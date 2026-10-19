import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { createIncidentService } from "../src/incidents.js";

const TEST_ADMIN_PASSWORD = "test-admin-bootstrap-password";

test("Incidentes: reportados por qualquer usuário, visíveis e resolvíveis pelo admin", async (t) => {
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
  const adminNotifications: string[] = [];
  const incidents = createIncidentService(config, undefined, {
    notifyAdmins: async (data) => {
      adminNotifications.push(data.titulo);
    },
  });

  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth: authService,
    incidents,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const json = { "Content-Type": "application/json" };

  const adminToken = ((await (
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ login: "admin_jp", senha: TEST_ADMIN_PASSWORD }),
    })
  ).json()) as any).token as string;

  await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ nome: "Ana Operadora", email: "ana.op@norvia.example", setor: "Financeiro", senha: "senhaSegura123" }),
  });
  const users = (await (await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as any[];
  const ana = users.find((u) => u.email === "ana.op@norvia.example");
  await fetch(`${base}/api/admin/users/${ana.id}/approve`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${adminToken}` },
    // RBAC por usuário: reportar incidente da NF-e exige ver a aba Revisão NF-e.
    body: JSON.stringify({ username: "ana_op", grants: ["revisao_nfe:ver"] }),
  });
  const userToken = ((await (
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ login: "ana_op", senha: "senhaSegura123" }),
    })
  ).json()) as any).token as string;

  // Sem sessão: 401
  assert.equal((await fetch(`${base}/api/incidents`)).status, 401);

  // Payload inválido: 400
  const invalid = await fetch(`${base}/api/incidents`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ executionId: "X", automationId: "inexistente" }),
  });
  assert.equal(invalid.status, 400);

  // Usuário comum reporta; quem reportou vem da sessão, não do corpo.
  const report = {
    executionId: "EXEC-1",
    automationId: "danfe-tiny",
    automationTitle: "NF-e & DANFE",
    stoppedNode: "Lançar no Tiny",
    diagnosticExplanation: "diag",
    recommendedAction: "ação",
    reportedBy: "Nome Forjado",
  };
  const created = await fetch(`${base}/api/incidents`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(report),
  });
  assert.equal(created.status, 201);
  const incident = (await created.json()) as any;
  assert.equal(incident.reportedBy, "Ana Operadora");
  assert.equal(incident.status, "pending");
  assert.deepEqual(adminNotifications, ["Incidente reportado: NF-e & DANFE"]);

  // Reportar a mesma execução de novo atualiza, não duplica.
  await fetch(`${base}/api/incidents`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ ...report, operatorNote: "de novo" }),
  });

  // Admin (outra sessão/máquina) enxerga o reporte.
  const pending = (await (
    await fetch(`${base}/api/incidents?status=pending`, { headers: { Authorization: `Bearer ${adminToken}` } })
  ).json()) as any[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operatorNote, "de novo");

  // Usuário comum não pode resolver.
  const forbidden = await fetch(`${base}/api/incidents/${pending[0].id}/resolve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(forbidden.status, 403);

  const resolved = await fetch(`${base}/api/incidents/${pending[0].id}/resolve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(resolved.status, 200);
  const all = (await (await fetch(`${base}/api/incidents`, { headers: { Authorization: `Bearer ${userToken}` } })).json()) as any[];
  assert.equal(all[0].status, "resolved");
  assert.equal(all[0].resolvedBy, "Autor");
});
