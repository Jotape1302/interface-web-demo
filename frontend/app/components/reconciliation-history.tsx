"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, DatabaseZap, History, RefreshCw, SearchX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SourceError } from "./panel-state";
import { ColumnFilterBar, ColumnFilterHeader } from "./column-filter";
import { formatDateBR, money } from "@/lib/formatters";
import { toSaoPauloISODate } from "@/lib/date-range-utils";
import {
  carregarFiltrosSession,
  converterParaDateRange,
  filtrosAtivosCount,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type ColumnFiltersState,
  type DateFilterValue,
} from "@/lib/column-filters";
import { downloadCsv } from "@/lib/csv-export";
import type {
  BaixaHistoricoItem,
  BaixaHistoricoQuery,
  BaixaHistoricoResponse,
  BaixaHistoricoStatus,
} from "@/lib/reconciliation-contracts";
import {
  MATCH_METHOD_META,
  RECONCILIATION_COMPANIES,
  companyLabel,
  formatExecutadoEm,
  historicoPageCount,
} from "@/lib/reconciliation-helpers";
import type { ReconciliationService } from "@/lib/reconciliation-service";

const PAGE_SIZE = 50;
const SKELETON_ROWS = 8;

interface ReconciliationHistoryProps {
  service: ReconciliationService;
  /** Incrementado pelo pai após uma baixa com sucesso, para recarregar a lista. */
  reloadSignal: number;
}

// Os filtros desta tabela são aplicados no gateway (o histórico é paginado no servidor), então
// só existem aqui as colunas que o endpoint sabe filtrar.
const RESULTADO_ROTULOS: Record<BaixaHistoricoStatus, string> = {
  sucesso: "Baixadas",
  erro: "Com erro",
  pendente: "Em andamento",
};

const HISTORICO_DEFS: Record<string, ColumnFilterDef<BaixaHistoricoItem>> = {
  executado_em: { id: "executado_em", label: "Executado em", tipo: "data", accessor: (h) => h.executado_em },
  usuario: { id: "usuario", label: "Usuário", tipo: "texto", accessor: (h) => h.usuario_nome || "" },
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (h) => companyLabel(h.empresa) },
  documento: { id: "documento", label: "Conta / Doc", tipo: "texto", accessor: (h) => `${h.numero_documento || ""} ${h.conta_pagar_id}`.trim() },
  fornecedor: { id: "fornecedor", label: "Fornecedor", tipo: "texto", accessor: (h) => h.fornecedor_nome || "" },
  resultado: { id: "resultado", label: "Resultado", tipo: "lista", accessor: (h) => RESULTADO_ROTULOS[h.status] ?? h.status },
};

function extrairDeAte(val: ColumnFilterValue | undefined): { de?: string; ate?: string } {
  if (!val || typeof val !== "object" || Array.isArray(val) || !("preset" in val || "de" in val || "ate" in val)) {
    return {};
  }
  const df = val as DateFilterValue;
  if (df.preset && df.preset !== "all" && df.preset !== "custom") {
    const range = converterParaDateRange(df);
    return {
      de: range.from ? toSaoPauloISODate(range.from) : undefined,
      ate: range.to ? toSaoPauloISODate(range.to) : undefined,
    };
  }
  return { de: df.de || undefined, ate: df.ate || undefined };
}

function extrairEmpresas(val: ColumnFilterValue | undefined): string[] | undefined {
  if (!Array.isArray(val) || val.length === 0) return undefined;
  const ids = RECONCILIATION_COMPANIES.filter((c) => val.includes(c.nome) || val.includes(c.id)).map((c) => c.id);
  return ids.length ? ids : undefined;
}

function extrairStatus(val: ColumnFilterValue | undefined): BaixaHistoricoStatus[] | undefined {
  if (!Array.isArray(val) || val.length === 0) return undefined;
  const status = (Object.keys(RESULTADO_ROTULOS) as BaixaHistoricoStatus[]).filter((s) => val.includes(RESULTADO_ROTULOS[s]));
  return status.length ? status : undefined;
}

function texto(val: ColumnFilterValue | undefined): string | undefined {
  return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

const CSV_PAGE_SIZE = 200;

function HistorySkeleton() {
  return (
    <div className="divide-y divide-border" aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5 sm:px-5">
          <Skeleton className="h-4 w-28 shrink-0" />
          <Skeleton className="hidden h-4 w-20 shrink-0 sm:block" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <Skeleton className="hidden h-4 w-20 shrink-0 md:block" />
          <Skeleton className="h-4 w-24 shrink-0" />
          <Skeleton className="h-5 w-16 shrink-0 rounded-none" />
        </div>
      ))}
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return "O histórico demorou mais que o esperado para responder. Tente novamente.";
  }
  return e instanceof Error ? e.message : "Não foi possível carregar o histórico de baixas.";
}

export default function ReconciliationHistory({ service, reloadSignal }: ReconciliationHistoryProps) {
  const [colFilters, setColFilters] = useState<ColumnFiltersState>(() => carregarFiltrosSession("rec", "historico"));
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);

  const updateColFilter = (id: string, val: ColumnFilterValue | undefined) => {
    setColFilters((prev) => {
      const proximo = { ...prev };
      if (val === undefined) {
        delete proximo[id];
      } else {
        proximo[id] = val;
      }
      salvarFiltrosSession("rec", "historico", proximo);
      return proximo;
    });
    setPage(1);
  };

  const clearFilters = () => {
    setColFilters({});
    salvarFiltrosSession("rec", "historico", {});
    setPage(1);
  };

  const { de, ate } = useMemo(() => extrairDeAte(colFilters.executado_em), [colFilters.executado_em]);
  const datesInvalid = Boolean(de && ate && de > ate);

  // Sem a página: a mesma consulta serve para a tela e para o CSV (que busca todas as páginas).
  const filtrosQuery = useMemo<BaixaHistoricoQuery>(
    () => ({
      empresa: extrairEmpresas(colFilters.empresa),
      status: extrairStatus(colFilters.resultado),
      de,
      ate,
      fornecedor: texto(colFilters.fornecedor),
      documento: texto(colFilters.documento),
      usuario: texto(colFilters.usuario),
    }),
    [colFilters, de, ate],
  );
  const query = useMemo<BaixaHistoricoQuery>(() => ({ ...filtrosQuery, page, pageSize: PAGE_SIZE }), [filtrosQuery, page]);

  const requestKey = `${JSON.stringify(filtrosQuery)}|${page}|${reloadToken}|${reloadSignal}`;

  const [result, setResult] = useState<{ key: string; data: BaixaHistoricoResponse } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const loading = !datesInvalid && result?.key !== requestKey && error?.key !== requestKey;
  const currentError = error?.key === requestKey ? error.message : null;

  useEffect(() => {
    if (datesInvalid) return;
    const controller = new AbortController();
    service
      .fetchBaixaHistorico(query, controller.signal)
      .then((data) => setResult({ key: requestKey, data }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError({ key: requestKey, message: describeError(e) });
      });
    return () => controller.abort();
  }, [service, query, requestKey, datesInvalid]);

  const [exportando, setExportando] = useState(false);
  const [erroCsv, setErroCsv] = useState<string | null>(null);
  // CSV com todas as páginas do filtro atual, não só a que está na tela.
  const exportarCsv = async () => {
    setExportando(true);
    setErroCsv(null);
    try {
      const itens: BaixaHistoricoItem[] = [];
      for (let pagina = 1; ; pagina++) {
        const res = await service.fetchBaixaHistorico({ ...filtrosQuery, page: pagina, pageSize: CSV_PAGE_SIZE });
        itens.push(...res.itens);
        if (res.itens.length === 0 || itens.length >= res.total) break;
      }
      downloadCsv(
        `historico-baixas-${toSaoPauloISODate(new Date())}`,
        ["Executado em", "Usuário", "Empresa", "Conta", "Documento", "Fornecedor", "Vencimento", "Data pgto.", "Valor pago", "Resultado", "Lote", "Mensagem"],
        itens.map((h) => [
          formatExecutadoEm(h.executado_em),
          h.usuario_nome,
          companyLabel(h.empresa),
          h.conta_pagar_id,
          h.numero_documento,
          h.fornecedor_nome,
          h.data_vencimento,
          h.data_pagamento,
          h.valor_pago,
          RESULTADO_ROTULOS[h.status] ?? h.status,
          h.lote_id,
          h.mensagem,
        ]),
      );
    } catch (e) {
      setErroCsv(describeError(e));
    } finally {
      setExportando(false);
    }
  };

  const reload = () => setReloadToken((t) => t + 1);

  const data = result?.data ?? null;
  const hasFilters = filtrosAtivosCount(colFilters, HISTORICO_DEFS) > 0;
  const pages = data ? historicoPageCount(data.total, data.pageSize || PAGE_SIZE) : 1;
  const firstRow = data && data.total > 0 ? (data.page - 1) * (data.pageSize || PAGE_SIZE) + 1 : 0;
  const lastRow = data ? firstRow + data.itens.length - (data.itens.length > 0 ? 1 : 0) : 0;

  return (
    <section className="panel" aria-labelledby="rec-hist-titulo" aria-busy={loading}>
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="section-title">
          <div className="section-icon bg-[var(--marca-marinho)] text-[var(--marca-ambar)]">
            <History size={18} />
          </div>
          <div>
            <h3 id="rec-hist-titulo">Histórico de baixas</h3>
            <p>Cada conta liquidada no Tiny por esta tela, com quem executou, quando e o resultado.</p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={reload} disabled={loading} className="gap-1.5 self-start sm:self-auto">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Atualizar
        </Button>
      </div>

      {data && data.disponivel && (
        <ColumnFilterBar
          totalCount={data.total}
          filteredCount={data.total}
          activeFiltersCount={filtrosAtivosCount(colFilters, HISTORICO_DEFS)}
          onClearAll={clearFilters}
          onExportCsv={data.total > 0 && !exportando ? () => void exportarCsv() : undefined}
          itemLabel="registros"
        />
      )}
      {erroCsv && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-destructive sm:px-5">
          Não foi possível gerar o CSV: {erroCsv}
        </p>
      )}

      {datesInvalid ? (
        <div className="px-5 py-8 text-center text-xs">
          <p role="alert" className="text-destructive">
            Informe um período válido: a data inicial precisa ser igual ou anterior à final.
          </p>
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="outline" onClick={() => updateColFilter("executado_em", undefined)}>
              Limpar período
            </Button>
          </div>
        </div>
      ) : currentError ? (
        <>
          <SourceError message={currentError} />
          <div className="flex justify-end border-t border-border px-4 py-3">
            <Button size="sm" variant="outline" onClick={reload} className="gap-1.5">
              <RefreshCw size={13} />
              Tentar novamente
            </Button>
          </div>
        </>
      ) : !data || (loading && data.itens.length === 0) ? (
        <>
          <output className="sr-only">Carregando histórico de baixas…</output>
          <HistorySkeleton />
        </>
      ) : !data.disponivel ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          <DatabaseZap size={22} className="mx-auto mb-2.5 text-amber-700 dark:text-amber-400" />
          <p className="text-sm font-semibold text-foreground">Histórico indisponível: banco de dados não configurado</p>
          <p className="mx-auto mt-1 max-w-md">
            O gateway está rodando sem MariaDB, então as baixas executadas não estão sendo registradas. As baixas no
            Tiny continuam funcionando normalmente.
          </p>
        </div>
      ) : data.itens.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          {hasFilters ? (
            <SearchX size={22} className="mx-auto mb-2.5 text-primary" />
          ) : (
            <History size={22} className="mx-auto mb-2.5 text-primary" />
          )}
          <p className="text-sm font-semibold text-foreground">
            {hasFilters ? "Nenhuma baixa encontrada com esses filtros" : "Nenhuma baixa registrada ainda"}
          </p>
          <p className="mx-auto mt-1 max-w-md">
            {hasFilters
              ? "Ajuste ou limpe os filtros para ver outras execuções."
              : "Quando você confirmar baixas na aba Conciliação, cada conta liquidada aparece aqui para consulta."}
          </p>
          {hasFilters && (
            <div className="mt-4 flex justify-center">
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Limpar filtros
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <Table className="min-w-[1180px]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <ColumnFilterHeader
                    title="Executado em"
                    def={HISTORICO_DEFS.executado_em}
                    value={colFilters.executado_em}
                    onChange={(v) => updateColFilter("executado_em", v)}
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    title="Usuário"
                    def={HISTORICO_DEFS.usuario}
                    value={colFilters.usuario}
                    onChange={(v) => updateColFilter("usuario", v)}
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    title="Empresa"
                    def={HISTORICO_DEFS.empresa}
                    value={colFilters.empresa}
                    onChange={(v) => updateColFilter("empresa", v)}
                    uniqueValues={RECONCILIATION_COMPANIES.map((c) => c.nome)}
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    title="Conta / doc."
                    def={HISTORICO_DEFS.documento}
                    value={colFilters.documento}
                    onChange={(v) => updateColFilter("documento", v)}
                  />
                </TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    title="Fornecedor"
                    def={HISTORICO_DEFS.fornecedor}
                    value={colFilters.fornecedor}
                    onChange={(v) => updateColFilter("fornecedor", v)}
                  />
                </TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Data pgto.</TableHead>
                <TableHead className="text-right">Valor pago</TableHead>
                <TableHead>
                  <ColumnFilterHeader
                    title="Resultado"
                    def={HISTORICO_DEFS.resultado}
                    value={colFilters.resultado}
                    onChange={(v) => updateColFilter("resultado", v)}
                    uniqueValues={["Baixadas", "Com erro", "Em andamento"]}
                  />
                </TableHead>
                <TableHead>Lote</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.itens.map((h) => {
                const method = h.metodo_match ? MATCH_METHOD_META[h.metodo_match] : undefined;
                const acrescimos = h.juros + h.multa;
                return (
                  <TableRow key={h.id} className="align-top">
                    <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {formatExecutadoEm(h.executado_em)}
                    </TableCell>
                    <TableCell className="font-medium">{h.usuario_nome || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{companyLabel(h.empresa)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{h.numero_documento || "—"}</div>
                      <code>#{h.conta_pagar_id}</code>
                    </TableCell>
                    <TableCell>
                      <div className="min-w-40 max-w-64 whitespace-normal">
                        <div className="font-medium text-foreground">{h.fornecedor_nome || "Não informado"}</div>
                        {method && <div className="text-[11px] text-muted-foreground">{method.label}</div>}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatDateBR(h.data_vencimento)}</TableCell>
                    <TableCell className="tabular-nums">{formatDateBR(h.data_pagamento)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div className="font-semibold">{money(h.valor_pago)}</div>
                      {h.valor_tiny !== null && Math.abs(h.valor_tiny - h.valor_pago) > 0.005 && (
                        <div className="text-[11px] text-muted-foreground">Tiny: {money(h.valor_tiny)}</div>
                      )}
                      {(acrescimos > 0 || h.desconto > 0) && (
                        <div className="space-x-1.5 text-[11px]">
                          {acrescimos > 0 && (
                            <span className="text-amber-700 dark:text-amber-400">+{money(acrescimos)}</span>
                          )}
                          {h.desconto > 0 && (
                            <span className="text-sky-700 dark:text-sky-400">−{money(h.desconto)}</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-64 space-y-1 whitespace-normal">
                        <Badge variant={h.status === "sucesso" ? "success" : h.status === "pendente" ? "warning" : "danger"}>
                          {h.status === "sucesso" ? "Baixada" : h.status === "pendente" ? "Em andamento" : "Erro"}
                        </Badge>
                        {h.status === "erro" && h.mensagem && (
                          <p className="line-clamp-3 break-words text-[11px] text-rose-600 dark:text-rose-400" title={h.mensagem}>
                            {h.mensagem}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-24 truncate" title={h.lote_id}>
                        {h.lote_id.slice(0, 8)}
                      </code>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="table-footer">
            <span>
              {firstRow}–{lastRow} de {data.total} registro(s)
            </span>
            <div className="pagination">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={loading || data.page <= 1}
                onClick={() => setPage(data.page - 1)}
                aria-label="Página anterior do histórico"
              >
                <ChevronLeft />
              </Button>
              <span>
                Página {data.page} de {pages}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={loading || data.page >= pages}
                onClick={() => setPage(data.page + 1)}
                aria-label="Próxima página do histórico"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
