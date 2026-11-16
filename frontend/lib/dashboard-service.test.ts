import assert from "node:assert/strict";
import test from "node:test";
import { HttpDashboardService, MockDashboardService, parseDashboard } from "./dashboard-service";
import { makeDemoDashboard } from "./demo";
import { automationStatus } from "./automations";

const timestamp = "2026-09-08T12:30:00Z";
const liveFixture = () => ({ ...makeDemoDashboard(timestamp), mode: "live" as const });

void test("demonstration preserves independent accumulated metrics and complete approval/failure lists", async () => {
  const result = await new MockDashboardService().getDashboard();
  assert.equal(result.mode, "demo");
  assert.deepEqual(result.metrics, {
    totalQueue: 1280,
    paidCount: 1092,
    reconciledCount: 1184,
    hoursSaved: 81.9,
    estimatedSavings: 900.9,
    automationRate: 92.5,
  });
  assert.equal(result.approvals?.length, 12);
  assert.equal(result.failures?.length, 4);
  assert.equal(result.executions?.length, 56);
  assert.ok(result.approvals?.every((account) => account.beneficiary.includes("(fictício)")));
});

void test("live request uses relative endpoint, same-origin credentials, no cache and signal", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, "/api/accounts-payable/dashboard");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return Response.json(liveFixture());
  };
  const result = await new HttpDashboardService("", fetcher).getDashboard();
  assert.equal(result.mode, "live");
});

void test("live request strips trailing base slash and surfaces authorization failure without demo fallback", async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.equal(input, "https://api.example.test/api/accounts-payable/dashboard");
    return new Response(null, { status: 401 });
  };
  await assert.rejects(
    new HttpDashboardService("https://api.example.test/", fetcher).getDashboard(),
    /não autorizado/,
  );
});

void test("live mode refuses a demonstration response", async () => {
  const fetcher: typeof fetch = async () => Response.json(makeDemoDashboard(timestamp));
  await assert.rejects(
    new HttpDashboardService("", fetcher).getDashboard(),
    /resposta demonstrativa/,
  );
});

void test("network failure remains an error and does not return a fixture", async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error("Network unavailable");
  };
  await assert.rejects(new HttpDashboardService("", fetcher).getDashboard(), /Network unavailable/);
});

void test("abort is honored in demo and passed through the HTTP boundary", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new MockDashboardService().getDashboard(controller.signal), {
    name: "AbortError",
  });
  const fetcher: typeof fetch = async (_input, init) => {
    init?.signal?.throwIfAborted();
    return Response.json(liveFixture());
  };
  await assert.rejects(new HttpDashboardService("", fetcher).getDashboard(controller.signal), {
    name: "AbortError",
  });
});

void test("n8n outage preserves business data as a partial result", () => {
  const data = liveFixture();
  data.executions = null;
  data.sources.n8n = { status: "error", message: "n8n indisponível" };
  const parsed = parseDashboard(data);
  assert.equal(parsed.metrics?.hoursSaved, 81.9);
  assert.equal(parsed.executions, null);
  assert.equal(automationStatus(parsed, false, false), "Falha de conexão");
});

void test("database outage is distinct from an empty database", () => {
  const unavailable = liveFixture();
  unavailable.metrics = null;
  unavailable.approvals = null;
  unavailable.failures = null;
  unavailable.sources.database = { status: "error" };
  assert.equal(parseDashboard(unavailable).metrics, null);
  const empty = liveFixture();
  empty.metrics = {
    totalQueue: 0,
    paidCount: 0,
    reconciledCount: 0,
    hoursSaved: 0,
    estimatedSavings: 0,
    automationRate: null,
  };
  empty.approvals = [];
  empty.failures = [];
  assert.equal(parseDashboard(empty).metrics?.automationRate, null);
});

void test("invalid and contradictory contracts are rejected", () => {
  const cases = [
    null,
    {},
    { ...liveFixture(), mode: "unknown" },
    { ...liveFixture(), generatedAt: "invalid" },
    { ...liveFixture(), metrics: { ...liveFixture().metrics, totalQueue: Infinity } },
    { ...liveFixture(), metrics: { ...liveFixture().metrics, automationRate: 101 } },
    { ...liveFixture(), metrics: null },
    { ...liveFixture(), executions: null },
  ];
  for (const value of cases) assert.throws(() => parseDashboard(value), /incompatíveis/);
});

void test("dates are validated while MariaDB updatedAt and decimal strings preserve transport semantics", () => {
  const data = liveFixture();
  data.approvals![0].updatedAt = "2026-09-08 09:30:00";
  data.approvals![0].amount = "-10.125";
  assert.equal(parseDashboard(data).approvals?.[0].amount, "-10.125");
  data.approvals![0].dueDate = "2026-02-30";
  assert.throws(() => parseDashboard(data), /incompatíveis/);
});

void test("overall attention reflects failed technical executions as well as business pending work", () => {
  const data = liveFixture();
  data.approvals = [];
  data.failures = [];
  assert.equal(automationStatus(data, false, false), "Requer atenção");
  data.executions = data.executions!.filter((execution) => execution.status !== "error");
  assert.equal(automationStatus(data, false, false), "Operacional");
  assert.equal(automationStatus(data, false, true), "Falha de conexão");
});

void test("métricas sem horas/R$ (usuário sem roi:ver) continuam válidas", () => {
  const data = liveFixture();
  const { hoursSaved: _h, estimatedSavings: _e, ...semRoi } = data.metrics!;
  data.metrics = semRoi;
  const parsed = parseDashboard(data);
  assert.equal(parsed.metrics?.hoursSaved, undefined);
  assert.equal(parsed.metrics?.estimatedSavings, undefined);
  assert.equal(parsed.metrics?.paidCount, 1092);
});

void test("horas/R$ presentes mas inválidos continuam rejeitados", () => {
  const data = liveFixture();
  data.metrics = { ...data.metrics!, hoursSaved: -1 };
  assert.throws(() => parseDashboard(data));
});
