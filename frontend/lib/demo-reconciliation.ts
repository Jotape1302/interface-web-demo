// Dados fictícios da Conciliação Inter × Tiny (Contas a Pagar) para o modo demonstração. Imita os
// jobs em segundo plano da API (prévia por filial com progresso, baixa conta a conta) e o histórico
// de baixas. Contas baixadas aqui somem das casadas e passam a "já baixadas" na próxima prévia.
// O estado vive em memória e volta ao início ao recarregar a página.

import type {
  AlreadyPaidItem,
  BaixaHistoricoItem,
  BaixaHistoricoQuery,
  BaixaHistoricoResponse,
  BaixaItemInput,
  BaixaJob,
  InternalTransferItem,
  MatchMethod,
  PreviewJob,
  ReconciliationEstadoResponse,
  ReconciliationJob,
  ReconciliationMatch,
  ReconciliationPreviewResponse,
  ReconciliationStatusResponse,
  UnmatchedInterItem,
  UnmatchedTinyItem,
} from './reconciliation-contracts';
import type { PreviewRequestBody } from './reconciliation-service';
import { RECONCILIATION_COMPANIES } from './reconciliation-helpers';

const DIA = 86_400_000;
const PREVIEW_POR_FILIAL_MS = 1_800;
const BAIXA_POR_CONTA_MS = 700;

interface SeedConta {
  fornecedor: string;
  cnpj: string;
  doc: string;
  valor: number;
  diasAntesDoFim: number; // data de pagamento em relação ao fim do período
  metodo: MatchMethod;
  tipo: 'PIX' | 'BOLETO' | 'TED';
  juros?: number;
}

const FORNECEDORES: SeedConta[] = [
  { fornecedor: 'Alumiconte Perfis Ltda', cnpj: '12345678000190', doc: 'NF 18.442', valor: 4_860.0, diasAntesDoFim: 2, metodo: 'CODIGO_BARRAS', tipo: 'BOLETO' },
  { fornecedor: 'Duratex Distribuição S.A.', cnpj: '97837181000147', doc: 'NF 95.113', valor: 12_430.5, diasAntesDoFim: 4, metodo: 'CODIGO_BARRAS', tipo: 'BOLETO' },
  { fornecedor: 'LedBrasil Iluminação', cnpj: '23456789000155', doc: 'NF 7.021', valor: 2_318.9, diasAntesDoFim: 5, metodo: 'CNPJ_VALOR_DATA', tipo: 'PIX' },
  { fornecedor: 'Transportadora Rota Sul', cnpj: '34567890000122', doc: 'CT-e 55.870', valor: 1_145.0, diasAntesDoFim: 6, metodo: 'CNPJ_VALOR', tipo: 'PIX' },
  { fornecedor: 'Granitos Andorinha ME', cnpj: '45678901000133', doc: 'NF 3.318', valor: 6_780.0, diasAntesDoFim: 8, metodo: 'CODIGO_BARRAS', tipo: 'BOLETO', juros: 13.56 },
  { fornecedor: 'Embalagens Paraná Ltda', cnpj: '56789012000144', doc: 'NF 21.906', valor: 894.3, diasAntesDoFim: 9, metodo: 'NOME_VALOR', tipo: 'TED' },
  { fornecedor: 'Copel Distribuição', cnpj: '04368898000106', doc: 'Fatura 09/2026', valor: 1_732.44, diasAntesDoFim: 11, metodo: 'CODIGO_BARRAS', tipo: 'BOLETO' },
  { fornecedor: 'Vivo Empresas', cnpj: '02558157000162', doc: 'Fatura 0926', valor: 389.9, diasAntesDoFim: 12, metodo: 'DOCUMENTO_VALOR', tipo: 'BOLETO' },
  { fornecedor: 'Rodaplast Indústria', cnpj: '67890123000155', doc: 'NF 44.120', valor: 9_215.0, diasAntesDoFim: 14, metodo: 'VALOR_DATA_UNICO', tipo: 'PIX' },
];

const MOTIVO: Record<MatchMethod, string> = {
  CODIGO_BARRAS: 'Código de barras do boleto igual ao da conta no Tiny.',
  CNPJ_VALOR_DATA: 'Mesmo CNPJ do favorecido, mesmo valor e pagamento perto do vencimento.',
  CNPJ_VALOR: 'Mesmo CNPJ do favorecido e mesmo valor.',
  NOME_VALOR: 'Nome do favorecido parecido com o fornecedor e mesmo valor.',
  DOCUMENTO_VALOR: 'Número do documento na descrição do pagamento e mesmo valor.',
  VALOR_DATA_UNICO: 'Único débito com esse valor na data (confira).',
};
const CONFIANCA: Record<MatchMethod, number> = {
  CODIGO_BARRAS: 0.99, CNPJ_VALOR_DATA: 0.95, CNPJ_VALOR: 0.9, NOME_VALOR: 0.8, DOCUMENTO_VALOR: 0.85, VALOR_DATA_UNICO: 0.7,
};

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const companyNome = (id: string) => RECONCILIATION_COMPANIES.find((c) => c.id === id)?.nome ?? id;

// Cada filial recebe uma "fatia" dos fornecedores e ids próprios de conta no Tiny.
function contasDaFilial(idx: number) {
  return FORNECEDORES.filter((_, i) => (i + idx) % 4 !== 0).map((f, i) => ({
    ...f,
    contaId: 700_000 + idx * 10_000 + i * 37,
    valor: Math.round(f.valor * (1 + idx * 0.07) * 100) / 100,
  }));
}

interface Estado {
  baixadas: Map<number, string>; // conta_pagar_id -> data da baixa
  historico: BaixaHistoricoItem[];
  jobs: Map<string, { job: ReconciliationJob; iniciado: number; executar: (j: ReconciliationJob, agora: number) => void }>;
  proximoId: number;
}

let estado: Estado | null = null;
function st(): Estado {
  if (!estado) estado = { baixadas: new Map(), historico: historicoInicial(), jobs: new Map(), proximoId: 1000 };
  return estado;
}

function historicoInicial(): BaixaHistoricoItem[] {
  const itens: BaixaHistoricoItem[] = [];
  let id = 1;
  const lotes: Array<[number, string, string]> = [[1, 'Marina Financeiro', 'norvia_campinas'], [3, 'Marina Financeiro', 'revesta'], [6, 'João', 'fabrilux'], [9, 'Marina Financeiro', 'norvia_curitiba']];
  for (const [diasAtras, usuario, empresa] of lotes) {
    const quando = Date.now() - diasAtras * DIA;
    const lote = idDeLote(diasAtras);
    FORNECEDORES.slice(diasAtras % 3, (diasAtras % 3) + 3).forEach((f, i) => {
      const erro = diasAtras === 6 && i === 2;
      itens.push({
        id: id++,
        lote_id: lote,
        executado_em: new Date(quando + i * 4000).toISOString(),
        usuario_nome: usuario,
        empresa,
        conta_pagar_id: 690_000 + id * 13,
        numero_documento: f.doc,
        fornecedor_nome: f.fornecedor,
        data_vencimento: ymd(quando - DIA),
        data_pagamento: ymd(quando - DIA),
        valor_tiny: f.valor,
        valor_pago: f.valor + (f.juros ?? 0),
        juros: f.juros ?? 0,
        multa: 0,
        desconto: 0,
        inter_transacao_id: idDeLote(diasAtras * 100 + i),
        metodo_match: f.metodo,
        status: erro ? 'erro' : 'sucesso',
        mensagem: erro
          ? 'Tiny recusou a baixa: HTTP 400 — a conta já possui baixa parcial.'
          : `Conta #${690_000 + id * 13} baixada com sucesso no Tiny ERP.`,
      });
    });
  }
  return itens.reverse();
}

function montarPrevia(body: PreviewRequestBody): ReconciliationPreviewResponse {
  const e = st();
  const fim = body.data_fim ? Date.parse(`${body.data_fim}T12:00:00`) : Date.now();
  const inicio = body.data_inicio ? Date.parse(`${body.data_inicio}T12:00:00`) : fim - 30 * DIA;
  const filiais = RECONCILIATION_COMPANIES.filter((c) => !body.empresa || c.id === body.empresa);

  const matches: ReconciliationMatch[] = [];
  const jaBaixadas: AlreadyPaidItem[] = [];
  const semParInter: UnmatchedInterItem[] = [];
  const semParTiny: UnmatchedTinyItem[] = [];
  const transferencias: InternalTransferItem[] = [];

  filiais.forEach((c) => {
    const idx = RECONCILIATION_COMPANIES.indexOf(c);
    contasDaFilial(idx).forEach((f, i) => {
      const pagamento = fim - f.diasAntesDoFim * DIA;
      if (pagamento < inicio) return;
      const transacao = `demo-${c.id}-${f.contaId}`;
      const juros = f.juros ?? 0;
      const base = {
        empresa: c.id,
        empresa_nome: c.nome,
        conta_pagar_id: f.contaId,
        numero_documento: f.doc,
        fornecedor_nome: f.fornecedor,
        data_vencimento: ymd(pagamento - (juros ? 3 * DIA : 0)),
        data_pagamento: ymd(pagamento),
        valor_pago: f.valor + juros,
        metodo_match: f.metodo,
        confianca: CONFIANCA[f.metodo],
        motivo: MOTIVO[f.metodo],
      };
      // Uma conta por filial já estava baixada no Tiny (conferência), além das baixadas na demo.
      if (e.baixadas.has(f.contaId) || i === 1) {
        jaBaixadas.push({
          ...base,
          inter_transacao_id: transacao,
          tipo_transacao: f.tipo,
          nome_favorecido: f.fornecedor.toUpperCase(),
          cpf_cnpj_favorecido: f.cnpj,
          valor_tiny: f.valor,
        });
        return;
      }
      matches.push({
        ...base,
        id: `${c.id}-${f.contaId}`,
        fornecedor_cnpj: f.cnpj,
        valor_tiny: f.valor,
        inter_transacao_id: transacao,
        tipo_transacao_inter: f.tipo,
        valor_original_inter: juros ? f.valor : null,
        juros,
        multa: 0,
        desconto: 0,
        codigo_barras: f.tipo === 'BOLETO' ? `34191.0900${idx} ${String(f.contaId).padStart(11, '0')} 1 ${Math.round(f.valor * 100)}` : null,
        status_tiny: 'aberto',
        historico_sugerido: `Pagamento ${f.doc} - ${f.fornecedor} (Banco Inter ${f.tipo})`,
        conta_origem_id: null,
      });
    });

    // Débito sem conta no Tiny e conta no Tiny sem pagamento no extrato.
    semParInter.push({
      empresa: c.id, empresa_nome: c.nome, transacao_id: `demo-sp-${c.id}`, data_pagamento: ymd(fim - 3 * DIA),
      valor_pago: 157.8 + idx * 40, tipo_transacao: 'PIX', titulo: 'Pix enviado', descricao: 'PIX - PAPELARIA CENTRAL',
      nome_favorecido: 'PAPELARIA CENTRAL LTDA', cpf_cnpj_favorecido: '78901234000166', codigo_barras: null,
    });
    semParTiny.push({
      id: 780_000 + idx, empresa: c.id, empresa_nome: c.nome, numero_documento: `NF ${9_100 + idx}`,
      fornecedor_nome: 'Madeireira Pinhais', fornecedor_cnpj: '89012345000177', data_vencimento: ymd(fim - 2 * DIA),
      valor: 2_140 + idx * 115, historico: 'Compra de ripas e sarrafos',
    });
  });

  // Transferência entre empresas do grupo (mesma raiz de CNPJ): Campinas → Curitiba.
  if (!body.empresa || body.empresa === 'norvia_campinas') {
    const valor = 25_000;
    const dia = ymd(fim - 7 * DIA);
    transferencias.push({
      empresa: 'norvia_campinas', empresa_nome: 'Norvia Campinas', transacao_id: 'demo-transf-1', data_pagamento: dia,
      valor_pago: valor, tipo_transacao: 'TED', titulo: 'TED enviada', descricao: 'TED - NORVIA CURITIBA',
      nome_favorecido: 'NORVIA ACABAMENTOS LTDA', cpf_cnpj_favorecido: '27184930000280', codigo_barras: null,
      empresa_destino_nome: 'Norvia Curitiba',
      situacao: 'sem_conta',
      conciliacao: null,
      conta_ja_baixada: null,
    });
  }

  const soma = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  return {
    status: 'ok',
    data_inicio: ymd(inicio),
    data_fim: ymd(fim),
    summary: {
      total_casados: matches.length,
      valor_total_casados: soma(matches.map((m) => m.valor_pago)),
      total_inter_sem_par: semParInter.length,
      valor_inter_sem_par: soma(semParInter.map((m) => m.valor_pago)),
      total_tiny_sem_par: semParTiny.length,
      valor_tiny_sem_par: soma(semParTiny.map((m) => m.valor)),
      total_ja_baixadas: jaBaixadas.length,
      valor_ja_baixadas: soma(jaBaixadas.map((m) => m.valor_pago)),
      total_transferencias_internas: transferencias.length,
      valor_transferencias_internas: soma(transferencias.map((m) => m.valor_pago)),
      total_transferencias_aptas: 0,
      valor_transferencias_aptas: 0,
    },
    matches,
    unmatched_inter: semParInter,
    unmatched_tiny: semParTiny,
    ja_baixadas: jaBaixadas,
    transferencias_internas: transferencias,
    avisos: [],
    dados_de: new Date().toISOString(),
    do_cache: false,
  };
}

function novoJobId(e: Estado) {
  e.proximoId += 1;
  return idDeLote(e.proximoId);
}

/** Identificador no formato dos jobs reais (hex), estável para a mesma semente. */
function idDeLote(semente: number) {
  let h = (semente * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 32; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out += (h >>> 24 & 15).toString(16);
  }
  return out;
}

export const demoReconciliation = {
  status(): ReconciliationStatusResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      empresas: RECONCILIATION_COMPANIES.map((c) => ({
        id: c.id, nome: c.nome, cnpj: c.cnpj,
        inter_configurado: true, inter_status: 'conectado', inter_mensagem: 'Certificado válido até 14/03/2027.',
        tiny_configurado: true,
      })),
    };
  },

  estado(): ReconciliationEstadoResponse {
    const previa = montarPrevia({ empresa: '' });
    return {
      ...previa,
      atualizado_em: new Date().toISOString(),
      historico_saidas: [],
      ultima_execucao: {
        tipo: 'rotina',
        em: new Date().toISOString(),
        sucesso: true,
        mensagem: 'Rotina diária executada com sucesso (Simulado).',
      },
    };
  },

  iniciarPrevia(body: PreviewRequestBody): PreviewJob {
    const e = st();
    const filiais = RECONCILIATION_COMPANIES.filter((c) => !body.empresa || c.id === body.empresa);
    const job: PreviewJob = {
      job_id: novoJobId(e), tipo: 'preview', status: 'executando', etapa: `${filiais[0].nome}: extrato do Banco Inter`,
      atual: 0, total: filiais.length, iniciado_em: new Date().toISOString(), concluido_em: null, erro: null, resultado: null,
    };
    e.jobs.set(job.job_id, {
      job, iniciado: Date.now(),
      executar: (j, decorrido) => {
        const feitos = Math.min(filiais.length, Math.floor(decorrido / PREVIEW_POR_FILIAL_MS));
        j.atual = feitos;
        if (feitos >= filiais.length) {
          Object.assign(j, { status: 'concluido', etapa: 'Comparação concluída', concluido_em: new Date().toISOString(), resultado: montarPrevia(body) });
          return;
        }
        const meio = (decorrido % PREVIEW_POR_FILIAL_MS) > PREVIEW_POR_FILIAL_MS / 2;
        j.etapa = `${filiais[feitos].nome}: ${meio ? 'contas a pagar no Tiny' : 'extrato do Banco Inter'}`;
      },
    });
    return structuredClone(job);
  },

  iniciarBaixa(itens: BaixaItemInput[]): BaixaJob {
    const e = st();
    const lote = novoJobId(e);
    const job: BaixaJob = {
      job_id: lote, tipo: 'baixar', status: 'executando', etapa: 'Preparando a baixa', atual: 0, total: itens.length,
      iniciado_em: new Date().toISOString(), concluido_em: null, erro: null, resultado: null,
    };
    let registrados = 0;
    e.jobs.set(lote, {
      job, iniciado: Date.now(),
      executar: (j, decorrido) => {
        const feitos = Math.min(itens.length, Math.floor(decorrido / BAIXA_POR_CONTA_MS));
        for (; registrados < feitos; registrados++) {
          const it = itens[registrados];
          e.baixadas.set(it.conta_pagar_id, new Date().toISOString());
          e.historico.unshift({
            id: e.historico.length + 1, lote_id: lote, executado_em: new Date().toISOString(), usuario_nome: 'João',
            empresa: it.empresa, conta_pagar_id: it.conta_pagar_id, numero_documento: it.numero_documento ?? null,
            fornecedor_nome: it.fornecedor_nome ?? null, data_vencimento: it.data_vencimento ?? null,
            data_pagamento: it.data_pagamento ?? null, valor_tiny: it.valor_tiny ?? null, valor_pago: it.valor_pago,
            juros: it.juros ?? 0, multa: it.multa ?? 0, desconto: it.desconto ?? 0,
            inter_transacao_id: it.inter_transacao_id ?? null, metodo_match: it.metodo_match ?? null,
            status: 'sucesso', mensagem: `Conta #${it.conta_pagar_id} baixada com sucesso no Tiny ERP.`,
          });
        }
        j.atual = feitos;
        if (feitos >= itens.length) {
          Object.assign(j, {
            status: 'concluido', etapa: 'Baixa concluída', concluido_em: new Date().toISOString(),
            resultado: {
              status: 'ok', total_solicitados: itens.length, total_sucessos: itens.length, total_falhas: 0,
              resultados: itens.map((it) => ({
                conta_pagar_id: it.conta_pagar_id, empresa: it.empresa, status: 'sucesso' as const,
                mensagem: `Conta #${it.conta_pagar_id} baixada com sucesso no Tiny ERP.`,
              })),
            },
          });
          return;
        }
        const atual = itens[feitos];
        j.etapa = `Baixando conta #${atual.conta_pagar_id} (${companyNome(atual.empresa)})`;
      },
    });
    return structuredClone(job);
  },

  job(jobId: string): ReconciliationJob | null {
    const reg = st().jobs.get(jobId);
    if (!reg) return null;
    if (reg.job.status === 'executando') reg.executar(reg.job, Date.now() - reg.iniciado);
    return structuredClone(reg.job);
  },

  historico(q: BaixaHistoricoQuery): BaixaHistoricoResponse {
    const termo = (q.q ?? '').trim().toLowerCase();
    const empresas = Array.isArray(q.empresa) ? q.empresa : q.empresa ? [q.empresa] : [];
    const status: string[] = Array.isArray(q.status) ? q.status : q.status ? [q.status] : [];
    const contem = (valor: string | null | undefined, filtro: string | undefined) =>
      !filtro?.trim() || (valor ?? '').toLowerCase().includes(filtro.trim().toLowerCase());
    const itens = st().historico.filter((h) => {
      if (empresas.length && !empresas.includes(h.empresa)) return false;
      if (status.length && !status.includes(h.status)) return false;
      const dia = h.executado_em.slice(0, 10);
      if (q.de && dia < q.de) return false;
      if (q.ate && dia > q.ate) return false;
      if (!contem(h.fornecedor_nome, q.fornecedor) || !contem(h.usuario_nome, q.usuario)) return false;
      if (!contem(`${h.numero_documento ?? ''} ${h.conta_pagar_id}`, q.documento)) return false;
      return !termo || `${h.fornecedor_nome ?? ''} ${h.numero_documento ?? ''} ${h.conta_pagar_id}`.toLowerCase().includes(termo);
    });
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    return { disponivel: true, itens: itens.slice((page - 1) * pageSize, page * pageSize), total: itens.length, page, pageSize };
  },
};
