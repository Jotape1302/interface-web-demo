"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { TinyLogo } from "@/components/ui/brand-logos";
import { ColumnFilterBar, ColumnFilterHeader } from "./column-filter";
import {
  aplicaFiltros,
  carregarFiltrosSession,
  filtrosAtivosCount,
  obterValoresUnicos,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from "@/lib/column-filters";
import { NotaCard } from "./danfe-nota-card";
import type {
  ConfirmLancamentoResponse,
  DanfeNotaStatus,
  DanfePendingReviewEntry,
  TinyCategory,
} from "@/lib/contracts";
import { makeDemoDanfePendingReview } from "@/lib/demo";
import { downloadCsv } from "@/lib/csv-export";
import {
  computeGroupPreview,
  resolveCompanyDisplayName,
  suggestPaymentMethodForNote,
} from "@/lib/danfe-review-helpers";
import { readApiError } from '@/lib/api-errors';
import { useAuth } from "@/lib/auth-context";

// Referência estável pra nota sem seleção de categoria ainda — `{}` inline no JSX
// criaria um objeto novo a cada render e quebraria o React.memo() do NotaCard.
const EMPTY_SELECTION: Record<string, string> = {};

// Quantas notas renderizar de uma vez por status/filtro — evita montar centenas de
// cards (cada um com múltiplos <select> de categoria) de uma só vez, que é o que
// deixava a troca de filtro lenta com o volume real de produção (188+ notas).
const PAGE_SIZE = 30;

const DANFE_DEFS: Record<string, ColumnFilterDef<DanfePendingReviewEntry>> = {
  numero_nota: {
    id: "numero_nota",
    label: "Nº Nota",
    tipo: "texto",
    accessor: (n) => `${n.nfe_data.numero_nota} ${n.chave}`,
  },
  data_emissao: {
    id: "data_emissao",
    label: "Emissão",
    tipo: "data",
    accessor: (n) => n.nfe_data.data_emissao,
  },
  fornecedor: {
    id: "fornecedor",
    label: "Fornecedor",
    tipo: "texto",
    accessor: (n) => `${n.nfe_data.emitente_nome} ${n.nfe_data.emitente_cnpj || ""}`,
  },
  empresa: {
    id: "empresa",
    label: "Empresa",
    tipo: "lista",
    accessor: (n) => resolveCompanyDisplayName(n.nfe_data.destinatario_cnpj, n.nfe_data.destinatario_nome),
  },
  valor_total: {
    id: "valor_total",
    label: "Valor total",
    tipo: "numero",
    accessor: (n) => n.nfe_data.valor_total,
  },
};

const STATUS_LABELS: Record<DanfeNotaStatus, { title: string; singular: string; plural: string; empty: string }> = {
  pending: {
    title: "Revisão e Categorização Pendente",
    singular: "nota aguardando",
    plural: "notas aguardando",
    empty: "Nenhuma nota aguardando revisão no momento.",
  },
  confirmed: {
    title: "Notas Lançadas no Tiny",
    singular: "nota lançada",
    plural: "notas lançadas",
    empty: "Nenhuma nota lançada no Tiny encontrada.",
  },
  archived: {
    title: "Notas Arquivadas",
    singular: "nota arquivada",
    plural: "notas arquivadas",
    empty: "Nenhuma nota arquivada.",
  },
};

const DEMO_CATEGORIES: TinyCategory[] = [
  { id: "480897321", nome: "Compras", grupo: "3.Custos", label: "3.Custos → Compras" },
  { id: "701885961", nome: "Materiais de Limpeza", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Materiais de Limpeza" },
  { id: "484437483", nome: "Material de Escritório", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Material de Escritório" },
  { id: "484437787", nome: "Combustível", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Combustível" },
  { id: "484437789", nome: "Outras Despesas", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Outras Despesas" },
];

interface DanfeReviewPanelProps {
  apiBase: string;
  mode: "demo" | "live";
  getAuthHeaders: () => Record<string, string>;
  refreshSignal: number;
  onConfirmed?: () => void;
}

export function DanfeReviewPanel({
  apiBase,
  mode,
  getAuthHeaders,
  refreshSignal,
  onConfirmed,
}: DanfeReviewPanelProps) {
  const { can } = useAuth();
  const canLaunch = can("revisao_nfe:lancar");
  const canArchive = can("revisao_nfe:arquivar");
  const [notas, setNotas] = useState<DanfePendingReviewEntry[]>([]);
  const [categories, setCategories] = useState<TinyCategory[]>([]);
  const [selections, setSelections] = useState<Record<string, Record<string, string>>>({});
  const [paymentMethods, setPaymentMethods] = useState<Record<string, string>>({});
  const [paymentMethodsNfe, setPaymentMethodsNfe] = useState<Record<string, string>>({});
  const [parcelasPorNota, setParcelasPorNota] = useState<Record<string, number>>({});
  const [selectedChaves, setSelectedChaves] = useState<Record<string, boolean>>({});
  const [confirmingChave, setConfirmingChave] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [archivingChave, setArchivingChave] = useState<string | null>(null);
  const [restoringChave, setRestoringChave] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Record<string, ConfirmLancamentoResponse>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DanfeNotaStatus>("pending");
  const [colFilters, setColFilters] = useState<ColumnFiltersState>(() =>
    carregarFiltrosSession("danfe", "notas"),
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const updateColFilter = (id: string, val: ColumnFilterValue | undefined) => {
    setColFilters((prev) => {
      const proximo = { ...prev };
      if (val === undefined) {
        delete proximo[id];
      } else {
        proximo[id] = val;
      }
      salvarFiltrosSession("danfe", "notas", proximo);
      return proximo;
    });
    setVisibleCount(PAGE_SIZE);
  };

  const clearFilters = () => {
    setColFilters({});
    salvarFiltrosSession("danfe", "notas", {});
    setVisibleCount(PAGE_SIZE);
  };

  // Buckets de demonstração: mantidos localmente (não vêm de API) para que arquivar/
  // restaurar/confirmar em modo demo persista entre trocas de filtro sem depender de
  // um backend real. `demoPendingRef` só é gerado uma vez, na 1ª carga, para não perder
  // ações do usuário quando `refreshSignal` disparar uma nova chamada a loadNotas().
  const demoPendingRef = useRef<DanfePendingReviewEntry[] | null>(null);
  const demoConfirmedRef = useRef<DanfePendingReviewEntry[]>([]);
  const demoArchivedRef = useRef<DanfePendingReviewEntry[]>([]);

  const filteredNotas = useMemo(() => {
    return aplicaFiltros(notas, colFilters, DANFE_DEFS);
  }, [notas, colFilters]);

  // Só renderiza os N primeiros cards por vez — com centenas de notas, montar tudo de
  // uma vez (cada card com vários <select> de categoria) é o que deixa a troca de
  // filtro lenta. "Carregar mais" avança essa janela sem refazer a busca no servidor.
  const visibleNotas = useMemo(() => filteredNotas.slice(0, visibleCount), [filteredNotas, visibleCount]);

  const categoriesByGroup = useMemo(() => {
    return categories.reduce<Record<string, TinyCategory[]>>((acc, cat) => {
      (acc[cat.grupo] ||= []).push(cat);
      return acc;
    }, {});
  }, [categories]);

  // Construída uma única vez por carregamento de categorias e reaproveitada em TODOS os
  // dropdowns de categoria dos cards — evita reconstruir a mesma árvore de ~70 opções a
  // cada card renderizado, que é o maior custo de DOM/CPU da tela em listas grandes.
  const categoryOptionsNode = useMemo(
    () => (
      <>
        {Object.entries(categoriesByGroup).map(([grupo, cats]) => (
          <NativeSelectOptGroup key={grupo} label={grupo}>
            {cats.map((cat) => (
              <NativeSelectOption key={cat.id} value={cat.id}>
                {cat.nome}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        ))}
      </>
    ),
    [categoriesByGroup],
  );

  const categoryName = useCallback(
    (id: string) => categories.find((c) => c.id === id)?.nome ?? "Compras",
    [categories],
  );

  const seedSelections = useCallback((entries: DanfePendingReviewEntry[]) => {
    setSelections((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        const merged = { ...next[entry.chave] };
        for (const item of entry.itens) {
          if (!(item.item_id in merged)) {
            merged[item.item_id] = item.categoria_sugerida_id;
          }
        }
        next[entry.chave] = merged;
      }
      return next;
    });
    setPaymentMethods((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (!(entry.chave in next)) {
          next[entry.chave] = suggestPaymentMethodForNote(entry.nfe_data.marcador_caixa, entry.nfe_data.destinatario_cnpj);
        }
      }
      return next;
    });
    setPaymentMethodsNfe((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (!(entry.chave in next)) {
          next[entry.chave] = entry.nfe_data.meio_pagamento_nfe || "";
        }
      }
      return next;
    });
    setSelectedChaves((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (!(entry.chave in next)) {
          next[entry.chave] = true;
        }
      }
      return next;
    });
  }, []);

  const loadCategories = useCallback(async () => {
    if (mode === "demo") {
      setCategories(DEMO_CATEGORIES);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/danfe/tiny-categories`, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(await readApiError(res, 'Falha ao carregar os dados'));
      setCategories((await res.json()) as TinyCategory[]);
    } catch (e) {
      console.error("Falha ao carregar categorias do Tiny:", e);
    }
  }, [apiBase, getAuthHeaders, mode]);

  const loadNotas = useCallback(async () => {
    if (mode === "demo") {
      if (!demoPendingRef.current) {
        demoPendingRef.current = makeDemoDanfePendingReview();
      }
      const bucket =
        statusFilter === "pending"
          ? demoPendingRef.current
          : statusFilter === "confirmed"
            ? demoConfirmedRef.current
            : demoArchivedRef.current;
      setNotas(bucket);
      setLoadError(null);
      if (statusFilter === "pending") seedSelections(bucket);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/danfe/notas?status=${statusFilter}`, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(await readApiError(res, 'Falha ao carregar os dados'));
      const data = (await res.json()) as { notas: DanfePendingReviewEntry[] };
      setNotas(data.notas || []);
      setLoadError(null);
      // Seed sugestões para itens novos, sem sobrescrever escolhas já feitas pelo usuário.
      if (statusFilter === "pending") seedSelections(data.notas || []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Falha ao carregar notas.");
    }
  }, [apiBase, getAuthHeaders, mode, seedSelections, statusFilter]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    void loadNotas();
  }, [loadNotas, refreshSignal]);

  const handleCategoryChange = useCallback((chave: string, itemId: string, categoriaId: string) => {
    setSelections((prev) => ({
      ...prev,
      [chave]: { ...prev[chave], [itemId]: categoriaId },
    }));
  }, []);

  const handlePaymentMethodChange = useCallback((chave: string, formaPagamentoId: string) => {
    setPaymentMethods((prev) => ({ ...prev, [chave]: formaPagamentoId }));
  }, []);

  const handlePaymentMethodNfeChange = useCallback((chave: string, code: string) => {
    setPaymentMethodsNfe((prev) => ({ ...prev, [chave]: code }));
  }, []);

  const handleParcelasChange = useCallback((chave: string, parcelas: number) => {
    setParcelasPorNota((prev) => ({ ...prev, [chave]: parcelas }));
  }, []);

  const handleToggleSelected = useCallback((chave: string, checked: boolean) => {
    setSelectedChaves((prev) => ({ ...prev, [chave]: checked }));
  }, []);

  const handleConfirm = useCallback(async (entry: DanfePendingReviewEntry) => {
    setConfirmingChave(entry.chave);

    if (mode === "demo") {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const preview = computeGroupPreview(
        entry.itens,
        selections[entry.chave] ?? {},
        categoryName,
        entry.nfe_data.valor_total,
      );
      const result: ConfirmLancamentoResponse = {
        chave: entry.chave,
        status: "success",
        grupos: preview.map((g, idx) => ({
          categoria_id: g.categoriaId,
          categoria_nome: g.categoriaNome,
          valor_total: g.valorTotal,
          item_ids: g.itemIds,
          tiny_result: {
            conta_id: 90000 + idx,
            nro_documento: preview.length > 1 ? `DEMO-${idx + 1}` : "DEMO",
            valor: g.valorTotal,
            vencimento: new Date().toISOString().slice(0, 10),
            situacao: "aberto",
            is_duplicate: false,
          },
          status: "success",
          error_message: null,
        })),
      };
      setLastResult((prev) => ({ ...prev, [entry.chave]: result }));
      const entrySelections = selections[entry.chave] ?? {};
      const confirmedEntry: DanfePendingReviewEntry = {
        ...entry,
        itens: entry.itens.map((item) => {
          const categoriaId = entrySelections[item.item_id] || item.categoria_sugerida_id;
          return { ...item, categoria_sugerida_id: categoriaId, categoria_sugerida_nome: categoryName(categoriaId) };
        }),
      };
      demoPendingRef.current = (demoPendingRef.current ?? []).filter((p) => p.chave !== entry.chave);
      demoConfirmedRef.current = [confirmedEntry, ...demoConfirmedRef.current];
      setNotas((prev) => prev.filter((p) => p.chave !== entry.chave));
      onConfirmed?.();
      setConfirmingChave(null);
      return;
    }

    try {
      const itens = entry.itens.map((item) => ({
        item_id: item.item_id,
        categoria_id: selections[entry.chave]?.[item.item_id] || item.categoria_sugerida_id,
      }));

      const formaPagamento = paymentMethods[entry.chave] ?? suggestPaymentMethodForNote(entry.nfe_data.marcador_caixa, entry.nfe_data.destinatario_cnpj);
      const meioPagamentoNfe = paymentMethodsNfe[entry.chave] ?? entry.nfe_data.meio_pagamento_nfe ?? "";

      const res = await fetch(`${apiBase}/api/danfe/confirm-lancamento`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          chave: entry.chave,
          itens,
          forma_pagamento: formaPagamento,
          meio_pagamento_nfe: meioPagamentoNfe || null,
          parcelas: parcelasPorNota[entry.chave] ?? 1,
        }),
      });
      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }

      const result = (await res.json()) as ConfirmLancamentoResponse;
      setLastResult((prev) => ({ ...prev, [entry.chave]: result }));

      if (result.status === "success") {
        setNotas((prev) => prev.filter((p) => p.chave !== entry.chave));
      } else {
        // Falha parcial: recarrega para refletir o estado real (nota continua pendente).
        void loadNotas();
      }
      onConfirmed?.();
    } catch (e) {
      setLastResult((prev) => ({
        ...prev,
        [entry.chave]: {
          chave: entry.chave,
          status: "partial_error",
          grupos: [
            {
              categoria_id: "",
              categoria_nome: "",
              valor_total: 0,
              item_ids: [],
              tiny_result: null,
              status: "error",
              error_message: e instanceof Error ? e.message : "Falha ao confirmar lançamento.",
            },
          ],
        },
      }));
      onConfirmed?.();
    } finally {
      setConfirmingChave(null);
    }
  }, [mode, selections, categoryName, onConfirmed, apiBase, getAuthHeaders, paymentMethods, paymentMethodsNfe, parcelasPorNota, loadNotas]);

  const handleConfirmAll = useCallback(async () => {
    setConfirmingAll(true);
    const snapshot = visibleNotas.filter((entry) => selectedChaves[entry.chave] !== false);
    for (const entry of snapshot) {
      await handleConfirm(entry);
    }
    setConfirmingAll(false);
  }, [visibleNotas, selectedChaves, handleConfirm]);

  const handleArchive = useCallback(async (entry: DanfePendingReviewEntry) => {
    setArchivingChave(entry.chave);
    if (mode === "demo") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      demoPendingRef.current = (demoPendingRef.current ?? []).filter((p) => p.chave !== entry.chave);
      demoArchivedRef.current = [entry, ...demoArchivedRef.current];
      setNotas((prev) => prev.filter((p) => p.chave !== entry.chave));
      setArchivingChave(null);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/danfe/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ chave: entry.chave }),
      });
      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }
      setNotas((prev) => prev.filter((p) => p.chave !== entry.chave));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Falha ao arquivar a nota.");
    } finally {
      setArchivingChave(null);
    }
  }, [mode, apiBase, getAuthHeaders]);

  const handleRestore = useCallback(async (entry: DanfePendingReviewEntry) => {
    setRestoringChave(entry.chave);
    if (mode === "demo") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      demoArchivedRef.current = demoArchivedRef.current.filter((p) => p.chave !== entry.chave);
      demoPendingRef.current = [entry, ...(demoPendingRef.current ?? [])];
      setNotas((prev) => prev.filter((p) => p.chave !== entry.chave));
      setRestoringChave(null);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/danfe/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ chave: entry.chave }),
      });
      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }
      setNotas((prev) => prev.filter((p) => p.chave !== entry.chave));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Falha ao restaurar a nota.");
    } finally {
      setRestoringChave(null);
    }
  }, [mode, apiBase, getAuthHeaders]);

  const isFiltered = filtrosAtivosCount(colFilters, DANFE_DEFS) > 0;
  const isPaginated = visibleNotas.length < filteredNotas.length;
  const selectedCount = visibleNotas.filter((entry) => selectedChaves[entry.chave] !== false).length;
  const allVisibleSelected = visibleNotas.length > 0 && selectedCount === visibleNotas.length;

  const empresasOpcoes = useMemo(
    () => obterValoresUnicos(notas, DANFE_DEFS.empresa.accessor),
    [notas],
  );

  // Alterna entre marcar e desmarcar as notas carregadas: só desmarca tudo quando já
  // está tudo marcado; se estiver tudo desmarcado ou misto, marca tudo.
  const handleToggleSelectAll = () => {
    const shouldSelectAll = !allVisibleSelected;
    setSelectedChaves((prev) => {
      const next = { ...prev };
      for (const entry of visibleNotas) {
        next[entry.chave] = shouldSelectAll;
      }
      return next;
    });
  };

  const handleStatusFilterChange = (value: DanfeNotaStatus) => {
    setStatusFilter(value);
    setVisibleCount(PAGE_SIZE);
  };

  const handleExportCsv = () => {
    downloadCsv(
      `notas-${statusFilter}`,
      ["Nº nota", "Emissão", "Chave de acesso", "Fornecedor", "CNPJ fornecedor", "Empresa", "CNPJ empresa", "Valor total", "Itens"],
      filteredNotas.map((n) => [
        n.nfe_data.numero_nota,
        n.nfe_data.data_emissao,
        n.chave,
        n.nfe_data.emitente_nome,
        n.nfe_data.emitente_cnpj,
        resolveCompanyDisplayName(n.nfe_data.destinatario_cnpj, n.nfe_data.destinatario_nome),
        n.nfe_data.destinatario_cnpj,
        n.nfe_data.valor_total,
        n.itens.length,
      ]),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <ClipboardList className="text-[var(--status-pending-fg)]" size={20} />
            {STATUS_LABELS[statusFilter].title}
          </h2>
          <NativeSelect
            size="sm"
            aria-label="Filtrar por status"
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value as DanfeNotaStatus)}
            className="h-8 text-xs w-auto min-w-[170px]"
          >
            <NativeSelectOption value="pending">Pendentes de Revisão</NativeSelectOption>
            <NativeSelectOption value="confirmed">Lançados no Tiny</NativeSelectOption>
            <NativeSelectOption value="archived">Arquivados</NativeSelectOption>
          </NativeSelect>
        </div>
        <span className="text-xs text-muted-foreground">
          {notas.length} {notas.length === 1 ? STATUS_LABELS[statusFilter].singular : STATUS_LABELS[statusFilter].plural}
        </span>
      </div>

      <ColumnFilterBar
        totalCount={notas.length}
        filteredCount={filteredNotas.length}
        activeFiltersCount={filtrosAtivosCount(colFilters, DANFE_DEFS)}
        onClearAll={clearFilters}
        onExportCsv={filteredNotas.length > 0 ? handleExportCsv : undefined}
        itemLabel="notas"
      />

      <div className="flex flex-wrap items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-xs">
        <span className="text-muted-foreground font-medium mr-1">Filtros:</span>
        <ColumnFilterHeader
          def={DANFE_DEFS.numero_nota}
          value={colFilters.numero_nota}
          onChange={(v) => updateColFilter("numero_nota", v)}
        />
        <ColumnFilterHeader
          def={DANFE_DEFS.data_emissao}
          value={colFilters.data_emissao}
          onChange={(v) => updateColFilter("data_emissao", v)}
        />
        <ColumnFilterHeader
          def={DANFE_DEFS.fornecedor}
          value={colFilters.fornecedor}
          onChange={(v) => updateColFilter("fornecedor", v)}
        />
        <ColumnFilterHeader
          def={DANFE_DEFS.empresa}
          value={colFilters.empresa}
          options={empresasOpcoes}
          onChange={(v) => updateColFilter("empresa", v)}
        />
        <ColumnFilterHeader
          def={DANFE_DEFS.valor_total}
          value={colFilters.valor_total}
          onChange={(v) => updateColFilter("valor_total", v)}
        />
      </div>

      {loadError && (
        <div className="p-3 rounded-lg bg-[var(--status-error-bg)] border border-[var(--status-error-border)] text-[var(--status-error-fg)] text-xs">
          {loadError}
        </div>
      )}

      {notas.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground border-dashed">
          {STATUS_LABELS[statusFilter].empty}
        </Card>
      ) : filteredNotas.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground border-dashed space-y-2">
          <p>Nenhuma nota corresponde aos filtros selecionados.</p>
          <Button variant="outline" size="sm" onClick={clearFilters} className="cursor-pointer">
            Limpar filtros
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {statusFilter === "pending" && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer w-fit">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={handleToggleSelectAll}
                disabled={confirmingAll}
                aria-label="Selecionar todas as notas carregadas"
              />
              Selecionar todos ({selectedCount} de {visibleNotas.length})
            </label>
          )}
          {visibleNotas.map((entry) => (
            <NotaCard
              key={entry.chave}
              entry={entry}
              statusFilter={statusFilter}
              isSelected={selectedChaves[entry.chave] !== false}
              isConfirming={confirmingChave === entry.chave}
              isArchiving={archivingChave === entry.chave}
              isRestoring={restoringChave === entry.chave}
              confirmingAll={confirmingAll}
              categorySelection={selections[entry.chave] ?? EMPTY_SELECTION}
              paymentMethod={paymentMethods[entry.chave] ?? suggestPaymentMethodForNote(entry.nfe_data.marcador_caixa, entry.nfe_data.destinatario_cnpj)}
              paymentMethodNfe={paymentMethodsNfe[entry.chave] ?? entry.nfe_data.meio_pagamento_nfe ?? ""}
              parcelas={parcelasPorNota[entry.chave] ?? 1}
              categoryOptionsNode={categoryOptionsNode}
              categoryName={categoryName}
              result={lastResult[entry.chave]}
              onToggleSelected={handleToggleSelected}
              onCategoryChange={handleCategoryChange}
              onPaymentMethodChange={handlePaymentMethodChange}
              onPaymentMethodNfeChange={handlePaymentMethodNfeChange}
              onParcelasChange={handleParcelasChange}
              onArchive={handleArchive}
              onRestore={handleRestore}
              canArchive={canArchive}
            />
          ))}

          {isPaginated && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                className="cursor-pointer"
              >
                Carregar mais ({visibleNotas.length} de {filteredNotas.length})
              </Button>
            </div>
          )}

          {statusFilter === "pending" && canLaunch && (
            <div className="flex justify-end">
              <Button
                variant="cta"
                size="default"
                onClick={() => void handleConfirmAll()}
                disabled={confirmingAll || selectedCount === 0}
                className="gap-2 cursor-pointer disabled:opacity-60"
              >
                {confirmingAll ? (
                  <>
                    <Loader2 className="animate-spin" size={14} />
                    <span>Enviando notas ao Tiny...</span>
                  </>
                ) : (
                  <>
                    <Send size={14} />
                    <TinyLogo size={14} />
                    <span>
                      {selectedCount === 0
                        ? "Nenhuma nota selecionada"
                        : (
                          <>
                            Confirmar e Enviar{" "}
                            {isPaginated
                              ? `${selectedCount} de ${visibleNotas.length} Notas carregadas`
                              : selectedCount !== filteredNotas.length
                                ? `${selectedCount} de ${filteredNotas.length} Notas selecionadas`
                                : isFiltered
                                  ? `${filteredNotas.length} de ${notas.length} Notas (filtradas)`
                                  : filteredNotas.length === 1
                                    ? "1 Nota"
                                    : `${filteredNotas.length} Notas`}{" "}
                            ao Tiny
                          </>
                        )}
                    </span>
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DanfeReviewPanel;
