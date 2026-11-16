import test from "node:test";
import assert from "node:assert/strict";
import { createDanfeService } from "../src/danfe.js";

const STATUS = { next_scan_at: "2026-11-10T06:00:00", total_novas_notas: 0, pending_review_count: 116, cnpjs: [] };

function stubFetch(t: test.TestContext, falhas: number) {
  const original = globalThis.fetch;
  const erros: string[] = [];
  const consoleError = console.error;
  const consoleWarn = console.warn;
  t.after(() => {
    globalThis.fetch = original;
    console.error = consoleError;
    console.warn = consoleWarn;
  });
  console.error = (msg: string) => void erros.push(String(msg));
  console.warn = () => {};
  let chamadas = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/v1/health")) return new Response("{}", { status: 200 });
    chamadas += 1;
    if (chamadas <= falhas) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(JSON.stringify(STATUS), { status: 200 });
  }) as typeof fetch;
  return { erros, chamadas: () => chamadas };
}

test("Status SEFAZ: um timeout isolado é repetido e não vira ERROR (incidente)", async (t) => {
  const s = stubFetch(t, 1);
  const status = await createDanfeService("live", "http://nfe.test").readSefazStatus();
  assert.equal(status.pending_review_count, 116);
  assert.equal(s.chamadas(), 2);
  assert.deepEqual(s.erros, []);
});

test("Status SEFAZ: falha que se repete loga ERROR e devolve o status vazio", async (t) => {
  const s = stubFetch(t, 2);
  const status = await createDanfeService("live", "http://nfe.test").readSefazStatus();
  assert.equal(status.pending_review_count, 0);
  assert.equal(s.chamadas(), 2);
  assert.equal(s.erros.length, 1);
  assert.match(s.erros[0]!, /readSefazStatus falhou/);
});
