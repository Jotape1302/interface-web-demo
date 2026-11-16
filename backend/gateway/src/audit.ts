import type { Pool } from "mariadb";
import type { RoiPeriodo } from "./contracts.js";
import { logWarn } from "./errors.js";
import type { Config } from "./config.js";
import { noPeriodo, periodoSql } from "./periodo.js";
import type { DbRow } from "./database.js";

/**
 * Ações de usuário registradas no log de auditoria. O rótulo em português de cada uma
 * fica no frontend (frontend/lib/audit-actions.ts).
 */
export const AUDIT_ACTIONS = [
  "login",
  "login_falhou",
  "logout",
  "senha_alterada",
  "alteracao_cadastro_solicitada",
  "usuario_criado",
  "usuario_aprovado",
  "usuario_rejeitado",
  "usuario_excluido",
  "permissoes_alteradas",
  "perfil_alterado",
  "setor_alterado",
  "sessao_encerrada",
  "sessoes_usuario_encerradas",
  "alteracao_cadastro_aprovada",
  "alteracao_cadastro_rejeitada",
  "workflow_token_disparado",
  "incidente_reportado",
  "incidente_resolvido",
  "agentes_qwen_resolvido",
  "nfe_varredura_sefaz",
  "nfe_lote_enviado",
  "nfe_lancada",
  "nfe_arquivada",
  "nfe_restaurada",
  "nfe_falha_resolvida",
  "dashboard_financeiro_sincronizado",
  "baixa_conciliacao_executada",
  "conciliacao_ml_executada",
  "baixa_conciliacao_ml_executada",
  "dda_executado",
  "dda_conta_vinculada",
  "dda_conta_criada",
  "dda_boleto_descartado",
  "dda_boleto_reaberto",
  "dda_boletos_validados",
  "dda_contas_criadas_lote",
  "conciliacao_ml_lancamentos_exportados",
  "conciliacao_ml_tarifas_lancadas",
  "conciliacao_ml_tarifas_conferidas",
  "conciliacao_ml_tarifas_refeitas_manual",
  "sincronizacao_tokens_ml_solicitada",
  "nfe_importada_chave",
  "fretes_medidas_enviadas",
  "fretes_medidas_salvas",
  "fretes_verificacao_manual",
  "fretes_nova_tentativa",
  "fretes_tipo_corrigido",
  "dimensoes_validadas",
  "dimensoes_reenviadas",
  "dimensoes_coleta_manual",
  "etiquetas_geradas",
  "contagem_estoque_sku_informado",
  "contagem_estoque_excluida",
  "contagem_estoque_conferida",
  "contagem_estoque_tiny",
  "marketing_lote_gerado",
  "marketing_rascunho_aprovado",
  "marketing_produto_alterado",
  "marketing_ambientes_gerar",
  "marketing_ambiente_aprovado",
  "marketing_ambiente_recusado",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: string;
  usuarioId: number | null;
  usuarioNome: string;
  acao: AuditAction;
  alvo?: string;
  detalhes?: Record<string, unknown>;
  sucesso: boolean;
  ip?: string;
  criadoEm: string;
}

export interface AuditInput {
  actor: { id: number; nome: string } | null;
  /** Usado quando não há usuário identificado (ex.: login com senha errada). */
  actorLabel?: string;
  acao: AuditAction;
  alvo?: string;
  detalhes?: Record<string, unknown>;
  sucesso?: boolean;
  ip?: string;
}

export interface AuditQuery {
  limit?: number;
  /** Paginação: só entradas com id menor que este. */
  before?: string;
  usuarioId?: number;
  acao?: AuditAction;
  /** Busca livre em usuário, alvo e detalhes. */
  q?: string;
}

export interface AuditService {
  bootstrap(): Promise<void>;
  /** Nunca lança: auditoria é best-effort e não pode derrubar a ação auditada. */
  record(input: AuditInput): Promise<void>;
  list(query?: AuditQuery): Promise<AuditEntry[]>;
  /** Soma o campo numérico `detalhes.<campo>` de todas as entradas da ação (usado pelo ROI). Rejeita se o banco falhar. */
  somarDetalhe(acao: AuditAction, campo: "sucessos", periodo?: RoiPeriodo): Promise<number>;
}

const MEMORY_LIMIT = 2000;

/**
 * Log de auditoria das ações dos usuários (quem aprovou, excluiu, lançou, resolveu…).
 * Fica no MariaDB, com fallback em memória (demo ou banco indisponível), mesmo padrão de
 * incidents.ts. Não guarda senha, token nem conteúdo de nota fiscal: só quem, o quê, em
 * quê e quando.
 */
export function createAuditService(config: Config, pool: Pool | undefined): AuditService {
  const memory: AuditEntry[] = [];
  let nextId = 1;

  async function query<T = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    if (!pool) throw new Error("Pool de banco não configurado");
    const conn = await pool.getConnection();
    try {
      return (await conn.query({ sql, timeout: config.timeoutMs }, values)) as T[];
    } finally {
      conn.release();
    }
  }

  function mapRow(r: DbRow): AuditEntry {
    let detalhes: Record<string, unknown> | undefined;
    if (r.detalhes) {
      try {
        detalhes = typeof r.detalhes === "string" ? JSON.parse(r.detalhes) : r.detalhes;
      } catch {
        detalhes = undefined;
      }
    }
    return {
      id: String(r.id),
      usuarioId: r.usuario_id === null || r.usuario_id === undefined ? null : Number(r.usuario_id),
      usuarioNome: r.usuario_nome as string,
      acao: r.acao as AuditEntry["acao"],
      alvo: (r.alvo as string | null | undefined) ?? undefined,
      detalhes,
      sucesso: Boolean(r.sucesso),
      ip: (r.ip as string | null | undefined) ?? undefined,
      criadoEm: String(r.criado_em),
    };
  }

  function matchesMemory(entry: AuditEntry, q: AuditQuery): boolean {
    if (q.before && Number(entry.id) >= Number(q.before)) return false;
    if (q.usuarioId !== undefined && entry.usuarioId !== q.usuarioId) return false;
    if (q.acao && entry.acao !== q.acao) return false;
    if (q.q) {
      const needle = q.q.toLowerCase();
      const hay = `${entry.usuarioNome} ${entry.alvo ?? ""} ${JSON.stringify(entry.detalhes ?? {})}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }

  function toEntry(input: AuditInput, id: string): AuditEntry {
    return {
      id,
      usuarioId: input.actor?.id ?? null,
      usuarioNome: input.actor?.nome ?? input.actorLabel ?? "Não identificado",
      acao: input.acao,
      alvo: input.alvo,
      detalhes: input.detalhes,
      sucesso: input.sucesso ?? true,
      ip: input.ip,
      criadoEm: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS auditoria_acoes (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NULL,
            usuario_nome VARCHAR(255) NOT NULL,
            acao VARCHAR(64) NOT NULL,
            alvo VARCHAR(255) NULL,
            detalhes TEXT NULL,
            sucesso TINYINT(1) NOT NULL DEFAULT 1,
            ip VARCHAR(64) NULL,
            criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_auditoria_criado (criado_em),
            INDEX idx_auditoria_usuario (usuario_id),
            INDEX idx_auditoria_acao (acao)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err) {
        console.warn("[AuditService] Falha ao inicializar tabela no MariaDB. Usando modo em memória:", err);
      }
    },

    async record(input) {
      const alvo = input.alvo?.slice(0, 255);
      const detalhes = input.detalhes && Object.keys(input.detalhes).length > 0 ? input.detalhes : undefined;
      const normalized = { ...input, alvo, detalhes };
      if (pool) {
        try {
          await query(
            `INSERT INTO auditoria_acoes (usuario_id, usuario_nome, acao, alvo, detalhes, sucesso, ip, criado_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
            [
              normalized.actor?.id ?? null,
              (normalized.actor?.nome ?? normalized.actorLabel ?? "Não identificado").slice(0, 255),
              normalized.acao,
              alvo ?? null,
              detalhes ? JSON.stringify(detalhes).slice(0, 8000) : null,
              normalized.sucesso === false ? 0 : 1,
              normalized.ip?.slice(0, 64) ?? null,
            ],
          );
          return;
        } catch (err) {
          console.warn("[AuditService] Falha ao gravar auditoria no MariaDB, usando memória:", err);
        }
      }
      memory.unshift(toEntry(normalized, String(nextId++)));
      if (memory.length > MEMORY_LIMIT) memory.length = MEMORY_LIMIT;
    },

    async list(q = {}) {
      const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
      if (pool) {
        try {
          const where: string[] = [];
          const values: unknown[] = [];
          if (q.before && /^\d+$/.test(q.before)) {
            where.push("id < ?");
            values.push(Number(q.before));
          }
          if (q.usuarioId !== undefined) {
            where.push("usuario_id = ?");
            values.push(q.usuarioId);
          }
          if (q.acao) {
            where.push("acao = ?");
            values.push(q.acao);
          }
          if (q.q) {
            where.push("(usuario_nome LIKE ? OR alvo LIKE ? OR detalhes LIKE ?)");
            const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            values.push(like, like, like);
          }
          const rows = await query(
            `SELECT id, usuario_id, usuario_nome, acao, alvo, detalhes, sucesso, ip,
                    DATE_FORMAT(criado_em, '%Y-%m-%dT%H:%i:%sZ') AS criado_em
             FROM auditoria_acoes
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY id DESC LIMIT ?`,
            [...values, limit],
          );
          return rows.map(mapRow);
        } catch (err) {
          logWarn("audit_db_query_failed", err);
        }
      }
      return memory.filter((e) => matchesMemory(e, q)).slice(0, limit);
    },

    async somarDetalhe(acao, campo, periodo) {
      if (pool) {
        const f = periodoSql("criado_em", periodo);
        const [row] = await query<{ total: number | bigint | string | null }>(
          `SELECT COALESCE(SUM(CAST(JSON_VALUE(detalhes, ?) AS UNSIGNED)), 0) AS total
             FROM auditoria_acoes WHERE ${["acao = ?", "detalhes IS NOT NULL", "JSON_VALID(detalhes)", ...f.where].join(" AND ")}`,
          [`$.${campo}`, acao, ...f.values],
        );
        return Number(row?.total ?? 0);
      }
      return memory
        .filter((e) => e.acao === acao && noPeriodo(e.criadoEm, periodo))
        .reduce((soma, e) => soma + (Number.isFinite(Number(e.detalhes?.[campo])) ? Number(e.detalhes?.[campo]) : 0), 0);
    },
  };
}

/** Valida os filtros de GET /api/admin/audit. */
export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const acao = params.get("acao") ?? "";
  const usuarioId = params.get("usuarioId");
  const limit = params.get("limit");
  return {
    limit: limit && /^\d+$/.test(limit) ? Number(limit) : undefined,
    before: params.get("before") || undefined,
    usuarioId: usuarioId && /^\d+$/.test(usuarioId) ? Number(usuarioId) : undefined,
    acao: (AUDIT_ACTIONS as readonly string[]).includes(acao) ? (acao as AuditAction) : undefined,
    q: params.get("q")?.trim().slice(0, 100) || undefined,
  };
}
