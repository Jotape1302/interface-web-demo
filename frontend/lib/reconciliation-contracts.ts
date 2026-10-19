export type MatchMethod =
  | 'CODIGO_BARRAS'
  | 'CNPJ_VALOR_DATA'
  | 'CNPJ_VALOR'
  | 'NOME_VALOR'
  | 'DOCUMENTO_VALOR'
  | 'VALOR_DATA_UNICO';

export interface UnmatchedInterItem {
  empresa: string;
  empresa_nome: string;
  transacao_id: string;
  data_pagamento: string;
  valor_pago: number;
  tipo_transacao: string;
  titulo: string;
  descricao: string;
  nome_favorecido: string | null;
  cpf_cnpj_favorecido: string | null;
  codigo_barras: string | null;
}

export interface UnmatchedTinyItem {
  id: number;
  empresa: string;
  empresa_nome: string;
  numero_documento: string;
  fornecedor_nome: string;
  fornecedor_cnpj: string | null;
  data_vencimento: string;
  valor: number;
  historico: string;
}

export interface ReconciliationMatch {
  id: string;
  empresa: string;
  empresa_nome: string;
  conta_pagar_id: number;
  numero_documento: string;
  fornecedor_nome: string;
  fornecedor_cnpj: string | null;
  data_vencimento: string;
  valor_tiny: number;
  inter_transacao_id: string;
  tipo_transacao_inter: string;
  data_pagamento: string;
  valor_pago: number;
  valor_original_inter: number | null;
  juros: number;
  multa: number;
  desconto: number;
  codigo_barras: string | null;
  metodo_match: MatchMethod;
  confianca: number;
  motivo: string;
  status_tiny: string;
  historico_sugerido: string;
  conta_origem_id?: number | null;
}

// Débito do Inter que corresponde a uma conta que já está paga (baixada) no Tiny:
// não é pendência, só aparece para conferência.
export interface AlreadyPaidItem {
  empresa: string;
  empresa_nome: string;
  inter_transacao_id: string;
  data_pagamento: string;
  valor_pago: number;
  tipo_transacao: string;
  nome_favorecido: string | null;
  cpf_cnpj_favorecido: string | null;
  conta_pagar_id: number;
  numero_documento: string;
  fornecedor_nome: string;
  data_vencimento: string;
  valor_tiny: number;
  metodo_match: MatchMethod;
  confianca: number;
  motivo: string;
}

// Débito do Inter para outra empresa do próprio grupo (mesma raiz de CNPJ). Fica na aba
// "Transferências entre empresas", mas é conciliado com o Tiny como qualquer débito:
// - apta_baixa: casou com conta em aberto -> `conciliacao` preenchida, baixa pela própria aba
//   (mesmo fluxo de baixa das contas casadas, via buildBaixaItem(conciliacao));
// - ja_baixada: casou com conta já paga -> `conta_ja_baixada` preenchida, só conferência;
// - sem_conta: nenhuma conta no Tiny (precisa ser lançada lá antes de poder baixar).
// Transferências NÃO aparecem em `matches` nem em `ja_baixadas`.
export type InternalTransferSituacao = 'apta_baixa' | 'ja_baixada' | 'sem_conta';

export interface InternalTransferItem extends UnmatchedInterItem {
  empresa_destino_nome: string;
  situacao: InternalTransferSituacao;
  conciliacao: ReconciliationMatch | null;
  conta_ja_baixada: AlreadyPaidItem | null;
}

export interface ReconciliationSummary {
  total_casados: number;
  valor_total_casados: number;
  total_inter_sem_par: number;
  valor_inter_sem_par: number;
  total_tiny_sem_par: number;
  valor_tiny_sem_par: number;
  total_ja_baixadas: number;
  valor_ja_baixadas: number;
  total_transferencias_internas: number;
  valor_transferencias_internas: number;
  total_transferencias_aptas: number;
  valor_transferencias_aptas: number;
}

export interface ReconciliationPreviewResponse {
  status: string;
  data_inicio: string;
  data_fim: string;
  summary: ReconciliationSummary;
  matches: ReconciliationMatch[];
  unmatched_inter?: UnmatchedInterItem[];
  unmatched_tiny?: UnmatchedTinyItem[];
  ja_baixadas?: AlreadyPaidItem[];
  transferencias_internas?: InternalTransferItem[];
  avisos?: string[];
  // Quando o Inter/Tiny foram consultados (mais antigo entre as filiais; ISO com fuso) e se
  // a resposta saiu inteira do cache do backend. Ausentes em backends anteriores.
  dados_de?: string;
  do_cache?: boolean;
}

export interface ReconciliationEstadoResponse extends ReconciliationPreviewResponse {
  atualizado_em?: string | null;
  historico_saidas?: Array<{
    removido_em: string;
    empresa: string;
    conta_pagar_id: number;
    numero_documento?: string;
    valor?: number;
    motivo: string;
    detalhes?: Record<string, unknown>;
  }>;
  ultima_execucao?: {
    tipo: string;
    em: string;
    sucesso: boolean;
    mensagem: string;
  } | null;
}

export interface BaixaItemInput {
  empresa: string;
  conta_pagar_id: number;
  valor_pago: number;
  data_pagamento?: string;
  juros?: number;
  multa?: number;
  desconto?: number;
  historico?: string;
  conta_origem_id?: number | null;
  // Metadados só para o histórico de baixas (o backend Python ignora).
  numero_documento?: string;
  fornecedor_nome?: string;
  data_vencimento?: string;
  valor_tiny?: number;
  inter_transacao_id?: string;
  metodo_match?: MatchMethod;
}

export interface BaixaItemResult {
  conta_pagar_id: number;
  empresa: string;
  inter_transacao_id?: string;
  // 'erro' também cobre item fora da última prévia: a mensagem pede para rodar "Comparar" de novo.
  status: 'sucesso' | 'erro';
  mensagem: string;
  // Valores efetivamente usados na baixa (do extrato guardado na prévia, não do pedido).
  // Ausentes quando o item nem chegou a ser casado com a prévia.
  valor_pago?: number;
  data_pagamento?: string;
  juros?: number;
  multa?: number;
  desconto?: number;
}

export interface BaixaResponse {
  status: string;
  total_solicitados: number;
  total_sucessos: number;
  total_falhas: number;
  resultados: BaixaItemResult[];
}

// Espelha InterClient.check_credentials_status (backend/automations/automacoes-financeiro/app/inter_client.py).
export type InterConnectionStatus =
  | 'conectado'
  | 'certificados_ausentes'
  | 'certificados_sem_permissao'
  | 'certificado_expirado'
  | 'erro_autenticacao'
  | 'nao_configurado';

export interface ReconciliationCompanyStatus {
  id: string;
  nome: string;
  cnpj: string;
  inter_configurado: boolean;
  // Ausente quando o gateway responde com o fallback (API Python fora do ar).
  inter_status?: InterConnectionStatus;
  inter_mensagem?: string;
  tiny_configurado: boolean;
}

export interface ReconciliationStatusResponse {
  status: string;
  timestamp: string;
  empresas: ReconciliationCompanyStatus[];
}

// Histórico de baixas (tabela conciliacao_baixas_historico, gravada pelo gateway a cada execução).
export interface BaixaHistoricoItem {
  id: number;
  lote_id: string;
  executado_em: string;
  usuario_nome: string | null;
  empresa: string;
  conta_pagar_id: number;
  numero_documento: string | null;
  fornecedor_nome: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  valor_tiny: number | null;
  valor_pago: number;
  juros: number;
  multa: number;
  desconto: number;
  inter_transacao_id: string | null;
  metodo_match: MatchMethod | null;
  /** `pendente`: enviada ao Tiny, resultado ainda não chegou. */
  status: 'sucesso' | 'erro' | 'pendente';
  mensagem: string | null;
}

// GET /api/reconciliation/historico?empresa=&status=&de=YYYY-MM-DD&ate=YYYY-MM-DD&q=&page=1&pageSize=50
export type BaixaHistoricoStatus = 'sucesso' | 'erro' | 'pendente';

export interface BaixaHistoricoQuery {
  /** Uma ou mais empresas (vão separadas por vírgula na URL). */
  empresa?: string | string[];
  status?: BaixaHistoricoStatus | BaixaHistoricoStatus[];
  de?: string;
  ate?: string;
  /** Busca livre em fornecedor, documento, usuário, conta e transação. */
  q?: string;
  /** Filtros de coluna: cada um restringe só o próprio campo. */
  fornecedor?: string;
  documento?: string;
  usuario?: string;
  page?: number;
  pageSize?: number;
}

export interface BaixaHistoricoResponse {
  // false quando o gateway está sem MariaDB (modo demo/local): não há histórico persistido.
  disponivel: boolean;
  itens: BaixaHistoricoItem[];
  total: number;
  page: number;
  pageSize: number;
}

// Tarefas em segundo plano (prévia e baixa passam de 1 min — mais que o timeout do NGINX).
// POST /api/reconciliation/jobs/preview (body = mesmo da prévia) ou
// POST /api/reconciliation/jobs/baixar  (body = { itens: BaixaItemInput[] })
// devolvem o job; GET /api/reconciliation/jobs/{job_id} devolve o andamento.
// 404 no GET = tarefa perdida (API reiniciada ou expirada após 1h).
export type ReconciliationJobStatus = 'executando' | 'concluido' | 'erro';

interface ReconciliationJobBase {
  job_id: string;
  status: ReconciliationJobStatus;
  etapa: string; // ex.: "Revesta: contas a pagar no Tiny", "Baixando conta #123 (Fabrilux)"
  atual: number;
  total: number;
  iniciado_em: string;
  concluido_em: string | null;
  erro: string | null;
}

export interface PreviewJob extends ReconciliationJobBase {
  tipo: 'preview';
  resultado: ReconciliationPreviewResponse | null;
}

export interface BaixaJob extends ReconciliationJobBase {
  tipo: 'baixar';
  resultado: BaixaResponse | null;
}

export type ReconciliationJob = PreviewJob | BaixaJob;
