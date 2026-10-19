import { resolveApiBaseUrl } from './contracts';
import type { AnuncioFrete, AnunciosPage, FretesStatus, HistoricoFretes, Medidas } from './fretes-contracts';
import { demoFretes } from './demo-marketplace';
import { demoDelay, isDemoSession } from './demo-session';
import { apiErrorMessage } from './api-errors';

function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const token = localStorage.getItem('norvia_session_token');
    return token ? { Authorization: `Bearer ${token}`, 'x-session-token': token } : {};
  } catch {
    return {};
  }
}

export class FretesService {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/marketplace/fretes${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(), ...init.headers },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(apiErrorMessage(body, res.status, 'Falha na automação de fretes'));
    return body as T;
  }

  status(): Promise<FretesStatus> {
    return this.request('/status');
  }

  anuncios(params: {
    q?: string;
    filial?: string;
    situacao?: string;
    modo?: string;
    bloqueio?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AnunciosPage> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.filial) qs.set('filial', params.filial);
    if (params.situacao) qs.set('situacao', params.situacao);
    if (params.modo) qs.set('modo', params.modo);
    if (params.bloqueio) qs.set('bloqueio', params.bloqueio);
    qs.set('page', String(params.page ?? 1));
    qs.set('page_size', String(params.pageSize ?? 50));
    return this.request(`/anuncios?${qs}`);
  }

  desfeitos(): Promise<{ itens: AnuncioFrete[]; total: number }> {
    return this.request('/desfeitos');
  }

  /** Nova tentativa em segundo plano; o resultado aparece no histórico e na conferência. */
  retentar(anuncios: Array<Pick<AnuncioFrete, 'filial' | 'mlb'>>): Promise<{ status: string; total: number }> {
    return this.request('/retentar', {
      method: 'POST',
      body: JSON.stringify({ anuncios: anuncios.map((a) => ({ filial: a.filial, mlb: a.mlb })) }),
    });
  }

  historico(status = ''): Promise<HistoricoFretes> {
    return this.request(`/historico${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  }

  executar(): Promise<{ status: string }> {
    return this.request('/executar', { method: 'POST', body: '{}' });
  }
}

/** Modo demonstração: mesmos métodos, com dados fictícios em memória (lib/demo-marketplace.ts). */
class DemoFretesService extends FretesService {
  status() { return demoDelay(demoFretes.status()); }
  anuncios(params: Parameters<FretesService['anuncios']>[0]) { return demoDelay(demoFretes.anuncios(params)); }
  desfeitos() { return demoDelay(demoFretes.desfeitos()); }
  retentar(anuncios: Array<Pick<AnuncioFrete, 'filial' | 'mlb'>>) { return demoDelay(demoFretes.retentar(anuncios)); }
  historico(status = '') { return demoDelay(demoFretes.historico(status)); }
  executar() { return demoDelay(demoFretes.executar()); }
}

export function createFretesService(apiBaseUrl?: string): FretesService {
  if (isDemoSession()) return new DemoFretesService('');
  return new FretesService(resolveApiBaseUrl(apiBaseUrl));
}
