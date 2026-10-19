import test from "node:test";
import assert from "node:assert/strict";
import { createDanfeService } from "../src/danfe.js";

const window = { days: 14 as const, from: "2026-09-15T03:00:00.000Z", to: "2026-09-28T15:00:00.000Z" };

function stubFetch(t: test.TestContext, history: unknown[]) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/v1/health")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ total: history.length, history }), { status: 200 });
  }) as typeof fetch;
}

test("Histórico da DANFE em produção vem da auditoria real, sem duração inventada", async (t) => {
  stubFetch(t, [
    { processed_at: "2026-09-28T12:00:00Z", audit_status: "success", chave_acesso: "41260943820617000166550010000123451000123451" },
    { processed_at: "2026-09-27T12:00:00Z", audit_status: "error", details: "Chave não localizada" },
    { processed_at: "2026-09-01T12:00:00Z", audit_status: "success" },
  ]);
  const { complete, executions } = await createDanfeService("live", "http://nfe.test").historyAdapter.readHistory(window);
  assert.equal(complete, true);
  assert.deepEqual(executions.map((e) => e.status), ["success", "error"]);
  assert.equal(executions[0]!.durationMs, null);
  assert.equal(executions[1]!.stoppedNode, "Chave não localizada");
});

test("Histórico da DANFE: resposta no limite cobrindo só parte da janela é marcada incompleta", async (t) => {
  const recentes = Array.from({ length: 1000 }, (_, i) => ({
    processed_at: new Date(Date.parse("2026-09-28T12:00:00Z") - i * 60_000).toISOString(),
    audit_status: "success",
  }));
  stubFetch(t, recentes);
  const { complete, executions } = await createDanfeService("live", "http://nfe.test").historyAdapter.readHistory(window);
  assert.equal(executions.length, 1000);
  assert.equal(complete, false);
});
