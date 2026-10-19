"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Barcode,
  CheckCircle2,
  ChevronRight,
  CircleCheckBig,
  History,
  Info,
  Landmark,
  RefreshCw,
  SearchX,
  TrendingDown,
  TrendingUp,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { InterLogo, TinyLogo } from "@/components/ui/brand-logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Empty, SourceError } from "./panel-state";
import ReconciliationHistory from "./reconciliation-history";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { formatCnpjMask, formatDateBR, money } from "@/lib/formatters";
import { toSaoPauloISODate } from "@/lib/date-range-utils";
import { downloadCsv } from "@/lib/csv-export";
import { ColumnFilterBar, ColumnFilterHeader } from "./column-filter";
import {
  aplicaFiltros,
  carregarFiltrosSession,
  filtrosAtivosCount,
  obterValoresUnicos,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from "@/lib/column-filters";
import type {
  AlreadyPaidItem,
  BaixaJob,
  BaixaResponse,
  InternalTransferItem,
  InternalTransferSituacao,
  PreviewJob,
  ReconciliationCompanyStatus,
  ReconciliationMatch,
  ReconciliationPreviewResponse,
  UnmatchedInterItem,
  UnmatchedTinyItem,
} from "@/lib/reconciliation-contracts";
import {
  INTER_HEALTH_META,
  MATCH_METHOD_META,
  RECONCILIATION_COMPANIES,
  buildBaixaItem,
  describeDadosDe,
  describeEstadoAtualizadoEm,
  describeJobProgress,
  describeSeparated,
  formatConfidence,
  formatElapsed,
  isInterUnavailable,
  parseAvisos,
  resolveInterHealth,
  separatedTotals,
  waitForJob,
  type InterHealth,
  type StatusTone,
} from "@/lib/reconciliation-helpers";
import { createReconciliationService } from "@/lib/reconciliation-service";
import { useAuth } from "@/lib/auth-context";

interface ReconciliationViewProps {
  apiBaseUrl?: string;
}

type TabId = "matches" | "unmatched_inter" | "unmatched_tiny" | "ja_baixadas" | "transferencias";

type ViewMode = "conciliacao" | "historico";

// Situação do extrato Inter na última prévia: define se os números de casamento são confiáveis.
type InterCoverage = "completo" | "parcial" | "indisponivel";

const DOT_CLASS: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  secondary: "bg-muted-foreground/40",
};

const TRANSFER_SITUACAO_META: Record<InternalTransferSituacao, { label: string; tone: StatusTone }> = {
  apta_baixa: { label: "Apta para baixa", tone: "success" },
  ja_baixada: { label: "Já baixada no Tiny", tone: "secondary" },
  sem_conta: { label: "Sem conta no Tiny", tone: "warning" },
};

const TABLE_SKELETON_ROWS = 6;

/** Junta os campos pesquisáveis de uma coluna (nome + CNPJ, documento + IDs…). */
function juntar(...campos: Array<string | number | null | undefined>): string {
  return campos.filter((c) => c !== null && c !== undefined && c !== "").join(" ");
}

const MATCHES_DEFS: Record<string, ColumnFilterDef<ReconciliationMatch>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (m) => m.empresa_nome || m.empresa },
  fornecedor: { id: "fornecedor", label: "Fornecedor", tipo: "texto", accessor: (m) => juntar(m.fornecedor_nome, m.fornecedor_cnpj) },
  documento: { id: "documento", label: "Documento", tipo: "texto", accessor: (m) => juntar(m.numero_documento, String(m.conta_pagar_id), m.codigo_barras) },
  data_inter: { id: "data_inter", label: "Venc. / Pgto.", tipo: "data", accessor: (m) => m.data_pagamento || m.data_vencimento },
  valor_inter: { id: "valor_inter", label: "Valor Inter", tipo: "numero", accessor: (m) => m.valor_pago },
  data_tiny: { id: "data_tiny", label: "Data Tiny", tipo: "data", accessor: (m) => m.data_vencimento },
  valor_tiny: { id: "valor_tiny", label: "Valor Tiny", tipo: "numero", accessor: (m) => m.valor_tiny },
  diferenca: { id: "diferenca", label: "Diferença", tipo: "numero", accessor: (m) => Math.abs(m.valor_pago - m.valor_tiny) },
  status: { id: "status", label: "Critério / Status", tipo: "lista", accessor: (m) => (m.metodo_match in MATCH_METHOD_META ? MATCH_METHOD_META[m.metodo_match].label : m.metodo_match) },
};

const UNMATCHED_INTER_DEFS: Record<string, ColumnFilterDef<UnmatchedInterItem>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (i) => i.empresa_nome || i.empresa },
  data: { id: "data", label: "Data pgto.", tipo: "data", accessor: (i) => i.data_pagamento },
  favorecido: { id: "favorecido", label: "Favorecido", tipo: "texto", accessor: (i) => juntar(i.nome_favorecido, i.cpf_cnpj_favorecido) },
  descricao: { id: "descricao", label: "Descrição", tipo: "texto", accessor: (i) => juntar(i.descricao, i.titulo) },
  codigo: { id: "codigo", label: "Código de barras / ID", tipo: "texto", accessor: (i) => juntar(i.codigo_barras, i.transacao_id) },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (i) => i.valor_pago },
};

const UNMATCHED_TINY_DEFS: Record<string, ColumnFilterDef<UnmatchedTinyItem>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (c) => c.empresa_nome || c.empresa },
  vencimento: { id: "vencimento", label: "Vencimento", tipo: "data", accessor: (c) => c.data_vencimento },
  fornecedor: { id: "fornecedor", label: "Fornecedor", tipo: "texto", accessor: (c) => juntar(c.fornecedor_nome, c.fornecedor_cnpj) },
  documento: { id: "documento", label: "Documento", tipo: "texto", accessor: (c) => juntar(c.numero_documento, String(c.id)) },
  valor: { id: "valor", label: "Valor em aberto", tipo: "numero", accessor: (c) => c.valor },
  historico: { id: "historico", label: "Histórico", tipo: "texto", accessor: (c) => `${c.numero_documento || ""} ${c.historico || ""}`.trim() },
};

const JA_BAIXADAS_DEFS: Record<string, ColumnFilterDef<AlreadyPaidItem>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (p) => p.empresa_nome || p.empresa },
  data_baixa: { id: "data_baixa", label: "Data pgto.", tipo: "data", accessor: (p) => p.data_pagamento },
  fornecedor: { id: "fornecedor", label: "Favorecido (Inter)", tipo: "texto", accessor: (p) => juntar(p.nome_favorecido, p.fornecedor_nome, p.cpf_cnpj_favorecido) },
  conta: { id: "conta", label: "Conta no Tiny", tipo: "texto", accessor: (p) => juntar(String(p.conta_pagar_id), p.numero_documento, p.inter_transacao_id) },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (p) => p.valor_pago || p.valor_tiny },
};

const TRANSFERENCIAS_DEFS: Record<string, ColumnFilterDef<InternalTransferItem>> = {
  empresa_origem: { id: "empresa_origem", label: "Empresa Origem", tipo: "lista", accessor: (t) => t.empresa_nome || t.empresa },
  empresa_destino: { id: "empresa_destino", label: "Empresa Destino", tipo: "lista", accessor: (t) => t.empresa_destino_nome },
  data: { id: "data", label: "Data pgto.", tipo: "data", accessor: (t) => t.data_pagamento },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (t) => t.valor_pago },
  situacao: { id: "situacao", label: "Situação", tipo: "lista", accessor: (t) => (t.situacao in TRANSFER_SITUACAO_META ? TRANSFER_SITUACAO_META[t.situacao].label : t.situacao) },
  descricao: { id: "descricao", label: "Descrição", tipo: "texto", accessor: (t) => juntar(t.nome_favorecido, t.cpf_cnpj_favorecido, t.descricao, t.titulo, t.transacao_id) },
};

function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toSaoPauloISODate(d);
}

// Espera após a última mudança de filtro antes de criar o job da prévia (evita um job por
// tecla ao digitar datas). Curta: com o cache do backend a resposta costuma ser imediata.
const PREVIEW_START_DELAY_MS = 300;

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === "TimeoutError";
}

function describePreviewError(e: unknown): string {
  if (isTimeout(e)) {
    return "O servidor não respondeu a tempo ao acompanhar a comparação. Tente novamente.";
  }
  return e instanceof Error ? e.message : "Erro ao carregar a prévia de conciliação.";
}

function describeBaixaError(e: unknown, fallback: string): string {
  if (isTimeout(e)) return "O servidor não respondeu a tempo. Confira o Histórico antes de tentar de novo.";
  return e instanceof Error ? e.message : fallback;
}

function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  // value null = indeterminado (ainda sem total conhecido).
  return (
    <Progress
      value={percent}
      aria-label={label}
      className={cn("w-full", percent === null && "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-pulse")}
    />
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

interface CompanyRow {
  id: string;
  nome: string;
  health: InterHealth;
  detalhe: string | null;
  tinyConfigurado: boolean | undefined;
}

function TechnicalDetail({ text }: { text: string }) {
  return (
    <details className="group text-[11px]">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        Detalhe técnico
      </summary>
      <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

function CompanyStatusCell({ row, inFilter }: { row: CompanyRow; inFilter: boolean }) {
  const meta = INTER_HEALTH_META[row.health];
  return (
    <li className={cn("space-y-2 bg-card p-4", !inFilter && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <span className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[meta.tone])} aria-hidden="true" />
          <span className="truncate">{row.nome}</span>
        </span>
        {!inFilter && <span className="shrink-0 text-[10px] text-muted-foreground">Fora do filtro</span>}
      </div>
      <Badge variant={meta.tone} className="h-auto whitespace-normal text-left">
        {meta.label}
      </Badge>
      {row.health !== "conectado" && <p className="text-xs leading-relaxed text-muted-foreground">{meta.hint}</p>}
      {row.detalhe && <TechnicalDetail text={row.detalhe} />}
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <TinyLogo size={12} />
        Tiny ERP:{" "}
        {row.tinyConfigurado === undefined ? "não verificado" : row.tinyConfigurado ? "token configurado" : "sem token"}
      </p>
    </li>
  );
}

function CompanyStatusSkeleton() {
  return (
    <li className="space-y-2.5 bg-card p-4" aria-hidden="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-5 w-24 rounded-full" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-28" />
    </li>
  );
}

function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-10 text-center text-xs text-muted-foreground">
      <Icon size={22} className="mx-auto mb-2.5 text-primary" />
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md">{children}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

function PreviewProgressPanel({ job, elapsedMs }: { job: PreviewJob | null; elapsedMs: number | null }) {
  // `total` da prévia conta filiais; se o backend passar a contar etapas, some a unidade.
  const unidade = job && job.total > 0 && job.total <= RECONCILIATION_COMPANIES.length ? "filiais" : "";
  const progress = job
    ? describeJobProgress(job, unidade)
    : { percent: null, label: "Iniciando a comparação no servidor…" };
  return (
    <div className="panel space-y-2.5 p-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <output className="flex min-w-0 items-center gap-2 font-medium text-foreground" aria-live="polite">
          <RefreshCw size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span className="truncate">{progress.label}</span>
        </output>
        {elapsedMs !== null && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatElapsed(elapsedMs)}
          </span>
        )}
      </div>
      <ProgressBar percent={progress.percent} label="Andamento da comparação" />
      <p className="text-[11px] text-muted-foreground">
        Cruzando o extrato do Banco Inter com as contas a pagar do Tiny. Pode levar alguns minutos: o Tiny limita a
        velocidade das consultas.
      </p>
    </div>
  );
}

function MetricSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <div className="metric-card skeleton h-[132px]" key={i} />
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="panel" aria-hidden="true">
      <div className="flex flex-wrap gap-2 border-b border-border p-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: TABLE_SKELETON_ROWS }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5 sm:px-5">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="h-4 w-24 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="hidden h-4 w-20 shrink-0 sm:block" />
            <Skeleton className="h-4 w-24 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCard({
  active,
  onSelect,
  label,
  icon: Icon,
  iconClass,
  value,
  detail,
  note,
  partial,
}: {
  active: boolean;
  onSelect: () => void;
  label: string;
  icon: LucideIcon;
  iconClass: string;
  value: string;
  detail: string;
  note?: string | null;
  partial?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "metric-card cursor-pointer text-left outline-offset-[-1px] focus-visible:outline-2 focus-visible:outline-ring",
        active && "outline-2 outline-primary",
      )}
    >
      <div className="metric-top">
        <span className="flex items-center gap-1.5">
          {label}
          {partial && (
            <Badge variant="warning" className="text-[10px] normal-case tracking-normal">
              Parcial
            </Badge>
          )}
        </span>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-md border", iconClass)}>
          <Icon size={18} />
        </span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail text-xs">{detail}</div>
      {note && (
        <p className="mt-2 flex items-start gap-1.5 border-t border-border/60 pt-2 text-[11px] leading-snug text-muted-foreground">
          <Info size={12} className="mt-px shrink-0" aria-hidden="true" />
          {note}
        </p>
      )}
    </button>
  );
}

function SupplierCell({ nome, cnpj }: { nome: string; cnpj: string | null }) {
  return (
    <div className="min-w-44 max-w-72 whitespace-normal">
      <div className="font-medium text-foreground">{nome}</div>
      {cnpj && <div className="font-mono text-[11px] text-muted-foreground">{formatCnpjMask(cnpj)}</div>}
    </div>
  );
}

export default function ReconciliationView({ apiBaseUrl }: ReconciliationViewProps) {
  const service = useMemo(() => createReconciliationService(apiBaseUrl), [apiBaseUrl]);
  // A prévia (job no gateway) exige contas_pagar:importar_extrato; a baixa, contas_pagar:baixar.
  const { can } = useAuth();
  const canPreview = can("contas_pagar:importar_extrato");
  const canBaixar = can("contas_pagar:baixar");

  // Conciliação × Histórico. O histórico só monta na primeira visita e depois fica montado
  // (escondido) para preservar filtros/página; `historyReload` o recarrega após uma baixa.
  const [viewMode, setViewMode] = useState<ViewMode>("conciliacao");
  const [historyMounted, setHistoryMounted] = useState(false);
  const [historyReload, setHistoryReload] = useState(0);
  const selectView = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === "historico") setHistoryMounted(true);
  };

  // Filtros
  const [empresa, setEmpresa] = useState<string>("todas");
  const [dataInicio, setDataInicio] = useState<string>(defaultStartDate);
  const [dataFim, setDataFim] = useState<string>(() => toSaoPauloISODate(new Date()));
  const [activeTab, setActiveTab] = useState<TabId>("matches");

  // Filtros de coluna no estilo planilha (persistidos por aba em sessionStorage)
  const [colFilters, setColFilters] = useState<Record<TabId, ColumnFiltersState>>(() => ({
    matches: carregarFiltrosSession("reconciliation", "matches"),
    unmatched_inter: carregarFiltrosSession("reconciliation", "unmatched_inter"),
    unmatched_tiny: carregarFiltrosSession("reconciliation", "unmatched_tiny"),
    ja_baixadas: carregarFiltrosSession("reconciliation", "ja_baixadas"),
    transferencias: carregarFiltrosSession("reconciliation", "transferencias"),
  }));

  const updateColFilter = (tab: TabId, colId: string, val: ColumnFilterValue | undefined) => {
    setColFilters((prev) => {
      const updatedTab = { ...prev[tab], [colId]: val };
      salvarFiltrosSession("reconciliation", tab, updatedTab);
      return { ...prev, [tab]: updatedTab };
    });
  };

  const clearColFilters = (tab: TabId) => {
    setColFilters((prev) => {
      salvarFiltrosSession("reconciliation", tab, {});
      return { ...prev, [tab]: {} };
    });
  };

  // Prévia: cada combinação de filtros (+ recargas manuais) gera uma chave; o carregamento
  // é derivado de "a última resposta é desta chave?", sem setState síncrono no efeito.
  // `forcarKey`: a requisição com essa chave (filtros + token) veio do "Comparar" e ignora o
  // cache do backend. Qualquer troca de filtro depois gera outra chave e volta a usar o cache.
  const [reload, setReload] = useState<{ token: number; forcarKey: string | null }>({ token: 0, forcarKey: null });
  const reloadToken = reload.token;
  const datesInvalid = !dataInicio || !dataFim || dataInicio > dataFim;
  const requestKey = `${empresa}|${dataInicio}|${dataFim}|${reloadToken}`;
  const forcarAtualizacao = reload.forcarKey === requestKey;
  const [preview, setPreview] = useState<{
    key: string;
    empresa: string;
    data: ReconciliationPreviewResponse;
  } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);
  const loading = canPreview && !datesInvalid && preview?.key !== requestKey && previewError?.key !== requestKey;
  const currentError = !canPreview
    ? "Seu usuário não tem a ação Importar extrato (prévia) de Contas a Pagar. Peça ao administrador para liberar em Gestão de Usuários."
    : previewError?.key === requestKey
      ? previewError.message
      : null;

  // Status de conexão por filial
  const [statusToken, setStatusToken] = useState(0);
  const [statusResult, setStatusResult] = useState<{
    token: number;
    empresas: ReconciliationCompanyStatus[] | null;
  } | null>(null);
  const statusLoading = statusResult?.token !== statusToken;

  // Estado persistente da rotina diária
  const [estadoAtualizadoEm, setEstadoAtualizadoEm] = useState<string | null>(null);

  // Seleção para baixa
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    service
      .getEstado(controller.signal)
      .then((res) => {
        if (res && res.status === "ok" && (res.matches?.length || res.unmatched_tiny?.length || res.summary?.total_casados)) {
          setPreview((prev) => {
            if (!prev) {
              return { key: requestKey, empresa, data: res };
            }
            return prev;
          });
          if (res.atualizado_em) {
            setEstadoAtualizadoEm(res.atualizado_em);
          }
          setSelectedIds(new Set((res.matches || []).map((m) => m.conta_pagar_id)));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [service, requestKey, empresa]);

  // Modal de confirmação & execução
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [baixaResult, setBaixaResult] = useState<BaixaResponse | null>(null);
  const [baixaError, setBaixaError] = useState<string | null>(null);
  // Job de baixa em andamento (null antes de iniciar); o polling é abortável ao fechar o modal.
  const [baixaJob, setBaixaJob] = useState<BaixaJob | null>(null);
  const [baixaStartedAt, setBaixaStartedAt] = useState(0);
  const baixaPollRef = useRef<AbortController | null>(null);

  const [previewProgress, setPreviewProgress] = useState<{
    key: string;
    startedAt: number;
    job: PreviewJob | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    service
      .getStatus(controller.signal)
      .then((res) => setStatusResult({ token: statusToken, empresas: res.empresas || [] }))
      .catch(() => {
        if (!controller.signal.aborted) setStatusResult({ token: statusToken, empresas: null });
      });
    return () => controller.abort();
  }, [service, statusToken]);

  // A prévia roda como job no backend (1–3 min; o NGINX corta requisições em ~60 s):
  // inicia o job e consulta o andamento. Trocar filtros/recarregar aborta só o polling
  // anterior (não há cancelamento no servidor), por isso o início espera uma pausa curta
  // na digitação das datas para não disparar um job por tecla.
  useEffect(() => {
    if (datesInvalid || !canPreview) return;
    const controller = new AbortController();
    const { signal } = controller;
    const startDelay = setTimeout(() => {
      const startedAt = Date.now();
      setPreviewProgress({ key: requestKey, startedAt, job: null });
      service
        .startPreviewJob(
          {
            empresa: empresa === "todas" ? undefined : empresa,
            data_inicio: dataInicio,
            data_fim: dataFim,
            forcar_atualizacao: forcarAtualizacao || undefined,
          },
          signal,
        )
        .then((job) =>
          waitForJob((id, s) => service.getJob(id, s), job, {
            signal,
            onProgress: (j) => setPreviewProgress({ key: requestKey, startedAt, job: j }),
          }),
        )
        .then((job) => {
          const res = job.resultado;
          if (!res) return;
          setEstadoAtualizadoEm(null);
          setPreview({ key: requestKey, empresa, data: res });
          // Por padrão, marca todas as casadas como selecionadas
          setSelectedIds(new Set((res.matches || []).map((m) => m.conta_pagar_id)));
        })
        .catch((e: unknown) => {
          if (signal.aborted) return;
          setPreviewError({ key: requestKey, message: describePreviewError(e) });
        });
    }, PREVIEW_START_DELAY_MS);
    return () => {
      clearTimeout(startDelay);
      controller.abort();
    };
  }, [service, empresa, dataInicio, dataFim, datesInvalid, requestKey, forcarAtualizacao, canPreview]);

  // Relógio para o tempo decorrido da prévia/baixa em andamento.
  const baixaRunning = baixaJob !== null && baixaResult === null && baixaError === null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!loading && !baixaRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [loading, baixaRunning]);
  const currentProgress = previewProgress?.key === requestKey ? previewProgress : null;

  // Para o polling da baixa se a tela for desmontada.
  useEffect(() => () => baixaPollRef.current?.abort(), []);

  // Recarga comum (ex.: após baixa) usa o cache do backend, que já descarta as filiais
  // baixadas; "Comparar" força consultar Inter e Tiny de novo.
  const refresh = () => setReload((r) => ({ token: r.token + 1, forcarKey: null }));
  const refreshForced = () =>
    setReload((r) => ({ token: r.token + 1, forcarKey: `${empresa}|${dataInicio}|${dataFim}|${r.token + 1}` }));

  const data = preview?.data ?? null;
  const avisos = useMemo(() => parseAvisos(data?.avisos), [data]);

  const companyRows = useMemo<CompanyRow[]>(
    () =>
      RECONCILIATION_COMPANIES.map((c) => {
        const status = statusResult?.empresas?.find((s) => s.id === c.id);
        const { health, detalhe } = resolveInterHealth(status, avisos.inter.get(c.id));
        return { id: c.id, nome: status?.nome ?? c.nome, health, detalhe, tinyConfigurado: status?.tiny_configurado };
      }),
    [statusResult, avisos],
  );

  const connectedCount = companyRows.filter((r) => r.health === "conectado").length;

  // Filiais da última prévia cujo extrato Inter não entrou no cruzamento.
  const coverage = useMemo(() => {
    if (!preview) return { state: "completo" as InterCoverage, offline: [] as string[], online: [] as string[] };
    const scope = companyRows.filter((r) => preview.empresa === "todas" || preview.empresa === r.id);
    const offline = scope.filter((r) => isInterUnavailable(r.health)).map((r) => r.nome);
    const online = scope.filter((r) => !isInterUnavailable(r.health)).map((r) => r.nome);
    const state: InterCoverage = offline.length === 0 ? "completo" : online.length === 0 ? "indisponivel" : "parcial";
    return { state, offline, online };
  }, [preview, companyRows]);
  const interDown = coverage.state === "indisponivel";

  const filteredMatches = useMemo(
    () => aplicaFiltros(data?.matches ?? [], colFilters.matches, MATCHES_DEFS),
    [data, colFilters.matches],
  );

  const filteredUnmatchedInter = useMemo(
    () => aplicaFiltros(data?.unmatched_inter ?? [], colFilters.unmatched_inter, UNMATCHED_INTER_DEFS),
    [data, colFilters.unmatched_inter],
  );

  const filteredUnmatchedTiny = useMemo(
    () => aplicaFiltros(data?.unmatched_tiny ?? [], colFilters.unmatched_tiny, UNMATCHED_TINY_DEFS),
    [data, colFilters.unmatched_tiny],
  );

  const filteredJaBaixadas = useMemo(
    () => aplicaFiltros(data?.ja_baixadas ?? [], colFilters.ja_baixadas, JA_BAIXADAS_DEFS),
    [data, colFilters.ja_baixadas],
  );

  const filteredTransferencias = useMemo(
    () => aplicaFiltros(data?.transferencias_internas ?? [], colFilters.transferencias, TRANSFERENCIAS_DEFS),
    [data, colFilters.transferencias],
  );

  const rawTotalDaAba = {
    matches: data?.matches?.length ?? 0,
    unmatched_inter: data?.unmatched_inter?.length ?? 0,
    unmatched_tiny: data?.unmatched_tiny?.length ?? 0,
    ja_baixadas: data?.ja_baixadas?.length ?? 0,
    transferencias: data?.transferencias_internas?.length ?? 0,
  }[activeTab];

  const activeDefs = {
    matches: MATCHES_DEFS,
    unmatched_inter: UNMATCHED_INTER_DEFS,
    unmatched_tiny: UNMATCHED_TINY_DEFS,
    ja_baixadas: JA_BAIXADAS_DEFS,
    transferencias: TRANSFERENCIAS_DEFS,
  }[activeTab] as Record<string, ColumnFilterDef<unknown>>;

  // CSV da aba ativa, com os filtros aplicados.
  function exportarCsvDaAba() {
    const nomeEmpresa = (id: string, nome?: string | null) => nome || RECONCILIATION_COMPANIES.find((c) => c.id === id)?.nome || id;
    if (activeTab === "matches") {
      downloadCsv("contas-casadas", ["Empresa", "Fornecedor", "CNPJ", "Documento", "Conta Tiny", "Vencimento", "Pagamento", "Valor Tiny", "Pago no Inter", "Critério"],
        filteredMatches.map((m) => [nomeEmpresa(m.empresa, m.empresa_nome), m.fornecedor_nome, m.fornecedor_cnpj, m.numero_documento, m.conta_pagar_id, m.data_vencimento, m.data_pagamento, m.valor_tiny, m.valor_pago, m.metodo_match]));
    } else if (activeTab === "unmatched_inter") {
      downloadCsv("debitos-inter-sem-par", ["Empresa", "Favorecido", "CPF/CNPJ", "Descrição", "Pagamento", "Valor", "Transação Inter"],
        filteredUnmatchedInter.map((i) => [nomeEmpresa(i.empresa, i.empresa_nome), i.nome_favorecido, i.cpf_cnpj_favorecido, i.descricao || i.titulo, i.data_pagamento, i.valor_pago, i.transacao_id]));
    } else if (activeTab === "unmatched_tiny") {
      downloadCsv("contas-tiny-em-aberto", ["Empresa", "Fornecedor", "CNPJ", "Documento", "Conta Tiny", "Vencimento", "Valor"],
        filteredUnmatchedTiny.map((c) => [nomeEmpresa(c.empresa, c.empresa_nome), c.fornecedor_nome, c.fornecedor_cnpj, c.numero_documento, c.id, c.data_vencimento, c.valor]));
    } else if (activeTab === "ja_baixadas") {
      downloadCsv("ja-baixadas-no-tiny", ["Empresa", "Fornecedor", "Documento", "Conta Tiny", "Vencimento", "Pagamento", "Valor Tiny", "Pago no Inter"],
        filteredJaBaixadas.map((p) => [nomeEmpresa(p.empresa, p.empresa_nome), p.fornecedor_nome || p.nome_favorecido, p.numero_documento, p.conta_pagar_id, p.data_vencimento, p.data_pagamento, p.valor_tiny, p.valor_pago]));
    } else {
      downloadCsv("transferencias-entre-empresas", ["Empresa", "Para", "Favorecido", "Pagamento", "Valor", "Situação", "Transação Inter"],
        filteredTransferencias.map((t) => [nomeEmpresa(t.empresa, t.empresa_nome), t.empresa_destino_nome, t.nome_favorecido, t.data_pagamento, t.valor_pago, t.situacao, t.transacao_id]));
    }
  }
  const totalDaAba = {
    matches: filteredMatches.length,
    unmatched_inter: filteredUnmatchedInter.length,
    unmatched_tiny: filteredUnmatchedTiny.length,
    ja_baixadas: filteredJaBaixadas.length,
    transferencias: filteredTransferencias.length,
  }[activeTab];

  const separated = useMemo(() => (data ? separatedTotals(data) : null), [data]);
  const separatedNote = separated ? describeSeparated(separated) : null;

  const toggleSelectOne = (contaId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(contaId)) {
        next.delete(contaId);
      } else {
        next.add(contaId);
      }
      return next;
    });
  };

  // "Selecionar todas" age só sobre as linhas visíveis com o filtro atual.
  const visibleSelectedCount = filteredMatches.filter((m) => selectedIds.has(m.conta_pagar_id)).length;
  const allVisibleSelected = filteredMatches.length > 0 && visibleSelectedCount === filteredMatches.length;
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const m of filteredMatches) {
        if (allVisibleSelected) next.delete(m.conta_pagar_id);
        else next.add(m.conta_pagar_id);
      }
      return next;
    });
  };

  // Transferências entre empresas conciliadas com conta em aberto no Tiny: baixadas pela
  // própria aba, com o mesmo fluxo (job + histórico) das contas casadas. Não vêm marcadas.
  const transferConciliacoes = useMemo(
    () =>
      filteredTransferencias.flatMap((t) =>
        t.situacao === "apta_baixa" && t.conciliacao ? [t.conciliacao] : [],
      ),
    [filteredTransferencias],
  );
  const selectedCasadas = useMemo(
    () => filteredMatches.filter((m) => selectedIds.has(m.conta_pagar_id)),
    [filteredMatches, selectedIds],
  );
  const selectedTransferencias = useMemo(
    () => transferConciliacoes.filter((m) => selectedIds.has(m.conta_pagar_id)),
    [transferConciliacoes, selectedIds],
  );
  // O modal confirma só o que foi marcado na aba de onde o botão foi clicado.
  const [baixaScope, setBaixaScope] = useState<"matches" | "transferencias">("matches");
  const selectedMatches = baixaScope === "transferencias" ? selectedTransferencias : selectedCasadas;
  const openBaixa = (scope: "matches" | "transferencias") => {
    setBaixaScope(scope);
    setIsModalOpen(true);
  };
  const totalSelectedValor = useMemo(() => selectedMatches.reduce((acc, m) => acc + m.valor_pago, 0), [selectedMatches]);
  const selectedCompanies = useMemo(() => new Set(selectedMatches.map((m) => m.empresa_nome)).size, [selectedMatches]);

  // Só não dá para fechar enquanto o job está sendo criado; depois ele roda sozinho no servidor.
  const closeModal = () => {
    if (isSubmitting) return;
    const poll = baixaPollRef.current;
    if (poll) {
      // Fechou no meio: para de acompanhar, mas o gateway segue baixando e gravando o histórico.
      poll.abort();
      baixaPollRef.current = null;
      setHistoryReload((t) => t + 1);
    }
    if (baixaJob && !baixaResult) {
      // Evita reenviar contas que podem já ter sido baixadas por este job.
      const enviados = new Set(selectedMatches.map((m) => m.conta_pagar_id));
      setSelectedIds((prev) => new Set([...prev].filter((id) => !enviados.has(id))));
    }
    setIsModalOpen(false);
    setBaixaResult(null);
    setBaixaError(null);
    setBaixaJob(null);
  };

  const handleConfirmBaixa = async () => {
    if (selectedMatches.length === 0) return;
    setIsSubmitting(true);
    setBaixaResult(null);
    setBaixaError(null);
    setBaixaJob(null);

    const payload = selectedMatches.map(buildBaixaItem);

    let job: BaixaJob;
    try {
      job = await service.startBaixaJob(payload);
    } catch (e) {
      setBaixaError(describeBaixaError(e, "Falha na comunicação ao iniciar a baixa."));
      setIsSubmitting(false);
      return;
    }
    setIsSubmitting(false);
    setBaixaStartedAt(Date.now());
    setBaixaJob(job);

    const controller = new AbortController();
    baixaPollRef.current = controller;
    try {
      const done = await waitForJob((id, s) => service.getJob(id, s), job, {
        signal: controller.signal,
        onProgress: setBaixaJob,
      });
      const res = done.resultado;
      if (!res) return;
      setBaixaResult(res);
      // Toda execução (inclusive falhas) vai para o histórico; a prévia só muda se algo foi baixado.
      setHistoryReload((t) => t + 1);
      if (res.total_sucessos > 0) {
        setTimeout(refresh, 1500);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setBaixaError(describeBaixaError(e, "Falha ao acompanhar a baixa."));
      setHistoryReload((t) => t + 1);
    } finally {
      if (baixaPollRef.current === controller) baixaPollRef.current = null;
    }
  };

  const tabs: Array<{ id: TabId; label: string; count: number; icon: LucideIcon }> = [
    { id: "matches", label: "Contas casadas", count: data?.matches.length ?? 0, icon: CheckCircle2 },
    { id: "unmatched_inter", label: "Débitos Inter sem par", count: data?.unmatched_inter?.length ?? 0, icon: TrendingUp },
    { id: "unmatched_tiny", label: "Contas Tiny em aberto", count: data?.unmatched_tiny?.length ?? 0, icon: TrendingDown },
  ];
  // Abas de conferência: não são pendências, ficam com menos destaque.
  const secondaryTabs: Array<{ id: TabId; label: string; count: number; icon: LucideIcon }> = [
    { id: "ja_baixadas", label: "Já baixadas no Tiny", count: data?.ja_baixadas?.length ?? 0, icon: CircleCheckBig },
    {
      id: "transferencias",
      label: "Transferências entre empresas",
      count: data?.transferencias_internas?.length ?? 0,
      icon: ArrowLeftRight,
    },
  ];

  const hasSearch = filtrosAtivosCount(colFilters[activeTab], activeDefs) > 0;
  const searchEmpty = (
    <EmptyState
      icon={SearchX}
      title="Nada encontrado para os filtros aplicados"
      action={
        <Button size="sm" variant="outline" onClick={() => clearColFilters(activeTab)}>
          Limpar filtros
        </Button>
      }
    >
      Nenhuma linha desta aba atende aos filtros de coluna aplicados.
    </EmptyState>
  );
  const interDownEmpty = (
    <EmptyState
      icon={Unplug}
      title="Extrato do Banco Inter indisponível"
      action={
        <Button size="sm" variant="outline" onClick={refreshForced} className="gap-1.5">
          <RefreshCw size={13} />
          Comparar novamente
        </Button>
      }
    >
      Sem o extrato não há pagamentos para casar com o Tiny. Corrija a conexão das filiais em “Conexão com o Banco
      Inter” e compare de novo.
    </EmptyState>
  );

  const tinyAvisos = avisos.outros;

  const renderTabButton = (t: { id: TabId; label: string; count: number; icon: LucideIcon }, secondary = false) => (
    <button
      key={t.id}
      type="button"
      role="tab"
      id={`rec-tab-${t.id}`}
      aria-selected={activeTab === t.id}
      aria-controls="rec-tabpanel"
      onClick={() => setActiveTab(t.id)}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition",
        secondary ? "text-[11px]" : "text-xs",
        activeTab === t.id
          ? "bg-muted text-foreground"
          : secondary
            ? "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <t.icon size={secondary ? 13 : 14} />
      {t.label}
      <Badge variant={activeTab === t.id ? "outline" : "secondary"} className="count-badge">
        {t.count}
      </Badge>
    </button>
  );

  const viewOptions: Array<{ id: ViewMode; label: string; icon: LucideIcon }> = [
    { id: "conciliacao", label: "Conciliação", icon: Landmark },
    { id: "historico", label: "Histórico de baixas", icon: History },
  ];

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Seção de contas a pagar"
        className="inline-flex w-full rounded-lg border border-border bg-card p-1 text-sm sm:w-auto"
      >
        {viewOptions.map((o) => (
          <button
            key={o.id}
            type="button"
            role="tab"
            id={`rec-view-tab-${o.id}`}
            aria-selected={viewMode === o.id}
            aria-controls={`rec-view-${o.id}`}
            onClick={() => selectView(o.id)}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3.5 py-1.5 font-medium transition sm:flex-none",
              viewMode === o.id
                ? "bg-muted text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <o.icon size={15} />
            {o.label}
          </button>
        ))}
      </div>

      {historyMounted && (
        <div
          role="tabpanel"
          id="rec-view-historico"
          aria-labelledby="rec-view-tab-historico"
          hidden={viewMode !== "historico"}
        >
          <ReconciliationHistory service={service} reloadSignal={historyReload} />
        </div>
      )}

      {viewMode === "conciliacao" && (
        <div role="tabpanel" id="rec-view-conciliacao" aria-labelledby="rec-view-tab-conciliacao" className="space-y-6">
          {/* Filtros */}
          <div className="panel p-4">
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div className="space-y-1.5">
                <label htmlFor="rec-empresa" className="text-xs font-medium text-muted-foreground">
                  Empresa / filial
                </label>
                <NativeSelect id="rec-empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)} className="w-full">
                  <NativeSelectOption value="todas">Todas as filiais</NativeSelectOption>
                  {RECONCILIATION_COMPANIES.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.nome}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-inicio" className="text-xs font-medium text-muted-foreground">
                  Data inicial
                </label>
                <Input
                  id="rec-inicio"
                  type="date"
                  value={dataInicio}
                  max={dataFim || undefined}
                  onChange={(e) => setDataInicio(e.target.value)}
                  aria-invalid={datesInvalid || undefined}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rec-fim" className="text-xs font-medium text-muted-foreground">
                  Data final
                </label>
                <Input
                  id="rec-fim"
                  type="date"
                  value={dataFim}
                  min={dataInicio || undefined}
                  onChange={(e) => setDataFim(e.target.value)}
                  aria-invalid={datesInvalid || undefined}
                />
              </div>
              {canPreview && (
              <Button
                variant="cta"
                onClick={refreshForced}
                disabled={loading || datesInvalid}
                title="Consulta o extrato do Inter e as contas do Tiny de novo"
                className="gap-1.5 sm:col-span-2 lg:col-span-1"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                {loading ? "Comparando…" : "Comparar"}
              </Button>
              )}
            </div>
            {datesInvalid && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                Informe um período válido: a data inicial precisa ser igual ou anterior à final.
              </p>
            )}
            {!datesInvalid && !loading && data && (describeEstadoAtualizadoEm(estadoAtualizadoEm) || describeDadosDe(data.dados_de, data.do_cache)) && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <History size={12} className="shrink-0" aria-hidden="true" />
                {describeEstadoAtualizadoEm(estadoAtualizadoEm) || describeDadosDe(data.dados_de, data.do_cache)}
              </p>
            )}
          </div>

          {/* Conexão por filial */}
          <section className="panel" aria-labelledby="rec-conexao-titulo">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="section-title">
                <div className="section-icon border border-border bg-white">
                  <InterLogo size={22} />
                </div>
                <div>
                  <h3 id="rec-conexao-titulo">
                    Conexão com o Banco Inter
                  </h3>
                  <p>
                    Extrato lido via mTLS por filial
                    <ArrowRight size={11} className="mx-1 inline" aria-hidden="true" />
                    baixa das contas no Tiny ERP v3.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 self-start sm:self-auto">
                {!statusLoading && statusResult?.empresas !== null && (
                  <Badge variant={connectedCount === companyRows.length ? "success" : connectedCount === 0 ? "danger" : "warning"}>
                    {connectedCount} de {companyRows.length} conectadas
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setStatusToken((t) => t + 1)}
                  disabled={statusLoading}
                  className="gap-1.5"
                >
                  <RefreshCw size={13} className={statusLoading ? "animate-spin" : ""} />
                  Verificar
                </Button>
              </div>
            </div>
            {!statusLoading && statusResult?.empresas === null && (
              <p role="alert" className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-5">
                <AlertTriangle size={13} className="shrink-0 text-amber-700 dark:text-amber-400" />
                Não foi possível consultar o status das conexões agora. O estado abaixo usa só os avisos da última comparação.
              </p>
            )}
            <ul className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4" aria-busy={statusLoading}>
              {statusLoading && !statusResult
                ? RECONCILIATION_COMPANIES.map((c) => <CompanyStatusSkeleton key={c.id} />)
                : companyRows.map((row) => (
                    <CompanyStatusCell key={row.id} row={row} inFilter={empresa === "todas" || empresa === row.id} />
                  ))}
            </ul>
          </section>

          {/* Resultado da comparação */}
          <section className="space-y-4" aria-busy={loading} aria-label="Resultado da conciliação">
            {datesInvalid ? null : loading ? (
              <>
                <PreviewProgressPanel
                  job={currentProgress?.job ?? null}
                  elapsedMs={currentProgress ? now - currentProgress.startedAt : null}
                />
                <MetricSkeletons />
                <TableSkeleton />
              </>
            ) : currentError ? (
              <div className="panel">
                <SourceError message={currentError} />
                <div className="flex justify-end border-t border-border px-4 py-3">
                  <Button size="sm" variant="outline" onClick={refreshForced} className="gap-1.5">
                    <RefreshCw size={13} />
                    Tentar novamente
                  </Button>
                </div>
              </div>
            ) : data ? (
              <>
                {coverage.state !== "completo" && (
                  <div
                    role="alert"
                    className="flex gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-xs"
                  >
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                    <div className="space-y-1">
                      <p className="font-semibold text-amber-700 dark:text-amber-300">
                        {interDown
                          ? "Conciliação não realizada: extrato do Banco Inter indisponível"
                          : "Conciliação parcial: falta o extrato de parte das filiais"}
                      </p>
                      <p className="leading-relaxed text-muted-foreground">
                        {interDown ? (
                          <>
                            Não foi possível ler o extrato de <strong className="text-foreground">{joinNames(coverage.offline)}</strong>.
                            Sem ele não há pagamentos para casar: todas as contas do Tiny aparecem como em aberto.
                          </>
                        ) : (
                          <>
                            Sem extrato de <strong className="text-foreground">{joinNames(coverage.offline)}</strong>. Os casamentos
                            consideram só {joinNames(coverage.online)}; as contas das demais filiais aparecem como em aberto.
                          </>
                        )}{" "}
                        Veja o motivo em “Conexão com o Banco Inter”.
                      </p>
                    </div>
                  </div>
                )}

                {tinyAvisos.length > 0 && (
                  <div className="flex gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-xs">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                    <div className="min-w-0 space-y-1.5">
                      <p className="font-semibold text-amber-700 dark:text-amber-300">
                        Parte das contas a pagar não foi carregada
                      </p>
                      <ul className="space-y-1.5 text-muted-foreground">
                        {tinyAvisos.map((a, idx) => (
                          <li key={idx}>
                            {a.fonte === "tiny" ? (
                              <>
                                <strong className="text-foreground">{a.empresa}</strong>: não foi possível ler as contas no Tiny ERP.
                                <TechnicalDetail text={a.mensagem} />
                              </>
                            ) : (
                              <>
                                {a.empresa && <strong className="text-foreground">{a.empresa}: </strong>}
                                {a.mensagem}
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                {/* Indicadores (também trocam a aba) */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <MetricCard
                    active={activeTab === "matches"}
                    onSelect={() => setActiveTab("matches")}
                    label="Contas casadas"
                    icon={CheckCircle2}
                    iconClass="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    value={interDown ? "—" : money(data.summary.valor_total_casados)}
                    detail={
                      interDown
                        ? "Extrato indisponível — nada para casar"
                        : `${data.summary.total_casados} conta(s) aptas para baixa`
                    }
                    partial={coverage.state === "parcial"}
                  />
                  <MetricCard
                    active={activeTab === "unmatched_inter"}
                    onSelect={() => setActiveTab("unmatched_inter")}
                    label="Débitos Inter sem par"
                    icon={TrendingUp}
                    iconClass="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    value={interDown ? "—" : money(data.summary.valor_inter_sem_par)}
                    detail={
                      interDown
                        ? "Extrato indisponível"
                        : `${data.summary.total_inter_sem_par} débito(s) sem conta aberta no Tiny`
                    }
                    note={interDown ? null : separatedNote}
                    partial={coverage.state === "parcial"}
                  />
                  <MetricCard
                    active={activeTab === "unmatched_tiny"}
                    onSelect={() => setActiveTab("unmatched_tiny")}
                    label="Contas Tiny em aberto"
                    icon={TrendingDown}
                    iconClass="border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-400"
                    value={money(data.summary.valor_tiny_sem_par)}
                    detail={
                      interDown
                        ? `${data.summary.total_tiny_sem_par} conta(s) — sem extrato para cruzar`
                        : `${data.summary.total_tiny_sem_par} conta(s) sem pagamento identificado`
                    }
                  />
                </div>

                {/* Abas + tabela */}
                <div className="panel">
                  <div className="flex flex-col gap-3 border-b border-border p-3 lg:flex-row lg:items-center lg:justify-between">
                    <div role="tablist" aria-label="Visões da conciliação" className="flex items-center gap-1 overflow-x-auto">
                      {tabs.map((t) => renderTabButton(t))}
                      <span className="mx-1.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
                      <span className="shrink-0 pr-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Conferência
                      </span>
                      {secondaryTabs.map((t) => renderTabButton(t, true))}
                    </div>

                    {((activeTab === "matches" && data.matches.length > 0) ||
                      (activeTab === "transferencias" && transferConciliacoes.length > 0)) &&
                      (() => {
                        const scope = activeTab === "transferencias" ? "transferencias" : "matches";
                        const selecionadas = scope === "transferencias" ? selectedTransferencias : selectedCasadas;
                        return (
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                            <span className="text-xs text-muted-foreground tabular-nums">
                              <strong className="text-foreground">{selecionadas.length}</strong> selecionada(s) ·{" "}
                              <strong className="text-foreground">
                                {money(selecionadas.reduce((acc, m) => acc + m.valor_pago, 0))}
                              </strong>
                            </span>
                            {canBaixar && (
                              <Button variant="cta" onClick={() => openBaixa(scope)} disabled={selecionadas.length === 0} className="gap-1.5">
                                <CheckCircle2 size={14} />
                                Dar baixa no Tiny ({selecionadas.length})
                              </Button>
                            )}
                          </div>
                        );
                      })()}
                  </div>

                  <ColumnFilterBar
                    totalCount={rawTotalDaAba}
                    filteredCount={totalDaAba}
                    activeFiltersCount={filtrosAtivosCount(colFilters[activeTab], activeDefs)}
                    onClearAll={() => clearColFilters(activeTab)}
                    onExportCsv={exportarCsvDaAba}
                    itemLabel={activeTab === "transferencias" ? "transferências" : "contas"}
                  />

                  <div role="tabpanel" id="rec-tabpanel" aria-labelledby={`rec-tab-${activeTab}`}>
                    {activeTab === "matches" &&
                      (filteredMatches.length === 0 ? (
                        interDown ? (
                          interDownEmpty
                        ) : hasSearch && data.matches.length > 0 ? (
                          searchEmpty
                        ) : (
                          <EmptyState icon={Landmark} title="Nenhum casamento encontrado">
                            Nenhum pagamento do extrato bateu com contas em aberto no período. Confira as outras abas ou
                            amplie o período.
                          </EmptyState>
                        )
                      ) : (
                        <>
                          <Table className="min-w-[980px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-10">
                                  <Checkbox
                                    checked={allVisibleSelected}
                                    indeterminate={visibleSelectedCount > 0 && !allVisibleSelected}
                                    onCheckedChange={toggleSelectAll}
                                    aria-label={allVisibleSelected ? "Desmarcar todas" : "Selecionar todas"}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Empresa"
                                    def={MATCHES_DEFS.empresa}
                                    value={colFilters.matches.empresa}
                                    onChange={(v) => updateColFilter("matches", "empresa", v)}
                                    uniqueValues={obterValoresUnicos(data.matches ?? [], (m) => m.empresa_nome || m.empresa)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Fornecedor"
                                    def={MATCHES_DEFS.fornecedor}
                                    value={colFilters.matches.fornecedor}
                                    onChange={(v) => updateColFilter("matches", "fornecedor", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Documento"
                                    def={MATCHES_DEFS.documento}
                                    value={colFilters.matches.documento}
                                    onChange={(v) => updateColFilter("matches", "documento", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Venc. / Pgto."
                                    def={MATCHES_DEFS.data_inter}
                                    value={colFilters.matches.data_inter}
                                    onChange={(v) => updateColFilter("matches", "data_inter", v)}
                                  />
                                </TableHead>
                                <TableHead className="text-right">
                                  <ColumnFilterHeader
                                    title="Valor Tiny"
                                    align="right"
                                    def={MATCHES_DEFS.valor_tiny}
                                    value={colFilters.matches.valor_tiny}
                                    onChange={(v) => updateColFilter("matches", "valor_tiny", v)}
                                  />
                                </TableHead>
                                <TableHead className="text-right">
                                  <ColumnFilterHeader
                                    title="Pago no Inter"
                                    align="right"
                                    def={MATCHES_DEFS.valor_inter}
                                    value={colFilters.matches.valor_inter}
                                    onChange={(v) => updateColFilter("matches", "valor_inter", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Critério"
                                    def={MATCHES_DEFS.status}
                                    value={colFilters.matches.status}
                                    onChange={(v) => updateColFilter("matches", "status", v)}
                                    uniqueValues={obterValoresUnicos(data.matches ?? [], (m) => (m.metodo_match in MATCH_METHOD_META ? MATCH_METHOD_META[m.metodo_match].label : m.metodo_match))}
                                  />
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredMatches.map((m) => {
                                const isSelected = selectedIds.has(m.conta_pagar_id);
                                const hasDivergence = Math.abs(m.valor_pago - m.valor_tiny) > 0.05;
                                const method = MATCH_METHOD_META[m.metodo_match];
                                return (
                                  <TableRow
                                    key={m.id}
                                    data-state={isSelected ? "selected" : undefined}
                                    onClick={() => toggleSelectOne(m.conta_pagar_id)}
                                    className="cursor-pointer align-top"
                                  >
                                    <TableCell>
                                      <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={() => toggleSelectOne(m.conta_pagar_id)}
                                        onClick={(e) => e.stopPropagation()}
                                        aria-label={`Selecionar ${m.fornecedor_nome}, documento ${m.numero_documento}`}
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <Badge variant="outline">{m.empresa_nome}</Badge>
                                    </TableCell>
                                    <TableCell>
                                      <SupplierCell nome={m.fornecedor_nome} cnpj={m.fornecedor_cnpj} />
                                    </TableCell>
                                    <TableCell>
                                      <div className="font-medium">{m.numero_documento}</div>
                                      <code>#{m.conta_pagar_id}</code>
                                    </TableCell>
                                    <TableCell className="tabular-nums">
                                      <div>{formatDateBR(m.data_vencimento)}</div>
                                      <div className="text-xs text-emerald-700 dark:text-emerald-400">
                                        {formatDateBR(m.data_pagamento)}
                                      </div>
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{money(m.valor_tiny)}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      <div className="font-semibold">{money(m.valor_pago)}</div>
                                      {hasDivergence && (m.juros > 0 || m.multa > 0 || m.desconto > 0) && (
                                        <div className="space-x-1.5 text-[11px]">
                                          {m.juros + m.multa > 0 && (
                                            <span className="text-amber-700 dark:text-amber-400">
                                              +{money(m.juros + m.multa)} {m.multa > 0 ? "juros/multa" : "juros"}
                                            </span>
                                          )}
                                          {m.desconto > 0 && (
                                            <span className="text-sky-700 dark:text-sky-400">−{money(m.desconto)} desc.</span>
                                          )}
                                        </div>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      <div className="max-w-60 space-y-1 whitespace-normal">
                                        <Badge variant={method?.tone ?? "secondary"}>
                                          {method?.label ?? m.metodo_match} · {formatConfidence(m.confianca)}
                                        </Badge>
                                        <p className="line-clamp-2 text-[11px] text-muted-foreground" title={m.motivo}>
                                          {m.motivo}
                                        </p>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                          <div className="table-footer">
                            <span>
                              Mostrando {filteredMatches.length} de {data.matches.length} casamento(s)
                            </span>
                            <span>Total casado: {money(filteredMatches.reduce((acc, m) => acc + m.valor_pago, 0))}</span>
                          </div>
                        </>
                      ))}

                    {activeTab === "unmatched_inter" && separatedNote && !interDown && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                        <Info size={12} className="shrink-0" aria-hidden="true" />
                        <span>{separatedNote} Eles ficam nas abas próprias (transferências conciliadas podem ser baixadas lá):</span>
                        {secondaryTabs
                          .filter((t) => t.count > 0)
                          .map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => setActiveTab(t.id)}
                              className="cursor-pointer font-medium text-primary underline-offset-2 hover:underline"
                            >
                              {t.label} ({t.count})
                            </button>
                          ))}
                      </div>
                    )}

                    {activeTab === "unmatched_inter" &&
                      (filteredUnmatchedInter.length === 0 ? (
                        interDown ? (
                          interDownEmpty
                        ) : hasSearch && (data.unmatched_inter?.length ?? 0) > 0 ? (
                          searchEmpty
                        ) : (
                          <Empty>Todos os débitos do extrato foram casados com contas do Tiny no período.</Empty>
                        )
                      ) : (
                        <>
                          <Table className="min-w-[900px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Empresa"
                                    def={UNMATCHED_INTER_DEFS.empresa}
                                    value={colFilters.unmatched_inter.empresa}
                                    onChange={(v) => updateColFilter("unmatched_inter", "empresa", v)}
                                    uniqueValues={obterValoresUnicos(data.unmatched_inter ?? [], (i) => i.empresa_nome || i.empresa)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Data pgto."
                                    def={UNMATCHED_INTER_DEFS.data}
                                    value={colFilters.unmatched_inter.data}
                                    onChange={(v) => updateColFilter("unmatched_inter", "data", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Favorecido"
                                    def={UNMATCHED_INTER_DEFS.favorecido}
                                    value={colFilters.unmatched_inter.favorecido}
                                    onChange={(v) => updateColFilter("unmatched_inter", "favorecido", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Descrição"
                                    def={UNMATCHED_INTER_DEFS.descricao}
                                    value={colFilters.unmatched_inter.descricao}
                                    onChange={(v) => updateColFilter("unmatched_inter", "descricao", v)}
                                  />
                                </TableHead>
                                <TableHead>Tipo</TableHead>
                                <TableHead className="text-right">
                                  <ColumnFilterHeader
                                    title="Valor"
                                    align="right"
                                    def={UNMATCHED_INTER_DEFS.valor}
                                    value={colFilters.unmatched_inter.valor}
                                    onChange={(v) => updateColFilter("unmatched_inter", "valor", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Código de barras / ID"
                                    def={UNMATCHED_INTER_DEFS.codigo}
                                    value={colFilters.unmatched_inter.codigo}
                                    onChange={(v) => updateColFilter("unmatched_inter", "codigo", v)}
                                  />
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredUnmatchedInter.map((itx) => (
                                <TableRow key={itx.transacao_id} className="align-top">
                                  <TableCell>
                                    <Badge variant="outline">{itx.empresa_nome}</Badge>
                                  </TableCell>
                                  <TableCell className="tabular-nums">{formatDateBR(itx.data_pagamento)}</TableCell>
                                  <TableCell>
                                    <SupplierCell
                                      nome={itx.nome_favorecido || itx.titulo || "Não informado"}
                                      cnpj={itx.cpf_cnpj_favorecido}
                                    />
                                  </TableCell>
                                  <TableCell>
                                    <p className="line-clamp-2 max-w-64 whitespace-normal text-xs" title={itx.descricao}>
                                      {itx.descricao || "—"}
                                    </p>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="secondary">{itx.tipo_transacao}</Badge>
                                  </TableCell>
                                  <TableCell className="text-right font-semibold tabular-nums">{money(itx.valor_pago)}</TableCell>
                                  <TableCell>
                                    <code
                                      className="block max-w-56 truncate"
                                      title={itx.codigo_barras || itx.transacao_id}
                                    >
                                      {itx.codigo_barras ? (
                                        <span className="inline-flex items-center gap-1">
                                          <Barcode size={11} /> {itx.codigo_barras}
                                        </span>
                                      ) : (
                                        `ID ${itx.transacao_id}`
                                      )}
                                    </code>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          <div className="table-footer">
                            <span>
                              Mostrando {filteredUnmatchedInter.length} de {data.unmatched_inter?.length ?? 0} débito(s)
                            </span>
                            <span>Total: {money(filteredUnmatchedInter.reduce((acc, itx) => acc + itx.valor_pago, 0))}</span>
                          </div>
                        </>
                      ))}

                    {activeTab === "unmatched_tiny" &&
                      (filteredUnmatchedTiny.length === 0 ? (
                        hasSearch && (data.unmatched_tiny?.length ?? 0) > 0 ? (
                          searchEmpty
                        ) : (
                          <Empty>Nenhuma conta a pagar em aberto no Tiny para o período e filial selecionados.</Empty>
                        )
                      ) : (
                        <>
                          <Table className="min-w-[820px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Empresa"
                                    def={UNMATCHED_TINY_DEFS.empresa}
                                    value={colFilters.unmatched_tiny.empresa}
                                    onChange={(v) => updateColFilter("unmatched_tiny", "empresa", v)}
                                    uniqueValues={obterValoresUnicos(data.unmatched_tiny ?? [], (c) => c.empresa_nome || c.empresa)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Vencimento"
                                    def={UNMATCHED_TINY_DEFS.vencimento}
                                    value={colFilters.unmatched_tiny.vencimento}
                                    onChange={(v) => updateColFilter("unmatched_tiny", "vencimento", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Fornecedor"
                                    def={UNMATCHED_TINY_DEFS.fornecedor}
                                    value={colFilters.unmatched_tiny.fornecedor}
                                    onChange={(v) => updateColFilter("unmatched_tiny", "fornecedor", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Documento"
                                    def={UNMATCHED_TINY_DEFS.documento}
                                    value={colFilters.unmatched_tiny.documento}
                                    onChange={(v) => updateColFilter("unmatched_tiny", "documento", v)}
                                  />
                                </TableHead>
                                <TableHead className="text-right">
                                  <ColumnFilterHeader
                                    title="Valor em aberto"
                                    align="right"
                                    def={UNMATCHED_TINY_DEFS.valor}
                                    value={colFilters.unmatched_tiny.valor}
                                    onChange={(v) => updateColFilter("unmatched_tiny", "valor", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Histórico"
                                    def={UNMATCHED_TINY_DEFS.historico}
                                    value={colFilters.unmatched_tiny.historico}
                                    onChange={(v) => updateColFilter("unmatched_tiny", "historico", v)}
                                  />
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredUnmatchedTiny.map((c) => (
                                <TableRow key={`${c.empresa}-${c.id}`} className="align-top">
                                  <TableCell>
                                    <Badge variant="outline">{c.empresa_nome}</Badge>
                                  </TableCell>
                                  <TableCell className="tabular-nums">{formatDateBR(c.data_vencimento)}</TableCell>
                                  <TableCell>
                                    <SupplierCell nome={c.fornecedor_nome} cnpj={c.fornecedor_cnpj} />
                                  </TableCell>
                                  <TableCell>
                                    <div className="font-medium">{c.numero_documento}</div>
                                    <code>#{c.id}</code>
                                  </TableCell>
                                  <TableCell className="text-right font-semibold tabular-nums">{money(c.valor)}</TableCell>
                                  <TableCell>
                                    <p className="max-w-64 truncate text-xs text-muted-foreground" title={c.historico}>
                                      {c.historico || "—"}
                                    </p>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          <div className="table-footer">
                            <span>
                              Mostrando {filteredUnmatchedTiny.length} de {data.unmatched_tiny?.length ?? 0} conta(s)
                            </span>
                            <span>Total: {money(filteredUnmatchedTiny.reduce((acc, c) => acc + c.valor, 0))}</span>
                          </div>
                        </>
                      ))}

                    {activeTab === "ja_baixadas" &&
                      (filteredJaBaixadas.length === 0 ? (
                        interDown ? (
                          interDownEmpty
                        ) : hasSearch && (data.ja_baixadas?.length ?? 0) > 0 ? (
                          searchEmpty
                        ) : (
                          <Empty>Nenhum débito do extrato corresponde a conta já baixada no Tiny no período.</Empty>
                        )
                      ) : (
                        <>
                          <p className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                            Débitos do Banco Inter cuja conta correspondente já está paga no Tiny. Só para conferência:
                            não há nada a baixar.
                          </p>
                          <Table className="min-w-[1040px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Empresa"
                                    def={JA_BAIXADAS_DEFS.empresa}
                                    value={colFilters.ja_baixadas.empresa}
                                    onChange={(v) => updateColFilter("ja_baixadas", "empresa", v)}
                                    uniqueValues={obterValoresUnicos(data.ja_baixadas ?? [], (p) => p.empresa_nome || p.empresa)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Data pgto."
                                    def={JA_BAIXADAS_DEFS.data_baixa}
                                    value={colFilters.ja_baixadas.data_baixa}
                                    onChange={(v) => updateColFilter("ja_baixadas", "data_baixa", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Favorecido (Inter)"
                                    def={JA_BAIXADAS_DEFS.fornecedor}
                                    value={colFilters.ja_baixadas.fornecedor}
                                    onChange={(v) => updateColFilter("ja_baixadas", "fornecedor", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Conta no Tiny"
                                    def={JA_BAIXADAS_DEFS.conta}
                                    value={colFilters.ja_baixadas.conta}
                                    onChange={(v) => updateColFilter("ja_baixadas", "conta", v)}
                                  />
                                </TableHead>
                                <TableHead>Vencimento</TableHead>
                                <TableHead className="text-right">
                                  <ColumnFilterHeader
                                    title="Pago / Valor Tiny"
                                    align="right"
                                    def={JA_BAIXADAS_DEFS.valor}
                                    value={colFilters.ja_baixadas.valor}
                                    onChange={(v) => updateColFilter("ja_baixadas", "valor", v)}
                                  />
                                </TableHead>
                                <TableHead>Critério</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredJaBaixadas.map((p) => {
                                const method = MATCH_METHOD_META[p.metodo_match];
                                const diverge = Math.abs(p.valor_pago - p.valor_tiny) > 0.05;
                                return (
                                  <TableRow key={`${p.empresa}-${p.inter_transacao_id}-${p.conta_pagar_id}`} className="align-top">
                                    <TableCell>
                                      <Badge variant="outline">{p.empresa_nome}</Badge>
                                    </TableCell>
                                    <TableCell className="tabular-nums">{formatDateBR(p.data_pagamento)}</TableCell>
                                    <TableCell>
                                      <SupplierCell nome={p.nome_favorecido || "Não informado"} cnpj={p.cpf_cnpj_favorecido} />
                                    </TableCell>
                                    <TableCell>
                                      <div className="min-w-40 max-w-64 whitespace-normal">
                                        <div className="font-medium text-foreground">
                                          Doc. {p.numero_documento || "—"} <code>#{p.conta_pagar_id}</code>
                                        </div>
                                        <div className="text-[11px] text-muted-foreground">{p.fornecedor_nome}</div>
                                      </div>
                                    </TableCell>
                                    <TableCell className="tabular-nums">{formatDateBR(p.data_vencimento)}</TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      <div className="font-semibold">{money(p.valor_pago)}</div>
                                      <div
                                        className={cn(
                                          "text-[11px]",
                                          diverge ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                                        )}
                                      >
                                        Tiny: {money(p.valor_tiny)}
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <div className="max-w-60 space-y-1 whitespace-normal">
                                        <Badge variant="secondary">
                                          {method?.label ?? p.metodo_match} · {formatConfidence(p.confianca)}
                                        </Badge>
                                        <p className="line-clamp-2 text-[11px] text-muted-foreground" title={p.motivo}>
                                          {p.motivo}
                                        </p>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                          <div className="table-footer">
                            <span>
                              Mostrando {filteredJaBaixadas.length} de {data.ja_baixadas?.length ?? 0} débito(s)
                            </span>
                            <span>Total: {money(filteredJaBaixadas.reduce((acc, p) => acc + p.valor_pago, 0))}</span>
                          </div>
                        </>
                      ))}

                    {activeTab === "transferencias" &&
                      (filteredTransferencias.length === 0 ? (
                        interDown ? (
                          interDownEmpty
                        ) : hasSearch && (data.transferencias_internas?.length ?? 0) > 0 ? (
                          searchEmpty
                        ) : (
                          <Empty>Nenhuma transferência entre empresas do grupo no período.</Empty>
                        )
                      ) : (
                        <>
                          <p className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                            Débitos para outra empresa do grupo (mesma raiz de CNPJ), conciliados com o Tiny. As que casaram
                            com uma conta em aberto podem ser baixadas aqui; as sem conta precisam ser lançadas no Tiny antes.
                          </p>
                          <Table className="min-w-[1100px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-10">
                                  <span className="sr-only">Selecionar</span>
                                </TableHead>
                                <TableHead>
                                  <div className="flex items-center gap-2">
                                    <ColumnFilterHeader
                                      title="Origem"
                                      def={TRANSFERENCIAS_DEFS.empresa_origem}
                                      value={colFilters.transferencias.empresa_origem}
                                      onChange={(v) => updateColFilter("transferencias", "empresa_origem", v)}
                                      uniqueValues={obterValoresUnicos(data.transferencias_internas ?? [], (t) => t.empresa_nome || t.empresa)}
                                    />
                                    <span className="text-muted-foreground" aria-hidden="true">→</span>
                                    <ColumnFilterHeader
                                      title="Destino"
                                      def={TRANSFERENCIAS_DEFS.empresa_destino}
                                      value={colFilters.transferencias.empresa_destino}
                                      onChange={(v) => updateColFilter("transferencias", "empresa_destino", v)}
                                      uniqueValues={obterValoresUnicos(data.transferencias_internas ?? [], (t) => t.empresa_destino_nome)}
                                    />
                                  </div>
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Data"
                                    def={TRANSFERENCIAS_DEFS.data}
                                    value={colFilters.transferencias.data}
                                    onChange={(v) => updateColFilter("transferencias", "data", v)}
                                  />
                                </TableHead>
                                <TableHead className="text-right">
                                  <ColumnFilterHeader
                                    title="Valor"
                                    align="right"
                                    def={TRANSFERENCIAS_DEFS.valor}
                                    value={colFilters.transferencias.valor}
                                    onChange={(v) => updateColFilter("transferencias", "valor", v)}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Situação"
                                    def={TRANSFERENCIAS_DEFS.situacao}
                                    value={colFilters.transferencias.situacao}
                                    onChange={(v) => updateColFilter("transferencias", "situacao", v)}
                                    uniqueValues={obterValoresUnicos(data.transferencias_internas ?? [], (t) => (t.situacao in TRANSFER_SITUACAO_META ? TRANSFER_SITUACAO_META[t.situacao].label : t.situacao))}
                                  />
                                </TableHead>
                                <TableHead>
                                  <ColumnFilterHeader
                                    title="Descrição"
                                    def={TRANSFERENCIAS_DEFS.descricao}
                                    value={colFilters.transferencias.descricao}
                                    onChange={(v) => updateColFilter("transferencias", "descricao", v)}
                                  />
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredTransferencias.map((t) => {
                                // Backend anterior não manda situação/conciliação: trata como "sem conta".
                                const conta = t.conciliacao ?? t.conta_ja_baixada ?? null;
                                const apta = t.situacao === "apta_baixa" && !!t.conciliacao;
                                const isSelected = apta && selectedIds.has(t.conciliacao!.conta_pagar_id);
                                const situacao = TRANSFER_SITUACAO_META[t.situacao] ?? TRANSFER_SITUACAO_META.sem_conta;
                                return (
                                <TableRow
                                  key={`${t.empresa}-${t.transacao_id}`}
                                  data-state={isSelected ? "selected" : undefined}
                                  onClick={apta ? () => toggleSelectOne(t.conciliacao!.conta_pagar_id) : undefined}
                                  className={cn("align-top", apta && "cursor-pointer")}
                                >
                                  <TableCell>
                                    {apta && (
                                      <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={() => toggleSelectOne(t.conciliacao!.conta_pagar_id)}
                                        onClick={(e) => e.stopPropagation()}
                                        aria-label={`Selecionar transferência para ${t.empresa_destino_nome} de ${money(t.valor_pago)}`}
                                      />
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex min-w-56 flex-wrap items-center gap-1.5">
                                      <Badge variant="outline">{t.empresa_nome}</Badge>
                                      <ArrowRight size={12} className="shrink-0 text-muted-foreground" aria-label="para" />
                                      <span className="font-medium text-foreground">{t.empresa_destino_nome}</span>
                                    </div>
                                    {t.cpf_cnpj_favorecido && (
                                      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                                        {formatCnpjMask(t.cpf_cnpj_favorecido)}
                                      </div>
                                    )}
                                  </TableCell>
                                  <TableCell className="tabular-nums">{formatDateBR(t.data_pagamento)}</TableCell>
                                  <TableCell className="text-right font-semibold tabular-nums">{money(t.valor_pago)}</TableCell>
                                  <TableCell>
                                    <div className="min-w-48 max-w-64 space-y-1 whitespace-normal">
                                      <Badge variant={situacao.tone}>{situacao.label}</Badge>
                                      {conta ? (
                                        <>
                                          <div className="text-xs font-medium text-foreground">
                                            Doc. {conta.numero_documento || "—"} <code>#{conta.conta_pagar_id}</code>
                                          </div>
                                          <div className="text-[11px] text-muted-foreground">
                                            Venc. {formatDateBR(conta.data_vencimento)} · Tiny {money(conta.valor_tiny)} ·{" "}
                                            {MATCH_METHOD_META[conta.metodo_match]?.label ?? conta.metodo_match}
                                          </div>
                                        </>
                                      ) : (
                                        <div className="text-[11px] text-muted-foreground">
                                          Lance a conta no Tiny para poder baixar.
                                        </div>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <p className="line-clamp-2 max-w-96 whitespace-normal text-xs" title={t.descricao || t.titulo}>
                                      {t.descricao || t.titulo || "—"}
                                    </p>
                                    <span className="text-[11px] text-muted-foreground">{t.tipo_transacao}</span>
                                  </TableCell>
                                </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                          <div className="table-footer">
                            <span>
                              Mostrando {filteredTransferencias.length} de {data.transferencias_internas?.length ?? 0}{" "}
                              transferência(s)
                            </span>
                            <span>Total: {money(filteredTransferencias.reduce((acc, t) => acc + t.valor_pago, 0))}</span>
                          </div>
                        </>
                      ))}
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}

      {/* Confirmação de baixa */}
      <AlertDialog
        open={isModalOpen}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-semibold">
              {baixaResult
                ? "Resultado da baixa no Tiny ERP"
                : baixaRunning
                  ? "Baixando contas no Tiny ERP"
                  : baixaJob
                    ? "Não foi possível acompanhar a baixa"
                    : "Confirmar baixa no Tiny ERP"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {baixaResult
                ? `${baixaResult.total_sucessos} de ${baixaResult.total_solicitados} conta(s) baixada(s) com sucesso.`
                : baixaRunning
                  ? "A baixa está sendo executada no servidor, uma conta por vez."
                  : baixaJob
                    ? "A baixa pode ter sido concluída total ou parcialmente. Confira o Histórico antes de tentar de novo."
                    : baixaScope === "transferencias"
                      ? "Revise as transferências entre empresas e as contas do Tiny conciliadas com elas antes de registrar a liquidação no ERP."
                      : "Revise as contas antes de registrar a liquidação no ERP."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {baixaJob && !baixaResult && (
            <div className="space-y-3">
              {(() => {
                const progress = describeJobProgress(baixaJob);
                return (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <output className="flex min-w-0 items-center gap-2 font-medium text-foreground" aria-live="polite">
                        {baixaRunning && (
                          <RefreshCw size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
                        )}
                        <span className="truncate">{progress.label}</span>
                      </output>
                      {baixaRunning && (
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatElapsed(now - baixaStartedAt)}
                        </span>
                      )}
                    </div>
                    <ProgressBar percent={progress.percent} label="Andamento da baixa" />
                  </div>
                );
              })()}
              {baixaRunning && (
                <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                  <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  Pode fechar esta janela: a baixa continua e ficará registrada no Histórico.
                </p>
              )}
              {baixaError && (
                <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {baixaError}
                </div>
              )}
            </div>
          )}

          {!baixaResult && !baixaJob && (
            <>
              <dl className="grid grid-cols-3 gap-2 text-xs">
                {[
                  { label: "Contas", value: String(selectedMatches.length) },
                  { label: "Valor total", value: money(totalSelectedValor) },
                  { label: "Filiais", value: String(selectedCompanies) },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-border bg-muted/40 p-2.5">
                    <dt className="text-muted-foreground">{s.label}</dt>
                    <dd className="mt-0.5 break-words font-mono text-xs font-semibold tabular-nums text-foreground sm:text-sm">{s.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                <p className="leading-relaxed text-muted-foreground">
                  As contas serão marcadas como <strong className="text-foreground">pagas</strong> no Tiny ERP com a data
                  e o valor liquidados no Banco Inter (juros, multa e desconto inclusos). Esta tela não desfaz a baixa.
                </p>
              </div>

              <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
                {selectedMatches.map((m) => (
                  <li key={m.id} className="flex items-start justify-between gap-3 p-2.5">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">{m.fornecedor_nome}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {m.empresa_nome} · Doc. {m.numero_documento} · Pgto. {formatDateBR(m.data_pagamento)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold tabular-nums text-foreground">{money(m.valor_pago)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {MATCH_METHOD_META[m.metodo_match]?.label ?? m.metodo_match}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {baixaError && (
                <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {baixaError}
                </div>
              )}
            </>
          )}

          {baixaResult && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
              {baixaResult.resultados.map((r) => (
                <li key={`${r.empresa}-${r.conta_pagar_id}`} className="flex items-start justify-between gap-3 p-2.5">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">Conta #{r.conta_pagar_id}</div>
                    <div className="break-words text-[11px] text-muted-foreground">
                      {r.empresa} · {r.mensagem}
                    </div>
                    {typeof r.valor_pago === "number" && (
                      <div className="text-[11px] tabular-nums text-muted-foreground">
                        {r.status === "sucesso" ? "Baixado" : "Valor"}: {money(r.valor_pago)}
                        {r.data_pagamento ? ` em ${formatDateBR(r.data_pagamento)}` : ""}
                        {r.juros ? ` · juros ${money(r.juros)}` : ""}
                        {r.multa ? ` · multa ${money(r.multa)}` : ""}
                        {r.desconto ? ` · desconto ${money(r.desconto)}` : ""}
                      </div>
                    )}
                  </div>
                  <Badge variant={r.status === "sucesso" ? "success" : "danger"} className="shrink-0">
                    {r.status === "sucesso" ? "Baixada" : "Falhou"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          <AlertDialogFooter>
            {baixaJob && !baixaResult && (
              <Button
                variant="outline"
                onClick={() => {
                  closeModal();
                  selectView("historico");
                }}
                className="gap-1.5"
              >
                <History size={14} />
                Ver Histórico
              </Button>
            )}
            <AlertDialogCancel disabled={isSubmitting}>
              {baixaResult || baixaJob ? "Fechar" : "Cancelar"}
            </AlertDialogCancel>
            {!baixaResult && !baixaJob && (
              <Button
                onClick={() => void handleConfirmBaixa()}
                disabled={isSubmitting || selectedMatches.length === 0}
                className="gap-1.5"
              >
                {isSubmitting ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {isSubmitting ? "Iniciando baixa…" : `Confirmar baixa (${selectedMatches.length})`}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
