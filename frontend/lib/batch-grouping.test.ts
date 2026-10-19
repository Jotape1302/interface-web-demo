import assert from "node:assert/strict";
import test from "node:test";
import { groupExecutions, groupDanfeHistory } from "./batch-grouping";
import { getPresetRange, isDateWithinFilter, formatDateRangeLabel } from "./date-range-utils";
import type { Execution } from "./contracts";

test("deve agrupar execuções disparadas na mesma janela de 5 minutos no mesmo lote", () => {
  const items: Execution[] = [
    { id: "1", startedAt: "2026-09-14T10:00:00Z", stoppedAt: "2026-09-14T10:01:00Z", durationMs: 60000, status: "success", stoppedNode: null },
    { id: "2", startedAt: "2026-09-14T10:02:00Z", stoppedAt: "2026-09-14T10:03:00Z", durationMs: 60000, status: "success", stoppedNode: null },
    { id: "3", startedAt: "2026-09-14T10:04:00Z", stoppedAt: "2026-09-14T10:05:00Z", durationMs: 60000, status: "error", stoppedNode: "HTTP Request" },
    // Este item ocorreu 25 minutos depois (novo lote)
    { id: "4", startedAt: "2026-09-14T10:25:00Z", stoppedAt: "2026-09-14T10:26:00Z", durationMs: 60000, status: "success", stoppedNode: null },
  ];

  const batches = groupExecutions(items, { windowMinutes: 5 });
  assert.equal(batches.length, 2, "Devem ser criados 2 lotes distintos");

  const [loteMaisRecente, loteAnterior] = batches;
  assert.equal(loteMaisRecente.items.length, 1);
  assert.equal(loteMaisRecente.summary.successRate, 100);

  assert.equal(loteAnterior.items.length, 3);
  assert.equal(loteAnterior.summary.successCount, 2);
  assert.equal(loteAnterior.summary.errorCount, 1);
  assert.match(loteAnterior.summary.successRateFormatted, /66[,.]67%|66[,.]7%/);
});

test("presets de período respeitam o fuso America/Sao_Paulo estritamente", () => {
  const hoje = getPresetRange("today");
  assert.ok(hoje.from !== null && hoje.to !== null);
  assert.equal(hoje.key, "today");

  const agoraIso = new Date().toISOString();
  assert.equal(isDateWithinFilter(agoraIso, hoje), true);

  const ano = getPresetRange("thisYear");
  assert.equal(ano.key, "thisYear");
  assert.equal(isDateWithinFilter("2026-06-15T12:00:00Z", ano), true);
  assert.equal(isDateWithinFilter("2025-06-15T12:00:00Z", ano), false);

  assert.equal(formatDateRangeLabel(hoje), "Hoje");
  assert.equal(formatDateRangeLabel({ key: "all", from: null, to: null }), "Todo o Período");
});

test("agrupamento de DANFEs calcula valor financeiro e taxa de sucesso corretamente", () => {
  const danfes = [
    { processed_at: "2026-09-10T14:10:00Z", audit_status: "success", valor_total: 216.24 },
    { processed_at: "2026-09-10T14:12:00Z", audit_status: "success", valor_total: 43.15 },
    { processed_at: "2026-09-10T14:14:00Z", audit_status: "error", valor_total: 100.00 },
  ];

  const batches = groupDanfeHistory(danfes, { windowMinutes: 10 });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].summary.totalCount, 3);
  assert.equal(batches[0].summary.successCount, 2);
  assert.equal(batches[0].summary.errorCount, 1);
  assert.equal(batches[0].summary.totalAmount, 359.39);
});
