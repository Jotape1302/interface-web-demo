import assert from "node:assert/strict";
import test from "node:test";
import { createSaoPauloDate, toSaoPauloISODate, getPresetRange } from "./date-range-utils";

test("toSaoPauloISODate não desloca o dia pro mês seguinte no fim do dia em São Paulo", () => {
  // Bug real de 2026-09-22: filtro "01/08 a 31/08" usava d.toISOString().slice(0, 10)
  // pra extrair a data — 31/08 23:59:59.999 -03:00 é 01/09 02:59:59.999Z em UTC, então
  // o date_to mandado pra API virava "2026-09-01", somando setembro junto nos KPIs.
  const fimDoMes = createSaoPauloDate(2026, 8, 31, 23, 59, 59, 999);
  assert.equal(toSaoPauloISODate(fimDoMes), "2026-08-31");
});

test("toSaoPauloISODate também não desloca o dia no início do dia", () => {
  const inicioDoMes = createSaoPauloDate(2026, 8, 1, 0, 0, 0, 0);
  assert.equal(toSaoPauloISODate(inicioDoMes), "2026-08-01");
});

test("toSaoPauloISODate cobre virada de ano (31/12 23:59:59 -03:00)", () => {
  const reveillon = createSaoPauloDate(2026, 12, 31, 23, 59, 59, 999);
  assert.equal(toSaoPauloISODate(reveillon), "2026-12-31");
});

test("getPresetRange('thisMonth') produz from/to que caem no mesmo mês uma vez formatados", () => {
  const preset = getPresetRange("thisMonth");
  assert.ok(preset.from && preset.to);
  const fromIso = toSaoPauloISODate(preset.from as Date);
  const toIso = toSaoPauloISODate(preset.to as Date);
  assert.equal(fromIso.slice(0, 7), toIso.slice(0, 7), "from e to devem ser do mesmo mês");
});
