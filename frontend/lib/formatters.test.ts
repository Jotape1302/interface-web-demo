import assert from "node:assert/strict";
import test from "node:test";
import { count, dateOnly, dateTime, duration, formatTimeSaved, hours, money, percentage } from "./formatters";

test("Brazilian quantitative presentation and null denominator are explicit", () => {
  assert.equal(count(1184), "1.184");
  assert.equal(hours(91), "91 h");
  assert.equal(formatTimeSaved(0), "0 min");
  assert.equal(formatTimeSaved(null), "0 min");
  assert.equal(formatTimeSaved(0.05), "3 min");
  assert.equal(formatTimeSaved(0.15), "9 min");
  assert.equal(formatTimeSaved(0.5), "30 min");
  assert.equal(formatTimeSaved(0.8), "48 min");
  assert.equal(formatTimeSaved(1), "1h");
  assert.equal(formatTimeSaved(1.5), "1h 30min");
  assert.equal(formatTimeSaved(91), "91h");
  assert.equal(money(1001).replace(/\s/g, " "), "R$ 1.001,00");
  assert.equal(money(55 / 60).replace(/\s/g, " "), "R$ 0,92");
  assert.equal(percentage(92.5), "92,5%");
  assert.equal(percentage(null), "Sem base");
  assert.equal(percentage(0), "0%");
});

test("calendar due dates never move into previous day and telemetry uses Brasilia", () => {
  assert.equal(dateOnly("2026-09-08"), "08/09/2026");
  assert.match(dateTime("2026-09-08T01:00:00Z"), /07\/09\/2026/);
  assert.match(dateTime("2026-09-08T01:00:00Z"), /22:00:00/);
  assert.equal(dateTime(null), "Não informado");
});

test("missing duration is distinct from zero and supports long executions", () => {
  assert.equal(duration(null), "—");
  assert.equal(duration(0), "0 s");
  assert.equal(duration(24000), "24 s");
  assert.equal(duration(124000), "2 min 4 s");
  assert.equal(duration(7320000), "2 h 2 min");
});

test("decimal amounts retain precision independently of JavaScript number limits", () => {
  assert.equal(money("9007199254740993.99").replace(/\s/g, " "), "R$ 9.007.199.254.740.993,99");
  assert.equal(money("-10.125").replace(/\s/g, " "), "-R$ 10,13");
  assert.equal(money("99.995").replace(/\s/g, " "), "R$ 100,00");
});
