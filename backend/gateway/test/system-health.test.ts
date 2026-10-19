import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import type { FinancialDashboardService } from "../src/financial-dashboard.js";
import {
  backupCheck,
  circuitBreakersCheck,
  createSystemHealthMonitor,
  databaseCheck,
  financialSyncCheck,
  marketplaceEngineCheck,
  sefazCheck,
  worstState,
  type HealthCheckDefinition,
  type HealthState,
} from "../src/system-health.js";

const NOW = new Date("2026-09-25T12:00:00Z");
const clock = () => NOW;

test("worstState: erro > atenção > ok > desconhecido", () => {
  assert.equal(worstState([]), "unknown");
  assert.equal(worstState(["unknown", "ok"]), "ok");
  assert.equal(worstState(["ok", "warning", "unknown"]), "warning");
  assert.equal(worstState(["warning", "error", "ok"]), "error");
});

test("monitor: cache curto, histórico e disponibilidade por checagem", async () => {
  let calls = 0;
  const states: HealthState[] = ["ok", "error", "ok", "ok"];
  const flaky: HealthCheckDefinition = {
    id: "flaky",
    title: "Instável",
    group: "Integrações",
    async run() {
      return { state: states[calls++]!, message: "" };
    },
  };
  const slow: HealthCheckDefinition = {
    id: "slow",
    title: "Lento",
    group: "Infraestrutura",
    run: () => new Promise(() => {}),
  };
  const monitor = createSystemHealthMonitor([flaky, slow], { cacheMs: 60_000, timeoutMs: 50 });

  const first = await monitor.read();
  assert.equal(calls, 1);
  await monitor.read(); // dentro do cache: não roda de novo
  assert.equal(calls, 1);
  await monitor.read(true);
  await monitor.read(true);
  const report = await monitor.read(true);
  assert.equal(calls, 4);

  const flakyResult = report.checks.find((c) => c.id === "flaky")!;
  assert.equal(flakyResult.history.length, 4);
  assert.equal(flakyResult.uptimePct, 75);
  // Checagem que não responde vira erro por tempo esgotado, sem travar o relatório.
  const slowResult = first.checks.find((c) => c.id === "slow")!;
  assert.equal(slowResult.state, "error");
  assert.match(slowResult.message, /sem resposta/);
  assert.equal(report.overall, "error");
});

test("backupCheck: sem configuração, sem arquivo, falhou, atrasado e ok", async () => {
  assert.equal((await backupCheck(undefined, clock).run()).state, "unknown");

  const dir = await mkdtemp(join(tmpdir(), "backup-status-"));
  const file = join(dir, "last-backup.json");
  const missing = await backupCheck(file, clock).run();
  assert.equal(missing.state, "error");
  assert.match(missing.message, /Nenhum backup/);

  await writeFile(file, JSON.stringify({ status: "error", finishedAt: "2026-09-25T05:30:00Z", error: "Falha na etapa: dump do banco financeiro (código 2)" }));
  const failed = await backupCheck(file, clock).run();
  assert.equal(failed.state, "error");
  assert.match(failed.message, /dump do banco financeiro/);

  await writeFile(file, JSON.stringify({ status: "ok", finishedAt: "2026-09-23T05:30:00Z", sizeBytes: 5 * 1024 ** 2, offsite: false }));
  assert.equal((await backupCheck(file, clock).run()).state, "warning");

  await writeFile(file, JSON.stringify({ status: "ok", finishedAt: "2026-09-25T05:30:00Z", sizeBytes: 5 * 1024 ** 2, retentionDays: 14, offsite: true }));
  const ok = await backupCheck(file, clock).run();
  assert.equal(ok.state, "ok");
  assert.deepEqual(
    ok.details?.map((d) => [d.label, d.value]),
    [
      ["Último backup", "há 6h 30min"],
      ["Tamanho", "5,0 MB"],
      ["Retenção", "14 dias"],
      ["Cópia fora do servidor", "Sim"],
    ],
  );
});

test("financialSyncCheck: falha parcial, total e sincronização atrasada", async () => {
  const company = (account_id: string, ok: boolean) => ({
    account_id,
    cnpj: "",
    ok,
    erro: ok ? null : "HTTP 403",
    caixa_lancamentos: 0,
    contas_pagar_abertas: 0,
    contas_receber_abertas: 0,
  });
  const service = (finishedAt: string, companies: ReturnType<typeof company>[]) =>
    ({
      readStatus: async () => ({
        last_sync_started_at: finishedAt,
        last_sync_finished_at: finishedAt,
        next_sync_at: "",
        companies,
        is_running: false,
        cooldown_seconds_remaining: 0,
      }),
    }) as unknown as FinancialDashboardService;

  const partial = await financialSyncCheck(
    service("2026-09-25T06:00:00Z", [company("fabrilux", true), company("norvia_campinas", false)]),
    clock,
  ).run();
  assert.equal(partial.state, "warning");
  assert.ok(partial.details?.some((d) => d.label === "Norvia Campinas" && d.value === "HTTP 403"));

  const total = await financialSyncCheck(service("2026-09-25T06:00:00Z", [company("fabrilux", false)]), clock).run();
  assert.equal(total.state, "error");

  const stale = await financialSyncCheck(service("2026-09-23T06:00:00Z", [company("fabrilux", true)]), clock).run();
  assert.equal(stale.state, "warning");
  assert.match(stale.message, /26 horas/);

  const semGravar = await financialSyncCheck(
    {
      readStatus: async () => ({
        ...(await service("2026-09-23T06:00:00Z", [company("fabrilux", true)]).readStatus()),
        erro_gravacao: "financial_dashboard_status.json: [Errno 13] Permission denied",
      }),
    } as unknown as FinancialDashboardService,
    clock,
  ).run();
  assert.equal(semGravar.state, "error");
  assert.ok(semGravar.details?.some((d) => d.label === "Erro de gravação" && /Permission denied/.test(d.value)));
});

test("sefazCheck: varredura parada há mais de 26h e erro de gravação do NSU", async () => {
  const danfe = (finishedAt: string, erro_gravacao: string | null = null) =>
    ({
      readSefazStatus: async () => ({
        last_scan_started_at: finishedAt,
        last_scan_finished_at: finishedAt,
        next_scan_at: "",
        total_novas_notas: 0,
        pending_review_count: 0,
        cnpjs: [],
        cooldown_seconds_remaining: 0,
        certificados: [],
        erro_gravacao,
      }),
    }) as unknown as Parameters<typeof sefazCheck>[0];

  assert.equal((await sefazCheck(danfe("2026-09-25T06:00:00Z"), clock).run()).state, "ok");
  const parada = await sefazCheck(danfe("2026-09-23T06:00:00Z"), clock).run();
  assert.equal(parada.state, "warning");
  assert.match(parada.message, /26 horas/);
  const semGravar = await sefazCheck(danfe("2026-09-25T06:00:00Z", "sefaz_nsu_state.json: Permission denied"), clock).run();
  assert.equal(semGravar.state, "error");
  assert.match(semGravar.message, /NSU/);
});

test("GET /api/admin/system-health é exclusivo do admin", async (t) => {
  const config = readConfig();
  const demo = createDemo();
  const previousBootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = "test-admin-bootstrap-password";
  t.after(() => {
    if (previousBootstrapPassword === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = previousBootstrapPassword;
  });
  const authService = createAuthService(config);
  await authService.bootstrap();
  const systemHealth = createSystemHealthMonitor([
    { id: "x", title: "X", group: "Infraestrutura", run: async () => ({ state: "ok", message: "tudo certo" }) },
  ]);
  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth: authService,
    systemHealth,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/api/admin/system-health`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin_jp", senha: "test-admin-bootstrap-password" }),
  });
  const { token } = (await login.json()) as { token: string };
  const res = await fetch(`${base}/api/admin/system-health`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const report = (await res.json()) as any;
  assert.equal(report.overall, "ok");
  assert.equal(report.checks[0].message, "tudo certo");
  assert.equal(report.checks[0].uptimePct, 100);
});

test("databaseCheck: sem banco, com latência medida e lista de esquemas operacionais", async () => {
  const semBanco = await databaseCheck(undefined).run();
  assert.equal(semBanco.state, "unknown");

  const basico = await databaseCheck(async () => {}).run();
  assert.equal(basico.state, "ok");
  assert.match(basico.message, /Banco respondendo a consultas/);
  assert.ok(basico.details?.some((d) => d.label === "Latência de consulta"));

  const completo = await databaseCheck(async () => ({
    latencyMs: 12,
    databases: ["financeiro", "marketplace", "producao"],
  })).run();
  assert.equal(completo.state, "ok");
  assert.equal(completo.message, "Banco respondendo a consultas (12ms).");
  assert.ok(completo.details?.some((d) => d.label === "Latência de consulta" && d.value === "12ms"));
  assert.ok(
    completo.details?.some((d) => d.label === "Bancos operacionais" && d.value === "financeiro, marketplace, producao"),
  );
});

test("marketplaceEngineCheck: sem configuração, sucesso, erro HTTP e exceção", async () => {
  assert.equal((await marketplaceEngineCheck(undefined).run()).state, "unknown");

  const ok = await marketplaceEngineCheck(async () => ({
    status: "ok",
    service: "automacoes-marketplace",
  })).run();
  assert.equal(ok.state, "ok");
  assert.equal(ok.message, "Serviço de Marketplace operacional.");
  assert.ok(ok.details?.some((d) => d.label === "Serviço" && d.value === "automacoes-marketplace"));

  const falhaStatus = await marketplaceEngineCheck(async () => ({
    status: "degraded",
  })).run();
  assert.equal(falhaStatus.state, "error");
  assert.match(falhaStatus.message, /status "degraded"/);

  const erroHttp = await marketplaceEngineCheck(async () => new Response("Internal Error", { status: 500 })).run();
  assert.equal(erroHttp.state, "error");
  assert.match(erroHttp.message, /HTTP 500/);

  const excecao = await marketplaceEngineCheck(async () => {
    throw new Error("ECONNREFUSED");
  }).run();
  assert.equal(excecao.state, "error");
  assert.match(excecao.message, /ECONNREFUSED/);
});

test("circuitBreakersCheck: sem circuitos, todos fechados, half-open e aberto", async () => {
  const vazio = await circuitBreakersCheck(() => ({})).run();
  assert.equal(vazio.state, "ok");
  assert.match(vazio.message, /Nenhum circuito/);

  const todosFechados = await circuitBreakersCheck(() => ({
    tiny: {
      name: "tiny",
      state: "closed",
      failureCount: 0,
      successCount: 10,
      lastError: null,
      lastStateChange: new Date().toISOString(),
      nextAttemptAt: null,
    },
    inter: {
      name: "inter",
      state: "closed",
      failureCount: 0,
      successCount: 5,
      lastError: null,
      lastStateChange: new Date().toISOString(),
      nextAttemptAt: null,
    },
  })).run();
  assert.equal(todosFechados.state, "ok");
  assert.match(todosFechados.message, /Todos os 2 circuitos/);
  assert.equal(todosFechados.details?.length, 2);
  assert.ok(todosFechados.details?.every((d) => d.state === "ok"));

  const recuperando = await circuitBreakersCheck(() => ({
    tiny: {
      name: "tiny",
      state: "half_open",
      failureCount: 5,
      successCount: 1,
      lastError: "Timeout",
      lastStateChange: new Date().toISOString(),
      nextAttemptAt: null,
    },
  })).run();
  assert.equal(recuperando.state, "warning");
  assert.match(recuperando.message, /1 circuito\(s\) em recuperação/);
  assert.equal(recuperando.details?.[0].state, "warning");

  const aberto = await circuitBreakersCheck(() => ({
    tiny: {
      name: "tiny",
      state: "open",
      failureCount: 5,
      successCount: 0,
      lastError: "503 Service Unavailable",
      lastStateChange: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + 30000).toISOString(),
    },
    sefaz: {
      name: "sefaz",
      state: "closed",
      failureCount: 0,
      successCount: 12,
      lastError: null,
      lastStateChange: new Date().toISOString(),
      nextAttemptAt: null,
    },
  })).run();
  assert.equal(aberto.state, "error");
  assert.match(aberto.message, /1 circuito\(s\) ABERTO\(S\)/);
  assert.ok(aberto.details?.some((d) => d.label === "Circuito · tiny" && d.state === "error"));
  assert.ok(aberto.details?.some((d) => d.label === "Circuito · sefaz" && d.state === "ok"));
});
