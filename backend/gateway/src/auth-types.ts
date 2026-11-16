import { PublicError } from "./errors.js";

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

export type UserRecord = User & { password_hash: string; salt: string };
export type UserPatch = Partial<Pick<UserRecord, "username" | "email" | "setor" | "status" | "password_hash" | "salt">> & {
  aprovadoPor?: number;
};
export interface SessionRecord {
  tokenHash: string;
  publicId: string;
  userId: number;
  ip: string;
  userAgent: string;
  expiresAt: number;
}

export interface Store {
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

