import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { createIncidentService } from "../src/incidents.js";
import { createAgentesQwenService, type AgentesQwenIncidente } from "../src/agentes-qwen.js";

const TEST_ADMIN_PASSWORD = "test-admin-bootstrap-password";

function incidenteQwen(grupo: AgentesQwenIncidente["grupo"], reportes: number[]): AgentesQwenIncidente {
  return {
    id: 9, servico: "automacao-nfe", evento: "reporte_operador", rota: null, mensagem: "Falha ao lançar", estado: grupo === "resolvido" ? "resolvido" : "novo",
    grupo, volta: 1, ocorrencias: 1, primeiroEm: null, ultimoEm: null, atualizadoEm: null, diagnostico: null, nota: null, pr: null,
    deployEm: null, deploy: [], acompanhamento: null, historico: [],
    reportes: reportes.map((id) => ({ id, automacao: "danfe-tiny", referencia: "EXEC-1", por: "Ana Operadora", em: null })),
  };
}

test("Reportar erro: qualquer aba com automação, vai aos agentes Qwen pelo repasse e fecha quando eles resolvem", async (t) => {
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
  const avisos: string[] = [];
  const incidents = createIncidentService(config, undefined, {
    notify: async (data) => {
      avisos.push(data.titulo);
    },
  });
  const agentesQwen = createAgentesQwenService(config, undefined, { notify: async () => {}, reportes: incidents });

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
    // RBAC por usuário: reportar erro da NF-e exige ver a aba Revisão NF-e.
    body: JSON.stringify({ username: "ana_op", grants: ["revisao_nfe:ver"] }),
  });
  const userToken = ((await (
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ login: "ana_op", senha: "senhaSegura123" }),
    })
  ).json()) as any).token as string;
  const comoAna = { ...json, Authorization: `Bearer ${userToken}` };

  // Sem sessão: 401
  assert.equal((await fetch(`${base}/api/incidents`)).status, 401);

  // Automação desconhecida ou sem a mensagem de erro: 400
  for (const corpo of [{ executionId: "X", automationId: "inexistente", errorMessage: "x" }, { executionId: "X", automationId: "danfe-tiny" }]) {
    assert.equal((await fetch(`${base}/api/incidents`, { method: "POST", headers: comoAna, body: JSON.stringify(corpo) })).status, 400);
  }
  // Aba que ela não vê: 403
  const semAba = await fetch(`${base}/api/incidents`, {
    method: "POST",
    headers: comoAna,
    body: JSON.stringify({ executionId: "MLB1", automationId: "shipping-review", errorMessage: "x" }),
  });
  assert.equal(semAba.status, 403);

  // Quem reportou vem da sessão, não do corpo; o título vem do catálogo.
  const report = {
    executionId: "EXEC-1",
    automationId: "danfe-tiny",
    stoppedNode: "Lançar no Tiny",
    errorMessage: "Falha ao lançar: CPF 123.456.789-09 sem cadastro",
    reportedBy: "Nome Forjado",
    automationTitle: "Forjado",
  };
  const created = await fetch(`${base}/api/incidents`, { method: "POST", headers: comoAna, body: JSON.stringify(report) });
  assert.equal(created.status, 201);
  const incident = (await created.json()) as any;
  assert.equal(incident.reportedBy, "Ana Operadora");
  assert.equal(incident.automationTitle, "NF-e & DANFE");
  assert.equal(incident.status, "pending");
  assert.equal(incident.agentIncidentId, null);
  assert.deepEqual(avisos, ["Erro reportado em NF-e & DANFE"]);

  // Reportar a mesma referência de novo atualiza, não duplica (nem reavisa).
  await fetch(`${base}/api/incidents`, { method: "POST", headers: comoAna, body: JSON.stringify({ ...report, operatorNote: "de novo" }) });
  assert.equal(avisos.length, 1);

  // O repasse leva o reporte ao PC (dados de pessoa física mascarados) até o PC confirmar.
  const ida = await agentesQwen.receber({ geradoEm: "x", commitProducao: null, incidentes: [] });
  assert.equal(ida.comandos.length, 1);
  const comando = ida.comandos[0]!;
  assert.equal(comando.acao, "reportar");
  assert.ok(comando.acao === "reportar");
  assert.equal(comando.reporte.servico, "automacao-nfe");
  assert.equal(comando.reporte.nota, "de novo");
  assert.equal(comando.reporte.mensagem, "Falha ao lançar: CPF <pf> sem cadastro");

  // O PC devolveu o reporte no incidente #9: sai da fila e fica ligado.
  const volta = await agentesQwen.receber({ geradoEm: "x", commitProducao: null, incidentes: [incidenteQwen("em_andamento", [Number(incident.id)])] });
  assert.equal(volta.comandos.length, 0);
  const lista = (await (await fetch(`${base}/api/incidents`, { headers: comoAna })).json()) as any[];
  assert.equal(lista.length, 1);
  assert.equal(lista[0].agentIncidentId, 9);
  assert.equal(lista[0].agentGroup, "em_andamento");
  assert.equal(lista[0].status, "pending");

  // Os agentes resolveram: o reporte fecha sozinho (não precisa mais estar no `reportes`).
  await agentesQwen.receber({ geradoEm: "x", commitProducao: null, incidentes: [incidenteQwen("resolvido", [])] });
  const fim = (await (await fetch(`${base}/api/incidents`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as any[];
  assert.equal(fim[0].status, "resolved");

  // Endpoint antigo de resolver não existe mais.
  assert.equal((await fetch(`${base}/api/incidents/${incident.id}/resolve`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } })).status, 404);
});
