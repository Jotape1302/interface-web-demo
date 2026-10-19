import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService, createAuthStore, type AuthStore } from "../src/auth.js";
import {
  ALL_PERMISSION_KEYS,
  MANAGER_ONLY_KEYS,
  PERMISSION_CATALOG,
  ROUTE_RULES,
  effectivePermissions,
  hasPermission,
  validateGrants,
} from "../src/permissions.js";

// Matriz papel (admin/gestor/user) × rota × ação do RBAC por usuário.

const ADMIN_PASS = "test-admin-bootstrap-password";
const PASS = "senha-forte-123";
const json = { "Content-Type": "application/json" };

async function startApi(t: any, opts: { store?: AuthStore; extra?: Record<string, unknown> } = {}) {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = ADMIN_PASS;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
  });
  const config = readConfig();
  const store = opts.store ?? createAuthStore(config);
  const auth = createAuthService(config, undefined, { store });
  await auth.bootstrap();
  const published: Array<[unknown, string]> = [];
  const events = {
    publish: (target: unknown, type: string) => void published.push([target, type]),
    attach: () => () => undefined,
    closeAll: () => undefined,
    connectionCount: () => 0,
  };
  const demo = createDemo();
  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth,
    events: events as any,
    ...(opts.extra ?? {}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  const base = `http://127.0.0.1:${a.port}`;

  const login = async (l: string, senha = PASS) => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: l, senha }) });
    assert.equal(res.status, 200, `login ${l}`);
    return { Authorization: `Bearer ${((await res.json()) as any).token}` };
  };
  const admin = await login("admin_jp", ADMIN_PASS);
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? h : { ...h, ...json },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** Cria (como admin) e devolve { id, h } já logado. */
  const mk = async (username: string, role: "admin" | "gestor" | "user", grants: string[] = [], setor = "Financeiro") => {
    const res = await call(admin, "POST", "/api/admin/users", {
      nome: username.toUpperCase(),
      username,
      email: `${username}@norvia.example`,
      setor,
      senha: PASS,
      role,
      grants,
    });
    assert.equal(res.status, 201, `criar ${username}: ${await res.clone().text()}`);
    const u = (await res.json()) as any;
    return { id: u.id as number, h: await login(username) };
  };
  return { base, auth, store, admin, login, call, mk, published };
}

const GESTOR_GRANTS = [
  "contas_pagar:ver",
  "contas_pagar:baixar",
  "usuarios:ver",
  "usuarios:criar",
  "usuarios:aprovar_cadastro",
  "usuarios:editar_permissoes",
  "usuarios:alterar_setor",
  "usuarios:excluir",
  "usuarios:derrubar_sessao",
  "usuarios:revisar_alteracao",
];

// ------------------------------------------------------------------- unidades

test("catálogo: chaves '<aba>:<acao>', todas com ':', únicas e sem colidir com as legadas", () => {
  const legadas = ["overview", "accounts_payable", "danfe_tiny", "ml_reconciliation", "financial_dashboard"];
  assert.equal(new Set(ALL_PERMISSION_KEYS).size, ALL_PERMISSION_KEYS.length);
  for (const k of ALL_PERMISSION_KEYS) {
    assert.match(k, /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    assert.ok(k.length <= 100);
    assert.ok(!legadas.includes(k));
  }
  for (const t of PERMISSION_CATALOG.tabs) assert.equal(t.actions[0]!.id, "ver", `${t.id} começa por ver`);
  assert.deepEqual(
    MANAGER_ONLY_KEYS.map((k) => k.split(":")[0]),
    MANAGER_ONLY_KEYS.map(() => "usuarios"),
  );
  const risco = PERMISSION_CATALOG.tabs.flatMap((t) => t.actions.filter((a) => a.risk === "force").map((a) => a.key));
  assert.deepEqual(risco, ["revisao_nfe:forcar_varredura", "dashboard_financeiro:forcar_sincronizacao"]);
  // Toda chave exigida por rota existe no catálogo.
  for (const r of ROUTE_RULES) if (r.access.kind === "perm") assert.ok(ALL_PERMISSION_KEYS.includes(r.access.key), r.access.key);
});

test("hasPermission: negado por padrão; admin passa; linha legada e chave de gestor em user não valem", () => {
  const user = { user: { role: "user" }, permissions: ["contas_pagar:ver"] };
  assert.equal(hasPermission(user, "contas_pagar:ver"), true);
  assert.equal(hasPermission(user, "contas_pagar:baixar"), false);
  assert.equal(hasPermission({ user: { role: "user" }, permissions: [] }, "contas_pagar:ver"), false);
  assert.equal(hasPermission({ user: { role: "user" }, permissions: ["accounts_payable"] }, "accounts_payable"), false);
  assert.equal(hasPermission({ user: { role: "user" }, permissions: ["usuarios:ver"] }, "usuarios:ver"), false);
  assert.equal(hasPermission({ user: { role: "gestor" }, permissions: ["usuarios:ver"] }, "usuarios:ver"), true);
  assert.equal(hasPermission({ user: { role: "admin" }, permissions: [] }, "revisao_nfe:forcar_varredura"), true);
  assert.deepEqual(effectivePermissions("admin", []), [...ALL_PERMISSION_KEYS]);
  assert.deepEqual(effectivePermissions("user", ["accounts_payable", "usuarios:ver", "erros:ver"]), ["erros:ver"]);
});

test("validateGrants: fora do catálogo, gestão de usuários em user e ação sem ver → erro", () => {
  assert.deepEqual(validateGrants(["contas_pagar:baixar", "contas_pagar:ver"], "user"), {
    ok: true,
    grants: ["contas_pagar:ver", "contas_pagar:baixar"],
  });
  assert.equal((validateGrants(["accounts_payable"], "user") as any).code, "unknown_permission");
  assert.equal((validateGrants(["xyz:ver"], "user") as any).code, "unknown_permission");
  assert.equal((validateGrants(["usuarios:ver"], "user") as any).code, "manager_only_permission");
  assert.equal(validateGrants(["usuarios:ver"], "gestor").ok, true);
  assert.equal((validateGrants(["contas_pagar:baixar"], "user") as any).code, "action_requires_view");
  assert.equal((validateGrants("contas_pagar:ver", "user") as any).code, "invalid_grants");
  // Saúde, Auditoria, Erros & Falhas e Tokens n8n podem ser dados a User.
  assert.equal(validateGrants(["saude:ver", "auditoria:ver", "erros:ver", "erros:resolver", "tokens_n8n:ver", "tokens_n8n:executar"], "user").ok, true);
});

// ------------------------------------------------------------------- rotas

test("toda rota mapeada a uma aba × ação nega (403) quem não tem a chave; admin não é barrado", async (t) => {
  const { call, mk, admin } = await startApi(t);
  const semNada = await mk("sem.nada", "user");
  for (const r of ROUTE_RULES) {
    if (r.access.kind !== "perm" && r.access.kind !== "admin") continue;
    const res = await call(semNada.h, r.method, r.sample, r.method === "GET" ? undefined : {});
    assert.equal(res.status, 403, `${r.method} ${r.sample} sem a chave`);
    const body = (await res.json()) as any;
    assert.equal(body.code, "forbidden", `${r.method} ${r.sample}`);
    if (r.access.kind === "perm") assert.equal(body.permission ?? r.access.key, r.access.key);
  }
  // Admin passa pela checagem (leituras locais, sem chamadas externas).
  for (const path of ["/api/accounts-payable/dashboard", "/api/admin/users", "/api/admin/sessions", "/api/admin/pending-count"]) {
    assert.equal((await call(admin, "GET", path)).status, 200, path);
  }
});

test("linha permitido = TRUE libera exatamente a aba/ação; Saúde/Auditoria/Tokens podem ser dados a User", async (t) => {
  const { call, mk } = await startApi(t);
  const u = await mk("ops", "user", ["contas_pagar:ver", "saude:ver", "auditoria:ver", "tokens_n8n:ver"]);
  assert.equal((await call(u.h, "GET", "/api/accounts-payable/dashboard")).status, 200);
  assert.notEqual((await call(u.h, "GET", "/api/admin/audit")).status, 403);
  assert.notEqual((await call(u.h, "GET", "/api/admin/system-health")).status, 403);
  assert.equal((await call(u.h, "GET", "/api/admin/token-automation")).status, 200);
  assert.equal((await call(u.h, "POST", "/api/admin/token-automation/execute", {})).status, 403);
  assert.equal((await call(u.h, "POST", "/api/reconciliation/baixar", {})).status, 403);
  assert.equal((await call(u.h, "GET", "/api/admin/users")).status, 403);
});

test("forçar varredura SEFAZ / sincronização sem a ação → 403; com a ação → passa", async (t) => {
  const calls: string[] = [];
  const { call, mk } = await startApi(t, {
    extra: {
      danfe: { scanSefaz: async (_c: unknown, o: { force: boolean }) => (calls.push(`scan:${o.force}`), { ok: true }) },
      financialDashboard: { sync: async (_c: unknown, o: { force: boolean }) => (calls.push(`sync:${o.force}`), { ok: true }) },
    },
  });
  const u = await mk("nfe", "user", ["revisao_nfe:ver", "revisao_nfe:varrer_sefaz", "dashboard_financeiro:ver", "dashboard_financeiro:sincronizar"]);
  assert.equal((await call(u.h, "POST", "/api/danfe/scan-sefaz")).status, 200);
  const f1 = await call(u.h, "POST", "/api/danfe/scan-sefaz?force=true");
  assert.equal(f1.status, 403);
  assert.equal(((await f1.json()) as any).permission, "revisao_nfe:forcar_varredura");
  assert.equal((await call(u.h, "POST", "/api/financial-dashboard/sync")).status, 200);
  assert.equal((await call(u.h, "POST", "/api/financial-dashboard/sync?force=1")).status, 403);
  assert.deepEqual(calls, ["scan:false", "sync:false"]);

  const f = await mk("nfe.forte", "user", [
    "revisao_nfe:ver",
    "revisao_nfe:varrer_sefaz",
    "revisao_nfe:forcar_varredura",
    "dashboard_financeiro:ver",
    "dashboard_financeiro:sincronizar",
    "dashboard_financeiro:forcar_sincronizacao",
  ]);
  assert.equal((await call(f.h, "POST", "/api/danfe/scan-sefaz?force=true")).status, 200);
  assert.equal((await call(f.h, "POST", "/api/financial-dashboard/sync?force=true")).status, 200);
});

// ------------------------------------------------------------------- Gestão de Usuários

test("Gestor: edita Users dentro do teto; fora do teto (conceder ou revogar) → 403 com os itens", async (t) => {
  const { call, mk, published } = await startApi(t);
  const g = await mk("gestor", "gestor", GESTOR_GRANTS);
  const u = await mk("user.a", "user", ["contas_pagar:ver"]);
  const v = await mk("user.b", "user", ["revisao_nfe:ver", "contas_pagar:ver"]);

  const st = (await (await call(g.h, "GET", `/api/admin/users/${u.id}/permissions`)).json()) as any;
  assert.deepEqual(st.grants, ["contas_pagar:ver"]);
  const ok = await call(g.h, "PUT", `/api/admin/users/${u.id}/permissions`, {
    grants: ["contas_pagar:ver", "contas_pagar:baixar"],
    expectedVersion: st.version,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as any).grants, ["contas_pagar:ver", "contas_pagar:baixar"]);
  assert.ok(published.some(([to, type]) => to === u.id && type === "session"), "evento SSE de sessão para o alvo");

  const cur = (await (await call(g.h, "GET", `/api/admin/users/${u.id}/permissions`)).json()) as any;
  const conceder = await call(g.h, "PUT", `/api/admin/users/${u.id}/permissions`, {
    grants: ["contas_pagar:ver", "revisao_nfe:ver"],
    expectedVersion: cur.version,
  });
  assert.equal(conceder.status, 403);
  const cb = (await conceder.json()) as any;
  assert.equal(cb.code, "outside_ceiling");
  assert.deepEqual(cb.items, ["revisao_nfe:ver"]);

  // Revogar o que o Gestor não tem também é proibido (B.1).
  const vs = (await (await call(g.h, "GET", `/api/admin/users/${v.id}/permissions`)).json()) as any;
  const revogar = await call(g.h, "PUT", `/api/admin/users/${v.id}/permissions`, { grants: ["contas_pagar:ver"], expectedVersion: vs.version });
  assert.equal(revogar.status, 403);
  assert.deepEqual(((await revogar.json()) as any).items, ["revisao_nfe:ver"]);
  // Mexer só no que tem, preservando o que não tem: ok.
  const parcial = await call(g.h, "PUT", `/api/admin/users/${v.id}/permissions`, {
    grants: ["revisao_nfe:ver", "contas_pagar:ver", "contas_pagar:baixar"],
    expectedVersion: vs.version,
  });
  assert.equal(parcial.status, 200);
});

test("Gestor sobre Admin/Gestor → 403 (permissões, setor, exclusão, sessões); sessões deles nem aparecem", async (t) => {
  const { call, mk, admin } = await startApi(t);
  const g = await mk("gestor", "gestor", GESTOR_GRANTS);
  const g2 = await mk("gestor2", "gestor", ["usuarios:ver"]);
  const a2 = await mk("admin2", "admin");
  for (const alvo of [g2.id, a2.id, 1]) {
    const st = (await (await call(admin, "GET", `/api/admin/users/${alvo}/permissions`)).json()) as any;
    const r = [
      await call(g.h, "PUT", `/api/admin/users/${alvo}/permissions`, { grants: [], expectedVersion: st.version }),
      await call(g.h, "PUT", `/api/admin/users/${alvo}/setor`, { setor: "RH" }),
      await call(g.h, "DELETE", `/api/admin/users/${alvo}`),
      await call(g.h, "POST", `/api/admin/users/${alvo}/force-logout`),
    ];
    for (const res of r) assert.equal(res.status, 403, `alvo ${alvo}`);
  }
  const sessions = (await (await call(g.h, "GET", "/api/admin/sessions")).json()) as any[];
  assert.ok(sessions.length > 0);
  assert.ok(sessions.every((s) => s.role === "user" || s.usuario_id === g.id), "sem sessões de Admin/Gestor de terceiros");
  const adminSessions = (await (await call(admin, "GET", "/api/admin/sessions")).json()) as any[];
  const sessA2 = adminSessions.find((s) => s.usuario_id === a2.id)!;
  assert.equal((await call(g.h, "POST", `/api/admin/sessions/${sessA2.id}/force-logout`)).status, 403);
  // Perfil: só Admin.
  assert.equal((await call(g.h, "PUT", `/api/admin/users/${g2.id}/role`, { role: "user" })).status, 403);
});

test("Gestor cria só User dentro do teto; aprova cadastro com permissões; ação não concedida → 403", async (t) => {
  const { base, call, mk } = await startApi(t);
  const g = await mk("gestor", "gestor", GESTOR_GRANTS);
  const novo = (extra: Record<string, unknown>) =>
    call(g.h, "POST", "/api/admin/users", { nome: "Novo", email: `n${Math.random()}@norvia.example`, setor: "SAC", senha: PASS, ...extra });
  assert.equal((await novo({ role: "gestor" })).status, 403);
  assert.equal((await novo({ role: "admin" })).status, 403);
  const fora = await novo({ grants: ["revisao_nfe:ver"] });
  assert.equal(fora.status, 403);
  assert.equal(((await fora.json()) as any).code, "outside_ceiling");
  const mo = await novo({ grants: ["usuarios:ver"] });
  assert.equal(mo.status, 400, "chave de Gestão de Usuários em User");
  assert.equal(((await mo.json()) as any).code, "manager_only_permission");
  const ok = await novo({ grants: ["contas_pagar:ver"] });
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as any).role, "user");

  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "Cadastro", email: "cad@norvia.example", setor: "Vendas", senha: PASS }),
  });
  const pend = ((await (await call(g.h, "GET", "/api/admin/users")).json()) as any[]).find((u) => u.email === "cad@norvia.example")!;
  assert.equal(pend.permissions_count.tabs, 0);
  assert.equal((await call(g.h, "POST", `/api/admin/users/${pend.id}/reject`)).status, 403, "sem usuarios:rejeitar_cadastro");
  assert.equal((await call(g.h, "POST", `/api/admin/users/${pend.id}/approve`, { grants: ["erros:ver"] })).status, 403);
  const ap = await call(g.h, "POST", `/api/admin/users/${pend.id}/approve`, { grants: ["contas_pagar:ver"] });
  assert.equal(ap.status, 200);
  assert.deepEqual(((await ap.json()) as any).grants, ["contas_pagar:ver"]);
});

test("Admin: chave de Gestão de Usuários em User → 400 (edição, aprovação, criação); fora do catálogo → 400", async (t) => {
  const { base, call, mk, admin } = await startApi(t);
  const u = await mk("user.a", "user");
  const st = (await (await call(admin, "GET", `/api/admin/users/${u.id}/permissions`)).json()) as any;
  const r1 = await call(admin, "PUT", `/api/admin/users/${u.id}/permissions`, { grants: ["usuarios:ver"], expectedVersion: st.version });
  assert.equal(r1.status, 400);
  assert.equal(((await r1.json()) as any).field, "grants");
  const r2 = await call(admin, "POST", "/api/admin/users", {
    nome: "X",
    email: "x@norvia.example",
    setor: "RH",
    senha: PASS,
    grants: ["usuarios:excluir", "usuarios:ver"],
  });
  assert.equal(r2.status, 400);
  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "Cad", email: "cad@norvia.example", setor: "Vendas", senha: PASS }),
  });
  const pend = ((await (await call(admin, "GET", "/api/admin/users")).json()) as any[]).find((x) => x.email === "cad@norvia.example")!;
  const r3 = await call(admin, "POST", `/api/admin/users/${pend.id}/approve`, { grants: ["usuarios:ver"] });
  assert.equal(r3.status, 400);
  assert.equal(((await (await call(admin, "GET", "/api/admin/users")).json()) as any[]).find((x) => x.id === pend.id).status, "pending", "400 não aprova");

  for (const grants of [["accounts_payable"], ["nada:ver"], ["contas_pagar:ver", "contas_pagar:apagar_tudo"]]) {
    const r = await call(admin, "PUT", `/api/admin/users/${u.id}/permissions`, { grants, expectedVersion: st.version });
    assert.equal(r.status, 400, JSON.stringify(grants));
    assert.equal(((await r.json()) as any).code, "unknown_permission");
  }
  // Aprovar/criar sem nenhuma permissão é permitido.
  const sem = await call(admin, "POST", `/api/admin/users/${pend.id}/approve`, {});
  assert.equal(sem.status, 200);
  assert.deepEqual(((await sem.json()) as any).grants, []);
});

test("conflito de versão → 409 com o estado atual; expectedVersion obrigatório", async (t) => {
  const { call, mk, admin } = await startApi(t);
  const u = await mk("user.a", "user");
  const st = (await (await call(admin, "GET", `/api/admin/users/${u.id}/permissions`)).json()) as any;
  assert.equal((await call(admin, "PUT", `/api/admin/users/${u.id}/permissions`, { grants: ["erros:ver"] })).status, 400);
  assert.equal(
    (await call(admin, "PUT", `/api/admin/users/${u.id}/permissions`, { grants: ["erros:ver"], expectedVersion: st.version })).status,
    200,
  );
  const stale = await call(admin, "PUT", `/api/admin/users/${u.id}/permissions`, { grants: ["saude:ver"], expectedVersion: st.version });
  assert.equal(stale.status, 409);
  const body = (await stale.json()) as any;
  assert.equal(body.code, "version_conflict");
  assert.deepEqual(body.current.grants, ["erros:ver"]);
  assert.equal(body.current.version, st.version + 1);
  assert.equal(body.current.updatedByName, "Autor");
  assert.ok(body.current.updatedAt);
});

test("autoalteração: perfil e permissões próprios → 403; setor próprio (Admin) pode", async (t) => {
  const { call, mk, admin } = await startApi(t);
  const a2 = await mk("admin2", "admin");
  const g = await mk("gestor", "gestor", GESTOR_GRANTS);
  const r1 = await call(a2.h, "PUT", `/api/admin/users/${a2.id}/role`, { role: "user" });
  assert.equal(r1.status, 403);
  assert.equal(((await r1.json()) as any).code, "self_change");
  const gs = (await (await call(admin, "GET", `/api/admin/users/${g.id}/permissions`)).json()) as any;
  const r2 = await call(g.h, "PUT", `/api/admin/users/${g.id}/permissions`, { grants: GESTOR_GRANTS, expectedVersion: gs.version });
  assert.equal(r2.status, 403);
  assert.equal(((await r2.json()) as any).code, "self_change");
  assert.equal((await call(a2.h, "DELETE", `/api/admin/users/${a2.id}`)).status, 403);
  assert.equal((await call(a2.h, "POST", `/api/admin/users/${a2.id}/force-logout`)).status, 403);
  assert.equal((await call(a2.h, "PUT", `/api/admin/users/${a2.id}/setor`, { setor: "Diretoria" })).status, 200);
  assert.equal((await call(admin, "PUT", "/api/admin/users/1/setor", { setor: "T.I" })).status, 200, "ROOT altera o próprio setor");
});

test("ROOT intocável por outro Admin: perfil, exclusão, setor, sessões (inclusive force-logout)", async (t) => {
  const { call, mk, admin } = await startApi(t);
  const a2 = await mk("admin2", "admin");
  const r = await call(a2.h, "PUT", "/api/admin/users/1/role", { role: "user" });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as any).code, "root_protected");
  assert.equal((await call(a2.h, "DELETE", "/api/admin/users/1")).status, 403);
  assert.equal((await call(a2.h, "PUT", "/api/admin/users/1/setor", { setor: "RH" })).status, 403);
  assert.equal((await call(a2.h, "POST", "/api/admin/users/1/force-logout")).status, 403);
  const sessoes = (await (await call(a2.h, "GET", "/api/admin/sessions")).json()) as any[];
  const raiz = sessoes.find((s) => s.usuario_id === 1)!;
  assert.equal(raiz.is_root, true);
  assert.equal((await call(a2.h, "POST", `/api/admin/sessions/${raiz.id}/force-logout`)).status, 403);
  assert.equal((await call(admin, "GET", "/api/auth/me")).status, 200, "sessão do ROOT continua");
  const lista = (await (await call(a2.h, "GET", "/api/admin/users")).json()) as any[];
  const root = lista.find((u) => u.id === 1)!;
  assert.equal(root.is_root, true);
  assert.equal(typeof root.version, "number");
  assert.deepEqual(root.permissions_count, {
    tabs: PERMISSION_CATALOG.tabs.length,
    actions: ALL_PERMISSION_KEYS.length - PERMISSION_CATALOG.tabs.length,
  });
});

test("perfil: Admin rebaixado começa sem nada e perde o poder na hora; Gestor → User perde Gestão de Usuários", async (t) => {
  const { call, mk, admin, published } = await startApi(t);
  const a2 = await mk("admin2", "admin");
  assert.equal((await call(a2.h, "GET", "/api/admin/users")).status, 200);
  const r = await call(admin, "PUT", `/api/admin/users/${a2.id}/role`, { role: "gestor" });
  assert.equal(r.status, 200);
  const body = (await r.json()) as any;
  assert.equal(body.previousRole, "admin");
  assert.deepEqual(body.permissions.grants, []);
  assert.ok(published.some(([to, type]) => to === a2.id && type === "session"));
  assert.equal((await call(a2.h, "GET", "/api/admin/users")).status, 403, "sem poder de admin já na próxima requisição");
  const me = (await (await call(a2.h, "GET", "/api/auth/me")).json()) as any;
  assert.equal(me.user.role, "gestor");
  assert.deepEqual(me.permissions, []);

  const g = await mk("gestor", "gestor", ["contas_pagar:ver", "usuarios:ver", "usuarios:criar"]);
  const r2 = await call(admin, "PUT", `/api/admin/users/${g.id}/role`, { role: "user" });
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as any;
  assert.deepEqual(b2.permissions.grants, ["contas_pagar:ver"]);
  const u = ((await (await call(admin, "GET", "/api/admin/users")).json()) as any[]).find((x) => x.id === g.id)!;
  assert.deepEqual(u.permissions_count, { tabs: 1, actions: 0 });

  // User → Gestor mantém o que tinha; perfil inválido → 400 com field.
  const r3 = await call(admin, "PUT", `/api/admin/users/${g.id}/role`, { role: "gestor" });
  assert.deepEqual(((await r3.json()) as any).permissions.grants, ["contas_pagar:ver"]);
  const r4 = await call(admin, "PUT", `/api/admin/users/${g.id}/role`, { role: "superuser" });
  assert.equal(r4.status, 400);
  assert.equal(((await r4.json()) as any).field, "role");
});

test("último admin → 409 (corrida de rebaixamento mútuo, sem ROOT)", async (t) => {
  const store = createAuthStore(readConfig());
  const { call, mk, auth } = await startApi(t, { store });
  // Simula base sem ROOT e com o admin inicial já rebaixado: sobram só os dois admins abaixo.
  const seed = (await store.findUserById(1))!;
  const a = await mk("admin.a", "admin");
  const b = await mk("admin.b", "admin");
  seed.is_root = false;
  seed.role = "user";
  // Os dois pedidos já passaram pela autorização (ambos admins) e chegam juntos ao serviço:
  // o store serializa e o segundo vira 409 `last_admin` (sempre ≥ 1 admin).
  const results = await Promise.allSettled([
    auth.updateRole(b.id, "user", { actorId: a.id }),
    auth.updateRole(a.id, "user", { actorId: b.id }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const err = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
  assert.equal(err.status, 409);
  assert.equal(err.code, "last_admin");
  // Pela API, o admin que acabou de ser rebaixado já não passa da autorização.
  const loser = results[0]!.status === "fulfilled" ? b : a;
  const winner = loser === a ? b : a;
  assert.equal((await call(loser.h, "PUT", `/api/admin/users/${winner.id}/role`, { role: "user" })).status, 403);
  assert.equal(await store.countApprovedAdmins(), 1);
});

test("Novo Usuário: erros 400 trazem code e field estáveis por campo", async (t) => {
  const { call, admin } = await startApi(t);
  const base = { nome: "Ana", username: "ana", email: "ana@norvia.example", setor: "RH", senha: PASS };
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ ...base, senha: "curta" }, "weak_password", "senha"],
    [{ ...base, nome: "" }, "validation", "nome"],
    [{ ...base, email: "sem-arroba" }, "validation", "email"],
    [{ ...base, setor: " " }, "validation", "setor"],
    [{ ...base, role: "root" }, "validation", "role"],
    [{ ...base, grants: "tudo" }, "invalid_grants", "grants"],
  ];
  for (const [payload, code, field] of cases) {
    const r = await call(admin, "POST", "/api/admin/users", payload);
    assert.equal(r.status, 400, JSON.stringify(payload));
    const b = (await r.json()) as any;
    assert.equal(b.code, code, field);
    assert.equal(b.field, field);
  }
  assert.equal((await call(admin, "POST", "/api/admin/users", base)).status, 201);
  const dupUser = await call(admin, "POST", "/api/admin/users", { ...base, email: "outra@norvia.example" });
  assert.deepEqual([dupUser.status, ((await dupUser.json()) as any).field], [400, "username"]);
  const dupMail = await call(admin, "POST", "/api/admin/users", { ...base, username: "ana2" });
  const dm = (await dupMail.json()) as any;
  assert.deepEqual([dupMail.status, dm.code, dm.field], [400, "duplicate", "email"]);
});

test("catálogo e rotas livres: qualquer logado, mesmo sem permissão nenhuma", async (t) => {
  const { call, mk } = await startApi(t);
  const u = await mk("sem.nada", "user");
  const cat = await call(u.h, "GET", "/api/admin/permissions/catalog");
  assert.equal(cat.status, 200);
  assert.deepEqual(((await cat.json()) as any).tabs.length, PERMISSION_CATALOG.tabs.length);
  for (const r of ROUTE_RULES) {
    if (r.access.kind !== "free" || r.sample === "/api/events") continue;
    const res = await call(u.h, r.method, r.sample, r.method === "GET" ? undefined : {});
    assert.notEqual(res.status, 403, `${r.method} ${r.sample}`);
    assert.notEqual(res.status, 401, `${r.method} ${r.sample}`);
  }
  // Emissão manual de notificação: só Admin.
  assert.equal((await call(u.h, "POST", "/api/notifications/emit", { tipo: "x", titulo: "y" })).status, 403);
});

test("B3: approve e reject sobre usuário que não está pending devolvem 409 not_pending (Admin e Gestor)", async (t) => {
  const { base, call, mk, admin, auth, store } = await startApi(t);
  const gestor = await mk("gestor.aprovador", "gestor", [
    "usuarios:ver",
    "usuarios:aprovar_cadastro",
    "usuarios:rejeitar_cadastro",
    "contas_pagar:ver",
  ]);
  const approvedUser = await mk("user.aprovado", "user", ["contas_pagar:ver"]);

  // 1. Alvo approved
  for (const actor of [admin, gestor.h]) {
    const resApprove = await call(actor, "POST", `/api/admin/users/${approvedUser.id}/approve`, {
      username: "hacked.login",
      grants: ["contas_pagar:ver", "contas_pagar:baixar"],
    });
    assert.equal(resApprove.status, 409, "approve sobre usuário approved deve retornar 409");
    const bodyApprove = (await resApprove.json()) as any;
    assert.equal(bodyApprove.code, "not_pending");

    const resReject = await call(actor, "POST", `/api/admin/users/${approvedUser.id}/reject`);
    assert.equal(resReject.status, 409, "reject sobre usuário approved deve retornar 409");
    const bodyReject = (await resReject.json()) as any;
    assert.equal(bodyReject.code, "not_pending");
  }

  // Verifica que status, username e permissões do approved continuam intactos
  const targetCheck1 = await auth.getUser(approvedUser.id);
  assert.equal(targetCheck1?.status, "approved");
  assert.equal(targetCheck1?.username, "user.aprovado");
  assert.deepEqual(targetCheck1?.permissoes, ["contas_pagar:ver"]);

  // 2. Alvo rejected
  const regRes1 = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "User Rejeitado", email: "rej@norvia.example", setor: "Financeiro", senha: PASS }),
  });
  assert.equal(regRes1.status, 201);
  const usersAfterReg = (await (await call(admin, "GET", "/api/admin/users")).json()) as any[];
  const rejTarget = usersAfterReg.find((u) => u.email === "rej@norvia.example");
  assert.ok(rejTarget);
  // Rejeição legítima inicial sobre pending
  const initialRej = await call(gestor.h, "POST", `/api/admin/users/${rejTarget.id}/reject`);
  assert.equal(initialRej.status, 200);

  // Tentativas subsequentes sobre rejected
  for (const actor of [admin, gestor.h]) {
    const resApprove = await call(actor, "POST", `/api/admin/users/${rejTarget.id}/approve`, { grants: ["contas_pagar:ver"] });
    assert.equal(resApprove.status, 409, "approve sobre usuário rejected deve retornar 409");
    assert.equal(((await resApprove.json()) as any).code, "not_pending");

    const resReject = await call(actor, "POST", `/api/admin/users/${rejTarget.id}/reject`);
    assert.equal(resReject.status, 409, "reject sobre usuário rejected deve retornar 409");
    assert.equal(((await resReject.json()) as any).code, "not_pending");
  }

  // 3. Alvo blocked
  const blockedUser = await mk("user.bloqueado", "user", ["contas_pagar:ver"]);
  await store.updateUser(blockedUser.id, { status: "blocked" });
  for (const actor of [admin, gestor.h]) {
    const resApprove = await call(actor, "POST", `/api/admin/users/${blockedUser.id}/approve`, { grants: ["contas_pagar:ver"] });
    assert.equal(resApprove.status, 409, "approve sobre usuário blocked deve retornar 409");
    assert.equal(((await resApprove.json()) as any).code, "not_pending");

    const resReject = await call(actor, "POST", `/api/admin/users/${blockedUser.id}/reject`);
    assert.equal(resReject.status, 409, "reject sobre usuário blocked deve retornar 409");
    assert.equal(((await resReject.json()) as any).code, "not_pending");
  }

  // 4. Fluxo normal sobre pending continua 200
  const regRes2 = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "User Normal", email: "normal@norvia.example", setor: "Financeiro", senha: PASS }),
  });
  assert.equal(regRes2.status, 201);
  const usersPending = (await (await call(admin, "GET", "/api/admin/users")).json()) as any[];
  const pendTarget = usersPending.find((u) => u.email === "normal@norvia.example");
  assert.ok(pendTarget);
  assert.equal(pendTarget.status, "pending");

  const approveSuccess = await call(gestor.h, "POST", `/api/admin/users/${pendTarget.id}/approve`, {
    grants: ["contas_pagar:ver"],
  });
  assert.equal(approveSuccess.status, 200);
  const approveBody = (await approveSuccess.json()) as any;
  assert.equal(approveBody.success, true);

  // Segunda tentativa imediata deve retornar 409
  const secondApprove = await call(gestor.h, "POST", `/api/admin/users/${pendTarget.id}/approve`, {
    grants: ["contas_pagar:ver"],
  });
  assert.equal(secondApprove.status, 409);
  assert.equal(((await secondApprove.json()) as any).code, "not_pending");
});
