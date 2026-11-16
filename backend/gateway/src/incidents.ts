import { PublicError, logWarn } from "./errors.js";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";
import { asWriteResult, type DbRow } from "./database.js";
import { mascarar } from "./atividades.js";
import type { AgentesQwenGrupo, AgentesQwenIncidente, AgentesQwenReporte, AgentesQwenReportes } from "./agentes-qwen.js";

/**
 * Automações com o botão "Reportar erro": título, serviço do compose que roda o código (é por ele
 * que o PC dos agentes junta o reporte ao incidente do mesmo erro vindo do log) e a aba que precisa
 * ver para reportar ou ver o reporte.
 */
export const AUTOMACOES_REPORTAVEIS = {
  "accounts-payable": { titulo: "Contas a Pagar", servico: "n8n", ver: "contas_pagar:ver" },
  "inter-reconciliation": { titulo: "Conciliação Banco Inter", servico: "automacao-nfe", ver: "contas_pagar:ver" },
  "ml-reconciliation": { titulo: "Conciliação Mercado Livre", servico: "automacao-nfe", ver: "conciliacao_ml:ver" },
  "danfe-tiny": { titulo: "NF-e & DANFE", servico: "automacao-nfe", ver: "revisao_nfe:ver" },
  "financial-dashboard": { titulo: "Dashboards Financeiro", servico: "gateway", ver: "dashboard_financeiro:ver" },
  "stock-count": { titulo: "Contagem de estoque", servico: "contagem-estoque", ver: "contagem_estoque:ver" },
  "dimension-standardization": { titulo: "Padronização de dimensões", servico: "automacoes-marketplace", ver: "dimensoes:ver" },
  "shipping-review": { titulo: "Fretes a combinar", servico: "automacoes-marketplace", ver: "fretes:ver" },
} as const;

export type IncidentAutomationId = keyof typeof AUTOMACOES_REPORTAVEIS;

/** Reporte de erro feito por um operador numa aba, e o que os agentes Qwen fizeram com ele. */
export interface Incident {
  id: string;
  /** O que falhou: execução, SKU, chave da NF-e, empresa... (um reporte pendente por referência). */
  executionId: string;
  automationId: IncidentAutomationId;
  automationTitle: string;
  stoppedNode?: string;
  /** Mensagem de erro que a tela mostrava. */
  errorMessage: string;
  operatorNote?: string;
  reportedBy: string;
  userRole: string;
  reportedAt: string;
  /** pending até o incidente dos agentes ligado a ele ficar resolvido. */
  status: "pending" | "resolved";
  /** Incidente dos agentes Qwen que recebeu o reporte (null: ainda não entregue ao PC). */
  agentIncidentId: number | null;
  agentGroup: AgentesQwenGrupo | null;
  resolvedAt?: string;
}

export interface IncidentReportInput {
  executionId: string;
  automationId: IncidentAutomationId;
  stoppedNode?: string;
  errorMessage: string;
  operatorNote?: string;
}

export interface IncidentReporter {
  id: number;
  nome: string;
  role: string;
}

export interface IncidentService extends AgentesQwenReportes {
  bootstrap(): Promise<void>;
  list(opts?: { status?: "pending" | "resolved"; limit?: number }): Promise<Incident[]>;
  report(reporter: IncidentReporter, input: IncidentReportInput): Promise<Incident>;
}

const PENDENTES_MAX = 20;
const PENDENTE_DIAS = 7; // reporte que o PC não recebeu em 7 dias sai da fila (fica no histórico)
const GRUPOS_AGENTES = new Set<string>(["em_andamento", "pr_pendente", "aguardando_deploy", "monitorando", "precisa_ti", "resolvido"]);

export function isIncidentAutomationId(v: unknown): v is IncidentAutomationId {
  return typeof v === "string" && Object.hasOwn(AUTOMACOES_REPORTAVEIS, v);
}

/** Valida e normaliza o corpo de POST /api/incidents — lança Error com mensagem pro usuário. */
export function parseIncidentReport(body: unknown): IncidentReportInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const executionId = str(b.executionId, 255);
  if (!executionId) throw new PublicError(400, "executionId é obrigatório.");
  if (!isIncidentAutomationId(b.automationId)) throw new PublicError(400, "automationId inválido.");
  const errorMessage = str(b.errorMessage, 2000);
  if (!errorMessage) throw new PublicError(400, "errorMessage é obrigatório.");
  return {
    executionId,
    automationId: b.automationId,
    stoppedNode: str(b.stoppedNode, 255) || undefined,
    errorMessage,
    operatorNote: str(b.operatorNote, 2000) || undefined,
  };
}

/**
 * Reportes do botão "Reportar erro" (todas as abas com automação). Ficam no MariaDB (tabela
 * incidentes) e vão aos agentes Qwen pela fila de comandos do repasse (agentes-qwen.ts): cada
 * repasse leva os reportes ainda sem incidente ligado; o estado seguinte traz o id do reporte em
 * `reportes` do incidente que o recebeu, o que liga os dois. Sem banco (demo/testes): em memória.
 */
export function createIncidentService(
  config: Config,
  pool: Pool | undefined,
  deps: { notify?(data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void> } = {},
): IncidentService {
  const memory = new Map<string, Incident>();
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

  function mapRow(r: DbRow): Incident {
    const automationId = isIncidentAutomationId(r.automation_id) ? r.automation_id : "accounts-payable";
    const grupo = r.agente_grupo as string | null;
    return {
      id: String(r.id),
      executionId: r.execution_id as string,
      automationId,
      automationTitle: r.automation_title as string,
      stoppedNode: (r.stopped_node as string | null | undefined) ?? undefined,
      // Reportes de antes dos agentes não tinham a mensagem: usa o diagnóstico fixo que a tela gerava.
      errorMessage: ((r.mensagem_erro ?? r.diagnostic_explanation) as string | null | undefined) ?? "",
      operatorNote: (r.operator_note as string | null | undefined) ?? undefined,
      reportedBy: r.reported_by as string,
      userRole: r.user_role as string,
      reportedAt: String(r.reported_at),
      status: r.status as Incident["status"],
      agentIncidentId: r.agente_incidente_id == null ? null : Number(r.agente_incidente_id),
      agentGroup: grupo && GRUPOS_AGENTES.has(grupo) ? (grupo as AgentesQwenGrupo) : null,
      resolvedAt: r.resolved_at ? String(r.resolved_at) : undefined,
    };
  }

  const SELECT = `SELECT id, execution_id, automation_id, automation_title, stopped_node, reported_by, user_role,
                         DATE_FORMAT(reported_at, '%Y-%m-%dT%H:%i:%sZ') AS reported_at, status,
                         diagnostic_explanation, mensagem_erro, operator_note, agente_incidente_id, agente_grupo,
                         DATE_FORMAT(resolved_at, '%Y-%m-%dT%H:%i:%sZ') AS resolved_at
                  FROM incidentes`;

  /** O que vai ao PC dos agentes: texto livre com dados de pessoa física mascarados, como nos logs. */
  function paraAgentes(i: Incident): AgentesQwenReporte {
    const a = AUTOMACOES_REPORTAVEIS[i.automationId];
    const m = (v: string) => mascarar(v) as string;
    return {
      id: Number(i.id),
      automacao: i.automationId,
      titulo: a.titulo,
      servico: a.servico,
      referencia: m(i.executionId),
      etapa: i.stoppedNode ?? null,
      mensagem: m(i.errorMessage),
      nota: i.operatorNote ? m(i.operatorNote) : null,
      por: i.reportedBy,
      em: i.reportedAt,
    };
  }

  async function notifyReported(incident: Incident) {
    if (!deps.notify) return;
    try {
      await deps.notify({
        tipo: "agentes_qwen",
        titulo: `Erro reportado em ${incident.automationTitle}`,
        mensagem: `${incident.reportedBy}: ${incident.errorMessage}`.slice(0, 500),
        link: "/admin/agentes-qwen",
      });
    } catch (err) {
      // notificação é best-effort; o reporte já foi gravado
      logWarn("incident_notify_failed", err);
    }
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS incidentes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            execution_id VARCHAR(255) NOT NULL,
            automation_id VARCHAR(50) NOT NULL,
            automation_title VARCHAR(255) NOT NULL,
            stopped_node VARCHAR(255) NULL,
            reported_by_id INT NULL,
            reported_by VARCHAR(255) NOT NULL,
            user_role VARCHAR(50) NOT NULL,
            reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            status ENUM('pending', 'resolved') NOT NULL DEFAULT 'pending',
            diagnostic_explanation TEXT NULL,
            recommended_action TEXT NULL,
            operator_note TEXT NULL,
            resolved_at DATETIME NULL,
            resolved_by VARCHAR(255) NULL,
            mensagem_erro TEXT NULL,
            agente_incidente_id INT NULL,
            agente_grupo VARCHAR(20) NULL,
            INDEX idx_incidentes_status (status),
            INDEX idx_incidentes_execucao (execution_id),
            INDEX idx_incidentes_agente (agente_incidente_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        // Tabela de antes dos agentes Qwen (migração 2026-10-30-reportar-erro-agentes.sql).
        await query("ALTER TABLE incidentes ADD COLUMN IF NOT EXISTS mensagem_erro TEXT NULL");
        await query("ALTER TABLE incidentes ADD COLUMN IF NOT EXISTS agente_incidente_id INT NULL");
        await query("ALTER TABLE incidentes ADD COLUMN IF NOT EXISTS agente_grupo VARCHAR(20) NULL");
        await query("CREATE INDEX IF NOT EXISTS idx_incidentes_agente ON incidentes (agente_incidente_id)");
      } catch (err) {
        console.warn("[IncidentService] Falha ao inicializar tabela no MariaDB. Usando modo em memória:", err);
      }
    },

    async list(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
      if (pool) {
        try {
          const rows = await query(
            `${SELECT} ${opts?.status ? "WHERE status = ?" : ""} ORDER BY reported_at DESC, id DESC LIMIT ?`,
            opts?.status ? [opts.status, limit] : [limit],
          );
          return rows.map(mapRow);
        } catch (err) {
          logWarn("incidents_db_query_failed", err);
        }
      }
      return Array.from(memory.values())
        .filter((i) => !opts?.status || i.status === opts.status)
        .sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : -1))
        .slice(0, limit);
    },

    async report(reporter, input) {
      // Um reporte pendente por automação × referência: reportar de novo atualiza o existente.
      const title = AUTOMACOES_REPORTAVEIS[input.automationId].titulo;
      if (pool) {
        try {
          const existing = await query(
            "SELECT id FROM incidentes WHERE execution_id = ? AND automation_id = ? AND status = 'pending' LIMIT 1",
            [input.executionId, input.automationId],
          );
          const values = [
            title,
            input.stoppedNode ?? null,
            reporter.id,
            reporter.nome,
            reporter.role,
            input.errorMessage,
            input.operatorNote ?? null,
          ];
          let id: number;
          if (existing[0]) {
            id = Number(existing[0].id);
            await query(
              `UPDATE incidentes SET automation_title = ?, stopped_node = ?, reported_by_id = ?, reported_by = ?, user_role = ?,
                 mensagem_erro = ?, operator_note = ?, reported_at = NOW()
               WHERE id = ?`,
              [...values, id],
            );
          } else {
            const result = asWriteResult(await query(
              `INSERT INTO incidentes (automation_title, stopped_node, reported_by_id, reported_by, user_role,
                 mensagem_erro, operator_note, execution_id, automation_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [...values, input.executionId, input.automationId],
            ));
            id = Number(result.insertId);
          }
          const rows = await query(`${SELECT} WHERE id = ?`, [id]);
          const incident = mapRow(rows[0] as DbRow); // acabou de ser gravada
          if (!existing[0]) await notifyReported(incident);
          return incident;
        } catch (err) {
          console.warn("[IncidentService] Falha ao gravar incidente no MariaDB, usando memória:", err);
        }
      }
      const existing = Array.from(memory.values()).find(
        (i) => i.executionId === input.executionId && i.automationId === input.automationId && i.status === "pending",
      );
      const incident: Incident = {
        ...input,
        id: existing?.id ?? String(nextId++),
        automationTitle: title,
        reportedBy: reporter.nome,
        userRole: reporter.role,
        reportedAt: new Date().toISOString(),
        status: "pending",
        agentIncidentId: existing?.agentIncidentId ?? null,
        agentGroup: existing?.agentGroup ?? null,
      };
      memory.set(incident.id, incident);
      if (!existing) await notifyReported(incident);
      return incident;
    },

    async pendentes() {
      if (pool) {
        try {
          const rows = await query(
            `${SELECT} WHERE status = 'pending' AND agente_incidente_id IS NULL
               AND reported_at >= NOW() - INTERVAL ${PENDENTE_DIAS} DAY
             ORDER BY id LIMIT ${PENDENTES_MAX}`,
          );
          return rows.map(mapRow).map(paraAgentes);
        } catch (err) {
          logWarn("incidents_db_query_failed", err);
          return [];
        }
      }
      return [...memory.values()].filter((i) => i.status === "pending" && i.agentIncidentId === null).slice(0, PENDENTES_MAX).map(paraAgentes);
    },

    async sincronizar(incidentes: AgentesQwenIncidente[]) {
      // Liga cada reporte ao incidente que o recebeu e acompanha o grupo; resolvido fecha o reporte.
      const porReporte = new Map<number, AgentesQwenIncidente>();
      for (const inc of incidentes) for (const r of inc.reportes) porReporte.set(r.id, inc);
      if (pool) {
        const abertos = await query("SELECT id, agente_incidente_id FROM incidentes WHERE status = 'pending'");
        const porId = new Map(incidentes.map((i) => [i.id, i]));
        for (const r of abertos) {
          const inc = porReporte.get(Number(r.id)) ?? (r.agente_incidente_id == null ? undefined : porId.get(Number(r.agente_incidente_id)));
          if (!inc) continue;
          const resolvido = inc.grupo === "resolvido";
          await query(
            `UPDATE incidentes SET agente_incidente_id = ?, agente_grupo = ?, status = ?, resolved_at = ${resolvido ? "NOW()" : "NULL"},
               resolved_by = ? WHERE id = ?`,
            [inc.id, inc.grupo, resolvido ? "resolved" : "pending", resolvido ? "Agentes Qwen" : null, Number(r.id)],
          );
        }
        return;
      }
      const porId = new Map(incidentes.map((i) => [i.id, i]));
      for (const i of memory.values()) {
        if (i.status !== "pending") continue;
        const inc = porReporte.get(Number(i.id)) ?? (i.agentIncidentId === null ? undefined : porId.get(i.agentIncidentId));
        if (!inc) continue;
        i.agentIncidentId = inc.id;
        i.agentGroup = inc.grupo;
        if (inc.grupo === "resolvido") {
          i.status = "resolved";
          i.resolvedAt = new Date().toISOString();
        }
      }
    },
  };
}
