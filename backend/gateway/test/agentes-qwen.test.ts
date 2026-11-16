import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import type { DanfeService } from "../src/danfe.js";
import {
  avisoDoIncidente,
  createAgentesQwenService,
  parseAgentesQwenEstado,
  type AgentesQwenEstado,
  type AgentesQwenIncidente,
} from "../src/agentes-qwen.js";

const TEST_ADMIN_PASSWORD = "test-admin-bootstrap-password";
const TOKEN = "t".repeat(32);
const AGORA = new Date("2026-10-30T15:00:00Z");

function incidente(extra: Partial<AgentesQwenIncidente> = {}): AgentesQwenIncidente {
  return {
    id: 7,
    servico: "gateway",
    evento: "request_error",
    rota: "POST /api/x",
    mensagem: "x",
    estado: "pr_aberto",
    grupo: "pr_pendente",
    volta: 1,
    ocorrencias: 2,
    primeiroEm: "2026-10-30T10:00:00Z",
    ultimoEm: "2026-10-30T11:00:00Z",
    atualizadoEm: "2026-10-30T14:00:00Z",
    diagnostico: "faltava validar o corpo",
    nota: null,
    pr: { url: "https://github.com/o/r/pull/42", numero: 42, aprovadoPor: null, aprovadoEm: null, mergeadoEm: null, mergeSha: null },
    deployEm: null,
    deploy: [],
    acompanhamento: null,
    historico: [{ evento: "pr_aberto", volta: 1, detalhe: "https://github.com/o/r/pull/42", em: "2026-10-30T14:00:00Z" }],
    reportes: [],
    ...extra,
  };
}
const estado = (...incs: AgentesQwenIncidente[]): AgentesQwenEstado => ({ geradoEm: AGORA.toISOString(), commitProducao: "abc1234", incidentes: incs });

test("parseAgentesQwenEstado: aceita o formato do painel.py e recusa grupo desconhecido", () => {
  const ok = estado(incidente());
  assert.deepEqual(parseAgentesQwenEstado(JSON.parse(JSON.stringify(ok))), ok);
  assert.throws(() => parseAgentesQwenEstado({ ...ok, incidentes: [{ ...incidente(), grupo: "x" }] }), /grupo/);
  assert.throws(() => parseAgentesQwenEstado({ incidentes: "x" }), /incidentes/);
});

test("avisoDoIncidente: PR pendente, precisa do TI, deploy e confirmação com o acompanhamento", () => {
  assert.match(avisoDoIncidente(incidente())!.aviso.titulo, /PR #42 aguardando sua aprovação/);
  const ti = avisoDoIncidente(incidente({ estado: "escalado", grupo: "precisa_ti", nota: "passou de 3 voltas" }))!;
  assert.equal(ti.chave, "7:1:ti:escalado");
  assert.match(ti.aviso.titulo, /não resolveu o incidente #7: precisa de você/);
  assert.match(ti.aviso.mensagem!, /passou de 3 voltas/);
  assert.match(avisoDoIncidente(incidente({ estado: "aguardando_deploy", grupo: "aguardando_deploy" }))!.aviso.titulo, /rode o deploy/);
  const ok = avisoDoIncidente(
    incidente({ estado: "resolvido", grupo: "resolvido", acompanhamento: { modo: "rota", rota: "POST /api/x", alvo: 5, acompanhadas: 5, sucessos: 5 } }),
  )!;
  assert.match(ok.aviso.mensagem!, /5\/5 execuções acompanhadas com 5\/5 sucessos/);
  assert.equal(avisoDoIncidente(incidente({ estado: "em_andamento", grupo: "em_andamento" })), null);
});

test("receber: avisa uma vez por situação e não reavisa histórico antigo", async () => {
  const avisos: { key: string; titulo: string }[] = [];
  const svc = createAgentesQwenService({ ...readConfig(), agentesQwenToken: TOKEN }, undefined, {
    notify: async (key, data) => void avisos.push({ key, titulo: data.titulo }),
  });
  const antigo = incidente({ id: 1, estado: "escalado", grupo: "precisa_ti", atualizadoEm: "2026-10-20T10:00:00Z" });
  assert.deepEqual(await svc.receber(estado(incidente(), antigo), AGORA), { avisos: 1, comandos: [] });
  assert.deepEqual(await svc.receber(estado(incidente(), antigo), AGORA), { avisos: 0, comandos: [] });
  assert.deepEqual(await svc.receber(estado(incidente({ estado: "aguardando_deploy", grupo: "aguardando_deploy" })), AGORA), { avisos: 1, comandos: [] });
  assert.deepEqual(avisos.map((a) => a.key), ["agentes_qwen:ver", "agentes_qwen:ver"]);
  const lido = await svc.ler();
  assert.equal(lido.recebidoEm, AGORA.toISOString());
  assert.equal(lido.estado?.incidentes[0]?.grupo, "aguardando_deploy");
  assert.equal(svc.tokenValido(`Bearer ${TOKEN}`), true);
  assert.equal(svc.tokenValido("Bearer outro"), false);
  assert.equal(createAgentesQwenService(readConfig(), undefined, { notify: async () => {} }).tokenValido(`Bearer ${TOKEN}`), false);
});

test("marcar como resolvido: pedido volta no repasse até o PC confirmar", async () => {
  const svc = createAgentesQwenService({ ...readConfig(), agentesQwenToken: TOKEN }, undefined, { notify: async () => {} });
  assert.equal(await svc.pedirResolucao(3, "MP demorou", "João"), "nao_encontrado");
  const ti = incidente({ id: 3, estado: "aguardando_ti", grupo: "precisa_ti" });
  await svc.receber(estado(ti), AGORA);
  assert.equal(await svc.pedirResolucao(3, " MP demorou ", "João"), "ok");
  assert.deepEqual((await svc.ler()).resolucoesPendentes, [3]);
  const comando = { acao: "resolver", incidente: 3, nota: "MP demorou", por: "João" };
  assert.deepEqual((await svc.receber(estado(ti), AGORA)).comandos, [comando]);
  // PC confirmou: o estado seguinte mostra resolvido e o pedido sai da fila.
  assert.deepEqual((await svc.receber(estado({ ...ti, estado: "resolvido", grupo: "resolvido" }), AGORA)).comandos, []);
  assert.deepEqual((await svc.ler()).resolucoesPendentes, []);
  assert.equal(await svc.pedirResolucao(3, "", "João"), "ja_resolvido");
});

test("rotas: repasse só com o token e sem passar pelo NGINX; leitura só com agentes_qwen:ver", async (t) => {
  const config = { ...readConfig(), agentesQwenToken: TOKEN };
  const anterior = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = TEST_ADMIN_PASSWORD;
  t.after(() => {
    if (anterior === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = anterior;
  });
  const auth = createAuthService(config);
  await auth.bootstrap();
  const demo = createDemo();
  const avisos: string[] = [];
  const agentesQwen = createAgentesQwenService(config, undefined, { notify: async (key) => void avisos.push(key) });
  const server = createApi(config, { dashboard: createDashboardService("demo", demo.database, demo.n8n), auth, agentesQwen });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const json = { "Content-Type": "application/json" };
  const corpo = JSON.stringify({ ...estado(incidente()), geradoEm: new Date().toISOString(), incidentes: [{ ...incidente(), atualizadoEm: new Date().toISOString() }] });

  const semToken = await fetch(`${base}/api/agentes-qwen/estado`, { method: "POST", headers: json, body: corpo });
  assert.equal(semToken.status, 401);
  const pelaInternet = await fetch(`${base}/api/agentes-qwen/estado`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "203.0.113.9" },
    body: corpo,
  });
  assert.equal(pelaInternet.status, 401);
  const ok = await fetch(`${base}/api/agentes-qwen/estado`, { method: "POST", headers: { ...json, Authorization: `Bearer ${TOKEN}` }, body: corpo });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { avisos: 1, comandos: [] });
  assert.deepEqual(avisos, ["agentes_qwen:ver"]);

  assert.equal((await fetch(`${base}/api/agentes-qwen`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "admin_jp", senha: TEST_ADMIN_PASSWORD }) });
  const token = ((await login.json()) as { token: string }).token;
  const lido = await fetch(`${base}/api/agentes-qwen`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(lido.status, 200);
  const dados = (await lido.json()) as { estado: AgentesQwenEstado };
  assert.equal(dados.estado.incidentes[0]?.pr?.numero, 42);
  const resolver = await fetch(`${base}/api/agentes-qwen/incidentes/7/resolver`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nota: "nada pendente" }),
  });
  assert.equal(resolver.status, 202);
  assert.deepEqual(((await resolver.json()) as { resolucoesPendentes: number[] }).resolucoesPendentes, [7]);
  const outro = await fetch(`${base}/api/agentes-qwen/incidentes/99/resolver`, { method: "POST", headers: { ...json, Authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(outro.status, 404);
});

test("rotas /financeiro: ponte do coletor até a automação, com o token do repasse e status da automação", async (t) => {
  const config = { ...readConfig(), agentesQwenToken: TOKEN };
  const chamadas: { metodo: string; caminho: string; corpo?: unknown }[] = [];
  const danfe = {
    async qwenRepasse(metodo: "GET" | "POST", caminho: string, corpo?: unknown) {
      chamadas.push({ metodo, caminho, corpo });
      if (caminho === "sugestoes") return { status: 409, corpo: { detail: "nota mudou" } };
      return { status: 200, corpo: { notas: [], categorias: [] } };
    },
  } as unknown as DanfeService;
  const demo = createDemo();
  const agentesQwen = createAgentesQwenService(config, undefined, { notify: async () => undefined });
  const server = createApi(config, { dashboard: createDashboardService("demo", demo.database, demo.n8n), agentesQwen, danfe });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/agentes-qwen/financeiro`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  assert.equal((await fetch(`${base}/pendentes`)).status, 401);
  assert.equal((await fetch(`${base}/pendentes`, { headers: { ...auth, "X-Forwarded-For": "203.0.113.9" } })).status, 401);
  const pend = await fetch(`${base}/pendentes?limit=10&outro=x`, { headers: auth });
  assert.equal(pend.status, 200);
  assert.deepEqual(await pend.json(), { notas: [], categorias: [] });
  const conf = await fetch(`${base}/confirmadas-recentes?cursor=${encodeURIComponent("2026-11-03T10:00:00|abc")}&limit=100`, { headers: auth });
  assert.equal(conf.status, 200);
  const sug = await fetch(`${base}/sugestoes`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ chave: "k" }),
  });
  assert.equal(sug.status, 409);
  assert.deepEqual(await sug.json(), { detail: "nota mudou" });
  assert.deepEqual(chamadas, [
    { metodo: "GET", caminho: "pendentes?limit=10", corpo: undefined },
    { metodo: "GET", caminho: "confirmadas-recentes?limit=100&cursor=2026-11-03T10%3A00%3A00%7Cabc", corpo: undefined },
    { metodo: "POST", caminho: "sugestoes", corpo: { chave: "k" } },
  ]);
});
