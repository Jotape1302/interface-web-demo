import test from "node:test";
import assert from "node:assert/strict";
import { routeAccess } from "../src/permissions.js";
import { createMlReconciliationRoutes } from "../src/routes/ml-reconciliation.js";
import { checkAutomationAlerts } from "../src/marketplace-alerts.js";
import { mlReconciliationCheck, type MlReconciliationStatus } from "../src/system-health.js";

function ctx(path: string, method: string, body?: Buffer | unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://gw${path}`);
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
  const sent: { status?: number; body?: any; raw?: Buffer; headers: Record<string, string> } = { headers: {} };
  const request = (async function* () {
    yield* chunks;
  })() as any;
  request.headers = headers;
  return {
    sent,
    ctx: {
      request,
      response: {
        statusCode: 0,
        setHeader(k: string, v: string) {
          sent.headers[k.toLowerCase()] = v;
        },
        end(buf: Buffer) {
          sent.status = this.statusCode;
          sent.raw = buf;
        },
      } as any,
      url,
      path: url.pathname,
      method,
      ip: "10.0.0.1",
      session: { user: { id: 5, nome: "Fin" } as any, permissions: [] },
      send(status: number, b: unknown) {
        sent.status = status;
        sent.body = b;
        return true;
      },
    },
  };
}

function fakePython(handlers: Record<string, (init: RequestInit) => Response>) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/api/v1/health")) return new Response("{}", { status: 200 });
    chamadas.push({ url, init });
    const path = url.replace("http://py:8000", "");
    const h = handlers[`${init.method ?? "GET"} ${path}`];
    return h ? h(init) : new Response(JSON.stringify({ detail: "nao achou" }), { status: 404 });
  }) as any;
  return { chamadas, fetchImpl };
}

test("rotas da conciliação Mercado Livre exigem a aba Conciliação ML", () => {
  assert.deepEqual(routeAccess("POST", "/api/ml-reconciliation/tokens/sincronizar"), { kind: "perm", key: "conciliacao_ml:executar" });
  assert.deepEqual(routeAccess("POST", "/api/ml-reconciliation/executar"), { kind: "perm", key: "conciliacao_ml:executar" });
  assert.deepEqual(routeAccess("POST", "/api/ml-reconciliation/jobs/baixar"), { kind: "perm", key: "conciliacao_ml:baixar" });
  assert.deepEqual(routeAccess("GET", "/api/ml-reconciliation/status"), { kind: "perm", key: "conciliacao_ml:ver" });
});

async function esperar(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

test("execução manual é repassada com o período e o resultado vai para a auditoria", async () => {
  const auditados: any[] = [];
  let consultas = 0;
  const py = fakePython({
    "POST /api/v1/conciliacao-ml/executar": () => new Response(JSON.stringify({ job_id: "e1", status: "executando" }), { status: 200 }),
    "GET /api/v1/conciliacao-ml/jobs/e1": () => {
      consultas += 1;
      const job = consultas < 2 ? { status: "executando" } : { status: "concluido", resultado: { status: "parcial" } };
      return new Response(JSON.stringify(job), { status: 200 });
    },
  });
  const handler = createMlReconciliationRoutes({
    pythonApiUrl: "http://py:8000",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: py.fetchImpl,
    jobPollIntervalMs: 5,
  });

  const c = ctx("/api/ml-reconciliation/executar", "POST", { de: "2025-09-01", ate: "2025-09-02", empresas: ["revesta"], extra: 1 });
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 200);
  assert.deepEqual(JSON.parse(String(py.chamadas[0]!.init.body)), { empresas: ["revesta"], de: "2025-09-01", ate: "2025-09-02" });

  await esperar(() => auditados.length > 0);
  assert.equal(auditados[0].acao, "conciliacao_ml_executada");
  assert.deepEqual(auditados[0].detalhes, { empresas: ["revesta"], de: "2025-09-01", ate: "2025-09-02", status: "parcial" });
  assert.equal(auditados[0].sucesso, false);
  assert.equal(auditados[0].actor.nome, "Fin");
});

test("execução recusada pelo Python (409) não é acompanhada", async () => {
  const auditados: any[] = [];
  const py = fakePython({
    "POST /api/v1/conciliacao-ml/executar": () => new Response(JSON.stringify({ detail: "em andamento" }), { status: 409 }),
  });
  const handler = createMlReconciliationRoutes({
    pythonApiUrl: "http://py:8000",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: py.fetchImpl,
    jobPollIntervalMs: 5,
  });
  const c = ctx("/api/ml-reconciliation/executar", "POST", {});
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 409);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(auditados.length, 0);
});

test("status, histórico e análises repassam a query para o Python", async () => {
  const py = fakePython({
    "GET /api/v1/conciliacao-ml/status": () => new Response(JSON.stringify({ empresas: [] }), { status: 200 }),
    "GET /api/v1/conciliacao-ml/execucoes?limit=5&tipo=baixa": () => new Response(JSON.stringify({ itens: [], total: 0 }), { status: 200 }),
    "GET /api/v1/conciliacao-ml/execucoes/abc123": () => new Response(JSON.stringify({ id: "abc123", log: [] }), { status: 200 }),
    "GET /api/v1/conciliacao-ml/analises?empresa=revesta": () => new Response(JSON.stringify({ itens: [{ analise_id: "a1" }] }), { status: 200 }),
  });
  const handler = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: py.fetchImpl });
  for (const [path, campo] of [
    ["/api/ml-reconciliation/status", "empresas"],
    ["/api/ml-reconciliation/execucoes?limit=5&tipo=baixa", "itens"],
    ["/api/ml-reconciliation/execucoes/abc123", "log"],
    ["/api/ml-reconciliation/analises?empresa=revesta", "itens"],
  ] as const) {
    const c = ctx(path, "GET");
    await handler(c.ctx as any);
    assert.equal(c.sent.status, 200, path);
    assert.ok(campo in c.sent.body, path);
  }
});

test("baixa leva o usuário da sessão, é acompanhada até o fim e vai para a auditoria", async () => {
  const auditados: any[] = [];
  let consultas = 0;
  const py = fakePython({
    "POST /api/v1/conciliacao-ml/jobs/baixar": () => new Response(JSON.stringify({ job_id: "b1", status: "executando" }), { status: 200 }),
    "GET /api/v1/conciliacao-ml/jobs/b1": () => {
      consultas += 1;
      const job =
        consultas < 2
          ? { job_id: "b1", status: "executando" }
          : { job_id: "b1", status: "concluido", resultado: { total_sucessos: 2, total_falhas: 0, total_ignorados: 1 } };
      return new Response(JSON.stringify(job), { status: 200 });
    },
  });
  const handler = createMlReconciliationRoutes({
    pythonApiUrl: "http://py:8000",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: py.fetchImpl,
    jobPollIntervalMs: 5,
  });

  const c = ctx("/api/ml-reconciliation/jobs/baixar", "POST", { analise_id: "a1", grupos: ["G-1", "G-2", "G-3"], usuario: "forjado" });
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 200);
  assert.deepEqual(JSON.parse(String(py.chamadas[0]!.init.body)), { analise_id: "a1", grupos: ["G-1", "G-2", "G-3"], usuario: "Fin" });

  await esperar(() => auditados.length > 0);
  assert.equal(auditados[0].acao, "baixa_conciliacao_ml_executada");
  assert.deepEqual(auditados[0].detalhes, { recebimentos: 3, sucessos: 2, falhas: 0, ignorados: 1 });
  assert.equal(auditados[0].sucesso, true);
});

test("JSON inválido volta 400 sem chamar o Python", async () => {
  const py = fakePython({});
  const handler = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: py.fetchImpl });
  const c = ctx("/api/ml-reconciliation/executar", "POST", Buffer.from("{nao"));
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 400);
  assert.equal(py.chamadas.length, 0);
});

test("avisos da conciliação notificam só quem vê a Conciliação ML e os admins, com link para a tela", async () => {
  const notificados: Array<{ id: number; link?: string }> = [];
  const users = [
    { id: 1, status: "approved", setor: "Marketing", role: "user", permissoes: ["conciliacao_ml:ver"] },
    { id: 2, status: "approved", setor: "Financeiro", role: "user", permissoes: ["contas_pagar:ver"] },
    { id: 3, status: "approved", setor: "TI", role: "admin" },
  ] as any[];
  const cursor = { ultimoId: 0 as number | null };
  const n = await checkAutomationAlerts({
    permissionFor: () => "conciliacao_ml:ver",
    linkFor: () => "/conciliacao-mercado-livre",
    readAvisos: async () => ({ itens: [{ id: 1, tipo: "conciliacao_ml_pronta", titulo: "Pronta", criado_em: new Date().toISOString() }], ultimo_id: 1 }),
    listUsers: async () => users,
    notify: async (id, data) => void notificados.push({ id, link: data.link }),
    cursor,
  });
  assert.equal(n, 1);
  assert.deepEqual(notificados.map((x) => x.id).sort(), [1, 3]);
  assert.equal(notificados[0]!.link, "/conciliacao-mercado-livre");
  assert.equal(cursor.ultimoId, 1);
});

test("mlReconciliationCheck: sem execução, falha parcial, token ausente e atraso", async () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const base: MlReconciliationStatus = {
    empresas: [
      { id: "norvia_campinas", nome: "Norvia Campinas", conexoes: { mercado_pago: true, mercado_livre: true, tiny: true } },
      { id: "revesta", nome: "Revesta", conexoes: { mercado_pago: false, mercado_livre: true, tiny: true } },
    ],
    em_execucao: null,
    ultima_execucao: null,
    erro_gravacao: null,
  };
  const run = (s: MlReconciliationStatus) => mlReconciliationCheck(async () => s, () => now).run();

  let r = await run(base);
  assert.equal(r.state, "warning");
  assert.equal(r.details!.find((d) => d.label === "Revesta")!.value, "Sem token: Mercado Pago");

  const ultima = (status: "ok" | "parcial" | "erro", concluida_em = "2026-10-05T11:00:00Z") => ({
    concluida_em,
    status,
    empresas: { norvia_campinas: { status: "ok" }, revesta: { status: status === "ok" ? "ok" : "erro", mensagem: "HTTP 500" } },
  });
  r = await run({ ...base, ultima_execucao: ultima("ok") });
  assert.equal(r.state, "ok");
  r = await run({ ...base, ultima_execucao: ultima("parcial") });
  assert.equal(r.state, "warning");
  assert.equal(r.details!.find((d) => d.label === "Revesta")!.value, "HTTP 500");
  r = await run({ ...base, ultima_execucao: ultima("erro") });
  assert.equal(r.state, "error");
  r = await run({ ...base, ultima_execucao: ultima("ok", "2026-10-04T08:00:00Z") });
  assert.equal(r.state, "warning");
  assert.match(r.message, /26 horas/);
  r = await run({ ...base, ultima_execucao: ultima("ok"), erro_gravacao: "estado.json: Permission denied" });
  assert.equal(r.state, "error");
});

test("download da planilha repassa o binário e o nome do arquivo", async () => {
  const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const py = fakePython({
    "GET /api/v1/conciliacao-ml/analises/a1/arquivos/lancamentos": () =>
      new Response(xlsx, {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": "attachment; filename*=UTF-8''LAN.xlsx",
        },
      }),
  });
  const handler = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: py.fetchImpl });
  const c = ctx("/api/ml-reconciliation/analises/a1/arquivos/lancamentos", "GET");
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 200);
  assert.deepEqual(c.sent.raw, xlsx);
  assert.equal(c.sent.headers["content-disposition"], "attachment; filename*=UTF-8''LAN.xlsx");
});

test("análise expirada devolve o 404 do Python e caminho desconhecido não vaza para outras rotas", async () => {
  const py = fakePython({});
  const handler = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: py.fetchImpl });
  const c = ctx("/api/ml-reconciliation/analises/zzz", "GET");
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 404);

  const outro = ctx("/api/reconciliation/status", "GET");
  assert.equal(await handler(outro.ctx as any), false);
});

test("SA-08: sincronizar tokens - upstream com token_prefixo tem resposta e auditoria sem ele", async () => {
  const auditados: any[] = [];
  const py = fakePython({
    "POST /api/v1/conciliacao-ml/tokens/sincronizar": () =>
      new Response(
        JSON.stringify({
          ok: true,
          mock: true,
          contas: {
            norvia: { conectado: true, renovado: true, token_prefixo: "APP_USR-secret" },
            revesta: { conectado: true, renovado: false, motivo: "TMS offline", token_prefixo: "APP_USR-secret2" },
          },
          tokens_atualizados: ["norvia"],
        }),
        { status: 200 },
      ),
  });
  const handler = createMlReconciliationRoutes({
    pythonApiUrl: "http://py:8000",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: py.fetchImpl,
  });

  const c = ctx("/api/ml-reconciliation/tokens/sincronizar", "POST");
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 200);
  assert.equal(c.sent.body.ok, true);
  assert.equal(c.sent.body.mock, true);
  assert.deepEqual(c.sent.body.tokens_atualizados, ["norvia"]);
  // Verifica que token_prefixo foi removido do payload de resposta
  assert.equal((c.sent.body.contas.norvia as any).token_prefixo, undefined);
  assert.equal((c.sent.body.contas.revesta as any).token_prefixo, undefined);
  assert.equal(c.sent.body.contas.revesta.motivo, "TMS offline");

  // Verifica que auditoria não contém token_prefixo
  await esperar(() => auditados.length > 0);
  assert.equal(auditados[0].acao, "sincronizacao_tokens_ml_solicitada");
  assert.equal(auditados[0].detalhes.ok, true);
  assert.deepEqual(auditados[0].detalhes.tokens_atualizados, ["norvia"]);
  assert.deepEqual(auditados[0].detalhes.contas, {
    norvia: { conectado: true, renovado: true },
    revesta: { conectado: true, renovado: false },
  });
  assert.equal(JSON.stringify(auditados[0]).includes("APP_USR"), false);
});

test("SA-08: sincronizar tokens - upstream 500 com detalhe devolve erro generico sem vazar detalhe", async () => {
  const py = fakePython({
    "POST /api/v1/conciliacao-ml/tokens/sincronizar": () =>
      new Response(JSON.stringify({ detail: "Internal error: secret_key leaked in stack trace", erro_id: "err-abc-123" }), {
        status: 500,
      }),
  });
  const handler = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: py.fetchImpl });
  const c = ctx("/api/ml-reconciliation/tokens/sincronizar", "POST");
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 502);
  assert.equal(c.sent.body.erro_id, "err-abc-123");
  assert.equal(c.sent.body.error.includes("secret_key"), false);
  assert.equal(c.sent.body.detail.includes("secret_key"), false);
  assert.equal(c.sent.body.error, "Falha na sincronização de tokens de conciliação.");
});

test("SA-08: sincronizar tokens - upstream 429 repassa status e mensagem de cooldown", async () => {
  const py = fakePython({
    "POST /api/v1/conciliacao-ml/tokens/sincronizar": () =>
      new Response(JSON.stringify({ detail: "Aguarde 45 segundos antes de tentar novamente." }), { status: 429 }),
  });
  const handler = createMlReconciliationRoutes({ pythonApiUrl: "http://py:8000", fetchImpl: py.fetchImpl });
  const c = ctx("/api/ml-reconciliation/tokens/sincronizar", "POST");
  await handler(c.ctx as any);
  assert.equal(c.sent.status, 429);
  assert.equal(c.sent.body.error, "Aguarde 45 segundos antes de tentar novamente.");
  assert.equal(c.sent.body.detail, "Aguarde 45 segundos antes de tentar novamente.");
});

