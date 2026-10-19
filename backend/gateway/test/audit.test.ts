import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { createAuditService, parseAuditQuery } from "../src/audit.js";

const TEST_ADMIN_PASSWORD = "test-admin-bootstrap-password";

test("parseAuditQuery ignora filtros inválidos", () => {
  const q = parseAuditQuery(new URLSearchParams("acao=inexistente&usuarioId=abc&limit=20&q=%20ana%20&before=10"));
  assert.equal(q.acao, undefined);
  assert.equal(q.usuarioId, undefined);
  assert.equal(q.limit, 20);
  assert.equal(q.q, "ana");
  assert.equal(q.before, "10");
  assert.equal(parseAuditQuery(new URLSearchParams("acao=usuario_excluido")).acao, "usuario_excluido");
});

test("Auditoria: registra ações de usuário e só o admin consulta", async (t) => {
  const config = readConfig();
  const demo = createDemo();
  const previousBootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = TEST_ADMIN_PASSWORD;
  t.after(() => {
    if (previousBootstrapPassword === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = previousBootstrapPassword;
  });
  const authService = createAuthService(config);
  await authService.bootstrap();
  const audit = createAuditService(config, undefined);

  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth: authService,
    audit,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const json = { "Content-Type": "application/json" };
  const login = async (loginName: string, senha: string) =>
    fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: loginName, senha }) });

  // Senha errada fica registrada como falha, sem usuário identificado.
  assert.equal((await login("admin_jp", "senha-errada")).status, 401);

  const adminToken = ((await (await login("admin_jp", TEST_ADMIN_PASSWORD)).json()) as any).token as string;
  const admin = { ...json, Authorization: `Bearer ${adminToken}` };

  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "Bruno Logística", email: "bruno@norvia.example", setor: "Logística", senha: "senhaSegura123" }),
  });
  const users = (await (await fetch(`${base}/api/admin/users`, { headers: admin })).json()) as any[];
  const bruno = users.find((u) => u.email === "bruno@norvia.example");
  await fetch(`${base}/api/admin/users/${bruno.id}/approve`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ username: "bruno_log" }),
  });
  const userToken = ((await (await login("bruno_log", "senhaSegura123")).json()) as any).token as string;

  // Usuário comum não consulta a auditoria.
  const forbidden = await fetch(`${base}/api/admin/audit`, { headers: { Authorization: `Bearer ${userToken}` } });
  assert.equal(forbidden.status, 403);

  await fetch(`${base}/api/admin/users/${bruno.id}/setor`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({ setor: "Financeiro" }),
  });
  await fetch(`${base}/api/admin/users/${bruno.id}`, { method: "DELETE", headers: admin });

  const entries = (await (await fetch(`${base}/api/admin/audit`, { headers: admin })).json()) as any[];
  const acoes = entries.map((e) => e.acao);
  // Mais recente primeiro.
  assert.deepEqual(acoes.slice(0, 6), [
    "usuario_excluido",
    "setor_alterado",
    "login",
    "usuario_aprovado",
    "login",
    "login_falhou",
  ]);
  const excluido = entries[0];
  assert.equal(typeof excluido.usuarioId, "number");
  assert.equal(excluido.alvo, `Bruno Logística (#${bruno.id})`);
  assert.equal(excluido.sucesso, true);
  assert.deepEqual(entries[1].detalhes, { de: "Logística", setor: "Financeiro" });
  const falhou = entries.find((e) => e.acao === "login_falhou");
  assert.equal(falhou.sucesso, false);
  assert.equal(falhou.usuarioId, null);
  assert.equal(falhou.alvo, "admin_jp");

  // Filtros.
  const soExclusoes = (await (
    await fetch(`${base}/api/admin/audit?acao=usuario_excluido`, { headers: admin })
  ).json()) as any[];
  assert.equal(soExclusoes.length, 1);
  const busca = (await (await fetch(`${base}/api/admin/audit?q=bruno`, { headers: admin })).json()) as any[];
  assert.ok(busca.length >= 3);
  const pagina = (await (
    await fetch(`${base}/api/admin/audit?before=${entries[1].id}&limit=1`, { headers: admin })
  ).json()) as any[];
  assert.equal(pagina.length, 1);
  assert.equal(pagina[0].id, entries[2].id);
});
