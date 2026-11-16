import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { deveRegistrar, extraDaAtividade, mascarar, separarTreino, type AtividadeInput, type AtividadesService } from "../src/atividades.js";
import type { DanfeService } from "../src/danfe.js";

const TEST_ADMIN_PASSWORD = "test-admin-bootstrap-password";

test("mascarar: segredo oculto, pessoa física mascarada, negócio intacto", () => {
  const entrada = {
    senha: "x",
    token: "abc",
    email: "ana@empresa.com",
    observacao: "falar com ana@empresa.com, CPF 123.456.789-09, cel (11) 98765-4321, 12345678909",
    emitente_cnpj: "12345678000199",
    chave: "35261012345678000199550010000014201000014209",
    valor: 1500.5,
    itens: [{ descricao: "Detergente", categoria_id: "701885961" }],
  };
  assert.deepEqual(mascarar(entrada), {
    senha: "<oculto>",
    token: "<oculto>",
    email: "<pf>",
    observacao: "falar com <pf>, CPF <pf>, cel <pf>, <pf>",
    emitente_cnpj: "12345678000199",
    chave: "35261012345678000199550010000014201000014209",
    valor: 1500.5,
    itens: [{ descricao: "Detergente", categoria_id: "701885961" }],
  });
});

test("mascarar: comprador do ML e nome de quem fez viram <pf>", () => {
  assert.deepEqual(mascarar({ nome_cliente: "Maria", usuario: "Ana", envio: { por: "Bruno" }, fornecedor_nome: "ACME LTDA" }), {
    nome_cliente: "<pf>",
    usuario: "<pf>",
    envio: { por: "<pf>" },
    fornecedor_nome: "ACME LTDA",
  });
});

test("separarTreino: tira o campo da resposta e guarda contexto e sugestão", () => {
  const request = new IncomingMessage(new Socket());
  const corpo = { job_id: "j1", treino: { contexto: { grupos: [1] }, sugestao: { baixar: ["g1"] } } };
  assert.deepEqual(separarTreino(request, corpo), { job_id: "j1" });
  assert.deepEqual(extraDaAtividade(request), { contexto: { grupos: [1] }, sugestao: { baixar: ["g1"] } });
  const lista = [{ treino: 1 }];
  assert.equal(separarTreino(request, lista), lista);
});

test("deveRegistrar: só mutações fora de credenciais, contagem, chat e leitura de aviso", () => {
  assert.equal(deveRegistrar("POST", "/api/danfe/confirm-lancamento"), true);
  assert.equal(deveRegistrar("PUT", "/api/admin/users/2/setor"), true);
  assert.equal(deveRegistrar("GET", "/api/danfe/notas"), false);
  assert.equal(deveRegistrar("POST", "/api/auth/login"), false);
  assert.equal(deveRegistrar("POST", "/api/auth/change-password"), false);
  assert.equal(deveRegistrar("POST", "/api/stock-count/contagens/abc/conferir"), false);
  assert.equal(deveRegistrar("POST", "/api/chat/messages"), false);
  assert.equal(deveRegistrar("POST", "/api/notifications/3/read"), false);
});

test("Atividades: lançamento de NF-e grava entrada, contexto e sugestão, e o painel não recebe o treino", async (t) => {
  const config = readConfig();
  const demo = createDemo();
  const anterior = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = TEST_ADMIN_PASSWORD;
  t.after(() => {
    if (anterior === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = anterior;
  });
  const auth = createAuthService(config);
  await auth.bootstrap();
  const gravadas: AtividadeInput[] = [];
  const atividades: AtividadesService = { bootstrap: async () => {}, registrar: (i) => void gravadas.push(i) };
  // Sugestão do classificador Qwen: confiança, motivo e alternativas chegam inteiros à tabela.
  const sugestaoQwen = {
    categoria_id: "A",
    origem: "qwen",
    nivel: null,
    confianca: "media",
    motivo: "fornecedor 12.345.678/0001-95 vende material de limpeza",
    qwen_modelo: "qwen2.5:14b",
    alternativas: { historico: { categoria_id: "C", nivel: "fornecedor" }, qwen: { categoria_id: "A", confianca: "media" }, regra: "B" },
  };
  const danfe = {
    async confirmLancamento(chave: string) {
      return {
        chave,
        status: "success" as const,
        grupos: [],
        treino: { contexto: { chave, itens: [{ item_id: "1", descricao: "Detergente" }] }, sugestao: { "1": sugestaoQwen } },
      };
    },
  } as unknown as DanfeService;

  const server = createApi(config, { dashboard: createDashboardService("demo", demo.database, demo.n8n), auth, danfe, atividades });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const json = { "Content-Type": "application/json" };

  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: "admin_jp", senha: TEST_ADMIN_PASSWORD }) });
  const token = ((await login.json()) as { token: string }).token;
  const admin = { ...json, Authorization: `Bearer ${token}` };

  const res = await fetch(`${base}/api/danfe/confirm-lancamento?origem=painel`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ chave: "352610", itens: [{ item_id: "1", categoria_id: "B" }], forma_pagamento: "pix" }),
  });
  assert.equal(res.status, 200);
  const corpo = (await res.json()) as Record<string, unknown>;
  assert.equal("treino" in corpo, false);
  await fetch(`${base}/api/danfe/notas`, { headers: admin });

  // O registro é gravado no "finish" da resposta: espera o evento chegar.
  for (let i = 0; i < 50 && gravadas.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(gravadas.length, 1, "login e GET não entram");
  const [a] = gravadas;
  assert.equal(a!.metodo, "POST");
  assert.equal(a!.path, "/api/danfe/confirm-lancamento");
  assert.equal(a!.permissao, "revisao_nfe:lancar");
  assert.deepEqual(a!.query, { origem: "painel" });
  assert.deepEqual((a!.entrada as { itens: unknown }).itens, [{ item_id: "1", categoria_id: "B" }]);
  assert.deepEqual(a!.extra?.sugestao, { "1": sugestaoQwen });
  assert.equal(a!.status, 200);
  assert.equal(a!.perfil, "admin");

  // As rotas internas do classificador (/api/v1/danfe/qwen/*) são só do coletor da VPS.
  for (const rota of ["/api/danfe/qwen/pendentes", "/api/danfe/qwen/confirmadas-recentes", "/api/v1/danfe/qwen/pendentes"]) {
    const r = await fetch(`${base}${rota}`, { headers: admin });
    assert.equal(r.status, 404, rota);
  }
});
