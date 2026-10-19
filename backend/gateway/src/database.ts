import mariadb, { type Pool } from "mariadb";
import type { Config } from "./config.js";
import type { Metrics } from "./contracts.js";
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
  const hoursSaved = (paidCount * 5) / 60;
  return {
    totalQueue,
    paidCount,
    reconciledCount,
    hoursSaved,
    estimatedSavings: hoursSaved * 11,
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
