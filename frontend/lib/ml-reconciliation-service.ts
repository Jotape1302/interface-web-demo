import type {
  MlAnalise,
  MlAnalisesResponse,
  MlArquivoTipo,
  MlBaixaJob,
  MlExecucaoDetalhe,
  MlExecucaoJob,
  MlExecucoesResponse,
  MlExecutarPedido,
  MlJob,
  MlStatus,
  MlTokenSyncResponse,
} from './ml-reconciliation-contracts';
import { resolveApiBaseUrl } from './contracts';
import { JobLostError } from './reconciliation-helpers';
import { nomeDoArquivo } from './ml-reconciliation-helpers';
import { demoMlReconciliation } from './demo-ml-reconciliation';
import { demoDelay, isDemoSession } from './demo-session';
import { readApiError } from './api-errors';

// Chamadas curtas: execução e baixa rodam como tarefas no backend (acompanhadas por getJob).
const REQUEST_TIMEOUT_MS = 15000;
const ANALISE_TIMEOUT_MS = 30000;

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const token = localStorage.getItem('norvia_session_token');
    return token ? { Authorization: `Bearer ${token}`, 'x-session-token': token } : {};
  } catch {
    return {};
  }
}

// detail/error/message + erro_id/requestId — ver lib/api-errors.ts.
const errorMessage = readApiError;

function salvarArquivo(blob: Blob, nome: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class MlReconciliationService {
  constructor(private readonly baseUrl: string = '') {}

  private url(path: string): string {
    return `${(this.baseUrl || '').replace(/\/$/, '')}${path}`;
  }

  private signal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async getJson<T>(path: string, fallback: string, signal?: AbortSignal, ms = REQUEST_TIMEOUT_MS): Promise<T> {
    const res = await fetch(this.url(path), {
      headers: { Accept: 'application/json', ...getAuthHeaders() },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this.signal(signal, ms),
    });
    if (!res.ok) throw new Error(await errorMessage(res, fallback));
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown, fallback: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: this.signal(signal, REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(await errorMessage(res, fallback));
    return (await res.json()) as T;
  }

  /** Empresas (com as conexões), última e próxima execução, execução em andamento. */
  getStatus(signal?: AbortSignal): Promise<MlStatus> {
    return this.getJson('/api/ml-reconciliation/status', 'Falha ao consultar a conciliação', signal);
  }

  /** Força sincronização e renovação dos tokens do Mercado Livre via TMS / OAuth. */
  sincronizarTokens(signal?: AbortSignal): Promise<MlTokenSyncResponse> {
    return this.postJson<MlTokenSyncResponse>('/api/ml-reconciliation/tokens/sincronizar', {}, 'Falha ao sincronizar tokens do Mercado Livre', signal);
  }

  /** Executa agora (sem período: as liberações de ontem, como a rotina diária). */
  executar(pedido: MlExecutarPedido, signal?: AbortSignal): Promise<MlExecucaoJob> {
    return this.postJson('/api/ml-reconciliation/executar', pedido, 'Falha ao iniciar a conciliação', signal);
  }

  getExecucoes(limit = 30, signal?: AbortSignal): Promise<MlExecucoesResponse> {
    return this.getJson(`/api/ml-reconciliation/execucoes?limit=${limit}`, 'Falha ao consultar o histórico', signal);
  }

  getExecucao(id: string, signal?: AbortSignal): Promise<MlExecucaoDetalhe> {
    return this.getJson(`/api/ml-reconciliation/execucoes/${encodeURIComponent(id)}`, 'Falha ao consultar o log', signal);
  }

  getAnalises(empresa: string, limit = 30, signal?: AbortSignal): Promise<MlAnalisesResponse> {
    const qs = new URLSearchParams({ empresa, limit: String(limit) });
    return this.getJson(`/api/ml-reconciliation/analises?${qs}`, 'Falha ao consultar as análises', signal);
  }

  getAnalise(analiseId: string, signal?: AbortSignal): Promise<MlAnalise> {
    return this.getJson(
      `/api/ml-reconciliation/analises/${encodeURIComponent(analiseId)}`,
      'Falha ao consultar a análise',
      signal,
      ANALISE_TIMEOUT_MS,
    );
  }

  /** Dispara a baixa no Tiny dos recebimentos selecionados. */
  startBaixa(analiseId: string, grupos: string[], signal?: AbortSignal): Promise<MlBaixaJob> {
    return this.postJson('/api/ml-reconciliation/jobs/baixar', { analise_id: analiseId, grupos }, 'Falha ao iniciar a baixa no Tiny', signal);
  }

  /** Andamento de uma tarefa. 404 vira `JobLostError` (API reiniciada ou tarefa expirada). */
  async getJob(jobId: string, signal?: AbortSignal): Promise<MlJob> {
    const res = await fetch(this.url(`/api/ml-reconciliation/jobs/${encodeURIComponent(jobId)}`), {
      headers: { Accept: 'application/json', ...getAuthHeaders() },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this.signal(signal, REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) throw new JobLostError();
    if (!res.ok) throw new Error(await errorMessage(res, 'Falha ao consultar o andamento da tarefa'));
    return (await res.json()) as MlJob;
  }

  /**
   * Gera a planilha no backend e entrega ao navegador como download. Na planilha de lançamentos,
   * o que já foi exportado antes fica de fora (evita importar duas vezes no Tiny) — salvo com
   * `incluirExportados`. Devolve as contagens desse controle (só para "lancamentos").
   */
  async downloadArquivo(
    analiseId: string,
    tipo: MlArquivoTipo,
    opcoes: { incluirExportados?: boolean } = {},
  ): Promise<MlExportacaoLancamentos | null> {
    const query = opcoes.incluirExportados ? '?incluir_exportados=true' : '';
    const res = await fetch(
      this.url(`/api/ml-reconciliation/analises/${encodeURIComponent(analiseId)}/arquivos/${tipo}${query}`),
      {
        headers: getAuthHeaders(),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(60000),
      },
    );
    if (res.status === 409) throw new LancamentosJaExportadosError(await errorMessage(res, 'Lançamentos já exportados'));
    if (!res.ok) throw new Error(await errorMessage(res, 'Falha ao gerar a planilha'));
    salvarArquivo(await res.blob(), nomeDoArquivo(res.headers.get('content-disposition'), `${tipo}.xlsx`));
    const total = res.headers.get('x-lancamentos-total');
    if (total === null) return null;
    return {
      total: Number(total),
      jaExportados: Number(res.headers.get('x-lancamentos-ja-exportados') ?? 0),
      naPlanilha: Number(res.headers.get('x-lancamentos-na-planilha') ?? 0),
    };
  }
}

/** Contagens do controle de exportação da planilha de lançamentos de caixa. */
export interface MlExportacaoLancamentos {
  total: number;
  jaExportados: number;
  naPlanilha: number;
}

/** Todos os lançamentos da análise já saíram numa planilha anterior (HTTP 409). */
export class LancamentosJaExportadosError extends Error {}

/** Modo demonstração: mesmos métodos, com dados fictícios em memória (lib/demo-ml-reconciliation.ts). */
class DemoMlReconciliationService extends MlReconciliationService {
  getStatus() {
    return demoDelay(demoMlReconciliation.status());
  }

  sincronizarTokens(): Promise<MlTokenSyncResponse> {
    return demoDelay(
      {
        ok: true,
        mock: true,
        contas: {
          norvia: { conectado: true, renovado: true },
          revesta: { conectado: true, renovado: true },
        },
        tokens_atualizados: ['norvia', 'revesta'],
      },
      300,
    );
  }

  executar(pedido: MlExecutarPedido) {
    return demoDelay(demoMlReconciliation.executar(pedido), 400);
  }

  getExecucoes(limit = 30) {
    return demoDelay(demoMlReconciliation.execucoes(limit));
  }

  async getExecucao(id: string) {
    const execucao = await demoDelay(demoMlReconciliation.execucao(id));
    if (!execucao) throw new Error('Execução de demonstração não encontrada.');
    return execucao;
  }

  getAnalises(empresa: string, limit = 30) {
    return demoDelay(demoMlReconciliation.analises(empresa, limit));
  }

  async getAnalise(analiseId: string) {
    const analise = await demoDelay(demoMlReconciliation.analise(analiseId));
    if (!analise) throw new Error('Análise de demonstração não encontrada.');
    return analise;
  }

  async startBaixa(analiseId: string, grupos: string[]) {
    const job = await demoDelay(demoMlReconciliation.iniciarBaixa(analiseId, grupos));
    if (!job) throw new Error('Análise de demonstração não encontrada.');
    return job;
  }

  async getJob(jobId: string) {
    const job = await demoDelay(demoMlReconciliation.job(jobId), 150);
    if (!job) throw new JobLostError();
    return job;
  }

  async downloadArquivo(): Promise<MlExportacaoLancamentos | null> {
    throw new Error('Download de planilhas indisponível no modo demonstração.');
  }
}

export function createMlReconciliationService(apiBaseUrl?: string): MlReconciliationService {
  if (isDemoSession()) return new DemoMlReconciliationService();
  return new MlReconciliationService(resolveApiBaseUrl(apiBaseUrl));
}
