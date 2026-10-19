import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";

const TEST_ADMIN_PASSWORD = "test-admin-bootstrap-password";

test("Sistema de Autenticação, Aprovação e Painel Administrativo", async (t) => {
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

  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth: authService,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  // 1. Login do Administrador inicial (admin_jp)
  const adminLoginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin_jp", senha: TEST_ADMIN_PASSWORD }),
  });
  assert.equal(adminLoginRes.status, 200);
  const adminData = (await adminLoginRes.json()) as any;
  assert.ok(adminData.token);
  assert.equal(adminData.user.role, "admin");
  assert.equal(adminData.user.nome, "Autor");
  const adminToken = adminData.token;

  // 2. Registro de novo usuário comum (Carlos Silva)
  const regRes = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "Carlos Silva",
      email: "carlos.silva@norvia.example",
      setor: "Financeiro",
      senha: "senhaSegura123",
    }),
  });
  assert.equal(regRes.status, 201);
  const regData = (await regRes.json()) as any;
  assert.ok(regData.message.includes("aprovação do administrador"));

  // 3. Tentar logar antes da aprovação do admin deve retornar 401
  const pendingLoginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "carlos.silva@norvia.example", senha: "senhaSegura123" }),
  });
  assert.equal(pendingLoginRes.status, 401);
  const pendingErr = (await pendingLoginRes.json()) as any;
  assert.ok(pendingErr.error.includes("pendente de aprovação"));

  // 4. Admin visualiza usuários pendentes
  const usersRes = await fetch(`${base}/api/admin/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(usersRes.status, 200);
  const usersList = (await usersRes.json()) as any[];
  const carlos = usersList.find((u) => u.email === "carlos.silva@norvia.example");
  assert.ok(carlos);
  assert.equal(carlos.status, "pending");

  // 5. Admin aprova o cadastro do Carlos definindo o username 'carlos_financeiro'
  const approveRes = await fetch(`${base}/api/admin/users/${carlos.id}/approve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: "carlos_financeiro" }),
  });
  assert.equal(approveRes.status, 200);

  // 6. Carlos agora consegue logar com o username definido pelo admin
  const carlosLoginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "carlos_financeiro", senha: "senhaSegura123" }),
  });
  assert.equal(carlosLoginRes.status, 200);
  const carlosData = (await carlosLoginRes.json()) as any;
  assert.ok(carlosData.token);
  assert.equal(carlosData.user.username, "carlos_financeiro");
  assert.equal(carlosData.user.role, "user");
  const carlosToken = carlosData.token;

  // 7. Usuário comum NÃO pode acessar rotas de admin (403)
  const forbiddenRes = await fetch(`${base}/api/admin/users`, {
    headers: { Authorization: `Bearer ${carlosToken}` },
  });
  assert.equal(forbiddenRes.status, 403);

  // 8. Admin lista sessões ativas e força logout do Carlos
  const sessionsRes = await fetch(`${base}/api/admin/sessions`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(sessionsRes.status, 200);
  const sessions = (await sessionsRes.json()) as any[];
  const carlosSession = sessions.find((s) => s.usuario_id === carlos.id);
  assert.ok(carlosSession);

  // Admin executa o force-logout
  const forceRes = await fetch(`${base}/api/admin/sessions/${carlosSession.id}/force-logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(forceRes.status, 200);

  // 9. Carlos agora tem sua sessão invalidada (/api/auth/me retorna 401)
  const meRes = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${carlosToken}` },
  });
  assert.equal(meRes.status, 401);
});
