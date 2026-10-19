import { PublicError } from "./errors.js";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";

export type IncidentAutomationId = "accounts-payable" | "danfe-tiny";

export interface Incident {
  id: string;
  executionId: string;
  automationId: IncidentAutomationId;
  automationTitle: string;
  stoppedNode?: string;
  reportedBy: string;
  userRole: string;
  reportedAt: string;
  status: "pending" | "resolved";
  diagnosticExplanation: string;
  recommendedAction: string;
  operatorNote?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface IncidentReportInput {
  executionId: string;
  automationId: IncidentAutomationId;
  automationTitle: string;
  stoppedNode?: string;
  diagnosticExplanation: string;
  recommendedAction: string;
  operatorNote?: string;
}

export interface IncidentReporter {
  id: number;
  nome: string;
  role: string;
}

export interface IncidentService {
  bootstrap(): Promise<void>;
  list(opts?: { status?: "pending" | "resolved"; limit?: number }): Promise<Incident[]>;
  report(reporter: IncidentReporter, input: IncidentReportInput): Promise<Incident>;
  resolve(id: string, resolvedBy: string): Promise<boolean>;
}

const AUTOMATION_IDS: readonly IncidentAutomationId[] = ["accounts-payable", "danfe-tiny"];

/** Valida e normaliza o corpo de POST /api/incidents — lança Error com mensagem pro usuário. */
export function parseIncidentReport(body: unknown): IncidentReportInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const executionId = str(b.executionId, 255);
  if (!executionId) throw new PublicError(400, "executionId é obrigatório.");
  if (!AUTOMATION_IDS.includes(b.automationId as IncidentAutomationId)) {
    throw new PublicError(400, "automationId inválido.");
  }
  return {
    executionId,
    automationId: b.automationId as IncidentAutomationId,
    automationTitle: str(b.automationTitle, 255) || String(b.automationId),
    stoppedNode: str(b.stoppedNode, 255) || undefined,
    diagnosticExplanation: str(b.diagnosticExplanation, 4000),
    recommendedAction: str(b.recommendedAction, 4000),
    operatorNote: str(b.operatorNote, 2000) || undefined,
  };
}

/**
 * Incidentes reportados pelos operadores (botão "Reportar" em execuções/NF-e com falha).
 * Antes viviam só no localStorage de quem reportava — o admin nunca via o reporte de outra
 * máquina. Agora ficam no MariaDB, com fallback em memória (demo ou banco indisponível),
 * mesmo padrão de notifications.ts.
 */
export function createIncidentService(
  config: Config,
  pool: Pool | undefined,
  deps: { notifyAdmins?(data: { tipo: string; titulo: string; mensagem?: string; link?: string }): Promise<void> } = {},
): IncidentService {
  const memory = new Map<string, Incident>();
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

  function mapRow(r: any): Incident {
    return {
      id: String(r.id),
      executionId: r.execution_id,
      automationId: r.automation_id,
      automationTitle: r.automation_title,
      stoppedNode: r.stopped_node ?? undefined,
      reportedBy: r.reported_by,
      userRole: r.user_role,
      reportedAt: String(r.reported_at),
      status: r.status,
      diagnosticExplanation: r.diagnostic_explanation ?? "",
      recommendedAction: r.recommended_action ?? "",
      operatorNote: r.operator_note ?? undefined,
      resolvedAt: r.resolved_at ? String(r.resolved_at) : undefined,
      resolvedBy: r.resolved_by ?? undefined,
    };
  }

  const SELECT = `SELECT id, execution_id, automation_id, automation_title, stopped_node, reported_by, user_role,
                         DATE_FORMAT(reported_at, '%Y-%m-%dT%H:%i:%sZ') AS reported_at, status,
                         diagnostic_explanation, recommended_action, operator_note,
                         DATE_FORMAT(resolved_at, '%Y-%m-%dT%H:%i:%sZ') AS resolved_at, resolved_by
                  FROM incidentes`;

  async function notifyReported(incident: Incident) {
    if (!deps.notifyAdmins) return;
    try {
      await deps.notifyAdmins({
        tipo: "incidente_reportado",
        titulo: `Incidente reportado: ${incident.automationTitle}`,
        mensagem: `${incident.reportedBy} reportou falha na execução ${incident.executionId}${
          incident.stoppedNode ? ` (etapa "${incident.stoppedNode}")` : ""
        }.`,
        link: "/admin/usuarios",
      });
    } catch {
      // notificação é best-effort; o incidente já foi gravado
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
            INDEX idx_incidentes_status (status),
            INDEX idx_incidentes_execucao (execution_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err) {
        console.warn("[IncidentService] Falha ao inicializar tabela no MariaDB. Usando modo em memória:", err);
      }
    },

    async list(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
      if (pool) {
        try {
          const rows = await query<any>(
            `${SELECT} ${opts?.status ? "WHERE status = ?" : ""} ORDER BY reported_at DESC, id DESC LIMIT ?`,
            opts?.status ? [opts.status, limit] : [limit],
          );
          return rows.map(mapRow);
        } catch {}
      }
      return Array.from(memory.values())
        .filter((i) => !opts?.status || i.status === opts.status)
        .sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : -1))
        .slice(0, limit);
    },

    async report(reporter, input) {
      // Um reporte pendente por execução: reportar de novo atualiza o existente (mesmo
      // comportamento que o store em localStorage tinha).
      if (pool) {
        try {
          const existing = await query<any>(
            "SELECT id FROM incidentes WHERE execution_id = ? AND status = 'pending' LIMIT 1",
            [input.executionId],
          );
          const values = [
            input.automationId,
            input.automationTitle,
            input.stoppedNode ?? null,
            reporter.id,
            reporter.nome,
            reporter.role,
            input.diagnosticExplanation,
            input.recommendedAction,
            input.operatorNote ?? null,
          ];
          let id: number;
          if (existing[0]) {
            id = Number(existing[0].id);
            await query(
              `UPDATE incidentes SET automation_id = ?, automation_title = ?, stopped_node = ?, reported_by_id = ?,
                 reported_by = ?, user_role = ?, diagnostic_explanation = ?, recommended_action = ?, operator_note = ?,
                 reported_at = NOW()
               WHERE id = ?`,
              [...values, id],
            );
          } else {
            const result = (await query(
              `INSERT INTO incidentes (automation_id, automation_title, stopped_node, reported_by_id, reported_by, user_role,
                 diagnostic_explanation, recommended_action, operator_note, execution_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [...values, input.executionId],
            )) as unknown as { insertId: number | bigint };
            id = Number(result.insertId);
          }
          const rows = await query<any>(`${SELECT} WHERE id = ?`, [id]);
          const incident = mapRow(rows[0]);
          await notifyReported(incident);
          return incident;
        } catch (err) {
          console.warn("[IncidentService] Falha ao gravar incidente no MariaDB, usando memória:", err);
        }
      }
      const existing = Array.from(memory.values()).find(
        (i) => i.executionId === input.executionId && i.status === "pending",
      );
      const incident: Incident = {
        ...input,
        id: existing?.id ?? `mem-${nextId++}`,
        reportedBy: reporter.nome,
        userRole: reporter.role,
        reportedAt: new Date().toISOString(),
        status: "pending",
      };
      memory.set(incident.id, incident);
      await notifyReported(incident);
      return incident;
    },

    async resolve(id, resolvedBy) {
      if (pool && /^\d+$/.test(id)) {
        try {
          await query(
            "UPDATE incidentes SET status = 'resolved', resolved_at = NOW(), resolved_by = ? WHERE id = ? AND status = 'pending'",
            [resolvedBy, Number(id)],
          );
          return true;
        } catch {}
      }
      const incident = memory.get(id);
      if (!incident) return false;
      incident.status = "resolved";
      incident.resolvedAt = new Date().toISOString();
      incident.resolvedBy = resolvedBy;
      return true;
    },
  };
}
