import { resolveApiBaseUrl } from './contracts';
import { demoDimensoes } from './demo-marketplace';
import { demoDelay, isDemoSession } from './demo-session';
import type { AnuncioSemSku, DimensoesStatus, ProdutosPage } from './dimensoes-contracts';
import type { Medidas } from './fretes-contracts';
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
  confiabilidade?: string;
  envio?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export class DimensoesService {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/marketplace/dimensoes${path}`, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(), ...init.headers },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(apiErrorMessage(body, res.status, 'Falha na padronização de dimensões'));
    return body as T;
  }

  status(): Promise<DimensoesStatus> {
    return this.request('/status');
  }

  produtos(f: FiltroProdutos): Promise<ProdutosPage> {
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.confiabilidade) qs.set('confiabilidade', f.confiabilidade);
    if (f.envio) qs.set('envio', f.envio);
    if (f.q) qs.set('q', f.q);
    qs.set('page', String(f.page ?? 1));
    qs.set('page_size', String(f.pageSize ?? 30));
    return this.request(`/produtos?${qs}`);
  }

  semSku(): Promise<{ itens: AnuncioSemSku[]; total: number }> {
    return this.request('/sem-sku');
  }

  /** Grava em dimensoes_produtos; o envio às plataformas segue em segundo plano. */
  validar(produtos: Array<{ sku: string } & Medidas>): Promise<{ gravados: string[]; recusados: string[] }> {
    return this.request('/validar', { method: 'POST', body: JSON.stringify({ produtos }) }, 60000);
  }

  reenviar(skus: string[]): Promise<{ status: string; total: number }> {
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
  validar(produtos: Array<{ sku: string } & Medidas>) { return demoDelay(demoDimensoes.validar(produtos), 900); }
  reenviar(skus: string[]) { return demoDelay(demoDimensoes.reenviar(skus)); }
  executar() { return demoDelay(demoDimensoes.executar()); }
}

export function createDimensoesService(apiBaseUrl?: string): DimensoesService {
  if (isDemoSession()) return new DemoDimensoesService('');
  return new DimensoesService(resolveApiBaseUrl(apiBaseUrl));
}
