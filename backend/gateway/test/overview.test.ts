import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createOverviewService, createDemoHistory, historyWindow } from "../src/overview.js";
import { createN8nHistory } from "../src/n8n.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { createAuthService } from "../src/auth.js";
const config = readConfig({});
const now = new Date("2026-09-08T02:00:00Z");
const window = historyWindow(now);
const demo = createDemo();
const dashboard = createDashboardService("demo", demo.database, demo.n8n);
const provider = {
  id: "accounts-payable",
  title: "Contas a Pagar",
  href: "/contas-a-pagar",
  dashboard,
  history: createDemoHistory(),
};
test("janela usa 14 dias calendário São Paulo e demo corresponde aos metadados", async () => {
  assert.equal(window.from, "2026-08-25T03:00:00.000Z");
  const overview = await createOverviewService("demo", [provider], () => now).read();
  assert.equal(overview.history.complete, true);
  assert.ok(overview.history.executions.length > 50);
  assert.ok(
    overview.history.executions.every(
      (e) => e.startedAt! >= window.from && e.startedAt! <= window.to,
    ),
  );
  assert.ok(overview.services.every((s) => s.status === "demo"));
});
test("histórico pagina, deduplica e filtra sem pressupor ordem de início", async () => {
  let calls = 0;
  const request = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    calls++;
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("includeData"), "false");
    const execution = { id: "1", status: "success", startedAt: "2026-09-01T12:00:00Z" };
    if (calls === 1)
      return Response.json({
        data: [execution, { ...execution, id: "old", startedAt: "2025-01-01T00:00:00Z" }],
        nextCursor: "cursor-2",
      });
    assert.equal(url.searchParams.get("cursor"), "cursor-2");
    return Response.json({ data: [execution, { ...execution, id: "2" }], nextCursor: null });
  }) as typeof fetch;
  const history = await createN8nHistory(
    { ...config, n8n: { baseUrl: "https://n8n.test", workflowId: "1", apiKey: "test" } },
    request,
  ).readHistory(window);
  assert.equal(calls, 2);
  assert.equal(history.complete, true);
  assert.equal(history.executions.length, 2);
});
test("limites, cursor repetido e datas ausentes marcam histórico parcial", async () => {
  const cfg = { ...config, n8n: { baseUrl: "https://n8n.test", workflowId: "1", apiKey: "test" } };
  const request = (async () =>
    Response.json({ data: [{ id: "1", status: "success" }], nextCursor: "again" })) as typeof fetch;
  assert.equal((await createN8nHistory(cfg, request, 1).readHistory(window)).complete, false);
  assert.equal((await createN8nHistory(cfg, request, 20).readHistory(window)).complete, false);
  await assert.rejects(
    createN8nHistory(cfg, (async () =>
      Response.json({ data: [], nextCursor: 3 })) as typeof fetch).readHistory(window),
  );
});
test("histórico n8n consolida execuções através de múltiplos workflows", async () => {
  const cfg = {
    ...config,
    n8n: {
      baseUrl: "https://n8n.test",
      workflowId: "wf-a",
      workflowIds: ["wf-a", "wf-b"],
      apiKey: "test",
    },
  };
  const request = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const wf = url.searchParams.get("workflowId");
    return Response.json({
      data: [
        {
          id: `hist-${wf}`,
          status: "success",
          workflowId: wf,
          startedAt: "2026-09-01T12:00:00Z",
        },
      ],
      nextCursor: null,
    });
  }) as typeof fetch;

  const history = await createN8nHistory(cfg, request).readHistory(window);
  assert.equal(history.complete, true);
  assert.equal(history.executions.length, 2);
  assert.deepEqual(
    history.executions.map((e) => e.id).sort(),
    ["hist-wf-a", "hist-wf-b"],
  );
});
test("erro de histórico não perde financeiro e serviços externos permanecem não verificados", async () => {
  const liveDashboard = createDashboardService("live", demo.database, demo.n8n);
  const value = await createOverviewService(
    "live",
    [
      {
        ...provider,
        dashboard: liveDashboard,
        history: {
          async readHistory() {
            throw new Error("secret");
          },
        },
      },
    ],
    () => now,
  ).read();
  assert.equal(value.automations[0]?.dashboard.metrics?.paidCount, 1092);
  assert.equal(value.history.complete, false);
  assert.equal(value.history.executions.length, 0);
  assert.ok(value.history.error);
  assert.ok(!JSON.stringify(value).includes("secret"));
  assert.equal(value.services.find((s) => s.id === "mariadb")?.status, "connected");
  assert.equal(value.services.find((s) => s.id === "n8n")?.status, "error");
  assert.equal(value.services.find((s) => s.id === "tiny")?.status, "unverified");
  assert.equal(value.services.find((s) => s.id === "inter")?.status, "unverified");
});
test("novo endpoint mantém endpoint original disponível e no-store", async (t) => {
  const overview = createOverviewService("demo", [provider], () => now);
  const server = createApi(config, { dashboard, overview });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/overview`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).automations[0].href, "/contas-a-pagar");
  assert.equal((await fetch(`${base}/api/accounts-payable/dashboard`)).status, 200);
});
test("serviços externos reportam connected quando healthCheckers indicam sucesso", async () => {
  const liveDashboard = createDashboardService("live", demo.database, demo.n8n);
  const overview = await createOverviewService(
    "live",
    [{ ...provider, dashboard: liveDashboard }],
    () => now,
    {
      checkTiny: async () => ({ connected: true, message: "API v3 e integração fiscal operacional." }),
      checkInter: async () => ({ connected: true, message: "Módulo DDA e conciliação bancária operacional." }),
    },
  ).read();

  const tiny = overview.services.find((s) => s.id === "tiny");
  const inter = overview.services.find((s) => s.id === "inter");
  assert.equal(tiny?.status, "connected");
  assert.equal(tiny?.message, "API v3 e integração fiscal operacional.");
  assert.equal(inter?.status, "connected");
  assert.equal(inter?.message, "Módulo DDA e conciliação bancária operacional.");
});
test("serviços externos reportam error quando healthCheckers indicam falha ou lançam exceção", async () => {
  const liveDashboard = createDashboardService("live", demo.database, demo.n8n);
  const overview = await createOverviewService(
    "live",
    [{ ...provider, dashboard: liveDashboard }],
    () => now,
    {
      checkTiny: async () => ({ connected: false, message: "Falha de autenticação OAuth2 Tiny." }),
      checkInter: async () => {
        throw new Error("Timeout ao consultar DDA Inter");
      },
    },
  ).read();

  const tiny = overview.services.find((s) => s.id === "tiny");
  const inter = overview.services.find((s) => s.id === "inter");
  assert.equal(tiny?.status, "error");
  assert.equal(tiny?.message, "Falha de autenticação OAuth2 Tiny.");
  assert.equal(inter?.status, "error");
  assert.equal(inter?.message, "Falha na verificação de saúde do Banco Inter.");
});
test("health público é mínimo (com cache) e os detalhes por conector exigem admin", async (t) => {
  let tinyCalls = 0;
  const healthCheckers = {
    checkTiny: async () => {
      tinyCalls++;
      return { connected: true, message: "API v3 operacional." };
    },
    checkInter: async () => ({ connected: true, message: "mTLS OK nas filiais Fabrilux, Revesta." }),
  };
  const previous = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = "test-admin-bootstrap-password";
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = previous;
  });
  const auth = createAuthService(config);
  await auth.bootstrap();
  const overview = createOverviewService("live", [provider], () => now, healthCheckers);
  const server = createApi(config, { dashboard, overview, healthCheckers, auth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  // Público: só o status agregado, sem nomes de filiais, mensagens, baseUrl ou circuitos.
  const apiHealthRes = await fetch(`${base}/api/health`);
  assert.equal(apiHealthRes.status, 200);
  const apiHealthData = (await apiHealthRes.json()) as any;
  assert.deepEqual(apiHealthData, { status: "ok" });
  await fetch(`${base}/api/health`);
  assert.equal(tinyCalls, 1, "segunda consulta em < 30 s vem do cache");
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });

  // Detalhes: 401 sem sessão.
  for (const p of ["/health/tiny", "/api/health/inter", "/api/health/circuits", "/health/n8n"]) {
    assert.equal((await fetch(`${base}${p}`)).status, 401, p);
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin_jp", senha: "test-admin-bootstrap-password" }),
  });
  const { token } = (await login.json()) as { token: string };
  const admin = { Authorization: `Bearer ${token}` };

  const tinyRes = await fetch(`${base}/health/tiny`, { headers: admin });
  assert.equal(tinyRes.status, 200);
  const tinyData = (await tinyRes.json()) as any;
  assert.equal(tinyData.service, "tiny");
  assert.equal(tinyData.connected, true);

  const interRes = await fetch(`${base}/health/inter`, { headers: admin });
  assert.equal(interRes.status, 200);
  assert.equal(((await interRes.json()) as any).service, "inter");

  const n8nRes = await fetch(`${base}/health/n8n`, { headers: admin });
  assert.ok([200, 503].includes(n8nRes.status));
  const n8nData = (await n8nRes.json()) as any;
  assert.equal(n8nData.service, "n8n");
  assert.ok("connected" in n8nData);
});


