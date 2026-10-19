import { PublicError } from "./errors.js";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";

export interface DirectMessage {
  id: number;
  remetente_id: number;
  destinatario_id: number;
  conteudo: string;
  enviado_em: string;
  lida: boolean;
  lida_em?: string | null;
}

export interface ChatContact {
  id: number;
  nome: string;
  username: string;
  foto_perfil?: string | null;
  setor: string;
  role: string;
}

export interface ConversationSummary {
  outroUsuarioId: number;
  ultimaMensagem: string;
  enviadoEm: string;
  naoLidas: number;
}

export interface ChatService {
  bootstrap(): Promise<void>;
  listContacts(currentUserId: number): Promise<ChatContact[]>;
  listConversations(userId: number): Promise<ConversationSummary[]>;
  listMessages(userId: number, otherUserId: number, opts?: { limit?: number; before?: string }): Promise<DirectMessage[]>;
  sendMessage(remetenteId: number, destinatarioId: number, conteudo: string): Promise<DirectMessage>;
  markConversationRead(userId: number, otherUserId: number): Promise<void>;
  getTotalUnreadCount(userId: number): Promise<number>;
}

export interface ChatDeps {
  // Fonte única de usuários (reaproveita auth.ts, evita duplicar o Map em memória de usuários).
  listApprovedUsers(): Promise<ChatContact[]>;
}

export function createChatService(config: Config, pool: Pool | undefined, deps: ChatDeps): ChatService {
  const memoryMessages = new Map<number, DirectMessage>();
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

  function mapRow(r: any): DirectMessage {
    return {
      id: Number(r.id),
      remetente_id: Number(r.remetente_id),
      destinatario_id: Number(r.destinatario_id),
      conteudo: r.conteudo,
      enviado_em: String(r.enviado_em),
      lida: Boolean(r.lida),
      lida_em: r.lida_em ? String(r.lida_em) : null,
    };
  }

  function memoryConversationMessages(userId: number, otherUserId: number): DirectMessage[] {
    return Array.from(memoryMessages.values()).filter(
      (m) =>
        (m.remetente_id === userId && m.destinatario_id === otherUserId) ||
        (m.remetente_id === otherUserId && m.destinatario_id === userId),
    );
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS mensagens_diretas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            remetente_id INT NOT NULL,
            destinatario_id INT NOT NULL,
            conteudo TEXT NOT NULL,
            enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            lida BOOLEAN NOT NULL DEFAULT FALSE,
            lida_em DATETIME NULL,
            INDEX idx_msg_conversa (remetente_id, destinatario_id, enviado_em),
            INDEX idx_msg_destinatario_lida (destinatario_id, lida)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err) {
        console.warn("[ChatService] Falha ao inicializar tabela no MariaDB. Usando modo em memória:", err);
      }
    },

    async listContacts(currentUserId) {
      const users = await deps.listApprovedUsers();
      return users.filter((u) => u.id !== currentUserId);
    },

    async listConversations(userId) {
      if (pool) {
        try {
          const rows = await query<any>(
            `SELECT
               CASE WHEN remetente_id = ? THEN destinatario_id ELSE remetente_id END AS outro_usuario_id,
               conteudo, enviado_em, lida, destinatario_id
             FROM mensagens_diretas
             WHERE remetente_id = ? OR destinatario_id = ?
             ORDER BY enviado_em DESC`,
            [userId, userId, userId],
          );
          const byOther = new Map<number, ConversationSummary>();
          const unreadByOther = new Map<number, number>();
          for (const r of rows) {
            const otherId = Number(r.outro_usuario_id);
            if (!byOther.has(otherId)) {
              byOther.set(otherId, {
                outroUsuarioId: otherId,
                ultimaMensagem: r.conteudo,
                enviadoEm: String(r.enviado_em),
                naoLidas: 0,
              });
            }
            if (Number(r.destinatario_id) === userId && !r.lida) {
              unreadByOther.set(otherId, (unreadByOther.get(otherId) || 0) + 1);
            }
          }
          return Array.from(byOther.values())
            .map((c) => ({ ...c, naoLidas: unreadByOther.get(c.outroUsuarioId) || 0 }))
            .sort((a, b) => (a.enviadoEm < b.enviadoEm ? 1 : -1));
        } catch {}
      }
      const byOther = new Map<number, ConversationSummary>();
      const sorted = Array.from(memoryMessages.values())
        .filter((m) => m.remetente_id === userId || m.destinatario_id === userId)
        .sort((a, b) => (a.enviado_em < b.enviado_em ? 1 : -1));
      for (const m of sorted) {
        const otherId = m.remetente_id === userId ? m.destinatario_id : m.remetente_id;
        if (!byOther.has(otherId)) {
          byOther.set(otherId, { outroUsuarioId: otherId, ultimaMensagem: m.conteudo, enviadoEm: m.enviado_em, naoLidas: 0 });
        }
      }
      for (const m of memoryMessages.values()) {
        if (m.destinatario_id === userId && !m.lida) {
          const c = byOther.get(m.remetente_id);
          if (c) c.naoLidas += 1;
        }
      }
      return Array.from(byOther.values()).sort((a, b) => (a.enviadoEm < b.enviadoEm ? 1 : -1));
    },

    async listMessages(userId, otherUserId, opts) {
      const limit = opts?.limit ?? 50;
      if (pool) {
        try {
          const rows = await query<any>(
            `SELECT id, remetente_id, destinatario_id, conteudo,
                    DATE_FORMAT(enviado_em, '%Y-%m-%dT%H:%i:%sZ') AS enviado_em, lida,
                    DATE_FORMAT(lida_em, '%Y-%m-%dT%H:%i:%sZ') AS lida_em
             FROM mensagens_diretas
             WHERE (remetente_id = ? AND destinatario_id = ?) OR (remetente_id = ? AND destinatario_id = ?)
             ${opts?.before ? "AND enviado_em < ?" : ""}
             ORDER BY enviado_em DESC LIMIT ?`,
            opts?.before
              ? [userId, otherUserId, otherUserId, userId, opts.before, limit]
              : [userId, otherUserId, otherUserId, userId, limit],
          );
          return rows.map(mapRow).reverse();
        } catch {}
      }
      return memoryConversationMessages(userId, otherUserId)
        .sort((a, b) => (a.enviado_em < b.enviado_em ? -1 : 1))
        .slice(-limit);
    },

    async sendMessage(remetenteId, destinatarioId, conteudo) {
      const texto = conteudo.trim();
      if (!texto) throw new PublicError(400, "A mensagem não pode estar vazia.");
      if (texto.length > 4000) throw new PublicError(400, "Mensagem muito longa (máximo 4000 caracteres).");

      if (pool) {
        try {
          const res: any = await query(
            `INSERT INTO mensagens_diretas (remetente_id, destinatario_id, conteudo) VALUES (?, ?, ?)`,
            [remetenteId, destinatarioId, texto],
          );
          return {
            id: Number(res.insertId),
            remetente_id: remetenteId,
            destinatario_id: destinatarioId,
            conteudo: texto,
            enviado_em: new Date().toISOString(),
            lida: false,
          };
        } catch {}
      }
      const m: DirectMessage = {
        id: nextId++,
        remetente_id: remetenteId,
        destinatario_id: destinatarioId,
        conteudo: texto,
        enviado_em: new Date().toISOString(),
        lida: false,
      };
      memoryMessages.set(m.id, m);
      return m;
    },

    async markConversationRead(userId, otherUserId) {
      if (pool) {
        try {
          await query(
            "UPDATE mensagens_diretas SET lida = TRUE, lida_em = NOW() WHERE destinatario_id = ? AND remetente_id = ? AND lida = FALSE",
            [userId, otherUserId],
          );
          return;
        } catch {}
      }
      for (const m of memoryMessages.values()) {
        if (m.destinatario_id === userId && m.remetente_id === otherUserId && !m.lida) {
          m.lida = true;
          m.lida_em = new Date().toISOString();
        }
      }
    },

    async getTotalUnreadCount(userId) {
      if (pool) {
        try {
          const rows = await query<any>(
            "SELECT COUNT(*) as count FROM mensagens_diretas WHERE destinatario_id = ? AND lida = FALSE",
            [userId],
          );
          return Number(rows[0]?.count || 0);
        } catch {}
      }
      let count = 0;
      for (const m of memoryMessages.values()) {
        if (m.destinatario_id === userId && !m.lida) count++;
      }
      return count;
    },
  };
}
