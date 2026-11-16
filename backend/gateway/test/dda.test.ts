import test from "node:test";
import assert from "node:assert/strict";
import { routeAccess } from "../src/permissions.js";
import { createDdaRoutes } from "../src/routes/dda.js";

function ctx(path: string, method: string, body?: unknown) {
  const url = new URL(`http://gw${path}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const sent: { status?: number; body?: any } = {};
  const request = (async function* () {
    yield* chunks;
  })() as any;
  request.headers = {};
  return {
    sent,
    ctx: {
      request,
      response: { statusCode: 0, setHeader() {}, end() {} } as any,
      url,
      path: url.pathname,
      method,
      ip: "10.0.0.1",
      requestId: "r1",
      session: { user: { id: 5, nome: "Fin" } as any, permissions: [] },
      send(status: number, b: unknown) {
        sent.status = status;
        sent.body = b;
        return true;
      },
    } as any,
  };
}

function fakePython(handlers: Record<string, (init: RequestInit) => Response>) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/api/v1/health")) return new Response("{}", { status: 200 });
    chamadas.push({ url, init });
    const h = handlers[`${init.method ?? "GET"} ${url.replace("http://py:8000", "")}`];
    return h ? h(init) : new Response(JSON.stringify({ detail: "nao achou" }), { status: 404 });
  }) as any;
  return { chamadas, fetchImpl };
}

const UUID = "0b6f1c2e-1a2b-4c3d-9e8f-123456789abc";

test("boletos DDA: leitura com a aba Contas a Pagar, decisões com Dar baixa", () => {
  assert.deepEqual(routeAccess("GET", "/api/dda/boletos"), { kind: "perm", key: "contas_pagar:ver" });
  assert.deepEqual(routeAccess("GET", "/api/dda/status"), { kind: "perm", key: "contas_pagar:ver" });
  assert.deepEqual(routeAccess("POST", "/api/dda/executar"), { kind: "perm", key: "contas_pagar:baixar" });
  for (const acao of ["vincular", "criar", "descartar", "reabrir"]) {
    assert.deepEqual(routeAccess("POST", `/api/dda/boletos/${UUID}/${acao}`), { kind: "perm", key: "contas_pagar:baixar" });
  }
});

test("criar conta repassa só os campos esperados e vai para a auditoria", async () => {
  const auditados: any[] = [];
  const { chamadas, fetchImpl } = fakePython({
    [`POST /api/v1/dda/boletos/${UUID}/criar-conta`]: () => new Response(JSON.stringify({ boleto: { id: UUID, situacao: "CASADO" } }), { status: 200 }),
  });
  const handler = createDdaRoutes({ pythonApiUrl: "http://py:8000", fetchImpl, audit: { record: async (e: any) => void auditados.push(e) } as any });
  const { ctx: c, sent } = ctx(`/api/dda/boletos/${UUID}/criar`, "POST", { categoria_id: 321, historico: "Aluguel", extra: "x" });
  await handler(c);
  assert.equal(sent.status, 200);
  assert.deepEqual(JSON.parse(String(chamadas[0].init.body)), { categoria_id: 321, historico: "Aluguel" });
  assert.equal(auditados[0].acao, "dda_conta_criada");
  assert.equal(auditados[0].alvo, UUID);
  assert.equal(auditados[0].sucesso, true);
});

test("recusa do motor (409) chega ao painel e é auditada como falha", async () => {
  const auditados: any[] = [];
  const { fetchImpl } = fakePython({
    [`POST /api/v1/dda/boletos/${UUID}/descartar`]: () =>
      new Response(JSON.stringify({ detail: "Boleto agendado no Inter: cancele o agendamento no Internet Banking antes." }), { status: 409 }),
  });
  const handler = createDdaRoutes({ pythonApiUrl: "http://py:8000", fetchImpl, audit: { record: async (e: any) => void auditados.push(e) } as any });
  const { ctx: c, sent } = ctx(`/api/dda/boletos/${UUID}/descartar`, "POST", { motivo: "duplicado" });
  await handler(c);
  assert.equal(sent.status, 409);
  assert.equal(auditados[0].sucesso, false);
});

test("rota desconhecida do DDA responde 404 e outras rotas passam adiante", async () => {
  const handler = createDdaRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: fakePython({}).fetchImpl });
  const a = ctx("/api/dda/xyz", "GET");
  await handler(a.ctx);
  assert.equal(a.sent.status, 404);
  assert.equal(await handler(ctx("/api/outra", "GET").ctx), false);
});

test("leituras do painel vão para /api/v1/dda/* no motor", async () => {
  const { chamadas, fetchImpl } = fakePython({
    "GET /api/v1/dda/status": () => new Response(JSON.stringify({ ativo: true }), { status: 200 }),
    "GET /api/v1/dda/boletos": () => new Response(JSON.stringify({ itens: [] }), { status: 200 }),
    "GET /api/v1/dda/execucoes": () => new Response(JSON.stringify({ itens: [] }), { status: 200 }),
  });
  const handler = createDdaRoutes({ pythonApiUrl: "http://py:8000", fetchImpl });
  for (const p of ["status", "boletos", "execucoes"]) {
    const c = ctx(`/api/dda/${p}`, "GET");
    await handler(c.ctx);
    assert.equal(c.sent.status, 200, p);
  }
  assert.deepEqual(chamadas.map((c) => c.url), ["http://py:8000/api/v1/dda/status", "http://py:8000/api/v1/dda/boletos", "http://py:8000/api/v1/dda/execucoes"]);
});

test("validar em lote repassa só ids válidos e audita", async () => {
  const auditados: any[] = [];
  const { chamadas, fetchImpl } = fakePython({
    "POST /api/v1/dda/boletos/validar": () => new Response(JSON.stringify({ validados: [UUID], recusados: [] }), { status: 200 }),
  });
  const handler = createDdaRoutes({ pythonApiUrl: "http://py:8000", fetchImpl, audit: { record: async (e: any) => void auditados.push(e) } as any });
  const c = ctx("/api/dda/validar", "POST", { ids: [UUID, "../x"] });
  await handler(c.ctx);
  assert.equal(c.sent.status, 200);
  assert.deepEqual(JSON.parse(String(chamadas[0].init.body)), { ids: [UUID] });
  assert.equal(auditados[0].acao, "dda_boletos_validados");
  assert.equal(routeAccess("POST", "/api/dda/validar").kind, "perm");
});

test("criar contas em lote exige categoria em todos", async () => {
  const { chamadas, fetchImpl } = fakePython({});
  const handler = createDdaRoutes({ pythonApiUrl: "http://py:8000", fetchImpl });
  const c = ctx("/api/dda/criar-contas", "POST", { itens: [{ boleto_id: UUID, categoria_id: 3 }, { boleto_id: UUID }] });
  await handler(c.ctx);
  assert.equal(c.sent.status, 400);
  assert.equal(chamadas.length, 0);
});
