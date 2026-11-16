import crypto from "node:crypto";
import type { Pool, PoolConnection } from "mariadb";
import type { Config } from "./config.js";
import { PublicError, ServiceUnavailableError } from "./errors.js";
import { asWriteResult, type DbRow } from "./database.js";
import { catalogOnly, effectivePermissions } from "./permissions.js";
import { type Role, ROLES, type UserStatus, type User, type AdminUserView, type PermissionState, type ReplacePermissionsResult, type UpdateRoleResult, type ChangeRequest, type ActiveSession, type SessionInfo, InvalidCredentialsError, type AuthService, type UserRecord, type UserPatch, type SessionRecord, type Store } from "./auth-types.js";
import { BOOTSTRAP_ADMIN, demoAdminPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, KEY_LENGTH, type ScryptParams, SCRYPT_PARAMS, LEGACY_SCRYPT_PARAMS, maxmemFor, scryptAsync, parseStoredHash, hashPassword, verifyPassword, DUMMY_SALT, burnPasswordCheck, hashSessionToken, TOKEN_RE, PUBLIC_ID_RE, SESSION_TTL_MS, requiredString, validateNewPassword, cleanUsername, validateEmail, GRANT_ERRORS, parseGrants, parseRole, publicState, REGISTER_MESSAGE, uniqueGrants } from "./auth-validators.js";

type SqlRunner = (sql: string, values?: unknown[]) => Promise<DbRow[]>;

/** Encerra a transação com ROLLBACK devolvendo um resultado de domínio (não é erro de banco). */
class TxAbort<T> {
  constructor(readonly value: T) {}
}

const DATE_ISO = "%Y-%m-%dT%H:%i:%sZ";

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export function createDbStore(config: Config, pool: Pool): Store {
  function dbUnavailable(err: unknown): ServiceUnavailableError {
    console.error(
      JSON.stringify({
        event: "auth_db_error",
        code: (err as { code?: unknown } | null)?.code,
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }),
    );
    return new ServiceUnavailableError("Banco de dados indisponível. Tente novamente em instantes.");
  }

  /** Qualquer falha do MariaDB vira 503 para o cliente; o detalhe fica só no log. */
  async function query<T = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> {
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
    const rows = await q(
      `SELECT u.id, u.permissoes_versao, u.permissoes_alterado_por, a.nome AS alterado_por_nome,
              DATE_FORMAT(u.permissoes_alterado_em, '${DATE_ISO}') AS permissoes_alterado_em
       FROM usuarios u LEFT JOIN usuarios a ON a.id = u.permissoes_alterado_por
       WHERE u.id = ?`,
      [userId],
    );
    const r = rows[0];
    if (!r) return null;
    const grants = await q(
      "SELECT recurso FROM usuario_permissoes WHERE usuario_id = ? AND permitido = TRUE ORDER BY recurso",
      [userId],
    );
    return {
      userId: Number(r.id),
      grants: grants.map((g) => String(g.recurso)),
      version: Number(r.permissoes_versao ?? 0),
      updatedBy: r.permissoes_alterado_por ? Number(r.permissoes_alterado_por) : null,
      updatedByName: (r.alterado_por_nome as string | null | undefined) ?? null,
      updatedAt: toIsoOrNull(r.permissoes_alterado_em),
    };
  }

  const mapUser = (r: DbRow): UserRecord => ({
    id: Number(r.id),
    username: r.username as string,
    nome: r.nome as string,
    email: r.email as string,
    setor: r.setor as string,
    role: r.role as Role,
    status: r.status as UserStatus,
    aprovado_por: r.aprovado_por ? Number(r.aprovado_por) : null,
    aprovado_em: r.aprovado_em ? String(r.aprovado_em) : null,
    criado_em: String(r.criado_em ?? ""),
    is_root: Boolean(Number(r.is_root ?? 0)),
    permissoes_versao: Number(r.permissoes_versao ?? 0),
    permissoes_alterado_por: r.permissoes_alterado_por ? Number(r.permissoes_alterado_por) : null,
    permissoes_alterado_em: toIsoOrNull(r.permissoes_alterado_em),
    password_hash: r.password_hash as string,
    salt: r.salt as string,
  });

  const mapChange = (r: DbRow): ChangeRequest => ({
    id: Number(r.id),
    usuario_id: Number(r.usuario_id),
    tipo: r.tipo as ChangeRequest["tipo"],
    valor_atual: r.valor_atual as string,
    valor_novo: r.valor_novo as string,
    status: r.status as ChangeRequest["status"],
    solicitado_em: String(r.solicitado_em),
    revisado_por: r.revisado_por ? Number(r.revisado_por) : null,
    revisado_em: r.revisado_em ? String(r.revisado_em) : null,
    usuario_nome: r.usuario_nome as string | undefined,
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
          INDEX idx_usuarios_status (status),
          INDEX idx_usuarios_role (role)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      // RBAC por usuário — mesmo efeito (parte não destrutiva) de
      // database/migrations/2026-10-08-rbac-permissoes-por-usuario.sql, idempotente.
      const roleCol = await query(
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
          UNIQUE KEY uk_usuario_recurso (usuario_id, recurso)
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
      const rows = await query("SELECT id FROM usuarios WHERE email = ? AND id != ? LIMIT 1", [email, excludeId ?? 0]);
      return rows[0] ? Number(rows[0].id) : null;
    },
    async findUserIdByUsername(username, excludeId) {
      const rows = await query("SELECT id FROM usuarios WHERE username = ? AND id != ? LIMIT 1", [username, excludeId ?? 0]);
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
        ).then(asWriteResult);
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
      const res = asWriteResult(await query(sql, values));
      return Number(res.affectedRows) > 0;
    },
    async deleteUser(id) {
      return withTransaction(async (q) => {
        // Invariante de dados: o ROOT nunca é apagado (defesa em profundidade; a regra é do gateway).
        const rows = await q("SELECT id, is_root FROM usuarios WHERE id = ? FOR UPDATE", [id]);
        if (!rows[0] || Number(rows[0].is_root)) return false;
        await q("DELETE FROM usuario_sessoes WHERE usuario_id = ?", [id]);
        await q("DELETE FROM usuario_permissoes WHERE usuario_id = ?", [id]);
        const res = asWriteResult(await q("DELETE FROM usuarios WHERE id = ?", [id]));
        return Number(res.affectedRows) > 0;
      });
    },
    async listUsers() {
      const rows = await query(
        `SELECT id, username, nome, email, setor, role, is_root, status, aprovado_por,
                DATE_FORMAT(aprovado_em, '%Y-%m-%dT%H:%i:%sZ') AS aprovado_em,
                DATE_FORMAT(criado_em, '%Y-%m-%dT%H:%i:%sZ') AS criado_em,
                permissoes_versao, permissoes_alterado_por,
                DATE_FORMAT(permissoes_alterado_em, '%Y-%m-%dT%H:%i:%sZ') AS permissoes_alterado_em
         FROM usuarios ORDER BY criado_em DESC`,
      );
      const perms = await query("SELECT usuario_id, recurso FROM usuario_permissoes WHERE permitido = TRUE");
      const permMap = new Map<number, string[]>();
      for (const p of perms) {
        const list = permMap.get(Number(p.usuario_id)) || [];
        list.push(p.recurso as string);
        permMap.set(Number(p.usuario_id), list);
      }
      return rows.map((r) => {
        const { password_hash: _h, salt: _s, ...u } = mapUser(r);
        return { ...u, permissoes: permMap.get(u.id) || [] };
      });
    },
    async permissionsOf(userId) {
      const rows = await query("SELECT recurso, permitido FROM usuario_permissoes WHERE usuario_id = ?", [userId]);
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
        ).then(asWriteResult);
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
        const rows = await q(
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
      const rows = await query("SELECT COUNT(*) AS count FROM usuarios WHERE role = 'admin' AND status = 'approved'");
      return Number(rows[0]?.count || 0);
    },
    async findRootUserId() {
      const rows = await query("SELECT id FROM usuarios WHERE is_root = TRUE ORDER BY id LIMIT 1");
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
      const rows = await query(
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
      const res = asWriteResult(await query("UPDATE usuario_sessoes SET ativo = FALSE WHERE public_id = ? AND ativo = TRUE", [publicId]));
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
      const rows = await query(
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
        nome: r.nome as string,
        email: r.email as string,
        username: r.username as string,
        setor: r.setor as string,
        role: r.role as Role,
        ip_address: (r.ip_address as string | null) || "unknown",
        user_agent: (r.user_agent as string | null) || "unknown",
        ultimo_acesso: String(r.ultimo_acesso),
        criado_em: String(r.criado_em),
      }));
    },
    async countPendingUsers() {
      const rows = await query("SELECT COUNT(*) as count FROM usuarios WHERE status = 'pending'");
      return Number(rows[0]?.count || 0);
    },
    async insertChangeRequest(userId, tipo, atual, novo) {
      const res = asWriteResult(await query(
        `INSERT INTO usuario_alteracoes_pendentes (usuario_id, tipo, valor_atual, valor_novo) VALUES (?, ?, ?, ?)`,
        [userId, tipo, atual, novo],
      ));
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
      const rows = await query(
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
      const rows = await query("SELECT * FROM usuario_alteracoes_pendentes WHERE id = ? AND status = 'pending'", [id]);
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
      const rows = await query(
        "SELECT id FROM usuario_alteracoes_pendentes WHERE tipo = ? AND valor_novo = ? AND status = 'pending' AND id != ? LIMIT 1",
        [tipo, valor, excludeRequestId ?? 0],
      );
      return rows.length > 0;
    },
    async countPendingChangeRequests() {
      const rows = await query("SELECT COUNT(*) as count FROM usuario_alteracoes_pendentes WHERE status = 'pending'");
      return Number(rows[0]?.count || 0);
    },
  };
}

/** Store de usuários/permissões, exposto para os testes (o serviço usa o mesmo factory). */
