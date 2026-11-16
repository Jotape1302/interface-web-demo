import type {
  DdaBoleto,
  DdaCategoria,
  DdaCriarContaItem,
  DdaCriarContasResultado,
  DdaExecucao,
  DdaJob,
  DdaStatus,
  DdaValidarResultado,
} from './dda-contracts';
import { readApiError } from './api-errors';
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

const DEMO_STATUS: DdaStatus = {
  configurado: true, ativo: true, agendar_no_inter: true, intervalo_minutos: 30, em_execucao: false,
  cadastros: [
    { empresa: 'revesta', nome: 'Revesta', ativo: true, status_label: 'Sucesso' },
    { empresa: 'norvia_campinas', nome: 'Norvia Campinas', ativo: true, status_label: 'Sucesso' },
  ],
  por_situacao: { SEM_CONTA: 1, AGENDADO: 1, BAIXADO: 1 },
  ultima_execucao: null,
};
const DEMO_BOLETOS: DdaBoleto[] = [
  { id: 'demo-1', empresa: 'revesta', situacao: 'SEM_CONTA', mensagem: 'Nenhuma conta a pagar em aberto no Tiny com o mesmo fornecedor, vencimento e valor.',
    beneficiario_nome: 'Transportadora Exemplo Ltda', beneficiario_cnpj: '11222333000181', valor: '842.30', vencimento: '2026-11-25', documento: '4471' },
  { id: 'demo-4', empresa: 'fabrilux', situacao: 'CASADO', mensagem: 'Casado com a conta a pagar do Tiny (fornecedor, vencimento e valor). Conta #789.',
    beneficiario_nome: 'Distribuidora Exemplo Ltda', beneficiario_cnpj: '22333444000155', valor: '1290.00', vencimento: '2026-11-28', documento: '1180/1',
    conta_id: 789, conta: { id: 789, fornecedor: 'DISTRIBUIDORA EXEMPLO LTDA', historico: 'NF 1180 - parcela 1/3', numero_documento: '1180/1', valor: '1290.00', vencimento: '2026-11-28' } },
  { id: 'demo-2', empresa: 'norvia_campinas', situacao: 'AGENDADO', mensagem: 'Agendado no Inter para 22/11/2026, aguardando aprovação.',
    beneficiario_nome: 'Embalagens Modelo SA', beneficiario_cnpj: '99888777000166', valor: '3150.00', vencimento: '2026-11-22', conta_id: 123,
    inter: { codigo_transacao: 'demo', status: 'AGUARDANDO_APROVACAO', aprovacoes_necessarias: 1, aprovacoes_realizadas: 0 } },
  { id: 'demo-3', empresa: 'revesta', situacao: 'BAIXADO', mensagem: 'Conta #456 baixada no Tiny (R$ 199.90).',
    beneficiario_nome: 'Energia Exemplo', beneficiario_cnpj: '55444333000122', valor: '199.90', vencimento: '2026-11-14', conta_id: 456 },
];

export class DdaService {
  constructor(private readonly baseUrl = '') {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async get<T>(path: string, fallback: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url(path), {
      headers: { Accept: 'application/json', ...authHeaders() },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(await readApiError(res, fallback));
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown, fallback: string): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(65000),
    });
    if (!res.ok) throw new Error(await readApiError(res, fallback));
    return (await res.json()) as T;
  }

  status(signal?: AbortSignal): Promise<DdaStatus> {
    if (isDemoSession()) return demoDelay(DEMO_STATUS);
    return this.get('/api/dda/status', 'Falha ao consultar a automação de boletos DDA', signal);
  }

  async boletos(signal?: AbortSignal): Promise<DdaBoleto[]> {
    if (isDemoSession()) return demoDelay(DEMO_BOLETOS);
    return (await this.get<{ itens: DdaBoleto[] }>('/api/dda/boletos', 'Falha ao listar os boletos DDA', signal)).itens;
  }

  async execucoes(signal?: AbortSignal): Promise<DdaExecucao[]> {
    if (isDemoSession()) return demoDelay([]);
    return (await this.get<{ itens: DdaExecucao[] }>('/api/dda/execucoes', 'Falha ao listar as rodadas do DDA', signal)).itens;
  }

  async categorias(empresa: string): Promise<DdaCategoria[]> {
    if (isDemoSession()) return demoDelay([{ id: '1', nome: 'Fretes', grupo: 'Despesas' }]);
    const q = new URLSearchParams({ empresa });
    return (await this.get<{ itens: DdaCategoria[] }>(`/api/dda/categorias?${q}`, 'Falha ao listar as categorias do Tiny')).itens;
  }

  /** Acompanha uma tarefa do motor até o fim (consulta a cada 3 s, até 20 min). */
  private async esperarJob<R>(jobId: string, onTick?: (job: DdaJob<R>) => void): Promise<DdaJob<R>> {
    for (let i = 0; i < 400; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await this.get<DdaJob<R>>(`/api/dda/jobs/${encodeURIComponent(jobId)}`, 'Falha ao acompanhar a tarefa do DDA');
      onTick?.(job);
      if (job.status !== 'executando') return job;
    }
    throw new Error('A tarefa do DDA passou de 20 minutos; confira o resultado mais tarde.');
  }

  /** Inicia a rodada e espera o fim (a rodada roda em segundo plano no motor). */
  async executar(): Promise<DdaJob> {
    if (isDemoSession()) return demoDelay({ status: 'concluido', resultado: { origem: 'manual', inicio: '', erros: [] } }, 900);
    const { job_id } = await this.post<{ job_id: string }>('/api/dda/executar', {}, 'Falha ao iniciar a rotina do DDA');
    return this.esperarJob<DdaExecucao>(job_id);
  }

  /** Validação humana dos casamentos automáticos (libera o agendamento no Inter). */
  validar(ids: string[]): Promise<DdaValidarResultado> {
    if (isDemoSession()) return demoDelay({ validados: ids, recusados: [] });
    return this.post('/api/dda/validar', { ids }, 'Falha ao validar os boletos');
  }

  /** Cria no Tiny, em lote, as contas dos boletos sem conta (tarefa no motor). */
  async criarContas(itens: DdaCriarContaItem[], onTick?: (job: DdaJob<DdaCriarContasResultado>) => void): Promise<DdaCriarContasResultado> {
    if (isDemoSession()) throw new Error('Ação indisponível no modo demonstração.');
    const { job_id } = await this.post<{ job_id: string }>('/api/dda/criar-contas', { itens }, 'Falha ao iniciar a criação das contas');
    const job = await this.esperarJob<DdaCriarContasResultado>(job_id, onTick);
    if (job.status !== 'concluido' || !job.resultado) throw new Error(job.erro || 'A criação das contas falhou.');
    return job.resultado;
  }

  private async acao(id: string, acao: 'vincular' | 'criar' | 'descartar' | 'reabrir', body: unknown): Promise<DdaBoleto> {
    if (isDemoSession()) throw new Error('Ação indisponível no modo demonstração.');
    const r = await this.post<{ boleto: DdaBoleto }>(`/api/dda/boletos/${encodeURIComponent(id)}/${acao}`, body, 'Falha na ação do boleto');
    return r.boleto;
  }

  vincular(id: string, contaId: number) {
    return this.acao(id, 'vincular', { conta_id: contaId });
  }

  criarConta(id: string, categoriaId: number, historico: string) {
    return this.acao(id, 'criar', { categoria_id: categoriaId, historico });
  }

  descartar(id: string, motivo: string) {
    return this.acao(id, 'descartar', { motivo });
  }

  reabrir(id: string) {
    return this.acao(id, 'reabrir', {});
  }
}
