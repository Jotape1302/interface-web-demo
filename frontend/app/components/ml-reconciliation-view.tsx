"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadCsv } from "@/lib/csv-export";
import { ColumnFilterBar } from "./column-filter";
import { aplicaFiltros, carregarFiltrosSession, contarValores, filtrosAtivosCount, salvarFiltrosSession, type ColumnFilterValue, type ColumnFiltersState } from "@/lib/column-filters";
import { AlertTriangle, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CalendarClock, CalendarDays, CheckCircle2, CircleCheckBig, Download, Info, ListChecks, Play, ReceiptText, RefreshCw, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatDateTimeBR, money } from "@/lib/formatters";
import type { MlAnalise, MlAnaliseResumo, MlArquivoTipo, MlBaixaJob, MlBaixaResponse, MlExecucaoJob, MlExecucaoResumo, MlStatus } from "@/lib/ml-reconciliation-contracts";
import { conexoesFaltando, erroPeriodo, periodoTexto, podeBaixar, vendaCancelada, somaSelecionados, statusExecucaoMeta, waitForMlJob, formatarMensagemSincronizacaoTokens, type TokenSyncFeedback } from "@/lib/ml-reconciliation-helpers";
import { createMlReconciliationService, LancamentosJaExportadosError } from "@/lib/ml-reconciliation-service";
import { SourceError } from "./panel-state";
import { useAuth } from "@/lib/auth-context";
import { useDataPolling } from "@/lib/use-data-polling";
import { isDemoSession } from "@/lib/demo-session";
import { TabId, PAGINA, STATUS_POLL_MS, RECEBIMENTOS_DEFS, ATALHOS_RECEBIMENTOS, grupoCategoria, PARA_CONFERIR, VENDAS_DEFS, LANCAMENTOS_DEFS, PENDENCIAS_DEFS, ARQUIVOS, erroDe, horaRotina, hojeIso, Metric, JobProgress, Pilulas, unicaOpcao, MaisLinhas, HistoricoExecucoes } from "./ml-reconciliation-view-parts";
import { RecebimentosTable, VendasTable, LancamentosTable, PendenciasTable } from "./ml-reconciliation-tables";
import { MlTarifasPendentes } from "./ml-tarifas-pendentes";

// ─────────────────────────────────────────────────────────────────────────────
// Tela
// ─────────────────────────────────────────────────────────────────────────────

/** Relógio isolado fora do componente (handlers de ação, não renderização). */
const agora = () => Date.now();

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

  // Início (epoch ms) da tarefa em andamento; o cronômetro vive em <Elapsed>.
  const [execStartedAt, setExecStartedAt] = useState(0);
  const [baixaStartedAt, setBaixaStartedAt] = useState(0);
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
  // useDataPolling não sobrepõe ciclos (um fetch por vez), cancela ao desmontar e pausa com a aba oculta.
  const acompanhandoRotina = Boolean(status?.em_execucao) && !executando && !isDemoSession();
  useDataPolling(
    async (signal) => {
      const [s, e] = await Promise.allSettled([service.getStatus(signal), service.getExecucoes(20, signal)]);
      if (signal.aborted) return;
      if (s.status === "fulfilled") aplicarStatus(s.value);
      else setStatusErro(erroDe(s.reason, "Falha ao consultar a conciliação."));
      if (e.status === "fulfilled") {
        setExecucoes(e.value.itens);
        setExecucoesErro(null);
      } else setExecucoesErro(erroDe(e.reason, "Falha ao consultar o histórico."));
    },
    { intervalMs: STATUS_POLL_MS, enabled: acompanhandoRotina, refetchOnVisible: false },
  );

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
          if (a.grupos.some(podeBaixar)) recebimentos.grupo = ["Aptos para baixa"];
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
    setExecStartedAt(agora());
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
  const aptosVisiveis = gruposFiltrados.filter(podeBaixar);
  const todosVisiveisMarcados = aptosVisiveis.length > 0 && aptosVisiveis.every((g) => selecionados.has(g.id));
  const algunsVisiveisMarcados = aptosVisiveis.some((g) => selecionados.has(g.id));
  const gruposSelecionados = analise ? analise.grupos.filter((g) => selecionados.has(g.id) && podeBaixar(g)) : [];
  const empresaStatus = status?.empresas.find((e) => e.id === empresaId) ?? null;

  function trocarEmpresa(id: string) {
    if (id === empresaId) return;
    setEmpresaId(id);
    setAnalises(null);
    setAnaliseId(null);
    setAnaliseErro(null);
  }

  const alternar = useCallback((id: string) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }, [setSelecionados]);

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
    setBaixaStartedAt(agora());
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
    // Planilha de lançamentos marca o que foi exportado: só com a permissão de baixar.
    if (!analise || (tipo === "lancamentos" && !canBaixar)) return;
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
              "flex items-center gap-2 rounded-none p-2.5 text-xs",
              tokenSyncFeedback.tipo === "sucesso"
                ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            )}
          >
            <CheckCircle2 size={14} className={tokenSyncFeedback.tipo === "sucesso" ? "text-emerald-600" : "text-amber-600"} />
            <span>{tokenSyncFeedback.msg}</span>
          </div>
        )}

        {statusErro && <SourceError message={statusErro} reportar={{ automationId: "ml-reconciliation", executionId: "status" }} />}
        {status?.erro_gravacao && (
          <SourceError
            message={`A rotina não consegue gravar o resultado no servidor (permissão em data/): ${status.erro_gravacao}`}
            reportar={{ automationId: "ml-reconciliation", executionId: "gravacao-em-data" }}
          />
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
                <div key={e.id} className="rounded-none border border-border p-3 text-xs">
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

        <div className="flex flex-col gap-3 rounded-none border border-border bg-muted/20 p-3 lg:flex-row lg:items-end">
          <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
              Empresa
              <select
                className="h-8 w-full rounded-none border border-border bg-background px-2 text-xs text-foreground"
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
          <div className="rounded-none border border-border bg-muted/30 p-3">
            <JobProgress job={execJob} startedAt={execStartedAt} texto="Andamento da conciliação" />
            <p className="mt-2 text-[11px] text-muted-foreground">
              O Mercado Pago gera o relatório de liberações em alguns minutos, e o Tiny limita a velocidade das consultas: a execução
              pode levar de 5 a 20 minutos. Pode sair da tela — o resultado fica no histórico.
            </p>
          </div>
        )}
        {!executando && status?.em_execucao && (
          <p className="flex items-center gap-2 rounded-none border border-border bg-muted/30 p-3 text-xs text-foreground">
            <RefreshCw size={13} className="animate-spin text-primary" />
            {status.em_execucao.origem === "agendada" ? "Rotina diária em andamento" : "Execução em andamento"}
            {status.progresso ? `: ${status.progresso.empresa ? `${status.progresso.empresa} · ` : ""}${status.progresso.etapa}` : "…"}
          </p>
        )}
        {execErro && (
          <div role="alert" className="rounded-none border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
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
                "rounded-none px-3 py-1.5 text-xs font-medium transition",
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
              className="h-8 rounded-none border border-border bg-background px-2 text-xs text-foreground"
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
                  ? `Pendências acumuladas (todas as rodadas) · ${formatDateTimeBR(a.criada_em)}`
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

      {analiseErro && <SourceError message={analiseErro} reportar={{ automationId: "ml-reconciliation", executionId: "analise" }} />}
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
              ? "pendências acumuladas de todas as rodadas (vendas fora da janela de 60 dias continuam baixáveis)"
              : `liberações de ${periodoTexto(analise.periodo_de, analise.periodo_ate)}`}{" "}
            · {analise.fontes.liberacoes ?? 0} linha(s) do Mercado Pago, {analise.fontes.pedidos_ml ?? 0} venda(s) do Mercado Livre,{" "}
            {analise.fontes.pedidos_tiny ?? 0} pedido(s) do Tiny · {analise.resumo.total_movimentos} movimentos
          </div>

          {analise.avisos.length > 0 && (
            <div className="space-y-1.5 rounded-none border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
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
              {ARQUIVOS.filter((a) => a.tipo !== "lancamentos" || canBaixar).map((a) => (
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
              <output className="flex flex-wrap items-center gap-2 rounded-none border border-[var(--status-pending-border)] bg-[var(--status-pending-bg)] px-3 py-2 text-xs text-[var(--status-pending-fg)]">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{avisoExportacao.mensagem}</span>
                {avisoExportacao.permitirTodos && canBaixar && (
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
                      "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs font-medium transition",
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
                    <RecebimentosTable
                      analise={analise}
                      colFilters={colFilters}
                      updateColFilter={updateColFilter}
                      gruposFiltrados={gruposFiltrados}
                      limite={limite}
                      selecionados={selecionados}
                      alternar={alternar}
                      alternarTodos={alternarTodos}
                      aptosVisiveis={aptosVisiveis}
                      todosVisiveisMarcados={todosVisiveisMarcados}
                      algunsVisiveisMarcados={algunsVisiveisMarcados}
                    />
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
                    <VendasTable
                      analise={analise}
                      colFilters={colFilters}
                      updateColFilter={updateColFilter}
                      comparativoFiltrado={comparativoFiltrado}
                      limite={limite}
                    />
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
                      <LancamentosTable
                        analise={analise}
                        colFilters={colFilters}
                        updateColFilter={updateColFilter}
                        lancamentosFiltrados={lancamentosFiltrados}
                        limite={limite}
                      />
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
                      <PendenciasTable
                        analise={analise}
                        colFilters={colFilters}
                        updateColFilter={updateColFilter}
                        pendenciasFiltradas={pendenciasFiltradas}
                        limite={limite}
                      />
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

      <MlTarifasPendentes
        service={service}
        empresaId={empresaId}
        empresaNome={nomes.get(empresaId) ?? empresaId}
        canLancar={canBaixar}
        onConcluido={() => void carregarExecucoes()}
      />

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
                  : `A baixa entra na conta ${analise?.lancamentos[0]?.conta ?? "do Mercado Livre"} de ${analise?.empresa_nome ?? ""}, na data da venda, pelo valor bruto recebido.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {baixando && (
            <div className="rounded-none border border-border bg-muted/40 p-3">
              <JobProgress job={baixaJob} startedAt={baixaStartedAt} texto="Andamento da baixa" />
            </div>
          )}

          {!baixando && !baixaResultado && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-none border border-border text-xs">
              {gruposSelecionados.map((g) => (
                <li key={g.id} className="flex items-start justify-between gap-3 p-2.5">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{g.nome_cliente}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {vendaCancelada(g)
                        ? `Cria a conta do pedido nº ${g.pedido_tiny_numero} (${money(g.pedido_tiny_valor ?? 0)}), baixa e lança estorno + tarifas`
                        : g.contas_vinculadas && g.contas_vinculadas.length > 1
                          ? `${g.contas_vinculadas.length} parcelas`
                          : `Conta #${g.conta_id}`}{" "}
                      · venda {g.id_venda} · {g.data_venda || g.data}
                    </div>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums">{money(g.valor_total)}</span>
                </li>
              ))}
            </ul>
          )}

          {baixaResultado && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-none border border-border text-xs">
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
            <div role="alert" className="rounded-none border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
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
