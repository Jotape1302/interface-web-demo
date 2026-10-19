'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  History,
  ListChecks,
  Loader2,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatDateTimeBR } from '@/lib/formatters';
import { fretesACombinar } from '@/lib/automations';
import type { AnuncioFrete, FretesStatus, HistoricoFretes, TrocaFrete } from '@/lib/fretes-contracts';
import { SITUACAO_INFO, formatMedidas, rotuloModo } from '@/lib/fretes-helpers';
import { createFretesService, type FretesService } from '@/lib/fretes-service';
import { useDataPolling } from '@/lib/use-data-polling';
import { Empty, SourceError } from './panel-state';
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

// A API do marketplace aceita no máximo 200 por página (acima disso responde 422).
const PAGINA_API = 200;

type Aba = 'anuncios' | 'desfeitos' | 'historico';
const PAGE_SIZE = 50;

const FRETES_DEFS: Record<string, ColumnFilterDef<AnuncioFrete>> = {
  anuncio: {
    id: 'anuncio',
    label: 'Anúncio / SKU / MLB',
    tipo: 'texto',
    accessor: (a) => `${a.sku || ''} ${a.mlb} ${a.titulo}`,
  },
  filial: {
    id: 'filial',
    label: 'Conta',
    tipo: 'lista',
    accessor: (a) => (a.filial === 'norvia' ? 'Norvia Campinas' : 'Revesta'),
    opcoes: ['Norvia Campinas', 'Revesta'],
  },
  modo_envio: {
    id: 'modo_envio',
    label: 'Tipo de envio',
    tipo: 'lista',
    accessor: (a) => rotuloModo(a.modo_envio),
    opcoes: ['A combinar', 'ME1', 'ME2', 'Personalizado'],
  },
  dimensoes: {
    id: 'dimensoes',
    label: 'Dimensões padronizadas',
    tipo: 'texto',
    accessor: (a) => (a.padrao ? `${formatMedidas(a.padrao)} ${a.embalagem ? a.embalagem.comprimento : ''}` : '—'),
  },
  situacao: {
    id: 'situacao',
    label: 'Situação',
    tipo: 'lista',
    accessor: (a) => SITUACAO_INFO[a.situacao]?.label ?? a.situacao,
    opcoes: Object.values(SITUACAO_INFO).map((s) => s.label),
  },
};

const FILTROS_PADRAO_FRETES: ColumnFiltersState = {
  modo_envio: ['A combinar'],
};

// -----------------------------------------------------------------------------------------
// Pedaços reaproveitados
// -----------------------------------------------------------------------------------------

function SituacaoBadge({ a }: { a: AnuncioFrete }) {
  const info = SITUACAO_INFO[a.situacao];
  return (
    <Badge variant={info.variant} className="text-[10px]">
      {info.label}
    </Badge>
  );
}

function ModoBadge({ modo }: { modo: string | null }) {
  return (
    <Badge variant={modo === 'not_specified' ? 'danger' : 'secondary'} className="font-mono text-[10px]">
      {rotuloModo(modo)}
    </Badge>
  );
}

function AnuncioTitulo({ a, contas }: { a: AnuncioFrete; contas?: FretesStatus['contas'] }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-foreground" title={a.titulo}>
        {a.titulo}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{a.sku || 'sem SKU'}</span>
        <span>·</span>
        {a.permalink ? (
          <a href={linkExternoSeguro(a.permalink)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-foreground">
            {a.mlb}
            <ExternalLink size={10} />
          </a>
        ) : (
          <span className="font-mono">{a.mlb}</span>
        )}
        <span>·</span>
        <span>{contas?.[a.filial]?.rotulo ?? a.filial}</span>
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------------------
// Abas
// -----------------------------------------------------------------------------------------

function AbaAnuncios({
  service,
  contas,
  recarregar,
}: {
  service: FretesService;
  contas?: FretesStatus['contas'];
  recarregar: number;
}) {
  const [colFilters, setColFilters] = useState<ColumnFiltersState>(() =>
    carregarFiltrosSession('fretes', 'anuncios', FILTROS_PADRAO_FRETES),
  );
  const [todosAnuncios, setTodosAnuncios] = useState<AnuncioFrete[] | null>(null);
  const [page, setPage] = useState(1);
  const [erro, setErro] = useState<string | null>(null);

  const updateColFilter = (id: string, val: ColumnFilterValue | undefined) => {
    setColFilters((prev) => {
      const proximo = { ...prev };
      if (val === undefined) {
        delete proximo[id];
      } else {
        proximo[id] = val;
      }
      salvarFiltrosSession('fretes', 'anuncios', proximo);
      return proximo;
    });
    setPage(1);
  };

  const clearFilters = () => {
    setColFilters({});
    salvarFiltrosSession('fretes', 'anuncios', {});
    setPage(1);
  };

  useEffect(() => {
    let vivo = true;
    buscarTodasPaginas((page) => service.anuncios({ page, pageSize: PAGINA_API }))
      .then((r) => vivo && (setTodosAnuncios(r.itens), setErro(null)))
      .catch((e: Error) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, [service, recarregar]);

  const filteredAnuncios = useMemo(() => {
    return aplicaFiltros(todosAnuncios ?? [], colFilters, FRETES_DEFS);
  }, [todosAnuncios, colFilters]);

  const total = filteredAnuncios.length;
  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, paginas);
  const visibleAnuncios = useMemo(() => {
    return filteredAnuncios.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  }, [filteredAnuncios, currentPage]);

  const handleExportCsv = () => {
    downloadCsv(
      'anuncios-fretes',
      ['SKU', 'MLB', 'Título', 'Conta', 'Envio atual', 'Envio indicado', 'Dimensões', 'Situação', 'Bloqueio'],
      filteredAnuncios.map((a) => [
        a.sku || '',
        a.mlb,
        a.titulo,
        contas?.[a.filial]?.rotulo ?? a.filial,
        rotuloModo(a.modo_envio),
        rotuloModo(a.envio_indicado),
        a.padrao ? formatMedidas(a.padrao) : '',
        SITUACAO_INFO[a.situacao]?.label ?? a.situacao,
        a.bloqueio_texto ?? '',
      ]),
    );
  };

  return (
    <div className="space-y-3">
      <ColumnFilterBar
        totalCount={todosAnuncios?.length ?? 0}
        filteredCount={total}
        activeFiltersCount={filtrosAtivosCount(colFilters, FRETES_DEFS)}
        onClearAll={clearFilters}
        onExportCsv={total > 0 ? handleExportCsv : undefined}
        itemLabel="anúncios"
      />

      {erro ? (
        <SourceError message={erro} />
      ) : !todosAnuncios ? (
        <Skeleton className="h-64 w-full" />
      ) : total === 0 ? (
        <Empty>
          Nenhum anúncio corresponde aos filtros selecionados.
          <Button variant="outline" size="sm" onClick={clearFilters} className="mt-2 cursor-pointer">
            Limpar filtros
          </Button>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <ColumnFilterHeader
                    def={FRETES_DEFS.anuncio}
                    value={colFilters.anuncio}
                    onChange={(v) => updateColFilter('anuncio', v)}
                    title="Anúncio / SKU"
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    def={FRETES_DEFS.filial}
                    value={colFilters.filial}
                    onChange={(v) => updateColFilter('filial', v)}
                    title="Conta"
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    def={FRETES_DEFS.modo_envio}
                    value={colFilters.modo_envio}
                    onChange={(v) => updateColFilter('modo_envio', v)}
                    title="Tipo de envio"
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    def={FRETES_DEFS.dimensoes}
                    value={colFilters.dimensoes}
                    onChange={(v) => updateColFilter('dimensoes', v)}
                    title="Dimensões padronizadas"
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    def={FRETES_DEFS.situacao}
                    value={colFilters.situacao}
                    onChange={(v) => updateColFilter('situacao', v)}
                    title="Situação"
                  />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAnuncios.map((a) => (
                <TableRow key={`${a.filial}:${a.mlb}`}>
                  <TableCell className="max-w-96">
                    <AnuncioTitulo a={a} contas={contas} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {contas?.[a.filial]?.rotulo ?? (a.filial === 'norvia' ? 'Norvia Campinas' : 'Revesta')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <ModoBadge modo={a.modo_envio} />
                    {a.envio_indicado && a.envio_indicado !== a.modo_envio && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">→ {rotuloModo(a.envio_indicado)}</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {a.padrao ? (
                      <>
                        {formatMedidas(a.padrao)}
                        {a.embalagem && (
                          <span className="block text-[10px] text-muted-foreground">embalagem 5 × 7 × {a.embalagem.comprimento}</span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <SituacaoBadge a={a} />
                    {a.bloqueio_texto && <p className="mt-1 text-[11px] text-muted-foreground">{a.bloqueio_texto}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {todosAnuncios && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {total.toLocaleString('pt-BR')} anúncio(s) · página {currentPage} de {paginas}
          </span>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={currentPage >= paginas} onClick={() => setPage((p) => p + 1)}>
              Próxima
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const TROCA_INFO: Record<TrocaFrete['status'], { label: string; variant: 'success' | 'warning' | 'danger' | 'info' }> = {
  aguardando: { label: 'Aguardando conferência', variant: 'info' },
  ok: { label: 'Manteve', variant: 'success' },
  revertido: { label: 'ML desfez', variant: 'danger' },
  erro: { label: 'Erro', variant: 'danger' },
};

function AbaHistorico({ historico }: { historico: HistoricoFretes | null }) {
  if (!historico) return <Skeleton className="h-64 w-full" />;
  if (historico.itens.length === 0) return <Empty>Nenhuma alteração de frete ainda.</Empty>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quando</TableHead>
            <TableHead>Anúncio</TableHead>
            <TableHead>Alteração</TableHead>
            <TableHead>Por</TableHead>
            <TableHead>Resultado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {historico.itens.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatDateTimeBR(t.feita_em)}</TableCell>
              <TableCell className="max-w-80">
                <p className="truncate text-sm" title={t.titulo ?? ''}>
                  {t.titulo || t.mlb}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">{t.mlb}</p>
              </TableCell>
              <TableCell className="text-xs">
                {t.para ? (
                  <>
                    Frete {rotuloModo(t.de)} → <strong>{rotuloModo(t.para)}</strong>
                  </>
                ) : (
                  'Medidas enviadas'
                )}
                {t.dims && <p className="font-mono text-[11px] text-muted-foreground">{formatMedidas(t.dims)}</p>}
              </TableCell>
              <TableCell className="text-xs">{t.usuario || (t.origem === 'rotina' ? 'Rotina diária' : '—')}</TableCell>
              <TableCell className="max-w-72">
                <Badge variant={TROCA_INFO[t.status].variant} className="text-[10px]">
                  {TROCA_INFO[t.status].label}
                </Badge>
                {t.mensagem && <p className="mt-1 line-clamp-3 text-[11px] text-rose-600 dark:text-rose-400">{t.mensagem}</p>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AbaDesfeitos({
  service,
  contas,
  recarregar,
  onReenviado,
  canRetentar,
}: {
  service: FretesService;
  contas?: FretesStatus['contas'];
  recarregar: number;
  onReenviado: () => void;
  /** Sessão tem fretes:retentar. */
  canRetentar: boolean;
}) {
  const [itens, setItens] = useState<AnuncioFrete[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const chave = (a: AnuncioFrete) => `${a.filial}:${a.mlb}`;

  useEffect(() => {
    let vivo = true;
    service
      .desfeitos()
      .then((r) => {
        if (!vivo) return;
        setItens(r.itens);
        setErro(null);
        // Mantém só a seleção do que ainda está na lista.
        const presentes = new Set(r.itens.map(chave));
        setSelecionados((sel) => new Set([...sel].filter((k) => presentes.has(k))));
      })
      .catch((e: Error) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, [service, recarregar]);

  const todos = (itens?.length ?? 0) > 0 && selecionados.size === itens?.length;
  const alternar = (k: string, marcado: boolean) =>
    setSelecionados((sel) => {
      const novo = new Set(sel);
      if (marcado) novo.add(k);
      else novo.delete(k);
      return novo;
    });

  async function tentarDeNovo() {
    if (!itens) return;
    const alvos = itens.filter((a) => selecionados.has(chave(a)));
    setEnviando(true);
    setErro(null);
    try {
      const r = await service.retentar(alvos);
      setAviso(
        `Tentando de novo ${r.total} anúncio(s) no Mercado Livre. A conferência sai 10 minutos depois de cada envio; ` +
          'se o ML desfizer de novo, o anúncio volta para esta lista.',
      );
      setSelecionados(new Set());
      setTimeout(onReenviado, 4000);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao pedir a nova tentativa.');
    } finally {
      setEnviando(false);
    }
  }

  if (erro && !itens) return <SourceError message={erro} />;
  if (!itens) return <Skeleton className="h-64 w-full" />;
  if (itens.length === 0) return <Empty>Nenhum anúncio desfeito pelo Mercado Livre.</Empty>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={todos}
            onCheckedChange={(marcado) => setSelecionados(marcado ? new Set(itens.map(chave)) : new Set())}
            aria-label="Selecionar todos os anúncios desfeitos"
          />
          Selecionar todos ({selecionados.size} de {itens.length})
        </label>
        {canRetentar && (
          <Button type="button" size="sm" onClick={() => void tentarDeNovo()} disabled={enviando || selecionados.size === 0}>
            {enviando ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            Tentar novamente{selecionados.size > 0 ? ` (${selecionados.size})` : ''}
          </Button>
        )}
      </div>
      {erro && <SourceError message={erro} />}
      {aviso && (
        <p className="flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
          {aviso}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Anúncio</TableHead>
              <TableHead>Envio</TableHead>
              <TableHead>Embalagem</TableHead>
              <TableHead>O que o ML fez</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {itens.map((a) => {
              const k = chave(a);
              return (
                <TableRow key={k} data-state={selecionados.has(k) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selecionados.has(k)}
                      onCheckedChange={(marcado) => alternar(k, Boolean(marcado))}
                      aria-label={`Selecionar ${a.mlb}`}
                    />
                  </TableCell>
                  <TableCell className="max-w-[360px]">
                    <AnuncioTitulo a={a} contas={contas} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <ModoBadge modo={a.modo_envio} />
                    {a.envio_indicado && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">→ {rotuloModo(a.envio_indicado)}</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{a.embalagem ? formatMedidas(a.embalagem) : '—'}</TableCell>
                  <TableCell className="min-w-[260px]">
                    <p className="line-clamp-3 text-[11px] text-rose-600 dark:text-rose-400" title={a.falha_envio?.mensagem}>
                      {a.falha_envio?.mensagem}
                    </p>
                    {a.falha_envio?.em && (
                      <p className="text-[10px] text-muted-foreground">{formatDateTimeBR(a.falha_envio.em)}</p>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------
// Tela
// -----------------------------------------------------------------------------------------

export default function FretesView({ apiBaseUrl }: { apiBaseUrl?: string }) {
  const service = useMemo(() => createFretesService(apiBaseUrl), [apiBaseUrl]);
  // Ações só com a permissão (o gateway barra do mesmo jeito).
  const { can } = useAuth();
  const canRetentar = can('fretes:retentar');
  const canVerificar = can('fretes:executar');
  const [aba, setAba] = useState<Aba>('anuncios');
  const [status, setStatus] = useState<FretesStatus | null>(null);
  const [historico, setHistorico] = useState<HistoricoFretes | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarregar, setRecarregar] = useState(0);
  const [executando, setExecutando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [st, hist] = await Promise.all([service.status(), service.historico()]);
      setStatus(st);
      setHistorico(hist);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar a automação de fretes.');
    }
  }, [service]);

  useEffect(() => {
    void carregar();
  }, [carregar, recarregar]);

  // Enquanto a verificação roda, acompanha o andamento com suspensão em aba oculta.
  useDataPolling(
    async () => {
      setRecarregar((n) => n + 1);
    },
    {
      intervalMs: 10000,
      enabled: Boolean(status?.em_execucao),
      pauseOnHidden: true,
      refetchOnVisible: true,
    },
  );

  async function verificarAgora() {
    setExecutando(true);
    try {
      await service.executar();
      setTimeout(() => setRecarregar((n) => n + 1), 1500);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao iniciar a verificação.');
    } finally {
      setExecutando(false);
    }
  }

  const envios = status?.envios ?? {};
  const kpis = [
    { label: 'Sem dimensões padronizadas', valor: status?.sem_padrao ?? 0, tom: 'text-amber-700 dark:text-amber-400' },
    { label: 'A combinar', valor: envios.not_specified ?? 0, tom: 'text-rose-600 dark:text-rose-400' },
    { label: 'ML desfez', valor: status?.desfeitos ?? 0, tom: 'text-rose-600 dark:text-rose-400' },
    { label: 'Aguardando conferência', valor: status?.aguardando_conferencia ?? 0, tom: 'text-amber-700 dark:text-amber-400' },
    { label: 'ME1', valor: envios.me1 ?? 0, tom: 'text-sky-700 dark:text-sky-400' },
    { label: 'ME2', valor: envios.me2 ?? 0, tom: 'text-emerald-700 dark:text-emerald-400' },
    { label: 'Anúncios no catálogo', valor: status?.total_anuncios ?? 0, tom: 'text-foreground' },
  ];
  const abas: Array<{ id: Aba; label: string; count?: number; icon: LucideIcon }> = [
    { id: 'anuncios', label: 'Anúncios', count: status?.total_anuncios, icon: ListChecks },
    { id: 'desfeitos', label: 'ML desfez', count: status?.desfeitos, icon: RotateCcw },
    { id: 'historico', label: 'Histórico', icon: History },
  ];
  const contasDesconectadas = Object.values(status?.contas ?? {}).filter((c) => !c.conectada);
  const ultima = status?.ultima_execucao;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Marketplace</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <Truck size={22} className="text-primary" />
            {fretesACombinar.title}
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Todo dia a automação pega as dimensões padronizadas de cada produto, define a embalagem (5 × 7 × 100/200/300 cm) e o
            tipo de envio, e tira do frete a combinar os anúncios que já podem ser trocados. Cada troca é conferida{' '}
            {status?.minutos_conferencia ?? 10} minutos depois.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRecarregar((n) => n + 1)}>
              <RefreshCw size={14} />
              Atualizar
            </Button>
            {canVerificar && (
              <Button type="button" size="sm" onClick={() => void verificarAgora()} disabled={executando || Boolean(status?.em_execucao)}>
                {status?.em_execucao || executando ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                {status?.em_execucao ? 'Verificando…' : 'Verificar agora'}
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {ultima ? `Última verificação: ${formatDateTimeBR(ultima.concluida_em)}` : 'Nenhuma verificação ainda'}
            {status && ` · próxima: ${formatDateTimeBR(status.proxima_execucao)}`}
          </p>
        </div>
      </div>

      {erro && <SourceError message={erro} />}
      {status && !status.configurado && (
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          Nenhuma conta do Mercado Livre tem access token na automação. A renovação dos tokens é feita fora deste sistema
          e ainda não foi configurada.
        </div>
      )}
      {status?.configurado && contasDesconectadas.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          Conta(s) sem conexão com o Mercado Livre: {contasDesconectadas.map((c) => c.rotulo).join(', ')}. Elas ficam de
          fora da verificação até receberem um access token válido (a renovação é feita fora deste sistema).
        </div>
      )}
      {ultima && ultima.resumo.erros.length > 0 && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300">
          <p className="font-semibold">A última verificação teve falhas:</p>
          <ul className="mt-1 list-disc pl-4">
            {ultima.resumo.erros.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="rounded-lg border border-border bg-card p-3 text-left"
          >
            <p className="text-[11px] text-muted-foreground">{k.label}</p>
            {status ? (
              <p className={cn('text-2xl font-bold tabular-nums', k.tom)}>{k.valor.toLocaleString('pt-BR')}</p>
            ) : (
              <Skeleton className="mt-1 h-7 w-12" />
            )}
          </div>
        ))}
      </div>

      <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-lg border border-border p-1">
        {abas.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={aba === t.id}
            onClick={() => setAba(t.id)}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
              aba === t.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            <t.icon size={14} />
            {t.label}
            {t.count !== undefined && (
              <Badge variant={aba === t.id ? 'outline' : 'secondary'} className="count-badge">
                {t.count}
              </Badge>
            )}
          </button>
        ))}
      </div>

      <section role="tabpanel">
        {aba === 'anuncios' && (
          <AbaAnuncios
            service={service}
            contas={status?.contas}
            recarregar={recarregar}
          />
        )}
        {aba === 'desfeitos' && (
          <AbaDesfeitos
            service={service}
            contas={status?.contas}
            recarregar={recarregar}
            onReenviado={() => setRecarregar((n) => n + 1)}
            canRetentar={canRetentar}
          />
        )}
        {aba === 'historico' && <AbaHistorico historico={historico} />}
      </section>
    </div>
  );
}
