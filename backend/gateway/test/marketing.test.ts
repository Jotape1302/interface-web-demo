import test from "node:test";
import assert from "node:assert/strict";
import { routeAccess } from "../src/permissions.js";
import { createMarketingRoutes } from "../src/routes/marketing.js";
import { resetAllCircuitBreakers } from "../src/circuit-breaker.js";

function ctx(path: string, method: string, body?: unknown) {
  const url = new URL(`http://gw${path}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const sent: { status?: number; body?: any } = {};
  return {
    sent,
    ctx: {
      request: (async function* () {
        yield* chunks;
      })() as any,
      response: {} as any,
      url,
      path: url.pathname,
      method,
      ip: "10.0.0.1",
      requestId: "req-1",
      session: { user: { id: 2, nome: "Ana", username: "ana.lu" } as any, permissions: [] },
      send(status: number, b: unknown) {
        sent.status = status;
        sent.body = b;
        return true;
      },
    },
  };
}

test("e-mail marketing: ver para leitura, gerar e aprovar para as ações", () => {
  assert.deepEqual(routeAccess("GET", "/api/marketing/rascunhos"), { kind: "perm", key: "email_marketing:ver" });
  assert.deepEqual(routeAccess("GET", "/api/marketing/ambientes"), { kind: "perm", key: "email_marketing:ver" });
  assert.deepEqual(routeAccess("GET", "/api/marketing/ambientes/cand-1.jpg"), { kind: "perm", key: "email_marketing:ver" });
  assert.deepEqual(routeAccess("POST", "/api/marketing/gerar-lote-semanal"), { kind: "perm", key: "email_marketing:gerar" });
  assert.deepEqual(routeAccess("POST", "/api/marketing/ambientes/gerar"), { kind: "perm", key: "email_marketing:gerar" });
  assert.deepEqual(routeAccess("POST", "/api/marketing/rascunhos/draft-seg-20261116/aprovar"), {
    kind: "perm",
    key: "email_marketing:aprovar",
  });
  assert.deepEqual(routeAccess("POST", "/api/marketing/ambientes/cand-1/aprovar"), {
    kind: "perm",
    key: "email_marketing:aprovar",
  });
  assert.deepEqual(routeAccess("POST", "/api/marketing/ambientes/cand-1/recusar"), {
    kind: "perm",
    key: "email_marketing:aprovar",
  });
  assert.equal(routeAccess("DELETE", "/api/marketing/rascunhos/x").kind, "none");
});

test("aprovação vai com o login da sessão no X-Usuario, sem autor no corpo, e é auditada", async (t) => {
  t.after(resetAllCircuitBreakers);
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const auditados: any[] = [];
  const handler = createMarketingRoutes({
    baseUrl: "http://py:8004",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: (async (u: string, init: RequestInit) => {
      chamadas.push({ url: u, init });
      return new Response(JSON.stringify({ status: "ok", rascunho: { id: "draft-seg-20261116" } }), { status: 200 });
    }) as any,
  });
  const r = ctx("/api/marketing/rascunhos/draft-seg-20261116/aprovar", "POST", {});
  assert.equal(await handler(r.ctx as any), true);
  assert.equal(r.sent.status, 200);
  assert.equal(chamadas[0]!.url, "http://py:8004/api/v1/rascunhos/draft-seg-20261116/aprovar");
  const headers = chamadas[0]!.init.headers as Record<string, string>;
  assert.equal(headers["X-Usuario"], "ana.lu");
  assert.deepEqual(JSON.parse(String(chamadas[0]!.init.body)), {});
  assert.equal(auditados[0].acao, "marketing_rascunho_aprovado");
  assert.equal(auditados[0].alvo, "draft-seg-20261116");
});

test("401 da automação (chave interna) vira 502, não desloga o usuário; 202 e 409 passam", async (t) => {
  t.after(resetAllCircuitBreakers);
  let resposta = { status: 401, body: { detail: "Chave interna ausente ou inválida." } };
  const handler = createMarketingRoutes({
    baseUrl: "http://py:8004",
    fetchImpl: (async () => new Response(JSON.stringify(resposta.body), { status: resposta.status })) as any,
  });
  const a = ctx("/api/marketing/status", "GET");
  await handler(a.ctx as any);
  assert.equal(a.sent.status, 502);
  assert.match(a.sent.body.error, /autenticação entre o gateway e a automação/);

  resposta = { status: 202, body: { status: "iniciado" } as any };
  const b = ctx("/api/marketing/gerar-lote-semanal", "POST", {});
  await handler(b.ctx as any);
  assert.equal(b.sent.status, 202);

  resposta = { status: 409, body: { detail: "Já existe uma geração em andamento. Aguarde terminar." } };
  const c = ctx("/api/marketing/gerar-lote-semanal", "POST", {});
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 409);
  assert.equal(c.sent.body.error, "Já existe uma geração em andamento. Aguarde terminar.");
});

test("rota fora do mapa não chega à automação", async () => {
  let chamou = false;
  const handler = createMarketingRoutes({
    fetchImpl: (async () => {
      chamou = true;
      return new Response("{}");
    }) as any,
  });
  const r = ctx("/api/marketing/rascunhos/draft-1/apagar", "POST", {});
  await handler(r.ctx as any);
  assert.equal(r.sent.status, 404);
  assert.equal(chamou, false);
});

test("binários do carrossel (jpeg e zip) são repassados intactos com headers corretos", async (t) => {
  t.after(resetAllCircuitBreakers);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const headersSet: Record<string, string> = {};
  let statusSet = 0;
  let endedWith: any = null;

  const handler = createMarketingRoutes({
    baseUrl: "http://py:8004",
    fetchImpl: (async (u: string) => {
      if (u.includes("carrossel/1")) {
        return new Response(fakeJpeg, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      return new Response(null, { status: 404 });
    }) as any,
  });

  const r = ctx("/api/marketing/rascunhos/draft-seg-20261116/carrossel/1", "GET");
  r.ctx.response = {
    setHeader(k: string, v: string) { headersSet[k] = v; },
    writeHead(s: number) { statusSet = s; },
    end(buf: any) { endedWith = buf; },
  };

  assert.equal(await handler(r.ctx as any), true);
  assert.equal(statusSet, 200);
  assert.equal(headersSet["Content-Type"], "image/jpeg");
  assert.deepEqual(endedWith, fakeJpeg);
});

test("binário de imagem de ambiente é repassado intacto e aprovação audita com X-Usuario", async (t) => {
  t.after(resetAllCircuitBreakers);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb]);
  const headersSet: Record<string, string> = {};
  let statusSet = 0;
  let endedWith: any = null;
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const auditados: any[] = [];

  const handler = createMarketingRoutes({
    baseUrl: "http://py:8004",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: (async (u: string, init: RequestInit) => {
      chamadas.push({ url: u, init });
      if (u.includes("ambientes/cand-1.jpg")) {
        return new Response(fakeJpeg, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      if (u.includes("ambientes/cand-1/aprovar")) {
        return new Response(JSON.stringify({ status: "ok", ambiente: { id: "cand-1", status: "aprovada" } }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as any,
  });

  // 1. GET binário
  const rGet = ctx("/api/marketing/ambientes/cand-1.jpg", "GET");
  rGet.ctx.response = {
    setHeader(k: string, v: string) { headersSet[k] = v; },
    writeHead(s: number) { statusSet = s; },
    end(buf: any) { endedWith = buf; },
  };
  assert.equal(await handler(rGet.ctx as any), true);
  assert.equal(statusSet, 200);
  assert.equal(headersSet["Content-Type"], "image/jpeg");
  assert.deepEqual(endedWith, fakeJpeg);

  // 2. POST aprovação
  const rPost = ctx("/api/marketing/ambientes/cand-1/aprovar", "POST", {});
  assert.equal(await handler(rPost.ctx as any), true);
  assert.equal(rPost.sent.status, 200);
  const headers = chamadas[1]!.init.headers as Record<string, string>;
  assert.equal(headers["X-Usuario"], "ana.lu");
  assert.equal(auditados[0].acao, "marketing_ambiente_aprovado");
  assert.equal(auditados[0].alvo, "cand-1");
});

