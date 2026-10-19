'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Camera,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileImage,
  Info,
  Maximize2,
  Pencil,
  MessageSquare,
  PackageSearch,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { stockCount } from '@/lib/automations';
import { useAuth } from '@/lib/auth-context';
import {
  createStockCountService,
  type StockCountService,
} from '@/lib/stock-count-service';
import {
  UNIDADES_POR_FARDO_PADRAO,
  type StockCountConferencia,
  type StockCountConsultaTiny,
  type StockCountEnvioTiny,
  type StockCountItem,
  type StockCountSkuManual,
  type StockCountStatus,
} from '@/lib/stock-count-contracts';
import { ColumnFilterBar, ColumnFilterHeader } from './column-filter';
import {
  aplicaFiltros,
  carregarFiltrosSession,
  filtrosAtivosCount,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from '@/lib/column-filters';
import { downloadCsv } from '@/lib/csv-export';
import { buscarTodasPaginas } from '@/lib/paginacao';

// O gateway devolve no máximo 100 contagens por página; a tela lê todas e filtra no navegador.
const PAGINA_API = 100;

const SITUACAO_ROTULOS: Record<StockCountStatus, string> = {
  aguardando_confirmacao: 'Aguardando Confirmação',
  confirmada: 'Confirmada',
  corrigida: 'Corrigida',
};

const ABAS_STATUS: Array<{ situacao: string | null; rotulo: string }> = [
  { situacao: null, rotulo: 'Todas' },
  { situacao: SITUACAO_ROTULOS.aguardando_confirmacao, rotulo: 'Aguardando conferência' },
  { situacao: SITUACAO_ROTULOS.confirmada, rotulo: 'Confirmadas' },
  { situacao: SITUACAO_ROTULOS.corrigida, rotulo: 'Corrigidas' },
];

const STOCK_COUNT_DEFS: Record<string, ColumnFilterDef<StockCountItem>> = {
  sku: {
    id: 'sku',
    label: 'SKU / Código',
    tipo: 'texto',
    accessor: (i) => `${i.codigo || ''} ${i.sku_manual?.sku || ''}`,
  },
  situacao: {
    id: 'situacao',
    label: 'Situação',
    tipo: 'lista',
    accessor: (i) => SITUACAO_ROTULOS[i.status] ?? i.status,
    opcoes: Object.values(SITUACAO_ROTULOS),
  },
  data: {
    id: 'data',
    label: 'Data',
    tipo: 'data',
    accessor: (i) => i.criado_em,
  },
  quantidade: {
    id: 'quantidade',
    label: 'Fardos',
    tipo: 'numero',
    accessor: (i) => i.quantidade_final ?? i.quantidade_detectada,
  },
  usuario_origem: {
    id: 'usuario_origem',
    label: 'Usuário / Origem',
    tipo: 'texto',
    accessor: (i) => `${i.conferencia?.usuario_nome || ''} ${i.telegram_user || ''} ${i.telegram_chat_id || ''}`,
  },
};

const BOT_USERNAME = process.env.NEXT_PUBLIC_STOCK_BOT_USERNAME?.replace(/^@/, '').trim() || '';

const STEPS = [
  {
    icon: MessageSquare,
    title: 'Abra o bot no Telegram',
    text: 'Procure o bot da contagem de estoque e envie /start na primeira vez.',
  },
  {
    icon: Camera,
    title: 'Fotografe a prateleira',
    text: 'Cada pacote tem um prendedor verde. Enquadre a prateleira inteira, com todos os prendedores e a etiqueta de código de barras da prateleira à vista.',
  },
  {
    icon: FileImage,
    title: 'Envie como arquivo, com o SKU',
    text: 'Use clipe → Arquivo e escreva o SKU do produto na legenda. Como “foto”, o Telegram comprime a imagem e prendedores ou o código de barras podem não ser lidos.',
  },
  {
    icon: PackageSearch,
    title: 'Confirme ou corrija',
    text: 'O bot devolve a foto com cada prendedor numerado (em amarelo os que pedem conferência) e a envia para esta tela. A quantidade é confirmada ou corrigida aqui no painel: só a contagem conferida vale.',
  },
] as const;

const PHOTO_TIPS = [
  'Boa iluminação, sem sombra forte sobre os prendedores.',
  'Distância em que todos os prendedores fiquem nítidos.',
  'Foto sem tremer e com foco na prateleira.',
  'Nenhum prendedor escondido atrás de caixas ou etiquetas.',
];

function statusBadge(status: StockCountStatus) {
  switch (status) {
    case 'confirmada':
      return <Badge variant="success" className="text-[10px] rounded-none">Confirmada</Badge>;
    case 'corrigida':
      return <Badge variant="info" className="text-[10px] rounded-none">Corrigida</Badge>;
    case 'aguardando_confirmacao':
      return <Badge variant="warning" className="text-[10px] rounded-none">Aguardando Confirmação</Badge>;
    default:
      return <Badge variant="secondary" className="text-[10px] rounded-none">{status}</Badge>;
  }
}

function formatDataBR(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return iso;
  }
}

interface StockCountProps {
  apiBaseUrl?: string;
}

// Foto do registro baixada com o token da sessão (uma <img> com a URL do gateway recebia 401).
function FotoContagem({
  service,
  item,
  tipo,
  titulo,
  onAbrir,
}: {
  service: StockCountService;
  item: StockCountItem;
  tipo: 'anotada' | 'original';
  titulo: string;
  onAbrir: () => void;
}) {
  const semOriginal = tipo === 'original' && !item.imagem_original;
  const [url, setUrl] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    if (semOriginal) return;
    const controle = new AbortController();
    let criada: string | null = null;
    setUrl(null);
    setFalhou(false);
    service
      .carregarImagem(item.id, tipo, controle.signal)
      .then((u) => {
        criada = u;
        setUrl(u);
      })
      .catch(() => {
        if (!controle.signal.aborted) setFalhou(true);
      });
    return () => {
      controle.abort();
      if (criada?.startsWith('blob:')) URL.revokeObjectURL(criada);
    };
  }, [service, item.id, tipo, semOriginal]);

  const borda = tipo === 'anotada' ? 'border-primary/30' : 'border-border';
  if (!url) {
    return (
      <div className={`flex aspect-[4/3] w-full items-center justify-center border ${borda} bg-muted p-3 text-center text-[11px] text-muted-foreground`}>
        {semOriginal
          ? 'Foto original não guardada (contagem anterior a 13/10/2026).'
          : falhou
            ? 'Não foi possível carregar a foto.'
            : 'Carregando foto…'}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`group relative aspect-[4/3] w-full cursor-zoom-in overflow-hidden border ${borda} bg-muted p-0 text-left`}
      onClick={onAbrir}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={titulo} className="h-full w-full object-cover transition " />
      <div className="absolute inset-0 flex items-center justify-center bg-primary/40 opacity-0 transition group-hover:opacity-100">
        <Maximize2 size={18} className="text-white" />
      </div>
    </button>
  );
}

type FotoRef = { id: string; tipo: 'anotada' | 'original'; titulo: string };

// Ampliação com navegação entre todas as fotos da lista (← → no teclado ou botões; Esc fecha).
function FotoLightbox({
  service,
  fotos,
  indice,
  onIndice,
  onFechar,
}: {
  service: StockCountService;
  fotos: FotoRef[];
  indice: number;
  onIndice: (i: number) => void;
  onFechar: () => void;
}) {
  const foto = fotos[indice];
  const [url, setUrl] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);
  const temAnterior = indice > 0;
  const temProxima = indice < fotos.length - 1;
  const anterior = useCallback(() => temAnterior && onIndice(indice - 1), [temAnterior, indice, onIndice]);
  const proxima = useCallback(() => temProxima && onIndice(indice + 1), [temProxima, indice, onIndice]);

  // Depende só de id/tipo: `fotos` é recriado a cada recarga da lista e, com o objeto na
  // dependência, a foto aberta era baixada de novo (piscava).
  const fotoId = foto?.id;
  const fotoTipo = foto?.tipo;
  useEffect(() => {
    if (!fotoId || !fotoTipo) return;
    const controle = new AbortController();
    let criada: string | null = null;
    setUrl(null);
    setFalhou(false);
    service
      .carregarImagem(fotoId, fotoTipo, controle.signal)
      .then((u) => {
        criada = u;
        setUrl(u);
      })
      .catch(() => {
        if (!controle.signal.aborted) setFalhou(true);
      });
    return () => {
      controle.abort();
      if (criada?.startsWith('blob:')) URL.revokeObjectURL(criada);
    };
  }, [service, fotoId, fotoTipo]);

  useEffect(() => {
    function tecla(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        anterior();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        proxima();
      } else if (e.key === 'Escape') {
        onFechar();
      }
    }
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [anterior, proxima, onFechar]);

  if (!foto) return null;
  const seta =
    'absolute top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-none border border-border bg-background/90 text-foreground shadow disabled:opacity-30';
  return (
    <dialog
      open
      aria-modal="true"
      aria-label={foto.titulo}
      className="fixed inset-0 z-50 m-0 flex h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-transparent p-4"
    >
      <button
        type="button"
        className="fixed inset-0 cursor-default border-0 bg-black/80 backdrop-blur-sm"
        onClick={onFechar}
        aria-label="Fechar ampliação da foto"
      />
      <div className="relative z-10 max-h-[92vh] max-w-[92vw] overflow-hidden rounded-none border border-border bg-background p-2 shadow-2xl">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-border px-1 pb-2">
          <h3 className="truncate text-xs font-semibold text-foreground">{foto.titulo}</h3>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {indice + 1} / {fotos.length}
            </span>
            <Button variant="ghost" size="sm" className="h-6 w-6 rounded-none p-0" onClick={onFechar} aria-label="Fechar">
              <X size={14} />
            </Button>
          </div>
        </div>
        <div className="relative flex min-h-[40vh] min-w-[50vw] max-h-[82vh] items-center justify-center overflow-auto">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={foto.titulo} className="max-h-[80vh] max-w-full object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">{falhou ? 'Não foi possível carregar a foto.' : 'Carregando foto…'}</span>
          )}
          <button type="button" className={`${seta} left-2`} onClick={anterior} disabled={!temAnterior} aria-label="Foto anterior (←)">
            <ChevronLeft size={20} />
          </button>
          <button type="button" className={`${seta} right-2`} onClick={proxima} disabled={!temProxima} aria-label="Próxima foto (→)">
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** SKU que vale para a contagem: o do bot ou o informado no painel. */
function skuDoItem(item: StockCountItem): string {
  return item.codigo || item.sku_manual?.sku || '';
}

/** Número da contagem como vai ao Tiny ("lançamento 000001"); sem número (bot ainda não numerou), o id do registro. */
const numeroContagem = (item: StockCountItem) => (item.numero ? String(item.numero).padStart(6, '0') : item.id);

const NOME_COR: Record<'verde' | 'rosa', string> = { verde: 'verde', rosa: 'rosa choque' };
const COR_BOLINHA: Record<'verde' | 'rosa', string> = { verde: 'bg-green-500', rosa: 'bg-pink-500' };

const fmtUn = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** Inteiro >= mínimo digitado num campo; null se vazio ou inválido. */
function inteiroCampo(valor: string, minimo: number): number | null {
  const n = Number(valor);
  return valor.trim() !== '' && Number.isInteger(n) && n >= minimo ? n : null;
}

// Conferência da quantidade: só no painel (o bot não pergunta mais nada no Telegram). Cada
// marcador é um fardo; o total em unidades (fardos × unidades por fardo + soltas) vai ao Tiny,
// que recebe só a entrada do que falta.
function ConferenciaContagem({
  item,
  service,
  podeConferir,
  porFardoPadrao,
  onConferida,
}: {
  item: StockCountItem;
  service: StockCountService;
  podeConferir: boolean;
  porFardoPadrao: number;
  onConferida: (conf: StockCountConferencia, tiny: StockCountEnvioTiny | null) => void;
}) {
  const pendente = item.status === 'aguardando_confirmacao';
  const [editando, setEditando] = useState(false);
  const [fardos, setFardos] = useState(String(item.quantidade_final ?? item.quantidade_detectada));
  // Com a cor do prendedor (desde 2026-10-15) o fardo é fixo: verde 5, rosa 10. Só contagens
  // antigas, sem cor, ainda pedem as unidades por fardo.
  const porFardoDaCor = item.cor ? item.unidades_por_fardo : undefined;
  const [porFardo, setPorFardo] = useState(String(porFardoDaCor ?? item.conferencia?.unidades_por_fardo ?? porFardoPadrao));
  const [soltas, setSoltas] = useState(String(item.conferencia?.unidades_soltas ?? 0));
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Produto e saldo atual no Tiny: confere se o SKU é o certo e compara com a foto. Carrega sozinho
  // nas contagens pendentes; nas já conferidas, sob demanda (o Tiny limita as chamadas).
  const sku = skuDoItem(item);
  const [consulta, setConsulta] = useState<StockCountConsultaTiny | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [erroConsulta, setErroConsulta] = useState<string | null>(null);

  const consultar = useCallback(
    async (atualizar: boolean, signal?: AbortSignal) => {
      setConsultando(true);
      setErroConsulta(null);
      try {
        setConsulta(await service.consultarTiny(item.id, atualizar, signal));
      } catch (e) {
        if (signal?.aborted) return;
        setErroConsulta(e instanceof Error ? e.message : 'Falha ao consultar o produto no Tiny.');
      } finally {
        if (!signal?.aborted) setConsultando(false);
      }
    },
    [service, item.id],
  );

  useEffect(() => {
    if (!sku || !pendente) return;
    const ctrl = new AbortController();
    void consultar(false, ctrl.signal);
    return () => ctrl.abort();
  }, [sku, pendente, consultar]);

  const nFardos = inteiroCampo(fardos, 0);
  const nPorFardo = inteiroCampo(porFardo, 1);
  const nSoltas = inteiroCampo(soltas, 0);
  const valido = nFardos !== null && nPorFardo !== null && nSoltas !== null;
  const total = valido ? nFardos * nPorFardo + nSoltas : null;

  async function enviar() {
    if (!valido) return;
    setEnviando(true);
    setErro(null);
    try {
      const res = await service.conferir(item.id, { quantidade: nFardos, unidades_por_fardo: nPorFardo, unidades_soltas: nSoltas });
      onConferida(res.conferencia, res.tiny);
      setEditando(false);
      setConsulta(null); // o saldo do Tiny mudou com a entrada
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao conferir a contagem.');
    } finally {
      setEnviando(false);
    }
  }

  const campo = (rotulo: string, valor: string, set: (v: string) => void, minimo: number, largura = 'w-16') => (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{rotulo}</span>
      <Input
        type="number"
        min={minimo}
        step={1}
        value={valor}
        onChange={(e) => set(e.target.value)}
        className={`h-8 ${largura} rounded-none text-xs`}
        disabled={enviando}
      />
    </label>
  );

  const formAberto = (pendente || editando) && podeConferir;
  const contado = formAberto ? total : (item.conferencia?.unidades_total ?? null);

  return (
    <div className="space-y-2 border-t border-border pt-2.5 text-xs">
      {sku && (
        <div className="space-y-1 border border-border bg-background/60 p-2">
          {consulta ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Produto no Tiny · {consulta.sku}
                  </span>
                  <span className="block font-medium text-foreground" title={consulta.produto}>
                    {consulta.produto || '(sem nome)'}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 rounded-none px-2 text-[11px]"
                  disabled={consultando}
                  onClick={() => void consultar(true)}
                >
                  {consultando ? 'Atualizando…' : 'Atualizar'}
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
                <span>
                  <span className="text-muted-foreground">Estoque no Tiny: </span>
                  <span className="font-semibold text-foreground">
                    {consulta.saldo === null ? '—' : `${fmtUn(consulta.saldo)} ${consulta.unidade || 'un'}`}
                  </span>
                  {consulta.deposito && <span className="text-muted-foreground"> · {consulta.deposito}</span>}
                </span>
                {contado !== null && (
                  <span>
                    <span className="text-muted-foreground">Contado na foto: </span>
                    <span className="font-semibold text-foreground">{fmtUn(contado)} un</span>
                  </span>
                )}
              </div>
              {consulta.saldo !== null && contado !== null && (
                <p className={contado > consulta.saldo ? 'text-[11px] text-foreground' : 'text-[11px] text-muted-foreground'}>
                  {contado > consulta.saldo
                    ? `Diferença: entram ${fmtUn(contado - consulta.saldo)} un no Tiny.`
                    : contado === consulta.saldo
                      ? 'Igual ao Tiny: nada a lançar.'
                      : `Tiny tem ${fmtUn(consulta.saldo - contado)} un a mais que a foto: nada é lançado nem retirado.`}
                </p>
              )}
              {consulta.aviso && <p className="text-[11px] text-amber-800 dark:text-amber-200">{consulta.aviso}</p>}
            </>
          ) : consultando ? (
            <span className="text-[11px] text-muted-foreground">Consultando o produto {sku} no Tiny…</span>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">SKU {sku}</span>
              <Button type="button" size="sm" variant="outline" className="h-7 rounded-none" onClick={() => void consultar(false)}>
                Ver produto e estoque no Tiny
              </Button>
            </div>
          )}
          {erroConsulta && <p className="text-[11px] text-destructive">{erroConsulta}</p>}
        </div>
      )}
      {!pendente && !editando && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {item.conferencia
              ? `Conferida${item.conferencia.usuario_nome ? ` por ${item.conferencia.usuario_nome}` : ''} em ${formatDataBR(item.conferencia.conferida_em)}.`
              : 'Conferida pelo operador no Telegram.'}
          </span>
          {podeConferir && (
            <Button type="button" size="sm" variant="ghost" className="h-7 rounded-none" onClick={() => setEditando(true)}>
              Alterar quantidade
            </Button>
          )}
        </div>
      )}
      {formAberto && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            {campo('Fardos', fardos, setFardos, 0)}
            <span className="pb-2 text-muted-foreground">×</span>
            {porFardoDaCor ? (
              <span className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Un. por fardo</span>
                <span className="flex h-8 items-center gap-1.5 text-sm font-semibold tabular-nums text-foreground" title={`Prendedor ${NOME_COR[item.cor!]}`}>
                  <span className={`h-2.5 w-2.5 ${COR_BOLINHA[item.cor!]}`} aria-hidden />
                  {porFardoDaCor}
                </span>
              </span>
            ) : (
              campo('Un. por fardo', porFardo, setPorFardo, 1)
            )}
            <span className="pb-2 text-muted-foreground">+</span>
            {campo('Un. soltas', soltas, setSoltas, 0)}
            <span className="pb-1.5 text-sm font-semibold tabular-nums text-foreground">= {total === null ? '—' : `${fmtUn(total)} un`}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="h-8 rounded-none" disabled={enviando || !valido}>
              {enviando ? 'Lançando no Tiny…' : nFardos === item.quantidade_detectada ? 'Confirmar' : 'Salvar correção'}
            </Button>
            {editando && (
              <Button type="button" size="sm" variant="ghost" className="h-8 rounded-none" disabled={enviando} onClick={() => setEditando(false)}>
                Cancelar
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground">O Tiny recebe só a entrada do que faltar; nada é retirado.</span>
          </div>
        </form>
      )}
      {pendente && !podeConferir && <p className="text-[11px] text-muted-foreground">Aguardando conferência.</p>}
      {erro && <p className="text-[11px] text-destructive">{erro}</p>}
    </div>
  );
}

// Situação da contagem no estoque do Tiny, com reenvio quando falhou ou nunca foi enviada.
function TinyContagem({
  item,
  service,
  podeConferir,
  onTiny,
}: {
  item: StockCountItem;
  service: StockCountService;
  podeConferir: boolean;
  onTiny: (tiny: StockCountEnvioTiny) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  if (!item.conferencia) return null;
  const tiny = item.tiny ?? null;
  const temSku = Boolean(item.codigo || item.sku_manual?.sku);

  async function reenviar() {
    setEnviando(true);
    setErro(null);
    try {
      onTiny(await service.enviarTiny(item.id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao enviar ao Tiny.');
    } finally {
      setEnviando(false);
    }
  }

  let texto: string;
  let tom = 'text-muted-foreground';
  if (!tiny) {
    texto = temSku ? 'Ainda não enviada ao Tiny.' : 'Informe o SKU para lançar no Tiny.';
    if (!temSku) tom = 'text-amber-800 dark:text-amber-200';
  } else if (tiny.status === 'lancado') {
    texto = `Tiny${tiny.produto ? ` (${tiny.produto})` : ''}: entrada de ${fmtUn(tiny.entrada ?? 0)} un (saldo era ${fmtUn(tiny.saldo_anterior ?? 0)}, contado ${fmtUn(tiny.unidades)})${tiny.deposito ? ` · ${tiny.deposito}` : ''}.`;
    tom = 'text-emerald-800 dark:text-emerald-300';
  } else if (tiny.status === 'sem_entrada') {
    texto = `Tiny já tinha ${fmtUn(tiny.saldo_anterior ?? 0)} un (contado ${fmtUn(tiny.unidades)}): nada lançado.`;
  } else {
    texto = tiny.mensagem || 'Falha no envio ao Tiny.';
    tom = 'text-destructive';
  }
  const podeReenviar = podeConferir && temSku && (!tiny || tiny.status === 'erro');

  return (
    <div className="space-y-1.5 border-t border-border pt-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-[11px] ${tom}`} title={tiny ? `Enviado em ${formatDataBR(tiny.enviado_em)}` : undefined}>
          {texto}
        </span>
        {podeReenviar && (
          <Button type="button" size="sm" variant="outline" className="h-7 rounded-none" disabled={enviando} onClick={() => void reenviar()}>
            {enviando ? 'Enviando…' : tiny ? 'Reenviar ao Tiny' : 'Enviar ao Tiny'}
          </Button>
        )}
      </div>
      {erro && <p className="text-[11px] text-destructive">{erro}</p>}
    </div>
  );
}

// SKU informado pelo painel (contagem sem produto) e exclusão da tela, com confirmação inline
// (sem window.confirm). O registro do bot não é alterado: o gateway guarda SKU e exclusão no banco.
function AcoesContagem({
  item,
  service,
  podeInformarSku,
  podeExcluir,
  onSku,
  onExcluida,
}: {
  item: StockCountItem;
  service: StockCountService;
  podeInformarSku: boolean;
  podeExcluir: boolean;
  onSku: (manual: StockCountSkuManual, tiny: StockCountEnvioTiny | null) => void;
  onExcluida: () => void;
}) {
  const [sku, setSku] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const semProduto = !item.codigo;

  async function salvarSku() {
    if (!sku.trim()) return;
    setEnviando(true);
    setErro(null);
    try {
      const res = await service.informarSku(item.id, sku);
      onSku(res.sku_manual, res.tiny);
      setSku('');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao informar o SKU.');
    } finally {
      setEnviando(false);
    }
  }

  async function excluir() {
    setEnviando(true);
    setErro(null);
    try {
      await service.excluirContagem(item.id);
      onExcluida();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao excluir a contagem.');
      setEnviando(false);
    }
  }

  if (!semProduto && !podeExcluir) return null;

  return (
    <div className="space-y-2 border-t border-border pt-2.5 text-xs">
      {semProduto && !item.sku_manual && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-amber-800 dark:text-amber-200">
            O bot não identificou o produto desta contagem (sem SKU na legenda e sem código de barras lido).
          </p>
          {podeInformarSku && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void salvarSku();
              }}
            >
              <Input
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Informe o SKU"
                maxLength={60}
                className="h-8 rounded-none font-mono text-xs"
                disabled={enviando}
              />
              <Button type="submit" size="sm" className="h-8 rounded-none" disabled={enviando || !sku.trim()}>
                Salvar SKU
              </Button>
            </form>
          )}
        </div>
      )}
      {item.sku_manual && (
        <p className="text-[11px] text-muted-foreground">
          SKU informado pelo painel{item.sku_manual.usuario_nome ? ` por ${item.sku_manual.usuario_nome}` : ''} em{' '}
          {formatDataBR(item.sku_manual.informado_em)}.
        </p>
      )}
      {podeExcluir && (
        <div className="flex items-center justify-end gap-2">
          {confirmando ? (
            <>
              <span className="text-[11px] text-muted-foreground">Tirar esta contagem da tela?</span>
              <Button type="button" size="sm" variant="outline" className="h-7 rounded-none" disabled={enviando} onClick={() => setConfirmando(false)}>
                Cancelar
              </Button>
              <Button type="button" size="sm" variant="destructive" className="h-7 rounded-none" disabled={enviando} onClick={() => void excluir()}>
                Confirmar exclusão
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 rounded-none text-muted-foreground" onClick={() => setConfirmando(true)}>
              <Trash2 size={13} /> Excluir contagem
            </Button>
          )}
        </div>
      )}
      {erro && <p className="text-[11px] text-destructive">{erro}</p>}
    </div>
  );
}

const POR_PAGINA = 12;

function Metrica({
  rotulo,
  valor,
  detalhe,
  icone: Icone,
  destaque,
}: {
  rotulo: string;
  valor: number;
  detalhe: string;
  icone: LucideIcon;
  destaque?: boolean;
}) {
  return (
    <div className={cn('metric-card', destaque && 'border-l-[3px] border-l-[var(--marca-ambar)]')}>
      <div className="metric-top">
        <span>{rotulo}</span>
        <span className="grid size-8 shrink-0 place-items-center border border-border bg-muted text-primary">
          <Icone size={17} />
        </span>
      </div>
      <div className="metric-value tabular-nums">{valor}</div>
      <div className="metric-detail text-xs">{detalhe}</div>
    </div>
  );
}

function CartaoEsqueleto() {
  return (
    <div className="border border-border bg-card" aria-hidden="true">
      <Skeleton className="h-16 rounded-none" />
      <div className="grid grid-cols-2 gap-2.5 p-4">
        <Skeleton className="aspect-[4/3] rounded-none" />
        <Skeleton className="aspect-[4/3] rounded-none" />
      </div>
      <Skeleton className="mx-4 mb-4 h-14 rounded-none" />
    </div>
  );
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{rotulo}</span>
      <div className="mt-0.5 text-xs text-foreground">{children}</div>
    </div>
  );
}

export default function StockCount({ apiBaseUrl }: StockCountProps) {
  const { can } = useAuth();
  const podeInformarSku = can('contagem_estoque:informar_sku');
  const podeExcluir = can('contagem_estoque:excluir');
  const podeConferir = can('contagem_estoque:conferir');
  const [service] = useState<StockCountService>(() => createStockCountService(apiBaseUrl));
  const [itens, setItens] = useState<StockCountItem[]>([]);
  // Unidades por fardo da conferência mais recente de cada SKU: o fardo muda de produto para
  // produto (5 ou 10), então a próxima conferência do mesmo SKU já começa com o último valor.
  const porFardoPorSku = useMemo(() => {
    const mapa = new Map<string, number>();
    const conferidas = itens
      .filter((i) => i.conferencia && skuDoItem(i))
      .sort((a, b) => (b.conferencia!.conferida_em || '').localeCompare(a.conferencia!.conferida_em || ''));
    for (const i of conferidas) {
      if (!mapa.has(skuDoItem(i))) mapa.set(skuDoItem(i), i.conferencia!.unidades_por_fardo);
    }
    return mapa;
  }, [itens]);
  const [configurado, setConfigurado] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [erro, setErro] = useState<string | null>(null);

  // Filtros de coluna
  const [colFilters, setColFilters] = useState<ColumnFiltersState>(() =>
    carregarFiltrosSession('estoque', 'contagens'),
  );
  const [pagina, setPagina] = useState<number>(1);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const [mostrarInstrucoes, setMostrarInstrucoes] = useState<boolean>(false);

  const updateColFilter = (id: string, val: ColumnFilterValue | undefined) => {
    setColFilters((prev) => {
      const proximo = { ...prev };
      if (val === undefined) {
        delete proximo[id];
      } else {
        proximo[id] = val;
      }
      salvarFiltrosSession('estoque', 'contagens', proximo);
      return proximo;
    });
    setPagina(1);
  };

  const clearFilters = () => {
    setColFilters({});
    salvarFiltrosSession('estoque', 'contagens', {});
    setPagina(1);
  };

  const filteredItens = useMemo(() => {
    return aplicaFiltros(itens, colFilters, STOCK_COUNT_DEFS);
  }, [itens, colFilters]);

  // Contagem das abas de status: aplica os demais filtros, menos o de situação.
  const contagemAbas = useMemo(() => {
    const { situacao: _situacao, ...outros } = colFilters;
    const base = aplicaFiltros(itens, outros, STOCK_COUNT_DEFS);
    const porSituacao: Record<string, number> = {};
    for (const i of base) {
      const rotulo = STOCK_COUNT_DEFS.situacao.accessor(i) as string;
      porSituacao[rotulo] = (porSituacao[rotulo] ?? 0) + 1;
    }
    return { total: base.length, porSituacao };
  }, [itens, colFilters]);
  const abaAtiva =
    Array.isArray(colFilters.situacao) && colFilters.situacao.length === 1
      ? colFilters.situacao[0]
      : Array.isArray(colFilters.situacao) && colFilters.situacao.length > 1
        ? undefined
        : null;

  const totalPaginas = Math.max(1, Math.ceil(filteredItens.length / POR_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas);

  const visiveis = useMemo(() => {
    return filteredItens.slice((paginaAtual - 1) * POR_PAGINA, paginaAtual * POR_PAGINA);
  }, [filteredItens, paginaAtual]);

  const resumo = useMemo(
    () => ({
      aguardando: filteredItens.filter((i) => i.status === 'aguardando_confirmacao').length,
      confirmadas: filteredItens.filter((i) => i.status === 'confirmada').length,
      corrigidas: filteredItens.filter((i) => i.status === 'corrigida').length,
      semSku: filteredItens.filter((i) => !i.codigo && !i.sku_manual).length,
    }),
    [filteredItens],
  );

  // Lightbox
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const fotos = useMemo<FotoRef[]>(
    () =>
      visiveis.flatMap((item) => [
        ...(item.imagem_original
          ? [{ id: item.id, tipo: 'original' as const, titulo: `Foto Original — ${item.codigo || item.id}` }]
          : []),
        {
          id: item.id,
          tipo: 'anotada' as const,
          titulo: `Contagem do Bot (${item.quantidade_detectada} un) — ${item.codigo || item.id}`,
        },
      ]),
    [visiveis],
  );
  const abrirFoto = (id: string, tipo: FotoRef['tipo']) => {
    const i = fotos.findIndex((f) => f.id === id && f.tipo === tipo);
    if (i >= 0) setLightboxIdx(i);
  };

  const [, startTransition] = useTransition();

  useEffect(() => {
    let ativo = true;
    let configuradoApi = true;
    buscarTodasPaginas(async (page) => {
      const res = await service.listarContagens({ page, pageSize: PAGINA_API });
      configuradoApi = res.configurado;
      return res;
    })
      .then((res) => {
        if (!ativo) return;
        startTransition(() => {
          setErro(null);
          setConfigurado(configuradoApi);
          setItens(res.itens);
          setLoading(false);
        });
      })
      .catch((err: unknown) => {
        if (!ativo) return;
        setErro(err instanceof Error ? err.message : 'Falha ao carregar contagens');
        setLoading(false);
      });
    return () => {
      ativo = false;
    };
  }, [service, reloadToken]);

  const recarregar = () => {
    setLoading(true);
    setReloadToken((t) => t + 1);
  };

  const handleExportCsv = () => {
    downloadCsv(
      'contagens-estoque',
      [
        'Nº', 'ID', 'Data', 'SKU', 'Situação', 'Fardos Detectados', 'Fardos Conferidos', 'Un. por Fardo', 'Un. Soltas',
        'Total Unidades', 'Tiny', 'Saldo Tiny Anterior', 'Entrada Tiny', 'Conferido Por', 'Telegram Chat',
      ],
      filteredItens.map((i) => [
        i.numero ? numeroContagem(i) : '',
        i.id,
        formatDataBR(i.criado_em),
        i.sku_manual?.sku || i.codigo || 'Sem SKU',
        i.status,
        i.quantidade_detectada,
        i.quantidade_final ?? '',
        i.conferencia?.unidades_por_fardo ?? '',
        i.conferencia?.unidades_soltas ?? '',
        i.conferencia?.unidades_total ?? '',
        i.tiny ? (i.tiny.status === 'erro' ? `erro: ${i.tiny.mensagem ?? ''}` : i.tiny.status) : '',
        i.tiny?.saldo_anterior ?? '',
        i.tiny?.entrada ?? '',
        i.conferencia?.usuario_nome ?? i.telegram_user,
        i.telegram_chat_id ?? '',
      ]),
    );
  };

  return (
    <div className="space-y-5">
      {/* Cabeçalho */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Logística</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <PackageSearch size={22} className="text-primary" />
            {stockCount.title}
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Conferência das prateleiras fotografadas pelo bot: confirme ou corrija a quantidade de cada contagem.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none text-xs"
            aria-expanded={mostrarInstrucoes}
            onClick={() => setMostrarInstrucoes(!mostrarInstrucoes)}
          >
            <Info size={14} className="mr-1.5" />
            {mostrarInstrucoes ? 'Ocultar instruções' : 'Instruções do bot'}
          </Button>
          {BOT_USERNAME && (
            <a
              href={`https://t.me/${BOT_USERNAME}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-none bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--brand-primary-hover)]"
            >
              <ExternalLink size={13} />@{BOT_USERNAME}
            </a>
          )}
        </div>
      </div>

      {/* Painel recolhível de Instruções */}
      {mostrarInstrucoes && (
        <div className="space-y-4 border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Como usar o bot</h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 rounded-none p-0"
              onClick={() => setMostrarInstrucoes(false)}
              aria-label="Fechar instruções"
            >
              <X size={14} />
            </Button>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-2 rounded-none border border-border bg-background p-3.5">
                <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-none bg-[var(--marca-ambar-suave)] text-[11px] font-bold text-[var(--accent-text)]">
                    {i + 1}
                  </span>
                  {step.title}
                </span>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 pt-1 lg:grid-cols-2">
            <div className="rounded-none border border-border bg-background p-3">
              <h3 className="mb-1 text-xs font-semibold text-foreground">Dicas para foto nítida</h3>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                {PHOTO_TIPS.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2.5 rounded-none border border-amber-500/30 bg-amber-500/5 p-3">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
              <div>
                <h3 className="mb-0.5 text-xs font-semibold text-foreground">Validação visual no estoque</h3>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Confira sempre se a quantidade numerada na imagem anotada corresponde ao lote real da prateleira antes de registrar.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Alerta de diretório não configurado */}
      {!configurado && (
        <div className="flex items-start gap-3 border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-semibold">Diretório de contagens não configurado</p>
            <p className="text-muted-foreground">
              A variável de ambiente <code className="bg-background/80 px-1 py-0.5 font-mono text-[11px]">CONTAGEM_REGISTRO_DIR</code> não está definida no Gateway.
              Monte a pasta de dados do bot do Telegram para habilitar a galeria em tempo real.
            </p>
          </div>
        </div>
      )}

      {/* Métricas: calculadas sobre a página carregada */}
      <section aria-label="Resumo das contagens">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Metrica
            rotulo="Aguardando conferência"
            valor={resumo.aguardando}
            detalhe="no filtro atual"
            icone={Clock}
            destaque={resumo.aguardando > 0}
          />
          <Metrica rotulo="Confirmadas" valor={resumo.confirmadas} detalhe="no filtro atual" icone={CheckCircle2} />
          <Metrica rotulo="Corrigidas" valor={resumo.corrigidas} detalhe="no filtro atual" icone={Pencil} />
          <Metrica
            rotulo="Sem SKU"
            valor={resumo.semSku}
            detalhe="no filtro atual, sem produto identificado"
            icone={TriangleAlert}
            destaque={resumo.semSku > 0}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Contagens exibidas: {visiveis.length} de {filteredItens.length} ({itens.length} no total).
        </p>
      </section>

      <ColumnFilterBar
        totalCount={itens.length}
        filteredCount={filteredItens.length}
        activeFiltersCount={filtrosAtivosCount(colFilters, STOCK_COUNT_DEFS)}
        onClearAll={clearFilters}
        onExportCsv={filteredItens.length > 0 ? handleExportCsv : undefined}
        itemLabel="contagens"
      />

      <div role="tablist" aria-label="Filtrar por status" className="flex flex-wrap border border-b-0 border-border bg-muted/40">
        {ABAS_STATUS.map((aba) => {
          const ativa = abaAtiva === aba.situacao;
          const n = aba.situacao ? (contagemAbas.porSituacao[aba.situacao] ?? 0) : contagemAbas.total;
          return (
            <button
              key={aba.rotulo}
              type="button"
              role="tab"
              aria-selected={ativa}
              onClick={() => updateColFilter('situacao', aba.situacao ? [aba.situacao] : undefined)}
              className={cn(
                'border-b-2 px-4 py-2.5 text-xs font-semibold outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring',
                ativa
                  ? 'border-[var(--marca-ambar)] bg-card text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {aba.rotulo} <span className="font-mono tabular-nums text-muted-foreground">· {n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-xs">
        <span className="text-muted-foreground font-medium mr-1">Filtros:</span>
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.sku}
          value={colFilters.sku}
          onChange={(v) => updateColFilter('sku', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.situacao}
          value={colFilters.situacao}
          onChange={(v) => updateColFilter('situacao', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.data}
          value={colFilters.data}
          onChange={(v) => updateColFilter('data', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.quantidade}
          value={colFilters.quantidade}
          onChange={(v) => updateColFilter('quantidade', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.usuario_origem}
          value={colFilters.usuario_origem}
          onChange={(v) => updateColFilter('usuario_origem', v)}
        />
        <div className="ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={recarregar}
            disabled={loading}
            className="h-7 text-xs"
            aria-label="Recarregar contagens"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {erro && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-800 dark:text-rose-200">
          <span>{erro}</span>
          <Button type="button" variant="outline" size="sm" className="h-7 rounded-none text-xs" onClick={recarregar}>
            Tentar novamente
          </Button>
        </div>
      )}

      {/* Lista de contagens */}
      <div className="space-y-4">
        {loading && itens.length === 0 ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" aria-busy="true" aria-label="Carregando contagens">
            {[0, 1, 2, 3].map((i) => (
              <CartaoEsqueleto key={i} />
            ))}
          </div>
        ) : filteredItens.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-border bg-card py-16 text-center text-xs text-muted-foreground">
            <PackageSearch size={32} className="mb-2 text-muted-foreground" />
            <p className="font-semibold text-foreground">Nenhuma contagem encontrada</p>
            <p className="mt-1 max-w-sm">
              {filtrosAtivosCount(colFilters, STOCK_COUNT_DEFS) > 0
                ? 'Nenhum resultado corresponde aos filtros aplicados.'
                : 'As fotos enviadas para o bot do Telegram aparecerão listadas aqui.'}
            </p>
            {filtrosAtivosCount(colFilters, STOCK_COUNT_DEFS) > 0 && (
              <Button variant="outline" size="sm" onClick={clearFilters} className="mt-3 cursor-pointer">
                Limpar filtros
              </Button>
            )}
          </div>
        ) : (
          <div className={cn('grid grid-cols-1 gap-4 xl:grid-cols-2', loading && 'opacity-60')} aria-busy={loading}>
            {visiveis.map((item) => {
              const pendente = item.status === 'aguardando_confirmacao';
              const produto = item.codigo || item.sku_manual?.sku;
              const barras = (item.codigos_barras || []).join(', ');
              return (
                <article
                  key={item.id}
                  className={cn(
                    'flex flex-col overflow-hidden border bg-card',
                    pendente ? 'border-amber-500/50 border-l-[3px] border-l-[var(--marca-ambar)]' : 'border-border',
                  )}
                >
                  {/* Identificação */}
                  <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Produto</p>
                      {produto ? (
                        <h2 className="truncate font-mono text-base font-bold text-foreground" title={produto}>
                          {produto}
                          {!item.codigo && <span className="ml-1.5 font-sans text-[10px] font-normal text-muted-foreground">(informado no painel)</span>}
                        </h2>
                      ) : (
                        <h2 className="text-base font-bold text-amber-700 dark:text-amber-300">Sem SKU</h2>
                      )}
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span className="font-mono" title={`Registro ${item.id}`}>#{numeroContagem(item)}</span>
                        <span className="flex items-center gap-1">
                          <Clock size={11} />
                          {formatDataBR(item.criado_em)}
                        </span>
                        <span>{item.telegram_user}</span>
                      </p>
                    </div>
                    {statusBadge(item.status)}
                  </header>

                  <div className="space-y-3 p-4">
                    {/* Fotos lado a lado */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Foto original</span>
                        <FotoContagem
                          service={service}
                          item={item}
                          tipo="original"
                          titulo={`Foto Original — ${item.codigo || item.id}`}
                          onAbrir={() => abrirFoto(item.id, 'original')}
                        />
                      </div>
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Foto da contagem</span>
                        <FotoContagem
                          service={service}
                          item={item}
                          tipo="anotada"
                          titulo={`Contagem do Bot (${item.quantidade_detectada} un) — ${item.codigo || item.id}`}
                          onAbrir={() => abrirFoto(item.id, 'anotada')}
                        />
                      </div>
                    </div>

                    {/* Quantidade em destaque e identificadores */}
                    <div className="grid grid-cols-[auto_1fr] gap-4 border border-border bg-muted/40 p-3">
                      <div>
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {item.quantidade_final !== null ? 'Fardos conferidos' : 'Fardos detectados'}
                        </span>
                        <span className="text-3xl font-bold leading-none tabular-nums text-foreground">
                          {item.quantidade_final ?? item.quantidade_detectada}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {(item.quantidade_final ?? item.quantidade_detectada) === 1 ? 'fardo' : 'fardos'}
                          </span>
                        </span>
                        {item.cor && item.unidades_por_fardo && (
                          <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <span className={`h-2 w-2 ${COR_BOLINHA[item.cor]}`} aria-hidden />
                            prendedor {NOME_COR[item.cor]} · {item.unidades_por_fardo} un/fardo
                          </span>
                        )}
                        {item.conferencia && (
                          <span className="mt-1 block text-[11px] tabular-nums text-foreground">
                            = {fmtUn(item.conferencia.unidades_total)} un ({item.conferencia.unidades_por_fardo}/fardo
                            {item.conferencia.unidades_soltas ? ` + ${item.conferencia.unidades_soltas} soltas` : ''})
                          </span>
                        )}
                        {item.quantidade_final !== null && item.quantidade_final !== item.quantidade_detectada && (
                          <span className="mt-1 block text-[11px] text-muted-foreground">bot detectou {item.quantidade_detectada}</span>
                        )}
                      </div>
                      <div className="grid min-w-0 content-center gap-2 sm:grid-cols-2">
                        <Campo rotulo="SKU (legenda)">
                          <span className="block truncate font-mono" title={item.sku_legenda || '—'}>
                            {item.sku_legenda || '—'}
                          </span>
                        </Campo>
                        <Campo rotulo="Código de barras">
                          <span className="block truncate font-mono" title={barras || '—'}>
                            {barras || '—'}
                          </span>
                        </Campo>
                      </div>
                    </div>

                    {item.alertas && item.alertas.length > 0 && (
                      <div className="flex items-start gap-1.5 border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200">
                        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div>
                          {item.alertas.map((a, i) => (
                            <p key={i}>{a}</p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Rodapé de ações */}
                  <footer className="mt-auto space-y-2.5 border-t border-border bg-muted/40 px-4 py-3 [&>div]:border-t-0 [&>div]:pt-0 [&>div+div]:border-t [&>div+div]:pt-2.5">
                    <ConferenciaContagem
                      key={`${item.id}-${item.status}-${item.quantidade_final ?? ''}-${item.conferencia?.unidades_total ?? ''}-${skuDoItem(item)}`}
                      item={item}
                      service={service}
                      podeConferir={podeConferir}
                      porFardoPadrao={porFardoPorSku.get(skuDoItem(item)) ?? UNIDADES_POR_FARDO_PADRAO}
                      onConferida={(conf, tiny) =>
                        setItens((lista) =>
                          lista.map((i) =>
                            i.id === item.id
                              ? {
                                  ...i,
                                  conferencia: conf,
                                  tiny: tiny ?? i.tiny ?? null,
                                  status: conf.status,
                                  quantidade_final: conf.quantidade_final,
                                  concluido_em: conf.conferida_em,
                                }
                              : i,
                          ),
                        )
                      }
                    />
                    <TinyContagem
                      item={item}
                      service={service}
                      podeConferir={podeConferir}
                      onTiny={(tiny) => setItens((lista) => lista.map((i) => (i.id === item.id ? { ...i, tiny } : i)))}
                    />
                    <AcoesContagem
                      item={item}
                      service={service}
                      podeInformarSku={podeInformarSku}
                      podeExcluir={podeExcluir}
                      onSku={(manual, tiny) =>
                        setItens((lista) =>
                          lista.map((i) => (i.id === item.id ? { ...i, sku_manual: manual, tiny: tiny ?? i.tiny ?? null } : i)),
                        )
                      }
                      onExcluida={() => {
                        setItens((lista) => lista.filter((i) => i.id !== item.id));
                      }}
                    />
                  </footer>
                </article>
              );
            })}
          </div>
        )}

        {/* Paginação */}
        {filteredItens.length > POR_PAGINA && (
          <div className="flex items-center justify-between border border-border bg-card p-3 text-xs">
            <span className="text-muted-foreground">
              Página {paginaAtual} de {totalPaginas}
            </span>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" className="rounded-none text-xs" disabled={paginaAtual <= 1 || loading} onClick={() => setPagina((p) => Math.max(1, p - 1))}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" className="rounded-none text-xs" disabled={paginaAtual * POR_PAGINA >= filteredItens.length || loading} onClick={() => setPagina((p) => p + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </div>

      {lightboxIdx !== null && (
        <FotoLightbox
          service={service}
          fotos={fotos}
          indice={Math.min(lightboxIdx, Math.max(0, fotos.length - 1))}
          onIndice={setLightboxIdx}
          onFechar={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}
