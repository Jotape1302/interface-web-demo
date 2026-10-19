import { randomUUID } from "node:crypto";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";
import type { Account, DatabaseSnapshot, Execution, HistoryWindow } from "./contracts.js";
import { metricsFromCounts } from "./database.js";

/**
 * Histórico das baixas executadas pela conciliação Inter × Tiny (tela Contas a Pagar).
 * Uma linha por conta enviada para baixa, com sucesso ou erro, gravada pelo gateway porque
 * é ele quem sabe qual usuário executou. Espelha BaixaHistorico* em
 * frontend/lib/reconciliation-contracts.ts.
 */

export interface BaixaHistoricoItem {
  id: number;
  lote_id: string;
  executado_em: string;
  usuario_nome: string | null;
  empresa: string;
  conta_pagar_id: number;
  numero_documento: string | null;
  fornecedor_nome: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  valor_tiny: number | null;
  valor_pago: number;
  juros: number;
  multa: number;
  desconto: number;
  inter_transacao_id: string | null;
  metodo_match: string | null;
  /** `pendente`: baixa enviada ao Tiny e ainda sem resultado (tarefa em segundo plano). */
  status: "sucesso" | "erro" | "pendente";
  mensagem: string | null;
}

export type BaixaHistoricoStatus = "sucesso" | "erro" | "pendente";

export interface BaixaHistoricoQuery {
  /** Uma ou mais empresas (na URL, separadas por vírgula). */
  empresa?: string[];
  /** Um ou mais resultados (na URL, separados por vírgula). */
  status?: BaixaHistoricoStatus[];
  de?: string;
  ate?: string;
  /** Busca livre (fornecedor, documento, usuário, conta ou transação). */
  q?: string;
  /** Filtros de coluna: cada um restringe só o seu campo (combinados com E). */
  fornecedor?: string;
  documento?: string;
  usuario?: string;
  page: number;
  pageSize: number;
}

export interface BaixaHistoricoPage {
  disponivel: boolean;
  itens: BaixaHistoricoItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Item como o frontend envia para POST /api/reconciliation/baixar (BaixaItemInput). */
export interface BaixaRequestItem {
  empresa?: unknown;
  conta_pagar_id?: unknown;
  valor_pago?: unknown;
  data_pagamento?: unknown;
  juros?: unknown;
  multa?: unknown;
  desconto?: unknown;
  numero_documento?: unknown;
  fornecedor_nome?: unknown;
  data_vencimento?: unknown;
  valor_tiny?: unknown;
  inter_transacao_id?: unknown;
  metodo_match?: unknown;
}

/**
 * Resultado por conta devolvido pela API Python (BaixaItemResult). Desde 2026-10-06 a automação
 * usa os valores do extrato guardado na prévia (não os do cliente) e devolve os efetivamente
 * usados — são ESTES que vão para o histórico quando presentes.
 */
export interface BaixaResultItem {
  conta_pagar_id?: unknown;
  empresa?: unknown;
  inter_transacao_id?: unknown;
  status?: unknown;
  mensagem?: unknown;
  valor_pago?: unknown;
  data_pagamento?: unknown;
  juros?: unknown;
  multa?: unknown;
  desconto?: unknown;
}

/** Valores efetivos: os do resultado da automação, com os do pedido só como reserva. */
function efetivo(item: BaixaRequestItem, res: BaixaResultItem | undefined): BaixaRequestItem {
  if (!res) return item;
  const pick = (k: "valor_pago" | "data_pagamento" | "juros" | "multa" | "desconto" | "inter_transacao_id") =>
    res[k] !== undefined && res[k] !== null && res[k] !== "" ? res[k] : item[k];
  return {
    ...item,
    inter_transacao_id: pick("inter_transacao_id"),
    valor_pago: pick("valor_pago"),
    data_pagamento: pick("data_pagamento"),
    juros: pick("juros"),
    multa: pick("multa"),
    desconto: pick("desconto"),
  };
}

export interface BaixaResumo {
  /** Contas baixadas com sucesso (todas as execuções). */
  contasBaixadas: number;
  valorBaixado: number;
}

export interface ReconciliationHistoryService {
  bootstrap(): Promise<void>;
  recordBatch(input: {
    usuarioId: number | null;
    usuarioNome: string | null;
    itens: BaixaRequestItem[];
    resultados: BaixaResultItem[];
  }): Promise<void>;
  /**
   * Grava as contas de uma tarefa de baixa como `pendente` assim que ela começa (lote_id = id
   * da tarefa). Assim, se o gateway reiniciar no meio, a baixa não some do histórico: o lote
   * volta a ser acompanhado (`pendingLotes`) e é fechado por `completeBatch`. Devolve false se
   * não gravou (sem banco ou falha).
   */
  recordPending(input: {
    loteId: string;
    usuarioId: number | null;
    usuarioNome: string | null;
    itens: BaixaRequestItem[];
  }): Promise<boolean>;
  /** Fecha um lote pendente com o resultado de cada conta. */
  completeBatch(input: { loteId: string; resultados: BaixaResultItem[]; erroGeral?: string | null }): Promise<void>;
  /** Lotes ainda pendentes (para retomar o acompanhamento depois de reiniciar o gateway). */
  pendingLotes(): Promise<string[]>;
  list(query: BaixaHistoricoQuery): Promise<BaixaHistoricoPage>;
  resumo(): Promise<BaixaResumo | null>;
  /**
   * Métricas de ROI e falhas recentes do painel Contas a Pagar (DatabaseAdapter). Substitui a
   * leitura da tabela conciliacao_contas_pagar do antigo fluxo n8n. Rejeita sem MariaDB, para o
   * painel mostrar a fonte como indisponível em vez de métricas zeradas.
   */
  snapshot(): Promise<DatabaseSnapshot>;
  /** Cada lote de baixa vira uma execução no histórico de 14 dias da Visão geral. */
  readHistory(window: HistoryWindow): Promise<{ complete: boolean; executions: Execution[] }>;
}

/** Minutos de trabalho manual poupados por conta baixada (mesma hipótese de docs/metrics.md). */
export const MINUTOS_POR_BAIXA = 5;

/** "2026-09-28 14:03:00" (DATETIME em UTC, dateStrings) -> ISO com Z. */
function utcDatetimeToIso(value: unknown): string | null {
  if (!value) return null;
  const s = String(value).trim().replace(" ", "T");
  const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** ISO -> "YYYY-MM-DD HH:MM:SS" em UTC, para comparar com executado_em. */
function isoToUtcDatetime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDate(value: unknown): string | null {
  const s = str(value, 10);
  return s && DATE_RE.test(s) ? s : null;
}

const STATUS_HISTORICO: readonly BaixaHistoricoStatus[] = ["sucesso", "erro", "pendente"];

function lista(raw: string | null, max: number): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))].slice(0, max);
}

function likeTermo(termo: string): string {
  return `%${termo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function parseBaixaHistoricoQuery(params: URLSearchParams): BaixaHistoricoQuery {
  const empresas = lista(params.get("empresa"), 20).filter((e) => e.length <= 50);
  const status = lista(params.get("status"), 3).filter((v): v is BaixaHistoricoStatus =>
    (STATUS_HISTORICO as readonly string[]).includes(v),
  );
  const page = Math.max(1, Math.trunc(Number(params.get("page")) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(Number(params.get("pageSize")) || 50)));
  return {
    empresa: empresas.length ? empresas : undefined,
    status: status.length ? status : undefined,
    de: isoDate(params.get("de")) ?? undefined,
    ate: isoDate(params.get("ate")) ?? undefined,
    q: str(params.get("q"), 100) ?? undefined,
    fornecedor: str(params.get("fornecedor"), 100) ?? undefined,
    documento: str(params.get("documento"), 100) ?? undefined,
    usuario: str(params.get("usuario"), 100) ?? undefined,
    page,
    pageSize,
  };
}

export function createReconciliationHistoryService(
  config: Config,
  pool: Pool | undefined,
): ReconciliationHistoryService {
  async function query<T = any>(sql: string, values: unknown[] = []): Promise<T[]> {
    if (!pool) throw new Error("Pool de banco não configurado");
    const conn = await pool.getConnection();
    try {
      return (await conn.query({ sql, timeout: config.timeoutMs }, values)) as T[];
    } finally {
      conn.release();
    }
  }

  function mapRow(r: any): BaixaHistoricoItem {
    const dateOnly = (v: unknown) => (v ? String(v).slice(0, 10) : null);
    return {
      id: Number(r.id),
      lote_id: String(r.lote_id),
      executado_em: String(r.executado_em),
      usuario_nome: r.usuario_nome ?? null,
      empresa: String(r.empresa),
      conta_pagar_id: Number(r.conta_pagar_id),
      numero_documento: r.numero_documento ?? null,
      fornecedor_nome: r.fornecedor_nome ?? null,
      data_vencimento: dateOnly(r.data_vencimento),
      data_pagamento: dateOnly(r.data_pagamento),
      valor_tiny: r.valor_tiny === null || r.valor_tiny === undefined ? null : Number(r.valor_tiny),
      valor_pago: Number(r.valor_pago),
      juros: Number(r.juros),
      multa: Number(r.multa),
      desconto: Number(r.desconto),
      inter_transacao_id: r.inter_transacao_id ?? null,
      metodo_match: r.metodo_match ?? null,
      status: r.status === "sucesso" || r.status === "pendente" ? r.status : "erro",
      mensagem: r.mensagem ?? null,
    };
  }

  // A API Python devolve um resultado por item, na mesma ordem; casa por conta+empresa
  // para não depender disso.
  function resultadoDe(resultados: BaixaResultItem[], item: BaixaRequestItem, idx: number): BaixaResultItem | undefined {
    return (
      resultados.find(
        (r) => num(r.conta_pagar_id) === num(item.conta_pagar_id) && str(r.empresa, 50) === str(item.empresa, 50),
      ) ?? resultados[idx]
    );
  }

  function baseRow(
    loteId: string,
    usuarioId: number | null,
    usuarioNome: string | null,
    item: BaixaRequestItem,
    status: "sucesso" | "erro" | "pendente",
    mensagem: string | null,
  ): unknown[] {
    return [
      loteId,
      usuarioId,
      str(usuarioNome, 255),
      str(item.empresa, 50) ?? "desconhecida",
      num(item.conta_pagar_id) ?? 0,
      str(item.numero_documento, 100),
      str(item.fornecedor_nome, 255),
      isoDate(item.data_vencimento),
      isoDate(item.data_pagamento),
      num(item.valor_tiny),
      num(item.valor_pago) ?? 0,
      num(item.juros) ?? 0,
      num(item.multa) ?? 0,
      num(item.desconto) ?? 0,
      str(item.inter_transacao_id, 255),
      str(item.metodo_match, 32),
      status,
      mensagem,
    ];
  }

  async function insertRows(rows: unknown[][]): Promise<void> {
    const conn = await pool!.getConnection();
    try {
      await conn.batch(
        {
          sql: `INSERT INTO conciliacao_baixas_historico
            (lote_id, executado_em, usuario_id, usuario_nome, empresa, conta_pagar_id, numero_documento,
             fornecedor_nome, data_vencimento, data_pagamento, valor_tiny, valor_pago, juros, multa, desconto,
             inter_transacao_id, metodo_match, status, mensagem)
            VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          // Sem `timeout`: o driver mariadb recusa batch() com ele ("Cannot use timeout for
          // Batch statement") e, com a opção, nenhuma baixa chegava a ser gravada.
        },
        rows,
      );
    } finally {
      conn.release();
    }
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS conciliacao_baixas_historico (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            lote_id CHAR(36) NOT NULL,
            executado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            usuario_id INT NULL,
            usuario_nome VARCHAR(255) NULL,
            empresa VARCHAR(50) NOT NULL,
            conta_pagar_id BIGINT NOT NULL,
            numero_documento VARCHAR(100) NULL,
            fornecedor_nome VARCHAR(255) NULL,
            data_vencimento DATE NULL,
            data_pagamento DATE NULL,
            valor_tiny DECIMAL(12, 2) NULL,
            valor_pago DECIMAL(12, 2) NOT NULL,
            juros DECIMAL(12, 2) NOT NULL DEFAULT 0,
            multa DECIMAL(12, 2) NOT NULL DEFAULT 0,
            desconto DECIMAL(12, 2) NOT NULL DEFAULT 0,
            inter_transacao_id VARCHAR(255) NULL,
            metodo_match VARCHAR(32) NULL,
            status VARCHAR(10) NOT NULL,
            mensagem TEXT NULL,
            INDEX idx_baixas_executado (executado_em),
            INDEX idx_baixas_empresa (empresa),
            INDEX idx_baixas_status (status),
            INDEX idx_baixas_conta (conta_pagar_id),
            INDEX idx_baixas_lote (lote_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err) {
        console.warn("[ReconciliationHistory] Falha ao criar tabela conciliacao_baixas_historico:", err);
      }
    },

    async recordBatch({ usuarioId, usuarioNome, itens, resultados }) {
      if (!pool || itens.length === 0) return;
      const loteId = randomUUID();
      const rows = itens.map((item, idx) => {
        const res = resultadoDe(resultados, item, idx);
        return baseRow(
          loteId,
          usuarioId,
          usuarioNome,
          efetivo(item, res),
          res?.status === "sucesso" ? "sucesso" : "erro",
          res ? str(res.mensagem, 4000) : "Sem resultado da API de conciliação para esta conta.",
        );
      });
      try {
        await insertRows(rows);
      } catch (err) {
        console.error("[ReconciliationHistory] Falha ao gravar histórico de baixas:", err);
      }
    },

    async recordPending({ loteId, usuarioId, usuarioNome, itens }) {
      if (!pool || itens.length === 0) return false;
      const rows = itens.map((item) =>
        baseRow(loteId, usuarioId, usuarioNome, item, "pendente", "Baixa em andamento no Tiny."),
      );
      try {
        await insertRows(rows);
        return true;
      } catch (err) {
        console.error("[ReconciliationHistory] Falha ao gravar baixa pendente:", err);
        return false;
      }
    },

    async completeBatch({ loteId, resultados, erroGeral }) {
      if (!pool) return;
      try {
        const pendentes = await query<{ id: number | bigint; empresa: string; conta_pagar_id: number | bigint }>(
          `SELECT id, empresa, conta_pagar_id FROM conciliacao_baixas_historico WHERE lote_id = ? AND status = 'pendente'`,
          [loteId],
        );
        for (const row of pendentes) {
          const res = resultados.find(
            (r) => num(r.conta_pagar_id) === Number(row.conta_pagar_id) && str(r.empresa, 50) === row.empresa,
          );
          const status = res?.status === "sucesso" ? "sucesso" : "erro";
          const mensagem = res
            ? str(res.mensagem, 4000)
            : `Situação desconhecida, confira no Tiny: ${erroGeral ?? "sem resultado da API de conciliação para esta conta"}`;
          if (res && num(res.valor_pago) !== null) {
            // Grava os valores que a automação de fato usou na baixa (extrato da prévia).
            await query(
              `UPDATE conciliacao_baixas_historico
                  SET status = ?, mensagem = ?, valor_pago = ?, data_pagamento = COALESCE(?, data_pagamento),
                      juros = ?, multa = ?, desconto = ?, inter_transacao_id = COALESCE(?, inter_transacao_id)
                WHERE id = ?`,
              [
                status,
                mensagem,
                num(res.valor_pago),
                isoDate(res.data_pagamento),
                num(res.juros) ?? 0,
                num(res.multa) ?? 0,
                num(res.desconto) ?? 0,
                str(res.inter_transacao_id, 255),
                row.id,
              ],
            );
          } else {
            await query(`UPDATE conciliacao_baixas_historico SET status = ?, mensagem = ? WHERE id = ?`, [
              status,
              mensagem,
              row.id,
            ]);
          }
        }
      } catch (err) {
        console.error(`[ReconciliationHistory] Falha ao fechar lote de baixa ${loteId}:`, err);
      }
    },

    async pendingLotes() {
      if (!pool) return [];
      try {
        const rows = await query<{ lote_id: string }>(
          `SELECT DISTINCT lote_id FROM conciliacao_baixas_historico WHERE status = 'pendente'`,
        );
        return rows.map((r) => String(r.lote_id));
      } catch (err) {
        console.warn("[ReconciliationHistory] Falha ao listar baixas pendentes:", err);
        return [];
      }
    },

    async list(q) {
      if (!pool) return { disponivel: false, itens: [], total: 0, page: q.page, pageSize: q.pageSize };
      const where: string[] = [];
      const values: unknown[] = [];
      if (q.empresa?.length) {
        where.push(`empresa IN (${q.empresa.map(() => "?").join(", ")})`);
        values.push(...q.empresa);
      }
      if (q.status?.length) {
        where.push(`status IN (${q.status.map(() => "?").join(", ")})`);
        values.push(...q.status);
      }
      // executado_em é gravado em UTC; os filtros de data do usuário são dias de São Paulo (UTC-3).
      if (q.de) {
        where.push("executado_em >= DATE_ADD(?, INTERVAL 3 HOUR)");
        values.push(q.de);
      }
      if (q.ate) {
        where.push("executado_em < DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL 3 HOUR)");
        values.push(q.ate);
      }
      if (q.q) {
        where.push(
          "(fornecedor_nome LIKE ? OR numero_documento LIKE ? OR usuario_nome LIKE ? OR CAST(conta_pagar_id AS CHAR) = ? OR inter_transacao_id = ?)",
        );
        const like = likeTermo(q.q);
        values.push(like, like, like, q.q, q.q);
      }
      if (q.fornecedor) {
        where.push("fornecedor_nome LIKE ?");
        values.push(likeTermo(q.fornecedor));
      }
      if (q.documento) {
        where.push("(numero_documento LIKE ? OR CAST(conta_pagar_id AS CHAR) = ? OR inter_transacao_id = ?)");
        values.push(likeTermo(q.documento), q.documento, q.documento);
      }
      if (q.usuario) {
        where.push("usuario_nome LIKE ?");
        values.push(likeTermo(q.usuario));
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [count] = await query<{ total: number | bigint }>(
        `SELECT COUNT(*) AS total FROM conciliacao_baixas_historico ${whereSql}`,
        values,
      );
      const rows = await query(
        `SELECT * FROM conciliacao_baixas_historico ${whereSql} ORDER BY executado_em DESC, id DESC LIMIT ? OFFSET ?`,
        [...values, q.pageSize, (q.page - 1) * q.pageSize],
      );
      return {
        disponivel: true,
        itens: rows.map(mapRow),
        total: Number(count?.total ?? 0),
        page: q.page,
        pageSize: q.pageSize,
      };
    },

    async snapshot() {
      if (!pool) throw new Error("Pool de banco não configurado");
      const [counts] = await query<{ total: number | bigint; sucessos: number | bigint | string | null }>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'sucesso'), 0) AS sucessos FROM conciliacao_baixas_historico`,
      );
      const falhas = await query(
        `SELECT * FROM conciliacao_baixas_historico WHERE status = 'erro' ORDER BY executado_em DESC, id DESC LIMIT 20`,
      );
      const total = String(counts?.total ?? 0);
      const sucessos = String(counts?.sucessos ?? 0);
      const base = metricsFromCounts(total, sucessos, sucessos);
      const hoursSaved = (base.paidCount * MINUTOS_POR_BAIXA) / 60;
      return {
        metrics: { ...base, hoursSaved, estimatedSavings: hoursSaved * 11 },
        approvals: [],
        failures: falhas.map((r): Account => {
          const item = mapRow(r);
          const executadoEm = utcDatetimeToIso(item.executado_em);
          return {
            id: String(item.id),
            beneficiary: item.fornecedor_nome ?? `Conta #${item.conta_pagar_id}`,
            cnpj: "",
            amount: item.valor_pago.toFixed(2),
            dueDate: item.data_vencimento ?? item.data_pagamento ?? (executadoEm ?? new Date().toISOString()).slice(0, 10),
            status: "FALHA_BAIXA",
            transactionId: item.inter_transacao_id,
            errorLog: item.mensagem,
            stoppedNode: "Baixa no Tiny",
            updatedAt: executadoEm,
          };
        }),
      };
    },

    async readHistory(window) {
      if (!pool) return { complete: true, executions: [] };
      const lotes = await query<{ lote_id: string; inicio: string; fim: string; total: number | bigint; sucessos: number | bigint | string }>(
        `SELECT lote_id, MIN(executado_em) AS inicio, MAX(executado_em) AS fim, COUNT(*) AS total,
                COALESCE(SUM(status = 'sucesso'), 0) AS sucessos
           FROM conciliacao_baixas_historico
          WHERE executado_em >= ? AND executado_em <= ?
          GROUP BY lote_id
          ORDER BY inicio DESC`,
        [isoToUtcDatetime(window.from), isoToUtcDatetime(window.to)],
      );
      return {
        complete: true,
        executions: lotes.map((l): Execution => {
          const inicio = utcDatetimeToIso(l.inicio);
          const fim = utcDatetimeToIso(l.fim);
          // Lote com qualquer conta não baixada conta como erro: exige atenção no histórico.
          const ok = Number(l.sucessos) === Number(l.total);
          return {
            id: String(l.lote_id),
            startedAt: inicio,
            stoppedAt: fim,
            durationMs: inicio && fim ? Date.parse(fim) - Date.parse(inicio) : null,
            status: ok ? "success" : "error",
            stoppedNode: ok ? null : "Baixa no Tiny",
          };
        }),
      };
    },

    async resumo() {
      if (!pool) return null;
      try {
        const [row] = await query<{ contas: number | bigint; valor: string | number | null }>(
          `SELECT COUNT(*) AS contas, COALESCE(SUM(valor_pago), 0) AS valor
             FROM conciliacao_baixas_historico WHERE status = 'sucesso'`,
        );
        return { contasBaixadas: Number(row?.contas ?? 0), valorBaixado: Number(row?.valor ?? 0) };
      } catch (err) {
        console.warn("[ReconciliationHistory] Falha ao ler resumo de baixas:", err);
        return null;
      }
    },
  };
}
