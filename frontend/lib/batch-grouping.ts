import { parseUtcDate, formatTimeBR, formatDateBR, decimal } from "./formatters";
import type {
  BatchExecutionGroup,
  BatchExecutionSummary,
  BatchGroupingOptions,
  Execution,
} from "./contracts";

export function groupItemsIntoBatches<T>(
  items: T[],
  extractors: {
    getTimestamp: (item: T) => string | number | Date | null | undefined;
    getStatus: (item: T) => "success" | "error" | "running" | "waiting" | "unknown";
    getDurationMs?: (item: T) => number | null | undefined;
    getAmount?: (item: T) => number | undefined;
  },
  options: BatchGroupingOptions = {}
): BatchExecutionGroup<T>[] {
  const { windowMinutes = 5, groupByDate = true, sortOrder = "desc" } = options;
  const windowMs = windowMinutes * 60 * 1000;

  // 1. Filtra itens com timestamps válidos e ordena
  const validItemsWithTime = items
    .map((item) => {
      const date = parseUtcDate(extractors.getTimestamp(item));
      return { item, date, time: date ? date.getTime() : 0 };
    })
    .filter((x): x is { item: T; date: Date; time: number } => x.date !== null)
    .sort((a, b) => (sortOrder === "desc" ? b.time - a.time : a.time - b.time));

  if (validItemsWithTime.length === 0) return [];

  const batches: Array<{
    items: T[];
    dates: Date[];
    dateKey: string;
  }> = [];

  let currentBatch: { items: T[]; dates: Date[]; dateKey: string } | null = null;
  let lastTime = 0;

  for (const { item, date, time } of validItemsWithTime) {
    const dateKey = formatDateBR(date);

    if (!currentBatch) {
      currentBatch = { items: [item], dates: [date], dateKey };
      lastTime = time;
      continue;
    }

    const delta = Math.abs(lastTime - time);
    const sameDate = !groupByDate || currentBatch.dateKey === dateKey;

    if (delta <= windowMs && sameDate) {
      // Pertence ao mesmo lote operacional
      currentBatch.items.push(item);
      currentBatch.dates.push(date);
      lastTime = time;
    } else {
      // Fecha lote anterior e inicia novo
      batches.push(currentBatch);
      currentBatch = { items: [item], dates: [date], dateKey };
      lastTime = time;
    }
  }

  if (currentBatch) {
    batches.push(currentBatch);
  }

  // 2. Mapeia e calcula métricas agregadas por lote
  return batches.map((batch, index) => {
    const times = batch.dates.map((d) => d.getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    const startedDate = new Date(minTime);
    const stoppedDate = new Date(maxTime);

    let successCount = 0;
    let errorCount = 0;
    let runningCount = 0;
    let waitingCount = 0;
    let sumDurations = 0;
    let totalAmount = 0;

    for (const item of batch.items) {
      const status = extractors.getStatus(item);
      if (status === "success") successCount++;
      else if (status === "error") errorCount++;
      else if (status === "running") runningCount++;
      else if (status === "waiting") waitingCount++;

      if (extractors.getDurationMs) {
        const d = extractors.getDurationMs(item);
        if (typeof d === "number") sumDurations += d;
      }
      if (extractors.getAmount) {
        const a = extractors.getAmount(item);
        if (typeof a === "number" && !isNaN(a)) totalAmount += a;
      }
    }

    const totalCount = batch.items.length;
    const successRate = totalCount > 0 ? (successCount / totalCount) * 100 : 0;

    // Duração: intervalo entre o início do primeiro e o fim do último (ou soma das durações)
    const spanDurationMs = maxTime - minTime;
    const durationMs = sumDurations > 0 ? sumDurations : spanDurationMs;

    const timeStartStr = formatTimeBR(startedDate);
    const timeEndStr = formatTimeBR(stoppedDate);
    const timeRangeLabel =
      timeStartStr === timeEndStr ? timeStartStr : `${timeStartStr} → ${timeEndStr}`;

    const summary: BatchExecutionSummary = {
      totalCount,
      successCount,
      errorCount,
      runningCount,
      waitingCount,
      successRate,
      successRateFormatted: `${decimal.format(successRate)}%`,
      startedAt: startedDate.toISOString(),
      stoppedAt: stoppedDate.toISOString(),
      durationMs,
      totalAmount: totalAmount > 0 ? totalAmount : undefined,
    };

    return {
      id: `batch-${batch.dateKey.replace(/\//g, "")}-${minTime}`,
      batchNumber: batches.length - index,
      dateKey: batch.dateKey,
      dateLabel: batch.dateKey,
      timeRangeLabel,
      summary,
      items: batch.items,
    };
  });
}

/**
 * Wrapper tipado para histórico do n8n / Contas a Pagar
 */
export function groupExecutions(
  executions: Execution[],
  options?: BatchGroupingOptions
): BatchExecutionGroup<Execution>[] {
  return groupItemsIntoBatches(
    executions,
    {
      getTimestamp: (e) => e.startedAt,
      getStatus: (e) => e.status,
      getDurationMs: (e) => e.durationMs,
    },
    options
  );
}

/**
 * Wrapper tipado para histórico de notas fiscais NF-e / DANFE
 */
export function groupDanfeHistory<
  T extends {
    processed_at: string;
    audit_status?: string;
    valor_total?: number;
  },
>(
  items: T[],
  options?: BatchGroupingOptions
): BatchExecutionGroup<T>[] {
  return groupItemsIntoBatches(
    items,
    {
      getTimestamp: (h) => h.processed_at,
      getStatus: (h) => (h.audit_status === "error" ? "error" : "success"),
      getAmount: (h) => h.valor_total,
    },
    { windowMinutes: 10, ...options }
  );
}
