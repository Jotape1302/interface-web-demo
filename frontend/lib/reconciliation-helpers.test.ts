import test from "node:test";
import assert from "node:assert/strict";
import type {
  BaixaJob,
  ReconciliationJob,
  ReconciliationCompanyStatus,
  ReconciliationMatch,
  ReconciliationPreviewResponse,
  ReconciliationSummary,
} from "./reconciliation-contracts";
import {
  JOB_LOST_MESSAGE,
  JobLostError,
  describeDadosDe,
  describeJobProgress,
  formatElapsed,
  waitForJob,
  buildBaixaItem,
  buildHistoricoSearchParams,
  classifyInterMessage,
  companyLabel,
  describeSeparated,
  formatConfidence,
  formatExecutadoEm,
  historicoPageCount,
  parseAvisos,
  resolveInterHealth,
  separatedTotals,
} from "./reconciliation-helpers";

const base: ReconciliationCompanyStatus = {
  id: "fabrilux",
  nome: "Fabrilux",
  cnpj: "43820617000166",
  inter_configurado: false,
  tiny_configurado: true,
};

void test("erro cru de PermissionError vira certificado sem permissão", () => {
  assert.equal(
    classifyInterMessage("Falha na autenticação do Banco Inter: ('Connection aborted.', PermissionError(13, 'Permission denied'))"),
    "certificados_sem_permissao",
  );
  assert.equal(classifyInterMessage("Certificados mTLS (.crt e .key) ausentes para 'fabrilux'."), "certificados_ausentes");
  assert.equal(classifyInterMessage("timeout"), "falha_extrato");
});

void test("avisos são separados por filial e origem", () => {
  const parsed = parseAvisos([
    "Norvia Campinas (Inter): Certificados mTLS encontrados, mas sem permissão de leitura pelo container",
    "Norvia Campinas: Falha ao consultar extrato no Banco Inter: boom",
    "Revesta: Falha ao consultar contas no Tiny: HTTP 403",
    "Aviso solto",
  ]);
  assert.deepEqual(parsed.inter.get("norvia_campinas"), [
    "Certificados mTLS encontrados, mas sem permissão de leitura pelo container",
    "Falha ao consultar extrato no Banco Inter: boom",
  ]);
  assert.deepEqual(parsed.outros, [
    { empresa: "Revesta", fonte: "tiny", mensagem: "Falha ao consultar contas no Tiny: HTTP 403" },
    { empresa: null, fonte: "outro", mensagem: "Aviso solto" },
  ]);
});

void test("status novo do backend é usado direto", () => {
  const r = resolveInterHealth({ ...base, inter_status: "certificados_sem_permissao", inter_mensagem: "sem permissão" }, undefined);
  assert.equal(r.health, "certificados_sem_permissao");
  assert.equal(r.detalhe, "sem permissão");
});

void test("backend antigo: erro de autenticação por permissão é refinado", () => {
  const r = resolveInterHealth(
    { ...base, inter_status: "erro_autenticacao", inter_mensagem: "PermissionError(13, 'Permission denied')" },
    undefined,
  );
  assert.equal(r.health, "certificados_sem_permissao");
});

void test("conectado com falha na prévia vira falha de extrato", () => {
  const ok = resolveInterHealth({ ...base, inter_status: "conectado", inter_configurado: true }, undefined);
  assert.deepEqual(ok, { health: "conectado", detalhe: null });
  const r = resolveInterHealth({ ...base, inter_status: "conectado" }, ["Falha ao consultar extrato no Banco Inter: 500"]);
  assert.equal(r.health, "falha_extrato");
});

void test("sem status nem aviso fica como não verificado", () => {
  assert.equal(resolveInterHealth(undefined, undefined).health, "desconhecido");
  assert.equal(resolveInterHealth(base, undefined).health, "desconhecido");
});

void test("confiança em fração vira percentual", () => {
  assert.equal(formatConfidence(0.95), "95%");
  assert.equal(formatConfidence(1), "100%");
});

const match: ReconciliationMatch = {
  id: "m1",
  empresa: "fabrilux",
  empresa_nome: "Fabrilux",
  conta_pagar_id: 987654,
  numero_documento: "NF 4521/1",
  fornecedor_nome: "Portobello S.A.",
  fornecedor_cnpj: "83475913000191",
  data_vencimento: "2026-09-20",
  valor_tiny: 1250,
  inter_transacao_id: "TX-001",
  tipo_transacao_inter: "PAGAMENTO",
  data_pagamento: "2026-09-22",
  valor_pago: 1262.5,
  valor_original_inter: 1250,
  juros: 12.5,
  multa: 0,
  desconto: 0,
  codigo_barras: null,
  metodo_match: "CODIGO_BARRAS",
  confianca: 0.99,
  motivo: "Código de barras idêntico",
  status_tiny: "aberto",
  historico_sugerido: "",
};

void test("item de baixa leva os metadados do histórico", () => {
  const item = buildBaixaItem(match);
  assert.equal(item.historico, "Baixa conciliada Banco Inter TX-001");
  assert.equal(item.conta_origem_id, null);
  assert.deepEqual(
    {
      numero_documento: item.numero_documento,
      fornecedor_nome: item.fornecedor_nome,
      data_vencimento: item.data_vencimento,
      valor_tiny: item.valor_tiny,
      inter_transacao_id: item.inter_transacao_id,
      metodo_match: item.metodo_match,
    },
    {
      numero_documento: "NF 4521/1",
      fornecedor_nome: "Portobello S.A.",
      data_vencimento: "2026-09-20",
      valor_tiny: 1250,
      inter_transacao_id: "TX-001",
      metodo_match: "CODIGO_BARRAS",
    },
  );
});

const baseSummary = {
  total_casados: 0,
  valor_total_casados: 0,
  total_inter_sem_par: 0,
  valor_inter_sem_par: 0,
  total_tiny_sem_par: 0,
  valor_tiny_sem_par: 0,
};

void test("backend antigo sem campos de separação vira zero", () => {
  const old = {
    status: "ok",
    data_inicio: "2026-09-01",
    data_fim: "2026-09-28",
    summary: baseSummary as ReconciliationSummary,
    matches: [],
  } satisfies ReconciliationPreviewResponse;
  const totals = separatedTotals(old);
  assert.deepEqual(totals, { jaBaixadas: { total: 0, valor: 0 }, transferencias: { total: 0, valor: 0 } });
  assert.equal(describeSeparated(totals), null);
});

void test("sem totais no summary, usa as listas", () => {
  const preview: ReconciliationPreviewResponse = {
    status: "ok",
    data_inicio: "2026-09-01",
    data_fim: "2026-09-28",
    summary: baseSummary as ReconciliationSummary,
    matches: [],
    transferencias_internas: [
      {
        empresa: "fabrilux",
        empresa_nome: "Fabrilux",
        empresa_destino_nome: "Revesta",
        transacao_id: "T1",
        data_pagamento: "2026-09-10",
        valor_pago: 5000,
        tipo_transacao: "PIX",
        titulo: "Pix enviado",
        descricao: "Ref. a transferência de saldo para pagamento das contas do dia",
        nome_favorecido: "Revesta Decoracoes",
        cpf_cnpj_favorecido: "36592814000100",
        codigo_barras: null,
        situacao: "sem_conta",
        conciliacao: null,
        conta_ja_baixada: null,
      },
    ],
  };
  const totals = separatedTotals(preview);
  assert.deepEqual(totals.transferencias, { total: 1, valor: 5000 });
  assert.equal(describeSeparated(totals), "1 transferência entre empresas foi separada.");
});

void test("frase de separação no plural", () => {
  assert.equal(
    describeSeparated({ jaBaixadas: { total: 7, valor: 1 }, transferencias: { total: 3, valor: 1 } }),
    "3 transferências entre empresas e 7 débitos já baixados no Tiny foram separados.",
  );
  assert.equal(
    describeSeparated({ jaBaixadas: { total: 1, valor: 1 }, transferencias: { total: 0, valor: 0 } }),
    "1 débito já baixado no Tiny foi separado.",
  );
  assert.equal(
    describeSeparated({ jaBaixadas: { total: 0, valor: 0 }, transferencias: { total: 4, valor: 1 } }),
    "4 transferências entre empresas foram separadas.",
  );
});

void test("query do histórico omite filtros vazios", () => {
  assert.equal(buildHistoricoSearchParams({}).toString(), "");
  assert.equal(
    buildHistoricoSearchParams({ empresa: "fabrilux", status: "erro", de: "2026-09-01", ate: "", q: "  portobello ", page: 2, pageSize: 50 }).toString(),
    "empresa=fabrilux&status=erro&de=2026-09-01&q=portobello&page=2&pageSize=50",
  );
  assert.equal(
    buildHistoricoSearchParams({ empresa: ["fabrilux", "curitiba"], status: ["erro", "pendente"], fornecedor: " acme ", documento: "123", usuario: "" }).toString(),
    "empresa=fabrilux%2Ccuritiba&status=erro%2Cpendente&fornecedor=acme&documento=123",
  );
});

void test("contagem de páginas do histórico", () => {
  assert.equal(historicoPageCount(0, 50), 1);
  assert.equal(historicoPageCount(50, 50), 1);
  assert.equal(historicoPageCount(51, 50), 2);
});

void test("executado em no formato DD/MM/AAAA HH:mm de São Paulo", () => {
  assert.equal(formatExecutadoEm("2026-09-28T13:05:00Z"), "28/09/2026 10:05");
  assert.equal(formatExecutadoEm(null), "—");
});

void test("rótulo da filial", () => {
  assert.equal(companyLabel("norvia_curitiba"), "Norvia Curitiba");
  assert.equal(companyLabel("desconhecida"), "desconhecida");
});

function baixaJob(overrides: Partial<BaixaJob> = {}): BaixaJob {
  return {
    job_id: "job-1",
    tipo: "baixar",
    status: "executando",
    etapa: "Baixando conta #123 (Fabrilux)",
    atual: 0,
    total: 3,
    iniciado_em: "2026-09-28T13:00:00Z",
    concluido_em: null,
    erro: null,
    resultado: null,
    ...overrides,
  };
}

const baixaOk = { status: "ok", total_solicitados: 3, total_sucessos: 3, total_falhas: 0, resultados: [] };
const noSleep = () => Promise.resolve();

void test("polling segue até concluir e reporta o andamento", async () => {
  const sequence: ReconciliationJob[] = [
    baixaJob({ atual: 1 }),
    baixaJob({ atual: 2 }),
    baixaJob({ status: "concluido", atual: 3, resultado: baixaOk }),
  ];
  const seen: number[] = [];
  const done = await waitForJob(
    () => {
      const next = sequence.shift();
      if (!next) throw new Error("consultou demais");
      return Promise.resolve(next);
    },
    baixaJob(),
    { sleep: noSleep, onProgress: (j) => seen.push(j.atual) },
  );
  assert.equal(done.resultado?.total_sucessos, 3);
  assert.deepEqual(seen, [0, 1, 2, 3]);
});

void test("job com erro vira exceção com a mensagem do backend", async () => {
  await assert.rejects(
    waitForJob(() => Promise.resolve(baixaJob({ status: "erro", erro: "Token do Tiny inválido" })), baixaJob(), {
      sleep: noSleep,
    }),
    /Token do Tiny inválido/,
  );
});

void test("404 (tarefa perdida) não é re-tentado", async () => {
  let calls = 0;
  await assert.rejects(
    waitForJob(
      () => {
        calls += 1;
        return Promise.reject(new JobLostError());
      },
      baixaJob(),
      { sleep: noSleep },
    ),
    (e: unknown) => e instanceof JobLostError && e.message === JOB_LOST_MESSAGE,
  );
  assert.equal(calls, 1);
});

void test("falhas transitórias são toleradas até o limite", async () => {
  let calls = 0;
  const done = await waitForJob(
    () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error("HTTP 502"));
      return Promise.resolve(baixaJob({ status: "concluido", resultado: baixaOk }));
    },
    baixaJob(),
    { sleep: noSleep },
  );
  assert.equal(done.status, "concluido");
  await assert.rejects(
    waitForJob(() => Promise.reject(new Error("HTTP 502")), baixaJob(), { sleep: noSleep, maxConsecutiveErrors: 2 }),
    /HTTP 502/,
  );
});

void test("abortar interrompe o polling", async () => {
  const controller = new AbortController();
  const pending = waitForJob(() => Promise.resolve(baixaJob()), baixaJob(), {
    signal: controller.signal,
    intervalMs: 10_000,
  });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof DOMException && e.name === "AbortError");
});

void test("job já concluído na criação não consulta de novo", async () => {
  const done = await waitForJob(
    () => Promise.reject(new Error("não deveria consultar")),
    baixaJob({ status: "concluido", resultado: baixaOk }),
  );
  assert.equal(done.status, "concluido");
});

void test("linha de andamento e barra determinada", () => {
  assert.deepEqual(describeJobProgress({ etapa: "Revesta: contas a pagar no Tiny", atual: 2, total: 4 }, "filiais"), {
    percent: 50,
    label: "Revesta: contas a pagar no Tiny · 2 de 4 filiais",
  });
  assert.deepEqual(describeJobProgress({ etapa: "Baixando conta #77", atual: 12, total: 63 }), {
    percent: 19,
    label: "Baixando conta #77 · 12 de 63",
  });
  assert.deepEqual(describeJobProgress({ etapa: "", atual: 0, total: 0 }), { percent: null, label: "Processando…" });
  assert.equal(describeJobProgress({ etapa: "x", atual: 9, total: 4 }).percent, 100);
});

void test("tempo decorrido", () => {
  assert.equal(formatElapsed(0), "0 s");
  assert.equal(formatElapsed(45_900), "45 s");
  assert.equal(formatElapsed(125_000), "2 min 05 s");
  assert.equal(formatElapsed(-5), "0 s");
});

void test("describeDadosDe mostra o horário de Brasília e avisa quando veio do cache", () => {
  const agora = new Date("2026-09-28T15:00:00Z");
  assert.equal(
    describeDadosDe("2026-09-28T13:42:10+00:00", true, agora),
    "Dados do Inter e do Tiny consultados às 10:42 (reaproveitados). Clique em Comparar para consultar de novo.",
  );
  assert.equal(describeDadosDe("2026-09-28T13:42:10+00:00", false, agora), "Dados do Inter e do Tiny consultados às 10:42.");
  assert.equal(
    describeDadosDe("2026-09-27T13:42:10+00:00", false, agora),
    "Dados do Inter e do Tiny consultados em 27/09 às 10:42.",
  );
  assert.equal(describeDadosDe(undefined, true, agora), null);
  assert.equal(describeDadosDe("lixo", true, agora), null);
});
