import crypto from "node:crypto";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";
import { PublicError } from "./errors.js";
import { catalogOnly, effectivePermissions, isManagerOnlyKey, validateGrants, permissionLabel } from "./permissions.js";
import { type Role, ROLES, type UserStatus, type User, type AdminUserView, type PermissionState, type ReplacePermissionsResult, type UpdateRoleResult, type ChangeRequest, type ActiveSession, type SessionInfo, InvalidCredentialsError, type AuthService, type UserRecord, type UserPatch, type SessionRecord, type Store } from "./auth-types.js";
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, KEY_LENGTH, type ScryptParams, SCRYPT_PARAMS, LEGACY_SCRYPT_PARAMS, maxmemFor, scryptAsync, parseStoredHash, hashPassword, verifyPassword, DUMMY_SALT, burnPasswordCheck, hashSessionToken, TOKEN_RE, PUBLIC_ID_RE, SESSION_TTL_MS, requiredString, validateNewPassword, cleanUsername, validateEmail, GRANT_ERRORS, parseGrants, parseRole, publicState, REGISTER_MESSAGE, uniqueGrants } from "./auth-validators.js";
import { BOOTSTRAP_ADMIN, demoAdminPassword } from "./auth-validators.js";
import { createMemoryStore } from "./auth-store-memory.js";
import { createDbStore } from "./auth-store-sql.js";

// ---------------------------------------------------------------------------------------------
// Admin inicial
// ---------------------------------------------------------------------------------------------


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
/** Quanto tempo as permissões de um usuário ficam em cache (GW-03). */
export const PERMISSIONS_CACHE_MS = 5_000;
/** Intervalo mínimo entre dois `touchSession` da mesma sessão (GW-03). */
export const TOUCH_SESSION_MIN_MS = 60_000;

/** Métodos do store que podem mudar permissão, perfil ou status: qualquer um invalida o cache. */
const PERMISSION_MUTATIONS = new Set<string>([
  "updateUser",
  "replacePermissions",
  "updateRole",
  "deleteUser",
  "insertUser",
  "reviewChangeRequest",
  "deactivateUserSessions",
]);

/**
 * GW-03: `permissionsOf` roda a cada requisição autenticada; guarda o resultado 5 s por usuário
 * e descarta TUDO ao passar qualquer escrita que altere permissão/perfil/status do usuário.
 */
function withPermissionsCache(inner: AuthStore, now: () => number = Date.now): AuthStore {
  const cache = new Map<number, { at: number; value: { allowed: string[]; denied: string[] } }>();
  let generation = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function" || typeof prop !== "string") return original;
      if (prop === "permissionsOf") {
        return async (userId: number) => {
          const hit = cache.get(userId);
          if (hit && now() - hit.at < PERMISSIONS_CACHE_MS) {
            return { allowed: [...hit.value.allowed], denied: [...hit.value.denied] };
          }
          const gen = generation;
          const value = await target.permissionsOf(userId);
          if (gen === generation) cache.set(userId, { at: now(), value });
          return { allowed: [...value.allowed], denied: [...value.denied] };
        };
      }
      if (PERMISSION_MUTATIONS.has(prop)) {
        return async (...args: unknown[]) => {
          generation++;
          cache.clear();
          try {
            return await (original as (...a: unknown[]) => unknown).apply(target, args);
          } finally {
            generation++;
            cache.clear();
          }
        };
      }
      return original.bind(target);
    },
  });
}

export function createAuthService(config: Config, pool?: Pool, opts: { store?: AuthStore } = {}): AuthService {
  // `opts.store`: só para testes (ex.: simular corrida de rebaixamento sem ROOT).
  const store = withPermissionsCache(opts.store ?? createAuthStore(config, pool));
  const lastTouch = new Map<string, number>();
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
      // GW-03: no máximo 1 escrita por minuto por sessão (era uma por requisição).
      const agora = Date.now();
      if (agora - (lastTouch.get(tokenHash) ?? 0) >= TOUCH_SESSION_MIN_MS) {
        lastTouch.set(tokenHash, agora);
        if (lastTouch.size > 5000) {
          for (const [k, at] of lastTouch) if (agora - at > TOUCH_SESSION_MIN_MS) lastTouch.delete(k);
        }
        void store.touchSession(tokenHash).catch(() => undefined);
      }
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

