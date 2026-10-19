"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle, CircleCheck, Clock3, Download, Flag, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { N8nLogo } from "@/components/ui/brand-logos";
import { Button } from "@/components/ui/button";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import type { Execution, DateRangeFilter } from "@/lib/contracts";
import { dateTime, duration } from "@/lib/formatters";
import { Empty, SourceError } from "./panel-state";
import { HistoryFilter } from "@/components/history-filter";
import { BatchExecutionView } from "@/components/batch-execution-view";
import { isDateWithinFilter } from "@/lib/date-range-utils";
import { groupExecutions } from "@/lib/batch-grouping";
import { ReportIncidentModal } from "@/components/report-incident-modal";
import { isExecutionReported, subscribeToIncidents } from "@/lib/incidents-store";
import { downloadCsv } from "@/lib/csv-export";

const STATUS_CSV_LABEL: Record<string, string> = {
  success: "Sucesso",
  error: "Erro",
  waiting: "Aguardando",
  running: "Em execução",
  unknown: "Desconhecido",
};

const statusLabels: Record<Execution["status"], { label: string; tone: string }> = {
  success: { label: "Sucesso", tone: "teal" },
  error: { label: "Erro", tone: "red" },
  running: { label: "Executando", tone: "blue" },
  waiting: { label: "Aguardando", tone: "amber" },
  unknown: { label: "Desconhecido", tone: "neutral" },
};

type StatusFilter = "all" | Execution["status"];
const filters: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "success", label: "Sucesso" },
  { value: "running", label: "Executando" },
  { value: "error", label: "Erro" },
  { value: "waiting", label: "Aguardando" },
];

export default function Executions({
  executions,
  loading,
  error,
}: {
  executions: Execution[] | null;
  loading: boolean;
  error?: string;
}) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateRangeFilter>({ key: "all" });
  const [viewMode, setViewMode] = useState<"batch" | "flat">("batch");
  const [reportingExecution, setReportingExecution] = useState<Execution | null>(null);
  const [, setIncidentsVersion] = useState(0);

  useEffect(() => {
    return subscribeToIncidents(() => {
      setIncidentsVersion((v) => v + 1);
    });
  }, []);

  // Filtra por status e intervalo de data simultaneamente
  const filtered = useMemo(() => {
    if (!executions) return [];
    return executions.filter((execution) => {
      const matchStatus = filter === "all" || execution.status === filter;
      const matchDate = isDateWithinFilter(execution.startedAt, dateFilter);
      return matchStatus && matchDate;
    });
  }, [executions, filter, dateFilter]);

  // Agrupa execuções em lotes temporais (janela de 5 minutos)
  const batches = useMemo(() => {
    return groupExecutions(filtered, { windowMinutes: 5 });
  }, [filtered]);

  return (
    <section className="execution-section" aria-labelledby="executions-title">
      <div className="section-heading">
        <div>
          <h2 id="executions-title">Histórico de execuções</h2>
          <p>Telemetria técnica da automação, direto do n8n.</p>
        </div>
        <span className="font-mono text-[11px] tabular-nums">
          <Activity size={14} />
          {executions?.length ?? 0} execuções registradas
        </span>
      </div>

      <div className="panel space-y-4">
        {/* Toolbar combinada: Provider + Filtro de Status + Filtro de Período/Calendário */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 border-b border-border/40 pb-3">
          <div className="execution-provider">
            <span className="n8n-mark">
              <Workflow size={17} />
            </span>
            <strong>Contas a Pagar</strong>
            <Badge variant="outline" className="source-label font-mono text-[10px] flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
                <N8nLogo size={12} />
              </span>
              <span>n8n</span>
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Filtros de Status */}
            <div
              role="group"
              aria-label="Filtrar execuções por status"
              className="status-filters"
            >
              {filters.map((option) => (
                <Button
                  key={option.value}
                  variant="ghost"
                  size="sm"
                  className={filter === option.value ? "filter-active" : ""}
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <span className="text-border hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* Filtro de Período com Calendário Interativo */}
            <HistoryFilter
              value={dateFilter}
              onChange={setDateFilter}
              totalFilteredCount={filtered.length}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              disabled={filtered.length === 0}
              onClick={() =>
                downloadCsv(
                  "execucoes-contas-a-pagar",
                  ["ID", "Início", "Fim", "Duração (s)", "Status", "Etapa onde parou"],
                  filtered.map((e) => [
                    e.id,
                    e.startedAt ? dateTime(e.startedAt) : "",
                    e.stoppedAt ? dateTime(e.stoppedAt) : "",
                    e.durationMs === null ? null : Math.round(e.durationMs / 1000),
                    STATUS_CSV_LABEL[e.status] ?? e.status,
                    e.stoppedNode,
                  ]),
                )
              }
            >
              <Download size={13} />
              CSV
            </Button>
          </div>
        </div>

        {/* Estado da Tabela / Carregamento / Vazio */}
        {executions === null ? (
          loading ? (
            <div className="table-loading">Consultando execuções…</div>
          ) : (
            <SourceError message={error} />
          )
        ) : filtered.length === 0 ? (
          <Empty>
            {executions.length === 0
              ? "Nenhuma execução registrada."
              : "Nenhuma execução encontrada para os filtros aplicados."}
          </Empty>
        ) : (
          <BatchExecutionView<Execution>
            batches={batches}
            totalItemsCount={filtered.length}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            renderItemHeaders={() => (
              <>
                <TableHead className="font-semibold text-xs">Execução</TableHead>
                <TableHead className="font-semibold text-xs">Início · Brasília</TableHead>
                <TableHead className="font-semibold text-xs">Duração</TableHead>
                <TableHead className="font-semibold text-xs">Status</TableHead>
                <TableHead className="font-semibold text-xs">Nó de parada</TableHead>
                <TableHead className="font-semibold text-xs text-right">Ação</TableHead>
              </>
            )}
            renderItemRow={(execution) => {
              const status = statusLabels[execution.status];
              const isError = execution.status === "error";
              const reported = isExecutionReported(execution.id);

              return (
                <TableRow key={execution.id} className="hover:bg-muted/40 text-sm transition-colors">
                  <TableCell>
                    <span className="execution-id font-mono text-xs font-semibold flex items-center gap-1.5">
                      <Workflow size={14} className="text-muted-foreground" />
                      <code className="text-foreground font-semibold">#{execution.id}</code>
                    </span>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-muted-foreground font-sans">
                    {dateTime(execution.startedAt)}
                  </TableCell>
                  <TableCell>
                    <span className="date-cell text-sm tabular-nums text-muted-foreground font-sans flex items-center gap-1.5">
                      <Clock3 size={13} />
                      {duration(execution.durationMs)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className={`status-badge ${status.tone} text-xs font-medium`}>
                      {execution.status === "success" ? (
                        <CircleCheck size={12} />
                      ) : (
                        <span className="status-dot" />
                      )}
                      {status.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {execution.stoppedNode ? (
                      <code className="text-xs px-2 py-0.5 rounded bg-muted/60 text-foreground font-mono">
                        {execution.stoppedNode}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isError ? (
                      reported ? (
                        <span
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                          title="Incidente já encaminhado para a fila de resolução do administrador"
                        >
                          <CheckCircle size={12} />
                          Reportado
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReportingExecution(execution)}
                          className="h-7 px-2.5 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:text-rose-700 hover:bg-rose-500/10 border-rose-500/30 gap-1.5 cursor-pointer shadow-2xs"
                        >
                          <Flag size={12} />
                          Reportar
                        </Button>
                      )
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            }}
          />
        )}

        {reportingExecution && (
          <ReportIncidentModal
            isOpen={!!reportingExecution}
            onClose={() => setReportingExecution(null)}
            executionId={reportingExecution.id}
            automationId="accounts-payable"
            automationTitle="Contas a Pagar"
            stoppedNode={reportingExecution.stoppedNode ?? undefined}
          />
        )}

        <div className="table-footer">
          <span className="font-mono text-xs tabular-nums">
            {filtered.length} de {executions?.length ?? "—"} execuções exibidas ({batches.length}{" "}
            {batches.length === 1 ? "lote" : "lotes"})
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            Filtros sincronizados com America/Sao_Paulo (UTC-3)
          </span>
        </div>
      </div>

      <p className="telemetry-note text-xs">
        “Aguardando” indica uma execução suspensa no fluxo; “Executando” indica processamento em
        andamento. O nó é exibido somente quando informado pela API.
      </p>
    </section>
  );
}
