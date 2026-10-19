import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationRoutes } from "../src/routes/reconciliation.js";
import { readConfig } from "../src/config.js";
import type { RequestContext } from "../src/http.js";

test("GET /api/reconciliation/estado responde 200 com estrutura de estado", async () => {
  const handler = createReconciliationRoutes({
    config: readConfig(),
    pythonApiUrl: "http://127.0.0.1:9999", // url inexistente força fallback gracioso
  });

  let statusEnviado = 0;
  let bodyEnviado: any = null;

  const ctx: RequestContext = {
    path: "/api/reconciliation/estado",
    method: "GET",
    url: new URL("http://localhost/api/reconciliation/estado"),
    request: {} as any,
    response: {} as any,
    requestId: "req-teste-estado",
    send: (status, body) => {
      statusEnviado = status;
      bodyEnviado = body;
      return true;
    },
  };

  const atendido = await handler(ctx);
  assert.equal(atendido, true);
  assert.equal(statusEnviado, 200);
  assert.ok(bodyEnviado);
  assert.equal(bodyEnviado.status, "vazio");
  assert.ok(Array.isArray(bodyEnviado.matches));
  assert.ok(Array.isArray(bodyEnviado.unmatched_tiny));
  assert.ok("total_casados" in bodyEnviado.summary);
});
