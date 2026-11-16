export interface Metrics {
  totalQueue: number;
  paidCount: number;
  reconciledCount: number;
  /** Ausentes para quem não tem `roi:ver` (cortados no servidor). */
  hoursSaved?: number;
  estimatedSavings?: number;
  automationRate: number | null;
}
export interface Account {
  id: string;
  beneficiary: string;
  cnpj: string;
  amount: string;
  dueDate: string;
  status: string;
  transactionId: string | null;
  errorLog: string | null;
  stoppedNode: string | null;
  updatedAt: string | null;
}
export interface Execution {
  id: string;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  status: "success" | "error" | "waiting" | "running" | "unknown";
  stoppedNode: string | null;
  workflowId?: string | null;
}
export interface SourceState {
  status: "ok" | "error";
  message?: string;
}
export interface Dashboard {
  mode: "demo" | "live";
  generatedAt: string;
  metrics: Metrics | null;
  approvals: Account[] | null;
  failures: Account[] | null;
  executions: Execution[] | null;
  sources: { database: SourceState; n8n: SourceState };
}
export interface DatabaseSnapshot {
  metrics: Metrics;
  approvals: Account[];
  failures: Account[];
}
export interface DatabaseAdapter {
  read(): Promise<DatabaseSnapshot>;
  close?(): Promise<void>;
}
export interface ExecutionAdapter {
  read(): Promise<Execution[]>;
}

export interface HistoryWindow {
  days: 14;
  from: string;
  to: string;
}
export interface ExecutionHistory extends HistoryWindow {
  complete: boolean;
  executions: Array<Execution & { automationId: string }>;
  error: string | null;
}
export interface HistoryAdapter {
  readHistory(window: HistoryWindow): Promise<{ complete: boolean; executions: Execution[] }>;
}
export interface OverviewResponse {
  mode: Dashboard["mode"];
  generatedAt: string;
  automations: Array<{ id: string; title: string; href: string; dashboard: Dashboard }>;
  history: ExecutionHistory;
  services: Array<{
    id: "mariadb" | "n8n" | "tiny" | "inter";
    name: string;
    status: "connected" | "error" | "unverified" | "demo";
    message: string;
  }>;
}

export interface DanfeDuplicate {
  numero: string;
  vencimento: string;
  valor: number;
}

export interface DanfeData {
  chave: string;
  numero_nota: string;
  data_emissao: string;
  emitente_nome: string;
  emitente_cnpj: string;
  valor_total: number;
  duplicatas: DanfeDuplicate[];
  destinatario_cnpj: string | null;
  destinatario_nome: string | null;
  meio_pagamento_nfe: string | null;
  /** Marcador de caixa/cartão lido do nome do arquivo ("Cartão Clara", "Caixa Visa"...). */
  marcador_caixa?: string | null;
  /** Bandeira do cartão no XML (detPag/card/tBand: 01 Visa, 02 Mastercard, 06 Elo...). */
  bandeira_cartao_nfe?: string | null;
  /** Parcelas declaradas no XML da NF-e (cobr/dup); a revisão pré-seleciona. */
  parcelas_nfe?: number | null;
}

export interface DanfeTinyResult {
  conta_id: number | null;
  nro_documento: string;
  valor: number;
  vencimento: string;
  situacao: string;
  is_duplicate: boolean;
}

export interface DanfeReviewItem {
  item_id: string;
  descricao: string;
  valor_total: number;
  codigo: string | null;
  ncm: string | null;
  quantidade: number;
  valor_unitario: number | null;
  categoria_sugerida_id: string;
  categoria_sugerida_nome: string;
  /**
   * "historico": notas anteriores do mesmo fornecedor; "qwen": classificador local no PC do TI;
   * "regra": descrição/NCM. Precedência: histórico por código > por NCM > Qwen alta/média >
   * histórico só do fornecedor > Qwen baixa > regra.
   */
  categoria_sugerida_origem?: "historico" | "qwen" | "regra";
  /** Só com origem "historico": o que casou (mesmo código, mesmo NCM ou só o fornecedor). */
  categoria_sugerida_nivel?: "codigo" | "ncm" | "fornecedor" | null;
  /** Só com origem "qwen". */
  categoria_sugerida_confianca?: "alta" | "media" | "baixa" | null;
  categoria_sugerida_motivo?: string | null;
}

export interface DanfeItemResult {
  filename: string;
  status: "success" | "error";
  step: "scan" | "receita_federal" | "tiny_erp" | "pending_review" | "completed" | "upload";
  key: string | null;
  scan_method: string | null;
  page_number: number | null;
  nfe_data: DanfeData | null;
  itens?: DanfeReviewItem[];
  tiny_results: DanfeTinyResult[];
  error_message: string | null;
  processed_at: string;
}

export interface TinyCategory {
  id: string;
  nome: string;
  grupo: string;
  label: string;
}

export interface DanfePendingReviewEntry {
  chave: string;
  filename: string;
  staged_at: string;
  nfe_data: DanfeData;
  itens: DanfeReviewItem[];
  /**
   * Só nas pendentes: forma de pagamento que o XML crava (tPag/tBand) ou, sem isso, a última
   * confirmada com o fornecedor. null: vale a regra do painel (marcador do arquivo, padrão da empresa).
   */
  forma_pagamento_sugerida?: string | null;
  forma_pagamento_origem?: "xml" | "historico" | null;
  /** Só nas pendentes: último "Meio de pagamento da NFe" (tPag) lançado com o fornecedor. */
  meio_pagamento_nfe_historico?: string | null;
  /** Última recusa do Tiny ao confirmar (a nota segue pendente); null depois de lançar. */
  last_error?: string | null;
  last_error_at?: string | null;
}

export interface DanfePendingReviewResponse {
  total: number;
  pending: DanfePendingReviewEntry[];
}

/**
 * Item de GET /api/v1/danfe/history: o `.meta.json` de uma nota processada (sucesso) ou o
 * registro de uma falha. O meta.json mudou de formato ao longo do tempo (ex.: `emitente` já foi
 * texto e objeto), então só os campos que o gateway lê têm tipo; o resto segue como veio.
 */
export interface DanfeHistoryItem {
  audit_status: "success" | "error";
  processed_at?: string;
  chave_acesso?: string;
  error_file?: string;
  resolved_at?: string | null;
  original_filename?: string;
  metodo_leitura?: string;
  /** Texto do erro (falhas). */
  details?: string;
  /** Nos meta.json atuais é objeto; nos antigos, texto (aí razao_social/cnpj ficam undefined). */
  emitente?: { razao_social?: string; cnpj?: string };
  valor_total?: number | string;
  [campo: string]: unknown;
}

export interface DanfeHistoryResponse {
  total: number;
  history: DanfeHistoryItem[];
}

export interface DanfeImportKeyResponse {
  status: string;
  message: string;
  chave: string;
}

export type DanfeNotaStatus = "pending" | "confirmed" | "archived";

export interface DanfeNotasResponse {
  total: number;
  status: DanfeNotaStatus;
  notas: DanfePendingReviewEntry[];
}

export interface ConfirmLancamentoItemInput {
  item_id: string;
  categoria_id: string;
}

export interface GroupedLancamentoResult {
  categoria_id: string;
  categoria_nome: string;
  valor_total: number;
  item_ids: string[];
  /** Nota parcelada: cada parcela de cada categoria é uma conta no Tiny. */
  parcela?: number;
  total_parcelas?: number;
  tiny_result: DanfeTinyResult | null;
  status: "success" | "error";
  error_message: string | null;
}

export interface ConfirmLancamentoResponse {
  chave: string;
  status: "success" | "partial_error";
  grupos: GroupedLancamentoResult[];
  /** Nota como a revisão mostrou + sugestão por item: o send do gateway tira (atividades.ts) e o painel não recebe. */
  treino?: { contexto?: unknown; sugestao?: unknown };
}

export interface DanfeBatchResponse {
  total: number;
  success_count: number;
  failed_count: number;
  total_amount: number;
  items: DanfeItemResult[];
}

export interface DanfeStatusResponse {
  status: string;
  version: string;
  nfe_provider: string;
  ocr_enabled: boolean;
  tiny_configured: boolean;
  timestamp: string;
}

export interface DanfeSefazCnpjStatus {
  cnpj: string;
  novas_notas: number;
  duplicadas_ignoradas: number;
  canceladas_ignoradas: number;
  eventos_ignorados: number;
  ult_nsu: string | null;
  status: "ok" | "erro" | "cooldown";
  erro: string | null;
  cooldown_until?: string | null;
  cooldown_seconds_remaining?: number;
}

export interface DanfeSefazStatus {
  last_scan_started_at: string | null;
  last_scan_finished_at: string | null;
  next_scan_at: string;
  total_novas_notas: number;
  pending_review_count: number;
  cnpjs: DanfeSefazCnpjStatus[];
  cooldown_seconds_remaining: number;
  is_running?: boolean;
  /** Validade dos certificados A1 da varredura SEFAZ (`alerta` = vence em até 30 dias). */
  certificados?: DanfeCertificateStatus[];
  /** Não nulo = a varredura rodou mas não gravou NSU/status em data/ (ver json_store.py). */
  erro_gravacao?: string | null;
}

export interface DanfeCertificateStatus {
  arquivo: string;
  cnpj: string | null;
  titular: string | null;
  valido_ate: string | null;
  dias_restantes: number | null;
  alerta: boolean;
  erro: string | null;
}

export interface FinancialDashboardCompanyStatus {
  account_id: string;
  cnpj: string;
  ok: boolean;
  erro: string | null;
  caixa_lancamentos: number;
  contas_pagar_abertas: number;
  contas_receber_abertas: number;
}

export interface FinancialDashboardStatus {
  last_sync_started_at: string | null;
  last_sync_finished_at: string | null;
  next_sync_at: string;
  companies: FinancialDashboardCompanyStatus[];
  is_running: boolean;
  cooldown_seconds_remaining: number;
  /** Não nulo = a sincronização rodou mas não gravou cache/status em data/ (ver json_store.py). */
  erro_gravacao?: string | null;
}

export interface FinancialDashboardCategoryEntry {
  categoria_id: string;
  categoria_nome: string;
  grupo: string;
  valor: number;
  valor_anterior: number;
  variacao_pct: number | null;
  percentual_do_total: number;
}

export interface FinancialDashboardMonthEntry {
  mes: string;
  label: string;
  receita: number;
  despesa: number;
  saldo: number;
}

export interface FinancialDashboardAgingEntry {
  nome: string;
  valor: number;
  qtd: number;
}

export interface FinancialDashboardAging {
  vencido_valor: number;
  vencido_qtd: number;
  proximos_7_dias_valor: number;
  proximos_7_dias_qtd: number;
  proximos_30_dias_valor: number;
  proximos_30_dias_qtd: number;
  top: FinancialDashboardAgingEntry[];
  taxa_inadimplencia_pct?: number;
  /** Faixas de atraso/vencimento (vencido +90 … a vencer +90), em ordem cronológica. */
  faixas?: Array<{ faixa: string; label: string; valor: number; qtd: number }>;
}

export interface FinancialDashboardDayEntry {
  dia: string;
  label: string;
  receita: number;
  despesa: number;
  saldo: number;
}

/** Projeção de compromissos (a receber − a pagar) pelos vencimentos em aberto; não inclui saldo bancário. */
export interface FinancialDashboardProjection {
  horizontes: Array<{ dias: number; a_receber: number; a_pagar: number; saldo: number }>;
  semanal: Array<{ inicio: string; label: string; a_receber: number; a_pagar: number; saldo_acumulado: number }>;
}

export interface FinancialDashboardStaleSource {
  account_id: string;
  label: string;
  fonte: "caixa" | "contas_pagar" | "contas_receber" | "forma_pagamento";
  synced_at: string | null;
}

export interface FinancialDashboardCompanyEntry {
  account_id: string;
  label: string;
  receita: number;
  despesa: number;
  resultado_liquido: number;
  margem_liquida_pct?: number | null;
  a_pagar_vencido?: number;
  a_receber_vencido?: number;
}

export interface FinancialDashboardResponse {
  generated_at: string | null;
  period: { from: string; to: string; previous_from: string; previous_to: string };
  companies_available: Array<{ account_id: string; label: string }>;
  company_selected: string | null;
  summary: {
    receita_total: number;
    receita_total_anterior: number;
    receita_variacao_pct: number | null;
    faturamento_bruto: number;
    faturamento_bruto_anterior: number;
    faturamento_bruto_variacao_pct: number | null;
    despesa_total: number;
    despesa_total_anterior: number;
    despesa_variacao_pct: number | null;
    resultado_liquido: number;
    resultado_liquido_anterior: number;
    resultado_liquido_variacao_pct: number | null;
    margem_liquida_pct: number | null;
    margem_liquida_pct_anterior: number | null;
  };
  fluxo_caixa_mensal: FinancialDashboardMonthEntry[];
  /** Série diária do período selecionado — null quando o período é longo ou o cache é legado (mensal). */
  fluxo_caixa_diario?: FinancialDashboardDayEntry[] | null;
  projecao_caixa?: FinancialDashboardProjection;
  dados_desatualizados?: FinancialDashboardStaleSource[];
  despesas_por_categoria: FinancialDashboardCategoryEntry[];
  receitas_por_categoria: FinancialDashboardCategoryEntry[];
  concentracao_despesas_top3_pct: number;
  categoria_maior_alta: { categoria_nome: string; variacao_pct: number } | null;
  contas_a_pagar: FinancialDashboardAging;
  contas_a_receber: FinancialDashboardAging;
  forma_pagamento: Array<{ marcador: string; valor: number; percentual: number }>;
  por_empresa: FinancialDashboardCompanyEntry[] | null;
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


/**
 * Tarefa longa da automação financeira (GET .../jobs/{id}): espelho de `_job_publico` em
 * backend/automations/automacoes-financeiro/app/routers/jobs.py. `resultado` depende do tipo
 * (prévia, baixa Inter, baixa ML) e chega como JSON solto.
 */
export interface AutomationJob {
  job_id?: string;
  tipo?: string;
  status: "executando" | "concluido" | "erro";
  etapa?: string;
  atual?: number;
  total?: number;
  iniciado_em?: string;
  concluido_em?: string | null;
  resultado?: unknown;
  erro?: string | null;
}

export interface RoiAutomacao {
  id: string;
  titulo: string;
  unidade: string;
  /** Itens contados na fonte; null quando a fonte falhou. */
  itens: number | null;
  minutosManual: number;
  minutosAtual: number;
  tarefaManual: string;
  tarefaAtual: string;
  horasEconomizadas: number | null;
  reais: number | null;
  fonte: { status: "ok" | "erro"; mensagem?: string };
  observacao: string | null;
}
/** Período do ROI (dias de São Paulo, inclusivos); null/null = desde o início. */
export interface RoiPeriodo {
  de: string | null;
  ate: string | null;
}
export interface RoiResponse {
  mode: Dashboard["mode"];
  periodo: RoiPeriodo;
  generatedAt: string;
  valorHora: number;
  automacoes: RoiAutomacao[];
  /** Soma só das fontes ok; `parcial` = alguma fonte falhou. */
  totais: { horasEconomizadas: number; reais: number; parcial: boolean };
  /** Automações que ficam fora da conta, com o motivo. */
  naoMedidas: Array<{ id: string; titulo: string; motivo: string }>;
}

// ---- Visão geral por área (GET /api/areas/{area}/visao-geral). Espelho: frontend/lib/area-overview-contracts.ts
export type AreaVisaoGeralId = "financeiro" | "logistica" | "marketplace" | "producao";
export type Severidade = "critica" | "atencao" | "info";
export interface AcaoPendente {
  id: string;
  automacao: string;
  titulo: string;
  descricao: string;
  quantidade: number | null;
  severidade: Severidade;
  href: string;
  acao: string;
  desde: string | null;
}
export interface AutomacaoResumo {
  id: string;
  titulo: string;
  href: string;
  status: "ok" | "atencao" | "erro" | "sem_dados";
  ultimaExecucao: string | null;
  indicadores: { rotulo: string; valor: string }[];
}
export interface ServicoStatus {
  id: string;
  nome: string;
  conectado: boolean;
  mensagem: string;
}
export interface VisaoGeralArea {
  area: AreaVisaoGeralId;
  geradoEm: string;
  acoesPendentes: AcaoPendente[];
  automacoes: AutomacaoResumo[];
  servicos: ServicoStatus[];
  indisponiveis: { fonte: string; mensagem: string }[];
}
