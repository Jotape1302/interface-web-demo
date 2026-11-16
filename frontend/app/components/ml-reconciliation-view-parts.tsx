"use client";

// Peças da tela de Conciliação ML (ml-reconciliation-view.tsx): constantes, filtros por coluna,
// métricas, progresso de job, pílulas, paginação e histórico de execuções.

import { useState } from "react";
import { type ColumnFilterDef, type ColumnFilterValue } from "@/lib/column-filters";
import { ChevronDown, ChevronRight, History, RefreshCw, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatDateTimeBR } from "@/lib/formatters";
import { describeJobProgress } from "@/lib/reconciliation-helpers";
import { Elapsed } from "./elapsed";
import { ReportarErro } from "@/components/reportar-erro";
import type { MlArquivoTipo, MlComparativo, MlExecucaoDetalhe, MlExecucaoResumo, MlGrupo, MlJob, MlLancamento, MlPendencia, MlStatus } from "@/lib/ml-reconciliation-contracts";
import { NIVEL_LOG, casamentoMeta, comparativoNoFiltro, periodoTexto, situacaoMeta, statusExecucaoMeta, grupoNoFiltro, type MlFiltroGrupo } from "@/lib/ml-reconciliation-helpers";
import { type MlReconciliationService } from "@/lib/ml-reconciliation-service";
import { SourceError } from "./panel-state";

export type TabId = "recebimentos" | "vendas" | "lancamentos" | "pendencias" | "saldo";

export const PAGINA = 200;
export const STATUS_POLL_MS = 10_000;

export const RECEBIMENTOS_DEFS: Record<string, ColumnFilterDef<MlGrupo>> = {
  data: { id: "data", label: "Liberação", tipo: "data", accessor: (g) => g.data },
  cliente: { id: "cliente", label: "Cliente", tipo: "texto", accessor: (g) => g.nome_cliente || "" },
  venda: { id: "venda", label: "Venda", tipo: "texto", accessor: (g) => `${g.id_venda || ""} ${g.mlb || ""}`.trim() },
  valor: { id: "valor", label: "Recebido (bruto)", tipo: "numero", accessor: (g) => g.valor_total },
  conta: { id: "conta", label: "Conta Tiny", tipo: "texto", accessor: (g) => `${g.conta_id || ""} ${g.conta_historico || ""}`.trim() },
  situacao: { id: "situacao", label: "Situação", tipo: "lista", accessor: (g) => situacaoMeta(g.situacao).label },
  // Sem coluna própria: preenchido pelos atalhos acima da tabela (Aptos, Pendentes…).
  grupo: { id: "grupo", label: "Visão", tipo: "lista", accessor: (g) => grupoCategoria(g) },
};

export const ATALHOS_RECEBIMENTOS: Array<{ id: MlFiltroGrupo; label: string }> = [
  { id: "aptos", label: "Aptos para baixa" },
  { id: "canceladas", label: "Canceladas/devolvidas" },
  { id: "pendentes", label: "Pendentes" },
  { id: "ja_baixados", label: "Já baixados no Tiny" },
  { id: "conciliados", label: "Baixados pela automação" },
];

export function grupoCategoria(g: MlGrupo): string {
  return ATALHOS_RECEBIMENTOS.find((a) => grupoNoFiltro(g, a.id))?.label ?? "Outros";
}

export const PARA_CONFERIR = "Para conferir";

export const VENDAS_DEFS: Record<string, ColumnFilterDef<MlComparativo>> = {
  data: { id: "data", label: "Liberação", tipo: "data", accessor: (c) => c.data },
  pagamento: { id: "pagamento", label: "Pagamento (MP)", tipo: "texto", accessor: (c) => c.id_pagamento || "" },
  venda: { id: "venda", label: "Venda (ML)", tipo: "texto", accessor: (c) => `${c.id_pedido || ""} ${c.id_pacote || ""} ${c.mlb || ""}`.trim() },
  cliente: { id: "cliente", label: "Cliente (Tiny)", tipo: "texto", accessor: (c) => c.nome_cliente || "" },
  valor: { id: "valor", label: "Líquido liberado", tipo: "numero", accessor: (c) => c.valor_liberado },
  ligacao: { id: "ligacao", label: "Ligação", tipo: "lista", accessor: (c) => casamentoMeta(c.casou_por).label },
  // Pagamentos com observação (pedido só pelo relatório, valor diferente…): atalho "Para conferir".
  conferir: {
    id: "conferir",
    label: "Conferência",
    tipo: "lista",
    accessor: (c) => (comparativoNoFiltro(c, "conferir") ? PARA_CONFERIR : "Sem observação"),
  },
};

export const LANCAMENTOS_DEFS: Record<string, ColumnFilterDef<MlLancamento>> = {
  data: { id: "data", label: "Data", tipo: "data", accessor: (l) => l.data },
  fluxo: { id: "fluxo", label: "Fluxo MP", tipo: "lista", accessor: (l) => (l.tipo === "C" ? "Recebimento MP" : "Pagamento MP") },
  categoria: { id: "categoria", label: "Categoria", tipo: "lista", accessor: (l) => l.categoria || "" },
  historico: { id: "historico", label: "Histórico", tipo: "texto", accessor: (l) => l.historico || "" },
  contato: { id: "contato", label: "Contato", tipo: "texto", accessor: (l) => `${l.contato || ""} ${l.cnpj || ""}`.trim() },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (l) => l.valor },
};

export const PENDENCIAS_DEFS: Record<string, ColumnFilterDef<MlPendencia>> = {
  data: { id: "data", label: "Data", tipo: "data", accessor: (p) => p.data },
  fluxo: { id: "fluxo", label: "Fluxo MP", tipo: "lista", accessor: (p) => (p.valor >= 0 ? "Recebimento MP" : "Pagamento MP") },
  tipo_operacao: { id: "tipo_operacao", label: "Tipo de operação", tipo: "lista", accessor: (p) => p.tipo_operacao || "" },
  referencia: { id: "referencia", label: "Pagamento / venda", tipo: "texto", accessor: (p) => `${p.operacao_relacionada || ""} ${p.id_venda || ""}`.trim() },
  cliente: { id: "cliente", label: "Cliente", tipo: "texto", accessor: (p) => p.nome_cliente || "" },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (p) => Math.abs(p.valor) },
  motivo: { id: "motivo", label: "Motivo da pendência", tipo: "texto", accessor: (p) => p.motivo || "" },
};

export const ARQUIVOS: Array<{ tipo: MlArquivoTipo; label: string }> = [
  { tipo: "lancamentos", label: "Lançamentos de caixa (importação Tiny)" },
  { tipo: "relatorio", label: "Relatório conciliado" },
  { tipo: "vendas-recebimentos", label: "Vendas × recebimentos" },
  { tipo: "saldo-recebimentos", label: "Saldo por dia (recebimentos)" },
  { tipo: "saldo-total", label: "Saldo por dia (todas as operações)" },
];

export function erroDe(e: unknown, fallback: string): string {
  if (e instanceof DOMException && e.name === "TimeoutError") return "O servidor não respondeu a tempo. Tente novamente.";
  return e instanceof Error ? e.message : fallback;
}

/** Hora local da rotina: tirada da próxima execução (ISO com fuso), não de hora_diaria (fuso do container). */
export function horaRotina(status: MlStatus | null): number {
  const proxima = status?.proxima_execucao ? new Date(status.proxima_execucao) : null;
  if (proxima && !Number.isNaN(proxima.getTime())) return proxima.getHours();
  return status?.hora_diaria ?? 5;
}

export function hojeIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Metric({
  label,
  icon: Icon,
  iconClass,
  value,
  detail,
}: {
  label: string;
  icon: LucideIcon;
  iconClass: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span>{label}</span>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-none border", iconClass)}>
          <Icon size={18} />
        </span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail text-xs">{detail}</div>
    </div>
  );
}

export function JobProgress({ job, startedAt, texto }: { job: MlJob | null; startedAt: number; texto: string }) {
  const progress = job ? describeJobProgress(job) : { percent: null, label: "Iniciando…" };
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <output className="flex min-w-0 items-center gap-2 font-medium text-foreground" aria-live="polite">
          <RefreshCw size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span className="truncate">{progress.label}</span>
        </output>
        <Elapsed since={startedAt} className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" />
      </div>
      <Progress
        value={progress.percent}
        aria-label={texto}
        className={cn(
          "w-full",
          progress.percent === null && "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-pulse",
        )}
      />
    </div>
  );
}

export function Pilulas({
  opcoes,
  ativo,
  contagem,
  total,
  onChange,
}: {
  opcoes: string[];
  /** Opção marcada; null = "Todos". */
  ativo: string | null;
  contagem: Record<string, number>;
  total: number;
  onChange: (opcao: string | null) => void;
}) {
  const botao = (valor: string | null, rotulo: string, n: number) => (
    <button
      key={rotulo}
      type="button"
      onClick={() => onChange(valor)}
      aria-pressed={ativo === valor}
      className={cn(
        "rounded-[4px] border px-2.5 py-1 text-[11px] font-medium transition",
        ativo === valor ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/50",
      )}
    >
      {rotulo} · {n}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
      {opcoes.map((o) => botao(o, o, contagem[o] ?? 0))}
      {botao(null, "Todos", total)}
    </div>
  );
}

/** Opção única marcada num filtro de lista (para destacar o atalho correspondente). */
export function unicaOpcao(valor: ColumnFilterValue | undefined): string | null {
  return Array.isArray(valor) && valor.length === 1 ? valor[0]! : null;
}

export function MaisLinhas({ mostrando, total, onMais }: { mostrando: number; total: number; onMais: () => void }) {
  return (
    <div className="table-footer flex items-center justify-between gap-3">
      <span>
        Mostrando {Math.min(mostrando, total)} de {total}
      </span>
      {mostrando < total && (
        <Button variant="outline" size="sm" onClick={onMais}>
          Mostrar mais
        </Button>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Histórico de execuções (com o log de cada uma)
// ─────────────────────────────────────────────────────────────────────────────

export function resumoExecucao(e: MlExecucaoResumo, nomes: Map<string, string>): string {
  return Object.entries(e.empresas)
    .map(([id, r]) => {
      const nome = nomes.get(id) ?? id;
      if (r.tarifas) return `${nome}: ${r.tarifas.lancamentos} lançamento(s) de tarifa, ${r.tarifas.falhas} venda(s) com falha`;
      if (r.baixa) return `${nome}: ${r.baixa.sucessos} baixada(s), ${r.baixa.ignorados} pulada(s), ${r.baixa.falhas} falha(s)`;
      if (r.status !== "ok") return `${nome}: ${r.mensagem || "falhou"}`;
      return `${nome}: ${r.resumo?.aptos_baixa ?? 0} apto(s), ${r.resumo?.total_pendencias ?? 0} para conferir`;
    })
    .join(" · ");
}

export function HistoricoExecucoes({
  service,
  execucoes,
  erro,
  nomes,
}: {
  service: MlReconciliationService;
  execucoes: MlExecucaoResumo[] | null;
  erro: string | null;
  nomes: Map<string, string>;
}) {
  const [aberta, setAberta] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<MlExecucaoDetalhe | null>(null);
  const [detalheErro, setDetalheErro] = useState<string | null>(null);

  async function alternar(id: string) {
    if (aberta === id) {
      setAberta(null);
      return;
    }
    setAberta(id);
    setDetalhe(null);
    setDetalheErro(null);
    try {
      setDetalhe(await service.getExecucao(id));
    } catch (e) {
      setDetalheErro(erroDe(e, "Falha ao carregar o log."));
    }
  }

  return (
    <div className="panel">
      <div className="flex items-center gap-2 border-b border-border p-3 sm:px-4">
        <History size={15} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Histórico de execuções</h2>
        <span className="text-[11px] text-muted-foreground">rotina diária, execuções manuais e baixas</span>
      </div>
      {erro && (
        <div className="p-3">
          <SourceError message={erro} reportar={{ automationId: "ml-reconciliation", executionId: "historico-de-execucoes" }} />
        </div>
      )}
      {execucoes && execucoes.length === 0 && (
        <div className="px-5 py-8 text-center text-xs text-muted-foreground">Nenhuma execução registrada ainda.</div>
      )}
      {execucoes && execucoes.length > 0 && (
        <ul className="divide-y divide-border">
          {execucoes.map((e) => {
            const meta = statusExecucaoMeta(e.status);
            const expandida = aberta === e.id;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => void alternar(e.id)}
                  aria-expanded={expandida}
                  className="flex w-full items-start gap-2 px-3 py-2.5 text-left text-xs transition hover:bg-muted/40 sm:px-4"
                >
                  {expandida ? (
                    <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium tabular-nums text-foreground">{formatDateTimeBR(e.iniciada_em)}</span>
                      <Badge variant={meta.tone}>{meta.label}</Badge>
                      <Badge variant="outline">
                        {e.tipo === "baixa" ? "Baixa" : e.tipo === "tarifas" ? "Tarifas no caixa" : e.origem === "agendada" ? "Rotina diária" : "Execução manual"}
                      </Badge>
                      <span className="text-muted-foreground">liberações de {periodoTexto(e.periodo_de, e.periodo_ate)}</span>
                      {e.usuario && <span className="text-muted-foreground">· {e.usuario}</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{resumoExecucao(e, nomes)}</p>
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {e.erros_log > 0 && <span className="text-destructive">{e.erros_log} erro(s) · </span>}
                    {e.avisos_log > 0 && <span className="text-amber-700 dark:text-amber-400">{e.avisos_log} aviso(s) · </span>}
                    {e.linhas_log} linha(s)
                  </span>
                </button>
                {expandida && (
                  <div className="border-t border-border bg-muted/30 px-3 py-2 sm:px-4">
                    {detalheErro && <SourceError message={detalheErro} reportar={{ automationId: "ml-reconciliation", executionId: `execucao-${e.id}` }} />}
                    {detalhe && (e.erros_log > 0 || meta.tone === "danger") && (
                      <ReportarErro
                        className="mb-2"
                        automationId="ml-reconciliation"
                        executionId={`execucao-${e.id}`}
                        errorMessage={detalhe.log.find((l) => l.nivel === "erro")?.mensagem ?? `${meta.label}: ${resumoExecucao(e, nomes)}`}
                      />
                    )}
                    {!detalhe && !detalheErro && <p className="py-2 text-[11px] text-muted-foreground">Carregando o log…</p>}
                    {detalhe && (
                      <ol className="max-h-80 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
                        {detalhe.log.map((l, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="shrink-0 tabular-nums text-muted-foreground">{formatDateTimeBR(l.em)}</span>
                            <span className={cn("w-12 shrink-0 font-semibold", NIVEL_LOG[l.nivel].className)}>{NIVEL_LOG[l.nivel].label}</span>
                            <span className="min-w-0 break-words">
                              {l.empresa && <span className="text-muted-foreground">[{l.empresa}] </span>}
                              {l.mensagem}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
