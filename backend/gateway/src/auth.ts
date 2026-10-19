import crypto from "node:crypto";
import type { Pool, PoolConnection } from "mariadb";
import type { Config } from "./config.js";
import { catalogOnly, effectivePermissions, isManagerOnlyKey, validateGrants, permissionLabel } from "./permissions.js";
import { PublicError, ServiceUnavailableError } from "./errors.js";

/** Perfil do usuário. `gestor` fica abaixo do admin; o acesso real vem das permissões (RBAC por usuário). */
export type Role = "admin" | "gestor" | "user";
export const ROLES: readonly Role[] = ["admin", "gestor", "user"];

export type UserStatus = "pending" | "approved" | "rejected" | "blocked";

export interface User {
  id: number;
  username: string;
  nome: string;
  email: string;
  setor: string;
  role: Role;
  status: UserStatus;
  aprovado_por?: number | null;
  aprovado_em?: string | null;
  criado_em: string;
  permissoes?: string[];
  /** Admin raiz (seed BOOTSTRAP_ADMIN): marca persistente, não depende do username. */
  is_root?: boolean;
  /** Versão do conjunto de permissões (concorrência otimista na troca atômica). */
  permissoes_versao?: number;
  permissoes_alterado_por?: number | null;
  permissoes_alterado_em?: string | null;
}

/**
 * Linha de GET /api/admin/users: o User + campos do editor de permissões. `permissoes` traz só
 * chaves do catálogo (admin: [] — acesso total implícito); `permissions_count` conta só o catálogo
 * (admin: catálogo inteiro).
 */
export interface AdminUserView extends User {
  is_root: boolean;
  version: number;
  permissions_count: { tabs: number; actions: number };
  permissions_updated_by: number | null;
  permissions_updated_by_name: string | null;
  permissions_updated_at: string | null;
}

/** Estado das permissões de um usuário, para o editor (versão + "alterado por / em"). */
export interface PermissionState {
  userId: number;
  grants: string[];
  version: number;
  updatedBy: number | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

export type ReplacePermissionsResult =
  | { ok: true; state: PermissionState }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_conflict"; current: PermissionState };

export type UpdateRoleResult =
  | { ok: true; previousRole: Role; state: PermissionState }
  | { ok: false; reason: "not_found" | "root" | "last_admin" };

export interface ChangeRequest {
  id: number;
  usuario_id: number;
  tipo: "username" | "email";
  valor_atual: string;
  valor_novo: string;
  status: "pending" | "approved" | "rejected";
  solicitado_em: string;
  revisado_por?: number | null;
  revisado_em?: string | null;
  usuario_nome?: string;
}

export interface ActiveSession {
  /** Id PÚBLICO da sessão (public_id) — nunca o token nem o hash dele (GW-03). */
  id: string;
  usuario_id: number;
  nome: string;
  email: string;
  username: string;
  setor: string;
  role: Role;
  ip_address: string;
  user_agent: string;
  ultimo_acesso: string;
  criado_em: string;
}

export interface SessionInfo {
  user: User;
  /** Permissões efetivas ("<aba>:<acao>"): admin = catálogo inteiro; demais = só as concedidas. */
  permissions: string[];
  sessionId: string;
}

// ---------------------------------------------------------------------------------------------
// Senhas (GW-10): scrypt assíncrono, N=2^17 para hashes novos. Formato gravado em password_hash:
//   "scrypt$<N>$<r>$<p>$<hex>"   (salt continua na coluna `salt`)
// Hashes antigos (só hex, scryptSync com os padrões do Node: N=16384, r=8, p=1) continuam
// válidos e são regravados no formato novo no primeiro login bem-sucedido.
// ---------------------------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1024;
const KEY_LENGTH = 64;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
/** scrypt usa ~128·N·r bytes (128 MB com N=2^17, r=8); o padrão do Node (32 MB) recusaria. */
function maxmemFor(params: ScryptParams): number {
  return 128 * params.N * params.r * 2;
}

function scryptAsync(password: string, salt: string, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function parseStoredHash(stored: string): { params: ScryptParams; key: Buffer } | null {
  if (stored.startsWith("scrypt$")) {
    const [, n, r, p, hex] = stored.split("$");
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    if (!hex || !/^[0-9a-f]+$/i.test(hex) || ![params.N, params.r, params.p].every((v) => Number.isSafeInteger(v) && v > 0)) {
      return null;
    }
    // Teto de sanidade: um hash adulterado no banco não pode pedir memória absurda.
    if (params.N > 2 ** 20 || params.r > 32 || params.p > 16) return null;
    return { params, key: Buffer.from(hex, "hex") };
  }
  if (/^[0-9a-f]{128}$/i.test(stored)) return { params: LEGACY_SCRYPT_PARAMS, key: Buffer.from(stored, "hex") };
  return null;
}

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const key = await scryptAsync(password, s, SCRYPT_PARAMS);
  return { hash: `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${key.toString("hex")}`, salt: s };
}

export async function verifyPassword(
  password: string,
  stored: string,
  salt: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parseStoredHash(stored ?? "");
  if (!parsed) {
    await burnPasswordCheck(password);
    return { ok: false, needsRehash: false };
  }
  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, parsed.params);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = derived.length === parsed.key.length && crypto.timingSafeEqual(derived, parsed.key);
  const needsRehash =
    ok && (parsed.params.N < SCRYPT_PARAMS.N || parsed.params.r !== SCRYPT_PARAMS.r || parsed.params.p !== SCRYPT_PARAMS.p);
  return { ok, needsRehash };
}

const DUMMY_SALT = crypto.randomBytes(16).toString("hex");
/** Mesmo custo de um login real quando o usuário não existe (não revela quem está cadastrado). */
async function burnPasswordCheck(password: string): Promise<void> {
  await scryptAsync(password, DUMMY_SALT, SCRYPT_PARAMS).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Tokens de sessão (GW-03): o cliente recebe o token bruto; o banco guarda só sha256(token) em
// `usuario_sessoes.id`. O admin vê e encerra sessões pelo `public_id` (aleatório, separado).
// ---------------------------------------------------------------------------------------------

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
const TOKEN_RE = /^[a-f0-9]{64}$/;
const PUBLIC_ID_RE = /^[a-f0-9]{24}$/;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Erro de login por usuário/senha — `knownUser` diz se o login digitado existe (só p/ auditoria). */
export class InvalidCredentialsError extends PublicError {
  constructor(readonly knownUser: boolean) {
    super(401, "Credenciais inválidas. Verifique seu e-mail e senha.", "invalid_credentials");
    this.name = "InvalidCredentialsError";
  }
}

export interface AuthService {
  bootstrap(): Promise<void>;
  register(data: unknown): Promise<{ success: boolean; message: string; created: boolean }>;
  login(data: { login?: unknown; senha?: unknown; ip?: string; userAgent?: string }): Promise<{ token: string; user: User; permissions: string[] }>;
  validateSession(token: string): Promise<SessionInfo | null>;
  logout(token: string): Promise<boolean>;
  listUsers(): Promise<User[]>;
  /**
   * Cria um usuário já aprovado. `data.grants` (opcional, padrão []) é o conjunto de permissões,
   * validado contra o catálogo e o perfil; `role` aceita admin | gestor | user (padrão user).
   * Erros 400 trazem `field` ("nome" | "username" | "email" | "setor" | "senha" | "role" | "grants").
   */
  createUser(data: unknown, opts?: { actorId?: number }): Promise<User>;
  /**
   * Aprova o cadastro. O setor efetivo é o informado na aprovação (sem ele, o do cadastro).
   * Com `grants`, grava as permissões em seguida (2 passos): se o 2º falhar, o usuário fica
   * aprovado sem permissões (`permissionsSaved: false`).
   */
  approveUser(
    userId: number,
    adminId: number,
    opts?: { username?: unknown; setor?: unknown; grants?: unknown },
  ): Promise<{ setor: string; setorSugerido: string; grants: string[]; permissionsSaved: boolean }>;
  rejectUser(userId: number, adminId: number): Promise<boolean>;
  deleteUser(userId: number): Promise<boolean>;
  /** Usuário (sem hash) com `permissoes` = linhas concedidas, ou null. */
  getUser(userId: number): Promise<User | null>;
  /** Estado das permissões (só chaves do catálogo), ou null se o usuário não existe. */
  getPermissionState(userId: number): Promise<PermissionState | null>;
  /**
   * Substitui TODO o conjunto (validado contra o catálogo e o perfil do alvo). `expectedVersion`
   * diferente da atual → PublicError 409 `version_conflict` (com o estado atual em `current`).
   */
  replacePermissions(
    userId: number,
    grants: unknown,
    opts: { actorId: number; expectedVersion?: number },
  ): Promise<PermissionState>;
  /**
   * Troca o perfil. Recusa: a si mesmo (403 `self_change`), ROOT (403 `root_protected`), último
   * admin (409 `last_admin`). Admin rebaixado começa sem permissões; Gestor → User perde as
   * chaves de Gestão de Usuários.
   */
  updateRole(
    userId: number,
    role: unknown,
    opts: { actorId: number },
  ): Promise<{ previousRole: Role; role: Role; state: PermissionState; removed: string[] }>;
  updateSetor(userId: number, setor: string): Promise<boolean>;
  listActiveSessions(): Promise<ActiveSession[]>;
  /** Encerra pela id pública mostrada no painel admin. */
  forceLogoutSession(publicId: string): Promise<boolean>;
  forceLogoutUser(userId: number): Promise<boolean>;
  getPendingCount(): Promise<number>;
  checkUsernameAvailable(username: string, excludeUserId?: number): Promise<boolean>;
  checkEmailAvailable(email: string, excludeUserId?: number): Promise<boolean>;
  requestChangeUsername(userId: number, novoUsername: unknown): Promise<ChangeRequest>;
  requestChangeEmail(userId: number, novoEmail: unknown): Promise<ChangeRequest>;
  /** Troca a senha e encerra as DEMAIS sessões do usuário (GW-11); mantém `keepSessionId`. */
  changePassword(userId: number, senhaAtual: unknown, novaSenha: unknown, keepSessionId?: string): Promise<boolean>;
  listChangeRequestsForUser(userId: number): Promise<ChangeRequest[]>;
  listChangeRequests(status?: "pending" | "approved" | "rejected"): Promise<ChangeRequest[]>;
  approveChangeRequest(
    requestId: number,
    adminId: number,
  ): Promise<{ usuario_id: number; tipo: "username" | "email"; valor_novo: string } | null>;
  rejectChangeRequest(requestId: number, adminId: number): Promise<{ usuario_id: number } | null>;
  getPendingChangeRequestsCount(): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Admin inicial
// ---------------------------------------------------------------------------------------------

const BOOTSTRAP_ADMIN = {
  username: "admin_jp",
  nome: "Autor",
  email: "admin@norvia.example",
  setor: "T.I",
};
// RBAC por usuário: nenhum cadastro nasce com permissão. Cadastro público, criação e aprovação
// gravam só o conjunto explícito escolhido pelo admin/gestor (vazio por padrão).

let generatedDemoPassword: string | null = null;
/**
 * Só no modo em memória (demo/testes, sem banco). Sem ADMIN_BOOTSTRAP_PASSWORD gera uma senha
 * por processo e a mostra UMA vez no log — é a única forma de entrar no demo local.
 */
function demoAdminPassword(): string {
  const fromEnv = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  if (!generatedDemoPassword) {
    generatedDemoPassword = crypto.randomBytes(12).toString("base64url");
    console.warn(
      `[auth] Modo demonstração sem ADMIN_BOOTSTRAP_PASSWORD: senha temporária do admin_jp nesta execução: ${generatedDemoPassword}`,
    );
  }
  return generatedDemoPassword;
}

/**
 * Perfis de exemplo do modo demo (store em memória, nunca no live): 1 Admin ROOT (seed), 1 Gestor,
 * 2 Users com permissões e 2 Users sem acesso. Senha = a do admin demo (ADMIN_BOOTSTRAP_PASSWORD
 * ou a gerada no log). Idempotente: não recria quem já existe.
 */
export const DEMO_PROFILES: ReadonlyArray<{ username: string; nome: string; setor: string; role: Role; grants: string[] }> = [
  {
    username: "gestora.demo",
    nome: "Gabriela Gestora (demo)",
    setor: "Diretoria",
    role: "gestor",
    grants: [
      "fin_visao_geral:ver",
      "contas_pagar:ver",
      "erros:ver",
      "usuarios:ver",
      "usuarios:aprovar_cadastro",
      "usuarios:rejeitar_cadastro",
      "usuarios:criar",
      "usuarios:editar_permissoes",
      "usuarios:alterar_setor",
      "usuarios:derrubar_sessao",
    ],
  },
  {
    username: "fin.demo",
    nome: "Fernanda Financeiro (demo)",
    setor: "Financeiro",
    role: "user",
    grants: [
      "fin_visao_geral:ver",
      "contas_pagar:ver",
      "contas_pagar:importar_extrato",
      "contas_pagar:baixar",
      "conciliacao_ml:ver",
      "revisao_nfe:ver",
      "revisao_nfe:varrer_sefaz",
      "dashboard_financeiro:ver",
      "dashboard_financeiro:sincronizar",
    ],
  },
  {
    username: "mkt.demo",
    nome: "Marcos Marketplace (demo)",
    setor: "E-Commerce",
    role: "user",
    grants: ["mkt_visao_geral:ver", "dimensoes:ver", "dimensoes:validar", "fretes:ver", "fretes:retentar"],
  },
  { username: "log.demo", nome: "Lucas Logística (demo)", setor: "Logística", role: "user", grants: [] },
  { username: "sac.demo", nome: "Sara SAC (demo)", setor: "SAC", role: "user", grants: [] },
];

export async function seedDemoProfiles(auth: AuthService): Promise<void> {
  const existing = new Set((await auth.listUsers()).map((u) => u.username));
  const rootId = (await auth.listUsers()).find((u) => u.is_root)?.id;
  for (const p of DEMO_PROFILES) {
    if (existing.has(p.username)) continue;
    await auth.createUser(
      { nome: p.nome, username: p.username, email: `${p.username}@demo.norvia.local`, setor: p.setor, senha: demoAdminPassword(), role: p.role, grants: p.grants },
      { actorId: rootId },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------------------------

/** `field` = id estável do campo no formulário (o frontend marca o campo pelo `field` do erro). */
function requiredString(value: unknown, label: string, max: number, field?: string): string {
  const extra = field ? { field } : undefined;
  if (typeof value !== "string" || !value.trim()) throw new PublicError(400, `${label} é obrigatório.`, "validation", extra);
  const v = value.trim();
  if (v.length > max) throw new PublicError(400, `${label} excede ${max} caracteres.`, "validation", extra);
  return v;
}

function validateNewPassword(value: unknown, label = "A senha", field = "senha"): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    throw new PublicError(400, `${label} deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`, "weak_password", { field });
  }
  if (value.length > MAX_PASSWORD_LENGTH) throw new PublicError(400, `${label} é longa demais.`, "validation", { field });
  return value;
}

function cleanUsername(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 100);
}

function validateEmail(value: unknown): string {
  const email = requiredString(value, "E-mail", 255, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new PublicError(400, "E-mail inválido.", "validation", { field: "email" });
  return email;
}

const GRANT_ERRORS: Record<string, string> = {
  invalid_grants: "Permissões inválidas: envie a lista de chaves.",
  unknown_permission: "Permissão fora do catálogo",
  manager_only_permission: "As ações da Gestão de Usuários só podem ser dadas a Gestores",
  action_requires_view: "Ação sem o acesso de ver a aba",
};

/** Valida o conjunto para o perfil do alvo; 400 com `field: "grants"`, `code` e `items`. */
function parseGrants(raw: unknown, role: Role): string[] {
  const v = validateGrants(raw ?? [], role);
  if (v.ok) return v.grants;
  const items = v.items.map(permissionLabel);
  throw new PublicError(400, `${GRANT_ERRORS[v.code]}${items.length ? `: ${items.join(", ")}` : ""}.`, v.code, {
    field: "grants",
    items: v.items,
  });
}

function parseRole(raw: unknown): Role {
  if (raw === undefined || raw === null || raw === "") return "user";
  if (typeof raw === "string" && (ROLES as readonly string[]).includes(raw)) return raw as Role;
  throw new PublicError(400, "Perfil inválido: use user, gestor ou admin.", "validation", { field: "role" });
}

/** Estado exposto ao cliente: só chaves do catálogo (linhas legadas ficam de fora). */
function publicState(state: PermissionState): PermissionState {
  return { ...state, grants: catalogOnly(state.grants) };
}

const REGISTER_MESSAGE = "Cadastro recebido! Aguarde a aprovação do administrador para acessar a plataforma.";

// ---------------------------------------------------------------------------------------------
// Armazenamento: MariaDB (live) ou memória (demo/testes). Sem fallback entre eles (GW-02).
// ---------------------------------------------------------------------------------------------

type UserRecord = User & { password_hash: string; salt: string };
type UserPatch = Partial<Pick<UserRecord, "username" | "email" | "setor" | "status" | "password_hash" | "salt">> & {
  aprovadoPor?: number;
};
interface SessionRecord {
  tokenHash: string;
  publicId: string;
  userId: number;
  ip: string;
  userAgent: string;
  expiresAt: number;
}

interface Store {
  init(): Promise<void>;
  findUserByLogin(login: string): Promise<UserRecord | null>;
  findUserById(id: number): Promise<UserRecord | null>;
  findUserIdByEmail(email: string, excludeId?: number): Promise<number | null>;
  findUserIdByUsername(username: string, excludeId?: number): Promise<number | null>;
  /** Cria o usuário e o conjunto de permissões numa única transação (tudo ou nada). */
  insertUser(u: Omit<UserRecord, "id" | "criado_em">, permissions: string[], opts?: { actorId?: number | null }): Promise<number>;
  updateUser(id: number, patch: UserPatch, opts?: { expectedStatus?: UserStatus }): Promise<boolean>;
  deleteUser(id: number): Promise<boolean>;
  listUsers(): Promise<User[]>;
  permissionsOf(userId: number): Promise<{ allowed: string[]; denied: string[] }>;
  setPermissions(userId: number, perms: Record<string, boolean>): Promise<void>;
  /** Estado das permissões (grants, versão, alterado por/em) ou null se o usuário não existe. */
  getPermissionState(userId: number): Promise<PermissionState | null>;
  /**
   * Substitui de forma atômica TODO o conjunto de permissões do usuário. Com `expectedVersion`,
   * só grava se a versão atual for essa (senão `version_conflict`, sem alterar nada).
   * Cada troca incrementa a versão e grava alterado por/em.
   */
  replacePermissions(
    userId: number,
    grants: readonly string[],
    opts: { actorId: number; expectedVersion?: number },
  ): Promise<ReplacePermissionsResult>;
  /**
   * Troca o perfil. Recusa ROOT (`root`) e o rebaixamento do último admin aprovado
   * (`last_admin`). Com `replaceGrants`, substitui as permissões na MESMA transação
   * (ex.: admin rebaixado começa com []).
   */
  updateRole(
    userId: number,
    role: Role,
    opts: { actorId: number; replaceGrants?: readonly string[] },
  ): Promise<UpdateRoleResult>;
  countApprovedAdmins(): Promise<number>;
  findRootUserId(): Promise<number | null>;
  insertSession(s: SessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<{ user: User; publicId: string } | null>;
  touchSession(tokenHash: string): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deactivateSessionByPublicId(publicId: string): Promise<boolean>;
  deactivateUserSessions(userId: number, exceptPublicId?: string): Promise<void>;
  listActiveSessions(): Promise<ActiveSession[]>;
  countPendingUsers(): Promise<number>;
  insertChangeRequest(userId: number, tipo: "username" | "email", atual: string, novo: string): Promise<ChangeRequest>;
  listChangeRequests(filter: { userId?: number; status?: ChangeRequest["status"] }): Promise<ChangeRequest[]>;
  getPendingChangeRequest(id: number): Promise<ChangeRequest | null>;
  reviewChangeRequest(id: number, status: "approved" | "rejected", adminId: number): Promise<void>;
  pendingChangeValueTaken(tipo: "username" | "email", valor: string, excludeRequestId?: number): Promise<boolean>;
  countPendingChangeRequests(): Promise<number>;
}

/** Remove duplicatas (a UNIQUE (usuario_id, recurso) recusaria) e ordena, para comparação estável. */
function uniqueGrants(grants: readonly string[]): string[] {
  return Array.from(new Set(grants)).sort();
}

function createMemoryStore(): Store {
  const users = new Map<number, UserRecord>();
  const perms = new Map<number, Map<string, boolean>>();
  const sessions = new Map<string, SessionRecord & { lastSeen: string; createdAt: string; active: boolean }>();
  const changes = new Map<number, ChangeRequest>();
  let nextUserId = 1;
  let nextChangeId = 1;

  const strip = ({ password_hash: _h, salt: _s, ...u }: UserRecord): User => u;
  const grantsOf = (userId: number) =>
    Array.from(perms.get(userId)?.entries() ?? [])
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
  const stateOf = (u: UserRecord): PermissionState => {
    const by = u.permissoes_alterado_por ?? null;
    return {
      userId: u.id,
      grants: grantsOf(u.id),
      version: u.permissoes_versao ?? 0,
      updatedBy: by,
      updatedByName: by !== null ? (users.get(by)?.nome ?? null) : null,
      updatedAt: u.permissoes_alterado_em ?? null,
    };
  };
  /** Síncrono de propósito: no store em memória, sem await no meio, a troca é atômica. */
  const replaceGrantsSync = (u: UserRecord, grants: readonly string[], actorId: number) => {
    perms.set(u.id, new Map(uniqueGrants(grants).map((g) => [g, true])));
    u.permissoes_versao = (u.permissoes_versao ?? 0) + 1;
    u.permissoes_alterado_por = actorId;
    u.permissoes_alterado_em = new Date().toISOString();
  };

  return {
    async init() {
      if (users.size > 0) return;
      const { hash, salt } = await hashPassword(demoAdminPassword());
      const id = nextUserId++;
      // Admin = acesso total implícito: nenhuma linha de permissão.
      users.set(id, {
        id,
        ...BOOTSTRAP_ADMIN,
        role: "admin",
        status: "approved",
        is_root: true,
        permissoes_versao: 0,
        permissoes_alterado_por: null,
        permissoes_alterado_em: null,
        criado_em: new Date().toISOString(),
        password_hash: hash,
        salt,
      });
      perms.set(id, new Map());
    },
    async findUserByLogin(login) {
      for (const u of users.values()) if (u.email === login || u.username === login) return u;
      return null;
    },
    async findUserById(id) {
      return users.get(id) ?? null;
    },
    async findUserIdByEmail(email, excludeId) {
      for (const u of users.values()) if (u.email === email && u.id !== excludeId) return u.id;
      return null;
    },
    async findUserIdByUsername(username, excludeId) {
      for (const u of users.values()) if (u.username === username && u.id !== excludeId) return u.id;
      return null;
    },
    async insertUser(u, permissions, opts = {}) {
      const id = nextUserId++;
      const now = new Date().toISOString();
      const grants = uniqueGrants(permissions);
      const actor = grants.length > 0 ? (opts.actorId ?? null) : null;
      users.set(id, {
        ...u,
        id,
        is_root: false,
        permissoes_versao: 0,
        permissoes_alterado_por: actor,
        permissoes_alterado_em: actor !== null ? now : null,
        criado_em: now,
      });
      perms.set(id, new Map(grants.map((p) => [p, true])));
      return id;
    },
    async updateUser(id, patch, opts) {
      const u = users.get(id);
      if (!u) return false;
      if (opts?.expectedStatus !== undefined && u.status !== opts.expectedStatus) {
        return false;
      }
      const { aprovadoPor, ...rest } = patch;
      Object.assign(u, rest);
      if (aprovadoPor !== undefined) {
        u.aprovado_por = aprovadoPor;
        u.aprovado_em = new Date().toISOString();
      }
      return true;
    },
    async deleteUser(id) {
      // Invariante de dados: o ROOT nunca é apagado (defesa em profundidade; a regra é do gateway).
      if (users.get(id)?.is_root) return false;
      const existed = users.delete(id);
      perms.delete(id);
      for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k);
      return existed;
    },
    async listUsers() {
      return Array.from(users.values()).map((u) => ({
        ...strip(u),
        permissoes: Array.from(perms.get(u.id)?.entries() ?? [])
          .filter(([, v]) => v)
          .map(([k]) => k),
      }));
    },
    async permissionsOf(userId) {
      const entries = Array.from(perms.get(userId)?.entries() ?? []);
      return { allowed: entries.filter(([, v]) => v).map(([k]) => k), denied: entries.filter(([, v]) => !v).map(([k]) => k) };
    },
    async setPermissions(userId, p) {
      const map = perms.get(userId) ?? new Map<string, boolean>();
      for (const [k, v] of Object.entries(p)) map.set(k, v);
      perms.set(userId, map);
    },
    async getPermissionState(userId) {
      const u = users.get(userId);
      return u ? stateOf(u) : null;
    },
    async replacePermissions(userId, grants, opts) {
      const u = users.get(userId);
      if (!u) return { ok: false, reason: "not_found" };
      if (opts.expectedVersion !== undefined && (u.permissoes_versao ?? 0) !== opts.expectedVersion) {
        return { ok: false, reason: "version_conflict", current: stateOf(u) };
      }
      replaceGrantsSync(u, grants, opts.actorId);
      return { ok: true, state: stateOf(u) };
    },
    async updateRole(userId, role, opts) {
      const u = users.get(userId);
      if (!u) return { ok: false, reason: "not_found" };
      if (u.is_root) return { ok: false, reason: "root" };
      const previousRole = u.role;
      if (previousRole === "admin" && role !== "admin") {
        let others = 0;
        for (const o of users.values()) if (o.id !== userId && o.role === "admin" && o.status === "approved") others++;
        if (others === 0) return { ok: false, reason: "last_admin" };
      }
      u.role = role;
      if (opts.replaceGrants !== undefined) replaceGrantsSync(u, opts.replaceGrants, opts.actorId);
      return { ok: true, previousRole, state: stateOf(u) };
    },
    async countApprovedAdmins() {
      let n = 0;
      for (const u of users.values()) if (u.role === "admin" && u.status === "approved") n++;
      return n;
    },
    async findRootUserId() {
      for (const u of users.values()) if (u.is_root) return u.id;
      return null;
    },
    async insertSession(s) {
      const now = new Date().toISOString();
      sessions.set(s.tokenHash, { ...s, lastSeen: now, createdAt: now, active: true });
    },
    async findSession(tokenHash) {
      const s = sessions.get(tokenHash);
      if (!s || !s.active || s.expiresAt < Date.now()) return null;
      const u = users.get(s.userId);
      if (!u || u.status !== "approved") return null;
      return { user: strip(u), publicId: s.publicId };
    },
    async touchSession(tokenHash) {
      const s = sessions.get(tokenHash);
      if (s) s.lastSeen = new Date().toISOString();
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async deactivateSessionByPublicId(publicId) {
      for (const [k, s] of sessions) {
        if (s.publicId === publicId) {
          sessions.delete(k);
          return true;
        }
      }
      return false;
    },
    async deactivateUserSessions(userId, exceptPublicId) {
      for (const [k, s] of sessions) if (s.userId === userId && s.publicId !== exceptPublicId) sessions.delete(k);
    },
    async listActiveSessions() {
      const out: ActiveSession[] = [];
      for (const s of sessions.values()) {
        const u = users.get(s.userId);
        if (!u || !s.active || s.expiresAt <= Date.now()) continue;
        out.push({
          id: s.publicId,
          usuario_id: u.id,
          nome: u.nome,
          email: u.email,
          username: u.username,
          setor: u.setor,
          role: u.role,
          ip_address: s.ip,
          user_agent: s.userAgent,
          ultimo_acesso: s.lastSeen,
          criado_em: s.createdAt,
        });
      }
      return out.sort((a, b) => (a.ultimo_acesso < b.ultimo_acesso ? 1 : -1));
    },
    async countPendingUsers() {
      let n = 0;
      for (const u of users.values()) if (u.status === "pending") n++;
      return n;
    },
    async insertChangeRequest(userId, tipo, atual, novo) {
      const req: ChangeRequest = {
        id: nextChangeId++,
        usuario_id: userId,
        tipo,
        valor_atual: atual,
        valor_novo: novo,
        status: "pending",
        solicitado_em: new Date().toISOString(),
      };
      changes.set(req.id, req);
      return { ...req };
    },
    async listChangeRequests({ userId, status }) {
      return Array.from(changes.values())
        .filter((c) => (userId === undefined || c.usuario_id === userId) && (!status || c.status === status))
        .map((c) => ({ ...c, usuario_nome: users.get(c.usuario_id)?.nome }))
        .sort((a, b) => (a.solicitado_em < b.solicitado_em ? 1 : -1));
    },
    async getPendingChangeRequest(id) {
      const c = changes.get(id);
      return c && c.status === "pending" ? { ...c } : null;
    },
    async reviewChangeRequest(id, status, adminId) {
      const c = changes.get(id);
      if (!c) return;
      c.status = status;
      c.revisado_por = adminId;
      c.revisado_em = new Date().toISOString();
    },
    async pendingChangeValueTaken(tipo, valor, excludeRequestId) {
      for (const c of changes.values()) {
        if (c.id !== excludeRequestId && c.tipo === tipo && c.status === "pending" && c.valor_novo === valor) return true;
      }
      return false;
    },
    async countPendingChangeRequests() {
      let n = 0;
      for (const c of changes.values()) if (c.status === "pending") n++;
      return n;
    },
  };
}

/** Executor de SQL: `query` (conexão avulsa) ou o da transação em curso. */
type SqlRunner = (sql: string, values?: unknown[]) => Promise<any>;

/** Encerra a transação com ROLLBACK devolvendo um resultado de domínio (não é erro de banco). */
class TxAbort<T> {
  constructor(readonly value: T) {}
}

const DATE_ISO = "%Y-%m-%dT%H:%i:%sZ";

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function createDbStore(config: Config, pool: Pool): Store {
  function dbUnavailable(err: unknown): ServiceUnavailableError {
    console.error(
      JSON.stringify({
        event: "auth_db_error",
        code: (err as any)?.code,
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }),
    );
    return new ServiceUnavailableError("Banco de dados indisponível. Tente novamente em instantes.");
  }

  /** Qualquer falha do MariaDB vira 503 para o cliente; o detalhe fica só no log. */
  async function query<T = any>(sql: string, values: unknown[] = []): Promise<T[]> {
    let conn;
    try {
      conn = await pool.getConnection();
      return (await conn.query({ sql, timeout: config.timeoutMs }, values)) as T[];
    } catch (err) {
      throw dbUnavailable(err);
    } finally {
      conn?.release();
    }
  }

  /**
   * Tudo numa conexão só, entre BEGIN e COMMIT. Erro do banco → ROLLBACK + 503 (nada fica gravado
   * pela metade — bug do "Novo Usuário"). `throw new TxAbort(valor)` → ROLLBACK e devolve `valor`.
   */
  async function withTransaction<T>(fn: (q: SqlRunner) => Promise<T>): Promise<T> {
    let conn: PoolConnection | undefined;
    try {
      conn = await pool.getConnection();
      const c = conn;
      await c.beginTransaction();
      const out = await fn((sql, values = []) => c.query({ sql, timeout: config.timeoutMs }, values));
      await c.commit();
      return out;
    } catch (err) {
      if (conn) await conn.rollback().catch(() => undefined);
      if (err instanceof TxAbort) return err.value as T;
      throw dbUnavailable(err);
    } finally {
      conn?.release();
    }
  }

  /** INSERT de várias linhas de uma vez (permitido = TRUE). Lista vazia não faz nada. */
  async function insertGrants(q: SqlRunner, userId: number, grants: readonly string[]): Promise<void> {
    const list = uniqueGrants(grants);
    if (list.length === 0) return;
    await q(
      `INSERT INTO usuario_permissoes (usuario_id, recurso, permitido) VALUES ${list.map(() => "(?, ?, TRUE)").join(", ")}`,
      list.flatMap((g) => [userId, g]),
    );
  }

  /** Troca atômica do conjunto (chamar dentro de withTransaction). Incrementa a versão. */
  async function bumpAndReplaceGrants(q: SqlRunner, userId: number, grants: readonly string[], actorId: number) {
    await q(
      `UPDATE usuarios SET permissoes_versao = permissoes_versao + 1, permissoes_alterado_por = ?, permissoes_alterado_em = NOW()
       WHERE id = ?`,
      [actorId, userId],
    );
    await q("DELETE FROM usuario_permissoes WHERE usuario_id = ?", [userId]);
    await insertGrants(q, userId, grants);
  }

  async function readPermissionState(q: SqlRunner, userId: number): Promise<PermissionState | null> {
    const rows: any[] = await q(
      `SELECT u.id, u.permissoes_versao, u.permissoes_alterado_por, a.nome AS alterado_por_nome,
              DATE_FORMAT(u.permissoes_alterado_em, '${DATE_ISO}') AS permissoes_alterado_em
       FROM usuarios u LEFT JOIN usuarios a ON a.id = u.permissoes_alterado_por
       WHERE u.id = ?`,
      [userId],
    );
    const r = rows[0];
    if (!r) return null;
    const grants: any[] = await q(
      "SELECT recurso FROM usuario_permissoes WHERE usuario_id = ? AND permitido = TRUE ORDER BY recurso",
      [userId],
    );
    return {
      userId: Number(r.id),
      grants: grants.map((g) => String(g.recurso)),
      version: Number(r.permissoes_versao ?? 0),
      updatedBy: r.permissoes_alterado_por ? Number(r.permissoes_alterado_por) : null,
      updatedByName: r.alterado_por_nome ?? null,
      updatedAt: toIsoOrNull(r.permissoes_alterado_em),
    };
  }

  const mapUser = (r: any): UserRecord => ({
    id: Number(r.id),
    username: r.username,
    nome: r.nome,
    email: r.email,
    setor: r.setor,
    role: r.role,
    status: r.status,
    aprovado_por: r.aprovado_por ? Number(r.aprovado_por) : null,
    aprovado_em: r.aprovado_em ? String(r.aprovado_em) : null,
    criado_em: String(r.criado_em ?? ""),
    is_root: Boolean(Number(r.is_root ?? 0)),
    permissoes_versao: Number(r.permissoes_versao ?? 0),
    permissoes_alterado_por: r.permissoes_alterado_por ? Number(r.permissoes_alterado_por) : null,
    permissoes_alterado_em: toIsoOrNull(r.permissoes_alterado_em),
    password_hash: r.password_hash,
    salt: r.salt,
  });

  const mapChange = (r: any): ChangeRequest => ({
    id: Number(r.id),
    usuario_id: Number(r.usuario_id),
    tipo: r.tipo,
    valor_atual: r.valor_atual,
    valor_novo: r.valor_novo,
    status: r.status,
    solicitado_em: String(r.solicitado_em),
    revisado_por: r.revisado_por ? Number(r.revisado_por) : null,
    revisado_em: r.revisado_em ? String(r.revisado_em) : null,
    usuario_nome: r.usuario_nome,
  });

  return {
    async init() {
      await query(`
        CREATE TABLE IF NOT EXISTS usuarios (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(100) NOT NULL UNIQUE,
          nome VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE,
          setor VARCHAR(100) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          salt VARCHAR(64) NOT NULL,
          role ENUM('admin', 'gestor', 'user') NOT NULL DEFAULT 'user',
          is_root BOOLEAN NOT NULL DEFAULT FALSE,
          status ENUM('pending', 'approved', 'rejected', 'blocked') NOT NULL DEFAULT 'pending',
          permissoes_versao INT UNSIGNED NOT NULL DEFAULT 0,
          permissoes_alterado_por INT NULL,
          permissoes_alterado_em DATETIME NULL,
          aprovado_por INT NULL,
          aprovado_em DATETIME NULL,
          criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_usuarios_email (email),
          INDEX idx_usuarios_status (status),
          INDEX idx_usuarios_role (role)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      // RBAC por usuário — mesmo efeito (parte não destrutiva) de
      // database/migrations/2026-10-08-rbac-permissoes-por-usuario.sql, idempotente.
      const roleCol = await query<any>(
        `SELECT COLUMN_TYPE AS tipo FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'role'`,
      );
      if (!String(roleCol[0]?.tipo ?? "").includes("'gestor'")) {
        await query(`ALTER TABLE usuarios MODIFY COLUMN role ENUM('admin', 'gestor', 'user') NOT NULL DEFAULT 'user'`);
      }
      await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_root BOOLEAN NOT NULL DEFAULT FALSE AFTER role`);
      await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes_versao INT UNSIGNED NOT NULL DEFAULT 0 AFTER status`);
      await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes_alterado_por INT NULL AFTER permissoes_versao`);
      await query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes_alterado_em DATETIME NULL AFTER permissoes_alterado_por`);
      // ROOT de bancos anteriores à coluna: o admin do seed, só se ainda não houver ROOT.
      await query(
        `UPDATE usuarios SET is_root = TRUE
         WHERE role = 'admin' AND (username = ? OR email = ?)
           AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM usuarios WHERE is_root = TRUE) AS r)
         ORDER BY id LIMIT 1`,
        [BOOTSTRAP_ADMIN.username, BOOTSTRAP_ADMIN.email],
      );
      await query(`
        CREATE TABLE IF NOT EXISTS usuario_permissoes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          usuario_id INT NOT NULL,
          recurso VARCHAR(100) NOT NULL,
          permitido BOOLEAN NOT NULL DEFAULT TRUE,
          criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_usuario_recurso (usuario_id, recurso),
          INDEX idx_perm_usuario (usuario_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      // `id` guarda sha256(token) em hex (GW-03); `public_id` é o id mostrado no painel admin.
      await query(`
        CREATE TABLE IF NOT EXISTS usuario_sessoes (
          id VARCHAR(128) NOT NULL PRIMARY KEY,
          public_id CHAR(24) NULL,
          usuario_id INT NOT NULL,
          ip_address VARCHAR(45) NULL,
          user_agent TEXT NULL,
          ultimo_acesso DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expira_em DATETIME NOT NULL,
          ativo BOOLEAN NOT NULL DEFAULT TRUE,
          criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_sessoes_public_id (public_id),
          INDEX idx_sessoes_usuario (usuario_id),
          INDEX idx_sessoes_ativo (ativo)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      // Mesmo efeito de database/migrations/2026-10-06-sessoes-token-hash.sql, idempotente, para
      // o gateway novo não depender da ordem do deploy: sessões antigas (token bruto) caem.
      await query(`ALTER TABLE usuario_sessoes ADD COLUMN IF NOT EXISTS public_id CHAR(24) NULL AFTER id`);
      await query(`ALTER TABLE usuario_sessoes ADD UNIQUE INDEX IF NOT EXISTS uk_sessoes_public_id (public_id)`);
      await query(`UPDATE usuario_sessoes SET ativo = FALSE WHERE public_id IS NULL AND ativo = TRUE`);
      await query(`
        CREATE TABLE IF NOT EXISTS usuario_alteracoes_pendentes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          usuario_id INT NOT NULL,
          tipo ENUM('username', 'email') NOT NULL,
          valor_atual VARCHAR(255) NOT NULL,
          valor_novo VARCHAR(255) NOT NULL,
          status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
          solicitado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revisado_por INT NULL,
          revisado_em DATETIME NULL,
          INDEX idx_alt_usuario (usuario_id),
          INDEX idx_alt_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Seed do admin inicial: a ÚNICA utilidade de ADMIN_BOOTSTRAP_PASSWORD. Com ROOT gravado,
      // nunca semeia de novo (mesmo que o ROOT tenha trocado username/e-mail).
      const root = await query("SELECT id FROM usuarios WHERE is_root = TRUE LIMIT 1");
      if (root.length > 0) return;
      const existing = await query("SELECT id FROM usuarios WHERE email = ? OR username = ?", [
        BOOTSTRAP_ADMIN.email,
        BOOTSTRAP_ADMIN.username,
      ]);
      if (existing.length > 0) return;
      const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
      if (!bootstrapPassword) {
        console.error(
          JSON.stringify({
            event: "admin_seed_skipped",
            message: "Tabela usuarios sem o admin inicial e ADMIN_BOOTSTRAP_PASSWORD não definida: seed não executado.",
          }),
        );
        return;
      }
      const { hash, salt } = await hashPassword(bootstrapPassword);
      // Um INSERT só (atômico): admin = acesso total implícito, sem linhas em usuario_permissoes.
      // Antes eram 1 + 6 INSERTs em conexões separadas — o mesmo defeito do "Novo Usuário".
      await query(
        `INSERT IGNORE INTO usuarios (username, nome, email, setor, password_hash, salt, role, is_root, status, aprovado_em)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', TRUE, 'approved', NOW())`,
        [BOOTSTRAP_ADMIN.username, BOOTSTRAP_ADMIN.nome, BOOTSTRAP_ADMIN.email, BOOTSTRAP_ADMIN.setor, hash, salt],
      );
    },
    async findUserByLogin(login) {
      const rows = await query("SELECT * FROM usuarios WHERE email = ? OR username = ? LIMIT 1", [login, login]);
      return rows[0] ? mapUser(rows[0]) : null;
    },
    async findUserById(id) {
      const rows = await query("SELECT * FROM usuarios WHERE id = ?", [id]);
      return rows[0] ? mapUser(rows[0]) : null;
    },
    async findUserIdByEmail(email, excludeId) {
      const rows = await query<any>("SELECT id FROM usuarios WHERE email = ? AND id != ? LIMIT 1", [email, excludeId ?? 0]);
      return rows[0] ? Number(rows[0].id) : null;
    },
    async findUserIdByUsername(username, excludeId) {
      const rows = await query<any>("SELECT id FROM usuarios WHERE username = ? AND id != ? LIMIT 1", [username, excludeId ?? 0]);
      return rows[0] ? Number(rows[0].id) : null;
    },
    async insertUser(u, permissions, opts = {}) {
      const grants = uniqueGrants(permissions);
      const actor = grants.length > 0 ? (opts.actorId ?? null) : null;
      // Bug do "Novo Usuário": antes, usuário e permissões iam em INSERTs avulsos (uma conexão
      // cada); falha no meio deixava o usuário gravado sem permissões e o retry dava "já cadastrado".
      return withTransaction(async (q) => {
        const res = await q(
          `INSERT INTO usuarios (username, nome, email, setor, password_hash, salt, role, status, aprovado_em,
                                 permissoes_alterado_por, permissoes_alterado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${u.status === "approved" ? "NOW()" : "NULL"}, ?, ${actor !== null ? "NOW()" : "NULL"})`,
          [u.username, u.nome, u.email, u.setor, u.password_hash, u.salt, u.role, u.status, actor],
        );
        const id = Number(res.insertId);
        await insertGrants(q, id, grants);
        return id;
      });
    },
    async updateUser(id, patch, opts) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const col of ["username", "email", "setor", "status", "password_hash", "salt"] as const) {
        if (patch[col] !== undefined) {
          sets.push(`${col} = ?`);
          values.push(patch[col]);
        }
      }
      if (patch.aprovadoPor !== undefined) {
        sets.push("aprovado_por = ?", "aprovado_em = NOW()");
        values.push(patch.aprovadoPor);
      }
      if (sets.length === 0) return true;
      let sql = `UPDATE usuarios SET ${sets.join(", ")} WHERE id = ?`;
      values.push(id);
      if (opts?.expectedStatus !== undefined) {
        sql += ` AND status = ?`;
        values.push(opts.expectedStatus);
      }
      const res: any = await query(sql, values);
      return Number(res.affectedRows) > 0;
    },
    async deleteUser(id) {
      return withTransaction(async (q) => {
        // Invariante de dados: o ROOT nunca é apagado (defesa em profundidade; a regra é do gateway).
        const rows: any[] = await q("SELECT id, is_root FROM usuarios WHERE id = ? FOR UPDATE", [id]);
        if (!rows[0] || Number(rows[0].is_root)) return false;
        await q("DELETE FROM usuario_sessoes WHERE usuario_id = ?", [id]);
        await q("DELETE FROM usuario_permissoes WHERE usuario_id = ?", [id]);
        const res = await q("DELETE FROM usuarios WHERE id = ?", [id]);
        return Number(res.affectedRows) > 0;
      });
    },
    async listUsers() {
      const rows = await query<any>(
        `SELECT id, username, nome, email, setor, role, is_root, status, aprovado_por,
                DATE_FORMAT(aprovado_em, '%Y-%m-%dT%H:%i:%sZ') AS aprovado_em,
                DATE_FORMAT(criado_em, '%Y-%m-%dT%H:%i:%sZ') AS criado_em,
                permissoes_versao, permissoes_alterado_por,
                DATE_FORMAT(permissoes_alterado_em, '%Y-%m-%dT%H:%i:%sZ') AS permissoes_alterado_em
         FROM usuarios ORDER BY criado_em DESC`,
      );
      const perms = await query<any>("SELECT usuario_id, recurso FROM usuario_permissoes WHERE permitido = TRUE");
      const permMap = new Map<number, string[]>();
      for (const p of perms) {
        const list = permMap.get(Number(p.usuario_id)) || [];
        list.push(p.recurso);
        permMap.set(Number(p.usuario_id), list);
      }
      return rows.map((r) => {
        const { password_hash: _h, salt: _s, ...u } = mapUser(r);
        return { ...u, permissoes: permMap.get(u.id) || [] };
      });
    },
    async permissionsOf(userId) {
      const rows = await query<any>("SELECT recurso, permitido FROM usuario_permissoes WHERE usuario_id = ?", [userId]);
      return {
        allowed: rows.filter((r) => Boolean(Number(r.permitido))).map((r) => String(r.recurso)),
        denied: rows.filter((r) => !Number(r.permitido)).map((r) => String(r.recurso)),
      };
    },
    async setPermissions(userId, p) {
      for (const [recurso, permitido] of Object.entries(p)) {
        await query(
          `INSERT INTO usuario_permissoes (usuario_id, recurso, permitido) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE permitido = VALUES(permitido)`,
          [userId, recurso, permitido],
        );
      }
    },
    async getPermissionState(userId) {
      return readPermissionState(query, userId);
    },
    async replacePermissions(userId, grants, opts) {
      return withTransaction<ReplacePermissionsResult>(async (q) => {
        // UPDATE condicional = trava da linha + checagem de versão num passo só.
        const values: unknown[] = [opts.actorId, userId];
        let cond = "";
        if (opts.expectedVersion !== undefined) {
          cond = " AND permissoes_versao = ?";
          values.push(opts.expectedVersion);
        }
        const res = await q(
          `UPDATE usuarios SET permissoes_versao = permissoes_versao + 1, permissoes_alterado_por = ?, permissoes_alterado_em = NOW()
           WHERE id = ?${cond}`,
          values,
        );
        if (Number(res.affectedRows) === 0) {
          const current = await readPermissionState(q, userId);
          throw new TxAbort<ReplacePermissionsResult>(
            current ? { ok: false, reason: "version_conflict", current } : { ok: false, reason: "not_found" },
          );
        }
        await q("DELETE FROM usuario_permissoes WHERE usuario_id = ?", [userId]);
        await insertGrants(q, userId, grants);
        return { ok: true, state: (await readPermissionState(q, userId))! };
      });
    },
    async updateRole(userId, role, opts) {
      return withTransaction<UpdateRoleResult>(async (q) => {
        // Trava o alvo e todos os admins numa leitura só (ordem de PK): dois admins se
        // rebaixando ao mesmo tempo não deixam o sistema sem admin.
        const rows: any[] = await q(
          "SELECT id, role, is_root, status FROM usuarios WHERE id = ? OR role = 'admin' ORDER BY id FOR UPDATE",
          [userId],
        );
        const target = rows.find((r) => Number(r.id) === userId);
        if (!target) throw new TxAbort<UpdateRoleResult>({ ok: false, reason: "not_found" });
        if (Number(target.is_root)) throw new TxAbort<UpdateRoleResult>({ ok: false, reason: "root" });
        const previousRole = target.role as Role;
        if (previousRole === "admin" && role !== "admin") {
          const others = rows.filter((r) => Number(r.id) !== userId && r.role === "admin" && r.status === "approved");
          if (others.length === 0) throw new TxAbort<UpdateRoleResult>({ ok: false, reason: "last_admin" });
        }
        if (previousRole !== role) await q("UPDATE usuarios SET role = ? WHERE id = ?", [role, userId]);
        if (opts.replaceGrants !== undefined) await bumpAndReplaceGrants(q, userId, opts.replaceGrants, opts.actorId);
        return { ok: true, previousRole, state: (await readPermissionState(q, userId))! };
      });
    },
    async countApprovedAdmins() {
      const rows = await query<any>("SELECT COUNT(*) AS count FROM usuarios WHERE role = 'admin' AND status = 'approved'");
      return Number(rows[0]?.count || 0);
    },
    async findRootUserId() {
      const rows = await query<any>("SELECT id FROM usuarios WHERE is_root = TRUE ORDER BY id LIMIT 1");
      return rows[0] ? Number(rows[0].id) : null;
    },
    async insertSession(s) {
      await query(
        `INSERT INTO usuario_sessoes (id, public_id, usuario_id, ip_address, user_agent, expira_em, ativo)
         VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?), TRUE)`,
        [s.tokenHash, s.publicId, s.userId, s.ip.slice(0, 45), s.userAgent.slice(0, 500), Math.floor(s.expiresAt / 1000)],
      );
    },
    async findSession(tokenHash) {
      const rows = await query<any>(
        `SELECT s.public_id, u.id, u.username, u.nome, u.email, u.setor, u.role, u.is_root, u.status, u.criado_em
         FROM usuario_sessoes s
         JOIN usuarios u ON s.usuario_id = u.id
         WHERE s.id = ? AND s.public_id IS NOT NULL AND s.ativo = TRUE AND s.expira_em > NOW() AND u.status = 'approved'`,
        [tokenHash],
      );
      const r = rows[0];
      if (!r) return null;
      const { password_hash: _h, salt: _s, ...user } = mapUser(r);
      return { user: { ...user, criado_em: "" }, publicId: String(r.public_id) };
    },
    async touchSession(tokenHash) {
      await query("UPDATE usuario_sessoes SET ultimo_acesso = NOW() WHERE id = ?", [tokenHash]);
    },
    async deleteSession(tokenHash) {
      await query("UPDATE usuario_sessoes SET ativo = FALSE WHERE id = ?", [tokenHash]);
    },
    async deactivateSessionByPublicId(publicId) {
      const res: any = await query("UPDATE usuario_sessoes SET ativo = FALSE WHERE public_id = ? AND ativo = TRUE", [publicId]);
      return Number(res.affectedRows) > 0;
    },
    async deactivateUserSessions(userId, exceptPublicId) {
      if (exceptPublicId) {
        await query("UPDATE usuario_sessoes SET ativo = FALSE WHERE usuario_id = ? AND (public_id IS NULL OR public_id <> ?)", [
          userId,
          exceptPublicId,
        ]);
      } else {
        await query("UPDATE usuario_sessoes SET ativo = FALSE WHERE usuario_id = ?", [userId]);
      }
    },
    async listActiveSessions() {
      const rows = await query<any>(
        `SELECT s.public_id, s.usuario_id, s.ip_address, s.user_agent,
                DATE_FORMAT(s.ultimo_acesso, '%Y-%m-%dT%H:%i:%sZ') AS ultimo_acesso,
                DATE_FORMAT(s.criado_em, '%Y-%m-%dT%H:%i:%sZ') AS criado_em,
                u.nome, u.email, u.username, u.setor, u.role
         FROM usuario_sessoes s
         JOIN usuarios u ON s.usuario_id = u.id
         WHERE s.ativo = TRUE AND s.expira_em > NOW() AND s.public_id IS NOT NULL
         ORDER BY s.ultimo_acesso DESC`,
      );
      return rows.map((r) => ({
        id: String(r.public_id),
        usuario_id: Number(r.usuario_id),
        nome: r.nome,
        email: r.email,
        username: r.username,
        setor: r.setor,
        role: r.role,
        ip_address: r.ip_address || "unknown",
        user_agent: r.user_agent || "unknown",
        ultimo_acesso: String(r.ultimo_acesso),
        criado_em: String(r.criado_em),
      }));
    },
    async countPendingUsers() {
      const rows = await query<any>("SELECT COUNT(*) as count FROM usuarios WHERE status = 'pending'");
      return Number(rows[0]?.count || 0);
    },
    async insertChangeRequest(userId, tipo, atual, novo) {
      const res: any = await query(
        `INSERT INTO usuario_alteracoes_pendentes (usuario_id, tipo, valor_atual, valor_novo) VALUES (?, ?, ?, ?)`,
        [userId, tipo, atual, novo],
      );
      return {
        id: Number(res.insertId),
        usuario_id: userId,
        tipo,
        valor_atual: atual,
        valor_novo: novo,
        status: "pending",
        solicitado_em: new Date().toISOString(),
      };
    },
    async listChangeRequests({ userId, status }) {
      const where: string[] = [];
      const values: unknown[] = [];
      if (userId !== undefined) {
        where.push("c.usuario_id = ?");
        values.push(userId);
      }
      if (status) {
        where.push("c.status = ?");
        values.push(status);
      }
      const rows = await query<any>(
        `SELECT c.id, c.usuario_id, c.tipo, c.valor_atual, c.valor_novo, c.status,
                DATE_FORMAT(c.solicitado_em, '%Y-%m-%dT%H:%i:%sZ') AS solicitado_em,
                c.revisado_por, DATE_FORMAT(c.revisado_em, '%Y-%m-%dT%H:%i:%sZ') AS revisado_em,
                u.nome AS usuario_nome
         FROM usuario_alteracoes_pendentes c
         JOIN usuarios u ON u.id = c.usuario_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY c.solicitado_em DESC`,
        values,
      );
      return rows.map(mapChange);
    },
    async getPendingChangeRequest(id) {
      const rows = await query<any>("SELECT * FROM usuario_alteracoes_pendentes WHERE id = ? AND status = 'pending'", [id]);
      return rows[0] ? mapChange(rows[0]) : null;
    },
    async reviewChangeRequest(id, status, adminId) {
      await query("UPDATE usuario_alteracoes_pendentes SET status = ?, revisado_por = ?, revisado_em = NOW() WHERE id = ?", [
        status,
        adminId,
        id,
      ]);
    },
    async pendingChangeValueTaken(tipo, valor, excludeRequestId) {
      const rows = await query<any>(
        "SELECT id FROM usuario_alteracoes_pendentes WHERE tipo = ? AND valor_novo = ? AND status = 'pending' AND id != ? LIMIT 1",
        [tipo, valor, excludeRequestId ?? 0],
      );
      return rows.length > 0;
    },
    async countPendingChangeRequests() {
      const rows = await query<any>("SELECT COUNT(*) as count FROM usuario_alteracoes_pendentes WHERE status = 'pending'");
      return Number(rows[0]?.count || 0);
    },
  };
}

/** Store de usuários/permissões, exposto para os testes (o serviço usa o mesmo factory). */
export type AuthStore = Store;
export function createAuthStore(config: Config, pool?: Pool): AuthStore {
  return pool ? createDbStore(config, pool) : createMemoryStore();
}

// ---------------------------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------------------------

/**
 * Com `pool` (modo live) tudo vai ao MariaDB e, se ele cair, as operações falham com 503 —
 * não há mais fallback em memória para login/sessão (GW-02). Sem `pool` (demo/testes) tudo
 * fica em memória.
 */
export function createAuthService(config: Config, pool?: Pool, opts: { store?: AuthStore } = {}): AuthService {
  // `opts.store`: só para testes (ex.: simular corrida de rebaixamento sem ROOT).
  const store = opts.store ?? createAuthStore(config, pool);
  let initPromise: Promise<void> | null = null;
  const ready = () => {
    if (!initPromise) {
      initPromise = store.init().catch((err) => {
        initPromise = null; // tenta de novo na próxima chamada (ex.: banco voltou)
        throw err;
      });
    }
    return initPromise;
  };

  async function usernameAvailable(username: string, excludeUserId?: number, excludeRequestId?: number) {
    const clean = cleanUsername(username);
    if (!clean) return false;
    if ((await store.findUserIdByUsername(clean, excludeUserId)) !== null) return false;
    return !(await store.pendingChangeValueTaken("username", clean, excludeRequestId));
  }

  async function emailAvailable(email: string, excludeUserId?: number, excludeRequestId?: number) {
    const clean = email.trim().toLowerCase();
    if (!clean) return false;
    if ((await store.findUserIdByEmail(clean, excludeUserId)) !== null) return false;
    return !(await store.pendingChangeValueTaken("email", clean, excludeRequestId));
  }

  /** Username livre derivado do e-mail (joao, joao2, joao3...). */
  async function uniqueUsername(base: string): Promise<string> {
    const root = cleanUsername(base) || "user";
    for (let i = 1; i <= 50; i++) {
      const candidate = i === 1 ? root : `${root.slice(0, 95)}${i}`;
      if (await usernameAvailable(candidate)) return candidate;
    }
    return `${root.slice(0, 80)}${crypto.randomBytes(4).toString("hex")}`;
  }

  return {
    async bootstrap() {
      try {
        await ready();
      } catch (err) {
        // Sem fallback: o gateway sobe, mas login/sessão respondem 503 até o banco voltar.
        console.error(
          JSON.stringify({
            event: "auth_bootstrap_failed",
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          }),
        );
      }
    },

    async register(data) {
      await ready();
      const d = (data ?? {}) as Record<string, unknown>;
      const nome = requiredString(d.nome, "Nome", 255, "nome");
      const email = validateEmail(d.email);
      // O setor do cadastro é só sugestão (rótulo de equipe, não dá acesso); a aprovação pode trocar.
      const setor = requiredString(d.setor, "Setor", 100, "setor");
      const senha = validateNewPassword(d.senha);

      if ((await store.findUserIdByEmail(email)) !== null) {
        // Resposta neutra (GW-10): não revela que o e-mail já existe. Gasta o mesmo scrypt.
        await burnPasswordCheck(senha);
        return { success: true, message: REGISTER_MESSAGE, created: false };
      }
      const username = await uniqueUsername(email.split("@")[0] || "user");
      const { hash, salt } = await hashPassword(senha);
      await store.insertUser(
        { username, nome, email, setor, role: "user", status: "pending", password_hash: hash, salt },
        [],
      );
      return { success: true, message: REGISTER_MESSAGE, created: true };
    },

    async login(data) {
      await ready();
      const login = typeof data.login === "string" ? data.login.trim().toLowerCase().slice(0, 255) : "";
      const senha = typeof data.senha === "string" ? data.senha.slice(0, MAX_PASSWORD_LENGTH) : "";
      const ip = data.ip || "unknown";
      const userAgent = data.userAgent || "unknown";

      const userRecord = login ? await store.findUserByLogin(login) : null;
      if (!userRecord) {
        await burnPasswordCheck(senha);
        throw new InvalidCredentialsError(false);
      }
      const check = await verifyPassword(senha, userRecord.password_hash, userRecord.salt);
      if (!check.ok) throw new InvalidCredentialsError(true);

      if (userRecord.status === "pending") {
        throw new PublicError(401, "Seu cadastro está pendente de aprovação pelo administrador.", "pending");
      }
      if (userRecord.status === "rejected" || userRecord.status === "blocked") {
        throw new PublicError(401, "Seu acesso foi desativado ou recusado pela administração.", "disabled");
      }

      if (check.needsRehash) {
        // Rehash transparente para o formato novo (N=2^17). Falha aqui não impede o login.
        try {
          const novo = await hashPassword(senha);
          await store.updateUser(userRecord.id, { password_hash: novo.hash, salt: novo.salt });
        } catch (err) {
          console.warn(JSON.stringify({ event: "password_rehash_failed", userId: userRecord.id, message: String(err) }));
        }
      }

      const token = crypto.randomBytes(32).toString("hex");
      await store.insertSession({
        tokenHash: hashSessionToken(token),
        publicId: crypto.randomBytes(12).toString("hex"),
        userId: userRecord.id,
        ip,
        userAgent,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      const { allowed } = await store.permissionsOf(userRecord.id);
      const permissions = effectivePermissions(userRecord.role, allowed);
      const { password_hash: _h, salt: _s, ...safeUser } = userRecord;
      return { token, user: { ...safeUser, permissoes: permissions }, permissions };
    },

    async validateSession(token) {
      if (!token || !TOKEN_RE.test(token)) return null;
      await ready();
      const tokenHash = hashSessionToken(token);
      const found = await store.findSession(tokenHash);
      if (!found) return null;
      void store.touchSession(tokenHash).catch(() => undefined);
      // Perfil, ROOT e permissões relidos a cada requisição: mudança vale na próxima chamada.
      const { allowed } = await store.permissionsOf(found.user.id);
      const permissions = effectivePermissions(found.user.role, allowed);
      return {
        user: { ...found.user, permissoes: permissions },
        permissions,
        sessionId: found.publicId,
      };
    },

    async logout(token) {
      if (!token || !TOKEN_RE.test(token)) return true;
      await ready();
      await store.deleteSession(hashSessionToken(token));
      return true;
    },

    async listUsers() {
      await ready();
      return store.listUsers();
    },

    async createUser(data, opts = {}) {
      await ready();
      const d = (data ?? {}) as Record<string, unknown>;
      const nome = requiredString(d.nome, "Nome", 255, "nome");
      const email = validateEmail(d.email);
      const setor = requiredString(d.setor, "Setor", 100, "setor");
      const senha = validateNewPassword(d.senha);
      const role = parseRole(d.role);
      // Admin = acesso total implícito: nenhuma linha de permissão, mesmo que venha algo.
      const grants = role === "admin" ? [] : parseGrants(d.grants, role);
      const username =
        cleanUsername(typeof d.username === "string" ? d.username : "") || cleanUsername(email.split("@")[0] || "") || "user";
      if ((await store.findUserIdByUsername(username)) !== null) {
        throw new PublicError(400, `O nome de usuário "${username}" já está cadastrado.`, "duplicate", { field: "username" });
      }
      if ((await store.findUserIdByEmail(email)) !== null) {
        throw new PublicError(400, `O e-mail "${email}" já está cadastrado.`, "duplicate", { field: "email" });
      }
      const { hash, salt } = await hashPassword(senha);
      const id = await store.insertUser(
        { username, nome, email, setor, role, status: "approved", password_hash: hash, salt },
        grants,
        { actorId: opts.actorId ?? null },
      );
      return {
        id,
        username,
        nome,
        email,
        setor,
        role,
        status: "approved",
        is_root: false,
        permissoes: grants,
        criado_em: new Date().toISOString(),
      };
    },

    async approveUser(userId, adminId, opts = {}) {
      await ready();
      const user = await store.findUserById(userId);
      if (!user) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (user.status !== "pending") {
        throw new PublicError(409, "Usuário não está pendente de aprovação.", "not_pending");
      }
      const patch: UserPatch = { status: "approved", aprovadoPor: adminId };

      // Validado antes de aprovar: conjunto inválido não aprova nada.
      const grants = opts.grants === undefined || opts.grants === null ? [] : parseGrants(opts.grants, user.role);

      const newUsername = typeof opts.username === "string" ? cleanUsername(opts.username) : "";
      if (newUsername) {
        if ((await store.findUserIdByUsername(newUsername, userId)) !== null) {
          throw new PublicError(400, `O nome de usuário "${newUsername}" já está em uso por outro colaborador.`, "duplicate", {
            field: "username",
          });
        }
        patch.username = newUsername;
      }

      // Setor = rótulo de equipe (não dá acesso): o da aprovação, ou a sugestão do cadastro.
      const setorSugerido = user.setor;
      const setor =
        opts.setor !== undefined && opts.setor !== null && opts.setor !== ""
          ? requiredString(opts.setor, "Setor", 100, "setor")
          : setorSugerido;
      patch.setor = setor;
      const updated = await store.updateUser(userId, patch, { expectedStatus: "pending" });
      if (!updated) {
        throw new PublicError(409, "Usuário não está pendente de aprovação.", "not_pending");
      }

      let permissionsSaved = true;
      if (grants.length > 0) {
        try {
          const res = await store.replacePermissions(userId, grants, { actorId: adminId });
          permissionsSaved = res.ok;
        } catch (err) {
          // Aprovado sem permissões é um estado válido (C.3.5): o admin completa no editor.
          permissionsSaved = false;
          console.error(JSON.stringify({ event: "approve_permissions_failed", userId, message: String(err) }));
        }
      }
      return { setor, setorSugerido, grants: permissionsSaved ? grants : [], permissionsSaved };
    },

    async rejectUser(userId, adminId) {
      await ready();
      const user = await store.findUserById(userId);
      if (!user) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (user.status !== "pending") {
        throw new PublicError(409, "Usuário não está pendente de aprovação.", "not_pending");
      }
      const ok = await store.updateUser(userId, { status: "rejected", aprovadoPor: adminId }, { expectedStatus: "pending" });
      if (!ok) {
        throw new PublicError(409, "Usuário não está pendente de aprovação.", "not_pending");
      }
      await store.deactivateUserSessions(userId);
      return ok;
    },

    async deleteUser(userId) {
      await ready();
      return store.deleteUser(userId);
    },

    async getUser(userId) {
      await ready();
      const u = await store.findUserById(userId);
      if (!u) return null;
      const { password_hash: _h, salt: _s, ...safe } = u;
      return { ...safe, permissoes: (await store.permissionsOf(userId)).allowed };
    },

    async getPermissionState(userId) {
      await ready();
      const state = await store.getPermissionState(userId);
      return state ? publicState(state) : null;
    },

    async replacePermissions(userId, rawGrants, opts) {
      await ready();
      const target = await store.findUserById(userId);
      if (!target) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (target.role === "admin") {
        throw new PublicError(
          400,
          "Administradores têm acesso total. Para limitar o acesso, altere o perfil para Gestor ou User.",
          "target_is_admin",
        );
      }
      if (opts.expectedVersion !== undefined && (!Number.isSafeInteger(opts.expectedVersion) || opts.expectedVersion < 0)) {
        throw new PublicError(400, "Versão das permissões inválida.", "validation", { field: "expectedVersion" });
      }
      const grants = parseGrants(rawGrants, target.role);
      const res = await store.replacePermissions(userId, grants, opts);
      if (res.ok) return publicState(res.state);
      if (res.reason === "not_found") throw new PublicError(404, "Usuário não encontrado.", "not_found");
      const current = publicState(res.current);
      throw new PublicError(
        409,
        "Outra pessoa alterou estas permissões. Recarregue e refaça as alterações.",
        "version_conflict",
        { current },
      );
    },

    async updateRole(userId, rawRole, opts) {
      await ready();
      const role = parseRole(rawRole === undefined ? "" : rawRole);
      if (rawRole === undefined || rawRole === null || rawRole === "") {
        throw new PublicError(400, "Informe o perfil (user, gestor ou admin).", "validation", { field: "role" });
      }
      if (userId === opts.actorId) throw new PublicError(403, "Você não pode alterar o próprio perfil.", "self_change");
      const target = await store.findUserById(userId);
      if (!target) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (target.is_root) throw new PublicError(403, "O usuário ROOT não pode ter o perfil alterado.", "root_protected");
      const previousRole = target.role;
      // Admin rebaixado começa sem nada; Gestor → User perde as chaves de Gestão de Usuários.
      let replaceGrants: string[] | undefined;
      let removed: string[] = [];
      if (previousRole === "admin" && role !== "admin") {
        replaceGrants = [];
      } else if (previousRole === "gestor" && role === "user") {
        const current = catalogOnly((await store.permissionsOf(userId)).allowed);
        removed = current.filter(isManagerOnlyKey);
        replaceGrants = current.filter((k) => !isManagerOnlyKey(k));
      }
      const res = await store.updateRole(userId, role, { actorId: opts.actorId, replaceGrants });
      if (res.ok) return { previousRole: res.previousRole, role, state: publicState(res.state), removed };
      if (res.reason === "not_found") throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (res.reason === "root") throw new PublicError(403, "O usuário ROOT não pode ter o perfil alterado.", "root_protected");
      throw new PublicError(409, "Não é possível: o sistema precisa de pelo menos um administrador.", "last_admin");
    },

    async updateSetor(userId, setor) {
      await ready();
      const clean = requiredString(setor, "Setor", 100, "setor");
      return store.updateUser(userId, { setor: clean });
    },

    async listActiveSessions() {
      await ready();
      return store.listActiveSessions();
    },

    async forceLogoutSession(publicId) {
      if (!PUBLIC_ID_RE.test(publicId)) return false;
      await ready();
      return store.deactivateSessionByPublicId(publicId);
    },

    async forceLogoutUser(userId) {
      await ready();
      await store.deactivateUserSessions(userId);
      return true;
    },

    async getPendingCount() {
      await ready();
      return store.countPendingUsers();
    },

    async checkUsernameAvailable(username, excludeUserId) {
      await ready();
      return usernameAvailable(username, excludeUserId);
    },

    async checkEmailAvailable(email, excludeUserId) {
      await ready();
      return emailAvailable(email, excludeUserId);
    },

    async requestChangeUsername(userId, novoUsername) {
      await ready();
      const novo = typeof novoUsername === "string" ? cleanUsername(novoUsername) : "";
      if (!novo) throw new PublicError(400, "Nome de usuário inválido.", "validation");
      const user = await store.findUserById(userId);
      if (!user) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (user.username === novo) throw new PublicError(400, "O novo nome de usuário é igual ao atual.", "validation");
      const pendentes = await store.listChangeRequests({ userId, status: "pending" });
      if (pendentes.some((c) => c.tipo === "username")) {
        throw new PublicError(400, "Você já tem uma solicitação de troca de nome de usuário aguardando aprovação.", "conflict");
      }
      if (!(await usernameAvailable(novo, userId))) {
        throw new PublicError(400, `O nome de usuário "${novo}" já está em uso ou aguardando aprovação.`, "conflict");
      }
      return store.insertChangeRequest(userId, "username", user.username, novo);
    },

    async requestChangeEmail(userId, novoEmail) {
      await ready();
      const novo = typeof novoEmail === "string" ? novoEmail.trim().toLowerCase() : "";
      if (!novo || !/^[^\s@]+@[^\s@]+$/.test(novo) || novo.length > 255) throw new PublicError(400, "E-mail inválido.", "validation");
      const user = await store.findUserById(userId);
      if (!user) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      if (user.email === novo) throw new PublicError(400, "O novo e-mail é igual ao atual.", "validation");
      const pendentes = await store.listChangeRequests({ userId, status: "pending" });
      if (pendentes.some((c) => c.tipo === "email")) {
        throw new PublicError(400, "Você já tem uma solicitação de troca de e-mail aguardando aprovação.", "conflict");
      }
      if (!(await emailAvailable(novo, userId))) {
        throw new PublicError(400, `O e-mail "${novo}" já está em uso ou aguardando aprovação.`, "conflict");
      }
      return store.insertChangeRequest(userId, "email", user.email, novo);
    },

    async changePassword(userId, senhaAtual, novaSenha, keepSessionId) {
      await ready();
      const nova = validateNewPassword(novaSenha, "A nova senha", "novaSenha");
      const user = await store.findUserById(userId);
      if (!user) throw new PublicError(404, "Usuário não encontrado.", "not_found");
      const check = await verifyPassword(typeof senhaAtual === "string" ? senhaAtual : "", user.password_hash, user.salt);
      if (!check.ok) throw new PublicError(400, "Senha atual incorreta.", "wrong_password");
      const novoHash = await hashPassword(nova);
      await store.updateUser(userId, { password_hash: novoHash.hash, salt: novoHash.salt });
      // GW-11: quem tinha a senha antiga perde as sessões abertas; a sessão atual continua.
      await store.deactivateUserSessions(userId, keepSessionId);
      return true;
    },

    async listChangeRequestsForUser(userId) {
      await ready();
      return store.listChangeRequests({ userId });
    },

    async listChangeRequests(status) {
      await ready();
      return store.listChangeRequests({ status });
    },

    async approveChangeRequest(requestId, adminId) {
      await ready();
      const req = await store.getPendingChangeRequest(requestId);
      if (!req) return null;
      const disponivel =
        req.tipo === "username"
          ? await usernameAvailable(req.valor_novo, req.usuario_id, req.id)
          : await emailAvailable(req.valor_novo, req.usuario_id, req.id);
      if (!disponivel) {
        throw new PublicError(
          400,
          `O ${req.tipo === "username" ? "nome de usuário" : "e-mail"} "${req.valor_novo}" não está mais disponível.`,
          "conflict",
        );
      }
      await store.updateUser(req.usuario_id, req.tipo === "username" ? { username: req.valor_novo } : { email: req.valor_novo });
      await store.reviewChangeRequest(requestId, "approved", adminId);
      return { usuario_id: req.usuario_id, tipo: req.tipo, valor_novo: req.valor_novo };
    },

    async rejectChangeRequest(requestId, adminId) {
      await ready();
      const req = await store.getPendingChangeRequest(requestId);
      if (!req) return null;
      await store.reviewChangeRequest(requestId, "rejected", adminId);
      return { usuario_id: req.usuario_id };
    },

    async getPendingChangeRequestsCount() {
      await ready();
      return store.countPendingChangeRequests();
    },
  };
}
