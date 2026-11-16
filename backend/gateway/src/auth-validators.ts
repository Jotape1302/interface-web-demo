import crypto from "node:crypto";
import { PublicError } from "./errors.js";
import { catalogOnly, isManagerOnlyKey, validateGrants, permissionLabel } from "./permissions.js";
import { ROLES, type PermissionState, type Role } from "./auth-types.js";

// ---------------------------------------------------------------------------------------------
// Senhas (GW-10): scrypt assíncrono, N=2^17 para hashes novos. Formato gravado em password_hash:
//   "scrypt$<N>$<r>$<p>$<hex>"   (salt continua na coluna `salt`)
// Hashes antigos (só hex, scryptSync com os padrões do Node: N=16384, r=8, p=1) continuam
// válidos e são regravados no formato novo no primeiro login bem-sucedido.
// ---------------------------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;
export const KEY_LENGTH = 64;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
export const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
/** scrypt usa ~128·N·r bytes (128 MB com N=2^17, r=8); o padrão do Node (32 MB) recusaria. */
export function maxmemFor(params: ScryptParams): number {
  return 128 * params.N * params.r * 2;
}

export function scryptAsync(password: string, salt: string, params: ScryptParams): Promise<Buffer> {
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

export function parseStoredHash(stored: string): { params: ScryptParams; key: Buffer } | null {
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

export const DUMMY_SALT = crypto.randomBytes(16).toString("hex");
/** Mesmo custo de um login real quando o usuário não existe (não revela quem está cadastrado). */
export async function burnPasswordCheck(password: string): Promise<void> {
  await scryptAsync(password, DUMMY_SALT, SCRYPT_PARAMS).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Tokens de sessão (GW-03): o cliente recebe o token bruto; o banco guarda só sha256(token) em
// `usuario_sessoes.id`. O admin vê e encerra sessões pelo `public_id` (aleatório, separado).
// ---------------------------------------------------------------------------------------------

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
export const TOKEN_RE = /^[a-f0-9]{64}$/;
export const PUBLIC_ID_RE = /^[a-f0-9]{24}$/;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;


// ---------------------------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------------------------

/** `field` = id estável do campo no formulário (o frontend marca o campo pelo `field` do erro). */
export function requiredString(value: unknown, label: string, max: number, field?: string): string {
  const extra = field ? { field } : undefined;
  if (typeof value !== "string" || !value.trim()) throw new PublicError(400, `${label} é obrigatório.`, "validation", extra);
  const v = value.trim();
  if (v.length > max) throw new PublicError(400, `${label} excede ${max} caracteres.`, "validation", extra);
  return v;
}

export function validateNewPassword(value: unknown, label = "A senha", field = "senha"): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    throw new PublicError(400, `${label} deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`, "weak_password", { field });
  }
  if (value.length > MAX_PASSWORD_LENGTH) throw new PublicError(400, `${label} é longa demais.`, "validation", { field });
  return value;
}

export function cleanUsername(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 100);
}

export function validateEmail(value: unknown): string {
  const email = requiredString(value, "E-mail", 255, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new PublicError(400, "E-mail inválido.", "validation", { field: "email" });
  return email;
}

export const GRANT_ERRORS: Record<string, string> = {
  invalid_grants: "Permissões inválidas: envie a lista de chaves.",
  unknown_permission: "Permissão fora do catálogo",
  manager_only_permission: "As ações da Gestão de Usuários só podem ser dadas a Gestores",
  action_requires_view: "Ação sem o acesso de ver a aba",
};

/** Valida o conjunto para o perfil do alvo; 400 com `field: "grants"`, `code` e `items`. */
export function parseGrants(raw: unknown, role: Role): string[] {
  const v = validateGrants(raw ?? [], role);
  if (v.ok) return v.grants;
  const items = v.items.map(permissionLabel);
  throw new PublicError(400, `${GRANT_ERRORS[v.code]}${items.length ? `: ${items.join(", ")}` : ""}.`, v.code, {
    field: "grants",
    items: v.items,
  });
}

export function parseRole(raw: unknown): Role {
  if (raw === undefined || raw === null || raw === "") return "user";
  if (typeof raw === "string" && (ROLES as readonly string[]).includes(raw)) return raw as Role;
  throw new PublicError(400, "Perfil inválido: use user, gestor ou admin.", "validation", { field: "role" });
}

/** Estado exposto ao cliente: só chaves do catálogo (linhas legadas ficam de fora). */
export function publicState(state: PermissionState): PermissionState {
  return { ...state, grants: catalogOnly(state.grants) };
}

export const REGISTER_MESSAGE = "Cadastro recebido! Aguarde a aprovação do administrador para acessar a plataforma.";

export function uniqueGrants(grants: readonly string[]): string[] {
  return Array.from(new Set(grants)).sort();
}


export const BOOTSTRAP_ADMIN = {
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
export function demoAdminPassword(): string {
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
