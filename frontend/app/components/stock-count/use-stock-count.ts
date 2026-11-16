'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useAuth } from '@/lib/auth-context';
import { createStockCountService, type StockCountService } from '@/lib/stock-count-service';
import type { StockCountItem } from '@/lib/stock-count-contracts';
import {
  aplicaFiltros,
  carregarFiltrosSession,
  salvarFiltrosSession,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from '@/lib/column-filters';
import { downloadCsv } from '@/lib/csv-export';
import { buscarTodasPaginas } from '@/lib/paginacao';
import { PAGINA_API, POR_PAGINA, STOCK_COUNT_DEFS, formatDataBR, numeroContagem, skuDoItem } from './helpers';
import type { FotoRef } from './foto-viewer';

/** Estado e regras da tela de contagem de estoque: carga, filtros, paginação, fotos e CSV. */
export function useStockCount(apiBaseUrl?: string) {
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
  // Fase única da carga: 'carregando' (primeira), 'recarregando' (lista antiga segue na tela),
  // 'erro' ou 'pronto'.
  const [fase, setFase] = useState<'carregando' | 'recarregando' | 'erro' | 'pronto'>('carregando');
  const [erro, setErro] = useState<string | null>(null);
  const loading = fase === 'carregando' || fase === 'recarregando';

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
    const controller = new AbortController();
    const { signal } = controller;
    let configuradoApi = true;
    buscarTodasPaginas(async (page) => {
      const res = await service.listarContagens({ page, pageSize: PAGINA_API }, signal);
      configuradoApi = res.configurado;
      return res;
    })
      .then((res) => {
        if (signal.aborted) return;
        startTransition(() => {
          setErro(null);
          setConfigurado(configuradoApi);
          setItens(res.itens);
          setFase('pronto');
        });
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        setErro(err instanceof Error ? err.message : 'Falha ao carregar contagens');
        setFase('erro');
      });
    return () => controller.abort();
  }, [service, reloadToken]);

  const recarregar = () => {
    setFase(itens.length === 0 ? 'carregando' : 'recarregando');
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

  return {
    service, itens, setItens, configurado, fase, loading, erro, colFilters, updateColFilter, clearFilters,
    filteredItens, contagemAbas, abaAtiva, totalPaginas, paginaAtual, setPagina, visiveis, resumo, porFardoPorSku,
    lightboxIdx, setLightboxIdx, fotos, abrirFoto, recarregar, handleExportCsv, mostrarInstrucoes, setMostrarInstrucoes,
    podeInformarSku, podeExcluir, podeConferir,
  };
}
