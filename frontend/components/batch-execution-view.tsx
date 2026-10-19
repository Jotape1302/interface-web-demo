"use client";

import * as React from "react";
import {
  Layers,
  List,
  CheckCircle2,
  AlertCircle,
  Clock3,
  ChevronDown,
  Workflow,
  DollarSign,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { duration, money } from "@/lib/formatters";
import type { BatchExecutionGroup } from "@/lib/contracts";

interface BatchExecutionViewProps<T> {
  batches: BatchExecutionGroup<T>[];
  totalItemsCount: number;
  viewMode: "batch" | "flat";
  onViewModeChange: (mode: "batch" | "flat") => void;
  renderItemRow: (item: T, index: number) => React.ReactNode;
  renderItemHeaders: () => React.ReactNode;
  emptyMessage?: string;
  className?: string;
}

export function BatchExecutionView<T>({
  batches,
  totalItemsCount,
  viewMode,
  onViewModeChange,
  renderItemRow,
  renderItemHeaders,
  emptyMessage = "Nenhuma execução registrada para o período selecionado.",
  className,
}: BatchExecutionViewProps<T>) {
  // Lotes expandidos (por padrão, o lote mais recente vem aberto)
  const [expandedBatchIds, setExpandedBatchIds] = React.useState<Record<string, boolean>>(() => {
    if (batches.length > 0) {
      return { [batches[0].id]: true };
    }
    return {};
  });

  // Atualiza se novos lotes chegarem e nenhum estiver expandido
  React.useEffect(() => {
    if (batches.length > 0) {
      setExpandedBatchIds((prev) => {
        if (Object.keys(prev).length === 0) {
          return { [batches[0].id]: true };
        }
        return prev;
      });
    }
  }, [batches]);

  const toggleBatch = (id: string) => {
    setExpandedBatchIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const expandAll = () => {
    const all = batches.reduce<Record<string, boolean>>((acc, b) => {
      acc[b.id] = true;
      return acc;
    }, {});
    setExpandedBatchIds(all);
  };

  const collapseAll = () => {
    setExpandedBatchIds({});
  };

  if (batches.length === 0 || totalItemsCount === 0) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground bg-muted/10 rounded-xl border border-border/40">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`space-y-3.5 ${className ?? ""}`}>
      {/* Barra de controle de visualização */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[11px] uppercase tracking-wider font-semibold">
            Visualização:
          </span>
          <div
            className="inline-flex rounded-lg bg-muted/40 p-0.5 border border-border/60"
            role="group"
            aria-label="Modo de visualização das execuções"
          >
            <button
              type="button"
              onClick={() => onViewModeChange("batch")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                viewMode === "batch"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground font-medium"
              }`}
            >
              <Layers size={13} />
              <span>Agrupado por Lotes</span>
              <span className="font-mono text-[10px] px-1 py-0.2 rounded bg-muted">
                {batches.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange("flat")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                viewMode === "flat"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground font-medium"
              }`}
            >
              <List size={13} />
              <span>Lista Contínua</span>
              <span className="font-mono text-[10px] px-1 py-0.2 rounded bg-muted">
                {totalItemsCount}
              </span>
            </button>
          </div>
        </div>

        {viewMode === "batch" && (
          <div className="flex items-center gap-1.5 text-xs">
            <Button
              variant="ghost"
              size="sm"
              onClick={expandAll}
              className="h-7 text-[11px] text-muted-foreground hover:text-foreground px-2"
            >
              Expandir todos
            </Button>
            <span className="text-muted-foreground">·</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={collapseAll}
              className="h-7 text-[11px] text-muted-foreground hover:text-foreground px-2"
            >
              Recolher todos
            </Button>
          </div>
        )}
      </div>

      {/* MODO 1: AGRUPADO POR LOTES (MASTER-DETAIL) */}
      {viewMode === "batch" ? (
        <div className="space-y-2.5">
          {batches.map((batch) => {
            const isExpanded = !!expandedBatchIds[batch.id];
            const { summary } = batch;
            const isFullSuccess = summary.successCount === summary.totalCount && summary.totalCount > 0;
            const hasErrors = summary.errorCount > 0;

            return (
              <Card
                key={batch.id}
                className="border border-border/70 overflow-hidden shadow-2xs transition-all bg-card hover:border-border"
              >
                {/* Cabeçalho do Lote */}
                <button
                  type="button"
                  onClick={() => toggleBatch(batch.id)}
                  aria-expanded={isExpanded}
                  className="w-full p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-left hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-muted/60 text-foreground border border-border/40 shrink-0">
                      <Workflow size={15} />
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-xs text-foreground font-mono">
                          Lote #{batch.batchNumber}
                        </span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs font-semibold text-foreground font-mono tabular-nums">
                          {batch.dateLabel}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono tabular-nums">
                          ({batch.timeRangeLabel})
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5 mt-1 text-[11px] text-muted-foreground">
                        <span className="font-mono tabular-nums">
                          {summary.totalCount} {summary.totalCount === 1 ? "execução" : "execuções"}
                        </span>
                        <span>·</span>
                        <span className="flex items-center gap-1 font-mono tabular-nums">
                          <Clock3 size={11} />
                          {duration(summary.durationMs)}
                        </span>
                        {summary.totalAmount !== undefined && summary.totalAmount > 0 && (
                          <>
                            <span>·</span>
                            <span className="flex items-center gap-1 font-mono tabular-nums text-foreground font-medium">
                              <DollarSign size={11} className="text-primary" />
                              Total: {money(summary.totalAmount)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 self-end md:self-center shrink-0">
                    {/* Badge de Taxa de Sucesso do Lote */}
                    <Badge
                      variant={isFullSuccess ? "default" : hasErrors ? "destructive" : "secondary"}
                      className={`text-xs gap-1 font-mono tabular-nums px-2 py-0.5 ${
                        isFullSuccess
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"
                          : hasErrors
                            ? "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                            : "bg-slate-500/15 text-muted-foreground border border-slate-500/30"
                      }`}
                    >
                      {isFullSuccess ? (
                        <CheckCircle2 size={11} />
                      ) : (
                        <AlertCircle size={11} />
                      )}
                      <span>
                        {summary.successCount}/{summary.totalCount} ({summary.successRateFormatted})
                      </span>
                    </Badge>

                    <ChevronDown
                      size={15}
                      className={`text-muted-foreground transition-transform duration-200 ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </div>
                </button>

                {/* Tabela dos Itens do Lote (Expandida) */}
                {isExpanded && (
                  <div className="border-t border-border/50 bg-background/50 overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-muted/25">
                        <TableRow>{renderItemHeaders()}</TableRow>
                      </TableHeader>
                      <TableBody>
                        {batch.items.map((item, idx) => renderItemRow(item, idx))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        /* MODO 2: LISTA CONTÍNUA PLANA */
        <div className="rounded-xl border border-border/70 overflow-hidden bg-card shadow-2xs">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>{renderItemHeaders()}</TableRow>
            </TableHeader>
            <TableBody>
              {batches.flatMap((b) => b.items).map((item, idx) => renderItemRow(item, idx))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
