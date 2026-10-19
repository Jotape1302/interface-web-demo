import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { FinancialDashboardNotSyncedError, type FinancialDashboardService } from "../src/financial-dashboard.js";

const config = readConfig({});
const demo = createDemo();
const dashboardService = createDashboardService("demo", demo.database, demo.n8n);

async function startServer(financialDashboard: FinancialDashboardService, t: any) {
  const server = createApi(config, { dashboard: dashboardService, financialDashboard });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("Dashboard Financeiro ainda não sincronizado repassa 404, não 500", async (t) => {
  const base = await startServer(
    {
      async readStatus() {
        return {
          last_sync_started_at: null,
          last_sync_finished_at: null,
          next_sync_at: new Date().toISOString(),
          companies: [],
          is_running: false,
          cooldown_seconds_remaining: 0,
        };
      },
      async sync() {
        throw new Error("não usado neste teste");
      },
      async readDashboard() {
        throw new FinancialDashboardNotSyncedError("Dashboard Financeiro ainda não foi sincronizado.");
      },
    },
    t,
  );

  const res = await fetch(`${base}/api/financial-dashboard?date_from=2026-09-01&date_to=2026-09-21`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /ainda não foi sincronizado/);
});

test("outras falhas do motor Python continuam retornando 500", async (t) => {
  const base = await startServer(
    {
      async readStatus() {
        throw new Error("indisponível");
      },
      async sync() {
        throw new Error("indisponível");
      },
      async readDashboard() {
        throw new Error("Falha ao consultar o Dashboard Financeiro (503)");
      },
    },
    t,
  );

  const res = await fetch(`${base}/api/financial-dashboard?date_from=2026-09-01&date_to=2026-09-21`);
  assert.equal(res.status, 500);
});

test("date_from/date_to ausentes retornam 422 sem chamar o serviço", async (t) => {
  let called = false;
  const base = await startServer(
    {
      async readStatus() {
        return {
          last_sync_started_at: null,
          last_sync_finished_at: null,
          next_sync_at: new Date().toISOString(),
          companies: [],
          is_running: false,
          cooldown_seconds_remaining: 0,
        };
      },
      async sync() {
        throw new Error("não usado");
      },
      async readDashboard() {
        called = true;
        throw new Error("não deveria ser chamado");
      },
    },
    t,
  );

  const res = await fetch(`${base}/api/financial-dashboard`);
  assert.equal(res.status, 422);
  assert.equal(called, false);
});

test("dashboard sincronizado retorna 200 com o payload do motor Python", async (t) => {
  const base = await startServer(
    {
      async readStatus() {
        return {
          last_sync_started_at: "2026-09-21T04:00:00",
          last_sync_finished_at: "2026-09-21T04:02:00",
          next_sync_at: "2026-09-22T04:00:00",
          companies: [],
          is_running: false,
          cooldown_seconds_remaining: 0,
        };
      },
      async sync() {
        throw new Error("não usado");
      },
      async readDashboard(dateFrom, dateTo) {
        return { period: { from: dateFrom, to: dateTo, previous_from: "", previous_to: "" } } as any;
      },
    },
    t,
  );

  const res = await fetch(`${base}/api/financial-dashboard?date_from=2026-09-01&date_to=2026-09-21`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.period.from, "2026-09-01");
});
