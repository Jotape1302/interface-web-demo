import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { createAuthService } from "../src/auth.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createAreaOverviewService, type AreaOverviewDeps } from "../src/area-overview.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const ADMIN_PASS = "test-admin-bootstrap-password";
const PASS = "senha-forte-123";
const json = { "Content-Type": "application/json" };
const todas = () => true;

const pendingReview = { total: 4, pending: [{ staged_at: "2026-10-25T10:00:00Z" }] };
const historico = {
  history: [
    { audit_status: "error", processed_at: "2026-10-26T10:00:00Z", resolved_at: null },
    { audit_status: "error", processed_at: "2026-10-20T10:00:00Z", resolved_at: "2026-10-21T10:00:00Z" },
    { audit_status: "success", processed_at: "2026-10-26T11:00:00Z" },
  ],
};
const sefaz = { last_scan_finished_at: "2026-10-27T10:00:00Z", cnpjs: [], certificados: [{ arquivo: "a.pfx", titular: "Fabrilux", dias_restantes: 5, alerta: true, erro: null }] };

function respostas(over: Record<string, unknown | Error> = {}) {
  const calls: string[] = [];
  const base: Record<string, unknown> = {
    "/api/v1/danfe/pending-review": pendingReview,
    "/api/v1/danfe/history?limit=1000": historico,
    "/api/v1/danfe/sefaz-status": sefaz,
    "/api/v1/reconciliacao/estado": { atualizado_em: "2026-10-27T09:00:00Z", summary: { total_casados: 0 } },
    "/api/v1/reconciliacao/status": { empresas: [{ nome: "Fabrilux", inter_status: "conectado" }] },
    "/api/v1/conciliacao-ml/status": {
      empresas: [{ id: "h", nome: "Fabrilux", conexoes: { mercado_pago: false, mercado_livre: true, tiny: true }, ultima_analise: { criada_em: "2026-10-26T10:00:00Z", resumo: { aptos_baixa: 9 } } }],
      ultima_execucao: { concluida_em: "2026-10-27T05:00:00Z", status: "ok", empresas: {} },
    },
    "/api/v1/financial-dashboard/status": { last_sync_finished_at: "2026-10-25T05:00:00Z", companies: [{ account_id: "h", ok: true }] },
    ...over,
  };
  const fetchFinanceiro = async (path: string) => {
    calls.push(path);
    const v = base[path];
    if (v instanceof Error) throw v;
    return v;
  };
  return { fetchFinanceiro, calls };
}

function deps(over: Partial<AreaOverviewDeps> = {}, resp = respostas()): AreaOverviewDeps {
  return {
    mode: "live",
    fetchFinanceiro: resp.fetchFinanceiro,
    history: {
      list: async (q) => ({
        disponivel: true,
        itens: [],
        total: q.status?.[0] === "erro" ? 2 : q.status?.[0] === "sucesso" ? 30 : 0,
        page: 1,
        pageSize: q.pageSize,
      }),
    },
    checkTiny: () => ({ connected: true, message: "ok" }),
    checkDatabase: () => ({ connected: true, message: "ok" }),
    clock: () => NOW,
    ...over,
  };
}

test("financeiro: pendências ordenadas crítica → atenção, quantidade desc, sem itens zerados", async () => {
  const v = await createAreaOverviewService(deps()).read("financeiro", todas);
  const sev = v.acoesPendentes.map((a) => a.severidade);
  const rank = { critica: 0, atencao: 1, info: 2 } as const;
  assert.deepEqual(sev, [...sev].sort((a, b) => rank[a] - rank[b]));
  const criticas = v.acoesPendentes.filter((a) => a.severidade === "critica");
  for (let i = 1; i < criticas.length; i++) assert.ok((criticas[i - 1]!.quantidade ?? 0) >= (criticas[i]!.quantidade ?? 0));
  assert.ok(v.acoesPendentes.every((a) => a.quantidade !== 0), "nenhum item com quantidade 0");
  const ids = v.acoesPendentes.map((a) => a.id);
  assert.ok(ids.includes("nfe-categorizar") && ids.includes("nfe-falhas") && ids.includes("cert-a1-critico") && ids.includes("ml-tokens") && ids.includes("baixas-erro"));
  assert.ok(!ids.includes("pagar-aptos"), "total_casados 0 não vira item");
  assert.ok(ids.includes("dash-sync-parada"), "sem sincronizar há mais de 1 dia");
  const nfe = v.acoesPendentes.find((a) => a.id === "nfe-categorizar")!;
  assert.equal(nfe.quantidade, 4);
  assert.equal(nfe.severidade, "atencao");
  assert.equal(nfe.href, "/danfe-tiny");
  assert.equal(v.acoesPendentes.find((a) => a.id === "nfe-falhas")!.quantidade, 1, "falha já resolvida não conta");
  assert.deepEqual(v.automacoes.map((a) => a.id), ["danfe-tiny", "accounts-payable", "conciliacao-ml", "dashboard-financeiro"]);
  assert.ok(v.servicos.some((s) => s.id === "inter" && s.conectado));
  assert.ok(v.servicos.some((s) => s.id === "mercado-livre" && !s.conectado));
});

test("filtro por permissão: sem revisao_nfe:ver não vê pendência nem automação de NF-e", async () => {
  const svc = createAreaOverviewService(deps());
  const v = await svc.read("financeiro", (p) => p !== "revisao_nfe:ver");
  assert.ok(!v.acoesPendentes.some((a) => a.automacao === "danfe-tiny"));
  assert.ok(!v.automacoes.some((a) => a.id === "danfe-tiny"));
  assert.ok(v.acoesPendentes.some((a) => a.automacao === "conciliacao-ml"));
});

test("fonte que falha vai para indisponiveis sem derrubar o resto (e só para quem vê a aba)", async () => {
  const resp = respostas({ "/api/v1/conciliacao-ml/status": new Error("segredo interno 10.0.0.5") });
  const svc = createAreaOverviewService(deps({}, resp));
  const v = await svc.read("financeiro", todas);
  assert.equal(v.indisponiveis.length, 1);
  assert.equal(v.indisponiveis[0]!.fonte, "Conciliação Mercado Livre");
  assert.ok(!JSON.stringify(v.indisponiveis).includes("segredo"), "não vaza detalhe do upstream");
  assert.ok(v.acoesPendentes.some((a) => a.id === "nfe-categorizar"));
  assert.equal(v.automacoes.find((a) => a.id === "conciliacao-ml")!.status, "sem_dados");
  const semMl = await createAreaOverviewService(deps({}, resp)).read("financeiro", (p) => p !== "conciliacao_ml:ver");
  assert.deepEqual(semMl.indisponiveis, []);
});

test("cache de 30 s por área com dedupe de leituras simultâneas; filtro vem depois do cache", async () => {
  let agora = NOW.getTime();
  const resp = respostas();
  const svc = createAreaOverviewService(deps({ clock: () => new Date(agora) }, resp));
  await Promise.all([svc.read("financeiro", todas), svc.read("financeiro", todas)]);
  const nfeCalls = () => resp.calls.filter((c) => c === "/api/v1/danfe/pending-review").length;
  assert.equal(nfeCalls(), 1, "leituras simultâneas compartilham a consulta");
  const outro = await svc.read("financeiro", (p) => p === "dashboard_financeiro:ver");
  assert.equal(nfeCalls(), 1, "outro usuário reaproveita o cache");
  assert.ok(outro.acoesPendentes.every((a) => a.automacao === "dashboard-financeiro"));
  agora += 29_000;
  await svc.read("financeiro", todas);
  assert.equal(nfeCalls(), 1);
  agora += 2_000;
  await svc.read("financeiro", todas);
  assert.equal(nfeCalls(), 2, "após 30 s consulta de novo");
});

test("logística: contagens pendentes e envios com erro; marketplace: dimensões, fretes e token", async () => {
  const log = await createAreaOverviewService(
    deps({
      readContagens: async () => ({ total: 10, aguardando: 3, semSku: 0, semEnvio: 0, envioErro: 2, lancadas: 5, ultimaEm: "2026-10-27T10:00:00Z", maisAntigaAguardando: null }),
    }),
  ).read("logistica", todas);
  assert.deepEqual(log.acoesPendentes.map((a) => a.id), ["contagem-envio-erro", "contagem-aguardando"]);
  assert.equal(log.acoesPendentes[0]!.severidade, "critica");

  const mkt = await createAreaOverviewService(
    deps({
      fetchMarketplace: async (path) =>
        path.includes("dimensoes")
          ? { total_produtos: 10, por_status: { pendente: 4, bloqueado: 2 }, com_erro_de_envio: 1, ultima_execucao: { concluida_em: "2026-10-27T08:00:00Z", status: "ok" } }
          : { total_anuncios: 50, contagem: { a_combinar: 6, falha: 2 }, aguardando_conferencia: 3, contas: { g: { rotulo: "Campinas", conectada: false } } },
    }),
  ).read("marketplace", todas);
  const ids = mkt.acoesPendentes.map((a) => a.id);
  for (const id of ["dimensoes-confirmar", "dimensoes-erro", "dimensoes-bloqueado", "fretes-a-combinar", "fretes-falha", "fretes-conferencia", "ml-token-desconectado"]) assert.ok(ids.includes(id), id);
  assert.equal(mkt.acoesPendentes[0]!.severidade, "critica");
  assert.ok(mkt.servicos.some((s) => s.id === "mercado-livre" && !s.conectado));
});

test("produção: automação sem dados e nenhuma pendência", async () => {
  const v = await createAreaOverviewService(deps()).read("producao", todas);
  assert.deepEqual(v.acoesPendentes, []);
  assert.equal(v.automacoes[0]!.status, "sem_dados");
});

test("demo: devolve dados coerentes sem chamar upstream", async () => {
  const v = await createAreaOverviewService({ mode: "demo", clock: () => NOW }).read("financeiro", todas);
  assert.ok(v.acoesPendentes.length >= 3);
  assert.deepEqual(v.indisponiveis, []);
});

// ------------------------------------------------------------------ HTTP (RBAC por área)

async function startApi(t: any) {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = ADMIN_PASS;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
  });
  const config = readConfig();
  const auth = createAuthService(config);
  await auth.bootstrap();
  const demo = createDemo();
  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth,
    areaOverview: createAreaOverviewService({ mode: "demo", clock: () => NOW }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  const base = `http://127.0.0.1:${a.port}`;
  const login = async (l: string, senha: string) => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: l, senha }) });
    return { Authorization: `Bearer ${((await res.json()) as any).token}` };
  };
  const admin = await login("admin_jp", ADMIN_PASS);
  const mk = async (username: string, grants: string[]) => {
    const res = await fetch(`${base}/api/admin/users`, {
      method: "POST",
      headers: { ...admin, ...json },
      body: JSON.stringify({ nome: username, username, email: `${username}@norvia.example`, setor: "Financeiro", senha: PASS, role: "user", grants }),
    });
    assert.equal(res.status, 201);
    return login(username, PASS);
  };
  return { base, admin, mk };
}

test("rota: 403 sem a aba Visão geral da área; 200 com ela; itens filtrados pela aba de origem", async (t) => {
  const { base, admin, mk } = await startApi(t);
  const sem = await mk("sem.grants", []);
  const soLog = await mk("so.log", ["log_visao_geral:ver"]);
  const fin = await mk("fin.nfe", ["fin_visao_geral:ver", "contas_pagar:ver"]);
  for (const area of ["financeiro", "logistica", "marketplace", "producao"]) {
    const r = await fetch(`${base}/api/areas/${area}/visao-geral`, { headers: sem });
    assert.equal(r.status, 403, area);
    assert.equal(((await r.json()) as any).permission, `${{ financeiro: "fin", logistica: "log", marketplace: "mkt", producao: "prod" }[area]}_visao_geral:ver`);
  }
  assert.equal((await fetch(`${base}/api/areas/financeiro/visao-geral`, { headers: soLog })).status, 403, "visão de outra área não vale");
  const l = await fetch(`${base}/api/areas/logistica/visao-geral`, { headers: soLog });
  assert.equal(l.status, 200);
  const logBody = (await l.json()) as any;
  assert.equal(logBody.area, "logistica");
  assert.deepEqual(logBody.acoesPendentes, [], "sem contagem_estoque:ver não vê a pendência de contagem");
  const f = (await (await fetch(`${base}/api/areas/financeiro/visao-geral`, { headers: fin })).json()) as any;
  assert.ok(f.acoesPendentes.length > 0);
  assert.ok(f.acoesPendentes.every((a: any) => a.automacao === "accounts-payable"));
  assert.ok(!f.acoesPendentes.some((a: any) => a.automacao === "danfe-tiny"), "sem revisao_nfe:ver");
  const a = await fetch(`${base}/api/areas/financeiro/visao-geral`, { headers: admin });
  assert.ok(((await a.json()) as any).acoesPendentes.some((x: any) => x.automacao === "danfe-tiny"));
  assert.equal((await fetch(`${base}/api/areas/financeiro/visao-geral`, { method: "POST", headers: { ...admin, ...json }, body: "{}" })).status, 404, "POST sem regra: negado por padrão");
});

test("conciliação ML: pendências recalculadas prevalecem sobre o resumo congelado e criam 'não exportados'", async () => {
  const resp = respostas({
    "/api/v1/conciliacao-ml/pendencias": {
      empresas: [{ id: "h", nome: "Fabrilux", analise_criada_em: "2026-10-26T10:00:00Z", aptos_baixa: 2, lancamentos_nao_exportados: 7 }],
    },
    "/api/v1/reconciliacao/estado": { atualizado_em: "2026-10-27T09:00:00Z", summary: { total_casados: 3, total_transferencias_aptas: 1 } },
  });
  const v = await createAreaOverviewService(deps({}, resp)).read("financeiro", todas);
  const aptos = v.acoesPendentes.find((a) => a.id === "ml-aptos")!;
  assert.equal(aptos.quantidade, 2, "usa o recalculado (2), não o resumo da análise (9)");
  const exp = v.acoesPendentes.find((a) => a.id === "ml-nao-exportados")!;
  assert.equal(exp.quantidade, 7);
  assert.equal(exp.acao, "Exportar planilha");
  const pagar = v.acoesPendentes.find((a) => a.id === "pagar-aptos")!;
  assert.equal(pagar.quantidade, 4, "casados + transferências aptas");
  assert.match(pagar.descricao, /conferida/);
});

test("conciliação ML: sem a fonte de pendências cai no resumo da análise", async () => {
  const resp = respostas({ "/api/v1/conciliacao-ml/pendencias": new Error("fora") });
  const v = await createAreaOverviewService(deps({}, resp)).read("financeiro", todas);
  assert.equal(v.acoesPendentes.find((a) => a.id === "ml-aptos")!.quantidade, 9);
  assert.ok(!v.acoesPendentes.some((a) => a.id === "ml-nao-exportados"));
});
