import test from "node:test";
import assert from "node:assert/strict";
import { createExecucoesCounter, normalizarRota } from "../src/execucoes.js";

test("normalizarRota troca ids, UUIDs, hashes e códigos de anúncio por :id", () => {
  assert.equal(normalizarRota("/api/danfe/123/confirm"), "/api/danfe/:id/confirm");
  assert.equal(normalizarRota("/api/x/0b4e7a1c-1d2e-4f3a-9b8c-7d6e5f4a3b2c"), "/api/x/:id");
  assert.equal(normalizarRota("/api/marketplace/anuncios/MLB4123456789"), "/api/marketplace/anuncios/:id");
  assert.equal(normalizarRota("/api/ml-reconciliation/baixar"), "/api/ml-reconciliation/baixar");
});

test("execuções: ok abaixo de 500, erro em 5xx, uma linha por janela e zera depois", () => {
  const c = createExecucoesCounter();
  assert.equal(c.fechar(60), null);
  c.registrar("POST", "/api/danfe/1/confirm", 200);
  c.registrar("POST", "/api/danfe/2/confirm", 404);
  c.registrar("POST", "/api/danfe/3/confirm", 502);
  const linha = JSON.parse(c.fechar(60)!);
  assert.equal(linha.event, "execucoes");
  assert.deepEqual(linha.rotas, { "POST /api/danfe/:id/confirm": { ok: 2, erro: 1 } });
  assert.equal(c.fechar(60), null);
});
