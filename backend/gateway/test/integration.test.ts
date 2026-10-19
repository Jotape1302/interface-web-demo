import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { metricsFromCounts } from "../src/database.js";
import { createN8n, mapExecution } from "../src/n8n.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
const config = readConfig({});
test("métricas preservam semântica, precisão e ausência de denominador", () => {
  assert.deepEqual(metricsFromCounts(1280n, 1092n, 1184n), {
    totalQueue: 1280,
    paidCount: 1092,
    reconciledCount: 1184,
    hoursSaved: 91,
    estimatedSavings: 1001,
    automationRate: 92.5,
  });
  assert.equal(metricsFromCounts(0, 0, 0).automationRate, null);
  assert.equal(metricsFromCounts(1, 1, 0).estimatedSavings, (5 / 60) * 11);
  assert.throws(() => metricsFromCounts(1, 2, 0));
  assert.throws(() => metricsFromCounts(9007199254740993n, 0, 0));
});
test("configuração valida modo real e nomes sem aceitar SQL injetado", () => {
  assert.throws(() => readConfig({ DATA_MODE: "live" }), /DB_HOST/);
  assert.throws(() => readConfig({ CORS_ORIGINS: "*" }));
  assert.equal(
    readConfig({ N8N_BASE_URL: "https://servidor.norvia.example/n8n/home/workflows" }).n8n.baseUrl,
    "https://servidor.norvia.example/n8n",
  );
  assert.equal(
    readConfig({ N8N_BASE_URL: "https://servidor.norvia.example/n8n/api/v1/" }).n8n.baseUrl,
    "https://servidor.norvia.example/n8n",
  );
  assert.equal(
    readConfig({ N8N_BASE_URL: "https://servidor.norvia.example/n8n/" }).n8n.baseUrl,
    "https://servidor.norvia.example/n8n",
  );
  assert.equal(
    readConfig({ N8N_BASE_URL: "http://host.docker.internal:5678" }).n8n.baseUrl,
    "http://host.docker.internal:5678",
  );
  assert.equal(
    readConfig({
      DATA_MODE: "live",
      DB_HOST: "mariadb",
      DB_USER: "u",
      DB_PASSWORD: "p",
      ADMIN_BOOTSTRAP_PASSWORD: "test-admin-password",
      N8N_BASE_URL: "http://host.docker.internal:5678",
      N8N_API_KEY: "key",
      N8N_WORKFLOW_ID: "wf-1",
    }).n8n.baseUrl,
    "http://host.docker.internal:5678",
  );
  assert.equal(
    readConfig({
      DATA_MODE: "live",
      DB_HOST: "mariadb",
      DB_USER: "u",
      DB_PASSWORD: "p",
      ADMIN_BOOTSTRAP_PASSWORD: "test-admin-password",
      N8N_BASE_URL: "http://172.17.0.1:5678",
      N8N_API_KEY: "key",
      N8N_WORKFLOW_ID: "wf-1",
    }).n8n.baseUrl,
    "http://172.17.0.1:5678",
  );
  // ADMIN_BOOTSTRAP_PASSWORD só serve ao seed: não é mais obrigatória em live.
  assert.doesNotThrow(() => readConfig({ DATA_MODE: "live", DB_HOST: "mariadb", DB_USER: "u", DB_PASSWORD: "p" }));
  assert.throws(() => readConfig({ AUTOMATIONS_INTERNAL_KEY: "curta" }), /32 caracteres/);
  assert.throws(() => readConfig({ TRUSTED_PROXIES: "10.0.0.0/99" }), /TRUSTED_PROXIES/);
});
test("telemetria valida horário, estado desconhecido e nó de parada", () => {
  const row = {
    id: "1",
    status: "waiting",
    startedAt: "2026-09-08T12:00:00Z",
    stoppedAt: "2026-09-08T12:01:00Z",
    data: { resultData: { lastNodeExecuted: "Aprovar" } },
  };
  assert.equal(mapExecution(row).durationMs, null);
  assert.equal(mapExecution(row).stoppedNode, "Aprovar");
  assert.equal(mapExecution({ id: "2", status: "canceled" }).status, "unknown");
  assert.throws(() => mapExecution({ id: "2", startedAt: "ontem" }));
  assert.equal(mapExecution({ ...row, status: "error" }).durationMs, 60000);
});
test("n8n usa workflow, header, limite e reduz dados sensíveis", async () => {
  const cfg = {
    ...config,
    n8n: { baseUrl: "https://n8n.example.test", apiKey: "test-key", workflowId: "w1" },
  };
  const mock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("workflowId"), "w1");
    assert.equal(url.searchParams.get("includeData"), "true");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal((init?.headers as Record<string, string>)["X-N8N-API-KEY"], "test-key");
    assert.ok(init?.signal);
    return Response.json({
      data: [
        {
          id: "12",
          status: "error",
          workflowId: "w1",
          data: { resultData: { lastNodeExecuted: "Consulta", secret: "never-return" } },
        },
      ],
    });
  }) as typeof fetch;
  const value = await createN8n(cfg, mock).read();
  assert.equal(value[0]?.stoppedNode, "Consulta");
  assert.ok(!JSON.stringify(value).includes("never-return"));
  await assert.rejects(
    createN8n(cfg, (async () => Response.json({ wrong: [] })) as typeof fetch).read(),
  );
  await assert.rejects(
    createN8n(cfg, (async () => new Response("", { status: 401 })) as typeof fetch).read(),
  );
  const timeoutMock = ((_: unknown, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("test deadline")), 1000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    })) as typeof fetch;
  await assert.rejects(createN8n({ ...cfg, timeoutMs: 10 }, timeoutMock).read(), /timeout/i);
});
test("n8n suporta múltiplos workflows do processo completo e ordena execuções agregadas", async () => {
  const multiCfg = readConfig({
    N8N_BASE_URL: "https://n8n.example.test",
    N8N_API_KEY: "test-key",
    N8N_WORKFLOW_IDS: "wf-1, wf-2, wf-3, wf-4",
  });
  assert.deepEqual(multiCfg.n8n.workflowIds, ["wf-1", "wf-2", "wf-3", "wf-4"]);
  assert.equal(multiCfg.n8n.workflowId, "wf-1");

  const requestedWorkflows: string[] = [];
  const mock = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const wf = url.searchParams.get("workflowId")!;
    requestedWorkflows.push(wf);
    const timestamp =
      wf === "wf-1"
        ? "2026-09-08T10:00:00Z"
        : wf === "wf-2"
          ? "2026-09-08T12:00:00Z"
          : wf === "wf-3"
            ? "2026-09-08T11:00:00Z"
            : "2026-09-08T09:00:00Z";
    return Response.json({
      data: [
        {
          id: `exec-${wf}`,
          status: "success",
          workflowId: wf,
          startedAt: timestamp,
          stoppedAt: timestamp,
        },
      ],
    });
  }) as typeof fetch;

  const executions = await createN8n(multiCfg, mock).read();
  assert.equal(requestedWorkflows.length, 4);
  assert.deepEqual(requestedWorkflows.sort(), ["wf-1", "wf-2", "wf-3", "wf-4"]);
  assert.equal(executions.length, 4);
  // Mais recente primeiro: wf-2 (12:00) -> wf-3 (11:00) -> wf-1 (10:00) -> wf-4 (09:00)
  assert.deepEqual(
    executions.map((e) => e.id),
    ["exec-wf-2", "exec-wf-3", "exec-wf-1", "exec-wf-4"],
  );
  assert.equal(executions[0]?.workflowId, "wf-2");
});
test("falhas parciais não substituem dados reais por demo ou zero", async () => {
  const demo = createDemo();
  const dbFail = await createDashboardService(
    "live",
    {
      async read() {
        throw new Error("secret");
      },
    },
    demo.n8n,
  ).read();
  assert.equal(dbFail.mode, "live");
  assert.equal(dbFail.metrics, null);
  assert.equal(dbFail.approvals, null);
  assert.equal(dbFail.sources.n8n.status, "ok");
  assert.ok(!JSON.stringify(dbFail).includes("secret"));
  const n8nFail = await createDashboardService("live", demo.database, {
    async read() {
      throw new Error("offline");
    },
  }).read();
  assert.equal(n8nFail.metrics?.hoursSaved, 91);
  assert.equal(n8nFail.executions, null);
});
test("HTTP entrega contrato, CORS restrito, no-store e somente leitura", async (t) => {
  const demo = createDemo();
  const server = createApi(config, { dashboard: createDashboardService("demo", demo.database, demo.n8n) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/accounts-payable/dashboard`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).mode, "demo");

  // Testa suporte a subpath encaminhado pelo Nginx (/automacoes/...)
  const subpathResponse = await fetch(`${base}/automacoes/api/accounts-payable/dashboard`);
  assert.equal(subpathResponse.status, 200);
  assert.equal((await fetch(`${base}/automacoes/health`)).status, 200);

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal(
    (await fetch(`${base}/health`, { headers: { origin: "https://untrusted.test" } })).status,
    403,
  );
  assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
});
