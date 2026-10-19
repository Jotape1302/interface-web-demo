import type { DashboardConfig } from './contracts';
import { parseDashboard, parseExecution } from './dashboard-service';
import { makeDemoDashboard, makeDemoDanfeDashboard } from './demo';
import type { OverviewResponse, OverviewService, OverviewServiceStatus, OverviewExecution } from './overview-contracts';
const fail = (): never => { throw new Error('A API retornou dados incompatíveis com a visão geral.'); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown): string => typeof value === 'string' ? value : fail();
const timestamp = (value: unknown): string => typeof value === 'string' && /T.*(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : fail();
export function parseOverview(value: unknown): OverviewResponse {
  const data = object(value); const history = object(data.history);
  if ((data.mode !== 'demo' && data.mode !== 'live') || !Array.isArray(data.automations) || !Array.isArray(data.services) || !Array.isArray(history.executions) || history.days !== 14 || typeof history.complete !== 'boolean' || !(history.error === null || typeof history.error === 'string')) return fail();
  const automations = data.automations.map(value => { const row = object(value); const dashboard = parseDashboard(row.dashboard); if (dashboard.mode !== data.mode) return fail(); const href = text(row.href); if (!/^\/[a-z0-9/-]*$/.test(href) || href.startsWith('//')) return fail(); return { id: text(row.id), title: text(row.title), href, dashboard }; });
  if (new Set(automations.map(row => row.id)).size !== automations.length) return fail();
  const from = timestamp(history.from); const to = timestamp(history.to); if (Date.parse(from) >= Date.parse(to)) return fail();
  const executions: OverviewExecution[] = history.executions.map(value => { const row = object(value); const automationId = text(row.automationId); if (!automations.some(automation => automation.id === automationId)) return fail(); return { ...parseExecution(row), automationId }; });
  const services: OverviewServiceStatus[] = data.services.map(value => { const row = object(value); if (!['mariadb', 'n8n', 'tiny', 'inter'].includes(text(row.id)) || !['connected', 'error', 'unverified', 'demo'].includes(text(row.status))) return fail(); if (data.mode === 'live' && row.status === 'demo') return fail(); return { id: row.id as OverviewServiceStatus['id'], name: text(row.name), status: row.status as OverviewServiceStatus['status'], message: text(row.message) }; });
  if (services.length !== 4 || new Set(services.map(row => row.id)).size !== 4) return fail();
  return { mode: data.mode, generatedAt: timestamp(data.generatedAt), automations, history: { days: 14, from, to, complete: history.complete, executions, error: history.error }, services };
}
export function makeDemoOverview(now = new Date()): OverviewResponse {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(`${date}T00:00:00-03:00`); start.setUTCDate(start.getUTCDate() - 13);
  const executions: OverviewExecution[] = [];
  for (let index = 0; index < 106; index++) {
    const day = index % 14; const ordinal = Math.floor(index / 14);
    const dayStart = start.getTime() + day * 86400000;
    const dayEnd = Math.min(dayStart + 86400000, now.getTime());
    const started = new Date(dayStart + (dayEnd - dayStart) * ((ordinal + 1) / 9));
    const status = index < 90 ? 'success' : index < 100 ? 'error' : index < 103 ? 'waiting' : index < 105 ? 'running' : 'unknown';
    executions.push({ automationId: 'accounts-payable', id: `DEMO-HIST-${index}`, startedAt: started.toISOString(), stoppedAt: status === 'success' || status === 'error' ? new Date(Math.min(started.getTime() + 24000, now.getTime())).toISOString() : null, durationMs: status === 'success' || status === 'error' ? Math.min(24000, now.getTime() - started.getTime()) : null, status, stoppedNode: status === 'error' ? 'Consultar título no Inter' : null });
  }
  return { mode: 'demo', generatedAt: now.toISOString(), automations: [{ id: 'accounts-payable', title: 'Contas a Pagar', href: '/contas-a-pagar', dashboard: makeDemoDashboard(now.toISOString()) }, { id: 'danfe-tiny', title: 'NF-e & DANFE', href: '/danfe-tiny', dashboard: makeDemoDanfeDashboard(now.toISOString()) }], history: { days: 14, from: start.toISOString(), to: now.toISOString(), complete: true, executions, error: null }, services: [ { id: 'mariadb', name: 'MariaDB', status: 'demo', message: 'Dados de negócio simulados.' }, { id: 'n8n', name: 'n8n', status: 'demo', message: 'Histórico técnico fictício de 14 dias.' }, { id: 'tiny', name: 'Tiny ERP', status: 'demo', message: 'Sem conexão externa na demonstração.' }, { id: 'inter', name: 'Banco Inter', status: 'demo', message: 'Nenhuma operação bancária é realizada.' } ] };
}
export class MockOverviewService implements OverviewService { async getOverview(signal?: AbortSignal) { signal?.throwIfAborted(); return parseOverview(makeDemoOverview()); } }
export class HttpOverviewService implements OverviewService {
  private readonly fetcher: typeof fetch;
  constructor(private readonly baseUrl = '', fetcher: typeof fetch = fetch) {
    this.fetcher = (input: RequestInfo | URL, init?: RequestInit) => Reflect.apply(fetcher, globalThis, [input, init]);
  }
  async getOverview(signal?: AbortSignal) { const timeout = AbortSignal.timeout(20000); const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/api/overview`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Acesso não autorizado. Verifique sua sessão e a configuração da API.' : await readApiError(response, 'Não foi possível consultar a visão geral')); const data = parseOverview(await response.json()); if (data.mode !== 'live') throw new Error('O modo conectado recebeu uma resposta demonstrativa. Verifique a configuração da API.'); return data; }
}
import { resolveApiBaseUrl } from './contracts';
import { readApiError } from './api-errors';
export const createOverviewService = (config: DashboardConfig): OverviewService => config.mode === 'demo' ? new MockOverviewService() : new HttpOverviewService(resolveApiBaseUrl(config.apiBaseUrl));
