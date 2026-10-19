import type { Pool } from "mariadb";
import type { Config } from "./config.js";
import type { User } from "./auth.js";
import { canSeeArea, isCatalogKey, userHasPermission, type PermissionArea } from "./permissions.js";

export interface Notification {
  id: number;
  destinatario_id: number;
  tipo: string;
  titulo: string;
  mensagem?: string | null;
  link?: string | null;
  lida: boolean;
  criado_em: string;
  lida_em?: string | null;
}

export interface NotificationService {
  bootstrap(): Promise<void>;
  notify(destinatarioId: number, data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void>;
  notifyRole(role: "admin" | "gestor" | "user", data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void>;
  /** Quem vê alguma aba da área (permissões, não setor) + admins. */
  notifyArea(area: PermissionArea, data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void>;
  /** Quem tem a chave "<aba>:<acao>" (ex.: "erros:ver") + admins. Chave fora do catálogo: só admins. */
  notifyPermission(key: string, data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void>;
  notifySetor(setor: string, data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void>;
  listForUser(userId: number, opts?: { unreadOnly?: boolean; limit?: number }): Promise<Notification[]>;
  getUnreadCount(userId: number): Promise<number>;
  markRead(id: number, userId: number): Promise<boolean>;
  markAllRead(userId: number): Promise<boolean>;
}

export interface NotificationDeps {
  getRecipientIds(role: "admin" | "gestor" | "user"): Promise<number[]>;
  listUsers?: () => Promise<User[]>;
  /** Chamado a cada notificação criada — usado para avisar o destinatário em tempo real. */
  onNotify?(destinatarioId: number): void;
}

export function createNotificationService(config: Config, pool: Pool | undefined, deps: NotificationDeps): NotificationService {
  // Fallback em memória (demo ou banco indisponível), mesmo padrão de auth.ts.
  const memoryNotifications = new Map<number, Notification>();
  let nextId = 1;

  async function query<T = any>(sql: string, values: any[] = []): Promise<T[]> {
    if (!pool) throw new Error("Pool de banco não configurado");
    const conn = await pool.getConnection();
    try {
      return (await conn.query({ sql, timeout: config.timeoutMs }, values)) as T[];
    } finally {
      conn.release();
    }
  }

  async function notifyFn(
    destinatarioId: number,
    data: { tipo: string; titulo: string; mensagem?: string; link?: string },
  ): Promise<void> {
    if (pool) {
      try {
        await query(`INSERT INTO notificacoes (destinatario_id, tipo, titulo, mensagem, link) VALUES (?, ?, ?, ?, ?)`, [
          destinatarioId,
          data.tipo,
          data.titulo,
          data.mensagem ?? null,
          data.link ?? null,
        ]);
        deps.onNotify?.(destinatarioId);
        return;
      } catch {}
    }
    const n: Notification = {
      id: nextId++,
      destinatario_id: destinatarioId,
      tipo: data.tipo,
      titulo: data.titulo,
      mensagem: data.mensagem ?? null,
      link: data.link ?? null,
      lida: false,
      criado_em: new Date().toISOString(),
    };
    memoryNotifications.set(n.id, n);
    deps.onNotify?.(destinatarioId);
  }

  function mapRow(r: any): Notification {
    return {
      id: Number(r.id),
      destinatario_id: Number(r.destinatario_id),
      tipo: r.tipo,
      titulo: r.titulo,
      mensagem: r.mensagem ?? null,
      link: r.link ?? null,
      lida: Boolean(r.lida),
      criado_em: String(r.criado_em),
      lida_em: r.lida_em ? String(r.lida_em) : null,
    };
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS notificacoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            destinatario_id INT NOT NULL,
            tipo VARCHAR(50) NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            mensagem TEXT NULL,
            link VARCHAR(255) NULL,
            lida BOOLEAN NOT NULL DEFAULT FALSE,
            criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            lida_em DATETIME NULL,
            INDEX idx_notif_destinatario_lida (destinatario_id, lida)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err) {
        console.warn("[NotificationService] Falha ao inicializar tabela no MariaDB. Usando modo em memória:", err);
      }
    },

    async notify(destinatarioId, data) {
      return notifyFn(destinatarioId, data);
    },

    async notifyRole(role, data) {
      const recipientIds = await deps.getRecipientIds(role);
      await Promise.all(recipientIds.map((id) => notifyFn(id, data)));
    },

    async notifyArea(area, data) {
      if (deps.listUsers) {
        const users = await deps.listUsers();
        const recipients = users.filter((u) => u.status === "approved" && canSeeArea(u, area));
        await Promise.all(recipients.map((u) => notifyFn(u.id, data)));
        return;
      }
      const adminIds = await deps.getRecipientIds("admin");
      await Promise.all(adminIds.map((id) => notifyFn(id, data)));
    },

    async notifyPermission(key, data) {
      if (deps.listUsers && isCatalogKey(key)) {
        const users = await deps.listUsers();
        const recipients = users.filter((u) => u.status === "approved" && userHasPermission(u, key));
        await Promise.all(recipients.map((u) => notifyFn(u.id, data)));
        return;
      }
      const adminIds = await deps.getRecipientIds("admin");
      await Promise.all(adminIds.map((id) => notifyFn(id, data)));
    },

    async notifySetor(setor, data) {
      if (deps.listUsers) {
        const users = await deps.listUsers();
        const normalize = (val: string) =>
          val.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
        const target = normalize(setor);
        const recipients = users.filter(
          (u) => u.status === "approved" && (normalize(u.setor || "") === target || u.role === "admin"),
        );
        await Promise.all(recipients.map((u) => notifyFn(u.id, data)));
        return;
      }
      const adminIds = await deps.getRecipientIds("admin");
      await Promise.all(adminIds.map((id) => notifyFn(id, data)));
    },

    async listForUser(userId, opts) {
      const limit = opts?.limit ?? 30;
      if (pool) {
        try {
          const rows = await query<any>(
            `SELECT id, destinatario_id, tipo, titulo, mensagem, link, lida,
                    DATE_FORMAT(criado_em, '%Y-%m-%dT%H:%i:%sZ') AS criado_em,
                    DATE_FORMAT(lida_em, '%Y-%m-%dT%H:%i:%sZ') AS lida_em
             FROM notificacoes
             WHERE destinatario_id = ? ${opts?.unreadOnly ? "AND lida = FALSE" : ""}
             ORDER BY criado_em DESC LIMIT ?`,
            [userId, limit],
          );
          return rows.map(mapRow);
        } catch {}
      }
      return Array.from(memoryNotifications.values())
        .filter((n) => n.destinatario_id === userId && (!opts?.unreadOnly || !n.lida))
        .sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1))
        .slice(0, limit);
    },

    async getUnreadCount(userId) {
      if (pool) {
        try {
          const rows = await query<any>(
            "SELECT COUNT(*) as count FROM notificacoes WHERE destinatario_id = ? AND lida = FALSE",
            [userId],
          );
          return Number(rows[0]?.count || 0);
        } catch {}
      }
      let count = 0;
      for (const n of memoryNotifications.values()) {
        if (n.destinatario_id === userId && !n.lida) count++;
      }
      return count;
    },

    async markRead(id, userId) {
      if (pool) {
        try {
          await query("UPDATE notificacoes SET lida = TRUE, lida_em = NOW() WHERE id = ? AND destinatario_id = ?", [
            id,
            userId,
          ]);
          return true;
        } catch {}
      }
      const n = memoryNotifications.get(id);
      if (n && n.destinatario_id === userId) {
        n.lida = true;
        n.lida_em = new Date().toISOString();
        return true;
      }
      return false;
    },

    async markAllRead(userId) {
      if (pool) {
        try {
          await query("UPDATE notificacoes SET lida = TRUE, lida_em = NOW() WHERE destinatario_id = ? AND lida = FALSE", [
            userId,
          ]);
          return true;
        } catch {}
      }
      for (const n of memoryNotifications.values()) {
        if (n.destinatario_id === userId && !n.lida) {
          n.lida = true;
          n.lida_em = new Date().toISOString();
        }
      }
      return true;
    },
  };
}
