"use client";

import { Elapsed } from "./elapsed";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  CircleCheckBig,
  FileText,
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
import { InterLogo } from "@/components/ui/brand-logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
import DdaView from "./dda-view";
import { cn } from "@/lib/utils";
import { formatDateBR, money } from "@/lib/formatters";
import { toSaoPauloISODate } from "@/lib/date-range-utils";
import { downloadCsv } from "@/lib/csv-export";
import { ColumnFilterBar } from "./column-filter";
import {
  aplicaFiltros,
  carregarFiltrosSession,
  filtrosAtivosCount,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from "@/lib/column-filters";
import type {
  BaixaJob,
  BaixaResponse,
  PreviewJob,
  ReconciliationCompanyStatus,
  ReconciliationPreviewResponse,
} from "@/lib/reconciliation-contracts";
import {
  MATCH_METHOD_META,
  RECONCILIATION_COMPANIES,
  buildBaixaItem,
  describeDadosDe,
  describeEstadoAtualizadoEm,
  describeJobProgress,
  describeSeparated,
  isInterUnavailable,
  parseAvisos,
  resolveInterHealth,
  separatedTotals,
  waitForJob,
} from "@/lib/reconciliation-helpers";
import { createReconciliationService } from "@/lib/reconciliation-service";
import { useAuth } from "@/lib/auth-context";
import {
  type TabId,
  type ViewMode,
  type InterCoverage,
  MATCHES_DEFS,
  UNMATCHED_INTER_DEFS,
  UNMATCHED_TINY_DEFS,
  JA_BAIXADAS_DEFS,
  TRANSFERENCIAS_DEFS,
  defaultStartDate,
  PREVIEW_START_DELAY_MS,
  describePreviewError,
  describeBaixaError,
  ProgressBar,
  joinNames,
  type CompanyRow,
  TechnicalDetail,
  CompanyStatusCell,
  CompanyStatusSkeleton,
  EmptyState,
  PreviewProgressPanel,
  MetricSkeletons,
  TableSkeleton,
  MetricCard,
} from "./reconciliation-view-parts";
import {
  JaBaixadasTable,
  MatchesTable,
  TransferenciasTable,
  UnmatchedInterTable,
  UnmatchedTinyTable,
} from "./reconciliation-tables";

interface ReconciliationViewProps {
  apiBaseUrl?: string;
}

export default function ReconciliationView({ apiBaseUrl }: ReconciliationViewProps) {
  const service = useMemo(() => createReconciliationService(apiBaseUrl), [apiBaseUrl]);
  // A prévia (job no gateway) exige contas_pagar:importar_extrato; a baixa, contas_pagar:baixar.
  const { can } = useAuth();
  const canPreview = can("contas_pagar:importar_extrato");
  const canBaixar = can("contas_pagar:baixar");

  // Conciliação × Histórico. O histórico só monta na primeira visita e depois fica montado
  // (escondido) para preservar filtros/página; `historyReload` o recarrega após uma baixa.
  // Link dos avisos do DDA (/contas-a-pagar?aba=dda) abre direto na aba.
  const [abaInicial] = useState<ViewMode>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("aba") === "dda" ? "dda" : "conciliacao",
  );
  const [viewMode, setViewMode] = useState<ViewMode>(abaInicial);
  const [historyMounted, setHistoryMounted] = useState(false);
  const [historyReload, setHistoryReload] = useState(0);
  const [ddaMounted, setDdaMounted] = useState(abaInicial === "dda");
  const selectView = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === "historico") setHistoryMounted(true);
    if (mode === "dda") setDdaMounted(true);
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

  const baixaRunning = baixaJob !== null && baixaResult === null && baixaError === null;
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

  const toggleSelectOne = useCallback((contaId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(contaId)) {
        next.delete(contaId);
      } else {
        next.add(contaId);
      }
      return next;
    });
  }, []);

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
        "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 font-medium transition",
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
    { id: "dda", label: "Boletos DDA", icon: FileText },
  ];

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Seção de contas a pagar"
        className="inline-flex w-full rounded-none border border-border bg-card p-1 text-sm sm:w-auto"
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
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-none px-3.5 py-1.5 font-medium transition sm:flex-none",
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

      {ddaMounted && (
        <div role="tabpanel" id="rec-view-dda" aria-labelledby="rec-view-tab-dda" hidden={viewMode !== "dda"}>
          <DdaView apiBaseUrl={apiBaseUrl} />
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
                  startedAt={currentProgress ? currentProgress.startedAt : null}
                />
                <MetricSkeletons />
                <TableSkeleton />
              </>
            ) : currentError ? (
              <div className="panel">
                <SourceError message={currentError} reportar={{ automationId: "inter-reconciliation", executionId: "previa-da-conciliacao" }} />
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
                    className="flex gap-2.5 rounded-none border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-xs"
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
                  <div className="flex gap-2.5 rounded-none border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-xs">
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
                        <MatchesTable
                          data={data}
                          colFilters={colFilters}
                          updateColFilter={updateColFilter}
                          filteredMatches={filteredMatches}
                          selectedIds={selectedIds}
                          toggleSelectOne={toggleSelectOne}
                          toggleSelectAll={toggleSelectAll}
                          allVisibleSelected={allVisibleSelected}
                          visibleSelectedCount={visibleSelectedCount}
                        />
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
                        <UnmatchedInterTable
                          data={data}
                          colFilters={colFilters}
                          updateColFilter={updateColFilter}
                          filteredUnmatchedInter={filteredUnmatchedInter}
                        />
                      ))}

                    {activeTab === "unmatched_tiny" &&
                      (filteredUnmatchedTiny.length === 0 ? (
                        hasSearch && (data.unmatched_tiny?.length ?? 0) > 0 ? (
                          searchEmpty
                        ) : (
                          <Empty>Nenhuma conta a pagar em aberto no Tiny para o período e filial selecionados.</Empty>
                        )
                      ) : (
                        <UnmatchedTinyTable
                          data={data}
                          colFilters={colFilters}
                          updateColFilter={updateColFilter}
                          filteredUnmatchedTiny={filteredUnmatchedTiny}
                        />
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
                        <JaBaixadasTable
                          data={data}
                          colFilters={colFilters}
                          updateColFilter={updateColFilter}
                          filteredJaBaixadas={filteredJaBaixadas}
                        />
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
                        <TransferenciasTable
                          data={data}
                          colFilters={colFilters}
                          updateColFilter={updateColFilter}
                          filteredTransferencias={filteredTransferencias}
                          selectedIds={selectedIds}
                          toggleSelectOne={toggleSelectOne}
                        />
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
                  <div className="space-y-2 rounded-none border border-border bg-muted/40 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <output className="flex min-w-0 items-center gap-2 font-medium text-foreground" aria-live="polite">
                        {baixaRunning && (
                          <RefreshCw size={13} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
                        )}
                        <span className="truncate">{progress.label}</span>
                      </output>
                      {baixaRunning && (
                        <Elapsed since={baixaStartedAt} className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" />
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
                <div role="alert" className="rounded-none border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
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
                  <div key={s.label} className="rounded-none border border-border bg-muted/40 p-2.5">
                    <dt className="text-muted-foreground">{s.label}</dt>
                    <dd className="mt-0.5 break-words font-mono text-xs font-semibold tabular-nums text-foreground sm:text-sm">{s.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="flex gap-2 rounded-none border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                <p className="leading-relaxed text-muted-foreground">
                  As contas serão marcadas como <strong className="text-foreground">pagas</strong> no Tiny ERP com a data
                  e o valor liquidados no Banco Inter (juros, multa e desconto inclusos). Esta tela não desfaz a baixa.
                </p>
              </div>

              <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-none border border-border text-xs">
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
                <div role="alert" className="rounded-none border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {baixaError}
                </div>
              )}
            </>
          )}

          {baixaResult && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-none border border-border text-xs">
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
