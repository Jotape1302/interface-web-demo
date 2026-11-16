'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Ruler,
  Send,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatDateTimeBR } from '@/lib/formatters';
import { padronizacaoDimensoes } from '@/lib/automations';
import type { AnuncioDimensoes, AnuncioSemSku, DimensoesStatus, ProdutoDimensoes } from '@/lib/dimensoes-contracts';
import type { Medidas } from '@/lib/fretes-contracts';
import {
  ATRIBUTO_ROTULO,
  SITUACAO_ANUNCIO_INFO,
  STATUS_PADRONIZACAO_INFO,
  podeConfirmar,
  valorAtributo,
} from '@/lib/dimensoes-helpers';
import { formatMedidas } from '@/lib/fretes-helpers';
import { createDimensoesService, type DimensoesService } from '@/lib/dimensoes-service';
import { useDataPolling } from '@/lib/use-data-polling';
import { Empty, SourceError } from './panel-state';
import { ReportarErro } from '@/components/reportar-erro';
import { linkExternoSeguro } from '@/lib/session-guard';
import { useAuth } from '@/lib/auth-context';
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
import { TIPOS_SKU, contarTiposSku, tipoSku, type TipoSku } from '@/lib/sku-tipo';

// A API do marketplace aceita no máximo 200 por página (acima disso responde 422).
const PAGINA_API = 200;

/** Atalhos dos indicadores: cada um troca os filtros de situação e envio. */
type AtalhoDimensoes = { situacao?: string[]; envio?: string[] };
const ATALHOS_KPI: Record<string, AtalhoDimensoes> = {
  pendente: { situacao: [STATUS_PADRONIZACAO_INFO.pendente.label] },
  bloqueado: { situacao: [STATUS_PADRONIZACAO_INFO.bloqueado.label] },
  sem_medida: { situacao: [STATUS_PADRONIZACAO_INFO.sem_medida.label] },
  padronizado: { situacao: [STATUS_PADRONIZACAO_INFO.padronizado.label] },
  erro: { envio: ['Erro'] },
};

function mesmaLista(a: unknown, b: string[] | undefined): boolean {
  const lista = Array.isArray(a) ? (a as string[]) : [];
  const alvo = b ?? [];
  return lista.length === alvo.length && alvo.every((v) => lista.includes(v));
}

const PAGE_SIZE = 30;
const LOTE_ENVIO = 200; // máximo de produtos por envio aceito pelo marketplace

const ENVIO_ROTULO: Record<string, string> = { ok: 'Enviado', erro: 'Erro', bloqueado: 'Bloqueado no ML', enviando: 'Enviando', nenhum: 'Sem envio' };

const DIMENSOES_DEFS: Record<string, ColumnFilterDef<ProdutoDimensoes>> = {
  sku_descricao: {
    id: 'sku_descricao',
    label: 'SKU / Título / MLB',
    tipo: 'texto',
    accessor: (p) => `${p.sku} ${p.descricao} ${p.anuncios.map((a) => `${a.mlb} ${a.titulo}`).join(' ')}`,
  },
  tipo_sku: {
    id: 'tipo_sku',
    label: 'Tipo de SKU',
    tipo: 'lista',
    accessor: (p) => tipoSku(p.sku),
    opcoes: [...TIPOS_SKU],
  },
  situacao: {
    id: 'situacao',
    label: 'Situação',
    tipo: 'lista',
    accessor: (p) => STATUS_PADRONIZACAO_INFO[p.status]?.label ?? p.status,
    opcoes: Object.values(STATUS_PADRONIZACAO_INFO).map((s) => s.label),
  },
  envio: {
    id: 'envio',
    label: 'Envio',
    tipo: 'lista',
    accessor: (p) => ENVIO_ROTULO[p.envio?.status ?? 'nenhum'] ?? p.envio?.status ?? '',
    opcoes: Object.values(ENVIO_ROTULO),
  },
  medidas: {
    id: 'medidas',
    label: 'Medidas do Tiny',
    tipo: 'texto',
    accessor: (p) => p.tiny.map((t) => `${formatMedidas(t.medidas)} ${t.medidas.peso ?? ''}g`).join(' '),
  },
};

const FILTROS_PADRAO_DIMENSOES: ColumnFiltersState = {
  situacao: [STATUS_PADRONIZACAO_INFO.pendente.label],
};

function pesoTexto(p: number | null | undefined): string {
  return p ? `${p.toLocaleString('pt-BR')} g` : '—';
}

function embalagemTexto(m: Medidas | null | undefined): string {
  if (!m || [m.altura, m.largura, m.comprimento].some((v) => v == null)) return 'vazia';
  return `${formatMedidas(m)} · ${pesoTexto(m.peso)}`;
}

const filialRotulo = (f: string) => (f === 'norvia' ? 'Norvia Campinas' : 'Revesta');

// -----------------------------------------------------------------------------------------
// Anúncio dentro do card: ficha e embalagem no ML → o que vem do Tiny
// -----------------------------------------------------------------------------------------

function DeDiferente({ de, para, difere }: { de: string; para: string; difere: boolean }) {
  if (!difere) return <span className="text-foreground">{para}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-rose-600 line-through decoration-rose-400/60 dark:text-rose-400">{de}</span>
      <ArrowRight size={11} className="shrink-0 text-muted-foreground" />
      <span className="font-semibold text-foreground">{para}</span>
    </span>
  );
}

function LinhaAnuncio({ a }: { a: AnuncioDimensoes }) {
  const info = SITUACAO_ANUNCIO_INFO[a.situacao];
  const diferentes = new Set(a.ficha_diferente ?? []);
  const atributos = Object.keys(a.ficha_alvo).length ? Object.keys(a.ficha_alvo) : a.atributos;
  return (
    <TableRow>
      <TableCell className="max-w-64 align-top">
        <p className="line-clamp-2 text-[11px] text-foreground" title={a.titulo}>
          {a.titulo}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
          {a.permalink ? (
            <a href={linkExternoSeguro(a.permalink)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-foreground">
              {a.mlb}
              <ExternalLink size={10} />
            </a>
          ) : (
            <span className="font-mono">{a.mlb}</span>
          )}
          <span>· {filialRotulo(a.filial)}</span>
        </p>
      </TableCell>
      <TableCell className="align-top font-mono text-[11px]">
        {atributos.length === 0 ? (
          <span className="text-muted-foreground">sem atributos de medida</span>
        ) : (
          <ul className="space-y-0.5">
            {atributos.map((attr) => (
              <li key={attr} className="whitespace-nowrap">
                <span className="font-sans text-muted-foreground">{ATRIBUTO_ROTULO[attr] ?? attr}: </span>
                {attr in a.ficha_alvo ? (
                  <DeDiferente
                    de={valorAtributo(attr, a.ficha_atual?.[attr])}
                    para={valorAtributo(attr, a.ficha_alvo[attr])}
                    difere={diferentes.has(attr)}
                  />
                ) : (
                  valorAtributo(attr, a.ficha_atual?.[attr])
                )}
              </li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell className="align-top font-mono text-[11px]">
        {a.embalagem_alvo ? (
          <DeDiferente de={embalagemTexto(a.embalagem_ml)} para={embalagemTexto(a.embalagem_alvo)} difere={Boolean(a.embalagem_diferente)} />
        ) : (
          <span className="text-muted-foreground">{embalagemTexto(a.embalagem_ml)}</span>
        )}
      </TableCell>
      <TableCell className="max-w-56 align-top">
        <Badge variant={info.variant} className="text-[10px]">
          {info.label}
        </Badge>
        {a.mensagem && <p className="mt-1 text-[10px] text-muted-foreground">{a.mensagem}</p>}
      </TableCell>
    </TableRow>
  );
}

// -----------------------------------------------------------------------------------------
// Card de um produto
// -----------------------------------------------------------------------------------------

const ProdutoCard = memo(function ProdutoCard({
  p,
  selecionado,
  onSelecionar,
  onConfirmar,
  ocupado,
  canValidar,
  canReenviar,
}: {
  p: ProdutoDimensoes;
  selecionado: boolean;
  onSelecionar: (sku: string, v: boolean) => void;
  onConfirmar: (sku: string, reenvio: boolean) => void;
  ocupado: boolean;
  /** Sessão tem dimensoes:validar / dimensoes:reenviar. */
  canValidar: boolean;
  canReenviar: boolean;
}) {
  const st = STATUS_PADRONIZACAO_INFO[p.status];
  const confirmavel = podeConfirmar(p);
  const comErro = p.envio?.status === 'erro';
  const aEnviar = p.anuncios.filter((a) => a.situacao === 'diferente').length;
  const destinos = Object.entries(p.envio?.destinos ?? {});
  const podeAgir = confirmavel && (comErro ? canReenviar : canValidar);

  return (
    <article className="space-y-3 rounded-none border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {podeAgir && !comErro && (
            <Checkbox
              checked={selecionado}
              onCheckedChange={(v) => onSelecionar(p.sku, Boolean(v))}
              disabled={ocupado}
              aria-label={`Selecionar ${p.sku}`}
              className="mt-1 shrink-0"
            />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground" title={p.descricao}>
              {p.descricao}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground">{p.sku}</span>
              <span>·</span>
              <span>
                {p.anuncios.length} anúncio(s) no ML{aEnviar > 0 && ` · ${aEnviar} a enviar`}
              </span>
            </p>
          </div>
        </div>
        <Badge variant={st.variant} className="shrink-0 text-[10px]">
          {st.label}
        </Badge>
      </header>

      {p.tiny.length > 0 && (
        <ul className="space-y-0.5 rounded-none bg-muted/40 p-2.5 text-[11px]">
          {p.tiny.map((t) => (
            <li key={t.conta} className="flex flex-wrap gap-x-1.5">
              <span className="font-medium text-foreground">{t.rotulo}</span>
              <span className="font-mono text-foreground">
                {formatMedidas(t.medidas)} · peso bruto {pesoTexto(t.medidas.peso)}
              </span>
              {t.peso_liquido != null && <span className="text-muted-foreground">(líquido {pesoTexto(t.peso_liquido)})</span>}
            </li>
          ))}
        </ul>
      )}

      {p.motivos.length > 0 && (
        <ul className="space-y-1 rounded-none bg-rose-500/5 p-2.5 text-xs text-rose-700 dark:text-rose-300">
          {p.motivos.map((m) => (
            <li key={m} className="flex gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {m}
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-x-auto rounded-none border border-border/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[11px]">Anúncio</TableHead>
              <TableHead className="text-[11px]">Ficha técnica</TableHead>
              <TableHead className="text-[11px]">Embalagem</TableHead>
              <TableHead className="text-[11px]">Situação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.anuncios.map((a) => (
              <LinhaAnuncio key={`${a.filial}:${a.mlb}`} a={a} />
            ))}
          </TableBody>
        </Table>
      </div>

      {podeAgir && (
        <div className="flex justify-end">
          <Button type="button" size="sm" variant={comErro ? 'outline' : 'default'} onClick={() => onConfirmar(p.sku, comErro)} disabled={ocupado}>
            {ocupado ? <Loader2 size={14} className="animate-spin" /> : comErro ? <RotateCcw size={14} /> : <Send size={14} />}
            {comErro ? 'Reenviar ao ML' : 'Confirmar envio ao ML'}
          </Button>
        </div>
      )}

      {p.envio && (
        <div className="space-y-1 rounded-none bg-muted/40 p-2.5 text-[11px]">
          <p className="font-semibold text-foreground">
            {p.envio.status === 'enviando'
              ? 'Enviando ao Mercado Livre…'
              : p.envio.status === 'ok'
                ? 'Enviado ao Mercado Livre'
                : p.envio.status === 'bloqueado'
                  ? 'O Mercado Livre não aceitou alterar este anúncio agora'
                  : 'Envio com falha em algum anúncio'}
            {p.envio.em && <span className="font-normal text-muted-foreground"> · {formatDateTimeBR(p.envio.em)}</span>}
            {p.envio.por && <span className="font-normal text-muted-foreground"> · confirmado por {p.envio.por}</span>}
          </p>
          {destinos.map(([k, d]) => (
            <p key={k} className="flex items-start gap-1.5">
              {d.status === 'ok' ? (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
              ) : d.status === 'bloqueado' ? (
                <Ban size={12} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
              ) : (
                <XCircle size={12} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
              )}
              <span>
                <span className="font-medium text-foreground">{d.local}</span>
                {d.mensagem && <span className="text-muted-foreground"> — {d.mensagem}</span>}
              </span>
            </p>
          ))}
          {comErro && (
            <ReportarErro
              className="mt-1"
              automationId="dimension-standardization"
              executionId={`sku-${p.sku}`}
              stoppedNode="Envio das medidas ao Mercado Livre"
              errorMessage={
                destinos
                  .filter(([, d]) => d.status === 'erro' && d.mensagem)
                  .map(([, d]) => `${d.local}: ${d.mensagem}`)
                  .join('\n') || 'Envio com falha em algum anúncio'
              }
            />
          )}
        </div>
      )}
    </article>
  );
});

// -----------------------------------------------------------------------------------------
// Tela
// -----------------------------------------------------------------------------------------

export default function DimensoesView({ apiBaseUrl }: { apiBaseUrl?: string }) {
  const service: DimensoesService = useMemo(() => createDimensoesService(apiBaseUrl), [apiBaseUrl]);
  // Ações só com a permissão (o gateway barra do mesmo jeito).
  const { can } = useAuth();
  const canValidar = can('dimensoes:validar');
  const canReenviar = can('dimensoes:reenviar');
  const canColetar = can('dimensoes:executar');
  const [status, setStatus] = useState<DimensoesStatus | null>(null);
  const [abaAtiva, setAbaAtiva] = useState<'produtos' | 'sem_sku'>('produtos');
  // Chave nova: os filtros salvos da versão anterior (Pendente/Divergente) não existem mais.
  const [colFilters, setColFilters] = useState<ColumnFiltersState>(() =>
    carregarFiltrosSession('dimensoes', 'produtos-tiny', FILTROS_PADRAO_DIMENSOES),
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [todosItens, setTodosItens] = useState<ProdutoDimensoes[] | null>(null);
  const [semSku, setSemSku] = useState<AnuncioSemSku[] | null>(null);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [ocupados, setOcupados] = useState<Set<string>>(new Set());
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarregar, setRecarregar] = useState(0);
  const [coletando, setColetando] = useState(false);

  const updateColFilter = (id: string, val: ColumnFilterValue | undefined) => {
    setColFilters((prev) => {
      const proximo = { ...prev };
      if (val === undefined) {
        delete proximo[id];
      } else {
        proximo[id] = val;
      }
      salvarFiltrosSession('dimensoes', 'produtos-tiny', proximo);
      return proximo;
    });
    setVisibleCount(PAGE_SIZE);
  };

  const clearFilters = () => {
    setColFilters({});
    salvarFiltrosSession('dimensoes', 'produtos-tiny', {});
    setVisibleCount(PAGE_SIZE);
  };

  // Uma carga por vez: recarregar (ou desmontar) aborta a anterior e descarta o que ela devolver.
  const cargaRef = useRef<AbortController | null>(null);
  const carregar = useCallback(async () => {
    cargaRef.current?.abort();
    const controller = new AbortController();
    cargaRef.current = controller;
    const { signal } = controller;
    try {
      const st = await service.status(signal);
      if (signal.aborted) return;
      setStatus(st);
      const [prodRes, semSkuRes] = await Promise.all([
        buscarTodasPaginas((page) => service.produtos({ page, pageSize: PAGINA_API }, signal)),
        service.semSku(signal),
      ]);
      if (signal.aborted) return;
      setTodosItens(prodRes.itens);
      setSemSku(semSkuRes.itens);
      setErro(null);
    } catch (e) {
      if (signal.aborted) return;
      setErro(e instanceof Error ? e.message : 'Falha ao carregar a padronização de dimensões.');
    }
  }, [service]);

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    void carregar();
    return () => cargaRef.current?.abort();
  }, [carregar, recarregar]);

  // Coleta rodando ou envio em andamento: acompanha com suspensão em aba oculta.
  useDataPolling(
    async () => {
      setRecarregar((n) => n + 1);
    },
    {
      intervalMs: 8000,
      enabled: Boolean(status?.em_execucao || status?.enviando),
      pauseOnHidden: true,
      refetchOnVisible: true,
    },
  );

  const filteredItens = useMemo(() => {
    return aplicaFiltros(todosItens ?? [], colFilters, DIMENSOES_DEFS);
  }, [todosItens, colFilters]);

  const visibleItens = useMemo(() => {
    return filteredItens.slice(0, visibleCount);
  }, [filteredItens, visibleCount]);

  // Grupos por formato do SKU (Final MP / Possui "-" / Outros); é o mesmo filtro "Tipo de SKU".
  const contagemTipoSku = useMemo(() => contarTiposSku((todosItens ?? []).map((p) => p.sku)), [todosItens]);
  const tiposSkuAtivos = Array.isArray(colFilters.tipo_sku) ? (colFilters.tipo_sku as string[]) : [];
  const tipoSkuAtivo: TipoSku | null = tiposSkuAtivos.length === 1 ? (tiposSkuAtivos[0] as TipoSku) : null;

  /** Confirma o envio (ou reenvio) ao ML das medidas do Tiny; segue em segundo plano. */
  const confirmar = useCallback(async (skus: string[], reenvio = false) => {
    setOcupados((o) => new Set([...o, ...skus]));
    setErro(null);
    setAviso(null);
    try {
      const r = reenvio ? await service.reenviar(skus) : await service.validar(skus);
      setAviso(
        `${r.aceitos.length} produto(s) ${reenvio ? 'reenviado(s)' : 'confirmado(s)'}: as medidas do Tiny seguem para a ficha e a embalagem dos anúncios no Mercado Livre em segundo plano.` +
          (r.recusados.length ? ` Não enviados: ${r.recusados.join('; ')}.` : ''),
      );
      setSelecionados(new Set());
      setRecarregar((n) => n + 1);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao confirmar o envio.');
    } finally {
      setOcupados((o) => new Set([...o].filter((s) => !skus.includes(s))));
    }
  }, [service]);

  const selecionarSku = useCallback((sku: string, marcado: boolean) => {
    setSelecionados((sel) => {
      const novo = new Set(sel);
      if (marcado) novo.add(sku);
      else novo.delete(sku);
      return novo;
    });
  }, []);
  const confirmarProduto = useCallback((sku: string, reenvio: boolean) => void confirmar([sku], reenvio), [confirmar]);

  async function coletar() {
    setColetando(true);
    try {
      await service.executar();
      setTimeout(() => setRecarregar((n) => n + 1), 1500);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao iniciar a coleta.');
    } finally {
      setColetando(false);
    }
  }

  const porStatus = status?.por_status ?? {};
  const kpis = [
    {
      id: 'pendente',
      label: 'A enviar ao ML',
      valor: porStatus.pendente ?? 0,
      detalhe: status ? `${status.anuncios_a_enviar.toLocaleString('pt-BR')} anúncio(s)` : null,
      tom: 'text-amber-700 dark:text-amber-400',
    },
    { id: 'bloqueado', label: 'Bloqueado no ML', valor: porStatus.bloqueado ?? 0, detalhe: null, tom: 'text-amber-700 dark:text-amber-400' },
    { id: 'sem_medida', label: 'Sem medida no Tiny', valor: porStatus.sem_medida ?? 0, detalhe: null, tom: 'text-rose-600 dark:text-rose-400' },
    { id: 'padronizado', label: 'Iguais ao Tiny', valor: porStatus.padronizado ?? 0, detalhe: null, tom: 'text-foreground' },
    { id: 'erro', label: 'Erro no envio', valor: status?.com_erro_de_envio ?? 0, detalhe: null, tom: 'text-rose-600 dark:text-rose-400' },
  ];

  // Indicador clicado: aplica o atalho mantendo os filtros de texto (SKU, medidas).
  const aplicarAtalho = (id: string) => {
    const atalho = ATALHOS_KPI[id];
    if (!atalho) return;
    setColFilters((prev) => {
      const proximo: ColumnFiltersState = { ...prev };
      for (const campo of ['situacao', 'envio'] as const) {
        if (atalho[campo]) proximo[campo] = atalho[campo];
        else delete proximo[campo];
      }
      salvarFiltrosSession('dimensoes', 'produtos-tiny', proximo);
      return proximo;
    });
    setVisibleCount(PAGE_SIZE);
  };
  const atalhoAtivo = Object.entries(ATALHOS_KPI).find(([, a]) =>
    (['situacao', 'envio'] as const).every((campo) => mesmaLista(colFilters[campo], a[campo])),
  )?.[0];

  // Confirmação em lote: só os produtos a enviar que estão no filtro atual (com erro = reenvio).
  const confirmaveis = filteredItens.filter((p) => podeConfirmar(p) && p.envio?.status !== 'erro' && canValidar);
  const comErroVisiveis = filteredItens.filter((p) => podeConfirmar(p) && p.envio?.status === 'erro').map((p) => p.sku);
  const selecionadosVisiveis = confirmaveis.filter((p) => selecionados.has(p.sku));
  const todosSelecionados = selecionadosVisiveis.length > 0 && selecionadosVisiveis.length === Math.min(confirmaveis.length, LOTE_ENVIO);
  const loteGrandeDemais = selecionadosVisiveis.length > LOTE_ENVIO;
  // O marketplace aceita no máximo LOTE_ENVIO produtos por envio: a seleção anda de 200 em 200.
  const proximos = confirmaveis.filter((p) => !selecionados.has(p.sku)).slice(0, LOTE_ENVIO);
  const anunciosSelecionados = selecionadosVisiveis.reduce((n, p) => n + p.anuncios.filter((a) => a.situacao === 'diferente').length, 0);
  const ultima = status?.ultima_execucao;

  const handleExportCsv = () => {
    downloadCsv(
      'produtos-dimensoes',
      ['SKU', 'Descrição', 'Situação', 'Anúncio', 'Conta', 'Tiny', 'Altura', 'Largura', 'Comprimento', 'Peso bruto (g)', 'Situação do anúncio', 'Diferenças', 'Envio'],
      filteredItens.flatMap((p) =>
        p.anuncios.map((a) => [
          p.sku,
          p.descricao,
          STATUS_PADRONIZACAO_INFO[p.status]?.label ?? p.status,
          a.mlb,
          filialRotulo(a.filial),
          a.conta_tiny,
          a.alvo?.altura ?? '',
          a.alvo?.largura ?? '',
          a.alvo?.comprimento ?? '',
          a.alvo?.peso ?? '',
          SITUACAO_ANUNCIO_INFO[a.situacao]?.label ?? a.situacao,
          a.diferencas.join(' | ') || a.mensagem || '',
          ENVIO_ROTULO[p.envio?.status ?? 'nenhum'] ?? '',
        ]),
      ),
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Marketplace</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <Ruler size={22} className="text-primary" />
            {padronizacaoDimensoes.title}
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            O Tiny é a fonte das medidas: para cada anúncio do Mercado Livre, a coleta pega o SKU e lê no Tiny da mesma empresa
            altura, largura, comprimento e peso bruto. Os anúncios diferentes ficam aqui para você confirmar o envio: a ficha
            técnica recebe as medidas nos atributos que o anúncio já usa e a embalagem recebe as mesmas medidas do Tiny, com o
            peso bruto. Nada é gravado no Tiny.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRecarregar((n) => n + 1)}>
              <RefreshCw size={14} />
              Atualizar
            </Button>
            {canColetar && (
              <Button type="button" size="sm" onClick={() => void coletar()} disabled={coletando || Boolean(status?.em_execucao)}>
                {status?.em_execucao || coletando ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                {status?.em_execucao ? 'Coletando…' : 'Coletar agora'}
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {ultima ? `Última coleta: ${formatDateTimeBR(ultima.concluida_em)}` : 'Nenhuma coleta ainda'}
            {status && ` · próxima: ${formatDateTimeBR(status.proxima_execucao)}`}
          </p>
          {status && status.contas_tiny.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {status.contas_tiny.map((c) => `ML ${filialRotulo(c.filial)} → ${c.rotulo}`).join(' · ')}
            </p>
          )}
          {status?.em_execucao && (
            <p className="text-[11px] font-medium text-foreground">
              Coletando desde {formatDateTimeBR(status.em_execucao)}
              {status.progresso &&
                ` · ${status.progresso.etapa}` +
                  (status.progresso.total
                    ? `: ${status.progresso.feitos.toLocaleString('pt-BR')} de ${status.progresso.total.toLocaleString('pt-BR')}`
                    : '…')}
            </p>
          )}
        </div>
      </div>

      {erro && <SourceError message={erro} reportar={{ automationId: 'dimension-standardization', executionId: 'painel' }} />}
      {status && !status.banco_configurado && (
        <div role="alert" className="rounded-none border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          O MariaDB não está configurado na automação (variáveis DB_*): sem ele não há token do Tiny e a coleta não lê as
          medidas.
        </div>
      )}
      {ultima && ultima.resumo.erros.length > 0 && (
        <div role="alert" className="rounded-none border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300">
          <p className="font-semibold">A última coleta teve falhas:</p>
          <ul className="mt-1 list-disc pl-4">
            {ultima.resumo.erros.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <ReportarErro
            className="mt-2"
            automationId="dimension-standardization"
            executionId={`coleta-${ultima.iniciada_em}`}
            stoppedNode="Coleta"
            errorMessage={ultima.resumo.erros.join('\n')}
          />
        </div>
      )}
      {aviso && (
        <p className="flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
          {aviso}
        </p>
      )}

      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Button
          type="button"
          size="sm"
          variant={abaAtiva === 'produtos' ? 'default' : 'outline'}
          onClick={() => setAbaAtiva('produtos')}
          className="cursor-pointer"
        >
          Produtos ({todosItens?.length ?? 0})
        </Button>
        <Button
          type="button"
          size="sm"
          variant={abaAtiva === 'sem_sku' ? 'default' : 'outline'}
          onClick={() => setAbaAtiva('sem_sku')}
          className="cursor-pointer"
        >
          Anúncios sem SKU ({status?.anuncios_sem_sku ?? semSku?.length ?? 0})
        </Button>
      </div>

      {abaAtiva === 'sem_sku' ? (
        !semSku ? (
          <Skeleton className="h-64 w-full" />
        ) : semSku.length === 0 ? (
          <Empty>Todos os anúncios do Mercado Livre têm SKU.</Empty>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Estes anúncios não têm SKU no Mercado Livre, então não dá para achar o produto no Tiny. Cadastre o SKU no anúncio
              e rode a coleta de novo.
            </p>
            <div className="overflow-x-auto rounded-none border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Anúncio</TableHead>
                    <TableHead>Conta</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {semSku.map((a) => (
                    <TableRow key={`${a.filial}:${a.mlb}`}>
                      <TableCell>
                        <p className="text-sm text-foreground">{a.titulo}</p>
                        {a.permalink ? (
                          <a href={linkExternoSeguro(a.permalink)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">
                            {a.mlb}
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <span className="font-mono text-[11px] text-muted-foreground">{a.mlb}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{filialRotulo(a.filial)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
            <legend className="float-left mr-1 text-xs font-medium text-muted-foreground">Tipo de SKU:</legend>
            <Button
              type="button"
              size="sm"
              variant={tiposSkuAtivos.length === 0 ? 'default' : 'outline'}
              onClick={() => updateColFilter('tipo_sku', undefined)}
              aria-pressed={tiposSkuAtivos.length === 0}
              className="cursor-pointer"
            >
              Todos ({todosItens?.length ?? 0})
            </Button>
            {TIPOS_SKU.map((t) => (
              <Button
                key={t}
                type="button"
                size="sm"
                variant={tipoSkuAtivo === t ? 'default' : 'outline'}
                onClick={() => updateColFilter('tipo_sku', tipoSkuAtivo === t ? undefined : [t])}
                aria-pressed={tipoSkuAtivo === t}
                className="cursor-pointer"
              >
                {t} ({contagemTipoSku[t]})
              </Button>
            ))}
          </fieldset>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {kpis.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => aplicarAtalho(k.id)}
                aria-pressed={atalhoAtivo === k.id}
                className={cn(
                  'cursor-pointer rounded-none border bg-card p-3 text-left transition hover:border-foreground/30',
                  atalhoAtivo === k.id ? 'border-foreground/40 ring-1 ring-foreground/20' : 'border-border',
                )}
              >
                <p className="text-[11px] text-muted-foreground">{k.label}</p>
                {status ? (
                  <p className={cn('text-xl font-bold tabular-nums', k.tom)}>
                    {k.valor.toLocaleString('pt-BR')}
                    {k.detalhe && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{k.detalhe}</span>}
                  </p>
                ) : (
                  <Skeleton className="mt-1 h-7 w-12" />
                )}
              </button>
            ))}
          </div>

          <ColumnFilterBar
            totalCount={todosItens?.length ?? 0}
            filteredCount={filteredItens.length}
            activeFiltersCount={filtrosAtivosCount(colFilters, DIMENSOES_DEFS)}
            onClearAll={clearFilters}
            onExportCsv={filteredItens.length > 0 ? handleExportCsv : undefined}
            itemLabel="produtos"
          />

          <div className="flex flex-wrap items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-xs">
            <span className="mr-1 font-medium text-muted-foreground">Filtros:</span>
            {(['sku_descricao', 'tipo_sku', 'situacao', 'envio', 'medidas'] as const).map((id) => (
              <ColumnFilterHeader key={id} def={DIMENSOES_DEFS[id]} value={colFilters[id]} onChange={(v) => updateColFilter(id, v)} />
            ))}
          </div>

          {(confirmaveis.length > 0 || (comErroVisiveis.length > 0 && canReenviar)) && (
            <div className="flex flex-wrap items-center gap-3 border-y border-border py-2 text-xs">
              {confirmaveis.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                  <Checkbox
                    checked={todosSelecionados}
                    onCheckedChange={(v) => setSelecionados(v ? new Set(confirmaveis.slice(0, LOTE_ENVIO).map((p) => p.sku)) : new Set())}
                    aria-label="Selecionar todos os produtos a enviar"
                  />
                  {confirmaveis.length > LOTE_ENVIO ? `Selecionar os primeiros ${LOTE_ENVIO}` : 'Selecionar todos'} ({selecionadosVisiveis.length} de{' '}
                  {confirmaveis.length})
                </label>
              )}
              {confirmaveis.length > LOTE_ENVIO && proximos.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelecionados(new Set(proximos.map((p) => p.sku)))}
                  disabled={ocupados.size > 0}
                >
                  Selecionar os próximos {proximos.length} itens
                </Button>
              )}
              {selecionadosVisiveis.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void confirmar(selecionadosVisiveis.map((p) => p.sku))}
                  disabled={ocupados.size > 0 || loteGrandeDemais}
                  title={loteGrandeDemais ? `No máximo ${LOTE_ENVIO} produtos por envio.` : undefined}
                >
                  <Send size={14} />
                  Confirmar envio ao ML ({selecionadosVisiveis.length} produto(s), {anunciosSelecionados} anúncio(s))
                </Button>
              )}
              {comErroVisiveis.length > 0 && canReenviar && (
                <Button type="button" size="sm" variant="outline" onClick={() => void confirmar(comErroVisiveis.slice(0, LOTE_ENVIO), true)} disabled={ocupados.size > 0}>
                  <RotateCcw size={14} />
                  Reenviar com erro ({Math.min(comErroVisiveis.length, LOTE_ENVIO)}
                  {comErroVisiveis.length > LOTE_ENVIO ? ` de ${comErroVisiveis.length}` : ''})
                </Button>
              )}
            </div>
          )}

          {!todosItens ? (
            <Skeleton className="h-64 w-full" />
          ) : filteredItens.length === 0 ? (
            <Empty>
              {todosItens.length === 0
                ? 'Nenhuma coleta ainda: clique em "Coletar agora" para ler os anúncios do Mercado Livre e as medidas do Tiny.'
                : 'Nenhum produto corresponde aos filtros selecionados.'}
            </Empty>
          ) : (
            <>
              <div className="grid gap-3 2xl:grid-cols-2">
                {visibleItens.map((p) => (
                  <ProdutoCard
                    key={p.sku}
                    p={p}
                    selecionado={selecionados.has(p.sku)}
                    ocupado={ocupados.has(p.sku)}
                    onSelecionar={selecionarSku}
                    onConfirmar={confirmarProduto}
                    canValidar={canValidar}
                    canReenviar={canReenviar}
                  />
                ))}
              </div>
              {visibleItens.length < filteredItens.length && (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                    className="cursor-pointer"
                  >
                    Carregar mais ({visibleItens.length} de {filteredItens.length})
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
