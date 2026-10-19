'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  Calendar,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  ExternalLink,
  Home,
  Layers,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Workflow,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { HistoryFilter } from '@/components/history-filter';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { BrandLogo } from '@/components/ui/brand-logos';
import type { DashboardConfig, DateRangeFilter } from '@/lib/contracts';
import type { OverviewResponse, OverviewService } from '@/lib/overview-contracts';
import { createOverviewService } from '@/lib/overview-service';
import { aggregateOverview } from '@/lib/overview-metrics';
import { count, dateTime, decimal, formatTimeSaved, hours, money, percentage } from '@/lib/formatters';
import { SourceError } from './panel-state';

interface ExecutionTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  label?: string;
}

function ExecutionChartTooltip({ active, payload, label }: ExecutionTooltipProps) {
  if (!active || !payload || !payload.length) return null;

  const successItem = payload.find((p) => p.name === 'Execuções com Sucesso' || p.name === 'success');
  const errorItem = payload.find((p) => p.name === 'Falhas Registradas' || p.name === 'error');
  const successVal = Number(successItem?.value ?? 0);
  const errorVal = Number(errorItem?.value ?? 0);
  const total = successVal + errorVal;
  const rate = total > 0 ? Math.round((successVal / total) * 100) : 100;

  return (
    <div className="rounded-md border border-border bg-popover p-3 shadow-md text-xs min-w-[170px] space-y-2">
      <div className="flex items-center justify-between border-b border-border pb-1 font-mono text-muted-foreground">
        <span className="font-semibold text-foreground">{label}</span>
        <span>{total} total</span>
      </div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between text-teal-700 dark:text-teal-400 font-medium">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-teal-500" />
            Sucessos
          </span>
          <span className="font-mono tabular-nums">{successVal}</span>
        </div>
        <div className="flex items-center justify-between text-rose-500 font-medium">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            Falhas
          </span>
          <span className="font-mono tabular-nums">{errorVal}</span>
        </div>
        <div className="pt-1 border-t border-border/50 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Taxa de assertividade</span>
          <span className="font-mono font-bold text-foreground">{rate}%</span>
        </div>
      </div>
    </div>
  );
}

export default function Overview({
  config,
  service: injectedService,
}: {
  config: DashboardConfig;
  service?: OverviewService;
}) {
  const service = useMemo(
    () => injectedService ?? createOverviewService(config),
    [injectedService, config.mode, config.apiBaseUrl]
  );

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const [chartAutomationId, setChartAutomationId] = useState<string>('all');
  const [chartDateFilter, setChartDateFilter] = useState<DateRangeFilter>({ key: 'all' });

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);

    try {
      const result = await service.getOverview(controller.signal);
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível carregar a visão geral. Verifique sua conexão e tente novamente.'
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  const aggregated = useMemo(() => {
    if (!data) return null;
    return aggregateOverview(data);
  }, [data]);

  // Versão filtrada, só pro gráfico "Evolução das Execuções" (por automação/período) —
  // os cards de métricas consolidadas e saúde continuam usando `aggregated` sem filtro.
  const chartAggregated = useMemo(() => {
    if (!data) return null;
    return aggregateOverview(data, { automationId: chartAutomationId, dateFilter: chartDateFilter });
  }, [data, chartAutomationId, chartDateFilter]);

  // Robust calculations for financial metrics
  const estimatedSavingsTotal = useMemo(() => {
    if (aggregated?.financial?.estimatedSavings) return aggregated.financial.estimatedSavings;
    return data?.automations.reduce((sum, a) => sum + (a.dashboard.metrics?.estimatedSavings ?? 0), 0) ?? 0;
  }, [aggregated, data]);

  const hoursSavedTotal = useMemo(() => {
    if (aggregated?.financial?.hoursSaved) return aggregated.financial.hoursSaved;
    return data?.automations.reduce((sum, a) => sum + (a.dashboard.metrics?.hoursSaved ?? 0), 0) ?? 0;
  }, [aggregated, data]);

  const paidCountTotal = useMemo(() => {
    if (aggregated?.financial?.paidCount) return aggregated.financial.paidCount;
    return data?.automations.reduce((sum, a) => sum + (a.dashboard.metrics?.paidCount ?? 0), 0) ?? 0;
  }, [aggregated, data]);

  // Extract pending human actions
  const pendingApprovals = useMemo(() => {
    if (!data) return [];
    return data.automations.flatMap((a) =>
      (a.dashboard.approvals ?? []).map((app) => ({
        ...app,
        automationId: a.id,
        automationTitle: a.title,
        href: a.href,
      }))
    );
  }, [data]);

  const pendingFailures = useMemo(() => {
    if (!data) return [];
    return data.automations.flatMap((a) =>
      (a.dashboard.failures ?? []).map((fail) => ({
        ...fail,
        automationId: a.id,
        automationTitle: a.title,
        href: a.href,
      }))
    );
  }, [data]);

  // NF-e & DANFE (revisão/categorização de notas fiscais)
  const danfePendingReview = useMemo(
    () => pendingApprovals.filter((a) => a.automationId === 'danfe-tiny'),
    [pendingApprovals]
  );
  const danfeFailures = useMemo(
    () => pendingFailures.filter((f) => f.automationId === 'danfe-tiny'),
    [pendingFailures]
  );

  const totalPendingActions = danfePendingReview.length + danfeFailures.length;

  // System health
  const healthRate = aggregated?.health ?? (aggregated && aggregated.observed > 0 ? 100 : null);
  const status = error ? 'Falha' : totalPendingActions > 0 ? 'Requer atenção' : 'Operacional';

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const chartData = useMemo(() => {
    if (!chartAggregated?.days?.length) return [];
    return chartAggregated.days.map((day) => {
      const [, month, dNum] = day.date.split('-');
      return {
        date: day.date,
        displayDate: `${dNum}/${month}`,
        success: day.success ?? 0,
        error: day.error ?? 0,
      };
    });
  }, [chartAggregated?.days]);

  return (
    <>
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-5 border-b border-border/60">
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Telemetria Integrada & Monitoramento da Operação
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Home className="text-primary" size={26} />
            Visão Geral do Financeiro
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Métricas consolidadas em tempo real, auditoria fiscal, esteira de processamento e integridade dos serviços.
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <Button
            onClick={() => void refresh()}
            disabled={loading}
            className="h-9 px-3.5 text-xs font-semibold rounded-md border border-border bg-secondary hover:bg-accent text-foreground transition flex items-center gap-2 cursor-pointer"
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} size={13} />
            <span>{loading ? 'Atualizando…' : 'Sincronizar Fontes'}</span>
          </Button>
        </div>
      </div>

      {/* Context Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-border/60 bg-muted/40 mb-6 text-xs">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck size={14} className="text-primary" />
            Ecossistema Multi-Automação
          </span>
          <span className="text-muted-foreground">|</span>
          <Badge variant="success" className="font-mono">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {status}
          </Badge>
          {totalPendingActions > 0 && (
            <Badge variant="warning" className="font-mono">
              <AlertTriangle size={11} />
              {totalPendingActions} pendência{totalPendingActions > 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        <span className="text-[11px] font-mono text-muted-foreground flex items-center gap-1.5">
          <Clock3 size={12} className="text-muted-foreground" />
          {loading
            ? 'Consultando fontes…'
            : data
            ? `${error ? 'Desatualizado · ' : 'Atualizado · '}${dateTime(data.generatedAt)}`
            : 'Sem atualização'}
        </span>
      </div>

      {error && <SourceError message={error} />}

      {/* 1. Cards de Métricas Consolidadas (Totais Gerais) */}
      <section className="mb-8" aria-label="Métricas Consolidadas">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">Telemetria Consolidada</h2>
            <span className="text-muted-foreground text-xs">/</span>
            <span className="text-xs text-muted-foreground">Total acumulado de rotinas ativas</span>
          </div>
        </div>

        <div className="metric-grid">
          {/* Card 1: ROI Financeiro Total */}
          <article className="metric-card">
            <div className="metric-top">
              <span>ROI Financeiro Total</span>
              <span className="metric-icon text-primary">
                <CircleDollarSign size={16} />
              </span>
            </div>
            <div className="metric-value">
              {loading && !data ? '—' : money(estimatedSavingsTotal)}
            </div>
            <div className="metric-detail">
              Capacidade economizada calculada a R$ 11,00/h
            </div>
            <span className="estimate-label">Ganho financeiro acumulado</span>
          </article>

          {/* Card 2: Tempo Total Poupado */}
          <article className="metric-card">
            <div className="metric-top">
              <span>Tempo Total Poupado</span>
              <span className="metric-icon text-primary">
                <Clock3 size={16} />
              </span>
            </div>
            <div className="metric-value">
              {loading && !data ? '—' : formatTimeSaved(hoursSavedTotal)}
            </div>
            <div className="metric-detail">
              {hoursSavedTotal > 0
                ? `${Math.round(hoursSavedTotal * 60)} min · ${decimal.format(hoursSavedTotal)} h decimal`
                : 'Tempo manual eliminado nas rotinas ativas'}
            </div>
            <span className="estimate-label">Produtividade da equipe</span>
          </article>

          {/* Card 3: Volume Geral de Transações */}
          <article className="metric-card">
            <div className="metric-top">
              <span>Volume de Transações</span>
              <span className="metric-icon text-primary">
                <Layers size={16} />
              </span>
            </div>
            <div className="metric-value">
              {loading && !data ? '—' : `${count(paidCountTotal)} itens`}
            </div>
            <div className="metric-detail">
              Títulos e registros processados pelas automações
            </div>
            <span className="estimate-label">Processamento contínuo</span>
          </article>

          {/* Card 4: Saúde do Ecossistema */}
          <article className="metric-card">
            <div className="metric-top">
              <span>Saúde Operacional</span>
              <span className="metric-icon text-primary">
                <Activity size={16} />
              </span>
            </div>
            <div className="metric-value">
              {loading && !data ? '—' : percentage(healthRate)}
            </div>
            <div className="metric-detail">
              {aggregated ? (
                `${aggregated.success} sucessos vs ${aggregated.errors} erros em 14 dias`
              ) : (
                'Taxa de sucesso operacional'
              )}
            </div>
            <div className="rate-track" aria-hidden="true">
              <span style={{ width: `${Math.min(healthRate ?? 0, 100)}%` }} />
            </div>
          </article>
        </div>
      </section>

      {/* 2. Painel Central de Insights e Tendências */}
      <section className="mb-8" aria-label="Insights e Tendências">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Card de Tendências - Gráfico 14 Dias (Ocupa 2 colunas) */}
          <div className="panel lg:col-span-2 p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-4 mb-3">
                <div className="flex items-center gap-3">
                  <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
                    <TrendingUp size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold tracking-tight">
                      Evolução das Execuções (Últimos 14 Dias)
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Histórico cronológico de workflows e assertividade diária
                    </p>
                  </div>
                </div>
                <Badge variant="outline" className="text-[11px] font-normal">
                  {chartAggregated?.observed ?? 0} execuções no período
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-1">
                <NativeSelect
                  size="sm"
                  aria-label="Filtrar gráfico por automação"
                  value={chartAutomationId}
                  onChange={(e) => setChartAutomationId(e.target.value)}
                  className="h-8 text-xs w-auto min-w-[170px]"
                >
                  <NativeSelectOption value="all">Todas as automações</NativeSelectOption>
                  {(data?.automations ?? []).map((a) => (
                    <NativeSelectOption key={a.id} value={a.id}>
                      {a.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <HistoryFilter value={chartDateFilter} onChange={setChartDateFilter} />
              </div>

              {/* Gráfico de Linhas (Evolução 14 Dias - Estilo Linear com Cores Originais) */}
              <div className="mt-4 pt-2">
                <div className="h-60 w-full min-w-0">
                  {isMounted ? (
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
                      <LineChart
                        data={chartData}
                        margin={{ top: 12, right: 12, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="currentColor"
                          className="stroke-border/40"
                        />
                        <XAxis
                          dataKey="displayDate"
                          tickLine={false}
                          axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
                          tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
                          interval={0}
                        />
                        <YAxis
                          allowDecimals={false}
                          tickLine={false}
                          axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
                          tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
                          width={32}
                        />
                        <Tooltip content={<ExecutionChartTooltip />} />
                        <Line
                          type="linear"
                          dataKey="success"
                          name="Execuções com Sucesso"
                          stroke="var(--chart-1)"
                          strokeWidth={3.5}
                          dot={{
                            r: 3.5,
                            stroke: 'var(--chart-1)',
                            strokeWidth: 2,
                            fill: 'var(--card)',
                          }}
                          activeDot={{
                            r: 6,
                            stroke: 'var(--chart-1)',
                            strokeWidth: 2,
                            fill: 'var(--chart-1)',
                          }}
                        />
                        <Line
                          type="linear"
                          dataKey="error"
                          name="Falhas Registradas"
                          stroke="var(--destructive)"
                          strokeWidth={3.5}
                          dot={{
                            r: 3.5,
                            stroke: 'var(--destructive)',
                            strokeWidth: 2,
                            fill: 'var(--card)',
                          }}
                          activeDot={{
                            r: 6,
                            stroke: 'var(--destructive)',
                            strokeWidth: 2,
                            fill: 'var(--destructive)',
                          }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-xs text-muted-foreground font-mono">
                      Carregando métricas...
                    </div>
                  )}
                </div>

                {/* Legenda do Gráfico */}
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground mt-3 pt-2.5 border-t border-border">
                  <div className="flex items-center gap-5 text-[11px] font-medium">
                    <span className="flex items-center gap-2">
                      <span className="w-5 h-1 bg-teal-500 rounded-full inline-block" />
                      <span className="text-foreground">Execuções com Sucesso</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="w-5 h-1 bg-rose-500 rounded-full inline-block" />
                      <span className="text-foreground">Falhas Registradas</span>
                    </span>
                  </div>
                  <span className="text-[11px] font-mono">
                    {chartDateFilter.key !== 'all'
                      ? 'Filtro de período restrito à janela de 14 dias já carregada'
                      : 'Janela: 14 dias (Fuso de Brasília)'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Card de Distribuição de Volume por Rotina (Ocupa 1 coluna) */}
          <div className="panel p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
                  <Workflow size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold tracking-tight">
                    Distribuição por Rotina
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Carga operacional dividida por automação
                  </p>
                </div>
              </div>

              <div className="space-y-4 my-2">
                {/* Rotinas Ativas */}
                {(data?.automations ?? [
                  { id: 'danfe-tiny', title: 'NF-e & DANFE (Tiny ERP)', dashboard: { metrics: { paidCount: 0 } } },
                ]).map((a) => {
                  const countVal = a.dashboard?.metrics?.paidCount ?? 0;
                  const isDanfe = a.id === 'danfe-tiny';
                  const label = isDanfe ? 'notas processadas' : 'pagamentos processados';
                  const dotColor = isDanfe ? 'bg-blue-500' : 'bg-teal-500';
                  const barColor = isDanfe ? 'bg-blue-500' : 'bg-teal-500';
                  const statusColor = isDanfe ? 'text-blue-600 dark:text-blue-400' : 'text-teal-700 dark:text-teal-400';

                  return (
                    <div key={a.id} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                          {a.title}
                        </span>
                        <span className={`font-semibold ${statusColor}`}>Ativo</span>
                      </div>
                      <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                        <div className={`h-full ${barColor} rounded-full w-full`} />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {count(countVal)} {label}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-3 border-t border-border mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Capacidade modular</span>
              <span className="text-teal-700 dark:text-teal-400 font-medium">
                {data?.automations?.length ?? 2} ativas
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Quadro de Ações Globais Pendentes */}
      <section className="mb-8" aria-label="Ações Globais Pendentes">
        <div className="panel overflow-hidden">
          <div className="panel-header">
            <div className="section-title">
              <div className="section-icon amber bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <AlertTriangle size={18} />
              </div>
              <div>
                <h3>
                  Ações Globais Pendentes
                  {totalPendingActions > 0 && (
                    <Badge className="bg-amber-500 text-white text-[10px] h-[18px] px-2 font-semibold">
                      {totalPendingActions}
                    </Badge>
                  )}
                </h3>
                <p>
                  Alertas operacionais e autorizações que exigem intervenção humana imediata.
                </p>
              </div>
            </div>
            {(danfePendingReview.length > 0 || danfeFailures.length > 0) && (
              <Link
                href="/danfe-tiny"
                className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
              >
                Gerenciar em NF-e & DANFE
                <ArrowRight size={13} />
              </Link>
            )}
          </div>

          <div className="p-5">
            {totalPendingActions === 0 ? (
              <div className="empty py-8 text-center flex flex-col items-center justify-center">
                <div className="w-12 h-12 rounded-lg bg-[var(--marca-marinho)] text-[var(--marca-ambar)] flex items-center justify-center mb-3">
                  <CheckCircle2 size={24} />
                </div>
                <strong className="text-sm font-semibold">Tudo em dia</strong>
                <p className="text-xs text-muted-foreground mt-1 max-w-md">
                  Nenhuma pendência operacional identificada no momento. Todas as rotinas estão operando com regularidade.
                </p>
              </div>
            ) : (
              <div className="space-y-3">

                {/* Bloco de Notas Aguardando Categorização (NF-e & DANFE) */}
                {danfePendingReview.length > 0 && (
                  <div className="p-4 rounded-lg border border-sky-500/20 bg-sky-500/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded bg-sky-500/10 text-sky-700 dark:text-sky-400 mt-0.5">
                        <AlertTriangle size={16} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-foreground">
                            NF-e & DANFE: {danfePendingReview.length}{' '}
                            {danfePendingReview.length === 1 ? 'nota aguardando categorização' : 'notas aguardando categorização'}
                          </span>
                          <Badge variant="info" className="text-[10px]">
                            Revisão Humana
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Notas encontradas pela varredura direta na SEFAZ, aguardando categorização antes do lançamento no Tiny ERP.
                        </p>
                      </div>
                    </div>
                    <Link
                      href="/danfe-tiny"
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-sky-600 hover:bg-sky-700 text-white transition-colors self-start md:self-auto shrink-0 shadow-sm"
                    >
                      Categorizar Notas
                      <ExternalLink size={12} />
                    </Link>
                  </div>
                )}

                {/* Bloco de Falhas Fiscais / Lançamento (NF-e & DANFE) */}
                {danfeFailures.length > 0 && (
                  <div className="p-4 rounded-lg border border-rose-500/20 bg-rose-500/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 mt-0.5">
                        <AlertTriangle size={16} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-foreground">
                            NF-e & DANFE: {danfeFailures.length}{' '}
                            {danfeFailures.length === 1 ? 'falha fiscal detectada' : 'falhas fiscais detectadas'}
                          </span>
                          <Badge variant="danger" className="text-[10px]">
                            Ação Requerida
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Erros no lançamento de contas no Tiny ERP ou rejeições na varredura da SEFAZ.
                        </p>
                      </div>
                    </div>
                    <Link
                      href="/danfe-tiny"
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-rose-600 hover:bg-rose-700 text-white transition-colors self-start md:self-auto shrink-0 shadow-sm"
                    >
                      Inspecionar Falhas
                      <ExternalLink size={12} />
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 4. Status Operacional dos Serviços */}
      <section className="mb-10" aria-label="Status Operacional dos Serviços">
        <div className="section-heading">
          <h2>Status Operacional dos Serviços</h2>
          <span>Conectividade dos componentes essenciais</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {(() => {
            const defaultServices = [
              { id: 'mariadb', name: 'MariaDB', status: 'connected', message: 'Persistência relacional corporativa' },
              { id: 'tiny', name: 'Tiny ERP', status: 'connected', message: 'Gestão fiscal e lançamentos de títulos' },
              { id: 'inter', name: 'Banco Inter', status: 'connected', message: 'Liquidação e conciliação bancária' },
              { id: 'sefaz', name: 'SEFAZ NFeDistribuicaoDFe', status: 'connected', message: 'Varredura direta por CNPJ com certificado A1' },
            ];
            const baseList = (data?.services && data.services.length > 0 ? [...data.services] : defaultServices)
              .filter((s) => s.id !== 'n8n');
            if (!baseList.some((s) => s.id === 'sefaz')) {
              // A varredura SEFAZ é gerenciada pelo motor Python (automacao-nfe), não
              // pelo gateway Node — por isso nunca vem dentro de `data.services`.
              // Precisa respeitar o modo demo manualmente, como os demais cards.
              baseList.push({
                id: 'sefaz' as any,
                name: 'SEFAZ NFeDistribuicaoDFe',
                status: config.mode === 'demo' ? 'demo' : 'connected',
                message:
                  config.mode === 'demo'
                    ? 'Demonstração com dados fictícios; conexão real não verificada.'
                    : 'Varredura direta por CNPJ com certificado A1',
              });
            }
            return baseList;
          })().map((srv) => {
            const isConnected = srv.status === 'connected';
            const isDemo = srv.status === 'demo';
            const isError = srv.status === 'error';

            return (
              <div
                key={srv.id}
                className="panel p-4 flex flex-col justify-between transition-all hover:border-border/80"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center shrink-0 shadow-sm border border-border/40 bg-white p-1">
                        <BrandLogo name={srv.id} size={24} />
                      </div>
                      <span className="font-semibold text-xs text-foreground truncate">
                        {srv.name}
                      </span>
                    </div>

                    <Badge
                      variant={isConnected ? 'success' : isDemo ? 'info' : isError ? 'danger' : 'outline'}
                      className="text-[9px] h-5 px-2 font-medium"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                          isConnected
                            ? 'bg-emerald-500'
                            : isDemo
                            ? 'bg-sky-500'
                            : isError
                            ? 'bg-rose-500'
                            : 'bg-muted-foreground'
                        }`}
                      />
                      {isConnected
                        ? 'Conectado'
                        : isDemo
                        ? 'Simulação'
                        : isError
                        ? 'Indisponível'
                        : 'Não verificado'}
                    </Badge>
                  </div>

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {srv.message}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Monitoramento</span>
                  <span className="font-mono text-[9px] text-foreground/80">Ativo</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
