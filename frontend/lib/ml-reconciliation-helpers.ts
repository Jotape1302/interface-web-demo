import type {
  MlCasamento,
  MlComparativo,
  MlConexao,
  MlEmpresaStatus,
  MlGrupo,
  MlJob,
  MlLancamento,
  MlLinhaLog,
  MlPendencia,
  MlStatusExecucao,
  MlTokenSyncResponse,
} from './ml-reconciliation-contracts';
import { JobLostError, abortableSleep } from './reconciliation-helpers';

export type MlTone = 'success' | 'warning' | 'danger' | 'secondary' | 'info';

/** Filtros da aba de recebimentos. */
export type MlFiltroGrupo = 'aptos' | 'conciliados' | 'pendentes' | 'ja_baixados' | 'todos';

const SITUACOES: Record<string, { label: string; tone: MlTone }> = {
  'APTO PARA BAIXA': { label: 'Apto para baixa', tone: 'info' },
  CONCILIADO: { label: 'Baixado no Tiny', tone: 'success' },
  'Não conciliado': { label: 'Sem cliente', tone: 'warning' },
  'NÃO LOCALIZADO': { label: 'Conta não localizada', tone: 'warning' },
  'VALOR DIVERGENTE': { label: 'Valor acima do saldo', tone: 'danger' },
  'TINY NÃO CONSULTADO': { label: 'Tiny não consultado', tone: 'secondary' },
  'ERRO API': { label: 'Erro na baixa', tone: 'danger' },
  'ERRO AO PROCESSAR': { label: 'Erro na consulta', tone: 'danger' },
  'DESCONTADO NA BAIXA': { label: 'Descontado na baixa', tone: 'secondary' },
};

/** Rótulo e cor da situação de um recebimento ("STATUS: PAGO" -> "Já pago no Tiny"). */
export function situacaoMeta(situacao: string): { label: string; tone: MlTone } {
  const conhecida = SITUACOES[situacao];
  if (conhecida) return conhecida;
  const status = /^STATUS:\s*(.+)$/i.exec(situacao);
  if (status) {
    const s = status[1]!.trim().toLowerCase();
    return { label: s === 'pago' ? 'Já pago no Tiny' : `Tiny: ${s}`, tone: 'secondary' };
  }
  return { label: situacao || '—', tone: 'secondary' };
}

export function grupoNoFiltro(grupo: MlGrupo, filtro: MlFiltroGrupo): boolean {
  switch (filtro) {
    case 'aptos':
      return grupo.apto_baixa;
    case 'conciliados':
      return grupo.situacao === 'CONCILIADO';
    case 'ja_baixados':
      return /^STATUS:/i.test(grupo.situacao);
    case 'pendentes':
      return !grupo.apto_baixa && grupo.situacao !== 'CONCILIADO' && !/^STATUS:/i.test(grupo.situacao);
    default:
      return true;
  }
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Busca livre por cliente, número da venda ou conta do Tiny. */
export function grupoCombinaBusca(grupo: MlGrupo, busca: string): boolean {
  const termo = normalizar(busca.trim());
  if (!termo) return true;
  return [grupo.nome_cliente, grupo.id_venda, grupo.conta_id ? String(grupo.conta_id) : '']
    .some((campo) => normalizar(campo).includes(termo));
}

/** Soma dos valores dos recebimentos selecionados (em centavos, para não acumular erro de float). */
export function somaSelecionados(grupos: readonly MlGrupo[], selecionados: ReadonlySet<string>): number {
  let centavos = 0;
  for (const g of grupos) if (selecionados.has(g.id)) centavos += Math.round(g.valor_total * 100);
  return centavos / 100;
}

const CASAMENTOS: Record<MlCasamento, { label: string; tone: MlTone }> = {
  pagamento: { label: 'Pelo ID do pagamento', tone: 'success' },
  pedido: { label: 'Pelo pedido do relatório', tone: 'warning' },
  sem_venda: { label: 'Sem venda', tone: 'secondary' },
};

/** Como a liberação do Mercado Pago foi ligada à venda do Mercado Livre. */
export function casamentoMeta(casouPor: MlCasamento): { label: string; tone: MlTone } {
  return CASAMENTOS[casouPor] ?? { label: casouPor, tone: 'secondary' };
}

/** Filtros da aba Vendas × Recebimentos. */
export type MlFiltroComparativo = 'conferir' | 'pagamento' | 'pedido' | 'sem_venda' | 'todos';

export function comparativoNoFiltro(item: MlComparativo, filtro: MlFiltroComparativo): boolean {
  if (filtro === 'todos') return true;
  if (filtro === 'conferir') return item.observacao !== '';
  return item.casou_por === filtro;
}

const STATUS_EXECUCAO: Record<MlStatusExecucao, { label: string; tone: MlTone }> = {
  ok: { label: 'Concluída', tone: 'success' },
  parcial: { label: 'Parcial', tone: 'warning' },
  erro: { label: 'Falhou', tone: 'danger' },
};

export function statusExecucaoMeta(status: MlStatusExecucao): { label: string; tone: MlTone } {
  return STATUS_EXECUCAO[status] ?? { label: status, tone: 'secondary' };
}

export const NIVEL_LOG: Record<MlLinhaLog['nivel'], { label: string; className: string }> = {
  info: { label: 'INFO', className: 'text-muted-foreground' },
  aviso: { label: 'AVISO', className: 'text-amber-600 dark:text-amber-400' },
  erro: { label: 'ERRO', className: 'text-destructive' },
};

function dataBr(iso: string): string {
  const [a, m, d] = iso.split('-');
  return a && m && d ? `${d}/${m}/${a}` : iso;
}

/** "01/09/2025" ou "01/09/2025 a 15/09/2025" (datas AAAA-MM-DD). */
export function periodoTexto(de: string, ate: string): string {
  return de === ate ? dataBr(de) : `${dataBr(de)} a ${dataBr(ate)}`;
}

const CONEXOES: Record<MlConexao, string> = {
  mercado_pago: 'Mercado Pago',
  mercado_livre: 'Mercado Livre',
  tiny: 'Tiny',
};

/** Conexões sem token da empresa, pelo nome ("Mercado Pago", "Tiny"...). */
export function conexoesFaltando(empresa: Pick<MlEmpresaStatus, 'conexoes'>): string[] {
  return (Object.keys(CONEXOES) as MlConexao[]).filter((c) => !empresa.conexoes[c]).map((c) => CONEXOES[c]);
}

/** Valida o período da execução manual (mesmas regras do backend: até 60 dias, sem datas futuras). */
export function erroPeriodo(de: string, ate: string, hoje: string): string | null {
  if (!de || !ate) return 'Informe as duas datas.';
  if (de > ate) return 'A data inicial é depois da data final.';
  if (ate > hoje) return 'O período não pode terminar depois de hoje.';
  const dias = Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000) + 1;
  if (dias > 60) return 'O período máximo é de 60 dias (limite do relatório do Mercado Pago).';
  return null;
}

export interface MlWaitOptions<T extends MlJob> {
  signal?: AbortSignal;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
  onProgress?: (job: T) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Consulta a tarefa até terminar (mesma política da conciliação Inter: 3 falhas seguidas, 404 = perdida). */
export async function waitForMlJob<T extends MlJob>(
  fetchJob: (jobId: string, signal?: AbortSignal) => Promise<MlJob>,
  initial: T,
  options: MlWaitOptions<T> = {},
): Promise<T> {
  const { signal, intervalMs = 2000, maxConsecutiveErrors = 3, onProgress, sleep = abortableSleep } = options;
  let job = initial;
  let failures = 0;
  onProgress?.(job);
  while (job.status === 'executando') {
    await sleep(intervalMs, signal);
    try {
      const next = await fetchJob(job.job_id, signal);
      if (next.tipo !== initial.tipo) throw new Error('O servidor devolveu uma tarefa de outro tipo.');
      job = next as T;
      failures = 0;
      onProgress?.(job);
    } catch (e) {
      if (signal?.aborted || e instanceof JobLostError) throw e;
      failures += 1;
      if (failures >= maxConsecutiveErrors) throw e;
    }
  }
  if (job.status === 'erro') throw new Error(job.erro || 'A tarefa terminou com erro no servidor.');
  if (job.resultado === null) throw new Error('A tarefa terminou sem devolver resultado.');
  return job;
}

/** Nome do arquivo do cabeçalho Content-Disposition (filename*=UTF-8''... ou filename="..."). */
export function nomeDoArquivo(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]!.trim());
    } catch {
      // segue para o formato simples
    }
  }
  const simples = /filename="?([^";]+)"?/i.exec(disposition);
  return simples ? simples[1]!.trim() : fallback;
}

export type MlFiltroFluxo = 'todos' | 'recebimentos' | 'pagamentos';

/** Filtra lançamentos por direção/fluxo (Recebimentos MP / Entradas vs Pagamentos MP / Saídas). */
export function lancamentoNoFluxo(l: MlLancamento, filtro: MlFiltroFluxo): boolean {
  if (filtro === 'todos') return true;
  const fluxo = l.fluxo || (l.tipo === 'C' ? 'RECEBIMENTO' : 'PAGAMENTO');
  return filtro === 'recebimentos' ? fluxo === 'RECEBIMENTO' : fluxo === 'PAGAMENTO';
}

/** Filtra pendências por direção/fluxo (Recebimentos MP / Entradas vs Pagamentos MP / Saídas). */
export function pendenciaNoFluxo(p: MlPendencia, filtro: MlFiltroFluxo): boolean {
  if (filtro === 'todos') return true;
  const fluxo = p.fluxo || (p.valor >= 0 ? 'RECEBIMENTO' : 'PAGAMENTO');
  return filtro === 'recebimentos' ? fluxo === 'RECEBIMENTO' : fluxo === 'PAGAMENTO';
}

/** Retorna categoria temática do motivo para exibição em badge de destaque. */
export function pendenciaMotivoMeta(motivo: string): { label: string; tone: MlTone } {
  const m = (motivo || '').toLowerCase();
  if (m.includes('tiny')) return { label: 'Sem par no Tiny', tone: 'warning' };
  if (m.includes('mercado livre') || m.includes(' ml')) return { label: 'Sem par no ML', tone: 'secondary' };
  if (m.includes('aguardando liberação futura') || m.includes('dinheiro retido')) return { label: 'Dinheiro retido (futuro)', tone: 'info' };
  if (m.includes('período anterior') || m.includes('liberação de valor retido')) return { label: 'Liberação retida anterior', tone: 'info' };
  if (m.includes('cpf/cnpj')) return { label: 'CPF/CNPJ ausente', tone: 'warning' };
  return { label: 'Conferir', tone: 'warning' };
}

export type TokenSyncFeedback = {
  tipo: 'sucesso' | 'aviso' | 'erro';
  msg: string;
};

/**
 * Formata o feedback da sincronização de tokens cobrindo 4 ramos:
 * 1. mock: true (modo de demonstração)
 * 2. 429 (cooldown de sincronização com tempo de espera)
 * 3. todas renovadas com sucesso
 * 4. parcial ou falha com detalhes/motivos por conta
 */
export function formatarMensagemSincronizacaoTokens(
  resultadoOuErro: unknown,
): TokenSyncFeedback {
  if (resultadoOuErro instanceof Error || typeof resultadoOuErro === 'string') {
    const raw = typeof resultadoOuErro === 'string' ? resultadoOuErro : resultadoOuErro.message;
    if (/429|aguarde|cooldown|muitas tentativas/i.test(raw)) {
      return {
        tipo: 'erro',
        msg: raw || 'Aguarde antes de tentar sincronizar novamente.',
      };
    }
    return {
      tipo: 'erro',
      msg: raw || 'Falha ao sincronizar tokens do Mercado Livre.',
    };
  }

  if (resultadoOuErro && typeof resultadoOuErro === 'object' && 'contas' in resultadoOuErro) {
    const res = resultadoOuErro as MlTokenSyncResponse;

    if (res.mock) {
      return {
        tipo: 'sucesso',
        msg: 'Modo simulação: tokens simulados sincronizados com sucesso.',
      };
    }

    const contas = Object.entries(res.contas || {});
    const falhas = contas.filter(([, c]) => !c.renovado);

    if (falhas.length > 0) {
      const detalhes = falhas
        .map(([nome, c]) => `${nome}: ${c.motivo || 'falha na renovação'}`)
        .join('; ');
      const todasFalharam = falhas.length === contas.length;
      return {
        tipo: todasFalharam ? 'erro' : 'aviso',
        msg: todasFalharam
          ? `Nenhum token pôde ser renovado (${detalhes}).`
          : `Tokens atualizados parcialmente. Pendências: ${detalhes}.`,
      };
    }

    return {
      tipo: 'sucesso',
      msg: 'Tokens do Mercado Livre atualizados com sucesso via TMS/OAuth!',
    };
  }

  return {
    tipo: 'erro',
    msg: 'Falha ao sincronizar tokens do Mercado Livre.',
  };
}
