'use client';

import { useEffect, useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { HistoryFilter } from '@/components/history-filter';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import type { DashboardConfig, DateRangeFilter } from '@/lib/contracts';
import type { OverviewResponse, OverviewService } from '@/lib/overview-contracts';
import { createOverviewService } from '@/lib/overview-service';
import { aggregateOverview } from '@/lib/overview-metrics';
import AreaOverview from './area-overview';

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
    <div className="rounded-none border border-border bg-popover p-3 shadow-md text-xs min-w-[170px] space-y-2">
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

// Visão geral do Financeiro: componente genérico da área + gráfico de execuções (de /api/overview).
export default function Overview({
  config,
  service: injectedService,
}: {
  config: DashboardConfig;
  service?: OverviewService;
}) {
  const service = useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/react-compiler -- depende só de mode/apiBaseUrl; o objeto config é recriado a cada render do pai
    () => injectedService ?? createOverviewService(config),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- depende só de mode/apiBaseUrl; o objeto config é recriado a cada render do pai
    [injectedService, config.mode, config.apiBaseUrl]
  );
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [chartAutomationId, setChartAutomationId] = useState<string>('all');
  const [chartDateFilter, setChartDateFilter] = useState<DateRangeFilter>({ key: 'all' });
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    service
      .getOverview(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch(() => undefined); // sem o gráfico a visão geral continua útil; a falha de fonte aparece no componente da área
    return () => controller.abort();
  }, [service]);

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- marca a montagem no cliente para o recharts
    setIsMounted(true);
  }, []);

  const chartAggregated = useMemo(
    () => (data ? aggregateOverview(data, { automationId: chartAutomationId, dateFilter: chartDateFilter }) : null),
    [data, chartAutomationId, chartDateFilter]
  );
  const chartData = useMemo(() => {
    if (!chartAggregated?.days?.length) return [];
    return chartAggregated.days.map((day) => {
      const [, month, dNum] = day.date.split('-');
      return { date: day.date, displayDate: `${dNum}/${month}`, success: day.success ?? 0, error: day.error ?? 0 };
    });
  }, [chartAggregated]);

  return (
    <AreaOverview area="financeiro">
      <section aria-label="Evolução das execuções" className="panel p-5">
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
      </section>
    </AreaOverview>
  );
}
