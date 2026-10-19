import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { Pool } from "mariadb";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService, hashSessionToken, verifyPassword, MIN_PASSWORD_LENGTH } from "../src/auth.js";
import { automationFetch, encodeUserHeader } from "../src/automation-http.js";
import { buildTrustedProxyList, clientIpFrom, DEFAULT_TRUSTED_PROXIES } from "../src/client-ip.js";
import { isAllowedOrigin } from "../src/http.js";
import { createReconciliationRoutes } from "../src/routes/reconciliation.js";
import { createMarketplaceRoutes } from "../src/routes/marketplace.js";
import { createMlReconciliationRoutes } from "../src/routes/ml-reconciliation.js";
import { createReconciliationHistoryService } from "../src/reconciliation-history.js";
import { createIncidentService } from "../src/incidents.js";

const KEY = "k".repeat(40);
const ADMIN_PASS = "test-admin-bootstrap-password";
const json = { "Content-Type": "application/json" };

function withEnv(t: { after(fn: () => void): void }, vars: Record<string, string | undefined>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function listen(server: ReturnType<typeof createServer>, t: { after(fn: () => unknown): void }) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  return `http://127.0.0.1:${a.port}`;
}

async function startApi(t: any, config = readConfig(), extra: Record<string, unknown> = {}) {
  withEnv(t, { ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PASS });
  const auth = createAuthService(config);
  await auth.bootstrap();
  const demo = createDemo();
  const server = createApi(config, { dashboard: createDashboardService("demo", demo.database, demo.n8n), auth, ...extra });
  const base = await listen(server, t);
  const login = async (login: string, senha: string) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { ...json, ...(config.internalApiKey ? { "X-API-Key": config.internalApiKey } : {}) },
      body: JSON.stringify({ login, senha }),
    });
  const adminToken = ((await (await login("admin_jp", ADMIN_PASS)).json()) as any).token as string;
  return { base, auth, login, admin: { Authorization: `Bearer ${adminToken}` }, adminToken };
}

// ---------------------------------------------------------------- C1: chave interna + X-Usuario

test("C1: automationFetch envia X-Internal-Key em toda chamada (inclusive health)", async (t) => {
  withEnv(t, { AUTOMATIONS_INTERNAL_KEY: KEY });
  const seen: IncomingMessage["headers"][] = [];
  const py = createServer((req, res) => {
    seen.push(req.headers);
    res.end("{}");
  });
  const base = await listen(py, t);
  await automationFetch(`${base}/api/v1/health`);
  await automationFetch(`${base}/x`, { headers: { "Content-Type": "application/json" }, method: "POST", body: "{}" });
  assert.equal(seen[0]!["x-internal-key"], KEY);
  assert.equal(seen[1]!["x-internal-key"], KEY);
  assert.equal(seen[1]!["content-type"], "application/json");
});

test("C1: X-Usuario URL-encoded só quando há não-ASCII", () => {
  assert.equal(encodeUserHeader("carlos_fin"), "carlos_fin");
  assert.equal(encodeUserHeader("joão"), "jo%C3%A3o");
});

test("C1: baixa Inter leva chave + X-Usuario + X-Request-Id; 409 repassado com mensagem clara", async (t) => {
  withEnv(t, { AUTOMATIONS_INTERNAL_KEY: KEY });
  const seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
  let conflito = false;
  const py = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/health") return res.end("{}");
    if (req.url === "/api/v1/reconciliacao/jobs/baixar") {
      if (conflito) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ detail: "Já existe uma baixa em andamento para a(s) conta(s) #10. Aguarde terminar." }));
      }
      return res.end(JSON.stringify({ job_id: "j1", status: "executando" }));
    }
    if (req.url === "/api/v1/reconciliacao/jobs/j1") return res.end(JSON.stringify({ status: "executando" }));
    res.statusCode = 404;
    res.end("{}");
  });
  const pyBase = await listen(py, t);
  const handler = createReconciliationRoutes({ config: readConfig(), pythonApiUrl: pyBase, jobPollIntervalMs: 60_000 });
  const gw = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://gw");
    void handler({
      request,
      response,
      url,
      path: url.pathname,
      method: request.method ?? "GET",
      ip: "127.0.0.1",
      requestId: "req-123",
      session: { user: { id: 7, nome: "João", username: "joão.fin" } as never, permissions: [] },
      send(status, body) {
        response.statusCode = status;
        response.end(JSON.stringify(body));
        return true;
      },
    });
  });
  const gwBase = await listen(gw, t);
  const body = JSON.stringify({ itens: [{ empresa: "fabrilux", conta_pagar_id: 10, inter_transacao_id: "tx1" }] });
  const ok = await fetch(`${gwBase}/api/reconciliation/jobs/baixar`, { method: "POST", headers: json, body });
  assert.equal(ok.status, 200);
  const call = seen.find((s) => s.url === "/api/v1/reconciliacao/jobs/baixar")!;
  assert.equal(call.headers["x-internal-key"], KEY);
  assert.equal(call.headers["x-usuario"], "jo%C3%A3o.fin");
  assert.equal(call.headers["x-request-id"], "req-123");
  assert.equal(seen.find((s) => s.url === "/api/v1/health")!.headers["x-internal-key"], KEY);

  conflito = true;
  const r = await fetch(`${gwBase}/api/reconciliation/jobs/baixar`, { method: "POST", headers: json, body });
  assert.equal(r.status, 409);
  const err = (await r.json()) as any;
  assert.match(err.detail, /baixa em andamento/);
  assert.equal(err.error, err.detail);
});

test("C1: 401 da automação (chave errada) vira 502 — nunca derruba a sessão do usuário", async () => {
  const handler = createMarketplaceRoutes({
    baseUrl: "http://py:8001",
    fetchImpl: (async () => new Response(JSON.stringify({ detail: "Chave interna ausente ou inválida." }), { status: 401 })) as any,
  });
  const sent: any = {};
  await handler({
    request: (async function* () {})() as any,
    response: {} as any,
    url: new URL("http://gw/api/marketplace/fretes/anuncios"),
    path: "/api/marketplace/fretes/anuncios",
    method: "GET",
    ip: "1",
    send(status: number, b: unknown) {
      sent.status = status;
      sent.body = b;
      return true;
    },
  } as any);
  assert.equal(sent.status, 502);
});

test("C1: marketplace e conciliação ML enviam chave e X-Usuario nas ações do usuário", async (t) => {
  withEnv(t, { AUTOMATIONS_INTERNAL_KEY: KEY });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/health")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ job_id: "x" }), { status: 200 });
  }) as any;
  const mkCtx = (path: string, body: unknown) => ({
    request: (async function* () {
      yield Buffer.from(JSON.stringify(body));
    })() as any,
    response: {} as any,
    url: new URL(`http://gw${path}`),
    path,
    method: "POST",
    ip: "1",
    session: { user: { id: 2, nome: "Ana", username: "ana" } as any, permissions: [] },
    send: () => true as const,
  });
  await createMarketplaceRoutes({ baseUrl: "http://py:8001", fetchImpl })(mkCtx("/api/marketplace/fretes/retentar", { anuncios: [] }) as any);
  const h = calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(h["X-Internal-Key"], KEY);
  assert.equal(h["X-Usuario"], "ana");

  const ml = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl, jobPollIntervalMs: 60_000 });
  await ml(mkCtx("/api/ml-reconciliation/jobs/baixar", { analise_id: "a1", grupos: ["g"] }) as any);
  const mh = calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(calls.at(-1)!.url, "http://py:8000/api/v1/conciliacao-ml/jobs/baixar");
  assert.equal(mh["X-Internal-Key"], KEY);
  assert.equal(mh["X-Usuario"], "ana");
  assert.equal((calls[1]!.init.headers as Record<string, string>)["X-Internal-Key"], KEY, "health também leva a chave");
});

test("Histórico de baixas grava os valores efetivos devolvidos pela automação, não os do cliente", async () => {
  const batches: unknown[][][] = [];
  const pool = {
    getConnection: async () => ({
      batch: async (_o: unknown, rows: unknown[][]) => void batches.push(rows),
      query: async () => [],
      release: () => undefined,
    }),
  } as unknown as Pool;
  const history = createReconciliationHistoryService(readConfig(), pool);
  await history.recordBatch({
    usuarioId: 1,
    usuarioNome: "Ana",
    itens: [{ empresa: "fabrilux", conta_pagar_id: 10, valor_pago: 999999, data_pagamento: "2020-01-01", juros: 5 }],
    resultados: [
      {
        empresa: "fabrilux",
        conta_pagar_id: 10,
        status: "sucesso",
        mensagem: "ok",
        inter_transacao_id: "tx9",
        valor_pago: 150.5,
        data_pagamento: "2026-09-25",
        juros: 0,
        multa: 1,
        desconto: 0,
      },
    ],
  });
  const row = batches[0]![0]!;
  // [lote, uid, nome, empresa, conta, doc, forn, venc, pgto, valor_tiny, valor_pago, juros, multa, desconto, itx, metodo, status, msg]
  assert.equal(row[8], "2026-09-25");
  assert.equal(row[10], 150.5);
  assert.equal(row[11], 0);
  assert.equal(row[12], 1);
  assert.equal(row[14], "tx9");
});

// ---------------------------------------------------------------- GW-04 / GW-14

test("GW-04: X-Forwarded-For só vale vindo de proxy confiável; usa o salto mais à direita", () => {
  const trusted = buildTrustedProxyList(DEFAULT_TRUSTED_PROXIES);
  const req = (remote: string, headers: Record<string, string>) => ({ socket: { remoteAddress: remote }, headers }) as any;
  assert.equal(clientIpFrom(req("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }), trusted), "203.0.113.9");
  assert.equal(clientIpFrom(req("::ffff:10.0.2.2", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), trusted), "198.51.100.7");
  assert.equal(clientIpFrom(req("127.0.0.1", { "x-real-ip": "198.51.100.8" }), trusted), "198.51.100.8");
  assert.equal(clientIpFrom(req("127.0.0.1", {}), trusted), "127.0.0.1");
  assert.equal(clientIpFrom(req("10.0.0.5", { "x-forwarded-for": "1.1.1.1" }), buildTrustedProxyList([])), "10.0.0.5");
});

test("GW-14: CORS só aceita as origens configuradas", () => {
  const origins = ["https://servidor.norvia.example"];
  assert.equal(isAllowedOrigin("https://servidor.norvia.example", origins), true);
  assert.equal(isAllowedOrigin("http://servidor.norvia.example", origins), false);
  assert.equal(isAllowedOrigin("http://192.168.0.10:3000", origins), false);
  assert.equal(isAllowedOrigin("http://localhost:3000", origins), false);
});

// ---------------------------------------------------------------- GW-06 / GW-09

test("GW-06: corpo > 1 MB → 413; corpo sem Content-Type JSON → 415; JSON inválido → 400", async (t) => {
  const { base } = await startApi(t);
  const big = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ x: "a".repeat(1_100_000) }) });
  assert.equal(big.status, 413);
  const txt = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(txt.status, 415);
  const bad = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: "{nope" });
  assert.equal(bad.status, 400);
});

test("GW-09: erro interno devolve mensagem genérica + requestId, sem o detalhe", async (t) => {
  const { base } = await startApi(t, readConfig(), {
    financialDashboard: {
      readStatus: async () => {
        throw new Error("ECONNREFUSED 10.0.0.9:8000 SELECT * FROM segredo");
      },
    },
  });
  const res = await fetch(`${base}/api/financial-dashboard/status`);
  assert.equal(res.status, 500);
  const body = (await res.json()) as any;
  assert.ok(body.requestId);
  assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
  assert.ok(!JSON.stringify(body).includes("segredo"));
});

// ---------------------------------------------------------------- GW-03 / GW-10 / GW-11 / GW-07

test("GW-03: admin vê id público da sessão (não o token) e encerra por ele; banco guarda sha256", async (t) => {
  const { base, admin, adminToken, login } = await startApi(t);
  await fetch(`${base}/api/admin/users`, {
    method: "POST",
    headers: { ...admin, ...json },
    body: JSON.stringify({ nome: "Bia", email: "bia@norvia.example", setor: "Financeiro", senha: "senha-forte-123" }),
  });
  const biaToken = ((await (await login("bia", "senha-forte-123")).json()) as any).token as string;
  const sessions = (await (await fetch(`${base}/api/admin/sessions`, { headers: admin })).json()) as any[];
  for (const s of sessions) {
    assert.match(s.id, /^[a-f0-9]{24}$/);
    assert.notEqual(s.id, biaToken);
    assert.notEqual(s.id, adminToken);
    assert.ok(!biaToken.startsWith(s.id) && !hashSessionToken(biaToken).startsWith(s.id));
  }
  const bia = sessions.find((s) => s.username === "bia")!;
  // Token bruto na URL não encerra nada (não casa com o formato do id público).
  assert.equal((await fetch(`${base}/api/admin/sessions/${biaToken}/force-logout`, { method: "POST", headers: admin })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/sessions/${bia.id}/force-logout`, { method: "POST", headers: admin })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${biaToken}` } })).status, 401);
});

test("GW-10/11: senha mínima, cadastro duplicado neutro, troca de senha derruba as outras sessões", async (t) => {
  const { base, admin, login } = await startApi(t);
  const reg = (senha: string, email = "rui@norvia.example") =>
    fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ nome: "Rui", email, setor: "Financeiro", senha }),
    });
  assert.equal((await reg("curta123")).status, 400);
  const first = await reg("senha-forte-123");
  const dup = await reg("outra-senha-456");
  assert.equal(first.status, 201);
  assert.equal(dup.status, 201);
  assert.deepEqual(await first.json(), await dup.json(), "resposta idêntica para e-mail já cadastrado");
  const users = (await (await fetch(`${base}/api/admin/users`, { headers: admin })).json()) as any[];
  assert.equal(users.filter((u) => u.email === "rui@norvia.example").length, 1);
  const rui = users.find((u) => u.email === "rui@norvia.example")!;
  await fetch(`${base}/api/admin/users/${rui.id}/approve`, { method: "POST", headers: { ...admin, ...json }, body: "{}" });

  const t1 = ((await (await login("rui", "senha-forte-123")).json()) as any).token;
  const t2 = ((await (await login("rui", "senha-forte-123")).json()) as any).token;
  const ch = await fetch(`${base}/api/auth/change-password`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${t1}` },
    body: JSON.stringify({ senhaAtual: "senha-forte-123", novaSenha: "nova-senha-forte-789" }),
  });
  assert.equal(ch.status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${t1}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${t2}` } })).status, 401);
  assert.equal(MIN_PASSWORD_LENGTH, 10);
});

test("GW-10: hash legado (scryptSync) continua válido e pede rehash; formato novo N=2^17", async () => {
  const salt = "abcd";
  const legacy = crypto.scryptSync("senha-antiga-1", salt, 64).toString("hex");
  assert.deepEqual(await verifyPassword("senha-antiga-1", legacy, salt), { ok: true, needsRehash: true });
  assert.equal((await verifyPassword("errada", legacy, salt)).ok, false);
  const { hashPassword } = await import("../src/auth.js");
  const novo = await hashPassword("senha-nova-123");
  assert.match(novo.hash, /^scrypt\$131072\$8\$1\$[0-9a-f]{128}$/);
  assert.deepEqual(await verifyPassword("senha-nova-123", novo.hash, novo.salt), { ok: true, needsRehash: false });
});

test("GW-07: setor é só rótulo — Diretoria aprovada sem setor explícito não ganha acesso a nada", async (t) => {
  const { base, admin, login } = await startApi(t);
  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "Esperto", email: "esperto@norvia.example", setor: "Diretoria", senha: "senha-forte-123" }),
  });
  const users = (await (await fetch(`${base}/api/admin/users`, { headers: admin })).json()) as any[];
  const u = users.find((x) => x.email === "esperto@norvia.example")!;
  const ok = await fetch(`${base}/api/admin/users/${u.id}/approve`, { method: "POST", headers: { ...admin, ...json }, body: "{}" });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).setor, "Diretoria");
  const h = { Authorization: `Bearer ${((await (await login("esperto", "senha-forte-123")).json()) as any).token}` };
  for (const path of ["/api/overview", "/api/accounts-payable/dashboard", "/api/danfe/status", "/api/admin/audit"]) {
    assert.equal((await fetch(`${base}${path}`, { headers: h })).status, 403, path);
  }
});

// ---------------------------------------------------------------- GW-01 / GW-12 / GW-02

test("GW-01: negado por padrão — sem linha 403, com permitido = TRUE libera; admin passa sempre", async (t) => {
  const { base, admin, login } = await startApi(t);
  const created = await fetch(`${base}/api/admin/users`, {
    method: "POST",
    headers: { ...admin, ...json },
    body: JSON.stringify({ nome: "Fin", email: "fin@norvia.example", setor: "Financeiro", senha: "senha-forte-123" }),
  });
  const fin = (await created.json()) as any;
  assert.deepEqual(fin.permissoes, [], "nada nasce marcado");
  const tok = ((await (await login("fin", "senha-forte-123")).json()) as any).token;
  const h = { Authorization: `Bearer ${tok}` };
  assert.equal((await fetch(`${base}/api/accounts-payable/dashboard`, { headers: h })).status, 403);
  const put = await fetch(`${base}/api/admin/users/${fin.id}/permissions`, {
    method: "PUT",
    headers: { ...admin, ...json },
    body: JSON.stringify({ grants: ["contas_pagar:ver"], expectedVersion: 0 }),
  });
  assert.equal(put.status, 200);
  assert.equal((await fetch(`${base}/api/accounts-payable/dashboard`, { headers: h })).status, 200);
  assert.equal((await fetch(`${base}/api/overview`, { headers: h })).status, 403, "outra aba continua negada");
  assert.equal((await fetch(`${base}/api/accounts-payable/dashboard`, { headers: admin })).status, 200);
});

test("GW-12: em live, /api/* não mapeada exige sessão", async (t) => {
  const live = readConfig({ DATA_MODE: "live", DB_HOST: "x", DB_USER: "u", DB_PASSWORD: "p" });
  const { base, admin } = await startApi(t, live);
  assert.equal((await fetch(`${base}/api/qualquer-coisa`)).status, 401);
  assert.equal((await fetch(`${base}/api/qualquer-coisa`, { headers: admin })).status, 404);
});

test("GW-02: com banco configurado e fora do ar, login e sessão respondem 503 (sem memória)", async (t) => {
  withEnv(t, { ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PASS });
  const live = readConfig({ DATA_MODE: "live", DB_HOST: "x", DB_USER: "u", DB_PASSWORD: "p" });
  const pool = { getConnection: async () => Promise.reject(new Error("connect ECONNREFUSED")) } as unknown as Pool;
  const auth = createAuthService(live, pool);
  const demo = createDemo();
  const base = await listen(createApi(live, { dashboard: createDashboardService("demo", demo.database, demo.n8n), auth }), t);
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "admin_jp", senha: ADMIN_PASS }) });
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(await r.json()).includes("ECONNREFUSED"));
  const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${"a".repeat(64)}` } });
  assert.equal(me.status, 503);
});

// ---------------------------------------------------------------- GW-13 / GW-16

test("GW-13: workflowId inválido é recusado", async (t) => {
  const { base, admin } = await startApi(t);
  assert.equal((await fetch(`${base}/api/admin/token-automation?workflowId=../../x`, { headers: admin })).status, 400);
  const r = await fetch(`${base}/api/admin/token-automation/execute`, {
    method: "POST",
    headers: { ...admin, ...json },
    body: JSON.stringify({ workflowId: "abc/../run" }),
  });
  assert.equal(r.status, 400);
});

test("GW-16: INTERNAL_API_KEY confere em tempo constante; incidentes filtrados pela área", async (t) => {
  const cfg = { ...readConfig(), internalApiKey: "chave-interna-gateway" };
  const incidents = createIncidentService(cfg, undefined);
  const { base, admin, login } = await startApi(t, cfg, { incidents });
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const withKey = (h: Record<string, string> = {}) => ({ ...h, "X-API-Key": "chave-interna-gateway" });
  // Admin cria um operador de Logística e reporta um incidente do Financeiro.
  await fetch(`${base}/api/admin/users`, {
    method: "POST",
    headers: withKey({ ...admin, ...json }),
    body: JSON.stringify({ nome: "Log", email: "log@norvia.example", setor: "Logística", senha: "senha-forte-123" }),
  });
  void login;
  const logTok = ((await (
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: withKey(json),
      body: JSON.stringify({ login: "log", senha: "senha-forte-123" }),
    })
  ).json()) as any).token;
  const rep = await fetch(`${base}/api/incidents`, {
    method: "POST",
    headers: withKey({ ...admin, ...json }),
    body: JSON.stringify({ executionId: "e1", automationId: "danfe-tiny" }),
  });
  assert.equal(rep.status, 201);
  const forAdmin = (await (await fetch(`${base}/api/incidents`, { headers: withKey(admin) })).json()) as any[];
  const forLog = (await (await fetch(`${base}/api/incidents`, { headers: withKey({ Authorization: `Bearer ${logTok}` }) })).json()) as any[];
  assert.equal(forAdmin.length, 1);
  assert.equal(forLog.length, 0);
});

test("GW-16: login_falhou não grava o texto digitado quando não é um usuário existente", async (t) => {
  const entries: any[] = [];
  const audit = { record: async (e: any) => void entries.push(e), list: async () => [], bootstrap: async () => undefined } as any;
  const { login } = await startApi(t, readConfig(), { audit });
  await login("minhaSenhaSecreta", "x");
  await login("admin_jp", "errada-mesmo");
  const falhas = entries.filter((e) => e.acao === "login_falhou");
  assert.equal(falhas[0].actorLabel, "Não identificado");
  assert.equal(falhas[0].alvo, undefined);
  assert.equal(falhas[1].alvo, "admin_jp");
});

test("SEC-01: NODE_ENV=production sem DATA_MODE não sobe (sem fail-open para demo)", () => {
  assert.throws(() => readConfig({ NODE_ENV: "production" }), /DATA_MODE obrigatório/);
  assert.throws(() => readConfig({ NODE_ENV: "production", DATA_MODE: " " }), /DATA_MODE obrigatório/);
  assert.equal(readConfig({ NODE_ENV: "production", DATA_MODE: "demo" }).mode, "demo");
  assert.equal(readConfig({}).mode, "demo");
});

test("SEC-01: em demo, ação sem token exige sessão; leitura segue liberada", async (t) => {
  const { base, admin } = await startApi(t, readConfig({}));
  for (const path of ["/api/ml-reconciliation/jobs/baixar", "/api/reconciliation/baixar", "/api/marketplace/fretes/executar"]) {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: json, body: "{}" });
    assert.equal(r.status, 401, path);
  }
  assert.equal((await fetch(`${base}/api/accounts-payable/dashboard`)).status, 200);
  // Com sessão a ação chega na rota (sem automação no ar, o erro é do upstream, não 401).
  const r = await fetch(`${base}/api/ml-reconciliation/jobs/baixar`, { method: "POST", headers: { ...json, ...admin }, body: "{}" });
  assert.notEqual(r.status, 401);
});

test("SEC-04: conciliação ML e dashboard financeiro têm permissão própria (ver ≠ ação)", async (t) => {
  const { base, admin, login } = await startApi(t);
  const created = await fetch(`${base}/api/admin/users`, {
    method: "POST",
    headers: { ...admin, ...json },
    body: JSON.stringify({
      nome: "Fin",
      email: "fin@norvia.example",
      setor: "Financeiro",
      senha: "senha-forte-123",
      grants: ["contas_pagar:ver", "conciliacao_ml:ver"],
    }),
  });
  assert.equal(created.status, 201);
  const h = { Authorization: `Bearer ${((await (await login("fin", "senha-forte-123")).json()) as any).token}` };
  assert.notEqual((await fetch(`${base}/api/ml-reconciliation/status`, { headers: h })).status, 403);
  // Ver a aba não dá a ação: a baixa da conciliação ML exige conciliacao_ml:baixar.
  const baixa = await fetch(`${base}/api/ml-reconciliation/jobs/baixar`, { method: "POST", headers: { ...h, ...json }, body: "{}" });
  assert.equal(baixa.status, 403);
  assert.equal(((await baixa.json()) as any).permission, "conciliacao_ml:baixar");
  assert.equal((await fetch(`${base}/api/financial-dashboard/status`, { headers: h })).status, 403);
  // Rota inexistente sob uma aba: negada por padrão (sem mapeamento), mesmo com sessão.
  assert.equal((await fetch(`${base}/api/financial-dashboard/summary`, { headers: h })).status, 404);
});
