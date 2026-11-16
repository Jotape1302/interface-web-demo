// Contratos do gateway: fonte única em backend/gateway/src/contracts.ts. Só tipos (`import type`
// some no build), então o bundle do frontend não leva código do gateway. Aqui ficam só os
// tipos exclusivos do frontend.
import type {
  Account,
  ConfirmLancamentoResponse,
  DanfeBatchResponse,
  DanfeCertificateStatus,
  DanfeData,
  DanfeDuplicate,
  DanfeItemResult,
  DanfeNotaStatus,
  DanfeNotasResponse,
  DanfePendingReviewEntry,
  DanfePendingReviewResponse,
  DanfeReviewItem,
  DanfeSefazCnpjStatus,
  DanfeSefazStatus,
  DanfeStatusResponse,
  DanfeTinyResult,
  Execution,
  FinancialDashboardAging,
  FinancialDashboardAgingEntry,
  FinancialDashboardCategoryEntry,
  FinancialDashboardCompanyEntry,
  FinancialDashboardCompanyStatus,
  FinancialDashboardDayEntry,
  FinancialDashboardMonthEntry,
  FinancialDashboardProjection,
  FinancialDashboardResponse,
  FinancialDashboardStaleSource,
  FinancialDashboardStatus,
  GroupedLancamentoResult,
  Metrics,
  SourceState,
  TinyCategory,
} from "../../backend/gateway/src/contracts";

export type {
  Account,
  ConfirmLancamentoResponse,
  DanfeBatchResponse,
  DanfeCertificateStatus,
  DanfeData,
  DanfeDuplicate,
  DanfeItemResult,
  DanfeNotaStatus,
  DanfeNotasResponse,
  DanfePendingReviewEntry,
  DanfePendingReviewResponse,
  DanfeReviewItem,
  DanfeSefazCnpjStatus,
  DanfeSefazStatus,
  DanfeStatusResponse,
  DanfeTinyResult,
  Execution,
  FinancialDashboardAging,
  FinancialDashboardAgingEntry,
  FinancialDashboardCategoryEntry,
  FinancialDashboardCompanyEntry,
  FinancialDashboardCompanyStatus,
  FinancialDashboardDayEntry,
  FinancialDashboardMonthEntry,
  FinancialDashboardProjection,
  FinancialDashboardResponse,
  FinancialDashboardStaleSource,
  FinancialDashboardStatus,
  GroupedLancamentoResult,
  Metrics,
  SourceState,
  TinyCategory,
};

export interface DashboardResponse {
  mode: "demo" | "live";
  generatedAt: string;
  metrics: Metrics | null;
  approvals: Account[] | null;
  failures: Account[] | null;
  executions: Execution[] | null;
  sources: { database: SourceState; n8n: SourceState };
}
export const SETORES = [
  "Financeiro",
  "Logística",
  "Diretoria",
  "Marketing",
  "T.I",
  "Vendas",
  "RH",
  "E-Commerce",
  "SAC",
  "Produção",
] as const;

export type Setor = (typeof SETORES)[number];

export interface DashboardConfig {
  mode: "demo" | "live";
  apiBaseUrl: string;
}
export interface DashboardService {
  getDashboard(signal?: AbortSignal): Promise<DashboardResponse>;
}

export function resolveApiBaseUrl(configuredUrl?: string): string {
  if (typeof window === 'undefined') {
    return configuredUrl || process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3100';
  }

  // Se uma URL customizada foi passada diretamente como argumento na chamada (ex: testes)
  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  const loc = typeof window !== 'undefined' ? window.location : null;
  const hostname = loc?.hostname || '';
  const protocol = loc?.protocol || '';
  const port = loc?.port || '';
  const origin = loc?.origin || '';
  const pathname = loc?.pathname || '';

  // 1. Acesso no ambiente local (localhost / 127.0.0.1): SEMPRE usa o Gateway local
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:3100';
  }

  // 2. Acesso direto em rede local com porta diferente de padrão (ex: http://192.168.50.20:3001)
  if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && port && !['', '80', '443'].includes(port)) {
    return `${protocol}//${hostname}:3100`;
  }

  // 3. Se houver uma variável de ambiente pública customizada com URL completa
  const envUrl = (process.env.NEXT_PUBLIC_API_BASE_URL || '').trim();
  if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
    // Se a URL do Nginx na VPS foi configurada sem /automacoes, anexa /automacoes para casar com a rota da API
    if ((protocol === 'https:' || port === '' || port === '80' || port === '443') && !envUrl.endsWith('/automacoes')) {
      return `${envUrl.replace(/\/$/, '')}/automacoes`;
    }
    return envUrl;
  }

  // 4. Quando o frontend roda via HTTPS ou portas web padrão (80/443), está atrás de um reverse proxy (ex: Nginx).
  // A API no Nginx é servida em /automacoes/api/
  if (protocol === 'https:' || port === '' || port === '80' || port === '443') {
    const isAutomacoes = pathname.startsWith('/automacoes') || pathname === '' || pathname === '/';
    return isAutomacoes ? `${origin}/automacoes` : origin;
  }

  // Fallback padrão para ambiente local de desenvolvimento
  return 'http://localhost:3100';
}

// ==========================================
// Dashboard Financeiro (agregação Tiny ERP)
// ==========================================

// ==========================================
// Tipos de Filtro Temporal e Calendário
// ==========================================

export type DatePresetKey =
  | "today"
  | "yesterday"
  | "last7days"
  | "last14days"
  | "thisMonth"
  | "lastMonth"
  | "thisYear"
  | "all"
  | "custom";

export interface DateRange {
  from?: Date | null;
  to?: Date | null;
}

export interface DateRangeFilter {
  key: DatePresetKey;
  from?: Date | null;
  to?: Date | null;
  label?: string;
}

// ==========================================
// Tipos para Agrupamento em Lotes (Batches)
// ==========================================

export interface BatchExecutionSummary {
  totalCount: number;
  successCount: number;
  errorCount: number;
  runningCount: number;
  waitingCount: number;
  successRate: number; // 0 a 100
  successRateFormatted: string; // ex: "100%", "80%"
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  totalAmount?: number; // Para lotes fiscais DANFE
}

export interface BatchExecutionGroup<T> {
  id: string;
  batchNumber: number;
  dateKey: string; // YYYY-MM-DD em America/Sao_Paulo
  dateLabel: string; // ex: "14/09/2026"
  timeRangeLabel: string; // ex: "10:35:12 → 10:38:45"
  summary: BatchExecutionSummary;
  items: T[];
}

export interface BatchGroupingOptions {
  /** Janela em minutos para agrupar runs no mesmo lote (padrão: 5 min) */
  windowMinutes?: number;
  /** Se deve respeitar limites de dia (não misturar dias diferentes no mesmo lote) */
  groupByDate?: boolean;
  /** Ordenação ('desc' para mais recentes primeiro) */
  sortOrder?: "asc" | "desc";
}

