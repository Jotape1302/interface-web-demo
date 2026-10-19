// Dados fictícios da Conciliação Mercado Livre × Contas a Receber Tiny para o modo demonstração.
// Imita a API: execução diária já feita (análises das duas empresas), execução manual com
// progresso por etapa, histórico com log e baixa recebimento a recebimento.
// O estado vive em memória e volta ao início ao recarregar a página.

import type {
  MlAnalise,
  MlAnaliseResumo,
  MlAnalisesResponse,
  MlBaixaJob,
  MlBaixaResultado,
  MlComparativo,
  MlExecucaoDetalhe,
  MlExecucaoJob,
  MlExecucaoResumo,
  MlExecucoesResponse,
  MlExecutarPedido,
  MlGrupo,
  MlJob,
  MlLancamento,
  MlLinhaLog,
  MlPendencia,
  MlResumo,
  MlStatus,
} from './ml-reconciliation-contracts';

const ETAPA_MS = 700;
const BAIXA_POR_GRUPO_MS = 600;

const EMPRESAS = [
  { id: 'norvia_campinas', nome: 'Norvia Campinas', conta: 'Mercado Livre - NORVIA' },
  { id: 'revesta', nome: 'Revesta', conta: 'Mercado Livre - REVESTA' },
] as const;

const CLIENTES = [
  'Mariana Alves', 'Rafael Costa', 'Juliana Prado', 'Carlos Menezes', 'Patrícia Ramos', 'Bruno Teixeira',
  'Fernanda Lopes', 'Gustavo Nunes', 'Aline Rocha', 'Thiago Martins', 'Camila Duarte', 'Eduardo Pires',
];

const ETAPAS = [
  'Pedindo o relatório de liberações ao Mercado Pago',
  'Aguardando o Mercado Pago gerar o relatório de liberações',
  'Lendo vendas do Mercado Livre',
  'Lendo os pedidos do Tiny',
  'Consultando contas a receber no Tiny',
  'Gerando lançamentos de caixa',
];

function isoDia(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function br(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

function centavos(v: number) {
  return Math.round(v * 100);
}

function montarAnalise(id: string, empresaIdx: number, de: string, ate: string, origem: 'agendada' | 'manual', execucaoId: string): MlAnalise {
  const empresa = EMPRESAS[empresaIdx]!;
  const data = br(ate);
  const grupos: MlGrupo[] = [];
  const lancamentos: MlLancamento[] = [];
  const comparativo: MlComparativo[] = [];
  const clientes = CLIENTES.slice(empresaIdx * 3, empresaIdx * 3 + 9);
  clientes.forEach((cliente, i) => {
    const pedido = `20000130${String(31387746 + i * 7919 + empresaIdx * 101).padStart(8, '0')}`;
    const pacote = i % 3 === 0 ? `20000099${String(1200 + i).padStart(8, '0')}` : '';
    const venda = pacote || pedido;
    const pagamento = String(123868190197 + i + empresaIdx * 1000);
    const valor = Math.round((89.9 + i * 37.35) * 100) / 100;
    const tarifa = Math.round(valor * 0.16 * 100) / 100;
    const situacao = i % 6 === 4 ? 'STATUS: PAGO' : i % 6 === 5 ? 'NÃO LOCALIZADO' : i === 7 ? 'VALOR DIVERGENTE' : 'APTO PARA BAIXA';
    const contaId = situacao === 'NÃO LOCALIZADO' ? null : 894315320 + i + empresaIdx * 100;
    const contaValor = situacao === 'VALOR DIVERGENTE' ? valor - 15 : valor;
    grupos.push({
      id: `G-${i * 3}`,
      id_venda: venda,
      data,
      nome_cliente: cliente,
      valor_total: valor,
      quantidade_movimentos: 1,
      situacao,
      mensagem:
        situacao === 'NÃO LOCALIZADO'
          ? `Nenhuma conta de ${cliente} cita a venda ${venda} no histórico.`
          : situacao === 'STATUS: PAGO'
            ? 'Conta já não está em aberto no Tiny: não requer baixa.'
            : situacao === 'VALOR DIVERGENTE'
              ? `Recebido R$ ${valor.toFixed(2)} é maior que o saldo em aberto da conta (R$ ${contaValor.toFixed(2)}). Confira no Tiny antes de baixar à mão.`
              : '',
      apto_baixa: situacao === 'APTO PARA BAIXA',
      conta_id: contaId,
      conta_situacao: situacao === 'STATUS: PAGO' ? 'pago' : contaId ? 'aberto' : '',
      conta_historico: contaId ? `Ref. ao pedido de venda nº ${28700 + i}, OC nº ${venda} - parcela 1/1` : '',
      conta_valor: contaId ? contaValor : null,
      conta_saldo: contaId ? (situacao === 'STATUS: PAGO' ? 0 : contaValor) : null,
      conta_valor_pago: situacao === 'STATUS: PAGO' ? valor : contaId ? 0 : null,
      baixado_em: '',
    });
    lancamentos.push({
      indice: i * 3 + 1,
      data,
      categoria: 'Intermediação de Negócios',
      historico: `Ref as tarifas sobre a venda ${venda}, operação ${pagamento} - Tarifa de venda`,
      tipo: 'D',
      valor: tarifa,
      contato: cliente,
      cnpj: `${String(100 + i).padStart(3, '0')}.458.618-43`,
      conta: empresa.conta,
      numero_documento: pagamento,
      tipo_operacao: 'Tarifa de venda',
    });
    if (i % 4 === 1) {
      lancamentos.push({
        indice: i * 3 + 2,
        data,
        categoria: 'Fretes sobre Vendas',
        historico: `Ref ao frete sobre a venda ${venda}, operação ${pagamento} - Tarifa de envio`,
        tipo: 'D',
        valor: 18.9,
        contato: cliente,
        cnpj: `${String(100 + i).padStart(3, '0')}.458.618-43`,
        conta: empresa.conta,
        numero_documento: pagamento,
        tipo_operacao: 'Tarifa de envio',
      });
    }
    const porPedido = i === 2;
    comparativo.push({
      id_pagamento: pagamento,
      data,
      valor_liberado: Math.round((valor - tarifa - (i % 4 === 1 ? 18.9 : 0)) * 100) / 100,
      casou_por: porPedido ? 'pedido' : 'pagamento',
      id_pedido: pedido,
      id_pacote: pacote,
      id_pedido_relatorio: pedido,
      nome_cliente: cliente,
      status_venda: 'paid',
      observacao: porPedido ? 'Venda localizada só pelo pedido do relatório: o pagamento não consta no pedido do Mercado Livre.' : '',
    });
  });
  grupos.push({
    id: 'G-90',
    id_venda: '',
    data,
    nome_cliente: '',
    valor_total: 30,
    quantidade_movimentos: 1,
    situacao: 'Não conciliado',
    mensagem: 'Recebimento sem venda do Mercado Livre ligada ao pagamento.',
    apto_baixa: false,
    conta_id: null,
    conta_situacao: '',
    conta_historico: '',
    conta_valor: null,
    conta_saldo: null,
    conta_valor_pago: null,
    baixado_em: '',
  });
  comparativo.push({
    id_pagamento: '125001122334',
    data,
    valor_liberado: 30,
    casou_por: 'sem_venda',
    id_pedido: '',
    id_pacote: '',
    id_pedido_relatorio: '',
    nome_cliente: '',
    status_venda: '',
    observacao: 'Pagamento sem venda no Mercado Livre (tarifa avulsa, publicidade, saque ou venda fora do período buscado).',
  });
  const pendencias: MlPendencia[] = [
    { indice: 91, data, tipo_operacao: 'Pagamento', operacao_relacionada: '125001122399', id_venda: '', nome_cliente: '', valor: -42.5, motivo: 'Movimento sem par que o anule no mesmo pagamento.' },
    { indice: 92, data, tipo_operacao: 'Diferença na liberação', operacao_relacionada: String(123868190199 + empresaIdx * 1000), id_venda: '', nome_cliente: '', valor: -0.37, motivo: 'Bruto menos tarifas, frete, impostos e cupom não fecha com o líquido liberado pelo Mercado Pago.' },
  ];
  const analise: MlAnalise = {
    analise_id: id,
    empresa: empresa.id,
    empresa_nome: empresa.nome,
    criada_em: new Date().toISOString(),
    periodo_de: de,
    periodo_ate: ate,
    origem,
    execucao_id: execucaoId,
    fontes: { liberacoes: 14 + clientes.length * 2, pedidos_ml: 412 + empresaIdx * 97, pedidos_tiny: 455 + empresaIdx * 88 },
    tiny_consultado: true,
    avisos: [],
    resumo: {} as MlResumo,
    grupos,
    lancamentos,
    pendencias,
    comparativo,
    saldo_recebimentos_dia: [],
    saldo_total_dia: [],
  };
  recalcular(analise);
  return analise;
}

function recalcular(a: MlAnalise) {
  const porSituacao: Record<string, number> = {};
  for (const g of a.grupos) porSituacao[g.situacao] = (porSituacao[g.situacao] ?? 0) + 1;
  const aptos = a.grupos.filter((g) => g.apto_baixa);
  const somaPorDia = new Map<string, number>();
  for (const g of a.grupos) somaPorDia.set(g.data, (somaPorDia.get(g.data) ?? 0) + centavos(g.valor_total));
  const totalPorDia = new Map(somaPorDia);
  for (const l of a.lancamentos) totalPorDia.set(l.data, (totalPorDia.get(l.data) ?? 0) + (l.tipo === 'C' ? 1 : -1) * centavos(l.valor));
  const ordenar = (m: Map<string, number>) =>
    [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([data, c]) => ({ data, valor: c / 100 }));
  a.saldo_recebimentos_dia = ordenar(somaPorDia);
  a.saldo_total_dia = ordenar(totalPorDia);
  const casamentos: MlResumo['pagamentos_por_casamento'] = {};
  for (const c of a.comparativo) casamentos[c.casou_por] = (casamentos[c.casou_por] ?? 0) + 1;
  a.resumo = {
    total_movimentos: a.grupos.reduce((s, g) => s + g.quantidade_movimentos, 0) + a.lancamentos.length + a.pendencias.length + 4,
    total_grupos: a.grupos.length,
    grupos_por_situacao: porSituacao,
    aptos_baixa: aptos.length,
    valor_aptos_baixa: aptos.reduce((s, g) => s + centavos(g.valor_total), 0) / 100,
    conciliados: porSituacao['CONCILIADO'] ?? 0,
    total_lancamentos: a.lancamentos.length,
    valor_creditos: a.lancamentos.filter((l) => l.tipo === 'C').reduce((s, l) => s + centavos(l.valor), 0) / 100,
    valor_debitos: a.lancamentos.filter((l) => l.tipo === 'D').reduce((s, l) => s + centavos(l.valor), 0) / 100,
    total_anuladas: 4,
    total_pendencias: a.pendencias.length,
    valor_recebimentos: a.grupos.reduce((s, g) => s + centavos(g.valor_total), 0) / 100,
    valor_liquido: a.saldo_total_dia.reduce((s, d) => s + centavos(d.valor), 0) / 100,
    total_recebimentos_mp: a.grupos.length + a.lancamentos.filter((l) => l.tipo === 'C').length,
    valor_recebimentos_mp: (a.grupos.reduce((s, g) => s + centavos(g.valor_total), 0) + a.lancamentos.filter((l) => l.tipo === 'C').reduce((s, l) => s + centavos(l.valor), 0)) / 100,
    total_pagamentos_mp: a.lancamentos.filter((l) => l.tipo === 'D').length,
    valor_pagamentos_mp: a.lancamentos.filter((l) => l.tipo === 'D').reduce((s, l) => s + centavos(l.valor), 0) / 100,
    pagamentos: a.comparativo.length,
    pagamentos_por_casamento: casamentos,
    pagamentos_com_observacao: a.comparativo.filter((c) => c.observacao).length,
  };
}

function cabecalho(a: MlAnalise): MlAnaliseResumo {
  const { grupos: _g, lancamentos: _l, pendencias: _p, comparativo: _c, saldo_recebimentos_dia: _s1, saldo_total_dia: _s2, ...resto } = a;
  return resto;
}

interface Registro {
  job: MlJob;
  iniciado: number;
  executar: (job: MlJob, decorridoMs: number) => void;
}

const estado = {
  proximo: 0,
  iniciado: false,
  analises: new Map<string, MlAnalise>(),
  execucoes: [] as MlExecucaoDetalhe[],
  jobs: new Map<string, Registro>(),
  emExecucao: null as MlStatus['em_execucao'],
  progresso: null as MlStatus['progresso'],
};

function novoId(prefixo: string) {
  estado.proximo += 1;
  return `${prefixo}-demo-${estado.proximo.toString(16).padStart(6, '0')}`;
}

function linha(nivel: MlLinhaLog['nivel'], empresa: string, mensagem: string): MlLinhaLog {
  return { em: new Date().toISOString(), nivel, empresa, mensagem };
}

/** Cria as análises das empresas e o registro da execução (com log), como a rotina faz. */
function registrarExecucao(origem: 'agendada' | 'manual', de: string, ate: string, empresas: string[]): MlExecucaoDetalhe {
  const id = novoId('exec');
  const log: MlLinhaLog[] = [linha('info', '', `Execução ${origem} iniciada: liberações de ${br(de)} a ${br(ate)}.`)];
  const resultado: MlExecucaoDetalhe['empresas'] = {};
  for (const empId of empresas) {
    const idx = EMPRESAS.findIndex((e) => e.id === empId);
    const emp = EMPRESAS[idx]!;
    const a = montarAnalise(novoId('analise'), idx, de, ate, origem, id);
    estado.analises.set(a.analise_id, a);
    const casam = a.resumo.pagamentos_por_casamento;
    log.push(
      linha('info', emp.nome, `Mercado Pago: ${a.fontes.liberacoes} linha(s) no relatório de liberações.`),
      linha('info', emp.nome, `Mercado Livre: ${a.fontes.pedidos_ml} pedido(s) nos últimos 60 dias.`),
      linha('info', emp.nome, `Tiny: ${a.fontes.pedidos_tiny} pedido(s) de venda no mesmo intervalo.`),
      linha('info', emp.nome, `Vendas × recebimentos: ${a.resumo.pagamentos} pagamento(s); ${casam.pagamento ?? 0} pelo ID do pagamento, ${casam.pedido ?? 0} pelo pedido do relatório, ${casam.sem_venda ?? 0} sem venda.`),
      linha('aviso', emp.nome, `Cliente '${CLIENTES[idx * 3 + 5]}' sem conta a receber que cite a venda.`),
      linha('info', emp.nome, `${a.resumo.aptos_baixa} apto(s) para baixa; ${a.resumo.total_lancamentos} lançamento(s) de caixa; ${a.resumo.total_pendencias} pendência(s).`),
    );
    resultado[empId] = { status: 'ok', analise_id: a.analise_id, resumo: a.resumo, mensagem: '' };
  }
  log.push(linha('info', '', 'Execução concluída (ok).'));
  const agora = new Date().toISOString();
  const execucao: MlExecucaoDetalhe = {
    id,
    tipo: 'analise',
    origem,
    iniciada_em: agora,
    concluida_em: agora,
    status: 'ok',
    periodo_de: de,
    periodo_ate: ate,
    empresas: resultado,
    log,
  };
  estado.execucoes.push(execucao);
  return execucao;
}

function semLog(e: MlExecucaoDetalhe): MlExecucaoResumo {
  const { log, ...resto } = e;
  return {
    ...resto,
    linhas_log: log.length,
    erros_log: log.filter((l) => l.nivel === 'erro').length,
    avisos_log: log.filter((l) => l.nivel === 'aviso').length,
  };
}

function iniciar() {
  if (estado.iniciado) return;
  estado.iniciado = true;
  const ontem = isoDia(-1);
  const d60 = isoDia(-60);
  const exec = registrarExecucao('agendada', ontem, ontem, EMPRESAS.map((e) => e.id));
  for (let idx = 0; idx < EMPRESAS.length; idx++) {
    const emp = EMPRESAS[idx]!;
    const aConsolidada = montarAnalise(`consolidado_${emp.id}`, idx, d60, ontem, 'agendada', exec.id);
    estado.analises.set(aConsolidada.analise_id, aConsolidada);
  }
}

function base(tipo: MlJob['tipo'], etapa: string, total: number) {
  return {
    job_id: novoId('job'),
    tipo,
    status: 'executando' as const,
    etapa,
    atual: 0,
    total,
    iniciado_em: new Date().toISOString(),
    concluido_em: null,
    erro: null,
    resultado: null,
  };
}

export const demoMlReconciliation = {
  status(): MlStatus {
    iniciar();
    const ultimas = new Map<string, MlAnaliseResumo>();
    for (const a of estado.analises.values()) ultimas.set(a.empresa, cabecalho(a));
    const analisesExec = estado.execucoes.filter((e) => e.tipo === 'analise');
    const proxima = new Date();
    proxima.setDate(proxima.getDate() + (proxima.getHours() >= 8 ? 1 : 0));
    proxima.setHours(8, 0, 0, 0);
    return {
      empresas: EMPRESAS.map((e) => ({
        id: e.id,
        nome: e.nome,
        conta_lancamento: e.conta,
        conexoes: { mercado_pago: true, mercado_livre: true, tiny: true },
        ultima_analise: ultimas.get(e.id) ?? null,
      })),
      em_execucao: estado.emExecucao,
      progresso: estado.progresso,
      ultima_execucao: analisesExec.length ? semLog(analisesExec[analisesExec.length - 1]!) : null,
      proxima_execucao: proxima.toISOString(),
      hora_diaria: 8,
      periodo_padrao: [isoDia(-60), isoDia(-1)],
      erro_gravacao: null,
    };
  },

  executar(pedido: MlExecutarPedido): MlExecucaoJob {
    iniciar();
    const de = pedido.de ?? isoDia(-1);
    const ate = pedido.ate ?? de;
    const empresas = pedido.empresas?.length ? pedido.empresas : EMPRESAS.map((e) => e.id);
    const job = base('ml_executar', ETAPAS[0]!, 0) as MlExecucaoJob;
    estado.emExecucao = { execucao_id: job.job_id, iniciada_em: job.iniciado_em, origem: 'manual' };
    estado.jobs.set(job.job_id, {
      job,
      iniciado: Date.now(),
      executar: (j, decorrido) => {
        const passo = Math.floor(decorrido / ETAPA_MS);
        const total = ETAPAS.length * empresas.length;
        const empresa = EMPRESAS.find((e) => e.id === empresas[Math.min(Math.floor(passo / ETAPAS.length), empresas.length - 1)]);
        j.etapa = `${empresa?.nome}: ${ETAPAS[passo % ETAPAS.length]}`;
        estado.progresso = { etapa: j.etapa, atual: 0, total: 0, empresa: empresa?.nome ?? '' };
        if (passo >= total) {
          const execucao = registrarExecucao('manual', de, ate, empresas);
          estado.emExecucao = null;
          estado.progresso = null;
          Object.assign(j, { status: 'concluido', etapa: 'Conciliação concluída', concluido_em: new Date().toISOString(), resultado: semLog(execucao) });
        }
      },
    });
    return structuredClone(job);
  },

  execucoes(limit: number): MlExecucoesResponse {
    iniciar();
    const itens = [...estado.execucoes].reverse().slice(0, limit).map(semLog);
    return { itens, total: estado.execucoes.length };
  },

  execucao(id: string): MlExecucaoDetalhe | null {
    const e = estado.execucoes.find((x) => x.id === id);
    return e ? structuredClone(e) : null;
  },

  analises(empresa: string, limit: number): MlAnalisesResponse {
    iniciar();
    const filtradas = [...estado.analises.values()].filter((a) => a.empresa === empresa);
    const consolidadas = filtradas.filter((a) => a.analise_id.startsWith('consolidado_'));
    const normais = filtradas.filter((a) => !a.analise_id.startsWith('consolidado_')).reverse();
    const itens = [...consolidadas, ...normais].slice(0, limit).map(cabecalho);
    return { itens: structuredClone(itens), total: itens.length };
  },

  iniciarBaixa(analiseId: string, grupoIds: string[]): MlBaixaJob | null {
    const analise = estado.analises.get(analiseId);
    if (!analise) return null;
    const job = base('ml_baixar', 'Iniciando baixa', grupoIds.length) as MlBaixaJob;
    const resultados: MlBaixaResultado[] = [];
    estado.jobs.set(job.job_id, {
      job,
      iniciado: Date.now(),
      executar: (j, decorrido) => {
        const feitos = Math.min(grupoIds.length, Math.floor(decorrido / BAIXA_POR_GRUPO_MS));
        for (let n = resultados.length; n < feitos; n++) {
          const g = analise.grupos.find((x) => x.id === grupoIds[n]);
          if (!g || !g.apto_baixa) {
            resultados.push({ grupo_id: grupoIds[n]!, status: 'ignorado', mensagem: 'Recebimento não está apto para baixa.' });
            continue;
          }
          Object.assign(g, { situacao: 'CONCILIADO', apto_baixa: false, conta_situacao: 'pago', conta_saldo: 0, conta_valor_pago: g.valor_total, baixado_em: isoDia(0) });
          resultados.push({ grupo_id: g.id, conta_id: g.conta_id, id_venda: g.id_venda, nome_cliente: g.nome_cliente, valor: g.valor_total, status: 'sucesso', mensagem: `Conta #${g.conta_id} baixada no Tiny.` });
        }
        j.atual = feitos;
        const atual = analise.grupos.find((x) => x.id === grupoIds[Math.min(feitos, grupoIds.length - 1)]);
        j.etapa = `Baixando conta #${atual?.conta_id ?? '—'} (${atual?.nome_cliente || '—'})`;
        if (feitos >= grupoIds.length) {
          recalcular(analise);
          const sucessos = resultados.filter((r) => r.status === 'sucesso').length;
          const ignorados = resultados.filter((r) => r.status === 'ignorado').length;
          const agora = new Date().toISOString();
          estado.execucoes.push({
            id: novoId('exec'),
            tipo: 'baixa',
            origem: 'manual',
            usuario: 'Usuário demonstração',
            iniciada_em: agora,
            concluida_em: agora,
            status: 'ok',
            periodo_de: analise.periodo_de,
            periodo_ate: analise.periodo_ate,
            empresas: { [analise.empresa]: { status: 'ok', analise_id: analise.analise_id, mensagem: '', baixa: { sucessos, falhas: 0, ignorados } } },
            log: resultados.map((r) => linha(r.status === 'sucesso' ? 'info' : 'aviso', analise.empresa_nome, r.mensagem)),
          });
          Object.assign(j, {
            status: 'concluido',
            etapa: 'Baixa concluída',
            concluido_em: agora,
            resultado: { status: 'concluido', total_solicitados: grupoIds.length, total_sucessos: sucessos, total_falhas: 0, total_ignorados: ignorados, resultados },
          });
        }
      },
    });
    return structuredClone(job);
  },

  job(jobId: string): MlJob | null {
    const reg = estado.jobs.get(jobId);
    if (!reg) return null;
    if (reg.job.status === 'executando') reg.executar(reg.job, Date.now() - reg.iniciado);
    return structuredClone(reg.job);
  },

  analise(analiseId: string): MlAnalise | null {
    const a = estado.analises.get(analiseId);
    return a ? structuredClone(a) : null;
  },
};
