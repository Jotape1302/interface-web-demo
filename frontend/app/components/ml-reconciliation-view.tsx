"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadCsv } from "@/lib/csv-export";
import { ColumnFilterBar, ColumnFilterHeader } from "./column-filter";
import {
  aplicaFiltros,
  carregarFiltrosSession,
  contarValores,
  filtrosAtivosCount,
  obterValoresUnicos,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from "@/lib/column-filters";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleCheckBig,
  Download,
  History,
  Info,
  ListChecks,
  Play,
  ReceiptText,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import { cn } from "@/lib/utils";
import { formatDateTimeBR, money } from "@/lib/formatters";
import { describeJobProgress, formatElapsed } from "@/lib/reconciliation-helpers";
import type {
  MlAnalise,
  MlAnaliseResumo,
  MlArquivoTipo,
  MlBaixaJob,
  MlBaixaResponse,
  MlComparativo,
  MlExecucaoDetalhe,
  MlExecucaoJob,
  MlExecucaoResumo,
  MlGrupo,
  MlLancamento,
  MlPendencia,
  MlStatus,
} from "@/lib/ml-reconciliation-contracts";
import {
  NIVEL_LOG,
  casamentoMeta,
  comparativoNoFiltro,
  conexoesFaltando,
  erroPeriodo,
  pendenciaMotivoMeta,
  periodoTexto,
  situacaoMeta,
  somaSelecionados,
  statusExecucaoMeta,
  waitForMlJob,
  formatarMensagemSincronizacaoTokens,
  grupoNoFiltro,
  type MlFiltroGrupo,
  type TokenSyncFeedback,
} from "@/lib/ml-reconciliation-helpers";
import {
  createMlReconciliationService,
  LancamentosJaExportadosError,
  type MlReconciliationService,
} from "@/lib/ml-reconciliation-service";
import { SourceError } from "./panel-state";
import { useAuth } from "@/lib/auth-context";

type TabId = "recebimentos" | "vendas" | "lancamentos" | "pendencias" | "saldo";

const PAGINA = 200;
const STATUS_POLL_MS = 10_000;

const RECEBIMENTOS_DEFS: Record<string, ColumnFilterDef<MlGrupo>> = {
  data: { id: "data", label: "Liberação", tipo: "data", accessor: (g) => g.data },
  cliente: { id: "cliente", label: "Cliente", tipo: "texto", accessor: (g) => g.nome_cliente || "" },
  venda: { id: "venda", label: "Venda", tipo: "texto", accessor: (g) => `${g.id_venda || ""} ${g.mlb || ""}`.trim() },
  valor: { id: "valor", label: "Recebido (bruto)", tipo: "numero", accessor: (g) => g.valor_total },
  conta: { id: "conta", label: "Conta Tiny", tipo: "texto", accessor: (g) => `${g.conta_id || ""} ${g.conta_historico || ""}`.trim() },
  situacao: { id: "situacao", label: "Situação", tipo: "lista", accessor: (g) => situacaoMeta(g.situacao).label },
  // Sem coluna própria: preenchido pelos atalhos acima da tabela (Aptos, Pendentes…).
  grupo: { id: "grupo", label: "Visão", tipo: "lista", accessor: (g) => grupoCategoria(g) },
};

const ATALHOS_RECEBIMENTOS: Array<{ id: MlFiltroGrupo; label: string }> = [
  { id: "aptos", label: "Aptos para baixa" },
  { id: "pendentes", label: "Pendentes" },
  { id: "ja_baixados", label: "Já baixados no Tiny" },
  { id: "conciliados", label: "Baixados pela automação" },
];

function grupoCategoria(g: MlGrupo): string {
  return ATALHOS_RECEBIMENTOS.find((a) => grupoNoFiltro(g, a.id))?.label ?? "Outros";
}

const PARA_CONFERIR = "Para conferir";

const VENDAS_DEFS: Record<string, ColumnFilterDef<MlComparativo>> = {
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

const LANCAMENTOS_DEFS: Record<string, ColumnFilterDef<MlLancamento>> = {
  data: { id: "data", label: "Data", tipo: "data", accessor: (l) => l.data },
  fluxo: { id: "fluxo", label: "Fluxo MP", tipo: "lista", accessor: (l) => (l.tipo === "C" ? "Recebimento MP" : "Pagamento MP") },
  categoria: { id: "categoria", label: "Categoria", tipo: "lista", accessor: (l) => l.categoria || "" },
  historico: { id: "historico", label: "Histórico", tipo: "texto", accessor: (l) => l.historico || "" },
  contato: { id: "contato", label: "Contato", tipo: "texto", accessor: (l) => `${l.contato || ""} ${l.cnpj || ""}`.trim() },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (l) => l.valor },
};

const PENDENCIAS_DEFS: Record<string, ColumnFilterDef<MlPendencia>> = {
  data: { id: "data", label: "Data", tipo: "data", accessor: (p) => p.data },
  fluxo: { id: "fluxo", label: "Fluxo MP", tipo: "lista", accessor: (p) => (p.valor >= 0 ? "Recebimento MP" : "Pagamento MP") },
  tipo_operacao: { id: "tipo_operacao", label: "Tipo de operação", tipo: "lista", accessor: (p) => p.tipo_operacao || "" },
  referencia: { id: "referencia", label: "Pagamento / venda", tipo: "texto", accessor: (p) => `${p.operacao_relacionada || ""} ${p.id_venda || ""}`.trim() },
  cliente: { id: "cliente", label: "Cliente", tipo: "texto", accessor: (p) => p.nome_cliente || "" },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (p) => Math.abs(p.valor) },
  motivo: { id: "motivo", label: "Motivo da pendência", tipo: "texto", accessor: (p) => p.motivo || "" },
};

const ARQUIVOS: Array<{ tipo: MlArquivoTipo; label: string }> = [
  { tipo: "lancamentos", label: "Lançamentos de caixa (importação Tiny)" },
  { tipo: "relatorio", label: "Relatório conciliado" },
  { tipo: "vendas-recebimentos", label: "Vendas × recebimentos" },
  { tipo: "saldo-recebimentos", label: "Saldo por dia (recebimentos)" },
  { tipo: "saldo-total", label: "Saldo por dia (todas as operações)" },
];

function erroDe(e: unknown, fallback: string): string {
  if (e instanceof DOMException && e.name === "TimeoutError") return "O servidor não respondeu a tempo. Tente novamente.";
  return e instanceof Error ? e.message : fallback;
}

/** Hora local da rotina: tirada da próxima execução (ISO com fuso), não de hora_diaria (fuso do container). */
function horaRotina(status: MlStatus | null): number {
  const proxima = status?.proxima_execucao ? new Date(status.proxima_execucao) : null;
  if (proxima && !Number.isNaN(proxima.getTime())) return proxima.getHours();
  return status?.hora_diaria ?? 8;
}

function hojeIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Metric({
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
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-md border", iconClass)}>
          <Icon size={18} />
        </span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail text-xs">{detail}</div>
    </div>
  );
}

function JobProgress({ job, elapsedMs, texto }: { job: MlExecucaoJob | MlBaixaJob | null; elapsedMs: number; texto: string }) {
  const progress = job ? describeJobProgress(job) : { percent: null, label: "Iniciando…" };
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <output className="flex min-w-0 items-center gap-2 font-medium text-foreground" aria-live="polite">
          <RefreshCw size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span className="truncate">{progress.label}</span>
        </output>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{formatElapsed(elapsedMs)}</span>
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

function Pilulas({
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
function unicaOpcao(valor: ColumnFilterValue | undefined): string | null {
  return Array.isArray(valor) && valor.length === 1 ? valor[0]! : null;
}

function MaisLinhas({ mostrando, total, onMais }: { mostrando: number; total: number; onMais: () => void }) {
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

function resumoExecucao(e: MlExecucaoResumo, nomes: Map<string, string>): string {
  return Object.entries(e.empresas)
    .map(([id, r]) => {
      const nome = nomes.get(id) ?? id;
      if (r.baixa) return `${nome}: ${r.baixa.sucessos} baixada(s), ${r.baixa.ignorados} pulada(s), ${r.baixa.falhas} falha(s)`;
      if (r.status !== "ok") return `${nome}: ${r.mensagem || "falhou"}`;
      return `${nome}: ${r.resumo?.aptos_baixa ?? 0} apto(s), ${r.resumo?.total_pendencias ?? 0} para conferir`;
    })
    .join(" · ");
}

function HistoricoExecucoes({
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
          <SourceError message={erro} />
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
                        {e.tipo === "baixa" ? "Baixa" : e.origem === "agendada" ? "Rotina diária" : "Execução manual"}
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
                    {detalheErro && <SourceError message={detalheErro} />}
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

// ─────────────────────────────────────────────────────────────────────────────
// Tela
// ─────────────────────────────────────────────────────────────────────────────

export default function MlReconciliationView({ apiBaseUrl }: { apiBaseUrl?: string }) {
  const service = useMemo(() => createMlReconciliationService(apiBaseUrl), [apiBaseUrl]);
  // Executar e dar baixa só com a permissão (o gateway barra do mesmo jeito).
  const { can } = useAuth();
  const canExecutar = can("conciliacao_ml:executar");
  const canBaixar = can("conciliacao_ml:baixar");

  const [status, setStatus] = useState<MlStatus | null>(null);
  const [statusErro, setStatusErro] = useState<string | null>(null);
  const [execucoes, setExecucoes] = useState<MlExecucaoResumo[] | null>(null);
  const [execucoesErro, setExecucoesErro] = useState<string | null>(null);

  // Execução manual
  const [execEmpresa, setExecEmpresa] = useState("todas");
  const [execDe, setExecDe] = useState("");
  const [execAte, setExecAte] = useState("");
  const [execJob, setExecJob] = useState<MlExecucaoJob | null>(null);
  const [executando, setExecutando] = useState(false);
  const [execErro, setExecErro] = useState<string | null>(null);

  // Análise exibida
  const [empresaId, setEmpresaId] = useState("norvia_campinas");
  const [analises, setAnalises] = useState<MlAnaliseResumo[] | null>(null);
  const [analiseId, setAnaliseId] = useState<string | null>(null);
  const [analiseCarregada, setAnalise] = useState<MlAnalise | null>(null);
  const [analiseErro, setAnaliseErro] = useState<string | null>(null);
  // A análise exibida é sempre a selecionada: enquanto a nova carrega, a anterior some.
  const analise = analiseCarregada && analiseCarregada.analise_id === analiseId ? analiseCarregada : null;
  const carregandoAnalise = Boolean(analiseId) && !analise && !analiseErro;

  const [tab, setTab] = useState<TabId>("recebimentos");
  const [colFilters, setColFilters] = useState<{
    recebimentos: ColumnFiltersState;
    vendas: ColumnFiltersState;
    lancamentos: ColumnFiltersState;
    pendencias: ColumnFiltersState;
  }>(() => ({
    // A visão (Aptos/Pendentes…) e o "Para conferir" são escolhidos a cada análise carregada.
    recebimentos: carregarFiltrosSession("ml", "recebimentos"),
    vendas: carregarFiltrosSession("ml", "vendas"),
    lancamentos: carregarFiltrosSession("ml", "lancamentos"),
    pendencias: carregarFiltrosSession("ml", "pendencias"),
  }));

  const updateColFilter = (
    tabId: "recebimentos" | "vendas" | "lancamentos" | "pendencias",
    id: string,
    val: ColumnFilterValue | undefined,
  ) => {
    setColFilters((prev) => {
      const proximoAba = { ...prev[tabId] };
      if (val === undefined) {
        delete proximoAba[id];
      } else {
        proximoAba[id] = val;
      }
      salvarFiltrosSession("ml", tabId, proximoAba);
      return { ...prev, [tabId]: proximoAba };
    });
    setLimite(PAGINA);
  };

  const clearColFilters = (tabId: "recebimentos" | "vendas" | "lancamentos" | "pendencias") => {
    setColFilters((prev) => {
      salvarFiltrosSession("ml", tabId, {});
      return { ...prev, [tabId]: {} };
    });
    setLimite(PAGINA);
  };
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [limite, setLimite] = useState(PAGINA);

  const [dialogAberto, setDialogAberto] = useState(false);
  const [baixaJob, setBaixaJob] = useState<MlBaixaJob | null>(null);
  const [baixando, setBaixando] = useState(false);
  const [baixaErro, setBaixaErro] = useState<string | null>(null);
  const [baixaResultado, setBaixaResultado] = useState<MlBaixaResponse | null>(null);

  const [downloadErro, setDownloadErro] = useState<string | null>(null);
  const [baixandoArquivo, setBaixandoArquivo] = useState<MlArquivoTipo | null>(null);
  // Controle de exportação da planilha de lançamentos (evita importar duas vezes no Tiny).
  const [avisoExportacao, setAvisoExportacao] = useState<{ mensagem: string; permitirTodos: boolean } | null>(null);

  const [decorrido, setDecorrido] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const [sincronizandoTokens, setSincronizandoTokens] = useState(false);
  const [tokenSyncFeedback, setTokenSyncFeedback] = useState<TokenSyncFeedback | null>(null);

  async function sincronizarTokens() {
    setSincronizandoTokens(true);
    setTokenSyncFeedback(null);
    try {
      const res = await service.sincronizarTokens();
      setTokenSyncFeedback(formatarMensagemSincronizacaoTokens(res));
      void carregarStatus();
    } catch (e) {
      setTokenSyncFeedback(formatarMensagemSincronizacaoTokens(e));
    } finally {
      setSincronizandoTokens(false);
      setTimeout(() => setTokenSyncFeedback(null), 6000);
    }
  }

  const nomes = useMemo(() => new Map((status?.empresas ?? []).map((e) => [e.id, e.nome])), [status]);

  const aplicarStatus = useCallback((s: MlStatus) => {
    setStatus(s);
    setStatusErro(null);
    setExecDe((atual) => atual || s.periodo_padrao[0]);
    setExecAte((atual) => atual || s.periodo_padrao[1]);
  }, []);

  const aplicarAnalises = useCallback((lista: MlAnaliseResumo[], selecionar?: string) => {
    setAnalises(lista);
    const consolidada = lista.find((a) => a.analise_id.startsWith("consolidado_"));
    setAnaliseId((atual) => selecionar ?? (atual && lista.some((a) => a.analise_id === atual) ? atual : (consolidada?.analise_id ?? lista[0]?.analise_id ?? null)));
  }, []);

  // Recargas depois de uma ação (execução, baixa) ou durante a rotina em andamento.
  const carregarStatus = useCallback(async () => {
    try {
      aplicarStatus(await service.getStatus());
    } catch (e) {
      setStatusErro(erroDe(e, "Falha ao consultar a conciliação."));
    }
  }, [service, aplicarStatus]);

  const carregarExecucoes = useCallback(async () => {
    try {
      setExecucoes((await service.getExecucoes(20)).itens);
      setExecucoesErro(null);
    } catch (e) {
      setExecucoesErro(erroDe(e, "Falha ao consultar o histórico."));
    }
  }, [service]);

  const carregarAnalises = useCallback(
    async (empresa: string, selecionar?: string) => {
      try {
        aplicarAnalises((await service.getAnalises(empresa, 30)).itens, selecionar);
      } catch (e) {
        setAnaliseErro(erroDe(e, "Falha ao consultar as análises."));
      }
    },
    [service, aplicarAnalises],
  );

  useEffect(() => {
    const controller = new AbortController();
    service
      .getStatus(controller.signal)
      .then(aplicarStatus)
      .catch((e) => !controller.signal.aborted && setStatusErro(erroDe(e, "Falha ao consultar a conciliação.")));
    service
      .getExecucoes(20, controller.signal)
      .then((r) => {
        setExecucoes(r.itens);
        setExecucoesErro(null);
      })
      .catch((e) => !controller.signal.aborted && setExecucoesErro(erroDe(e, "Falha ao consultar o histórico.")));
    return () => controller.abort();
  }, [service, aplicarStatus]);

  // A rotina diária pode estar rodando no servidor: acompanha o status enquanto estiver.
  useEffect(() => {
    if (!status?.em_execucao || executando) return;
    const id = setInterval(() => {
      void carregarStatus();
      void carregarExecucoes();
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [status?.em_execucao, executando, carregarStatus, carregarExecucoes]);

  useEffect(() => {
    const controller = new AbortController();
    service
      .getAnalises(empresaId, 30, controller.signal)
      .then((r) => aplicarAnalises(r.itens))
      .catch((e) => !controller.signal.aborted && setAnaliseErro(erroDe(e, "Falha ao consultar as análises.")));
    return () => controller.abort();
  }, [empresaId, service, aplicarAnalises]);

  useEffect(() => {
    if (!analiseId) return;
    const controller = new AbortController();
    service
      .getAnalise(analiseId, controller.signal)
      .then((a) => {
        setAnalise(a);
        setAnaliseErro(null);
        setSelecionados(new Set());
        // Como antes dos filtros por coluna: abre nos aptos (ou em tudo, se não houver) e, nas
        // vendas, nos pagamentos para conferir quando existirem. Os demais filtros da aba ficam.
        setColFilters((prev) => {
          const recebimentos = { ...prev.recebimentos };
          if (a.resumo.aptos_baixa > 0) recebimentos.grupo = ["Aptos para baixa"];
          else delete recebimentos.grupo;
          const vendas = { ...prev.vendas };
          if (a.resumo.pagamentos_com_observacao > 0) vendas.conferir = [PARA_CONFERIR];
          else delete vendas.conferir;
          salvarFiltrosSession("ml", "recebimentos", recebimentos);
          salvarFiltrosSession("ml", "vendas", vendas);
          return { ...prev, recebimentos, vendas };
        });
        setTab("recebimentos");
        setLimite(PAGINA);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setAnaliseErro(erroDe(e, "Falha ao carregar a análise."));
      });
    return () => controller.abort();
  }, [analiseId, service]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Tempo decorrido da tarefa em andamento, medido no navegador.
  useEffect(() => {
    if (!executando && !baixando) return;
    const t0 = Date.now();
    const id = setInterval(() => setDecorrido(Date.now() - t0), 1000);
    return () => clearInterval(id);
  }, [executando, baixando]);

  const periodoInvalido = execDe && execAte ? erroPeriodo(execDe, execAte, hojeIso()) : "Informe o período.";
  const ocupado = executando || Boolean(status?.em_execucao);

  async function executarAgora() {
    if (periodoInvalido || ocupado) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setExecutando(true);
    setExecErro(null);
    setExecJob(null);
    setDecorrido(0);
    try {
      const job = await service.executar(
        { empresas: execEmpresa === "todas" ? undefined : [execEmpresa], de: execDe, ate: execAte },
        controller.signal,
      );
      const final = await waitForMlJob((id, s) => service.getJob(id, s), job, {
        signal: controller.signal,
        onProgress: setExecJob,
      });
      const nova = final.resultado?.empresas[empresaId]?.analise_id;
      await Promise.all([carregarStatus(), carregarExecucoes(), carregarAnalises(empresaId, nova)]);
    } catch (e) {
      if (!controller.signal.aborted) setExecErro(erroDe(e, "Falha na conciliação."));
      void carregarExecucoes();
    } finally {
      if (abortRef.current === controller) setExecutando(false);
    }
  }

  const gruposFiltrados = useMemo(
    () => (analise ? aplicaFiltros(analise.grupos, colFilters.recebimentos, RECEBIMENTOS_DEFS) : []),
    [analise, colFilters.recebimentos],
  );
  const comparativoFiltrado = useMemo(
    () => (analise ? aplicaFiltros(analise.comparativo, colFilters.vendas, VENDAS_DEFS) : []),
    [analise, colFilters.vendas],
  );
  const lancamentosFiltrados = useMemo(
    () => (analise ? aplicaFiltros(analise.lancamentos, colFilters.lancamentos, LANCAMENTOS_DEFS) : []),
    [analise, colFilters.lancamentos],
  );
  const pendenciasFiltradas = useMemo(
    () => (analise ? aplicaFiltros(analise.pendencias, colFilters.pendencias, PENDENCIAS_DEFS) : []),
    [analise, colFilters.pendencias],
  );


  // CSV da aba ativa com os filtros aplicados (as planilhas acima continuam sendo a análise inteira).
  function exportarCsvDaAba() {
    const empresa = nomes.get(empresaId) ?? empresaId;
    if (tab === "recebimentos") {
      downloadCsv(`ml-recebimentos-${empresaId}`, ["Empresa", "Liberação", "Cliente", "Venda", "Recebido (bruto)", "Conta Tiny", "Saldo da conta", "Situação", "Mensagem"],
        gruposFiltrados.map((g) => [empresa, g.data, g.nome_cliente, g.id_venda, g.valor_total, g.conta_id, g.conta_saldo, g.situacao, g.mensagem]));
    } else if (tab === "vendas") {
      downloadCsv(`ml-vendas-x-recebimentos-${empresaId}`, ["Empresa", "Data", "Pagamento", "Pedido", "Cliente", "Valor liberado", "Casou por", "Status da venda", "Observação"],
        comparativoFiltrado.map((c) => [empresa, c.data, c.id_pagamento, c.id_pedido, c.nome_cliente, c.valor_liberado, c.casou_por, c.status_venda, c.observacao]));
    } else if (tab === "lancamentos") {
      downloadCsv(`ml-lancamentos-${empresaId}`, ["Empresa", "Data", "Categoria", "Histórico", "Tipo", "Valor", "Contato", "Documento"],
        lancamentosFiltrados.map((l) => [empresa, l.data, l.categoria, l.historico, l.tipo, l.valor, l.contato, l.numero_documento]));
    } else if (tab === "pendencias") {
      downloadCsv(`ml-conferir-${empresaId}`, ["Empresa", "Data", "Operação", "Venda", "Cliente", "Valor", "Motivo"],
        pendenciasFiltradas.map((p) => [empresa, p.data, p.tipo_operacao, p.id_venda, p.nome_cliente, p.valor, p.motivo]));
    }
  }
  const aptosVisiveis = gruposFiltrados.filter((g) => g.apto_baixa);
  const todosVisiveisMarcados = aptosVisiveis.length > 0 && aptosVisiveis.every((g) => selecionados.has(g.id));
  const algunsVisiveisMarcados = aptosVisiveis.some((g) => selecionados.has(g.id));
  const gruposSelecionados = analise ? analise.grupos.filter((g) => selecionados.has(g.id) && g.apto_baixa) : [];
  const empresaStatus = status?.empresas.find((e) => e.id === empresaId) ?? null;

  function trocarEmpresa(id: string) {
    if (id === empresaId) return;
    setEmpresaId(id);
    setAnalises(null);
    setAnaliseId(null);
    setAnaliseErro(null);
  }

  function alternar(id: string) {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }

  function alternarTodos() {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      for (const g of aptosVisiveis) {
        if (todosVisiveisMarcados) novo.delete(g.id);
        else novo.add(g.id);
      }
      return novo;
    });
  }

  function abrirBaixa() {
    setBaixaJob(null);
    setBaixaErro(null);
    setBaixaResultado(null);
    setDialogAberto(true);
  }

  async function confirmarBaixa() {
    if (!analise || gruposSelecionados.length === 0) return;
    setBaixando(true);
    setBaixaErro(null);
    setDecorrido(0);
    try {
      const job = await service.startBaixa(analise.analise_id, gruposSelecionados.map((g) => g.id));
      const final = await waitForMlJob((id, s) => service.getJob(id, s), job, { onProgress: setBaixaJob });
      setBaixaResultado(final.resultado);
      setSelecionados(new Set());
    } catch (e) {
      setBaixaErro(erroDe(e, "Falha na baixa. Confira no Tiny antes de tentar de novo."));
    } finally {
      setBaixando(false);
      // A situação de cada recebimento mudou no servidor (inclusive em falha parcial).
      try {
        setAnalise(await service.getAnalise(analise.analise_id));
      } catch {
        // o resultado da baixa continua no diálogo
      }
      void carregarExecucoes();
    }
  }

  async function baixarArquivo(tipo: MlArquivoTipo, incluirExportados = false) {
    if (!analise) return;
    setDownloadErro(null);
    setAvisoExportacao(null);
    setBaixandoArquivo(tipo);
    try {
      const exportacao = await service.downloadArquivo(analise.analise_id, tipo, { incluirExportados });
      if (exportacao && exportacao.jaExportados > 0 && !incluirExportados) {
        setAvisoExportacao({
          mensagem: `${exportacao.jaExportados} de ${exportacao.total} lançamento(s) já tinham saído numa planilha anterior e ficaram fora desta (${exportacao.naPlanilha} na planilha).`,
          permitirTodos: true,
        });
      }
    } catch (e) {
      if (e instanceof LancamentosJaExportadosError) {
        setAvisoExportacao({ mensagem: e.message, permitirTodos: true });
      } else {
        setDownloadErro(erroDe(e, "Falha ao gerar a planilha."));
      }
    } finally {
      setBaixandoArquivo(null);
    }
  }

  const tabs: Array<{ id: TabId; label: string; icon: LucideIcon; count: number }> = analise
    ? [
        { id: "recebimentos", label: "Recebimentos", icon: CircleCheckBig, count: analise.grupos.length },
        { id: "vendas", label: "Vendas × Recebimentos", icon: ArrowLeftRight, count: analise.comparativo.length },
        { id: "lancamentos", label: "Lançamentos de caixa", icon: ReceiptText, count: analise.lancamentos.length },
        { id: "pendencias", label: "Conferir", icon: AlertTriangle, count: analise.pendencias.length },
        { id: "saldo", label: "Saldo por dia", icon: CalendarDays, count: analise.saldo_total_dia.length },
      ]
    : [];

  const saldoPorDia = useMemo(() => {
    if (!analise) return [];
    const receb = new Map(analise.saldo_recebimentos_dia.map((d) => [d.data, d.valor]));
    return analise.saldo_total_dia.map((d) => ({ data: d.data, recebimentos: receb.get(d.data) ?? 0, total: d.valor }));
  }, [analise]);

  return (
    <div className="space-y-6">
      {/* Rotina diária */}
      <div className="panel space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CalendarClock size={15} className="text-primary" />
              Rotina diária
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              {/* Hora pela próxima execução (fuso do navegador): hora_diaria vem no fuso do container (UTC). */}
              Todo dia às {String(horaRotina(status)).padStart(2, "0")}h, conferindo de novo os últimos 60 dias de liberações (o
              máximo do Mercado Pago): vendas pela API do Mercado Livre, recebimentos pelo relatório de liberações do Mercado Pago
              (cruzados pelo ID do pagamento), clientes e contas a receber pelo Tiny. Recebimentos baixados aqui ou direto no Tiny
              saem das pendências. Nada é baixado sozinho: a baixa é confirmada aqui.
            </p>
          </div>
          {status && (
            <div className="flex shrink-0 flex-col items-start gap-2.5 sm:items-end">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <span className="text-muted-foreground">Última execução</span>
                <span className="text-muted-foreground">Próxima execução</span>
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  {status.ultima_execucao ? (
                    <>
                      {formatDateTimeBR(status.ultima_execucao.concluida_em)}
                      <Badge variant={statusExecucaoMeta(status.ultima_execucao.status).tone}>
                        {statusExecucaoMeta(status.ultima_execucao.status).label}
                      </Badge>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                <span className="font-medium text-foreground">{formatDateTimeBR(status.proxima_execucao)}</span>
              </div>
              {canExecutar && status.renovacao_tokens_no_painel === false && (
                <span
                  className="max-w-56 text-right text-[11px] text-muted-foreground"
                  title="scripts/sync_ml_tokens.py no cron do servidor"
                >
                  Tokens do Mercado Livre renovados automaticamente pelo servidor a cada 2 h.
                </span>
              )}
              {canExecutar && status.renovacao_tokens_no_painel !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={sincronizarTokens}
                  disabled={sincronizandoTokens}
                  className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                  title="Consulta o TMS/OAuth e atualiza os tokens de acesso do Mercado Livre"
                >
                  <RefreshCw size={12} className={cn(sincronizandoTokens && "animate-spin text-primary")} />
                  {sincronizandoTokens ? "Sincronizando..." : "Sincronizar Tokens ML"}
                </Button>
              )}
            </div>
          )}
        </div>

        {tokenSyncFeedback && (
          <div
            className={cn(
              "flex items-center gap-2 rounded-md p-2.5 text-xs",
              tokenSyncFeedback.tipo === "sucesso"
                ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            )}
          >
            <CheckCircle2 size={14} className={tokenSyncFeedback.tipo === "sucesso" ? "text-emerald-600" : "text-amber-600"} />
            <span>{tokenSyncFeedback.msg}</span>
          </div>
        )}

        {statusErro && <SourceError message={statusErro} />}
        {status?.erro_gravacao && (
          <SourceError message={`A rotina não consegue gravar o resultado no servidor (permissão em data/): ${status.erro_gravacao}`} />
        )}

        {status && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {status.empresas.map((e) => {
              const faltando = conexoesFaltando(e);
              const ultima = e.ultima_analise;
              // A conciliação segue só pelo Mercado Pago quando o token do ML é recusado: sem este
              // destaque a falha ficava só no log e o selo "Mercado Livre" seguia verde.
              const falhaVendasMl = (ultima?.avisos ?? []).find((a) => a.startsWith("Vendas do Mercado Livre não lidas")) ?? null;
              return (
                <div key={e.id} className="rounded-lg border border-border p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{e.nome}</span>
                    <div className="flex flex-wrap gap-1">
                      {(["mercado_pago", "mercado_livre", "tiny"] as const).map((c) => (
                        <Badge
                          key={c}
                          variant={c === "mercado_livre" && falhaVendasMl ? "danger" : e.conexoes[c] ? "success" : "warning"}
                          title={c === "mercado_livre" && falhaVendasMl ? falhaVendasMl : undefined}
                        >
                          {c === "mercado_pago" ? "Mercado Pago" : c === "mercado_livre" ? "Mercado Livre" : "Tiny"}
                          {c === "mercado_livre" && falhaVendasMl ? " recusado" : e.conexoes[c] ? "" : " sem token"}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {ultima
                      ? `Última análise: liberações de ${periodoTexto(ultima.periodo_de, ultima.periodo_ate)} · ${ultima.resumo.aptos_baixa} apto(s) para baixa (${money(ultima.resumo.valor_aptos_baixa)}) · ${ultima.resumo.total_pendencias} para conferir`
                      : "Nenhuma análise ainda."}
                  </p>
                  {falhaVendasMl && (
                    <p className="mt-1.5 border-l-2 border-destructive bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                      A última análise não leu as vendas do Mercado Livre (token recusado) e cruzou só pelo relatório do
                      Mercado Pago. Depois que o token for renovado pelo cron do servidor, rode de novo este período.
                    </p>
                  )}
                  {faltando.length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                      Sem token: {faltando.join(", ")}. A execução {faltando.includes("Mercado Pago") && faltando.includes("Mercado Livre") ? "desta empresa falha" : "segue com o que houver"}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 lg:flex-row lg:items-end">
          <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              Empresa
              <select
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                value={execEmpresa}
                onChange={(e) => setExecEmpresa(e.target.value)}
                disabled={ocupado}
              >
                <option value="todas">Todas</option>
                {status?.empresas.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nome}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="ml-exec-de" className="space-y-1 text-[11px] font-medium text-muted-foreground">
              Liberações de
              <Input id="ml-exec-de" type="date" value={execDe} max={hojeIso()} onChange={(e) => setExecDe(e.target.value)} disabled={ocupado} className="h-8 text-xs" />
            </label>
            <label htmlFor="ml-exec-ate" className="space-y-1 text-[11px] font-medium text-muted-foreground">
              até
              <Input id="ml-exec-ate" type="date" value={execAte} max={hojeIso()} onChange={(e) => setExecAte(e.target.value)} disabled={ocupado} className="h-8 text-xs" />
            </label>
          </div>
          {canExecutar && (
            <Button variant="cta" onClick={() => void executarAgora()} disabled={Boolean(periodoInvalido) || ocupado} className="gap-1.5">
              {ocupado ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
              {ocupado ? "Conciliando…" : "Executar agora"}
            </Button>
          )}
        </div>
        {periodoInvalido && execDe && execAte && <p className="text-[11px] text-destructive">{periodoInvalido}</p>}

        {executando && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <JobProgress job={execJob} elapsedMs={decorrido} texto="Andamento da conciliação" />
            <p className="mt-2 text-[11px] text-muted-foreground">
              O Mercado Pago gera o relatório de liberações em alguns minutos, e o Tiny limita a velocidade das consultas: a execução
              pode levar de 5 a 20 minutos. Pode sair da tela — o resultado fica no histórico.
            </p>
          </div>
        )}
        {!executando && status?.em_execucao && (
          <p className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-foreground">
            <RefreshCw size={13} className="animate-spin text-primary" />
            {status.em_execucao.origem === "agendada" ? "Rotina diária em andamento" : "Execução em andamento"}
            {status.progresso ? `: ${status.progresso.empresa ? `${status.progresso.empresa} · ` : ""}${status.progresso.etapa}` : "…"}
          </p>
        )}
        {execErro && (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {execErro}
          </div>
        )}
      </div>

      {/* Seleção da análise */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" aria-label="Empresa" className="flex items-center gap-1">
          {(status?.empresas ?? []).map((e) => (
            <button
              key={e.id}
              type="button"
              role="tab"
              aria-selected={empresaId === e.id}
              onClick={() => trocarEmpresa(e.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition",
                empresaId === e.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {e.nome}
            </button>
          ))}
        </div>
        {analises && analises.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Análise
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              value={analiseId ?? ""}
              onChange={(e) => {
                setAnaliseErro(null);
                setAnaliseId(e.target.value);
              }}
              disabled={baixando}
            >
              {analises.map((a) => {
                const isConsolidado = a.analise_id.startsWith("consolidado_");
                const label = isConsolidado
                  ? `Pendências (últimos 60 dias) · ${formatDateTimeBR(a.criada_em)}`
                  : `${periodoTexto(a.periodo_de, a.periodo_ate)} · ${a.origem === "agendada" ? "rotina" : "manual"} · ${formatDateTimeBR(a.criada_em)}`;
                return (
                  <option key={a.analise_id} value={a.analise_id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>
        )}
      </div>

      {analiseErro && <SourceError message={analiseErro} />}
      {analises && analises.length === 0 && (
        <div className="panel px-5 py-10 text-center text-xs text-muted-foreground">
          Nenhuma análise de {empresaStatus?.nome ?? "esta empresa"} ainda. A rotina diária gera uma por dia; use “Executar agora” para
          conciliar um período.
        </div>
      )}
      {carregandoAnalise && !analise && (
        <div className="panel px-5 py-10 text-center text-xs text-muted-foreground">Carregando a análise…</div>
      )}

      {/* Resultado */}
      {analise && (
        <>
          <div className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{analise.empresa_nome}</span> ·{" "}
            {analise.analise_id.startsWith("consolidado_")
              ? "pendências dos últimos 60 dias"
              : `liberações de ${periodoTexto(analise.periodo_de, analise.periodo_ate)}`}{" "}
            · {analise.fontes.liberacoes ?? 0} linha(s) do Mercado Pago, {analise.fontes.pedidos_ml ?? 0} venda(s) do Mercado Livre,{" "}
            {analise.fontes.pedidos_tiny ?? 0} pedido(s) do Tiny · {analise.resumo.total_movimentos} movimentos
          </div>

          {analise.avisos.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              {analise.avisos.map((a) => (
                <p key={a} className="flex gap-2">
                  <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {a}
                </p>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <Metric
              label="Recebimentos MP"
              icon={ArrowDownLeft}
              iconClass="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              value={money(analise.resumo.valor_recebimentos_mp ?? analise.resumo.valor_recebimentos)}
              detail={`${analise.resumo.total_recebimentos_mp ?? analise.resumo.total_movimentos} entradas brutas`}
            />
            <Metric
              label="Pagamentos MP"
              icon={ArrowUpRight}
              iconClass="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
              value={money(analise.resumo.valor_pagamentos_mp ?? analise.resumo.valor_debitos)}
              detail={`${analise.resumo.total_pagamentos_mp ?? 0} tarifas, fretes e débitos`}
            />
            <Metric
              label="Aptos para baixa"
              icon={CircleCheckBig}
              iconClass="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400"
              value={String(analise.resumo.aptos_baixa)}
              detail={`${money(analise.resumo.valor_aptos_baixa)} em contas abertas`}
            />
            <Metric
              label="Lançamentos caixa"
              icon={ReceiptText}
              iconClass="border-primary/30 bg-primary/10 text-primary"
              value={String(analise.resumo.total_lancamentos)}
              detail={`${money(analise.resumo.valor_creditos)} ent. · ${money(analise.resumo.valor_debitos)} saí.`}
            />
            <Metric
              label="Para conferir"
              icon={AlertTriangle}
              iconClass="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              value={String(analise.resumo.total_pendencias)}
              detail={`${analise.resumo.total_anuladas} anulados entre si`}
            />
          </div>

          <div className="panel space-y-2 p-3 sm:px-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Planilhas</span>
              {ARQUIVOS.map((a) => (
                <Button
                  key={a.tipo}
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={baixandoArquivo !== null}
                  onClick={() => void baixarArquivo(a.tipo)}
                >
                  {baixandoArquivo === a.tipo ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                  {a.label}
                </Button>
              ))}
            </div>
            {downloadErro && (
              <p role="alert" className="text-xs text-destructive">
                {downloadErro}
              </p>
            )}
            {avisoExportacao && (
              <output className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--status-pending-border)] bg-[var(--status-pending-bg)] px-3 py-2 text-xs text-[var(--status-pending-fg)]">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{avisoExportacao.mensagem}</span>
                {avisoExportacao.permitirTodos && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={baixandoArquivo !== null}
                    onClick={() => void baixarArquivo("lancamentos", true)}
                  >
                    Baixar todos (só se a importação anterior falhou)
                  </Button>
                )}
              </output>
            )}
          </div>

          <div className="panel">
            <div className="flex flex-col gap-3 border-b border-border p-3 lg:flex-row lg:items-center lg:justify-between">
              <div role="tablist" aria-label="Visões da conciliação Mercado Livre" className="flex items-center gap-1 overflow-x-auto">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => {
                      setTab(t.id);
                      setLimite(PAGINA);
                    }}
                    className={cn(
                      "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                      tab === t.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <t.icon size={14} />
                    {t.label}
                    <Badge variant={tab === t.id ? "outline" : "secondary"} className="count-badge">
                      {t.count}
                    </Badge>
                  </button>
                ))}
              </div>

              {tab === "recebimentos" && canBaixar && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    <strong className="text-foreground">{gruposSelecionados.length}</strong> selecionado(s) ·{" "}
                    <strong className="text-foreground">{money(somaSelecionados(analise.grupos, selecionados))}</strong>
                  </span>
                  <Button variant="cta" onClick={abrirBaixa} disabled={gruposSelecionados.length === 0 || baixando} className="gap-1.5">
                    <CheckCircle2 size={14} />
                    Dar baixa no Tiny ({gruposSelecionados.length})
                  </Button>
                </div>
              )}
            </div>

            {tab === "recebimentos" && (
              <>
                <ColumnFilterBar
                  totalCount={analise.grupos.length}
                  filteredCount={gruposFiltrados.length}
                  activeFiltersCount={filtrosAtivosCount(colFilters.recebimentos, RECEBIMENTOS_DEFS)}
                  onClearAll={() => clearColFilters("recebimentos")}
                  onExportCsv={exportarCsvDaAba}
                  itemLabel="recebimentos"
                />
                <Pilulas
                  opcoes={ATALHOS_RECEBIMENTOS.map((a) => a.label)}
                  ativo={unicaOpcao(colFilters.recebimentos.grupo)}
                  contagem={contarValores(analise.grupos, grupoCategoria)}
                  total={analise.grupos.length}
                  onChange={(o) => updateColFilter("recebimentos", "grupo", o ? [o] : undefined)}
                />

                {gruposFiltrados.length === 0 ? (
                  <div className="px-5 py-10 text-center text-xs text-muted-foreground">
                    <ListChecks size={22} className="mx-auto mb-2.5 text-primary" />
                    Nenhum recebimento neste filtro.
                  </div>
                ) : (
                  <>
                    <Table className="min-w-[900px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">
                            <Checkbox
                              checked={todosVisiveisMarcados}
                              indeterminate={algunsVisiveisMarcados && !todosVisiveisMarcados}
                              onCheckedChange={alternarTodos}
                              disabled={aptosVisiveis.length === 0}
                              aria-label="Selecionar todos os aptos"
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Liberação"
                              def={RECEBIMENTOS_DEFS.data}
                              value={colFilters.recebimentos.data}
                              onChange={(v) => updateColFilter("recebimentos", "data", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Cliente"
                              def={RECEBIMENTOS_DEFS.cliente}
                              value={colFilters.recebimentos.cliente}
                              onChange={(v) => updateColFilter("recebimentos", "cliente", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Venda"
                              def={RECEBIMENTOS_DEFS.venda}
                              value={colFilters.recebimentos.venda}
                              onChange={(v) => updateColFilter("recebimentos", "venda", v)}
                            />
                          </TableHead>
                          <TableHead className="text-right">
                            <ColumnFilterHeader
                              title="Recebido (bruto)"
                              align="right"
                              def={RECEBIMENTOS_DEFS.valor}
                              value={colFilters.recebimentos.valor}
                              onChange={(v) => updateColFilter("recebimentos", "valor", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Conta a receber (Tiny)"
                              def={RECEBIMENTOS_DEFS.conta}
                              value={colFilters.recebimentos.conta}
                              onChange={(v) => updateColFilter("recebimentos", "conta", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Situação"
                              def={RECEBIMENTOS_DEFS.situacao}
                              value={colFilters.recebimentos.situacao}
                              onChange={(v) => updateColFilter("recebimentos", "situacao", v)}
                              uniqueValues={obterValoresUnicos(analise.grupos, RECEBIMENTOS_DEFS.situacao.accessor)}
                              counts={contarValores(analise.grupos, RECEBIMENTOS_DEFS.situacao.accessor)}
                            />
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {gruposFiltrados.slice(0, limite).map((g) => {
                          const meta = situacaoMeta(g.situacao);
                          const marcado = selecionados.has(g.id);
                          return (
                            <TableRow
                              key={g.id}
                              data-state={marcado ? "selected" : undefined}
                              onClick={g.apto_baixa ? () => alternar(g.id) : undefined}
                              className={cn("align-top", g.apto_baixa && "cursor-pointer")}
                            >
                              <TableCell>
                                {g.apto_baixa && (
                                  <Checkbox
                                    checked={marcado}
                                    onCheckedChange={() => alternar(g.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    aria-label={`Selecionar ${g.nome_cliente}, venda ${g.id_venda}`}
                                  />
                                )}
                              </TableCell>
                              <TableCell className="tabular-nums">{g.data}</TableCell>
                              <TableCell>
                                <div className="max-w-56 whitespace-normal font-medium text-foreground">{g.nome_cliente || "—"}</div>
                              </TableCell>
                              <TableCell>
                                <code>{g.id_venda || "sem venda"}</code>
                                {g.mlb && <div className="mt-0.5 text-[11px] font-mono text-muted-foreground">{g.mlb}</div>}
                                {g.quantidade_movimentos > 1 && (
                                  <div className="mt-1">
                                    <Badge variant="secondary">{g.quantidade_movimentos} liberações</Badge>
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-semibold tabular-nums">{money(g.valor_total)}</TableCell>
                              <TableCell>
                                {g.contas_vinculadas && g.contas_vinculadas.length > 1 ? (
                                  <div className="max-w-72 whitespace-normal space-y-1">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <Badge variant="outline" className="text-[10px] font-mono border-primary/40 text-primary">
                                        {g.contas_vinculadas.length} parcelas
                                      </Badge>
                                      <span className="text-[11px] text-muted-foreground">
                                        {g.conta_saldo !== null && `saldo ${money(g.conta_saldo)}`}
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-muted-foreground font-mono">
                                      {g.contas_vinculadas.map((c) => `#${c.id}${c.numero ? ` (${c.numero}ª)` : ""}`).join(", ")}
                                    </div>
                                    <p className="line-clamp-2 text-[11px] text-muted-foreground" title={g.conta_historico}>
                                      {g.conta_historico}
                                    </p>
                                  </div>
                                ) : g.conta_id ? (
                                  <div className="max-w-72 whitespace-normal">
                                    <code>#{g.conta_id}</code>
                                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                                      {g.conta_valor !== null && `valor ${money(g.conta_valor)}`}
                                      {g.conta_saldo !== null && ` · saldo ${money(g.conta_saldo)}`}
                                    </span>
                                    <p className="line-clamp-2 text-[11px] text-muted-foreground" title={g.conta_historico}>
                                      {g.conta_historico}
                                    </p>
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="max-w-60 space-y-1 whitespace-normal">
                                  <Badge variant={meta.tone}>{meta.label}</Badge>
                                  {g.mensagem && (
                                    <p className="line-clamp-2 text-[11px] text-muted-foreground" title={g.mensagem}>
                                      {g.mensagem}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <MaisLinhas mostrando={limite} total={gruposFiltrados.length} onMais={() => setLimite((l) => l + PAGINA)} />
                  </>
                )}
              </>
            )}

            {tab === "vendas" && (
              <>
                <div className="border-b border-border p-3">
                  <p className="flex gap-2 text-[11px] text-muted-foreground">
                    <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
                    Cada pagamento liberado pelo Mercado Pago, ligado à venda do Mercado Livre pelo ID do pagamento. Quando o pagamento
                    não consta em nenhum pedido, vale o pedido informado no relatório — confira esses casos.
                  </p>
                </div>
                <ColumnFilterBar
                  totalCount={analise.comparativo.length}
                  filteredCount={comparativoFiltrado.length}
                  activeFiltersCount={filtrosAtivosCount(colFilters.vendas, VENDAS_DEFS)}
                  onClearAll={() => clearColFilters("vendas")}
                  onExportCsv={exportarCsvDaAba}
                  itemLabel="pagamentos"
                />
                <Pilulas
                  opcoes={[PARA_CONFERIR]}
                  ativo={unicaOpcao(colFilters.vendas.conferir) === PARA_CONFERIR ? PARA_CONFERIR : null}
                  contagem={contarValores(analise.comparativo, VENDAS_DEFS.conferir.accessor)}
                  total={analise.comparativo.length}
                  onChange={(o) => updateColFilter("vendas", "conferir", o ? [o] : undefined)}
                />
                {comparativoFiltrado.length === 0 ? (
                  <div className="px-5 py-10 text-center text-xs text-muted-foreground">Nenhum pagamento neste filtro.</div>
                ) : (
                  <>
                    <Table className="min-w-[980px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Liberação"
                              def={VENDAS_DEFS.data}
                              value={colFilters.vendas.data}
                              onChange={(v) => updateColFilter("vendas", "data", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Pagamento (MP)"
                              def={VENDAS_DEFS.pagamento}
                              value={colFilters.vendas.pagamento}
                              onChange={(v) => updateColFilter("vendas", "pagamento", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Venda (ML)"
                              def={VENDAS_DEFS.venda}
                              value={colFilters.vendas.venda}
                              onChange={(v) => updateColFilter("vendas", "venda", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Cliente (Tiny)"
                              def={VENDAS_DEFS.cliente}
                              value={colFilters.vendas.cliente}
                              onChange={(v) => updateColFilter("vendas", "cliente", v)}
                            />
                          </TableHead>
                          <TableHead className="text-right">
                            <ColumnFilterHeader
                              title="Líquido liberado"
                              align="right"
                              def={VENDAS_DEFS.valor}
                              value={colFilters.vendas.valor}
                              onChange={(v) => updateColFilter("vendas", "valor", v)}
                            />
                          </TableHead>
                          <TableHead>
                            <ColumnFilterHeader
                              title="Ligação"
                              def={VENDAS_DEFS.ligacao}
                              value={colFilters.vendas.ligacao}
                              onChange={(v) => updateColFilter("vendas", "ligacao", v)}
                              uniqueValues={obterValoresUnicos(analise.comparativo, VENDAS_DEFS.ligacao.accessor)}
                              counts={contarValores(analise.comparativo, VENDAS_DEFS.ligacao.accessor)}
                            />
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {comparativoFiltrado.slice(0, limite).map((c) => {
                          const meta = casamentoMeta(c.casou_por);
                          return (
                            <TableRow key={`${c.id_pagamento}-${c.data}`} className="align-top">
                              <TableCell className="tabular-nums">{c.data}</TableCell>
                              <TableCell>
                                <code>{c.id_pagamento || "—"}</code>
                              </TableCell>
                              <TableCell>
                                {c.id_pedido ? (
                                  <>
                                    <code>{c.id_pedido}</code>
                                    {c.id_pacote && <div className="text-[11px] text-muted-foreground">pacote {c.id_pacote}</div>}
                                    {c.mlb && <div className="text-[11px] font-mono text-muted-foreground">{c.mlb}</div>}
                                    {c.status_venda && <div className="text-[11px] text-muted-foreground">{c.status_venda}</div>}
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="max-w-48 whitespace-normal">{c.nome_cliente || "—"}</TableCell>
                              <TableCell className="text-right tabular-nums">{money(c.valor_liberado)}</TableCell>
                              <TableCell>
                                <div className="max-w-72 space-y-1 whitespace-normal">
                                  <Badge variant={meta.tone}>{meta.label}</Badge>
                                  {c.observacao && <p className="text-[11px] text-muted-foreground">{c.observacao}</p>}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <MaisLinhas mostrando={limite} total={comparativoFiltrado.length} onMais={() => setLimite((l) => l + PAGINA)} />
                  </>
                )}
              </>
            )}

            {tab === "lancamentos" &&
              (analise.lancamentos.length === 0 ? (
                <div className="px-5 py-10 text-center text-xs text-muted-foreground">Nenhum lançamento de caixa gerado.</div>
              ) : (
                <>
                  <div className="border-b border-border p-3">
                    <p className="flex gap-2 text-[11px] text-muted-foreground">
                      <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
                      Tarifas, fretes, devoluções e estornos das liberações. Baixe a planilha “Lançamentos de caixa” e importe no Tiny
                      (conta {analise.lancamentos[0]?.conta}).
                    </p>
                  </div>
                  <ColumnFilterBar
                    totalCount={analise.lancamentos.length}
                    filteredCount={lancamentosFiltrados.length}
                    activeFiltersCount={filtrosAtivosCount(colFilters.lancamentos, LANCAMENTOS_DEFS)}
                    onClearAll={() => clearColFilters("lancamentos")}
                    onExportCsv={exportarCsvDaAba}
                    itemLabel="lançamentos"
                  />
                  {lancamentosFiltrados.length === 0 ? (
                    <div className="px-5 py-10 text-center text-xs text-muted-foreground">Nenhum lançamento neste filtro de fluxo.</div>
                  ) : (
                    <>
                      <Table className="min-w-[980px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Data"
                                def={LANCAMENTOS_DEFS.data}
                                value={colFilters.lancamentos.data}
                                onChange={(v) => updateColFilter("lancamentos", "data", v)}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Fluxo MP"
                                def={LANCAMENTOS_DEFS.fluxo}
                                value={colFilters.lancamentos.fluxo}
                                onChange={(v) => updateColFilter("lancamentos", "fluxo", v)}
                                uniqueValues={["Recebimento MP", "Pagamento MP"]}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Categoria"
                                def={LANCAMENTOS_DEFS.categoria}
                                value={colFilters.lancamentos.categoria}
                                onChange={(v) => updateColFilter("lancamentos", "categoria", v)}
                                uniqueValues={obterValoresUnicos(analise.lancamentos, LANCAMENTOS_DEFS.categoria.accessor)}
                                counts={contarValores(analise.lancamentos, LANCAMENTOS_DEFS.categoria.accessor)}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Histórico"
                                def={LANCAMENTOS_DEFS.historico}
                                value={colFilters.lancamentos.historico}
                                onChange={(v) => updateColFilter("lancamentos", "historico", v)}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Contato"
                                def={LANCAMENTOS_DEFS.contato}
                                value={colFilters.lancamentos.contato}
                                onChange={(v) => updateColFilter("lancamentos", "contato", v)}
                              />
                            </TableHead>
                            <TableHead className="text-right">
                              <ColumnFilterHeader
                                title="Valor"
                                align="right"
                                def={LANCAMENTOS_DEFS.valor}
                                value={colFilters.lancamentos.valor}
                                onChange={(v) => updateColFilter("lancamentos", "valor", v)}
                              />
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lancamentosFiltrados.slice(0, limite).map((l) => (
                            <TableRow key={l.indice} className="align-top">
                              <TableCell className="tabular-nums">{l.data}</TableCell>
                              <TableCell>
                                <Badge variant={l.tipo === "C" ? "success" : "secondary"}>
                                  {l.tipo === "C" ? "Recebimento MP" : "Pagamento MP"}
                                </Badge>
                              </TableCell>
                              <TableCell className="whitespace-normal">{l.categoria}</TableCell>
                              <TableCell>
                                <p className="line-clamp-2 max-w-96 whitespace-normal text-[11px]" title={l.historico}>
                                  {l.historico}
                                </p>
                              </TableCell>
                              <TableCell>
                                <div className="max-w-48 whitespace-normal">{l.contato || "—"}</div>
                                {l.cnpj && <code className="text-[11px]">{l.cnpj}</code>}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right font-semibold tabular-nums",
                                  l.tipo === "C" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                                )}
                              >
                                {l.tipo === "C" ? "+" : "−"}
                                {money(l.valor)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <MaisLinhas mostrando={limite} total={lancamentosFiltrados.length} onMais={() => setLimite((l) => l + PAGINA)} />
                    </>
                  )}
                </>
              ))}

            {tab === "pendencias" &&
              (analise.pendencias.length === 0 ? (
                <div className="px-5 py-10 text-center text-xs text-muted-foreground">Nenhum movimento para conferir.</div>
              ) : (
                <>
                  <div className="border-b border-border p-3">
                    <p className="flex gap-2 text-[11px] text-muted-foreground">
                      <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
                      Movimentos que não viraram lançamento: confira a pendência pelo motivo indicado e lance à mão no Tiny se necessário.
                      No relatório conciliado aparecem como VERIFICAR.
                    </p>
                  </div>
                  <ColumnFilterBar
                    totalCount={analise.pendencias.length}
                    filteredCount={pendenciasFiltradas.length}
                    activeFiltersCount={filtrosAtivosCount(colFilters.pendencias, PENDENCIAS_DEFS)}
                    onClearAll={() => clearColFilters("pendencias")}
                    onExportCsv={exportarCsvDaAba}
                    itemLabel="movimentos"
                  />
                  {pendenciasFiltradas.length === 0 ? (
                    <div className="px-5 py-10 text-center text-xs text-muted-foreground">Nenhum movimento para conferir neste filtro.</div>
                  ) : (
                    <>
                      <Table className="min-w-[920px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Data"
                                def={PENDENCIAS_DEFS.data}
                                value={colFilters.pendencias.data}
                                onChange={(v) => updateColFilter("pendencias", "data", v)}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Fluxo MP"
                                def={PENDENCIAS_DEFS.fluxo}
                                value={colFilters.pendencias.fluxo}
                                onChange={(v) => updateColFilter("pendencias", "fluxo", v)}
                                uniqueValues={["Recebimento MP", "Pagamento MP"]}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Tipo de operação"
                                def={PENDENCIAS_DEFS.tipo_operacao}
                                value={colFilters.pendencias.tipo_operacao}
                                onChange={(v) => updateColFilter("pendencias", "tipo_operacao", v)}
                                uniqueValues={obterValoresUnicos(analise.pendencias, PENDENCIAS_DEFS.tipo_operacao.accessor)}
                                counts={contarValores(analise.pendencias, PENDENCIAS_DEFS.tipo_operacao.accessor)}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Pagamento / venda"
                                def={PENDENCIAS_DEFS.referencia}
                                value={colFilters.pendencias.referencia}
                                onChange={(v) => updateColFilter("pendencias", "referencia", v)}
                              />
                            </TableHead>
                            <TableHead className="text-right">
                              <ColumnFilterHeader
                                title="Valor"
                                align="right"
                                def={PENDENCIAS_DEFS.valor}
                                value={colFilters.pendencias.valor}
                                onChange={(v) => updateColFilter("pendencias", "valor", v)}
                              />
                            </TableHead>
                            <TableHead>
                              <ColumnFilterHeader
                                title="Motivo da pendência"
                                def={PENDENCIAS_DEFS.motivo}
                                value={colFilters.pendencias.motivo}
                                onChange={(v) => updateColFilter("pendencias", "motivo", v)}
                              />
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {pendenciasFiltradas.slice(0, limite).map((p) => {
                            const meta = pendenciaMotivoMeta(p.motivo);
                            const ehRecebimento = p.valor >= 0;
                            return (
                              <TableRow key={p.indice} className="align-top">
                                <TableCell className="tabular-nums">{p.data}</TableCell>
                                <TableCell>
                                  <Badge variant={ehRecebimento ? "success" : "secondary"}>
                                    {ehRecebimento ? "Recebimento MP" : "Pagamento MP"}
                                  </Badge>
                                </TableCell>
                                <TableCell className="whitespace-normal font-medium">{p.tipo_operacao}</TableCell>
                                <TableCell>
                                  <code>{p.operacao_relacionada || "—"}</code>
                                  {p.id_venda && <div className="text-[11px] text-muted-foreground">venda {p.id_venda}</div>}
                                  {p.nome_cliente && <div className="text-[11px] text-muted-foreground">{p.nome_cliente}</div>}
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    "text-right tabular-nums font-semibold",
                                    ehRecebimento ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                                  )}
                                >
                                  {ehRecebimento ? "+" : "−"}
                                  {money(Math.abs(p.valor))}
                                </TableCell>
                                <TableCell className="max-w-80 whitespace-normal">
                                  <div className="space-y-1">
                                    <Badge variant={meta.tone}>{meta.label}</Badge>
                                    <p className="text-[11px] text-muted-foreground">{p.motivo}</p>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                      <MaisLinhas mostrando={limite} total={pendenciasFiltradas.length} onMais={() => setLimite((l) => l + PAGINA)} />
                    </>
                  )}
                </>
              ))}

            {tab === "saldo" && (
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Data da liberação</TableHead>
                    <TableHead className="text-right">Recebimentos</TableHead>
                    <TableHead className="text-right">Todas as operações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {saldoPorDia.map((d) => (
                    <TableRow key={d.data}>
                      <TableCell className="tabular-nums">{d.data}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(d.recebimentos)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{money(d.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}

      <HistoricoExecucoes service={service} execucoes={execucoes} erro={execucoesErro} nomes={nomes} />

      <AlertDialog
        open={dialogAberto}
        onOpenChange={(open) => {
          if (!open && !baixando) setDialogAberto(false);
        }}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-semibold">
              {baixaResultado ? "Resultado da baixa no Tiny ERP" : baixando ? "Baixando contas a receber no Tiny" : "Confirmar baixa no Tiny ERP"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {baixaResultado
                ? `${baixaResultado.total_sucessos} de ${baixaResultado.total_solicitados} recebimento(s) baixado(s).`
                : baixando
                  ? "Cada conta é relida antes da baixa: se já não estiver em aberto, ou o saldo for menor que o recebido, é pulada."
                  : `A baixa entra na conta ${analise?.lancamentos[0]?.conta ?? "do Mercado Livre"} de ${analise?.empresa_nome ?? ""}, na data da liberação, pelo valor bruto recebido.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {baixando && (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <JobProgress job={baixaJob} elapsedMs={decorrido} texto="Andamento da baixa" />
            </div>
          )}

          {!baixando && !baixaResultado && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
              {gruposSelecionados.map((g) => (
                <li key={g.id} className="flex items-start justify-between gap-3 p-2.5">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{g.nome_cliente}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {g.contas_vinculadas && g.contas_vinculadas.length > 1
                        ? `${g.contas_vinculadas.length} parcelas`
                        : `Conta #${g.conta_id}`}{" "}
                      · venda {g.id_venda} · {g.data}
                    </div>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums">{money(g.valor_total)}</span>
                </li>
              ))}
            </ul>
          )}

          {baixaResultado && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
              {baixaResultado.resultados.map((r) => (
                <li key={r.grupo_id} className="flex items-start justify-between gap-3 p-2.5">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">
                      {r.nome_cliente || r.grupo_id} {r.conta_id ? `· conta #${r.conta_id}` : ""}
                    </div>
                    <div className="break-words text-[11px] text-muted-foreground">{r.mensagem}</div>
                  </div>
                  <Badge variant={r.status === "sucesso" ? "success" : r.status === "ignorado" ? "secondary" : "danger"} className="shrink-0">
                    {r.status === "sucesso" ? "Baixada" : r.status === "ignorado" ? "Pulada" : "Falhou"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {baixaErro && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {baixaErro}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={baixando}>{baixaResultado || baixaErro ? "Fechar" : "Cancelar"}</AlertDialogCancel>
            {!baixaResultado && !baixaErro && (
              <Button onClick={() => void confirmarBaixa()} disabled={baixando || gruposSelecionados.length === 0} className="gap-1.5">
                {baixando ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {baixando
                  ? "Baixando…"
                  : `Confirmar baixa (${gruposSelecionados.length} · ${money(somaSelecionados(analise?.grupos ?? [], selecionados))})`}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
