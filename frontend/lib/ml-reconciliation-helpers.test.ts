import test from 'node:test';
import assert from 'node:assert/strict';
import type { MlComparativo, MlExecucaoJob, MlExecucaoResumo, MlGrupo } from './ml-reconciliation-contracts';
import {
  casamentoMeta,
  comparativoNoFiltro,
  conexoesFaltando,
  erroPeriodo,
  grupoCombinaBusca,
  grupoNoFiltro,
  lancamentoNoFluxo,
  nomeDoArquivo,
  pendenciaMotivoMeta,
  pendenciaNoFluxo,
  periodoTexto,
  situacaoMeta,
  somaSelecionados,
  waitForMlJob,
} from './ml-reconciliation-helpers';
import { JobLostError } from './reconciliation-helpers';
import { demoMlReconciliation } from './demo-ml-reconciliation';

function grupo(id: string, situacao: string, extra: Partial<MlGrupo> = {}): MlGrupo {
  return {
    id,
    id_venda: '2000013231387746',
    data: '01/09/2025',
    nome_cliente: 'Lucas Teixeira',
    valor_total: 29.38,
    quantidade_movimentos: 1,
    situacao,
    mensagem: '',
    apto_baixa: situacao === 'APTO PARA BAIXA',
    conta_id: 894315320,
    conta_situacao: 'aberto',
    conta_historico: '',
    conta_valor: null,
    conta_saldo: null,
    conta_valor_pago: null,
    baixado_em: '',
    ...extra,
  };
}

function job(status: MlExecucaoJob['status'], extra: Partial<MlExecucaoJob> = {}): MlExecucaoJob {
  return {
    job_id: 'j1', tipo: 'ml_executar', status, etapa: '', atual: 0, total: 0,
    iniciado_em: '', concluido_em: null, erro: null, resultado: null, ...extra,
  };
}

void test('situação do recebimento vira rótulo e cor', () => {
  assert.deepEqual(situacaoMeta('APTO PARA BAIXA'), { label: 'Apto para baixa', tone: 'info' });
  assert.deepEqual(situacaoMeta('STATUS: PAGO'), { label: 'Já pago no Tiny', tone: 'secondary' });
  assert.deepEqual(situacaoMeta('STATUS: CANCELADA'), { label: 'Tiny: cancelada', tone: 'secondary' });
  assert.equal(situacaoMeta('ERRO API').tone, 'danger');
  assert.deepEqual(situacaoMeta('VALOR DIVERGENTE'), { label: 'Valor acima do saldo', tone: 'danger' });
  assert.equal(situacaoMeta('outra').label, 'outra');
});

void test('filtros separam aptos, baixados, já pagos e pendências', () => {
  const grupos = [
    grupo('a', 'APTO PARA BAIXA'),
    grupo('b', 'CONCILIADO'),
    grupo('c', 'STATUS: PAGO'),
    grupo('d', 'NÃO LOCALIZADO'),
    grupo('e', 'Não conciliado'),
    grupo('f', 'VALOR DIVERGENTE'),
  ];
  const ids = (f: Parameters<typeof grupoNoFiltro>[1]) => grupos.filter((g) => grupoNoFiltro(g, f)).map((g) => g.id);
  assert.deepEqual(ids('aptos'), ['a']);
  assert.deepEqual(ids('conciliados'), ['b']);
  assert.deepEqual(ids('ja_baixados'), ['c']);
  assert.deepEqual(ids('pendentes'), ['d', 'e', 'f']);
  assert.equal(ids('todos').length, 6);
});

void test('busca ignora acento e caixa e procura também venda e conta', () => {
  const g = grupo('a', 'APTO PARA BAIXA', { nome_cliente: 'José Antônio' });
  assert.ok(grupoCombinaBusca(g, 'jose antonio'));
  assert.ok(grupoCombinaBusca(g, '3231387746'));
  assert.ok(grupoCombinaBusca(g, '894315320'));
  assert.ok(!grupoCombinaBusca(g, 'maria'));
  assert.ok(grupoCombinaBusca(g, '  '));
});

void test('soma dos selecionados sem erro de ponto flutuante', () => {
  const grupos = [grupo('a', 'APTO PARA BAIXA', { valor_total: 0.1 }), grupo('b', 'APTO PARA BAIXA', { valor_total: 0.2 }), grupo('c', 'APTO PARA BAIXA', { valor_total: 5 })];
  assert.equal(somaSelecionados(grupos, new Set(['a', 'b'])), 0.3);
});

function comp(casou_por: MlComparativo['casou_por'], observacao = ''): MlComparativo {
  return {
    id_pagamento: '1', data: '01/09/2025', valor_liberado: 10, casou_por, id_pedido: '', id_pacote: '',
    id_pedido_relatorio: '', nome_cliente: '', status_venda: '', observacao,
  };
}

void test('comparativo vendas × recebimentos: rótulo e filtros', () => {
  assert.equal(casamentoMeta('pagamento').tone, 'success');
  assert.equal(casamentoMeta('pedido').label, 'Pelo pedido do relatório');
  const itens = [comp('pagamento'), comp('pedido', 'só pelo pedido'), comp('sem_venda', 'sem venda')];
  const n = (f: Parameters<typeof comparativoNoFiltro>[1]) => itens.filter((c) => comparativoNoFiltro(c, f)).length;
  assert.equal(n('conferir'), 2);
  assert.equal(n('pagamento'), 1);
  assert.equal(n('sem_venda'), 1);
  assert.equal(n('todos'), 3);
});

void test('período: texto e validação iguais ao backend', () => {
  assert.equal(periodoTexto('2025-09-01', '2025-09-01'), '01/09/2025');
  assert.equal(periodoTexto('2025-09-01', '2025-09-15'), '01/09/2025 a 15/09/2025');
  assert.equal(erroPeriodo('2025-09-01', '2025-09-30', '2025-10-05'), null);
  assert.match(erroPeriodo('2025-09-02', '2025-09-01', '2025-10-05')!, /depois da data final/);
  assert.match(erroPeriodo('2025-09-01', '2025-10-06', '2025-10-05')!, /depois de hoje/);
  assert.match(erroPeriodo('2025-07-01', '2025-09-30', '2025-10-05')!, /60 dias/);
  assert.equal(erroPeriodo('2025-08-02', '2025-09-30', '2025-10-05'), null); // exatamente 60 dias
});

void test('conexões sem token pelo nome', () => {
  assert.deepEqual(conexoesFaltando({ conexoes: { mercado_pago: false, mercado_livre: true, tiny: false } }), ['Mercado Pago', 'Tiny']);
  assert.deepEqual(conexoesFaltando({ conexoes: { mercado_pago: true, mercado_livre: true, tiny: true } }), []);
});

void test('nome do arquivo vem do Content-Disposition (UTF-8 ou simples)', () => {
  assert.equal(
    nomeDoArquivo("attachment; filename*=UTF-8''LAN%C3%87AMENTOS%20DE%20CAIXA.xlsx", 'x.xlsx'),
    'LANÇAMENTOS DE CAIXA.xlsx',
  );
  assert.equal(nomeDoArquivo('attachment; filename="saldo.xlsx"', 'x.xlsx'), 'saldo.xlsx');
  assert.equal(nomeDoArquivo(null, 'x.xlsx'), 'x.xlsx');
});

void test('waitForMlJob acompanha até concluir e tolera falha isolada de rede', async () => {
  const respostas: Array<() => MlExecucaoJob> = [
    () => { throw new Error('rede'); },
    () => job('executando', { atual: 1, total: 2 }),
    () => job('concluido', { resultado: {} as MlExecucaoResumo }),
  ];
  const progresso: number[] = [];
  const final = await waitForMlJob(async () => respostas.shift()!(), job('executando'), {
    sleep: async () => undefined,
    onProgress: (j) => progresso.push(j.atual),
  });
  assert.equal(final.status, 'concluido');
  assert.deepEqual(progresso, [0, 1, 0]);
});

void test('waitForMlJob: erro da tarefa e tarefa perdida', async () => {
  await assert.rejects(
    waitForMlJob(async () => job('erro', { erro: 'Relatório não ficou pronto' }), job('executando'), { sleep: async () => undefined }),
    /Relatório não ficou pronto/,
  );
  await assert.rejects(
    waitForMlJob(async () => { throw new JobLostError(); }, job('executando'), { sleep: async () => undefined }),
    JobLostError,
  );
});

void test('demonstração: rotina diária já executada, execução manual e baixa seguem o contrato da API', () => {
  const status = demoMlReconciliation.status();
  assert.deepEqual(status.empresas.map((e) => e.id), ['norvia_campinas', 'revesta']);
  assert.equal(status.ultima_execucao?.origem, 'agendada');
  const analiseId = status.empresas[0]!.ultima_analise!.analise_id;
  const analise = demoMlReconciliation.analise(analiseId)!;
  assert.ok(analise.comparativo.length > 0 && analise.resumo.aptos_baixa > 0);
  assert.ok(demoMlReconciliation.execucao(status.ultima_execucao!.id)!.log.length > 3);

  const exec = demoMlReconciliation.executar({ empresas: ['revesta'] });
  assert.equal(exec.tipo, 'ml_executar');
  assert.equal(demoMlReconciliation.job(exec.job_id)!.status, 'executando');
  assert.ok(demoMlReconciliation.status().em_execucao);

  const aptos = analise.grupos.filter((g) => g.apto_baixa).map((g) => g.id);
  const baixa = demoMlReconciliation.iniciarBaixa(analiseId, aptos)!;
  assert.equal(baixa.tipo, 'ml_baixar');
  assert.equal(demoMlReconciliation.iniciarBaixa('nada', aptos), null);
});

void test('filtros por fluxo separam recebimentos MP (entradas) e pagamentos MP (saídas)', () => {
  const l1 = { indice: 1, data: '01/09/2025', categoria: 'Cat', historico: 'H', tipo: 'C' as const, valor: 100, contato: '', cnpj: '', conta: 'C', numero_documento: '1', tipo_operacao: 'Recebimento', fluxo: 'RECEBIMENTO' as const };
  const l2 = { indice: 2, data: '01/09/2025', categoria: 'Cat', historico: 'H', tipo: 'D' as const, valor: 15, contato: '', cnpj: '', conta: 'C', numero_documento: '2', tipo_operacao: 'Tarifa', fluxo: 'PAGAMENTO' as const };

  assert.equal(lancamentoNoFluxo(l1, 'todos'), true);
  assert.equal(lancamentoNoFluxo(l1, 'recebimentos'), true);
  assert.equal(lancamentoNoFluxo(l1, 'pagamentos'), false);

  assert.equal(lancamentoNoFluxo(l2, 'recebimentos'), false);
  assert.equal(lancamentoNoFluxo(l2, 'pagamentos'), true);

  const p1 = { indice: 1, data: '01/09/2025', tipo_operacao: 'Liberação', operacao_relacionada: '', id_venda: '', nome_cliente: '', valor: 20, motivo: 'retenção anterior', fluxo: 'RECEBIMENTO' as const };
  const p2 = { indice: 2, data: '01/09/2025', tipo_operacao: 'Retenção', operacao_relacionada: '', id_venda: '', nome_cliente: '', valor: -20, motivo: 'liberação futura', fluxo: 'PAGAMENTO' as const };

  assert.equal(pendenciaNoFluxo(p1, 'recebimentos'), true);
  assert.equal(pendenciaNoFluxo(p1, 'pagamentos'), false);
  assert.equal(pendenciaNoFluxo(p2, 'pagamentos'), true);
});

void test('pendenciaMotivoMeta identifica categorias de motivos amigáveis', () => {
  assert.equal(pendenciaMotivoMeta('Não encontrado par no Tiny').label, 'Sem par no Tiny');
  assert.equal(pendenciaMotivoMeta('Não encontrado par no Mercado Livre').label, 'Sem par no ML');
  assert.equal(pendenciaMotivoMeta('Dinheiro retido aguardando liberação futura').label, 'Dinheiro retido (futuro)');
});
