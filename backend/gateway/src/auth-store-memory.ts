import crypto from "node:crypto";
import { PublicError } from "./errors.js";
import { catalogOnly, effectivePermissions } from "./permissions.js";
import { type Role, ROLES, type UserStatus, type User, type AdminUserView, type PermissionState, type ReplacePermissionsResult, type UpdateRoleResult, type ChangeRequest, type ActiveSession, type SessionInfo, InvalidCredentialsError, type AuthService, type UserRecord, type UserPatch, type SessionRecord, type Store } from "./auth-types.js";
import { BOOTSTRAP_ADMIN, demoAdminPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, KEY_LENGTH, type ScryptParams, SCRYPT_PARAMS, LEGACY_SCRYPT_PARAMS, maxmemFor, scryptAsync, parseStoredHash, hashPassword, verifyPassword, DUMMY_SALT, burnPasswordCheck, hashSessionToken, TOKEN_RE, PUBLIC_ID_RE, SESSION_TTL_MS, requiredString, validateNewPassword, cleanUsername, validateEmail, GRANT_ERRORS, parseGrants, parseRole, publicState, REGISTER_MESSAGE, uniqueGrants } from "./auth-validators.js";

export function createMemoryStore(): Store {
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
/** Devolve as linhas (SELECT) ou o OkPacket (escrita, ver `asWriteResult`), como o driver. */
