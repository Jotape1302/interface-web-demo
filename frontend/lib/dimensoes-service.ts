import { resolveApiBaseUrl } from './contracts';
import { demoDimensoes } from './demo-marketplace';
import { demoDelay, isDemoSession } from './demo-session';
import type { AnuncioSemSku, DimensoesStatus, ProdutosPage } from './dimensoes-contracts';
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

export interface FiltroProdutos {
  status?: string;
  envio?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ResultadoConfirmacao {
  aceitos: string[];
  recusados: string[];
}

export class DimensoesService {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/marketplace/dimensoes${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiErrorMessage(body, res.status, 'Falha na padronização de dimensões'));
    // 200 sem JSON: resposta cortada (ex.: serviço reiniciando no deploy).
    if (body === null) throw new Error('Resposta incompleta do serviço (pode estar reiniciando). Clique em Atualizar.');
    return body as T;
  }

  status(signal?: AbortSignal): Promise<DimensoesStatus> {
    return this.request('/status', { signal });
  }

  produtos(f: FiltroProdutos, signal?: AbortSignal): Promise<ProdutosPage> {
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.envio) qs.set('envio', f.envio);
    if (f.q) qs.set('q', f.q);
    qs.set('page', String(f.page ?? 1));
    qs.set('page_size', String(f.pageSize ?? 30));
    return this.request(`/produtos?${qs}`, { signal });
  }

  semSku(signal?: AbortSignal): Promise<{ itens: AnuncioSemSku[]; total: number }> {
    return this.request('/sem-sku', { signal });
  }

  /** Confirma o envio ao ML das medidas do Tiny; o envio segue em segundo plano. */
  validar(skus: string[]): Promise<ResultadoConfirmacao> {
    return this.request('/validar', { method: 'POST', body: JSON.stringify({ skus }) }, 60000);
  }

  reenviar(skus: string[]): Promise<ResultadoConfirmacao> {
    return this.request('/reenviar', { method: 'POST', body: JSON.stringify({ skus }) });
  }

  executar(): Promise<{ status: string }> {
    return this.request('/executar', { method: 'POST', body: '{}' });
  }
}

/** Modo demonstração: mesmos métodos, com dados fictícios em memória (lib/demo-marketplace.ts). */
class DemoDimensoesService extends DimensoesService {
  status() { return demoDelay(demoDimensoes.status()); }
  produtos(f: FiltroProdutos) { return demoDelay(demoDimensoes.produtos(f)); }
  semSku() { return demoDelay(demoDimensoes.semSku()); }
  validar(skus: string[]) { return demoDelay(demoDimensoes.validar(skus), 900); }
  reenviar(skus: string[]) { return demoDelay(demoDimensoes.reenviar(skus)); }
  executar() { return demoDelay(demoDimensoes.executar()); }
}

export function createDimensoesService(apiBaseUrl?: string): DimensoesService {
  if (isDemoSession()) return new DemoDimensoesService('');
  return new DimensoesService(resolveApiBaseUrl(apiBaseUrl));
}
