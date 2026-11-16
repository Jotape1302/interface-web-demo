'use client';

import { resolveApiBaseUrl } from './contracts';
import { isRealtimeConnected, subscribeRealtime } from './realtime';
import { readApiError } from './api-errors';
import type { AgentesQwenGrupo } from './agentes-qwen';

/** Automações com o botão "Reportar erro" (mesma lista de AUTOMACOES_REPORTAVEIS do gateway). */
export const REPORT_AUTOMATIONS = {
  'accounts-payable': 'Contas a Pagar',
  'inter-reconciliation': 'Conciliação Banco Inter',
  'ml-reconciliation': 'Conciliação Mercado Livre',
  'danfe-tiny': 'NF-e & DANFE',
  'financial-dashboard': 'Dashboards Financeiro',
  'stock-count': 'Contagem de estoque',
  'dimension-standardization': 'Padronização de dimensões',
  'shipping-review': 'Fretes a combinar',
} as const;

export type ReportAutomationId = keyof typeof REPORT_AUTOMATIONS;

/** Erro reportado numa aba; quem resolve são os agentes Qwen (aba Agentes Qwen). */
export interface ReportedIncident {
  id: string;
  /** O que falhou: execução, SKU, chave da NF-e, empresa... */
  executionId: string;
  automationId: ReportAutomationId;
  automationTitle: string;
  stoppedNode?: string;
  errorMessage: string;
  operatorNote?: string;
  reportedBy: string;
  userRole: string;
  reportedAt: string;
  status: 'pending' | 'resolved';
  /** Incidente dos agentes que recebeu o reporte (null: o PC dos agentes ainda não recebeu). */
  agentIncidentId: number | null;
  agentGroup: AgentesQwenGrupo | null;
  resolvedAt?: string;
}

export interface ReportInput {
  automationId: ReportAutomationId;
  executionId: string;
  errorMessage: string;
  stoppedNode?: string;
  operatorNote?: string;
}

const STORAGE_KEY = 'norvia_reported_incidents_v2';
const EVENT_NAME = 'norvia-incidents-updated';

/** Onde o reporte está, em palavras de quem reportou. */
export function reportStatusLabel(i: Pick<ReportedIncident, 'status' | 'agentGroup' | 'agentIncidentId'>): string {
  if (i.status === 'resolved' || i.agentGroup === 'resolvido') return 'Resolvido pelos agentes Qwen';
  switch (i.agentGroup) {
    case 'em_andamento':
      return `Em análise pelos agentes Qwen (#${i.agentIncidentId})`;
    case 'pr_pendente':
      return 'Correção proposta, aguardando aprovação do TI';
    case 'aguardando_deploy':
      return 'Correção aprovada, aguardando ir ao ar';
    case 'monitorando':
      return 'Correção no ar, acompanhando as próximas execuções';
    case 'precisa_ti':
      return 'Com o TI';
    default:
      return 'Enviado aos agentes Qwen';
  }
}

// ---------------------------------------------------------------------------
// Persistência: em produção os reportes vivem no gateway (MariaDB) e vão aos agentes Qwen pelo
// repasse do coletor. Em modo demo ficam no localStorage.
//
// A API síncrona (getReportedIncidents, findPendingReport) lê um cache em memória; enquanto houver
// alguém inscrito (subscribeToIncidents), o cache é atualizado pelo evento em tempo real
// "incidents" (lib/realtime.ts), com poll a cada POLL_MS (o andamento nos agentes muda sem evento).
// ---------------------------------------------------------------------------

const POLL_MS = 60_000;
const TOKEN_STORAGE_KEY = 'norvia_session_token';

let cache: ReportedIncident[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeRealtime: (() => void) | null = null;
let subscribers = 0;

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function isDemo(): boolean {
  return process.env.NEXT_PUBLIC_DATA_MODE === 'demo' || readToken() === 'mock-demo-token';
}

function apiUrl(path: string): string {
  return `${resolveApiBaseUrl().replace(/\/$/, '')}${path}`;
}

function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT_NAME));
}

function readDemoIncidents(): ReportedIncident[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as ReportedIncident[];
  } catch {
    return [];
  }
}

function writeDemoIncidents(incidents: ReportedIncident[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(incidents));
  } catch {
    /* ignore */
  }
  notify();
}

export function getReportedIncidents(): ReportedIncident[] {
  return isDemo() ? readDemoIncidents() : cache;
}

/** Reporte ainda aberto da mesma automação e referência (o botão vira o andamento). */
export function findPendingReport(automationId: ReportAutomationId, executionId: string): ReportedIncident | undefined {
  return getReportedIncidents().find((i) => i.automationId === automationId && i.executionId === executionId && i.status === 'pending');
}

/** Busca a lista atual no gateway e avisa os inscritos. Falha de rede mantém o cache anterior. */
export async function refreshIncidents(): Promise<void> {
  if (isDemo() || !readToken()) return;
  try {
    const res = await fetch(apiUrl('/api/incidents'), { headers: authHeaders() });
    if (!res.ok) return;
    cache = (await res.json()) as ReportedIncident[];
    notify();
  } catch {
    // mantém o cache anterior
  }
}

export async function reportIncident(input: ReportInput, demoReporter = 'Operador (demo)'): Promise<ReportedIncident> {
  if (isDemo()) {
    const incidents = readDemoIncidents();
    const existing = incidents.find((i) => i.automationId === input.automationId && i.executionId === input.executionId && i.status === 'pending');
    const novo: ReportedIncident = {
      ...input,
      id: existing?.id ?? `demo-${Date.now()}`,
      automationTitle: REPORT_AUTOMATIONS[input.automationId],
      reportedBy: demoReporter,
      userRole: 'demo',
      reportedAt: new Date().toISOString(),
      status: 'pending',
      agentIncidentId: 1,
      agentGroup: 'em_andamento',
    };
    writeDemoIncidents([novo, ...incidents.filter((i) => i.id !== novo.id)]);
    return novo;
  }

  // Quem reportou é definido pelo gateway a partir da sessão — não é enviado.
  const res = await fetch(apiUrl('/api/incidents'), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res, 'Falha ao reportar o erro'));
  const body = (await res.json().catch(() => null)) as ReportedIncident | null;
  if (!body) throw new Error('Resposta inválida do servidor ao reportar o erro.');
  cache = [body, ...cache.filter((i) => i.id !== body.id)];
  notify();
  return body;
}

export function subscribeToIncidents(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener('storage', callback);
  subscribers++;
  if (subscribers === 1 && !isDemo()) {
    void refreshIncidents();
    // Evento em tempo real quando alguém reporta; o poll acompanha o andamento nos agentes.
    unsubscribeRealtime = subscribeRealtime(['incidents', 'reconnected'], () => void refreshIncidents());
    pollTimer = setInterval(() => {
      if (!isRealtimeConnected() || document.visibilityState === 'visible') void refreshIncidents();
    }, POLL_MS);
  }
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener('storage', callback);
    subscribers--;
    if (subscribers === 0) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      unsubscribeRealtime?.();
      unsubscribeRealtime = null;
    }
  };
}
