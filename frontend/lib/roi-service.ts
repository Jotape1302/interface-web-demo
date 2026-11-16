import { readApiError } from './api-errors';
import { resolveApiBaseUrl, type DashboardConfig } from './contracts';
import { makeDemoRoi } from './demo-roi';
import { roiPeriodoRotulo, roiQuery } from './roi-period';
import type { RoiAutomacao, RoiPeriodoAplicado, RoiResponse, RoiService } from './roi-contracts';

const fail = (): never => {
  throw new Error('A API retornou dados incompatíveis com o ROI das automações.');
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();
const text = (value: unknown): string => (typeof value === 'string' ? value : fail());
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail());
const nullableNumber = (value: unknown): number | null => (value === null ? null : number(value));
const dataOuNula = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fail();
const timestamp = (value: unknown): string =>
  typeof value === 'string' && /T.*(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : fail();

function parseAutomacao(value: unknown): RoiAutomacao {
  const row = object(value);
  const fonte = object(row.fonte);
  if (fonte.status !== 'ok' && fonte.status !== 'erro') return fail();
  const itens = nullableNumber(row.itens);
  const horasEconomizadas = nullableNumber(row.horasEconomizadas);
  const reais = nullableNumber(row.reais);
  // Fonte com falha vem sem números; fonte ok sempre traz os três.
  const completo = itens !== null && horasEconomizadas !== null && reais !== null;
  const vazio = itens === null && horasEconomizadas === null && reais === null;
  if (fonte.status === 'ok' ? !completo : !vazio) return fail();
  if (row.observacao !== null && typeof row.observacao !== 'string') return fail();
  return {
    id: text(row.id),
    titulo: text(row.titulo),
    unidade: text(row.unidade),
    itens,
    minutosManual: number(row.minutosManual),
    minutosAtual: number(row.minutosAtual),
    tarefaManual: text(row.tarefaManual),
    tarefaAtual: text(row.tarefaAtual),
    horasEconomizadas,
    reais,
    fonte: { status: fonte.status, ...(fonte.mensagem === undefined ? {} : { mensagem: text(fonte.mensagem) }) },
    observacao: row.observacao,
  };
}

export function parseRoi(value: unknown): RoiResponse {
  const data = object(value);
  const totais = object(data.totais);
  const periodo = data.periodo === undefined || data.periodo === null ? {} : object(data.periodo);
  if ((data.mode !== 'demo' && data.mode !== 'live') || !Array.isArray(data.automacoes) || !Array.isArray(data.naoMedidas) || typeof totais.parcial !== 'boolean') return fail();
  const automacoes = data.automacoes.map(parseAutomacao);
  if (new Set(automacoes.map((a) => a.id)).size !== automacoes.length) return fail();
  return {
    mode: data.mode,
    generatedAt: timestamp(data.generatedAt),
    valorHora: number(data.valorHora),
    automacoes,
    totais: { horasEconomizadas: number(totais.horasEconomizadas), reais: number(totais.reais), parcial: totais.parcial },
    periodo: { de: dataOuNula(periodo.de), ate: dataOuNula(periodo.ate) },
    naoMedidas: data.naoMedidas.map((item) => {
      const row = object(item);
      return { id: text(row.id), titulo: text(row.titulo), motivo: text(row.motivo) };
    }),
  };
}

/** Economia por item (manual − atual), em minutos. */
export const minutosEconomizados = (a: Pick<RoiAutomacao, 'minutosManual' | 'minutosAtual'>): number =>
  Math.round((a.minutosManual - a.minutosAtual) * 100) / 100;

/** Linhas do CSV exportado pela tela. */
export function roiCsvRows(roi: RoiResponse): (string | number | null)[][] {
  return roi.automacoes.map((a) => [
    a.titulo,
    a.unidade,
    a.itens,
    a.minutosManual,
    a.tarefaManual,
    a.minutosAtual,
    a.tarefaAtual,
    minutosEconomizados(a),
    a.horasEconomizadas === null ? null : Math.round(a.horasEconomizadas * 100) / 100,
    a.reais,
    a.fonte.status === 'ok' ? 'Ok' : 'Falha na fonte',
    a.observacao,
  ]);
}
/** Linha de cabeçalho do CSV com o período do relatório. */
export const roiCsvPeriodoLinha = (roi: RoiResponse): string[] => [`Período: ${roiPeriodoRotulo(roi.periodo)}`];
export const ROI_CSV_HEADERS = ['Automação', 'Unidade contada', 'Itens', 'Min. manual/item', 'Tarefa manual', 'Min. atual/item', 'Tarefa atual', 'Min. economizados/item', 'Horas economizadas', 'R$ economizados', 'Fonte', 'Observação'];

export class MockRoiService implements RoiService {
  async getRoi(signal?: AbortSignal, periodo?: Partial<RoiPeriodoAplicado>) {
    signal?.throwIfAborted();
    return parseRoi(makeDemoRoi(new Date(), periodo));
  }
}

export class HttpRoiService implements RoiService {
  private readonly fetcher: typeof fetch;
  constructor(private readonly baseUrl = '', fetcher: typeof fetch = fetch) {
    this.fetcher = (input: RequestInfo | URL, init?: RequestInit) => Reflect.apply(fetcher, globalThis, [input, init]);
  }
  async getRoi(signal?: AbortSignal, periodo?: Partial<RoiPeriodoAplicado>) {
    const timeout = AbortSignal.timeout(30000);
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/api/roi${roiQuery(periodo)}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Acesso não autorizado. Verifique sua sessão e suas permissões.' : await readApiError(response, 'Não foi possível consultar o ROI das automações'));
    const data = parseRoi(await response.json());
    if (data.mode !== 'live') throw new Error('O modo conectado recebeu uma resposta demonstrativa. Verifique a configuração da API.');
    return data;
  }
}

export const createRoiService = (config: DashboardConfig): RoiService =>
  config.mode === 'demo' ? new MockRoiService() : new HttpRoiService(resolveApiBaseUrl(config.apiBaseUrl));
