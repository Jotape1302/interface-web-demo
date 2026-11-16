import mariadb, { type Pool } from "mariadb";
import type { Config } from "./config.js";
import type { Metrics } from "./contracts.js";
import { economia } from "./roi.js";

/**
 * Linha crua devolvida pelo driver mariadb num SELECT. Os `mapRow` de cada serviço convertem
 * campo a campo para o tipo de domínio; `unknown` obriga essa conversão a ser explícita.
 */
export type DbRow = Record<string, unknown>;

/** Resultado de INSERT/UPDATE/DELETE no driver mariadb (OkPacket). */
export interface DbWriteResult {
  affectedRows: number;
  insertId: number | bigint;
  warningStatus: number;
}

/** Em INSERT/UPDATE/DELETE o driver devolve o OkPacket no lugar do array de linhas. */
export function asWriteResult(result: unknown): DbWriteResult {
  return result as DbWriteResult;
}

export function metricsFromCounts(total: unknown, paid: unknown, reconciled: unknown): Metrics {
  function count(v: unknown): number {
    if (!["bigint", "number", "string"].includes(typeof v) || !/^\d+$/.test(String(v)))
      throw new Error("Contagem inválida");
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Contagem fora do intervalo seguro");
    return n;
  }
  const totalQueue = count(total),
    paidCount = count(paid),
    reconciledCount = count(reconciled);
  if (paidCount > totalQueue || reconciledCount > totalQueue)
    throw new Error("Contagens inconsistentes");
  const { horas: hoursSaved, reais } = economia("accounts-payable", paidCount);
  return {
    totalQueue,
    paidCount,
    reconciledCount,
    hoursSaved,
    estimatedSavings: reais,
    automationRate: totalQueue ? (reconciledCount / totalQueue) * 100 : null,
  };
}
export function createDbPool(
  config: Config,
  createPool: typeof mariadb.createPool = mariadb.createPool,
): Pool {
  return createPool({
    ...config.database,
    ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,
    connectionLimit: 4,
    acquireTimeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
    dateStrings: true,
    decimalAsNumber: false,
    bigIntAsNumber: false,
  });
}
