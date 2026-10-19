import type {
  BaixaHistoricoQuery,
  BaixaHistoricoResponse,
  BaixaItemInput,
  BaixaJob,
  PreviewJob,
  ReconciliationEstadoResponse,
  ReconciliationJob,
  ReconciliationStatusResponse,
} from './reconciliation-contracts';
import { resolveApiBaseUrl } from './contracts';
import { readApiError } from './api-errors';
import { JobLostError, buildHistoricoSearchParams } from './reconciliation-helpers';
import { demoReconciliation } from './demo-reconciliation';
import { demoDelay, isDemoSession } from './demo-session';

export interface PreviewRequestBody {
  empresa?: string;
  data_inicio?: string;
  data_fim?: string;
  tolerance_days?: number;
  // true ignora o cache do backend (15 min por filial/período) e consulta Inter/Tiny de novo.
  forcar_atualizacao?: boolean;
}

// Chamadas curtas: o trabalho pesado roda em segundo plano (job) no backend, então
// nenhuma requisição individual chega perto do timeout de ~60 s do NGINX.
const JOB_REQUEST_TIMEOUT_MS = 15000;

function getAuthHeaders(): Record<string, string> {
  if (typeof window !== 'undefined') {
    try {
      const token = localStorage.getItem('norvia_session_token');
      if (token) {
        return {
          Authorization: `Bearer ${token}`,
          'x-session-token': token,
        };
      }
    } catch {
      // ignore
    }
  }
  return {};
}

// Corpo de erro do gateway (`error`, `requestId`) ou repassado da automação (`detail`, `erro_id`).
const errorMessage = readApiError;

export class ReconciliationService {
  constructor(private readonly baseUrl: string = '') {}

  private getUrl(path: string): string {
    const cleanBase = (this.baseUrl || '').replace(/\/$/, '');
    return `${cleanBase}${path}`;
  }

  private withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async postJson<T>(path: string, body: unknown, fallbackError: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.getUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: this.withTimeout(signal, JOB_REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(await errorMessage(res, fallbackError));
    return (await res.json()) as T;
  }

  async getStatus(signal?: AbortSignal): Promise<ReconciliationStatusResponse> {
    const res = await fetch(this.getUrl('/api/reconciliation/status'), {
      signal: this.withTimeout(signal, 10000),
      headers: {
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(await errorMessage(res, 'Falha ao consultar status da conciliação'));

    return (await res.json()) as ReconciliationStatusResponse;
  }

  async getEstado(signal?: AbortSignal): Promise<ReconciliationEstadoResponse> {
    const res = await fetch(this.getUrl('/api/reconciliation/estado'), {
      signal: this.withTimeout(signal, 10000),
      headers: {
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(await errorMessage(res, 'Falha ao consultar estado da conciliação'));

    return (await res.json()) as ReconciliationEstadoResponse;
  }

  /** Dispara a comparação extrato × contas em segundo plano. */
  startPreviewJob(body: PreviewRequestBody, signal?: AbortSignal): Promise<PreviewJob> {
    return this.postJson<PreviewJob>(
      '/api/reconciliation/jobs/preview',
      body,
      'Falha ao iniciar a comparação de extrato e contas',
      signal,
    );
  }

  /** Dispara a baixa das contas no Tiny em segundo plano. */
  startBaixaJob(itens: BaixaItemInput[], signal?: AbortSignal): Promise<BaixaJob> {
    return this.postJson<BaixaJob>(
      '/api/reconciliation/jobs/baixar',
      { itens },
      'Falha ao iniciar a baixa no Tiny ERP',
      signal,
    );
  }

  /** Andamento de um job. 404 vira `JobLostError` (API reiniciada ou job expirado). */
  async getJob(jobId: string, signal?: AbortSignal): Promise<ReconciliationJob> {
    const res = await fetch(this.getUrl(`/api/reconciliation/jobs/${encodeURIComponent(jobId)}`), {
      signal: this.withTimeout(signal, JOB_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status === 404) throw new JobLostError();
    if (!res.ok) throw new Error(await errorMessage(res, 'Falha ao consultar o andamento da tarefa'));
    return (await res.json()) as ReconciliationJob;
  }

  async fetchBaixaHistorico(query: BaixaHistoricoQuery, signal?: AbortSignal): Promise<BaixaHistoricoResponse> {
    const qs = buildHistoricoSearchParams(query).toString();
    const res = await fetch(this.getUrl(`/api/reconciliation/historico${qs ? `?${qs}` : ''}`), {
      signal: this.withTimeout(signal, JOB_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(await errorMessage(res, 'Falha ao consultar o histórico de baixas'));

    const body = (await res.json()) as Partial<BaixaHistoricoResponse>;
    return {
      disponivel: body.disponivel !== false,
      itens: Array.isArray(body.itens) ? body.itens : [],
      total: typeof body.total === 'number' ? body.total : 0,
      page: typeof body.page === 'number' ? body.page : (query.page ?? 1),
      pageSize: typeof body.pageSize === 'number' ? body.pageSize : (query.pageSize ?? 50),
    };
  }
}

/** Modo demonstração: mesmos métodos, com dados fictícios em memória (lib/demo-reconciliation.ts). */
class DemoReconciliationService extends ReconciliationService {
  getStatus() {
    return demoDelay(demoReconciliation.status(), 600);
  }

  getEstado() {
    return demoDelay(demoReconciliation.estado(), 200);
  }

  startPreviewJob(body: PreviewRequestBody) {
    return demoDelay(demoReconciliation.iniciarPrevia(body));
  }

  startBaixaJob(itens: BaixaItemInput[]) {
    return demoDelay(demoReconciliation.iniciarBaixa(itens));
  }

  async getJob(jobId: string): Promise<ReconciliationJob> {
    const job = await demoDelay(demoReconciliation.job(jobId), 150);
    if (!job) throw new JobLostError();
    return job;
  }

  fetchBaixaHistorico(query: BaixaHistoricoQuery) {
    return demoDelay(demoReconciliation.historico(query));
  }
}

export function createReconciliationService(apiBaseUrl?: string): ReconciliationService {
  if (isDemoSession()) return new DemoReconciliationService();
  return new ReconciliationService(resolveApiBaseUrl(apiBaseUrl));
}
