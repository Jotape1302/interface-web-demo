'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Building2,
  Calendar,
  CircleDollarSign,
  Download,
  Info,
  Landmark,
  PiggyBank,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DashboardChartIcon } from '@/components/ui/dashboard-icon';
import { useTheme } from './theme-provider';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { HistoryFilter } from '@/components/history-filter';
import { ColumnFilterBar, ColumnFilterHeader } from './column-filter';
import {
  aplicaFiltros,
  carregarFiltrosSession,
  filtrosAtivosCount,
  obterValoresUnicos,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from '@/lib/column-filters';
import { resolveApiBaseUrl } from '@/lib/contracts';
import type {
  DashboardConfig,
  DateRangeFilter,
  FinancialDashboardAging,
  FinancialDashboardCategoryEntry,
  FinancialDashboardCompanyEntry,
  FinancialDashboardProjection,
  FinancialDashboardResponse,
  FinancialDashboardStaleSource,
  FinancialDashboardStatus,
} from '@/lib/contracts';
import { getPresetRange, toSaoPauloISODate } from '@/lib/date-range-utils';
import { money, percentage, formatDateTimeBR } from '@/lib/formatters';
import { makeDemoFinancialDashboard, makeDemoFinancialDashboardStatus } from '@/lib/demo';
import { downloadCsv } from '@/lib/csv-export';
import { financialDashboard } from '@/lib/automations';
import { getFinancialPalette, categoryColor, type FinancialPalette } from '@/lib/financial-dashboard-colors';
import { generateFinancialInsights, type FinancialInsight, type FinancialInsightTone } from '@/lib/financial-insights';
import { apiErrorMessage, readApiError } from '@/lib/api-errors';
import { useAuth } from '@/lib/auth-context';
import { ConfirmImpactDialog } from './confirm-impact-dialog';

const FORCE_SYNC_RISK = 'Ignora o intervalo entre sincronizações e consome a cota da API do Tiny das 3 empresas.';

const TOP_CATEGORIES_SHOWN = 6;

/** Recharts trata `fill`/`stroke` como atributos SVG de apresentação — passar
 * `var(--token)` neles não resolve de forma confiável (cai pro preto padrão do
 * SVG quando inválido). Por isso as cores aqui vêm sempre de hex resolvido em
 * JS (ver lib/financial-dashboard-colors.ts), nunca de custom properties CSS. */
function coloredBarShape<T>(getColor: (payload: T) => string, radius: [number, number, number, number]) {
  return function BarShape(props: unknown) {
    const { payload, ...rest } = props as { payload: T } & Record<string, unknown>;
    return <Rectangle {...rest} radius={radius} fill={getColor(payload)} />;
  };
}

const isoDate = toSaoPauloISODate;

/** Resolve o filtro de calendário padrão para datas concretas — "Todo o Período"
 * (sem from/to) cai para a janela de 13 meses que o backend mantém em cache. */
function resolveDateRange(filter: DateRangeFilter): { from: string; to: string } {
  if (filter.from && filter.to) {
    return { from: isoDate(filter.from), to: isoDate(filter.to) };
  }
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 12);
  return { from: isoDate(from), to: isoDate(to) };
}

function DeltaBadge({ pct, invert = false }: { pct: number | null; invert?: boolean }) {
  if (pct === null) return <span className="text-xs text-muted-foreground">Sem base de comparação</span>;
  const isUp = pct > 0;
  const isFlat = pct === 0;
  const good = isFlat ? null : invert ? !isUp : isUp;
  const colorClass = good === null ? 'text-muted-foreground' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const Icon = isUp ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${colorClass}`}>
      {!isFlat && <Icon size={13} />}
      {percentage(Math.abs(pct))} vs. período anterior
    </span>
  );
}

/** Rótulo de eixo mais curto que `money()` (sem centavos), pra caber na largura
 * reservada pro eixo Y sem cortar dígito — o valor exato continua no tooltip. */
function compactMoney(v: number): string {
  return money(Math.round(v)).replace(/,00$/, '');
}

function decimalPct(v: number) {
  return `${v.toFixed(1)}%`;
}

function foldCategories(
  entries: FinancialDashboardCategoryEntry[],
  palette: FinancialPalette,
): Array<FinancialDashboardCategoryEntry & { color: string }> {
  const top = entries
    .slice(0, TOP_CATEGORIES_SHOWN)
    .map((e, i) => ({ ...e, color: categoryColor(palette, i) }));
  const rest = entries.slice(TOP_CATEGORIES_SHOWN);
  if (rest.length === 0) return top;
  const outrosValor = rest.reduce((acc, r) => acc + r.valor, 0);
  const outrosValorAnterior = rest.reduce((acc, r) => acc + r.valor_anterior, 0);
  const outrosPct = rest.reduce((acc, r) => acc + r.percentual_do_total, 0);
  return [
    ...top,
    {
      categoria_id: '__outros__',
      categoria_nome: `Demais categorias (${rest.length})`,
      grupo: '',
      valor: outrosValor,
      valor_anterior: outrosValorAnterior,
      variacao_pct: outrosValorAnterior ? Math.round(((outrosValor - outrosValorAnterior) / outrosValorAnterior) * 1000) / 10 : null,
      percentual_do_total: Math.round(outrosPct * 10) / 10,
      color: palette.outros,
    },
  ];
}

function truncateAxisLabel(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? `${value}` : '';
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

// Tick customizado para eixos de categoria (nomes de fornecedores/clientes/categorias):
// o <Text> padrão do Recharts quebra rótulos longos em várias linhas sem levar em conta
// a altura de cada linha do gráfico, sobrepondo o texto às barras vizinhas. Truncar com
// reticências mantém uma linha por rótulo; o nome completo aparece no tooltip ao passar o mouse.
function CategoryAxisTick({
  x,
  y,
  payload,
  maxChars,
  fontSize,
}: {
  x?: number;
  y?: number;
  payload?: { value: unknown };
  maxChars: number;
  fontSize: number;
}) {
  if (x === undefined || y === undefined || !payload) return null;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill="currentColor" fillOpacity={0.75} fontSize={fontSize}>
      {truncateAxisLabel(payload.value, maxChars)}
    </text>
  );
}

function CategoryRankingChart({ entries, palette }: { entries: FinancialDashboardCategoryEntry[]; palette: FinancialPalette }) {
  const folded = useMemo(() => foldCategories(entries, palette), [entries, palette]);
  if (folded.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sem lançamentos no período selecionado.</p>;
  }
  const chartData = [...folded].reverse();
  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={200}>
        <ComposedChart data={chartData} layout="vertical" margin={{ top: 4, right: 74, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" className="stroke-border/40" />
          <XAxis
            type="number"
            tickFormatter={(v) => money(Number(v))}
            tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
          />
          <YAxis
            type="category"
            dataKey="categoria_nome"
            width={140}
            tick={<CategoryAxisTick maxChars={20} fontSize={11} />}
            tickLine={false}
            axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
          />
          <Tooltip
            cursor={{ fill: 'currentColor', opacity: 0.05 }}
            content={({ active, payload }) => {
              if (!active || !payload || !payload.length) return null;
              const row = payload[0].payload as FinancialDashboardCategoryEntry & { color: string };
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                  <p className="font-semibold text-popover-foreground">{row.categoria_nome}</p>
                  <p className="text-muted-foreground">{row.grupo}</p>
                  <p className="mt-1 font-mono text-popover-foreground">{money(row.valor)} ({percentage(row.percentual_do_total)})</p>
                  {row.variacao_pct !== null && (
                    <p className="text-muted-foreground">variação: {row.variacao_pct > 0 ? '+' : ''}{decimalPct(row.variacao_pct)}</p>
                  )}
                </div>
              );
            }}
          />
          <Bar
            dataKey="valor"
            maxBarSize={22}
            shape={coloredBarShape<FinancialDashboardCategoryEntry & { color: string }>((p) => p.color, [0, 4, 4, 0])}
          >
            <LabelList
              dataKey="valor"
              position="right"
              formatter={(v) => money(Number(v))}
              style={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
            />
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function TopEntitiesChart({
  entries,
  color,
}: {
  entries: Array<{ nome: string; valor: number; qtd: number }>;
  color: string;
}) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground py-6 text-center">Nenhuma conta em aberto.</p>;
  }
  const chartData = [...entries].reverse();
  return (
    <div className="h-44 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={140}>
        <ComposedChart data={chartData} layout="vertical" margin={{ top: 4, right: 68, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" className="stroke-border/40" />
          <XAxis
            type="number"
            tickFormatter={(v) => money(Number(v))}
            tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
          />
          <YAxis
            type="category"
            dataKey="nome"
            width={130}
            tick={<CategoryAxisTick maxChars={18} fontSize={10} />}
            tickLine={false}
            axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
          />
          <Tooltip
            cursor={{ fill: 'currentColor', opacity: 0.05 }}
            content={({ active, payload }) => {
              if (!active || !payload || !payload.length) return null;
              const row = payload[0].payload as { nome: string; valor: number; qtd: number };
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                  <p className="font-semibold text-popover-foreground">{row.nome}</p>
                  <p className="font-mono text-popover-foreground">{money(row.valor)}</p>
                  <p className="text-muted-foreground">{row.qtd} conta(s)</p>
                </div>
              );
            }}
          />
          <Bar dataKey="valor" maxBarSize={16} shape={coloredBarShape(() => color, [0, 4, 4, 0])}>
            <LabelList
              dataKey="valor"
              position="right"
              formatter={(v) => money(Number(v))}
              style={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
            />
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function CashFlowChart({
  meses,
  palette,
}: {
  meses: Array<{ label: string; receita: number; despesa: number; saldo: number }>;
  palette: FinancialPalette;
}) {
  if (meses.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sem histórico sincronizado ainda.</p>;
  }
  return (
    <div className="h-72 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
        <ComposedChart data={meses} margin={{ top: 12, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="stroke-border/40" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
            tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) => compactMoney(Number(v))}
            tickLine={false}
            axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
            tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
            width={78}
          />
          <Tooltip
            cursor={{ stroke: 'currentColor', opacity: 0.1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload || !payload.length) return null;
              return (
                <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md space-y-0.5">
                  <p className="font-semibold text-popover-foreground mb-1">{label}</p>
                  {payload.map((p) => (
                    <p key={p.dataKey as string} className="font-mono" style={{ color: p.color }}>
                      {p.name}: {money(Number(p.value))}
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="receita" name="Receita (entrada)" fill={palette.entrada} radius={[3, 3, 0, 0]} maxBarSize={18} />
          <Bar dataKey="despesa" name="Despesa (saída)" fill={palette.saida} radius={[3, 3, 0, 0]} maxBarSize={18} />
          <Line type="monotone" dataKey="saldo" name="Saldo" stroke={palette.faturamentoBruto} strokeWidth={2.5} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Barras horizontais simples por faixa de atraso/vencimento — vencidas em vermelho. */
function AgingBuckets({
  faixas,
  accentColor,
}: {
  faixas: NonNullable<FinancialDashboardAging['faixas']>;
  accentColor: string;
}) {
  const max = Math.max(...faixas.map((f) => f.valor), 1);
  return (
    <div className="mb-4">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-2">Por faixa de vencimento</p>
      <ul className="space-y-1.5">
        {faixas.map((f) => {
          const vencida = f.faixa.startsWith('vencido');
          return (
            <li key={f.faixa} className="grid grid-cols-[9.5rem_1fr_auto] items-center gap-2 text-[11px]">
              <span className={vencida ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}>{f.label}</span>
              <span className="h-2 rounded-full bg-muted overflow-hidden">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(f.valor / max) * 100}%`, backgroundColor: vencida ? 'var(--destructive)' : accentColor }}
                />
              </span>
              <span className="font-mono tabular-nums text-right min-w-[6.5rem]">
                {money(f.valor)} <span className="text-muted-foreground">({f.qtd})</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProjectionCard({ projecao, palette }: { projecao: FinancialDashboardProjection; palette: FinancialPalette }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="section-icon" style={{ backgroundColor: `${palette.lucro}1a`, color: palette.lucro }}>
          <TrendingUp size={18} />
        </div>
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Projeção de Compromissos</h3>
          <p
            className="text-xs text-muted-foreground inline-flex items-center gap-1"
            title="Soma dos títulos em aberto por data de vencimento: a receber menos a pagar. Não inclui saldo bancário nem títulos já vencidos."
          >
            A receber − a pagar pelos vencimentos
            <Info size={11} className="text-muted-foreground cursor-help" />
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 my-4">
        {projecao.horizontes.map((h) => (
          <div key={h.dias} className="rounded-lg border border-border/60 p-2.5">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{h.dias} dias</p>
            <p
              className="text-sm font-bold tabular-nums"
              style={{ color: h.saldo < 0 ? palette.saida : palette.entrada }}
            >
              {money(h.saldo)}
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
              +{money(h.a_receber)}
              <br />−{money(h.a_pagar)}
            </p>
          </div>
        ))}
      </div>
      <div className="h-40 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={120}>
          <ComposedChart data={projecao.semanal} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="stroke-border/40" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
              tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v) => compactMoney(Number(v))}
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
              width={70}
            />
            <Tooltip
              cursor={{ stroke: 'currentColor', opacity: 0.1 }}
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null;
                const row = payload[0].payload as FinancialDashboardProjection['semanal'][number];
                return (
                  <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md space-y-0.5">
                    <p className="font-semibold text-popover-foreground mb-1">Semana de {row.label}</p>
                    <p className="font-mono" style={{ color: palette.entrada }}>A receber: {money(row.a_receber)}</p>
                    <p className="font-mono" style={{ color: palette.saida }}>A pagar: {money(row.a_pagar)}</p>
                    <p className="font-mono text-popover-foreground">Acumulado: {money(row.saldo_acumulado)}</p>
                  </div>
                );
              }}
            />
            <Bar dataKey="a_receber" name="A receber" fill={palette.entrada} radius={[2, 2, 0, 0]} maxBarSize={10} />
            <Bar dataKey="a_pagar" name="A pagar" fill={palette.saida} radius={[2, 2, 0, 0]} maxBarSize={10} />
            <Line type="monotone" dataKey="saldo_acumulado" name="Acumulado" stroke={palette.lucro} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const STALE_SOURCE_LABELS: Record<FinancialDashboardStaleSource['fonte'], string> = {
  caixa: 'receitas/despesas (caixa)',
  contas_pagar: 'contas a pagar',
  contas_receber: 'contas a receber',
  forma_pagamento: 'forma de pagamento',
};

/**
 * Aviso de dados desatualizados: quando uma fonte do Tiny falha na sincronização, o
 * backend mantém o último dado bom — sem este aviso, ele pareceria atual.
 */
function StaleDataBanner({
  stale,
  failedCompanies,
}: {
  stale: FinancialDashboardStaleSource[];
  failedCompanies: Array<{ label: string; erro: string | null }>;
}) {
  if (stale.length === 0 && failedCompanies.length === 0) return null;
  const byCompany = new Map<string, FinancialDashboardStaleSource[]>();
  for (const s of stale) byCompany.set(s.label, [...(byCompany.get(s.label) ?? []), s]);
  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs">
      <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" />
      <div className="space-y-1">
        <p className="font-semibold text-amber-700 dark:text-amber-300">
          Parte dos dados não foi atualizada na última sincronização
        </p>
        <ul className="text-muted-foreground space-y-0.5">
          {[...byCompany.entries()].map(([label, sources]) => (
            <li key={label}>
              <strong className="text-foreground">{label}</strong>:{' '}
              {sources
                .map((s) =>
                  `${STALE_SOURCE_LABELS[s.fonte]} ${s.synced_at ? `de ${formatDateTimeBR(s.synced_at)}` : 'sem data conhecida'}`,
                )
                .join('; ')}
            </li>
          ))}
          {failedCompanies
            .filter((c) => !byCompany.has(c.label))
            .map((c) => (
              <li key={c.label}>
                <strong className="text-foreground">{c.label}</strong>: {c.erro ?? 'falha na sincronização'}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

function AgingCard({
  title,
  icon: Icon,
  aging,
  chartLabel,
  accentColor,
}: {
  title: string;
  icon: typeof Wallet;
  aging: FinancialDashboardAging;
  chartLabel: string;
  accentColor: string;
}) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="section-icon" style={{ backgroundColor: `${accentColor}1a`, color: accentColor }}>
          <Icon size={18} />
        </div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Vencido</p>
          <p className="text-base font-bold text-rose-600 dark:text-rose-400">{money(aging.vencido_valor)}</p>
          <p className="text-[11px] text-muted-foreground">{aging.vencido_qtd} conta(s)</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Próx. 7 dias</p>
          <p className="text-base font-bold">{money(aging.proximos_7_dias_valor)}</p>
          <p className="text-[11px] text-muted-foreground">{aging.proximos_7_dias_qtd} conta(s)</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Próx. 30 dias</p>
          <p className="text-base font-bold">{money(aging.proximos_30_dias_valor)}</p>
          <p className="text-[11px] text-muted-foreground">{aging.proximos_30_dias_qtd} conta(s)</p>
        </div>
      </div>
      {aging.taxa_inadimplencia_pct !== undefined && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <AlertTriangle size={14} className="text-amber-700 dark:text-amber-400 shrink-0" />
          <p className="text-xs">
            Taxa de inadimplência: <strong>{percentage(aging.taxa_inadimplencia_pct)}</strong> do saldo em aberto
          </p>
        </div>
      )}
      {aging.faixas && aging.faixas.some((f) => f.valor > 0) && <AgingBuckets faixas={aging.faixas} accentColor={accentColor} />}
      {aging.top.length > 0 && (
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">{chartLabel}</p>
          <TopEntitiesChart entries={aging.top} color={accentColor} />
        </div>
      )}
    </div>
  );
}

const INSIGHT_TONE_STYLES: Record<FinancialInsightTone, { border: string; bg: string; fg: string; Icon: typeof Info }> = {
  negative: { border: 'border-rose-500/40', bg: 'bg-rose-500/5', fg: 'text-rose-700 dark:text-rose-400', Icon: TrendingDown },
  warning: { border: 'border-amber-500/40', bg: 'bg-amber-500/5', fg: 'text-amber-700 dark:text-amber-400', Icon: AlertTriangle },
  positive: { border: 'border-emerald-500/40', bg: 'bg-emerald-500/5', fg: 'text-emerald-700 dark:text-emerald-400', Icon: TrendingUp },
  neutral: { border: 'border-border', bg: 'bg-muted/30', fg: 'text-muted-foreground', Icon: Info },
};

function InsightCard({ insight }: { insight: FinancialInsight }) {
  const style = INSIGHT_TONE_STYLES[insight.tone];
  const { Icon } = style;
  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} p-4 flex gap-3`}>
      <Icon size={18} className={`shrink-0 mt-0.5 ${style.fg}`} />
      <div>
        <p className={`text-sm font-semibold ${style.fg}`}>{insight.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{insight.description}</p>
      </div>
    </div>
  );
}

const EMPRESAS_DEFS: Record<string, ColumnFilterDef<FinancialDashboardCompanyEntry>> = {
  empresa: {
    id: 'empresa',
    label: 'Empresa',
    tipo: 'lista',
    accessor: (e) => e.label,
  },
  receita: {
    id: 'receita',
    label: 'Entradas',
    tipo: 'numero',
    accessor: (e) => e.receita,
  },
  despesas: {
    id: 'despesas',
    label: 'Saídas',
    tipo: 'numero',
    accessor: (e) => e.despesa,
  },
  resultado: {
    id: 'resultado',
    label: 'Resultado',
    tipo: 'numero',
    accessor: (e) => e.resultado_liquido,
  },
  margem: {
    id: 'margem',
    label: 'Margem',
    tipo: 'numero',
    accessor: (e) => e.margem_liquida_pct ?? 0,
  },
  a_pagar_vencido: {
    id: 'a_pagar_vencido',
    label: 'A pagar vencido',
    tipo: 'numero',
    accessor: (e) => e.a_pagar_vencido ?? 0,
  },
  a_receber_vencido: {
    id: 'a_receber_vencido',
    label: 'A receber vencido',
    tipo: 'numero',
    accessor: (e) => e.a_receber_vencido ?? 0,
  },
};

export default function FinancialDashboardPanel({ config }: { config: DashboardConfig }) {
  // Botões de sincronização aparecem só com a permissão (o gateway barra do mesmo jeito).
  const { can } = useAuth();
  const canSync = can('dashboard_financeiro:sincronizar');
  const canForceSync = can('dashboard_financeiro:forcar_sincronizacao');
  const [confirmForceSync, setConfirmForceSync] = useState(false);
  const apiBase = resolveApiBaseUrl(config.apiBaseUrl).replace(/\/$/, '');
  const { theme } = useTheme();
  const palette = useMemo(() => getFinancialPalette(theme), [theme]);
  const [status, setStatus] = useState<FinancialDashboardStatus | null>(null);
  const [data, setData] = useState<FinancialDashboardResponse | null>(null);
  const [filter, setFilter] = useState<DateRangeFilter>(() => getPresetRange('thisMonth'));
  const [company, setCompany] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notSynced, setNotSynced] = useState(false);
  const [cashFlowView, setCashFlowView] = useState<'diario' | 'mensal'>('diario');

  const getStoredAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (typeof window !== 'undefined') {
      const token =
        window.localStorage.getItem('norvia_session_token') ||
        window.sessionStorage.getItem('norvia_session_token');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        headers['x-session-token'] = token;
      }
    }
    return headers;
  }, []);

  const loadStatus = useCallback(async () => {
    if (config.mode === 'demo') {
      setStatus(makeDemoFinancialDashboardStatus());
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/financial-dashboard/status`, { headers: getStoredAuthHeaders() });
      if (res.ok) setStatus((await res.json()) as FinancialDashboardStatus);
    } catch {
      // status é informativo; falha aqui não deve travar o resto do painel
    }
  }, [apiBase, config.mode, getStoredAuthHeaders]);

  const { from: dateFrom, to: dateTo } = useMemo(() => resolveDateRange(filter), [filter]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    setNotSynced(false);
    if (config.mode === 'demo') {
      setData(makeDemoFinancialDashboard(dateFrom, dateTo, company === 'all' ? undefined : company));
      setLoading(false);
      return;
    }
    try {
      const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
      if (company !== 'all') params.set('company', company);
      const res = await fetch(`${apiBase}/api/financial-dashboard?${params.toString()}`, {
        headers: getStoredAuthHeaders(),
      });
      if (res.status === 404) {
        setData(null);
        setNotSynced(true);
        return;
      }
      if (!res.ok) throw new Error(await readApiError(res, 'Falha ao consultar o Dashboard Financeiro'));
      setData((await res.json()) as FinancialDashboardResponse);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Falha ao consultar o Dashboard Financeiro');
    } finally {
      setLoading(false);
    }
  }, [apiBase, company, config.mode, dateFrom, dateTo, getStoredAuthHeaders]);

  useEffect(() => {
    void loadStatus();
    void loadDashboard();
  }, [loadStatus, loadDashboard]);

  const handleSync = useCallback(async (force = false) => {
    setConfirmForceSync(false);
    setSyncing(true);
    setErrorMessage(null);
    try {
      if (config.mode === 'demo') {
        await new Promise((resolve) => setTimeout(resolve, 700));
        setStatus(makeDemoFinancialDashboardStatus());
        await loadDashboard();
        return;
      }
      const res = await fetch(`${apiBase}/api/financial-dashboard/sync${force ? '?force=true' : ''}`, {
        method: 'POST',
        headers: getStoredAuthHeaders(),
      });
      const body = (await res.json().catch(() => null)) as FinancialDashboardStatus | null;
      if (!res.ok) throw new Error(apiErrorMessage(body, res.status, 'Falha ao sincronizar'));
      if (body) setStatus(body);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Falha ao sincronizar o Dashboard Financeiro');
    } finally {
      setSyncing(false);
    }
  }, [apiBase, config.mode, getStoredAuthHeaders, loadDashboard]);

  const insights = useMemo(() => (data ? generateFinancialInsights(data) : []), [data]);

  // Empresas que falharam por inteiro na última sincronização (token ausente, exceção) —
  // falhas parciais por fonte já vêm em `data.dados_desatualizados`.
  const failedCompanies = useMemo(() => {
    const labels = new Map((data?.companies_available ?? []).map((c) => [c.account_id, c.label]));
    return (status?.companies ?? [])
      .filter((c) => !c.ok && (company === 'all' || c.account_id === company))
      .map((c) => ({ label: labels.get(c.account_id) ?? c.account_id, erro: c.erro }));
  }, [status, data, company]);

  const [colFiltersEmpresas, setColFiltersEmpresas] = useState<ColumnFiltersState>(() =>
    carregarFiltrosSession('dashboard_financeiro', 'empresas'),
  );

  const updateColFilterEmpresas = (id: string, val: ColumnFilterValue | undefined) => {
    setColFiltersEmpresas((prev) => {
      const proximo = { ...prev };
      if (val === undefined) delete proximo[id];
      else proximo[id] = val;
      salvarFiltrosSession('dashboard_financeiro', 'empresas', proximo);
      return proximo;
    });
  };

  const clearFiltersEmpresas = () => {
    setColFiltersEmpresas({});
    salvarFiltrosSession('dashboard_financeiro', 'empresas', {});
  };

  const empresasFiltradas = useMemo(() => {
    return aplicaFiltros(data?.por_empresa ?? [], colFiltersEmpresas, EMPRESAS_DEFS);
  }, [data?.por_empresa, colFiltersEmpresas]);

  const exportCategories = useCallback(() => {
    if (!data) return;
    const rows = [
      ...data.receitas_por_categoria.map((c) => ['Receita', c] as const),
      ...data.despesas_por_categoria.map((c) => ['Despesa', c] as const),
    ].map(([tipo, c]) => [tipo, c.categoria_nome, c.grupo, c.valor, c.valor_anterior, c.variacao_pct, c.percentual_do_total]);
    downloadCsv(
      `dashboard-financeiro_categorias_${data.period.from}_a_${data.period.to}`,
      ['Tipo', 'Categoria', 'Grupo', 'Valor no período', 'Valor período anterior', 'Variação (%)', '% do total'],
      rows,
    );
  }, [data]);

  const exportCompanies = useCallback(() => {
    if (!data?.por_empresa) return;
    downloadCsv(
      `dashboard-financeiro_empresas_${data.period.from}_a_${data.period.to}`,
      ['Empresa', 'Entradas', 'Saídas', 'Resultado', 'Margem (%)', 'A pagar vencido', 'A receber vencido'],
      empresasFiltradas.map((e) => [
        e.label,
        e.receita,
        e.despesa,
        e.resultado_liquido,
        e.margem_liquida_pct,
        e.a_pagar_vencido,
        e.a_receber_vencido,
      ]),
    );
  }, [data, empresasFiltradas]);

  const dailyFlow = data?.fluxo_caixa_diario ?? null;
  const showDailyFlow = cashFlowView === 'diario' && dailyFlow !== null;

  const isRunning = status?.is_running ?? false;
  const cooldownRemaining = status?.cooldown_seconds_remaining ?? 0;

  return (
    <>
      <div className="space-y-6">
        <div className="border-b border-border/40 pb-5">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Controle Financeiro & Gestão de Gastos
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <DashboardChartIcon className="text-primary" width={26} height={26} />
            {financialDashboard.title}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Indicadores financeiros reais extraídos do Tiny ERP — controle de gastos, categorias, contas a
            pagar/receber e comparativo entre empresas.
          </p>
        </div>

        <div className="panel p-4 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <HistoryFilter value={filter} onChange={setFilter} />
            <NativeSelect
              size="sm"
              aria-label="Selecionar empresa"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="h-8 text-xs w-auto min-w-[170px]"
            >
              <NativeSelectOption value="all">Todas as empresas</NativeSelectOption>
              {(data?.companies_available ?? []).map((c) => (
                <NativeSelectOption key={c.account_id} value={c.account_id}>
                  {c.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Calendar size={13} />
              {status?.last_sync_finished_at ? (
                <span>Última sincronização: {formatDateTimeBR(status.last_sync_finished_at)}</span>
              ) : (
                <span>Ainda não sincronizado</span>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={exportCategories}
              disabled={!data}
              className="h-8 text-xs gap-1.5"
              title="Receitas e despesas por categoria no período selecionado"
            >
              <Download size={13} />
              Exportar CSV
            </Button>
            {canSync && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSync()}
                disabled={syncing || isRunning || cooldownRemaining > 0}
                className="h-8 text-xs gap-1.5"
              >
                <RefreshCw size={13} className={syncing || isRunning ? 'animate-spin' : ''} />
                {isRunning || syncing ? 'Sincronizando…' : cooldownRemaining > 0 ? `Aguarde ${Math.ceil(cooldownRemaining / 60)} min` : 'Sincronizar agora'}
              </Button>
            )}
            {canForceSync && cooldownRemaining > 0 && !syncing && !isRunning && (
              <Button size="sm" variant="outline" onClick={() => setConfirmForceSync(true)} className="h-8 text-xs">
                Forçar sincronização
              </Button>
            )}
          </div>
        </div>

        {errorMessage && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle size={14} className="shrink-0" />
            {errorMessage}
          </div>
        )}

        {loading && !data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3" aria-label="Carregando indicadores">
            {[1, 2, 3, 4, 5].map((i) => (
              <div className="metric-card skeleton" key={i} />
            ))}
          </div>
        )}

        {!loading && notSynced && (
          <div className="panel p-8 text-center">
            <PiggyBank size={28} className="mx-auto mb-3 text-muted-foreground" />
            <h3 className="text-sm font-semibold mb-1">Dashboard Financeiro ainda não foi sincronizado</h3>
            <p className="text-xs text-muted-foreground mb-4">
              A primeira sincronização lê o histórico de caixa, categorias e contas do Tiny ERP para as 4 empresas
              monitoradas — pode levar alguns minutos.
            </p>
            {canSync && (
              <Button size="sm" onClick={() => void handleSync()} disabled={syncing} className="gap-1.5">
                <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
                {syncing ? 'Sincronizando…' : 'Sincronizar agora'}
              </Button>
            )}
          </div>
        )}

        {data && (
          <>
            <StaleDataBanner stale={data.dados_desatualizados ?? []} failedCompanies={failedCompanies} />

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <article className="metric-card">
                <div className="metric-top">
                  <span
                    className="inline-flex items-center gap-1"
                    title="Soma só das vendas (categoria &quot;Receitas&quot;). Não conta juros, rendimento de aplicação ou outras receitas financeiras — essas entram apenas em Receita Total."
                  >
                    Faturamento bruto
                    <Info size={12} className="text-muted-foreground cursor-help" />
                  </span>
                  <span className="metric-icon" style={{ backgroundColor: `${palette.faturamentoBruto}1a`, color: palette.faturamentoBruto }}>
                    <Building2 size={19} />
                  </span>
                </div>
                <div className="metric-value">{money(data.summary.faturamento_bruto)}</div>
                <div className="metric-detail"><DeltaBadge pct={data.summary.faturamento_bruto_variacao_pct} /></div>
                <p className="text-[10px] text-muted-foreground mt-1.5">Só vendas, sem receitas financeiras</p>
              </article>
              <article className="metric-card">
                <div className="metric-top">
                  <span
                    className="inline-flex items-center gap-1"
                    title="Soma todas as entradas do período: o Faturamento Bruto (vendas) mais receitas financeiras, como juros e rendimento de aplicação."
                  >
                    Receita total (entradas)
                    <Info size={12} className="text-muted-foreground cursor-help" />
                  </span>
                  <span className="metric-icon" style={{ backgroundColor: `${palette.entrada}1a`, color: palette.entrada }}>
                    <CircleDollarSign size={19} />
                  </span>
                </div>
                <div className="metric-value">{money(data.summary.receita_total)}</div>
                <div className="metric-detail"><DeltaBadge pct={data.summary.receita_variacao_pct} /></div>
                <p className="text-[10px] text-muted-foreground mt-1.5">Faturamento bruto + receitas financeiras</p>
              </article>
              <article className="metric-card">
                <div className="metric-top">
                  <span>Despesas totais (saídas)</span>
                  <span className="metric-icon" style={{ backgroundColor: `${palette.saida}1a`, color: palette.saida }}>
                    <Wallet size={19} />
                  </span>
                </div>
                <div className="metric-value">{money(data.summary.despesa_total)}</div>
                <div className="metric-detail"><DeltaBadge pct={data.summary.despesa_variacao_pct} invert /></div>
              </article>
              <article className="metric-card">
                <div className="metric-top">
                  <span>Resultado líquido (lucro)</span>
                  <span className="metric-icon" style={{ backgroundColor: `${palette.lucro}1a`, color: palette.lucro }}>
                    <Landmark size={19} />
                  </span>
                </div>
                <div className={`metric-value ${data.summary.resultado_liquido < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                  {money(data.summary.resultado_liquido)}
                </div>
                <div className="metric-detail"><DeltaBadge pct={data.summary.resultado_liquido_variacao_pct} /></div>
              </article>
              <article className="metric-card">
                <div className="metric-top">
                  <span>Margem líquida</span>
                  <span className="metric-icon" style={{ backgroundColor: `${palette.lucro}1a`, color: palette.lucro }}>
                    <Banknote size={19} />
                  </span>
                </div>
                <div className="metric-value">{percentage(data.summary.margem_liquida_pct)}</div>
                <div className="metric-detail text-xs text-muted-foreground">
                  Período anterior: {percentage(data.summary.margem_liquida_pct_anterior)}
                </div>
              </article>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className={`panel p-5 ${data.projecao_caixa ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
                  <div className="flex items-center gap-3">
                    <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
                      <CircleDollarSign size={18} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold tracking-tight">
                        {showDailyFlow ? 'Fluxo de Caixa diário (período selecionado)' : 'Fluxo de Caixa (13 meses)'}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Entradas, saídas e saldo {showDailyFlow ? 'por dia' : 'mensal'} — movimentação real de caixa
                      </p>
                    </div>
                  </div>
                  {dailyFlow !== null && (
                    <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
                      {(['diario', 'mensal'] as const).map((view) => (
                        <button
                          key={view}
                          type="button"
                          onClick={() => setCashFlowView(view)}
                          aria-pressed={cashFlowView === view}
                          className={`px-2.5 py-1 rounded ${cashFlowView === view ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}
                        >
                          {view === 'diario' ? 'Diário' : 'Mensal'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <CashFlowChart meses={showDailyFlow ? dailyFlow : data.fluxo_caixa_mensal} palette={palette} />
              </div>

              {data.projecao_caixa && <ProjectionCard projecao={data.projecao_caixa} palette={palette} />}
            </div>

            {data.por_empresa && data.por_empresa.length > 0 && (
              <div className="panel p-5 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
                    <Building2 size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold tracking-tight">Comparativo entre Empresas</h3>
                    <p className="text-xs text-muted-foreground">
                      Resultado no período selecionado; vencidos são a foto de hoje.
                    </p>
                  </div>
                </div>

                <ColumnFilterBar
                  totalCount={data.por_empresa.length}
                  filteredCount={empresasFiltradas.length}
                  activeFiltersCount={filtrosAtivosCount(colFiltersEmpresas)}
                  onClearAll={clearFiltersEmpresas}
                  onExportCsv={exportCompanies}
                  itemLabel="empresas"
                />

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                        <th className="text-left font-medium py-2 pr-3">
                          <ColumnFilterHeader
                            title="Empresa"
                            def={EMPRESAS_DEFS.empresa}
                            value={colFiltersEmpresas.empresa}
                            onChange={(v) => updateColFilterEmpresas('empresa', v)}
                            uniqueValues={obterValoresUnicos(data.por_empresa, (e) => e.label)}
                          />
                        </th>
                        <th className="text-right font-medium py-2 px-3">
                          <div className="flex justify-end">
                            <ColumnFilterHeader
                              title="Entradas"
                              def={EMPRESAS_DEFS.receita}
                              value={colFiltersEmpresas.receita}
                              onChange={(v) => updateColFilterEmpresas('receita', v)}
                            />
                          </div>
                        </th>
                        <th className="text-right font-medium py-2 px-3">
                          <div className="flex justify-end">
                            <ColumnFilterHeader
                              title="Saídas"
                              def={EMPRESAS_DEFS.despesas}
                              value={colFiltersEmpresas.despesas}
                              onChange={(v) => updateColFilterEmpresas('despesas', v)}
                            />
                          </div>
                        </th>
                        <th className="text-right font-medium py-2 px-3">
                          <div className="flex justify-end">
                            <ColumnFilterHeader
                              title="Resultado"
                              def={EMPRESAS_DEFS.resultado}
                              value={colFiltersEmpresas.resultado}
                              onChange={(v) => updateColFilterEmpresas('resultado', v)}
                            />
                          </div>
                        </th>
                        <th className="text-right font-medium py-2 px-3">
                          <div className="flex justify-end">
                            <ColumnFilterHeader
                              title="Margem"
                              def={EMPRESAS_DEFS.margem}
                              value={colFiltersEmpresas.margem}
                              onChange={(v) => updateColFilterEmpresas('margem', v)}
                            />
                          </div>
                        </th>
                        <th className="text-right font-medium py-2 px-3">
                          <div className="flex justify-end">
                            <ColumnFilterHeader
                              title="A pagar vencido"
                              def={EMPRESAS_DEFS.a_pagar_vencido}
                              value={colFiltersEmpresas.a_pagar_vencido}
                              onChange={(v) => updateColFilterEmpresas('a_pagar_vencido', v)}
                            />
                          </div>
                        </th>
                        <th className="text-right font-medium py-2 pl-3">
                          <div className="flex justify-end">
                            <ColumnFilterHeader
                              title="A receber vencido"
                              def={EMPRESAS_DEFS.a_receber_vencido}
                              value={colFiltersEmpresas.a_receber_vencido}
                              onChange={(v) => updateColFilterEmpresas('a_receber_vencido', v)}
                            />
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {empresasFiltradas.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-6 text-center text-xs text-muted-foreground">
                            Nenhuma empresa encontrada com os filtros aplicados.
                          </td>
                        </tr>
                      ) : (
                        empresasFiltradas.map((e) => (
                          <tr key={e.account_id} className="border-b border-border/50 last:border-0">
                            <td className="py-2 pr-3 font-medium">{e.label}</td>
                            <td className="py-2 px-3 text-right font-mono text-xs">{money(e.receita)}</td>
                            <td className="py-2 px-3 text-right font-mono text-xs">{money(e.despesa)}</td>
                            <td
                              className="py-2 px-3 text-right font-mono text-xs font-bold"
                              style={{ color: e.resultado_liquido < 0 ? palette.saida : palette.entrada }}
                            >
                              {money(e.resultado_liquido)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-xs">
                              {e.margem_liquida_pct === undefined || e.margem_liquida_pct === null ? '—' : percentage(e.margem_liquida_pct)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-xs">
                              {e.a_pagar_vencido === undefined ? '—' : money(e.a_pagar_vencido)}
                            </td>
                            <td className="py-2 pl-3 text-right font-mono text-xs">
                              {e.a_receber_vencido === undefined ? '—' : money(e.a_receber_vencido)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="panel p-5">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="flex items-center gap-3">
                    <div className="section-icon" style={{ backgroundColor: `${palette.saida}1a`, color: palette.saida }}>
                      <Wallet size={18} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold tracking-tight">Despesas por Categoria</h3>
                      <p className="text-xs text-muted-foreground">
                        Concentração top 3: {percentage(data.concentracao_despesas_top3_pct)}
                        {data.categoria_maior_alta && (
                          <> · Maior alta: <strong>{data.categoria_maior_alta.categoria_nome}</strong> (+{decimalPct(data.categoria_maior_alta.variacao_pct)})</>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
                <CategoryRankingChart entries={data.despesas_por_categoria} palette={palette} />
              </div>

              <div className="panel p-5">
                <div className="flex items-center gap-3 mb-1">
                  <div className="section-icon" style={{ backgroundColor: `${palette.entrada}1a`, color: palette.entrada }}>
                    <CircleDollarSign size={18} />
                  </div>
                  <h3 className="text-sm font-semibold tracking-tight">Receitas por Categoria</h3>
                </div>
                <CategoryRankingChart entries={data.receitas_por_categoria} palette={palette} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <AgingCard
                title="Contas a Pagar"
                icon={Wallet}
                aging={data.contas_a_pagar}
                chartLabel="Maiores fornecedores em aberto"
                accentColor={palette.saida}
              />
              <AgingCard
                title="Contas a Receber"
                icon={Landmark}
                aging={data.contas_a_receber}
                chartLabel="Maiores clientes em aberto"
                accentColor={palette.entrada}
              />
            </div>

            {data.forma_pagamento.length > 0 && (
              <div className="panel p-5">
                <div className="flex items-center gap-3 mb-1">
                  <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
                    <Banknote size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold tracking-tight">Despesas por Forma de Pagamento</h3>
                    <p className="text-xs text-muted-foreground">Contas pagas com vencimento no período selecionado</p>
                  </div>
                </div>
                <div className="h-52 w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={140}>
                    <ComposedChart
                      data={[...data.forma_pagamento].reverse()}
                      layout="vertical"
                      margin={{ top: 4, right: 74, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="currentColor" className="stroke-border/40" />
                      <XAxis
                        type="number"
                        tickFormatter={(v) => money(Number(v))}
                        tick={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
                        tickLine={false}
                        axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
                      />
                      <YAxis
                        type="category"
                        dataKey="marcador"
                        width={150}
                        tick={{ fill: 'currentColor', opacity: 0.75, fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: 'currentColor', opacity: 0.15 }}
                      />
                      <Tooltip
                        cursor={{ fill: 'currentColor', opacity: 0.05 }}
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null;
                          const row = payload[0].payload as { marcador: string; valor: number; percentual: number };
                          return (
                            <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
                              <p className="font-semibold text-popover-foreground">{row.marcador}</p>
                              <p className="font-mono text-popover-foreground">{money(row.valor)} ({percentage(row.percentual)})</p>
                            </div>
                          );
                        }}
                      />
                      <Bar
                        dataKey="valor"
                        maxBarSize={22}
                        shape={coloredBarShape<{ marcador: string; valor: number; percentual: number }>((p) => {
                          const idx = data.forma_pagamento.findIndex((f) => f.marcador === p.marcador);
                          return categoryColor(palette, idx);
                        }, [0, 4, 4, 0])}
                      >
                        <LabelList
                          dataKey="valor"
                          position="right"
                          formatter={(v) => money(Number(v))}
                          style={{ fill: 'currentColor', opacity: 0.85, fontSize: 10, fontFamily: 'monospace' }}
                        />
                      </Bar>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="panel p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
                  <TrendingUp size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold tracking-tight">Insights Financeiros</h3>
                  <p className="text-xs text-muted-foreground">
                    Comparativo automático entre o período selecionado e o período imediatamente anterior de mesma duração.
                  </p>
                </div>
              </div>
              {insights.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {insights.map((insight) => (
                    <InsightCard key={insight.id} insight={insight} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  Nada fora do padrão no período selecionado.
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmImpactDialog
        open={confirmForceSync}
        title="Forçar a sincronização do Dashboard Financeiro agora?"
        confirmLabel="Forçar sincronização"
        requireCheck="Entendo o risco"
        busy={syncing}
        onCancel={() => setConfirmForceSync(false)}
        onConfirm={() => void handleSync(true)}
      >
        <p>{FORCE_SYNC_RISK}</p>
      </ConfirmImpactDialog>
    </>
  );
}
