"use client";

// Peças da tela de Contas a Pagar (reconciliation-view.tsx): tipos, filtros por coluna,
// esqueletos, cartões e células reutilizadas pelas tabelas de cada aba.

import {
  ChevronRight,
  Info,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { Elapsed } from "./elapsed";
import { TinyLogo } from "@/components/ui/brand-logos";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { formatCnpjMask } from "@/lib/formatters";
import { toSaoPauloISODate } from "@/lib/date-range-utils";
import { type ColumnFilterDef } from "@/lib/column-filters";
import type {
  AlreadyPaidItem,
  InternalTransferItem,
  InternalTransferSituacao,
  PreviewJob,
  ReconciliationMatch,
  UnmatchedInterItem,
  UnmatchedTinyItem,
} from "@/lib/reconciliation-contracts";
import {
  INTER_HEALTH_META,
  MATCH_METHOD_META,
  RECONCILIATION_COMPANIES,
  describeJobProgress,
  type InterHealth,
  type StatusTone,
} from "@/lib/reconciliation-helpers";


export type TabId = "matches" | "unmatched_inter" | "unmatched_tiny" | "ja_baixadas" | "transferencias";

export type ViewMode = "conciliacao" | "historico" | "dda";

// Situação do extrato Inter na última prévia: define se os números de casamento são confiáveis.
export type InterCoverage = "completo" | "parcial" | "indisponivel";

export const DOT_CLASS: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  secondary: "bg-muted-foreground/40",
};

export const TRANSFER_SITUACAO_META: Record<InternalTransferSituacao, { label: string; tone: StatusTone }> = {
  apta_baixa: { label: "Apta para baixa", tone: "success" },
  ja_baixada: { label: "Já baixada no Tiny", tone: "secondary" },
  sem_conta: { label: "Sem conta no Tiny", tone: "warning" },
};

export const TABLE_SKELETON_ROWS = 6;

/** Junta os campos pesquisáveis de uma coluna (nome + CNPJ, documento + IDs…). */
export function juntar(...campos: Array<string | number | null | undefined>): string {
  return campos.filter((c) => c !== null && c !== undefined && c !== "").join(" ");
}

export const MATCHES_DEFS: Record<string, ColumnFilterDef<ReconciliationMatch>> = {
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

export const UNMATCHED_INTER_DEFS: Record<string, ColumnFilterDef<UnmatchedInterItem>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (i) => i.empresa_nome || i.empresa },
  data: { id: "data", label: "Data pgto.", tipo: "data", accessor: (i) => i.data_pagamento },
  favorecido: { id: "favorecido", label: "Favorecido", tipo: "texto", accessor: (i) => juntar(i.nome_favorecido, i.cpf_cnpj_favorecido) },
  descricao: { id: "descricao", label: "Descrição", tipo: "texto", accessor: (i) => juntar(i.descricao, i.titulo) },
  codigo: { id: "codigo", label: "Código de barras / ID", tipo: "texto", accessor: (i) => juntar(i.codigo_barras, i.transacao_id) },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (i) => i.valor_pago },
};

export const UNMATCHED_TINY_DEFS: Record<string, ColumnFilterDef<UnmatchedTinyItem>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (c) => c.empresa_nome || c.empresa },
  vencimento: { id: "vencimento", label: "Vencimento", tipo: "data", accessor: (c) => c.data_vencimento },
  fornecedor: { id: "fornecedor", label: "Fornecedor", tipo: "texto", accessor: (c) => juntar(c.fornecedor_nome, c.fornecedor_cnpj) },
  documento: { id: "documento", label: "Documento", tipo: "texto", accessor: (c) => juntar(c.numero_documento, String(c.id)) },
  valor: { id: "valor", label: "Valor em aberto", tipo: "numero", accessor: (c) => c.valor },
  historico: { id: "historico", label: "Histórico", tipo: "texto", accessor: (c) => `${c.numero_documento || ""} ${c.historico || ""}`.trim() },
};

export const JA_BAIXADAS_DEFS: Record<string, ColumnFilterDef<AlreadyPaidItem>> = {
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (p) => p.empresa_nome || p.empresa },
  data_baixa: { id: "data_baixa", label: "Data pgto.", tipo: "data", accessor: (p) => p.data_pagamento },
  fornecedor: { id: "fornecedor", label: "Favorecido (Inter)", tipo: "texto", accessor: (p) => juntar(p.nome_favorecido, p.fornecedor_nome, p.cpf_cnpj_favorecido) },
  conta: { id: "conta", label: "Conta no Tiny", tipo: "texto", accessor: (p) => juntar(String(p.conta_pagar_id), p.numero_documento, p.inter_transacao_id) },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (p) => p.valor_pago || p.valor_tiny },
};

export const TRANSFERENCIAS_DEFS: Record<string, ColumnFilterDef<InternalTransferItem>> = {
  empresa_origem: { id: "empresa_origem", label: "Empresa Origem", tipo: "lista", accessor: (t) => t.empresa_nome || t.empresa },
  empresa_destino: { id: "empresa_destino", label: "Empresa Destino", tipo: "lista", accessor: (t) => t.empresa_destino_nome },
  data: { id: "data", label: "Data pgto.", tipo: "data", accessor: (t) => t.data_pagamento },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (t) => t.valor_pago },
  situacao: { id: "situacao", label: "Situação", tipo: "lista", accessor: (t) => (t.situacao in TRANSFER_SITUACAO_META ? TRANSFER_SITUACAO_META[t.situacao].label : t.situacao) },
  descricao: { id: "descricao", label: "Descrição", tipo: "texto", accessor: (t) => juntar(t.nome_favorecido, t.cpf_cnpj_favorecido, t.descricao, t.titulo, t.transacao_id) },
};

export function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toSaoPauloISODate(d);
}

// Espera após a última mudança de filtro antes de criar o job da prévia (evita um job por
// tecla ao digitar datas). Curta: com o cache do backend a resposta costuma ser imediata.
export const PREVIEW_START_DELAY_MS = 300;

export function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === "TimeoutError";
}

export function describePreviewError(e: unknown): string {
  if (isTimeout(e)) {
    return "O servidor não respondeu a tempo ao acompanhar a comparação. Tente novamente.";
  }
  return e instanceof Error ? e.message : "Erro ao carregar a prévia de conciliação.";
}

export function describeBaixaError(e: unknown, fallback: string): string {
  if (isTimeout(e)) return "O servidor não respondeu a tempo. Confira o Histórico antes de tentar de novo.";
  return e instanceof Error ? e.message : fallback;
}

export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  // value null = indeterminado (ainda sem total conhecido).
  return (
    <Progress
      value={percent}
      aria-label={label}
      className={cn("w-full", percent === null && "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-pulse")}
    />
  );
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

export interface CompanyRow {
  id: string;
  nome: string;
  health: InterHealth;
  detalhe: string | null;
  tinyConfigurado: boolean | undefined;
}

export function TechnicalDetail({ text }: { text: string }) {
  return (
    <details className="group text-[11px]">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        Detalhe técnico
      </summary>
      <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-none border border-border bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

export function CompanyStatusCell({ row, inFilter }: { row: CompanyRow; inFilter: boolean }) {
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

export function CompanyStatusSkeleton() {
  return (
    <li className="space-y-2.5 bg-card p-4" aria-hidden="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-5 w-24 rounded-full" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-28" />
    </li>
  );
}

export function EmptyState({
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

export function PreviewProgressPanel({ job, startedAt }: { job: PreviewJob | null; startedAt: number | null }) {
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
        {startedAt !== null && (
          <Elapsed since={startedAt} className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" />
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

export function MetricSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <div className="metric-card skeleton h-[132px]" key={i} />
      ))}
    </div>
  );
}

export function TableSkeleton() {
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

export function MetricCard({
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
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-none border", iconClass)}>
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

export function SupplierCell({ nome, cnpj }: { nome: string; cnpj: string | null }) {
  return (
    <div className="min-w-44 max-w-72 whitespace-normal">
      <div className="font-medium text-foreground">{nome}</div>
      {cnpj && <div className="font-mono text-[11px] text-muted-foreground">{formatCnpjMask(cnpj)}</div>}
    </div>
  );
}
