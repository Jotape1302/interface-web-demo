import type { OverviewResponse, OverviewExecution } from './overview-contracts';
import type { DateRangeFilter } from './contracts';
import { isDateWithinFilter } from './date-range-utils';
export interface DailyExecutions { date: string; success: number | null; error: number | null; other: number | null }
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
export const brasiliaDay = (timestamp: string) => dayFormatter.format(new Date(timestamp));
export interface AggregateOverviewOptions {
  // Ambos aplicados client-side sobre a janela de 14 dias já buscada do backend (o
  // contrato de /api/overview é fixo em 14 dias) — não disparam nova consulta à API.
  automationId?: string;
  dateFilter?: DateRangeFilter;
}
export function aggregateOverview(data: OverviewResponse, options: AggregateOverviewOptions = {}) {
  const financialComplete = data.automations.every(automation => automation.dashboard.sources.database.status === 'ok' && automation.dashboard.metrics !== null);
  const financial = financialComplete ? data.automations.reduce((total, automation) => ({ estimatedSavings: total.estimatedSavings + automation.dashboard.metrics!.estimatedSavings, hoursSaved: total.hoursSaved + automation.dashboard.metrics!.hoursSaved, paidCount: total.paidCount + automation.dashboard.metrics!.paidCount }), { estimatedSavings: 0, hoursSaved: 0, paidCount: 0 }) : null;
  const history = data.history; const seen = new Set<string>(); let excluded = 0;
  const withinWindow = (execution: OverviewExecution) => execution.startedAt && Number.isFinite(Date.parse(execution.startedAt)) && Date.parse(execution.startedAt) >= Date.parse(history.from) && Date.parse(execution.startedAt) <= Date.parse(history.to);
  const executions = history.executions.filter(execution => { const key = `${execution.automationId}:${execution.id}`; if (seen.has(key)) return false; seen.add(key); if (!withinWindow(execution)) { excluded++; return false; } if (options.automationId && options.automationId !== 'all' && execution.automationId !== options.automationId) return false; if (options.dateFilter && !isDateWithinFilter(execution.startedAt, options.dateFilter)) return false; return true; });
  const success = executions.filter(execution => execution.status === 'success').length;
  const errors = executions.filter(execution => execution.status === 'error').length;
  const historyAvailable = history.error === null;
  const health = historyAvailable && success + errors > 0 ? success / (success + errors) * 100 : null;
  const complete = history.complete && excluded === 0;
  const days: DailyExecutions[] = [];
  const startDay = new Date(`${brasiliaDay(history.from)}T12:00:00Z`);
  for (let index = 0; index < 14; index++) {
    const day = new Date(startDay); day.setUTCDate(day.getUTCDate() + index); const date = day.toISOString().slice(0, 10);
    const observed = executions.filter(execution => brasiliaDay(execution.startedAt!) === date);
    const known = historyAvailable && (complete || observed.length > 0);
    days.push({ date, success: known ? observed.filter(execution => execution.status === 'success').length : null, error: known ? observed.filter(execution => execution.status === 'error').length : null, other: known ? observed.filter(execution => execution.status !== 'success' && execution.status !== 'error').length : null });
  }
  const distribution = data.automations.map(automation => ({ id: automation.id, title: automation.title, value: automation.dashboard.metrics?.paidCount ?? null, share: financial !== null && financial.paidCount > 0 && automation.dashboard.metrics !== null ? automation.dashboard.metrics.paidCount / financial.paidCount * 100 : null }));
  return { financial, financialComplete, contributing: data.automations.filter(automation => automation.dashboard.metrics !== null).length, health, historyAvailable, complete, excluded, success, errors, observed: executions.length, days, distribution };
}
