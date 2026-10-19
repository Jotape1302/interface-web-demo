import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage, readApiError } from "./api-errors";

test("prefere detail, depois error, depois message", () => {
  assert.equal(apiErrorMessage({ detail: "D", error: "E" }, 400, "Falha"), "D");
  assert.equal(apiErrorMessage({ error: "E", message: "M" }, 400, "Falha"), "E");
  assert.equal(apiErrorMessage({ message: "M" }, 400, "Falha"), "M");
});

test("lista de validação do FastAPI vira texto", () => {
  assert.equal(apiErrorMessage({ detail: [{ msg: "a" }, { msg: "b" }] }, 422, "Falha"), "a; b");
});

test("anexa erro_id das automações e requestId só em 5xx", () => {
  assert.equal(
    apiErrorMessage({ error: "Falha X", detail: "Falha X", erro_id: "abc123" }, 502, "Falha"),
    "Falha X (ref.: abc123)",
  );
  assert.equal(apiErrorMessage({ error: "Erro interno", requestId: "req-1" }, 500, "Falha"), "Erro interno (ref.: req-1)");
  assert.equal(apiErrorMessage({ error: "Inválido", requestId: "req-1" }, 400, "Falha"), "Inválido");
});

test("sem corpo usa padrão com status, inclusive 413/415", () => {
  assert.equal(apiErrorMessage(null, 404, "Falha ao carregar"), "Falha ao carregar (HTTP 404).");
  assert.match(apiErrorMessage(null, 413, "Falha"), /grandes demais \(HTTP 413\)/);
  assert.match(apiErrorMessage("html", 415, "Falha"), /não suportado.*HTTP 415/);
});

test("readApiError não quebra com corpo HTML", async () => {
  const res = new Response("<html>413 Request Entity Too Large</html>", { status: 413 });
  assert.match(await readApiError(res, "Falha"), /HTTP 413/);
  const json = new Response(JSON.stringify({ detail: "Rode Comparar de novo" }), { status: 409 });
  assert.equal(await readApiError(json, "Falha"), "Rode Comparar de novo");
});
