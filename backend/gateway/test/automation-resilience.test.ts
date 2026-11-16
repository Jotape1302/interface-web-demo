import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { createDanfeService } from "../src/danfe.js";
import { createStockTinyClient } from "../src/stock-tiny.js";
import { createFinancialDashboardRoutes } from "../src/routes/financial-dashboard.js";
import {
  AUTOMATION_DEFAULT_TIMEOUT_MS,
  AUTOMATION_URL_TTL_MS,
  automationFetch,
  callAutomation,
  createAutomationUrlResolver,
} from "../src/automation-http.js";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../src/circuit-breaker.js";

const json = { "Content-Type": "application/json" };

// ------------------------------------------------------------------ GW-01: resolvedor de URL

test("GW-01: a URL ativa fica 60 s memorizada, sem GET /health a cada chamada", async () => {
  const health: string[] = [];
  let agora = 1_000_000;
  const fetchImpl = (async (url: string) => {
    health.push(url);
    return new Response("{}", { status: url.startsWith("http://a") ? 503 : 200 });
  }) as unknown as typeof fetch;
  const resolve = createAutomationUrlResolver(["http://a:8000", "http://b:8000"], fetchImpl, { now: () => agora });

  assert.equal(await resolve(), "http://b:8000");
  assert.equal(health.length, 2, "a 1ª resolução sonda a e depois b");
  for (let i = 0; i < 5; i++) assert.equal(await resolve(), "http://b:8000");
  assert.equal(health.length, 2, "dentro do TTL não há nova sondagem");

  resolve.invalidate();
  await resolve();
  assert.equal(health.length, 3, "após invalidar, sonda de novo (começa pela ativa)");

  agora += AUTOMATION_URL_TTL_MS + 1;
  await resolve();
  assert.equal(health.length, 4, "passado o TTL, revalida");
});

test("GW-01: se nenhum candidato responde devolve o último que funcionou, sem memorizar", async () => {
  let chamadas = 0;
  const fetchImpl = (async () => {
    chamadas++;
    throw new Error("conexão recusada");
  }) as unknown as typeof fetch;
  const resolve = createAutomationUrlResolver(["http://a:8000", "http://b:8000"], fetchImpl);
  assert.equal(await resolve(), "http://a:8000");
  const apos1 = chamadas;
  await resolve();
  assert.ok(chamadas > apos1, "sem sucesso, cada chamada tenta de novo");
});

// ------------------------------------------------------------------ GW-04: timeout padrão

test("GW-04: automationFetch aplica timeout de 30 s só quando a chamada não traz signal", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const vistos: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    vistos.push(init?.signal);
    return new Response("{}");
  }) as unknown as typeof fetch;

  await automationFetch("http://x/a");
  assert.ok(vistos[0] instanceof AbortSignal, "sem signal, entra o timeout padrão");
  assert.equal(vistos[0]!.aborted, false);
  assert.equal(AUTOMATION_DEFAULT_TIMEOUT_MS, 30_000);

  const meu = new AbortController();
  await automationFetch("http://x/b", { signal: meu.signal });
  assert.equal(vistos[1], meu.signal, "o signal do chamador é preservado");
});

// ------------------------------------------------------------------ GW-05 / GW-09: breaker

test("GW-05: callAutomation conta 5xx e rede como falha, mas 4xx não", async (t) => {
  t.after(() => resetAllCircuitBreakers());
  const nome = "teste-4xx";
  for (let i = 0; i < 10; i++) {
    const res = await callAutomation(nome, async () => new Response("{}", { status: 422 }));
    assert.equal(res.status, 422);
  }
  assert.equal(getCircuitBreaker(nome).getState(), "closed", "10 respostas 4xx não abrem o circuito");

  for (let i = 0; i < 5; i++) {
    const res = await callAutomation(nome, async () => new Response("{}", { status: 500 }));
    assert.equal(res.status, 500, "a resposta 5xx ainda chega ao chamador");
  }
  assert.equal(getCircuitBreaker(nome).getState(), "open");
  await assert.rejects(callAutomation(nome, async () => new Response("{}")), CircuitBreakerOpenError);
});

test("GW-05: erro de conexão invalida a URL memorizada", async (t) => {
  t.after(() => resetAllCircuitBreakers());
  let invalidada = 0;
  await assert.rejects(
    callAutomation(
      "teste-rede",
      async () => {
        throw new TypeError("fetch failed");
      },
      { invalidate: () => invalidada++ },
    ),
    /fetch failed/,
  );
  assert.equal(invalidada, 1);
});

test("GW-09: em half_open só uma chamada de teste por vez; getState não tem efeito colateral", async () => {
  const b = new CircuitBreaker({ name: "probe", failureThreshold: 1, resetTimeoutMs: 20, successThreshold: 1 });
  await assert.rejects(b.execute(async () => Promise.reject(new Error("x"))), /x/);
  assert.equal(b.getState(), "open");
  await new Promise((r) => setTimeout(r, 30));

  const antes = b.getStats().lastStateChange;
  assert.equal(b.getState(), "half_open");
  assert.equal(b.getState(), "half_open");
  assert.equal(b.getStats().lastStateChange, antes, "ler o estado não muda o breaker");

  let liberar!: () => void;
  const primeira = b.execute(() => new Promise<string>((r) => (liberar = () => r("ok"))));
  await assert.rejects(b.execute(async () => "segunda"), CircuitBreakerOpenError, "2ª chamada enquanto o teste corre");
  liberar();
  assert.equal(await primeira, "ok");
  assert.equal(b.getState(), "closed");
});

// ------------------------------------------------------------------ servidor de teste

async function listen(server: ReturnType<typeof createServer>, t: { after(fn: () => unknown): void }) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  return `http://127.0.0.1:${a.port}`;
}

/** Motor financeiro falso: /health ok; demais rotas devolvem o que `respond` decidir. */
async function fakeFinanceiro(
  t: { after(fn: () => unknown): void },
  respond: (req: IncomingMessage, body: string) => { status: number; body?: unknown },
) {
  const chamadas: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => {
      const body = Buffer.concat(partes).toString();
      if (req.url === "/api/v1/health") {
        res.setHeader("Content-Type", "application/json");
        return res.end("{}");
      }
      chamadas.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const r = respond(req, body);
      res.statusCode = r.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  return { base: await listen(server, t), chamadas };
}

async function startApiComDanfe(t: any, danfeUrl: string, extra: { limiteProxyMs?: number } = {}) {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = "test-admin-bootstrap-password";
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
    resetAllCircuitBreakers();
  });
  const config = readConfig({});
  const auth = createAuthService(config);
  await auth.bootstrap();
  const demo = createDemo();
  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth,
    danfe: createDanfeService("live", danfeUrl),
    ...extra,
  });
  const base = await listen(server, t);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ login: "admin_jp", senha: "test-admin-bootstrap-password" }),
  });
  const token = ((await login.json()) as any).token as string;
  return { base, headers: { ...json, Authorization: `Bearer ${token}` } };
}

// ------------------------------------------------------------------ rotas da DANFE (upstream mockado)

test("rotas DANFE: scan-sefaz, process-batch, archive e restore repassam ao motor com chave e autor", async (t) => {
  const prev = process.env.AUTOMATIONS_INTERNAL_KEY;
  process.env.AUTOMATIONS_INTERNAL_KEY = "k".repeat(40);
  t.after(() => {
    if (prev === undefined) delete process.env.AUTOMATIONS_INTERNAL_KEY;
    else process.env.AUTOMATIONS_INTERNAL_KEY = prev;
  });
  const motor = await fakeFinanceiro(t, (req) => {
    if (req.url?.startsWith("/api/v1/danfe/scan-sefaz")) return { status: 200, body: { total_novas_notas: 3, cnpjs: [] } };
    if (req.url === "/api/v1/danfe/process-batch") return { status: 200, body: { total: 2, success_count: 1, failed_count: 1, results: [] } };
    if (req.url === "/api/v1/danfe/archive") return { status: 200, body: { chave: "41260", status: "arquivada" } };
    if (req.url === "/api/v1/danfe/restore") return { status: 200, body: { chave: "41260", status: "pendente" } };
    return { status: 404 };
  });
  const { base, headers } = await startApiComDanfe(t, motor.base);

  const scan = await fetch(`${base}/api/danfe/scan-sefaz`, { method: "POST", headers });
  assert.equal(scan.status, 200);
  assert.equal(((await scan.json()) as any).total_novas_notas, 3);

  const form = "--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.xml\"\r\n\r\n<x/>\r\n--b--\r\n";
  const lote = await fetch(`${base}/api/danfe/process-batch`, {
    method: "POST",
    headers: { Authorization: headers.Authorization, "Content-Type": "multipart/form-data; boundary=b" },
    body: form,
  });
  assert.equal(lote.status, 200);
  assert.equal(((await lote.json()) as any).success_count, 1);
  const chamadaLote = motor.chamadas.find((c) => c.url === "/api/v1/danfe/process-batch")!;
  assert.equal(chamadaLote.body, form);
  assert.match(String(chamadaLote.headers["content-type"]), /multipart\/form-data/);

  const arq = await fetch(`${base}/api/danfe/archive`, { method: "POST", headers, body: JSON.stringify({ chave: "41260" }) });
  assert.equal(arq.status, 200);
  const sem = await fetch(`${base}/api/danfe/archive`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(sem.status, 422);
  const rest = await fetch(`${base}/api/danfe/restore`, { method: "POST", headers, body: JSON.stringify({ chave: "41260" }) });
  assert.equal(rest.status, 200);
  assert.equal(((await rest.json()) as any).status, "pendente");

  for (const c of motor.chamadas) {
    assert.equal(c.headers["x-internal-key"], "k".repeat(40));
    assert.equal(c.headers["x-usuario"], "admin_jp");
  }
});

test("rotas DANFE: 4xx do motor volta como erro tratado e não abre o circuito", async (t) => {
  const motor = await fakeFinanceiro(t, () => ({ status: 409, body: { detail: "Nota já arquivada" } }));
  const { base, headers } = await startApiComDanfe(t, motor.base);
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/api/danfe/archive`, { method: "POST", headers, body: JSON.stringify({ chave: "1" }) });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as any).error, /Nota já arquivada/);
  }
  assert.equal(getCircuitBreaker("financeiro").getState(), "closed");
});

test("GW-05: 5xx repetido do motor abre o circuito 'financeiro' e a rota responde 503 sem chamar o upstream", async (t) => {
  const motor = await fakeFinanceiro(t, () => ({ status: 500, body: { detail: "boom" } }));
  const { base, headers } = await startApiComDanfe(t, motor.base);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${base}/api/danfe/archive`, { method: "POST", headers, body: JSON.stringify({ chave: "1" }) });
    assert.equal(r.status, 502);
  }
  const antes = motor.chamadas.length;
  const aberto = await fetch(`${base}/api/danfe/archive`, { method: "POST", headers, body: JSON.stringify({ chave: "1" }) });
  assert.equal(aberto.status, 503);
  assert.equal(((await aberto.json()) as any).code, "circuit_open");
  assert.equal(motor.chamadas.length, antes, "com o circuito aberto o motor nem é chamado");
});

// ------------------------------------------------------------------ stock-tiny

test("stock-tiny: consultar/ajustar passam pelo breaker, memorizam a URL e tratam 4xx sem abrir o circuito", async (t) => {
  t.after(() => resetAllCircuitBreakers());
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.endsWith("/api/v1/health")) return new Response("{}");
    if (url.includes("/estoque/consultar")) {
      return new Response(JSON.stringify({ sku: "A1", id_produto: 1, produto: "Prod", unidade: "UN", deposito: null, saldo: 4, aviso: null }));
    }
    if (url.endsWith("/estoque/ajustar")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ detail: "SKU sem produto" }), { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const client = createStockTinyClient({ baseUrl: "http://contagem.test:8002", fetchImpl });

  assert.equal((await client.consultar("A1")).saldo, 4);
  await client.consultar("A1");
  assert.equal(urls.filter((u) => u.endsWith("/api/v1/health")).length, 1, "um único /health para duas consultas");

  for (let i = 0; i < 6; i++) {
    await assert.rejects(
      client.ajustar({ registro_id: "r", sku: "A1", quantidade: 1, numero: 1, criado_em: "2026-10-27T00:00:00Z" }),
      (e: any) => e.status === 404 && /SKU sem produto/.test(e.message),
    );
  }
  assert.equal(getCircuitBreaker("contagem-estoque").getState(), "closed");
});

// ------------------------------------------------------------------ financial-dashboard: force

test("dashboard financeiro: sync?force=true sem a permissão de forçar responde 403 sem chamar o motor", async () => {
  let sincronizou = false;
  const handler = createFinancialDashboardRoutes({
    financialDashboard: {
      async readStatus() {
        throw new Error("n/a");
      },
      async sync() {
        sincronizou = true;
        return {} as any;
      },
      async readDashboard() {
        throw new Error("n/a");
      },
    },
  });
  let enviado: { status: number; body: any } | undefined;
  const ctx: any = {
    path: "/api/financial-dashboard/sync",
    method: "POST",
    url: new URL("http://gw/api/financial-dashboard/sync?force=true"),
    session: { user: { id: 3, nome: "Fin" }, permissions: ["dashboard_financeiro:ver"] },
    send(status: number, body: any) {
      enviado = { status, body };
      return true;
    },
  };
  await handler(ctx);
  assert.equal(enviado?.status, 403);
  assert.equal(enviado?.body.permission, "dashboard_financeiro:forcar_sincronizacao");
  assert.equal(sincronizou, false);

  ctx.session.permissions.push("dashboard_financeiro:forcar_sincronizacao");
  await handler(ctx);
  assert.equal(sincronizou, true);
});

test("NGINX que desiste da requisição lenta vira erro no log para os agentes Qwen (504 do lote, 12/11)", async (t) => {
  const lento = createServer((req, res) => {
    if (req.url === "/api/v1/health") return res.end("{}");
    req.resume();
    req.on("end", () => setTimeout(() => res.end(JSON.stringify({ total: 0, items: [] })), 400));
  });
  const motor = await listen(lento, t);
  const { base, headers } = await startApiComDanfe(t, motor, { limiteProxyMs: 100 });
  const erros: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void erros.push(a.map(String).join(" "));
  t.after(() => {
    console.error = original;
  });

  // O "NGINX" (aqui o próprio fetch) desiste antes de o motor responder.
  const corpo = new FormData();
  corpo.append("files", new Blob(["%PDF"]), "a.pdf");
  await assert.rejects(
    fetch(`${base}/api/danfe/process-batch`, {
      method: "POST",
      headers: { Authorization: headers.Authorization },
      body: corpo,
      signal: AbortSignal.timeout(200),
    }),
  );
  await new Promise((r) => setTimeout(r, 50));
  const log = erros.map((e) => JSON.parse(e)).find((e) => e.event === "proxy_timeout_error");
  assert.ok(log, `sem proxy_timeout_error no log: ${erros.join("\n")}`);
  assert.equal(log.method, "POST");
  assert.equal(log.path, "/api/danfe/process-batch");
  assert.equal(log.name, "TempoEsgotadoNoProxy");
  assert.match(log.message, /HTTP 504/);
});

test("navegador que desiste antes do limite do NGINX não vira erro", async (t) => {
  const lento = createServer((req, res) => {
    if (req.url === "/api/v1/health") return res.end("{}");
    req.resume();
    req.on("end", () => setTimeout(() => res.end("{}"), 300));
  });
  const motor = await listen(lento, t);
  const { base, headers } = await startApiComDanfe(t, motor, { limiteProxyMs: 10_000 });
  const erros: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void erros.push(a.map(String).join(" "));
  t.after(() => {
    console.error = original;
  });
  const corpo = new FormData();
  corpo.append("files", new Blob(["%PDF"]), "a.pdf");
  await assert.rejects(
    fetch(`${base}/api/danfe/process-batch`, {
      method: "POST",
      headers: { Authorization: headers.Authorization },
      body: corpo,
      signal: AbortSignal.timeout(100),
    }),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(erros.filter((e) => e.includes("proxy_timeout_error")), []);
});
