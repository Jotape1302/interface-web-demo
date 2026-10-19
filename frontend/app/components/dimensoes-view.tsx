'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
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
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatDateTimeBR } from '@/lib/formatters';
import { padronizacaoDimensoes } from '@/lib/automations';
import type { AnuncioSemSku, DimensoesStatus, ProdutoDimensoes } from '@/lib/dimensoes-contracts';
import type { Medidas } from '@/lib/fretes-contracts';
import { CONFIABILIDADE_INFO, STATUS_PADRONIZACAO_INFO, embalagemPara, medidasValidas } from '@/lib/dimensoes-helpers';
import { type CampoMedida, camposParaMedidas, formatMedidas, medidasParaCampos } from '@/lib/fretes-helpers';
import { createDimensoesService, type DimensoesService } from '@/lib/dimensoes-service';
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

/** Atalhos dos indicadores: cada um troca os filtros de situação, confiabilidade e envio. */
type AtalhoDimensoes = { situacao?: string[]; confiabilidade?: string[]; envio?: string[] };
const A_REVISAR = ['Pendente', 'Divergente'];
const ATALHOS_KPI: Record<string, AtalhoDimensoes> = {
  revisar: { situacao: A_REVISAR },
  alta: { situacao: A_REVISAR, confiabilidade: ['Alta'] },
  media: { situacao: A_REVISAR, confiabilidade: ['Média'] },
  baixa: { situacao: A_REVISAR, confiabilidade: ['Baixa'] },
  divergente: { situacao: ['Divergente'] },
  padronizado: { situacao: ['Padronizado'] },
  erro: { envio: ['Erro'] },
};

function mesmaLista(a: unknown, b: string[] | undefined): boolean {
  const lista = Array.isArray(a) ? (a as string[]) : [];
  const alvo = b ?? [];
  return lista.length === alvo.length && alvo.every((v) => lista.includes(v));
}

const PAGE_SIZE = 30;

const DIMENSOES_DEFS: Record<string, ColumnFilterDef<ProdutoDimensoes>> = {
  sku_descricao: {
    id: 'sku_descricao',
    label: 'SKU / Título',
    tipo: 'texto',
    accessor: (p) => `${p.sku} ${p.descricao}`,
  },
  situacao: {
    id: 'situacao',
    label: 'Situação',
    tipo: 'lista',
    accessor: (p) => {
      const mapa: Record<string, string> = {
        pendente: 'Pendente',
        divergente: 'Divergente',
        padronizado: 'Padronizado',
      };
      return mapa[p.status] ?? p.status;
    },
    opcoes: ['Pendente', 'Divergente', 'Padronizado'],
  },
  confiabilidade: {
    id: 'confiabilidade',
    label: 'Confiabilidade',
    tipo: 'lista',
    accessor: (p) => {
      const mapa: Record<string, string> = {
        alta: 'Alta',
        media: 'Média',
        baixa: 'Baixa',
      };
      return mapa[p.confiabilidade] ?? p.confiabilidade;
    },
    opcoes: ['Alta', 'Média', 'Baixa'],
  },
  envio: {
    id: 'envio',
    label: 'Envio',
    tipo: 'lista',
    accessor: (p) => {
      const st = p.envio?.status ?? 'pendente';
      const mapa: Record<string, string> = {
        sucesso: 'Sucesso',
        erro: 'Erro',
        pendente: 'Pendente',
      };
      return mapa[st] ?? st;
    },
    opcoes: ['Sucesso', 'Erro', 'Pendente'],
  },
  medidas: {
    id: 'medidas',
    label: 'Medidas / Peso',
    tipo: 'texto',
    accessor: (p) => {
      const m = p.padrao ?? p.sugestao;
      return `${m.altura || ''}x${m.largura || ''}x${m.comprimento || ''} ${m.peso || ''}g`;
    },
  },
};

const FILTROS_PADRAO_DIMENSOES: ColumnFiltersState = {
  situacao: ['Pendente', 'Divergente'],
};

const CAMPOS: Array<{ id: CampoMedida; label: string; unidade: string }> = [
  { id: 'altura', label: 'Altura', unidade: 'cm' },
  { id: 'largura', label: 'Largura', unidade: 'cm' },
  { id: 'comprimento', label: 'Comprimento', unidade: 'cm' },
  { id: 'peso', label: 'Peso', unidade: 'g' },
];

function pesoTexto(p: number | null | undefined): string {
  return p ? `${p.toLocaleString('pt-BR')} g` : '—';
}

// -----------------------------------------------------------------------------------------
// Card de um produto
// -----------------------------------------------------------------------------------------

function ProdutoCard({
  p,
  campos,
  selecionado,
  onCampos,
  onSelecionar,
  onValidar,
  onReenviar,
  ocupado,
  canValidar,
  canReenviar,
}: {
  p: ProdutoDimensoes;
  campos: Record<CampoMedida, string>;
  selecionado: boolean;
  onCampos: (c: Record<CampoMedida, string>) => void;
  onSelecionar: (v: boolean) => void;
  onValidar: () => void;
  onReenviar: () => void;
  ocupado: boolean;
  /** Sessão tem dimensoes:validar / dimensoes:reenviar. */
  canValidar: boolean;
  canReenviar: boolean;
}) {
  const medidas = camposParaMedidas(campos);
  const valido = medidasValidas(medidas);
  const embalagem = embalagemPara(medidas);
  const concordantes = new Set(p.fontes_concordantes);
  const conf = CONFIABILIDADE_INFO[p.confiabilidade];
  const st = STATUS_PADRONIZACAO_INFO[p.status];
  const aRevisar = p.status !== 'padronizado';
  const destinos = Object.entries(p.envio?.destinos ?? {});

  return (
    <article className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {aRevisar && (
            <Checkbox
              checked={selecionado}
              onCheckedChange={(v) => onSelecionar(Boolean(v))}
              disabled={ocupado || !valido}
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
                {p.tiny.length} conta(s) no Tiny · {p.anuncios.length} anúncio(s) no ML
              </span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {aRevisar && (
            <Badge variant={conf.variant} className="text-[10px]">
              {conf.label}
            </Badge>
          )}
          <Badge variant={st.variant} className="text-[10px]">
            {st.label}
          </Badge>
        </div>
      </header>

      {p.motivos.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-rose-500/5 p-2.5 text-xs text-rose-700 dark:text-rose-300">
          {p.motivos.map((m) => (
            <li key={m} className="flex gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {m}
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-x-auto rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[11px]">Local</TableHead>
              <TableHead className="text-[11px]">Fonte</TableHead>
              <TableHead className="text-[11px]">Medida informada</TableHead>
              <TableHead className="text-right text-[11px]">Peso</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.fontes.map((f) => {
              const bate = concordantes.has(`${f.fonte}|${f.local}`);
              const vazia = [f.dims.altura, f.dims.largura, f.dims.comprimento, f.dims.peso].every((v) => v == null);
              return (
                <TableRow key={`${f.fonte}|${f.local}`} className={cn(vazia && 'opacity-50')}>
                  <TableCell className="whitespace-nowrap text-[11px]">{f.local}</TableCell>
                  <TableCell className="whitespace-nowrap text-[11px]" title={f.texto ?? undefined}>
                    {f.rotulo}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-[11px]">
                    <span className={cn(bate && 'font-semibold text-emerald-700 dark:text-emerald-400')}>{formatMedidas(f.dims)}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right font-mono text-[11px]">{pesoTexto(f.dims.peso)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {p.padrao && (
        <p className="text-[11px] text-muted-foreground">
          Padrão atual:{' '}
          <span className="font-mono text-foreground">
            {formatMedidas(p.padrao)} · {pesoTexto(p.padrao.peso)}
          </span>{' '}
          · validado por {p.padrao.validado_por || '—'} em {formatDateTimeBR(p.padrao.validado_em)}
        </p>
      )}

      {aRevisar && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CAMPOS.map((c) => (
              <label key={c.id} className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
                {c.label}
                <div className="relative">
                  <Input
                    inputMode="decimal"
                    value={campos[c.id]}
                    onChange={(e) => onCampos({ ...campos, [c.id]: e.target.value })}
                    aria-invalid={!campos[c.id].trim() || undefined}
                    className="h-8 pr-8 text-sm tabular-nums"
                    disabled={ocupado}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1.5 text-xs text-muted-foreground">{c.unidade}</span>
                </div>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {!valido
                ? 'Preencha altura, largura, comprimento e peso (o Mercado Livre exige o peso).'
                : embalagem
                  ? `Embalagem padrão: 5 × 7 × ${embalagem.comprimento} cm.`
                  : 'Não cabe na embalagem padrão (5 × 7 × até 300 cm): o tipo de frete não será trocado sozinho.'}
            </p>
            {canValidar && (
              <Button type="button" size="sm" onClick={onValidar} disabled={ocupado || !valido}>
                {ocupado ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Validar e enviar
              </Button>
            )}
          </div>
        </div>
      )}

      {p.envio && (
        <div className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-foreground">
              {p.envio.status === 'enviando'
                ? 'Enviando às plataformas…'
                : p.envio.status === 'ok'
                  ? 'Enviado a todas as plataformas'
                  : 'Envio com falha em alguma plataforma'}
            </p>
            {p.envio.status === 'erro' && canReenviar && (
              <Button type="button" size="sm" variant="outline" onClick={onReenviar} disabled={ocupado}>
                <RotateCcw size={13} />
                Reenviar
              </Button>
            )}
          </div>
          {destinos.map(([k, d]) => (
            <p key={k} className="flex items-start gap-1.5">
              {d.status === 'ok' ? (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
              ) : (
                <XCircle size={12} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
              )}
              <span>
                <span className="font-medium text-foreground">{d.local}</span>
                {d.mensagem && <span className="text-muted-foreground"> — {d.mensagem}</span>}
              </span>
            </p>
          ))}
        </div>
      )}

      {p.anuncios.length > 0 && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {p.anuncios.map((a) =>
            a.permalink ? (
              <a key={a.mlb} href={linkExternoSeguro(a.permalink)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-foreground">
                {a.mlb}
                <ExternalLink size={10} />
              </a>
            ) : (
              <span key={a.mlb} className="font-mono">
                {a.mlb}
              </span>
            ),
          )}
        </p>
      )}
    </article>
  );
}

// -----------------------------------------------------------------------------------------
// Tela
// -----------------------------------------------------------------------------------------

function camposIniciais(p: ProdutoDimensoes): Record<CampoMedida, string> {
  const base: Medidas = p.status === 'divergente' && p.padrao ? p.padrao : p.sugestao;
  return medidasParaCampos(base);
}

export default function DimensoesView({ apiBaseUrl }: { apiBaseUrl?: string }) {
  const service: DimensoesService = useMemo(() => createDimensoesService(apiBaseUrl), [apiBaseUrl]);
  // Ações só com a permissão (o gateway barra do mesmo jeito).
  const { can } = useAuth();
  const canValidar = can('dimensoes:validar');
  const canReenviar = can('dimensoes:reenviar');
  const canColetar = can('dimensoes:executar');
  const [status, setStatus] = useState<DimensoesStatus | null>(null);
  const [abaAtiva, setAbaAtiva] = useState<'produtos' | 'sem_sku'>('produtos');
  const [colFilters, setColFilters] = useState<ColumnFiltersState>(() =>
    carregarFiltrosSession('dimensoes', 'produtos', FILTROS_PADRAO_DIMENSOES),
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [todosItens, setTodosItens] = useState<ProdutoDimensoes[] | null>(null);
  const [semSku, setSemSku] = useState<AnuncioSemSku[] | null>(null);
  const [campos, setCampos] = useState<Record<string, Record<CampoMedida, string>>>({});
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
      salvarFiltrosSession('dimensoes', 'produtos', proximo);
      return proximo;
    });
    setVisibleCount(PAGE_SIZE);
  };

  const clearFilters = () => {
    setColFilters({});
    salvarFiltrosSession('dimensoes', 'produtos', {});
    setVisibleCount(PAGE_SIZE);
  };

  const carregar = useCallback(async () => {
    try {
      const st = await service.status();
      setStatus(st);
      const [prodRes, semSkuRes] = await Promise.all([
        buscarTodasPaginas((page) => service.produtos({ page, pageSize: PAGINA_API })),
        service.semSku(),
      ]);
      setTodosItens(prodRes.itens);
      setSemSku(semSkuRes.itens);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar a padronização de dimensões.');
    }
  }, [service]);

  useEffect(() => {
    void carregar();
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

  const camposDe = (p: ProdutoDimensoes) => campos[p.sku] ?? camposIniciais(p);

  const filteredItens = useMemo(() => {
    return aplicaFiltros(todosItens ?? [], colFilters, DIMENSOES_DEFS);
  }, [todosItens, colFilters]);

  const visibleItens = useMemo(() => {
    return filteredItens.slice(0, visibleCount);
  }, [filteredItens, visibleCount]);

  async function validar(lista: ProdutoDimensoes[]) {
    const skus = lista.map((p) => p.sku);
    setOcupados((o) => new Set([...o, ...skus]));
    setErro(null);
    setAviso(null);
    try {
      const r = await service.validar(lista.map((p) => ({ sku: p.sku, ...camposParaMedidas(camposDe(p)) })));
      setAviso(
        `${r.gravados.length} produto(s) padronizado(s) e gravado(s) em dimensoes_produtos; o envio ao Tiny e ao Mercado Livre segue em segundo plano.` +
          (r.recusados.length ? ` Recusados: ${r.recusados.join('; ')}.` : ''),
      );
      setSelecionados(new Set());
      setRecarregar((n) => n + 1);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao validar.');
    } finally {
      setOcupados((o) => new Set([...o].filter((s) => !skus.includes(s))));
    }
  }

  async function reenviar(skus: string[]) {
    try {
      await service.reenviar(skus);
      setAviso(`Reenviando ${skus.length} produto(s) às plataformas.`);
      setRecarregar((n) => n + 1);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao reenviar.');
    }
  }

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
  const porConf = status?.pendentes_por_confiabilidade ?? {};
  const kpis = [
    { id: 'revisar', label: 'A revisar', valor: (porStatus.pendente ?? 0) + (porStatus.divergente ?? 0), tom: 'text-amber-700 dark:text-amber-400' },
    { id: 'alta', label: 'Alta confiabilidade', valor: porConf.alta ?? 0, tom: 'text-emerald-700 dark:text-emerald-400' },
    { id: 'media', label: 'Média confiabilidade', valor: porConf.media ?? 0, tom: 'text-amber-700 dark:text-amber-400' },
    { id: 'baixa', label: 'Baixa confiabilidade', valor: porConf.baixa ?? 0, tom: 'text-rose-600 dark:text-rose-400' },
    { id: 'divergente', label: 'Divergentes do padrão', valor: porStatus.divergente ?? 0, tom: 'text-rose-600 dark:text-rose-400' },
    { id: 'padronizado', label: 'Padronizados', valor: porStatus.padronizado ?? 0, tom: 'text-foreground' },
    { id: 'erro', label: 'Erro no envio', valor: status?.com_erro_de_envio ?? 0, tom: 'text-rose-600 dark:text-rose-400' },
  ];

  // Indicador clicado: aplica o atalho mantendo os filtros de texto (SKU, medidas).
  const aplicarAtalho = (id: string) => {
    const atalho = ATALHOS_KPI[id];
    if (!atalho) return;
    setColFilters((prev) => {
      const proximo: ColumnFiltersState = { ...prev };
      for (const campo of ['situacao', 'confiabilidade', 'envio'] as const) {
        if (atalho[campo]) proximo[campo] = atalho[campo];
        else delete proximo[campo];
      }
      salvarFiltrosSession('dimensoes', 'produtos', proximo);
      return proximo;
    });
    setVisibleCount(PAGE_SIZE);
  };
  const atalhoAtivo = Object.entries(ATALHOS_KPI).find(([, a]) =>
    (['situacao', 'confiabilidade', 'envio'] as const).every((campo) => mesmaLista(colFilters[campo], a[campo])),
  )?.[0];

  const revisaveis = filteredItens.filter((p) => p.status !== 'padronizado' && medidasValidas(camposParaMedidas(camposDe(p))));
  const todosSelecionados = revisaveis.length > 0 && revisaveis.every((p) => selecionados.has(p.sku));
  // Só o que está no filtro atual é enviado; o contador mostra o mesmo número.
  const selecionadosVisiveis = filteredItens.filter((p) => selecionados.has(p.sku));
  const ultima = status?.ultima_execucao;
  const comErroVisiveis = filteredItens.filter((p) => p.envio?.status === 'erro').map((p) => p.sku);

  const handleExportCsv = () => {
    downloadCsv(
      'produtos-dimensoes',
      ['SKU', 'Descrição', 'Situação', 'Confiabilidade', 'Envio', 'Altura', 'Largura', 'Comprimento', 'Peso (g)'],
      filteredItens.map((p) => {
        const m = p.padrao ?? p.sugestao;
        return [
          p.sku,
          p.descricao,
          p.status,
          p.confiabilidade,
          p.envio?.status ?? 'pendente',
          m.altura ?? '',
          m.largura ?? '',
          m.comprimento ?? '',
          m.peso ?? '',
        ];
      }),
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
            Compara as medidas de cada produto no título, na descrição e na ficha técnica do Mercado Livre e do Tiny. Revise,
            valide e as medidas vão para a tabela dimensoes_produtos e para todas as plataformas. O Tipo de frete usa só
            produtos padronizados.
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

      {erro && <SourceError message={erro} />}
      {status && !status.banco_configurado && (
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          O MariaDB não está configurado na automação (variáveis DB_*): as dimensões validadas não são gravadas em
          dimensoes_produtos e o Tiny não tem token.
        </div>
      )}
      {ultima && ultima.resumo.erros.length > 0 && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300">
          <p className="font-semibold">A última coleta teve falhas:</p>
          <ul className="mt-1 list-disc pl-4">
            {ultima.resumo.erros.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
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
              Estes anúncios não têm SKU no Mercado Livre, então não dá para ligá-los ao produto do Tiny. Cadastre o SKU no
              anúncio e rode a coleta de novo.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border">
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
                      <TableCell className="text-xs">{a.filial === 'norvia' ? 'Norvia Campinas' : 'Revesta'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {kpis.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => aplicarAtalho(k.id)}
                aria-pressed={atalhoAtivo === k.id}
                className={cn(
                  'cursor-pointer rounded-lg border bg-card p-3 text-left transition hover:border-foreground/30',
                  atalhoAtivo === k.id ? 'border-foreground/40 ring-1 ring-foreground/20' : 'border-border',
                )}
              >
                <p className="text-[11px] text-muted-foreground">{k.label}</p>
                {status ? (
                  <p className={cn('text-xl font-bold tabular-nums', k.tom)}>{k.valor.toLocaleString('pt-BR')}</p>
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
            <span className="text-muted-foreground font-medium mr-1">Filtros:</span>
            <ColumnFilterHeader
              def={DIMENSOES_DEFS.sku_descricao}
              value={colFilters.sku_descricao}
              onChange={(v) => updateColFilter('sku_descricao', v)}
            />
            <ColumnFilterHeader
              def={DIMENSOES_DEFS.situacao}
              value={colFilters.situacao}
              onChange={(v) => updateColFilter('situacao', v)}
            />
            <ColumnFilterHeader
              def={DIMENSOES_DEFS.confiabilidade}
              value={colFilters.confiabilidade}
              onChange={(v) => updateColFilter('confiabilidade', v)}
            />
            <ColumnFilterHeader
              def={DIMENSOES_DEFS.envio}
              value={colFilters.envio}
              onChange={(v) => updateColFilter('envio', v)}
            />
            <ColumnFilterHeader
              def={DIMENSOES_DEFS.medidas}
              value={colFilters.medidas}
              onChange={(v) => updateColFilter('medidas', v)}
            />
          </div>

          {filteredItens.length > 0 && (revisaveis.length > 0 || comErroVisiveis.length > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                {revisaveis.length > 0 && canValidar && (
                  <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                    <Checkbox
                      checked={todosSelecionados}
                      onCheckedChange={(v) => setSelecionados(v ? new Set(revisaveis.map((p) => p.sku)) : new Set())}
                      aria-label="Selecionar todos os produtos prontos para validar"
                    />
                    Selecionar todos ({selecionadosVisiveis.length} de {revisaveis.length})
                  </label>
                )}
                {selecionadosVisiveis.length > 0 && canValidar && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void validar(selecionadosVisiveis)}
                    disabled={ocupados.size > 0}
                  >
                    <Send size={14} />
                    Validar e enviar ({selecionadosVisiveis.length})
                  </Button>
                )}
                {comErroVisiveis.length > 0 && canReenviar && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void reenviar(comErroVisiveis)}>
                    <RotateCcw size={14} />
                    Reenviar com erro ({comErroVisiveis.length})
                  </Button>
                )}
              </div>
            </div>
          )}

          {!todosItens ? (
            <Skeleton className="h-64 w-full" />
          ) : filteredItens.length === 0 ? (
            <Empty>
              {todosItens.length === 0
                ? 'Nenhuma coleta ainda: clique em "Coletar agora" para ler os produtos do Tiny e os anúncios do Mercado Livre.'
                : 'Nenhum produto corresponde aos filtros selecionados.'}
            </Empty>
          ) : (
            <>
              <div className="grid gap-3 xl:grid-cols-2">
                {visibleItens.map((p) => (
                  <ProdutoCard
                    key={p.sku}
                    p={p}
                    campos={camposDe(p)}
                    selecionado={selecionados.has(p.sku)}
                    ocupado={ocupados.has(p.sku)}
                    onCampos={(c) => setCampos((prev) => ({ ...prev, [p.sku]: c }))}
                    onSelecionar={(v) =>
                      setSelecionados((sel) => {
                        const novo = new Set(sel);
                        if (v) novo.add(p.sku);
                        else novo.delete(p.sku);
                        return novo;
                      })
                    }
                    onValidar={() => void validar([p])}
                    onReenviar={() => void reenviar([p.sku])}
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
