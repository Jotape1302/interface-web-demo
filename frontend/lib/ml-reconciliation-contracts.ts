// Contratos da Conciliação Mercado Livre × Contas a Receber Tiny
// (backend/automations/automacoes-financeiro/app/ml_reconciliation*.py, via /api/ml-reconciliation).

export type MlConexao = 'mercado_pago' | 'mercado_livre' | 'tiny';

export interface MlEmpresaStatus {
  id: string;
  nome: string;
  conta_lancamento: string;
  conexoes: Record<MlConexao, boolean>;
  ultima_analise: MlAnaliseResumo | null;
}

export type MlStatusExecucao = 'ok' | 'parcial' | 'erro';

export interface MlResultadoEmpresa {
  status: 'ok' | 'erro' | 'sem_credencial' | 'parcial';
  mensagem?: string;
  analise_id?: string;
  resumo?: MlResumo;
  baixa?: { sucessos: number; falhas: number; ignorados: number };
}

export interface MlLinhaLog {
  em: string;
  nivel: 'info' | 'aviso' | 'erro';
  empresa: string;
  mensagem: string;
}

/** Execução da rotina (análise diária/manual) ou de uma baixa, com o log linha a linha. */
export interface MlExecucao {
  id: string;
  tipo: 'analise' | 'baixa';
  origem: 'agendada' | 'manual';
  usuario?: string;
  iniciada_em: string;
  concluida_em: string;
  status: MlStatusExecucao;
  periodo_de: string; // AAAA-MM-DD
  periodo_ate: string;
  empresas: Record<string, MlResultadoEmpresa>;
}

/** Item da listagem (sem o log). */
export interface MlExecucaoResumo extends MlExecucao {
  linhas_log: number;
  erros_log: number;
  avisos_log: number;
}

export interface MlExecucaoDetalhe extends MlExecucao {
  log: MlLinhaLog[];
}

export interface MlExecucoesResponse {
  itens: MlExecucaoResumo[];
  total: number;
}

export interface MlStatus {
  empresas: MlEmpresaStatus[];
  em_execucao: { execucao_id: string; iniciada_em: string; origem: string } | null;
  progresso: { etapa: string; atual: number; total: number; empresa: string } | null;
  ultima_execucao: MlExecucaoResumo | null;
  proxima_execucao: string;
  hora_diaria: number;
  /** false = o financeiro não tem TMS/OAuth: os tokens são renovados pelo cron do servidor. */
  renovacao_tokens_no_painel?: boolean;
  periodo_padrao: [string, string];
  erro_gravacao: string | null;
}

export interface MlContaVinculada {
  id: number;
  numero?: number;
  situacao?: string;
  valor?: number | null;
  saldo?: number | null;
  valor_pago?: number | null;
  historico?: string;
  vencimento?: string;
}

/** Recebimentos de uma venda somados, a baixar numa conta do Contas a Receber. */
export interface MlGrupo {
  id: string;
  id_venda: string;
  id_operacao?: string;
  mlb?: string;
  data: string; // dd/mm/aaaa
  nome_cliente: string;
  valor_total: number;
  quantidade_movimentos: number;
  quantidade_parcelas?: number;
  contas_vinculadas?: MlContaVinculada[];
  // "APTO PARA BAIXA", "CONCILIADO", "Não conciliado", "NÃO LOCALIZADO", "VALOR DIVERGENTE", "STATUS: PAGO"...
  situacao: string;
  mensagem: string;
  apto_baixa: boolean;
  conta_id: number | null;
  conta_situacao: string;
  conta_historico: string;
  conta_valor: number | null;
  conta_saldo: number | null;
  conta_valor_pago: number | null;
  baixado_em: string;
}

/** Linha da planilha de lançamentos de caixa para importar no Tiny. */
export interface MlLancamento {
  indice: number;
  data: string;
  categoria: string;
  historico: string;
  tipo: 'C' | 'D';
  valor: number;
  contato: string;
  cnpj: string;
  conta: string;
  numero_documento: string;
  tipo_operacao: string;
  fluxo?: 'RECEBIMENTO' | 'PAGAMENTO';
}

/** Movimento que não virou lançamento e precisa de conferência manual. */
export interface MlPendencia {
  indice: number;
  data: string;
  tipo_operacao: string;
  operacao_relacionada: string;
  id_venda: string;
  nome_cliente: string;
  valor: number;
  motivo: string;
  fluxo?: 'RECEBIMENTO' | 'PAGAMENTO';
}

export type MlCasamento = 'pagamento' | 'pedido' | 'sem_venda';

/** Comparativo vendas (Mercado Livre) × recebimentos (Mercado Pago), por pagamento. */
export interface MlComparativo {
  id_pagamento: string;
  data: string;
  valor_liberado: number;
  casou_por: MlCasamento;
  id_pedido: string;
  id_pacote: string;
  mlb?: string;
  id_pedido_relatorio: string;
  nome_cliente: string;
  status_venda: string;
  observacao: string;
}

export interface MlSaldoDia {
  data: string;
  valor: number;
}

export interface MlResumo {
  total_movimentos: number;
  total_grupos: number;
  grupos_por_situacao: Record<string, number>;
  aptos_baixa: number;
  valor_aptos_baixa: number;
  conciliados: number;
  total_lancamentos: number;
  valor_creditos: number;
  valor_debitos: number;
  total_anuladas: number;
  total_pendencias: number;
  valor_recebimentos: number;
  valor_liquido: number;
  total_recebimentos_mp?: number;
  valor_recebimentos_mp?: number;
  total_pagamentos_mp?: number;
  valor_pagamentos_mp?: number;
  pagamentos: number;
  pagamentos_por_casamento: Partial<Record<MlCasamento, number>>;
  pagamentos_com_observacao: number;
}

export interface MlAnaliseResumo {
  analise_id: string;
  empresa: string;
  empresa_nome: string;
  criada_em: string;
  periodo_de: string;
  periodo_ate: string;
  origem: 'agendada' | 'manual';
  execucao_id: string;
  fontes: { liberacoes?: number; pedidos_ml?: number; pedidos_tiny?: number };
  tiny_consultado: boolean;
  avisos: string[];
  resumo: MlResumo;
}

export interface MlAnalisesResponse {
  itens: MlAnaliseResumo[];
  total: number;
}

export interface MlAnalise extends MlAnaliseResumo {
  grupos: MlGrupo[];
  lancamentos: MlLancamento[];
  pendencias: MlPendencia[];
  comparativo: MlComparativo[];
  saldo_recebimentos_dia: MlSaldoDia[];
  saldo_total_dia: MlSaldoDia[];
}

export interface MlBaixaResultado {
  grupo_id: string;
  conta_id?: number | null;
  id_venda?: string;
  nome_cliente?: string;
  valor?: number;
  status: 'sucesso' | 'erro' | 'ignorado';
  mensagem: string;
}

export interface MlBaixaResponse {
  status: 'concluido' | 'parcial' | 'erro';
  total_solicitados: number;
  total_sucessos: number;
  total_falhas: number;
  total_ignorados: number;
  resultados: MlBaixaResultado[];
}

export type MlJobStatus = 'executando' | 'concluido' | 'erro';

interface MlJobBase {
  job_id: string;
  status: MlJobStatus;
  etapa: string;
  atual: number;
  total: number;
  iniciado_em: string;
  concluido_em: string | null;
  erro: string | null;
}

export interface MlExecucaoJob extends MlJobBase {
  tipo: 'ml_executar';
  resultado: MlExecucaoResumo | null;
}

export interface MlBaixaJob extends MlJobBase {
  tipo: 'ml_baixar';
  resultado: MlBaixaResponse | null;
}

export type MlJob = MlExecucaoJob | MlBaixaJob;

export type MlArquivoTipo = 'relatorio' | 'lancamentos' | 'vendas-recebimentos' | 'saldo-recebimentos' | 'saldo-total';

export interface MlExecutarPedido {
  empresas?: string[];
  de?: string; // AAAA-MM-DD
  ate?: string;
}

export interface MlTokenContaStatus {
  conectado: boolean;
  renovado: boolean;
  motivo?: string;
}

export interface MlTokenSyncResponse {
  ok: boolean;
  mock?: boolean;
  contas: Record<string, MlTokenContaStatus>;
  tokens_atualizados: string[];
}
