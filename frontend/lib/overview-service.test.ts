import assert from "node:assert/strict";
import test from "node:test";
import { parseOverview, makeDemoOverview } from "./overview-service";
import { makeDemoDashboard } from "./demo";

void test("makeDemoOverview generates valid demo overview with 4 services", () => {
  const overview = makeDemoOverview();
  const parsed = parseOverview(overview);
  assert.equal(parsed.mode, "demo");
  assert.equal(parsed.services.length, 4);
  assert.deepEqual(
    parsed.services.map((s) => s.id),
    ["mariadb", "n8n", "tiny", "inter"],
  );
  assert.equal(parsed.history.days, 14);
});

void test("parseOverview accepts valid live overview with 4 services and valid automation dashboards", () => {
  const timestamp = "2026-09-10T14:30:00Z";
  const liveOverview = {
    mode: "live" as const,
    generatedAt: timestamp,
    automations: [
      {
        id: "accounts-payable",
        title: "Contas a Pagar",
        href: "/contas-a-pagar",
        dashboard: { ...makeDemoDashboard(timestamp), mode: "live" as const },
      },
      {
        id: "danfe-tiny",
        title: "NF-e & DANFE",
        href: "/danfe-tiny",
        dashboard: { ...makeDemoDashboard(timestamp), mode: "live" as const },
      },
    ],
    history: {
      days: 14 as const,
      from: "2026-08-27T14:30:00Z",
      to: timestamp,
      complete: true,
      executions: [],
      error: null,
    },
    services: [
      { id: "mariadb", name: "MariaDB", status: "connected" as const, message: "OK" },
      { id: "n8n", name: "n8n", status: "connected" as const, message: "OK" },
      { id: "tiny", name: "Tiny ERP", status: "unverified" as const, message: "OK" },
      { id: "inter", name: "Banco Inter", status: "unverified" as const, message: "OK" },
    ],
  };

  const parsed = parseOverview(liveOverview);
  assert.equal(parsed.mode, "live");
  assert.equal(parsed.automations.length, 2);
  assert.equal(parsed.services.length, 4);
});

void test("parseOverview rejects payloads with 5 services or invalid service ids", () => {
  const timestamp = "2026-09-10T14:30:00Z";
  const invalidOverview = {
    mode: "live" as const,
    generatedAt: timestamp,
    automations: [
      {
        id: "accounts-payable",
        title: "Contas a Pagar",
        href: "/contas-a-pagar",
        dashboard: { ...makeDemoDashboard(timestamp), mode: "live" as const },
      },
    ],
    history: {
      days: 14 as const,
      from: "2026-08-27T14:30:00Z",
      to: timestamp,
      complete: true,
      executions: [],
      error: null,
    },
    services: [
      { id: "mariadb", name: "MariaDB", status: "connected" as const, message: "OK" },
      { id: "n8n", name: "n8n", status: "connected" as const, message: "OK" },
      { id: "tiny", name: "Tiny ERP", status: "unverified" as const, message: "OK" },
      { id: "inter", name: "Banco Inter", status: "unverified" as const, message: "OK" },
      { id: "receita", name: "Receita", status: "unverified" as const, message: "OK" },
    ],
  };

  assert.throws(() => parseOverview(invalidOverview), /incompatíveis com a visão geral/);
});

void test("aggregateOverview soma métricas sem horas/R$ sem virar NaN", async () => {
  const { aggregateOverview } = await import("./overview-metrics");
  const overview = makeDemoOverview();
  for (const a of overview.automations) {
    const { hoursSaved: _h, estimatedSavings: _e, ...rest } = a.dashboard.metrics!;
    a.dashboard.metrics = rest;
  }
  const parsed = parseOverview(overview);
  const agg = aggregateOverview(parsed);
  assert.equal(agg.financial?.hoursSaved, 0);
  assert.equal(agg.financial?.estimatedSavings, 0);
  assert.ok((agg.financial?.paidCount ?? 0) > 0);
});
