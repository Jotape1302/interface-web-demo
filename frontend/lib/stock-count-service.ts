import type {
  StockCountConferencia,
  StockCountConferirInput,
  StockCountConsultaTiny,
  StockCountEnvioTiny,
  StockCountItem,
  StockCountSkuManual,
  StockCountListResponse,
  StockCountQuery,
} from './stock-count-contracts';
import { resolveApiBaseUrl } from './contracts';
import { readApiError } from './api-errors';
import { demoDelay, isDemoSession } from './demo-session';

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

function buildSvgDataUrl(titulo: string, anotada: boolean, count: number): string {
  const circulos = anotada
    ? Array.from({ length: Math.min(count, 12) }, (_, i) => {
        const x = 50 + (i % 6) * 60;
        const y = 80 + Math.floor(i / 6) * 60;
        return `<circle cx="${x}" cy="${y}" r="18" fill="#10b981" fill-opacity="0.25" stroke="#10b981" stroke-width="2.5"/><text x="${x}" y="${y + 5}" font-family="sans-serif" font-size="12" font-weight="bold" fill="#065f46" text-anchor="middle">${i + 1}</text>`;
      }).join('')
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260">
    <rect width="400" height="260" fill="#f1f5f9"/>
    <rect x="20" y="20" width="360" height="220" rx="4" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
    <line x1="20" y1="200" x2="380" y2="200" stroke="#94a3b8" stroke-width="6"/>
    <text x="35" y="45" font-family="sans-serif" font-size="12" font-weight="bold" fill="#475569">${titulo} ${anotada ? '(Anotada)' : '(Original)'}</text>
    ${circulos}
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DEMO_ITEMS: StockCountItem[] = [
  {
    id: "a1b2c3d4e5f6",
    criado_em: "2026-10-13T09:45:00-03:00",
    codigo: "FORRO-PVC-200-BR",
    origem_codigo: "codigo_e_legenda",
    sku_legenda: "FORRO-PVC-200-BR",
    codigos_barras: ["7891112223334"],
    quantidade_detectada: 12,
    cor: 'verde',
    unidades_por_fardo: 5,
    quantidade_final: 12,
    status: "confirmada",
    alertas: [],
    telegram_user_id: 101,
    telegram_user: "Carlos Estoquista",
    telegram_chat_id: -100223344,
    foto_sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    imagem: "a1b2c3d4e5f6.jpg",
    imagem_original: "a1b2c3d4e5f6_original.jpg",
    concluido_em: "2026-10-13T09:46:12-03:00",
  },
  {
    id: "b2c3d4e5f6a1",
    criado_em: "2026-10-13T08:15:20-03:00",
    codigo: "RODAPE-POLI-10CM",
    origem_codigo: "legenda",
    sku_legenda: "RODAPE-POLI-10CM",
    codigos_barras: [],
    quantidade_detectada: 8,
    cor: 'rosa',
    unidades_por_fardo: 10,
    quantidade_final: 9,
    status: "corrigida",
    alertas: ["Prendedor parcialmente visível no canto superior"],
    telegram_user_id: 102,
    telegram_user: "Mariana Logística",
    telegram_chat_id: -100223344,
    foto_sha256: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
    imagem: "b2c3d4e5f6a1.jpg",
    imagem_original: "b2c3d4e5f6a1_original.jpg",
    concluido_em: "2026-10-13T08:17:05-03:00",
  },
  {
    id: "c3d4e5f6a1b2",
    criado_em: "2026-10-12T16:30:10-03:00",
    codigo: "CANALETA-50X20",
    origem_codigo: "codigo_de_barras",
    sku_legenda: null,
    codigos_barras: ["7899988776655"],
    quantidade_detectada: 6,
    quantidade_final: null,
    status: "aguardando_confirmacao",
    alertas: ["Baixa iluminação na prateleira"],
    telegram_user_id: 101,
    telegram_user: "Carlos Estoquista",
    telegram_chat_id: -100223344,
    foto_sha256: "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
    imagem: "c3d4e5f6a1b2.jpg",
    imagem_original: "c3d4e5f6a1b2_original.jpg",
    concluido_em: null,
  },
  {
    id: "d4e5f6a1b2c3",
    criado_em: "2026-10-11T11:00:00-03:00",
    codigo: "PERFIL-ALUM-2M",
    origem_codigo: "codigo_e_legenda",
    sku_legenda: "PERFIL-ALUM-2M",
    codigos_barras: ["7894455667788"],
    quantidade_detectada: 15,
    quantidade_final: 15,
    status: "confirmada",
    alertas: [],
    telegram_user_id: 103,
    telegram_user: "Roberto Fábrica",
    telegram_chat_id: -100223344,
    foto_sha256: "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
    imagem: "d4e5f6a1b2c3.jpg",
    imagem_original: "d4e5f6a1b2c3_original.jpg",
    concluido_em: "2026-10-11T11:02:40-03:00",
  },
];

// Modo demo: uma contagem sem produto para exercitar "Informar SKU", e as ações em memória.
DEMO_ITEMS.push({
  id: "e5f6a1b2c3d4",
  criado_em: "2026-10-13T17:34:46-03:00",
  codigo: null,
  origem_codigo: "sem_produto",
  sku_legenda: null,
  codigos_barras: [],
  quantidade_detectada: 8,
  quantidade_final: null,
  status: "aguardando_confirmacao",
  alertas: ["1 prendedor com cor duvidosa"],
  telegram_user_id: 123456,
  telegram_user: "Operador Demo",
  telegram_chat_id: 123456,
  imagem: "e5f6a1b2c3d4.jpg",
  imagem_original: "e5f6a1b2c3d4_original.jpg",
  concluido_em: null,
});
const demoSkus = new Map<string, StockCountSkuManual>();
const demoExcluidas = new Set<string>();
const demoConferencias = new Map<string, StockCountConferencia>();
const demoEnvios = new Map<string, StockCountEnvioTiny>();
/** Saldo fictício do Tiny por SKU no modo demo (o que não está aqui começa em 20). */
const demoSaldoTiny = new Map<string, number>();
// Conferir/informar SKU esperam o Tiny (busca do produto, estoque e entrada).
const TIMEOUT_TINY_MS = 70000;

function demoNomeProduto(sku: string): string {
  return `Produto demonstração ${sku}`;
}

function demoEnviarTiny(id: string, sku: string | null, unidades: number): StockCountEnvioTiny | null {
  if (!sku) return null;
  const saldo = demoSaldoTiny.get(sku) ?? 20;
  const entrada = Math.max(0, unidades - saldo);
  demoSaldoTiny.set(sku, saldo + entrada);
  const envio: StockCountEnvioTiny = {
    registro_id: id,
    status: entrada > 0 ? 'lancado' : 'sem_entrada',
    sku,
    produto: demoNomeProduto(sku),
    unidades,
    saldo_anterior: saldo,
    entrada,
    id_lancamento: entrada > 0 ? 900000 + demoEnvios.size : null,
    deposito: 'Geral',
    mensagem: null,
    usuario_nome: 'Usuário Demo',
    enviado_em: new Date().toISOString(),
  };
  demoEnvios.set(id, envio);
  return envio;
}

export class StockCountService {
  constructor(private readonly baseUrl: string = '') {}

  protected getUrl(path: string): string {
    const cleanBase = (this.baseUrl || '').replace(/\/$/, '');
    return `${cleanBase}${path}`;
  }

  imagemUrl(id: string, tipo: 'anotada' | 'original'): string {
    return this.getUrl(`/api/stock-count/imagens/${encodeURIComponent(id)}/${tipo}`);
  }

  /**
   * Baixa a foto com o token da sessão e devolve um blob: URL (o chamador revoga). Uma <img> com a
   * URL do gateway não manda o cabeçalho Authorization e recebe 401.
   */
  async carregarImagem(id: string, tipo: 'anotada' | 'original', signal?: AbortSignal): Promise<string> {
    const res = await fetch(this.imagemUrl(id, tipo), {
      headers: getAuthHeaders(),
      credentials: 'same-origin',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(await readApiError(res, 'Falha ao carregar a foto'));
    return URL.createObjectURL(await res.blob());
  }

  async listarContagens(query: StockCountQuery = {}, signal?: AbortSignal): Promise<StockCountListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    if (query.sku) params.set('sku', query.sku);
    if (query.data_inicio) params.set('data_inicio', query.data_inicio);
    if (query.data_fim) params.set('data_fim', query.data_fim);

    const qs = params.toString();
    const url = this.getUrl(`/api/stock-count/contagens${qs ? `?${qs}` : ''}`);

    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: {
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(await readApiError(res, 'Falha ao consultar contagens de estoque'));
    }

    return (await res.json()) as StockCountListResponse;
  }

  private async enviar(path: string, method: 'POST' | 'DELETE', body: unknown, fallback: string, timeoutMs = 10000): Promise<any> {
    const res = await fetch(this.getUrl(path), {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Accept: 'application/json',
        ...getAuthHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(await readApiError(res, fallback));
    return res.json();
  }

  /**
   * SKU de uma contagem registrada sem produto (origem "sem_produto"). Se ela já estava conferida,
   * o gateway lança no Tiny na mesma hora e devolve o envio.
   */
  async informarSku(id: string, sku: string): Promise<{ sku_manual: StockCountSkuManual; tiny: StockCountEnvioTiny | null }> {
    const data = await this.enviar(
      `/api/stock-count/contagens/${encodeURIComponent(id)}/sku`, 'POST', { sku }, 'Falha ao informar o SKU', TIMEOUT_TINY_MS,
    );
    return { sku_manual: data.sku_manual as StockCountSkuManual, tiny: (data.tiny ?? null) as StockCountEnvioTiny | null };
  }

  /**
   * Confirma ou corrige a contagem (fardos, unidades por fardo e soltas). O gateway lança no Tiny
   * só a entrada que falta e devolve o envio (null sem SKU).
   */
  async conferir(
    id: string,
    input: StockCountConferirInput,
  ): Promise<{ conferencia: StockCountConferencia; tiny: StockCountEnvioTiny | null }> {
    const data = await this.enviar(
      `/api/stock-count/contagens/${encodeURIComponent(id)}/conferir`, 'POST', input, 'Falha ao conferir a contagem', TIMEOUT_TINY_MS,
    );
    return { conferencia: data.conferencia as StockCountConferencia, tiny: (data.tiny ?? null) as StockCountEnvioTiny | null };
  }

  /** Nome do produto e saldo atual no Tiny (só leitura). `atualizar` ignora o cache de 1 min do gateway. */
  async consultarTiny(id: string, atualizar = false, signal?: AbortSignal): Promise<StockCountConsultaTiny> {
    const res = await fetch(
      this.getUrl(`/api/stock-count/contagens/${encodeURIComponent(id)}/tiny${atualizar ? '?atualizar=1' : ''}`),
      {
        headers: { Accept: 'application/json', ...getAuthHeaders() },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
      },
    );
    if (!res.ok) throw new Error(await readApiError(res, 'Falha ao consultar o produto no Tiny'));
    return (await res.json()) as StockCountConsultaTiny;
  }

  /** Reenvia ao Tiny uma contagem já conferida (falha anterior ou conferida antes da integração). */
  async enviarTiny(id: string): Promise<StockCountEnvioTiny> {
    const data = await this.enviar(
      `/api/stock-count/contagens/${encodeURIComponent(id)}/tiny`, 'POST', undefined, 'Falha ao enviar ao Tiny', TIMEOUT_TINY_MS,
    );
    return data.tiny as StockCountEnvioTiny;
  }

  /** Tira a contagem da tela (o registro do bot continua até a retenção). */
  async excluirContagem(id: string): Promise<void> {
    await this.enviar(`/api/stock-count/contagens/${encodeURIComponent(id)}`, 'DELETE', undefined, 'Falha ao excluir a contagem');
  }
}

class DemoStockCountService extends StockCountService {
  override imagemUrl(id: string, tipo: 'anotada' | 'original'): string {
    const item = DEMO_ITEMS.find((i) => i.id === id);
    const titulo = item ? item.codigo || 'Prateleira' : 'Prateleira';
    const count = item ? item.quantidade_detectada : 5;
    return buildSvgDataUrl(titulo, tipo === 'anotada', count);
  }

  override async carregarImagem(id: string, tipo: 'anotada' | 'original'): Promise<string> {
    return this.imagemUrl(id, tipo);
  }

  override async conferir(id: string, input: StockCountConferirInput) {
    const item = DEMO_ITEMS.find((i) => i.id === id);
    const conf: StockCountConferencia = {
      registro_id: id,
      status: item && item.quantidade_detectada === input.quantidade ? 'confirmada' : 'corrigida',
      quantidade_final: input.quantidade,
      unidades_por_fardo: input.unidades_por_fardo,
      unidades_soltas: input.unidades_soltas,
      unidades_total: input.quantidade * input.unidades_por_fardo + input.unidades_soltas,
      usuario_nome: 'Usuário Demo',
      conferida_em: new Date().toISOString(),
    };
    demoConferencias.set(id, conf);
    const tiny = demoEnviarTiny(id, item?.codigo || demoSkus.get(id)?.sku || null, conf.unidades_total);
    return demoDelay({ conferencia: conf, tiny });
  }

  override async informarSku(id: string, sku: string) {
    const item = { registro_id: id, sku: sku.trim().toUpperCase(), usuario_nome: 'Usuário Demo', informado_em: new Date().toISOString() };
    demoSkus.set(id, item);
    const conf = demoConferencias.get(id);
    const anterior = demoEnvios.get(id);
    const tiny =
      conf && (!anterior || anterior.status === 'erro') ? demoEnviarTiny(id, item.sku, conf.unidades_total) : (anterior ?? null);
    return demoDelay({ sku_manual: item, tiny });
  }

  override async consultarTiny(id: string): Promise<StockCountConsultaTiny> {
    const item = DEMO_ITEMS.find((i) => i.id === id);
    const sku = item?.codigo || demoSkus.get(id)?.sku;
    if (!sku) throw new Error('Contagem sem SKU.');
    return demoDelay({
      sku,
      id_produto: 1,
      produto: demoNomeProduto(sku),
      unidade: 'UN',
      deposito: 'Geral',
      saldo: demoSaldoTiny.get(sku) ?? 20,
      aviso: null,
      consultado_em: new Date().toISOString(),
    });
  }

  override async enviarTiny(id: string): Promise<StockCountEnvioTiny> {
    const item = DEMO_ITEMS.find((i) => i.id === id);
    const conf = demoConferencias.get(id);
    if (!conf) throw new Error('Confira a contagem antes de enviar ao Tiny.');
    const tiny = demoEnviarTiny(id, item?.codigo || demoSkus.get(id)?.sku || null, conf.unidades_total);
    if (!tiny) throw new Error('Informe o SKU da contagem antes de enviar ao Tiny.');
    return demoDelay(tiny);
  }

  override async excluirContagem(id: string): Promise<void> {
    demoExcluidas.add(id);
    await demoDelay(null);
  }

  override async listarContagens(query: StockCountQuery = {}): Promise<StockCountListResponse> {
    let filtrados = DEMO_ITEMS.filter((i) => !demoExcluidas.has(i.id)).map((i) => {
      const conf = demoConferencias.get(i.id) ?? null;
      return {
        ...i,
        sku_manual: demoSkus.get(i.id) ?? null,
        conferencia: conf,
        tiny: demoEnvios.get(i.id) ?? null,
        ...(conf ? { status: conf.status, quantidade_final: conf.quantidade_final, concluido_em: conf.conferida_em } : {}),
      };
    });

    if (query.status) {
      filtrados = filtrados.filter((i) => i.status === query.status);
    }
    if (query.sku) {
      const q = query.sku.trim().toUpperCase();
      filtrados = filtrados.filter(
        (i) =>
          (i.codigo || '').toUpperCase().includes(q) ||
          (i.sku_legenda || '').toUpperCase().includes(q) ||
          (i.codigos_barras || []).some((b) => b.toUpperCase().includes(q)) ||
          (i.sku_manual?.sku || '').includes(q),
      );
    }
    if (query.data_inicio) {
      filtrados = filtrados.filter((i) => i.criado_em >= query.data_inicio!);
    }
    if (query.data_fim) {
      const fim = query.data_fim.includes('T') ? query.data_fim : `${query.data_fim}T23:59:59`;
      filtrados = filtrados.filter((i) => i.criado_em <= fim);
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const itens = filtrados.slice(offset, offset + pageSize);

    return demoDelay({
      configurado: true,
      itens,
      total: filtrados.length,
      page,
      pageSize,
    });
  }
}

export function createStockCountService(apiBaseUrl?: string): StockCountService {
  if (isDemoSession()) return new DemoStockCountService();
  return new StockCountService(resolveApiBaseUrl(apiBaseUrl));
}
