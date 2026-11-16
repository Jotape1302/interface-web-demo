import { apiErrorMessage } from './api-errors';
import type { AreaComVisaoGeral } from './areas';
import type { VisaoGeralArea } from './area-overview-contracts';
import { resolveApiBaseUrl } from './contracts';
import { makeDemoVisaoGeral } from './demo-area-overview';
import { demoDelay, isDemoSession } from './demo-session';

function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const token = localStorage.getItem('norvia_session_token');
    return token ? { Authorization: `Bearer ${token}`, 'x-session-token': token } : {};
  } catch {
    return {};
  }
}

export async function fetchVisaoGeral(area: AreaComVisaoGeral, signal?: AbortSignal): Promise<VisaoGeralArea> {
  if (isDemoSession()) return demoDelay(makeDemoVisaoGeral(area, new Date().toISOString()));
  const base = resolveApiBaseUrl().replace(/\/$/, '');
  const res = await fetch(`${base}/api/areas/${area}/visao-geral`, {
    headers: { Accept: 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(apiErrorMessage(body, res.status, 'Não foi possível carregar a visão geral'));
  return normalizarVisaoGeral(body, area);
}

/** Tolera campos ausentes na resposta, para a tela nunca quebrar por lista indefinida. */
export function normalizarVisaoGeral(body: unknown, area: AreaComVisaoGeral): VisaoGeralArea {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<VisaoGeralArea>;
  return {
    area,
    geradoEm: typeof b.geradoEm === 'string' ? b.geradoEm : new Date().toISOString(),
    acoesPendentes: Array.isArray(b.acoesPendentes) ? b.acoesPendentes : [],
    automacoes: Array.isArray(b.automacoes) ? b.automacoes : [],
    servicos: Array.isArray(b.servicos) ? b.servicos : [],
    indisponiveis: Array.isArray(b.indisponiveis) ? b.indisponiveis : [],
  };
}
