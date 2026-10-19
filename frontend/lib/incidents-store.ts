'use client';

import { resolveApiBaseUrl } from './contracts';
import { isRealtimeConnected, subscribeRealtime } from './realtime';
import { readApiError } from './api-errors';

export interface ReportedIncident {
  id: string;
  executionId: string;
  automationId: 'accounts-payable' | 'danfe-tiny';
  automationTitle: string;
  stoppedNode?: string;
  reportedBy: string;
  userRole: string;
  reportedAt: string;
  status: 'pending' | 'resolved';
  diagnosticExplanation: string;
  recommendedAction: string;
  operatorNote?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

const STORAGE_KEY = 'norvia_reported_incidents_v1';
const EVENT_NAME = 'norvia-incidents-updated';

/**
 * Banco de conhecimento de diagnósticos assertivos por nó de automação.
 * Permite que o administrador saiba exatamente a causa e a ação de resolução.
 */
export function getIncidentDiagnostic(
  automationId: 'accounts-payable' | 'danfe-tiny',
  stoppedNode?: string
): { diagnostic: string; action: string } {
  const node = (stoppedNode || '').toLowerCase();

  if (node.includes('inter') || node.includes('banco') || node.includes('titulo')) {
    return {
      diagnostic:
        'Falha de comunicação ou timeout com a API do Banco Inter ao consultar liquidação da remessa de pagamento. Possível expiração do certificado digital mTLS ou instabilidade temporária no gateway bancário.',
      action:
        '1. Verifique a validade do certificado digital e credenciais do Banco Inter no n8n. 2. Teste o endpoint bancário via painel do Gateway. 3. Re-execute o lote para conciliar os títulos pendentes.',
    };
  }

  if (node.includes('barra') || node.includes('código') || node.includes('febraban') || node.includes('barcode')) {
    return {
      diagnostic:
        'Boleto rejeitado na validação de linha digitável FEBRABAN. O dígito verificador geral é inconsistente ou a linha digitável foi corrompida durante a leitura ótica/OCR.',
      action:
        '1. Abra a conta a pagar no Tiny ERP e confira o código de barras físico do documento. 2. Se necessário, solicite 2ª via atualizada ao fornecedor ou realize a liquidação via chave PIX.',
    };
  }

  if (node.includes('tiny') || node.includes('erp') || node.includes('contas a pagar')) {
    return {
      diagnostic:
        'Rejeição da API do Tiny ERP (V3). O token de acesso OAuth pode ter expirado ou o cadastro do fornecedor possui divergência de CNPJ/Inscrição Estadual no ERP.',
      action:
        '1. Verifique o status da conexão OAuth do Tiny no Gateway de Automações. 2. Acesse o ERP Tiny e valide se o fornecedor possui cadastro ativo e conta contábil vinculada.',
    };
  }

  if (node.includes('sefaz') || node.includes('nsu') || node.includes('certificado')) {
    return {
      diagnostic:
        'Falha na varredura direta contra a SEFAZ (NFeDistribuicaoDFe). O certificado digital A1 do CNPJ pode estar vencido/com senha incorreta, ou o webservice nacional está indisponível.',
      action:
        '1. Confira a validade e a senha do certificado A1 do CNPJ afetado. 2. Tente rodar a varredura novamente pelo botão "Rodar agora" na tela de NF-e & DANFE.',
    };
  }

  if (node.includes('scanner') || node.includes('ocr')) {
    return {
      diagnostic:
        'Falha na extração de texto ou chave de acesso da DANFE enviada manualmente. O arquivo pode estar corrompido, em resolução insuficiente (< 300 DPI) ou sem código de barras legível.',
      action:
        '1. Verifique o arquivo original enviado. 2. Refaça o upload manual na tela de NF-e & DANFE com um PDF de alta resolução ou insira a chave de 44 dígitos.',
    };
  }

  return {
    diagnostic: `Interrupção técnica no fluxo automatizado durante a execução do nó "${stoppedNode || 'Não especificado'}". Parâmetros de entrada inválidos ou falha de rede temporária.`,
    action:
      '1. Inspecione os logs de telemetria desta execução no n8n/Gateway. 2. Confirme os dados da fatura/documento e execute novamente a automação.',
  };
}

/**
 * Fixtures iniciais de demonstração (caso o storage esteja vazio)
 */
const DEFAULT_DEMO_INCIDENTS: ReportedIncident[] = [
  {
    id: 'inc-demo-01',
    executionId: 'DEMO-2944',
    automationId: 'accounts-payable',
    automationTitle: 'Contas a Pagar',
    stoppedNode: 'Consultar título no Inter',
    reportedBy: 'Operador Financeiro',
    userRole: 'financeiro',
    reportedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    status: 'pending',
    diagnosticExplanation:
      'Falha de comunicação ou timeout com a API do Banco Inter ao consultar liquidação da remessa de pagamento. Possível expiração do certificado digital mTLS ou instabilidade temporária no gateway bancário.',
    recommendedAction:
      '1. Verifique a validade do certificado digital e credenciais do Banco Inter no n8n. 2. Teste o endpoint bancário via painel do Gateway. 3. Re-execute o lote para conciliar os títulos pendentes.',
    operatorNote: 'Lote das 13:57 não sincronizou o status dos boletos de informática no Inter.',
  },
];

// ---------------------------------------------------------------------------
// Persistência: em produção os incidentes vivem no gateway (MariaDB) — antes ficavam só
// no localStorage de quem reportava, então o admin nunca via o reporte feito em outra
// máquina. Em modo demo continua no localStorage, com a fixture acima.
//
// A API síncrona (getReportedIncidents, isExecutionReported, getPendingIncidentsCount)
// lê um cache em memória; enquanto houver alguém inscrito (subscribeToIncidents), o
// cache é atualizado pelo evento em tempo real "incidents" (lib/realtime.ts), com poll a
// cada POLL_MS só enquanto o canal estiver desconectado.
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
  if (typeof window === 'undefined') return DEFAULT_DEMO_INCIDENTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DEMO_INCIDENTS));
      return DEFAULT_DEMO_INCIDENTS;
    }
    return JSON.parse(raw) as ReportedIncident[];
  } catch {
    return DEFAULT_DEMO_INCIDENTS;
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

export async function reportIncident(
  incident: Omit<ReportedIncident, 'id' | 'reportedAt' | 'status' | 'reportedBy' | 'userRole'> & {
    reportedBy?: string;
    userRole?: string;
  },
): Promise<ReportedIncident> {
  if (isDemo()) {
    const incidents = readDemoIncidents();
    const newIncident: ReportedIncident = {
      ...incident,
      reportedBy: incident.reportedBy ?? 'Operador Local',
      userRole: incident.userRole ?? 'operador',
      id: `inc-${Date.now()}`,
      reportedAt: new Date().toISOString(),
      status: 'pending',
    };
    // Se já existe um reporte pendente para a mesma execução, atualiza
    const existingIdx = incidents.findIndex((i) => i.executionId === incident.executionId);
    if (existingIdx >= 0) incidents[existingIdx] = newIncident;
    else incidents.unshift(newIncident);
    writeDemoIncidents(incidents);
    return newIncident;
  }

  // Quem reportou é definido pelo gateway a partir da sessão — não é enviado.
  const { reportedBy: _reportedBy, userRole: _userRole, ...payload } = incident;
  const res = await fetch(apiUrl('/api/incidents'), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await readApiError(res, 'Falha ao reportar incidente'));
  const body = (await res.json().catch(() => null)) as ReportedIncident | null;
  if (!body) throw new Error('Resposta inválida do servidor ao reportar incidente.');
  cache = [body, ...cache.filter((i) => i.id !== body.id)];
  notify();
  return body;
}

export async function resolveIncident(incidentId: string, resolvedBy: string): Promise<void> {
  if (isDemo()) {
    writeDemoIncidents(
      readDemoIncidents().map((inc) =>
        inc.id === incidentId
          ? { ...inc, status: 'resolved' as const, resolvedAt: new Date().toISOString(), resolvedBy }
          : inc,
      ),
    );
    return;
  }
  const res = await fetch(apiUrl(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`), {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, 'Falha ao resolver incidente'));
  }
  await refreshIncidents();
}

export function isExecutionReported(executionId: string): boolean {
  return getReportedIncidents().some((i) => i.executionId === executionId && i.status === 'pending');
}

export function getPendingIncidentsCount(): number {
  return getReportedIncidents().filter((i) => i.status === 'pending').length;
}

export function subscribeToIncidents(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener('storage', callback);
  subscribers++;
  if (subscribers === 1 && !isDemo()) {
    void refreshIncidents();
    // Evento em tempo real quando alguém reporta/resolve; o poll é só fallback.
    unsubscribeRealtime = subscribeRealtime(['incidents', 'reconnected'], () => void refreshIncidents());
    pollTimer = setInterval(() => {
      if (!isRealtimeConnected()) void refreshIncidents();
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
