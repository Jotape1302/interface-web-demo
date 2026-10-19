"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  Copy,
  FileSpreadsheet,
  FileText,
  Flag,
  Info,
  Layers,
  Play,
  PlayCircle,
  Radar,
  RefreshCw,
  ScanBarcode,
  Search,
  Send,
  Trash2,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { resolveApiBaseUrl } from "@/lib/contracts";
import { formatCnpjMask, formatDateBR, formatDateTimeBR } from "@/lib/formatters";
import type {
  DanfeBatchResponse,
  DanfeSefazStatus,
  DanfeItemResult,
  DanfeStatusResponse,
  DashboardConfig,
  DateRangeFilter,
} from "@/lib/contracts";
import { danfeAutomation } from "@/lib/automations";
import { matchesNotaSearch } from "@/lib/danfe-review-helpers";
import { downloadCsv } from "@/lib/csv-export";
import { HistoryFilter } from "@/components/history-filter";
import { BatchExecutionView } from "@/components/batch-execution-view";
import { TinyLogo } from "@/components/ui/brand-logos";
import { isDateWithinFilter } from "@/lib/date-range-utils";
import { ReportIncidentModal } from "@/components/report-incident-modal";
import { DanfeReviewPanel } from "./danfe-review-panel";
import { isExecutionReported, subscribeToIncidents } from "@/lib/incidents-store";
import { makeDemoDanfeHistory, makeDemoDanfeStatus, makeDemoSefazStatus } from "@/lib/demo";
import { groupDanfeHistory } from "@/lib/batch-grouping";
import { setIfChanged } from "@/lib/deep-equal";
import { useDataPolling } from "@/lib/use-data-polling";
import { readApiError } from '@/lib/api-errors';
import { useAuth } from "@/lib/auth-context";
import { ConfirmImpactDialog } from "./confirm-impact-dialog";

const FORCE_SEFAZ_RISK =
  "Ignora o intervalo mínimo de consulta da SEFAZ. Uso repetido pode bloquear a consulta da empresa (rejeição 656) por até 1 hora.";

interface DanfeHistoryItem {
  processed_at: string;
  original_filename?: string;
  chave_acesso?: string;
  metodo_leitura?: string;
  numero_nota?: string;
  emitente?: { razao_social?: string; cnpj?: string };
  valor_total?: number;
  audit_status?: string;
  details?: string;
  error_file?: string;
  resolved_at?: string | null;
  lancamentos_tiny?: Array<{
    conta_id?: number;
    nro_documento?: string;
    valor?: number;
    vencimento?: string;
    situacao?: string;
    /** true: a nota já estava no Tiny e nenhuma conta foi criada. */
    is_duplicate?: boolean;
  }>;
}

function FormattedAccessKey({ chave }: { chave?: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!chave) return <span className="text-muted-foreground">—</span>;
  // Sem espaços, igual ao XML e à SEFAZ: o que se vê é o que se cola.
  const rawKey = chave.replace(/\s+/g, "");
  const formatted = rawKey;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="inline-flex items-center gap-1.5 font-mono text-[11px] group">
      <span
        className="truncate max-w-[160px] font-mono tabular-nums text-foreground/90 font-medium select-all"
        title={rawKey}
      >
        {formatted}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted cursor-pointer shrink-0"
        title="Copiar chave completa de 44 dígitos"
      >
        {copied ? (
          <Check size={11} className="text-emerald-700 dark:text-emerald-400" />
        ) : (
          <Copy size={11} />
        )}
      </button>
    </div>
  );
}

function formatSyncTime(isoString?: string | null): string {
  if (!isoString) return "—";
  const normalized =
    isoString.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(isoString)
      ? isoString
      : `${isoString}Z`;
  const date = new Date(normalized);
  if (isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export default function DanfePanel({ config }: { config: DashboardConfig }) {
  // Botões de ação aparecem só com a permissão (o gateway barra do mesmo jeito).
  const { can } = useAuth();
  const canScan = can("revisao_nfe:varrer_sefaz");
  const canForceScan = can("revisao_nfe:forcar_varredura");
  const canImportKey = can("revisao_nfe:importar_chave");
  const canResolveFailure = can("revisao_nfe:resolver_falha");
  const canLaunch = can("revisao_nfe:lancar");
  const [confirmForceScan, setConfirmForceScan] = useState(false);
  const [statusInfo, setStatusInfo] = useState<DanfeStatusResponse | null>(null);
  const [sefazStatus, setSefazStatus] = useState<DanfeSefazStatus | null>(null);
  const sefazCnpjErrors = useMemo(
    () =>
      (sefazStatus?.cnpjs ?? []).filter(
        (c) => c.status === "erro" && c.erro && !c.erro.includes("656") && !c.erro.includes("Consumo Indevido"),
      ),
    [sefazStatus],
  );
  const cooldownSecondsRemaining = sefazStatus?.cooldown_seconds_remaining ?? 0;
  const certAlerts = useMemo(
    () => (sefazStatus?.certificados ?? []).filter((c) => c.alerta || c.erro),
    [sefazStatus],
  );
  const isSefazScanInCooldown = cooldownSecondsRemaining > 0;
  const cooldownMinutesLabel = `${Math.max(1, Math.ceil(cooldownSecondsRemaining / 60))} min`;
  const [isRunningSefazScan, setIsRunningSefazScan] = useState(false);
  const isScanning = Boolean(isRunningSefazScan || sefazStatus?.is_running);
  const [batchResult, setBatchResult] = useState<DanfeBatchResponse | null>(null);
  const [historyItems, setHistoryItems] = useState<DanfeHistoryItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showManualUpload, setShowManualUpload] = useState(false);
  const [manualChaveInput, setManualChaveInput] = useState("");
  const [isImportingKey, setIsImportingKey] = useState(false);
  const [importKeySuccess, setImportKeySuccess] = useState<string | null>(null);

  // Estados para filtro de período e modo de visualização do histórico
  const [historyDateFilter, setHistoryDateFilter] = useState<DateRangeFilter>({ key: "all" });
  const [historySearch, setHistorySearch] = useState("");
  const [historyViewMode, setHistoryViewMode] = useState<"batch" | "flat">("batch");

  // Estados para o upload manual secundário
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploadingManual, setIsUploadingManual] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Estado para reporte de falhas fiscais ao Administrador
  const [reportingIncident, setReportingIncident] = useState<{
    id: string;
    node?: string;
    details?: string;
  } | null>(null);
  const [, setIncidentsVersion] = useState(0);
  const [resolvingFile, setResolvingFile] = useState<string | null>(null);

  // Sinal para o painel de revisão/categorização recarregar a lista de notas pendentes
  // sempre que um novo lote termina de ser escaneado (sem re-renderizar o painel inteiro).
  const [reviewRefreshSignal, setReviewRefreshSignal] = useState(0);

  useEffect(() => {
    return subscribeToIncidents(() => {
      setIncidentsVersion((v) => v + 1);
    });
  }, []);

  // Filtragem e agrupamento de histórico fiscal em lotes
  const filteredHistory = useMemo(() => {
    return historyItems.filter(
      (item) =>
        isDateWithinFilter(item.processed_at, historyDateFilter) &&
        matchesNotaSearch(historySearch, [
          item.chave_acesso,
          item.numero_nota,
          item.emitente?.razao_social,
          item.emitente?.cnpj,
          item.original_filename,
        ]),
    );
  }, [historyItems, historyDateFilter, historySearch]);

  const historyBatches = useMemo(() => {
    return groupDanfeHistory(filteredHistory, { windowMinutes: 10 });
  }, [filteredHistory]);

  const apiBase = resolveApiBaseUrl(config.apiBaseUrl).replace(/\/$/, "");

  const getStoredAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (typeof window !== "undefined") {
      const token =
        window.localStorage.getItem("norvia_session_token") ||
        window.sessionStorage.getItem("norvia_session_token");
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        headers["x-session-token"] = token;
      }
    }
    return headers;
  }, []);

  // Carrega status dos provedores, da varredura SEFAZ e histórico recente
  const loadStatusAndHistory = useCallback(async (signal?: AbortSignal) => {
    if (config.mode === "demo") {
      setIfChanged(setStatusInfo, makeDemoDanfeStatus());
      setIfChanged(setSefazStatus, makeDemoSefazStatus());
      setIfChanged(setHistoryItems, makeDemoDanfeHistory());
      return;
    }

    try {
      const headers = getStoredAuthHeaders();

      const [statusRes, sefazRes, historyRes] = await Promise.allSettled([
        fetch(`${apiBase}/api/danfe/status`, { headers, signal }),
        fetch(`${apiBase}/api/danfe/sefaz-status`, { headers, signal }),
        fetch(`${apiBase}/api/danfe/history`, { headers, signal }),
      ]);

      if (signal?.aborted) return;

      if (statusRes.status === "fulfilled" && statusRes.value.ok) {
        setIfChanged(setStatusInfo, (await statusRes.value.json()) as DanfeStatusResponse);
      }
      if (sefazRes.status === "fulfilled" && sefazRes.value.ok) {
        setIfChanged(setSefazStatus, (await sefazRes.value.json()) as DanfeSefazStatus);
      }
      if (historyRes.status === "fulfilled" && historyRes.value.ok) {
        const hData = (await historyRes.value.json()) as { history?: DanfeHistoryItem[] };
        setIfChanged(setHistoryItems, hData.history || []);
      }
    } catch (e) {
      if (signal?.aborted) return;
      console.error("Falha ao carregar status ou histórico:", e);
    }
  }, [apiBase, config.mode, getStoredAuthHeaders]);

  useDataPolling(
    (signal) => loadStatusAndHistory(signal),
    {
      intervalMs: isScanning ? 2500 : 10000,
      pauseOnHidden: true,
      refetchOnVisible: true,
    },
  );

  // Tira a falha das pendências (ex.: nota lançada direto no Tiny). Ela continua no histórico.
  const handleResolveFailure = async (errorFile: string) => {
    setResolvingFile(errorFile);
    setErrorMessage(null);
    const markResolved = (resolvedAt: string) =>
      setHistoryItems((prev) =>
        prev.map((item) => (item.error_file === errorFile ? { ...item, resolved_at: resolvedAt } : item))
      );

    if (config.mode === "demo") {
      markResolved(new Date().toISOString());
      setResolvingFile(null);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/danfe/failures/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getStoredAuthHeaders() },
        body: JSON.stringify({ error_file: errorFile }),
      });
      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }
      const data = (await res.json()) as { resolved_at: string };
      markResolved(data.resolved_at);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Falha ao marcar a falha como resolvida.");
    } finally {
      setResolvingFile(null);
    }
  };

  // Ação Principal: Botão "Rodar agora" para disparar a varredura direta na SEFAZ
  // (distNSUInt) fora do horário agendado (SEFAZ_SCAN_HOUR, 1x/dia por padrão).
  const handleRunSefazScan = async (force = false) => {
    if ((isSefazScanInCooldown && !force) || isScanning) return;
    setConfirmForceScan(false);

    setIsRunningSefazScan(true);
    setErrorMessage(null);

    if (config.mode === "demo") {
      setTimeout(() => {
        setIsRunningSefazScan(false);
        setSefazStatus(makeDemoSefazStatus());
        setReviewRefreshSignal((v) => v + 1);
      }, 1000);
      return;
    }

    try {
      const res = await fetch(`${apiBase}/api/danfe/scan-sefaz${force ? "?force=true" : ""}`, {
        method: "POST",
        headers: getStoredAuthHeaders(),
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }

      const result: DanfeSefazStatus = (await res.json()) as DanfeSefazStatus;
      setSefazStatus(result);
      setReviewRefreshSignal((v) => v + 1);
      void loadStatusAndHistory();
    } catch (e) {
      setErrorMessage(
        e instanceof Error
          ? e.message
          : "Erro ao rodar a varredura SEFAZ. Verifique se a API funcional Python está rodando.",
      );
    } finally {
      setIsRunningSefazScan(false);
    }
  };

  // Upload manual secundário
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArr = Array.from(e.target.files);
      setSelectedFiles((prev) => [...prev, ...filesArr]);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArr = Array.from(e.dataTransfer.files);
      setSelectedFiles((prev) => [...prev, ...filesArr]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const clearFiles = () => {
    setSelectedFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImportKey = async () => {
    const rawKey = manualChaveInput.replace(/\D/g, "");
    if (rawKey.length !== 44) {
      setErrorMessage("A chave de acesso deve conter exatamente 44 dígitos numéricos.");
      return;
    }
    setIsImportingKey(true);
    setErrorMessage(null);
    setImportKeySuccess(null);

    try {
      const res = await fetch(`${apiBase}/api/danfe/import-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getStoredAuthHeaders(),
        },
        body: JSON.stringify({ chave: rawKey }),
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }

      const data = (await res.json()) as { numero_nota?: string | null };
      const numDoc = data.numero_nota || rawKey.slice(-8);
      setImportKeySuccess(`Nota fiscal nº ${numDoc} importada com sucesso para revisão!`);
      setManualChaveInput("");
      setReviewRefreshSignal((v) => v + 1);
      void loadStatusAndHistory();
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Falha ao importar NF-e pela chave de acesso.");
    } finally {
      setIsImportingKey(false);
    }
  };

  const handleProcessManualBatch = async () => {
    if (selectedFiles.length === 0) return;
    setIsUploadingManual(true);
    setErrorMessage(null);

    const formData = new FormData();
    selectedFiles.forEach((file) => {
      formData.append("files", file);
    });

    try {
      const headers = getStoredAuthHeaders();
      delete headers["Content-Type"];
      const res = await fetch(`${apiBase}/api/danfe/process-batch`, {
        method: "POST",
        headers,
        body: formData,
      });

      if (!res.ok) {
        throw new Error(await readApiError(res, 'Erro na requisição'));
      }

      const result: DanfeBatchResponse = (await res.json()) as DanfeBatchResponse;
      setBatchResult(result);
      setReviewRefreshSignal((v) => v + 1);
      clearFiles();
      void loadStatusAndHistory();
    } catch (e) {
      setErrorMessage(
        e instanceof Error
          ? e.message
          : "Erro ao processar lote manual. Verifique se o servidor Python está ativo.",
      );
    } finally {
      setIsUploadingManual(false);
    }
  };

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val);
  };

  const pendingReviewCount = sefazStatus?.pending_review_count ?? 0;

  return (
    <>
      <div className="space-y-6">
        {/* Cabeçalho */}
        <div className="border-b border-border/40 pb-5">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Automação Fiscal & Contas a Pagar
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <ScanBarcode className="text-primary" size={26} />
            {danfeAutomation.title}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Varredura direta na SEFAZ contra o CNPJ de cada empresa (NFeDistribuicaoDFe), categorização humana e lançamento no ERP Tiny.
          </p>
        </div>

        {/* Certificados A1 vencendo/vencidos ou ilegíveis — a varredura SEFAZ para sem eles */}
        {certAlerts.length > 0 && (
          <div
            role="alert"
            className={`flex gap-2 rounded-lg border px-3 py-2.5 text-xs ${
              certAlerts.some((c) => (c.dias_restantes ?? 0) <= 7 || c.erro)
                ? "border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error-fg)]"
                : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
            }`}
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-semibold">Certificado digital A1 precisa de atenção</p>
              <ul>
                {certAlerts.map((c) => (
                  <li key={c.arquivo}>
                    <strong>{c.titular ?? c.arquivo}</strong>
                    {c.cnpj ? ` (${formatCnpjMask(c.cnpj)})` : ""}:{" "}
                    {c.erro
                      ? c.erro
                      : (c.dias_restantes ?? 0) < 0
                        ? `venceu em ${formatDateBR(c.valido_ate)} — a varredura SEFAZ deste CNPJ está parada.`
                        : `vence em ${c.dias_restantes} dia(s) (${formatDateBR(c.valido_ate)}).`}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Linha de Integrações e Provedores */}
        <div className="flex flex-wrap items-center gap-3 text-xs bg-card p-3 rounded-lg border border-border">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>SEFAZ:</span>
            <Badge variant="outline" className="text-xs font-mono flex items-center gap-1.5 bg-background">
              <Radar size={12} className="text-primary" />
              <span>
                {sefazStatus?.cnpjs?.length
                  ? `${sefazStatus.cnpjs.length} CNPJ(s) monitorado(s)`
                  : "Certificado A1"}
              </span>
            </Badge>
          </div>

          <span className="text-muted-foreground">|</span>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Provedor NF-e:</span>
            <Badge variant="secondary" className="text-xs">
              {statusInfo?.nfe_provider === "sefaz_a1"
                ? "SEFAZ (Certificado A1)"
                : statusInfo?.nfe_provider === "receita_oficial"
                  ? "API Oficial Receita Federal"
                  : statusInfo?.nfe_provider || "SEFAZ"}
            </Badge>
          </div>

          <span className="text-muted-foreground">|</span>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Tiny ERP:</span>
            <Badge
              variant={statusInfo?.tiny_configured ? "default" : "secondary"}
              className="text-xs flex items-center gap-1.5"
            >
              <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
                <TinyLogo size={12} />
              </span>
              <span>{statusInfo?.tiny_configured ? "OAuth2 Conectado (4h)" : "Configurado"}</span>
            </Badge>
          </div>

          <span className="text-muted-foreground">|</span>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">OCR Tesseract:</span>
            <Badge variant="outline" className="text-xs text-emerald-700 dark:text-emerald-400">
              Habilitado (upload manual)
            </Badge>
          </div>
        </div>

        {/* Alerta de erro */}
        {errorMessage && (
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-start gap-3">
            <AlertCircle className="shrink-0 mt-0.5" size={18} />
            <div>
              <p className="font-semibold">Falha na Execução</p>
              <p className="text-xs mt-0.5 opacity-90">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* CONSOLE OPERACIONAL: VARREDURA DIRETA NA SEFAZ POR CNPJ */}
        <Card className="p-4 md:p-5 bg-card border border-border shadow-2xs rounded-xl">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div className="space-y-1.5 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-bold uppercase tracking-wider text-primary">
                  Console Operacional
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono tabular-nums">
                  <Clock3 size={12} />
                  Última varredura: {formatSyncTime(sefazStatus?.last_scan_finished_at)}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono tabular-nums">
                  Próxima agendada: {formatSyncTime(sefazStatus?.next_scan_at)}
                </span>
              </div>

              <h2 className="text-base md:text-lg font-bold text-foreground">
                Varredura Direta na SEFAZ (NFeDistribuicaoDFe)
              </h2>

              <p className="text-xs text-muted-foreground leading-relaxed">
                Consulta diária (ou sob demanda) contra o CNPJ de cada empresa usando o certificado digital A1: toda compra em que o CNPJ da empresa foi informado ao fornecedor aparece automaticamente aqui, aguardando categorização.
              </p>

              <div className="pt-1.5 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">Aguardando categorização:</span>
                  <Badge
                    variant={pendingReviewCount > 0 ? "warning" : "outline"}
                    className="font-mono text-[11px] font-semibold"
                  >
                    {pendingReviewCount} {pendingReviewCount === 1 ? "nota pendente" : "notas pendentes"}
                  </Badge>
                </div>

                {sefazStatus?.cnpjs && sefazStatus.cnpjs.length > 0 && (
                  <span className="text-[11px] text-muted-foreground truncate max-w-sm font-mono">
                    CNPJs: {sefazStatus.cnpjs.map((c) => formatCnpjMask(c.cnpj)).join(", ")}
                  </span>
                )}
              </div>

              {sefazCnpjErrors.length > 0 && (
                <div className="mt-2 p-3 rounded-lg bg-[var(--status-pending-bg)] border border-[var(--status-pending-border)] text-[var(--status-pending-fg)] text-xs space-y-1">
                  <p className="font-semibold flex items-center gap-1.5">
                    <AlertCircle size={14} className="shrink-0" />
                    {sefazCnpjErrors.length === 1
                      ? "1 CNPJ falhou na última varredura"
                      : `${sefazCnpjErrors.length} CNPJs falharam na última varredura`}
                  </p>
                  {sefazCnpjErrors.map((c) => (
                    <p key={c.cnpj} className="opacity-90 font-mono">
                      {formatCnpjMask(c.cnpj)}: {c.erro}
                    </p>
                  ))}
                  {sefazCnpjErrors.some((c) => c.erro?.includes("656") || c.erro?.includes("Consumo Indevido")) && (
                    <p className="pt-1 text-xs text-[var(--status-pending-fg)] font-sans border-t border-[var(--status-pending-border)] mt-1 flex items-start gap-1.5">
                      <Info size={13} className="shrink-0 mt-0.5" />
                      <span>A SEFAZ impõe proteção de 1h contra consultas repetidas. As notas já capturadas abaixo permanecem disponíveis normalmente para revisão e lançamento. O sistema retomará a consulta dessas filiais automaticamente após o término do período.</span>
                    </p>
                  )}
                </div>
              )}

              {sefazCnpjErrors.length === 0 && sefazStatus?.last_scan_finished_at && (
                <div className="mt-2 p-2.5 rounded-lg bg-[var(--status-success-bg)] border border-[var(--status-success-border)] text-[var(--status-success-fg)] text-xs flex items-center gap-2">
                  <CheckCircle2 size={15} className="shrink-0" />
                  <span>
                    Todas as filiais estão sincronizadas com a SEFAZ. Não há novos documentos emitidos pendentes de busca no momento.
                  </span>
                </div>
              )}
            </div>

            {/* BOTÃO DE ACIONAMENTO PROFISSIONAL */}
            {(canScan || canForceScan) && (
            <div className="flex flex-col items-start lg:items-end justify-center shrink-0 gap-1.5">
              {canScan && (
              <Button
                variant="cta"
                size="default"
                onClick={() => void handleRunSefazScan()}
                disabled={isScanning || isSefazScanInCooldown}
                className="h-10 px-5 text-xs gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isScanning ? (
                  <>
                    <RefreshCw className="animate-spin" size={15} />
                    <span>Consultando a SEFAZ...</span>
                  </>
                ) : isSefazScanInCooldown ? (
                  <>
                    <Clock3 size={14} />
                    <span>Disponível em {cooldownMinutesLabel}</span>
                  </>
                ) : (
                  <>
                    <Play size={14} className="fill-current" />
                    <span>Rodar Varredura Agora</span>
                  </>
                )}
              </Button>
              )}
              {canForceScan && isSefazScanInCooldown && !isScanning && (
                <Button variant="outline" size="sm" onClick={() => setConfirmForceScan(true)} className="text-xs">
                  Forçar varredura
                </Button>
              )}
              <span className="text-[10px] text-muted-foreground font-mono">
                {isScanning
                  ? "Consultando distNSUInt por CNPJ..."
                  : isSefazScanInCooldown
                    ? "Cooldown de proteção contra bloqueio da SEFAZ (cStat 656)"
                    : "Disparo sob demanda · Roda 1x/dia automaticamente"}
              </span>
            </div>
            )}
          </div>
        </Card>

        {/* SEÇÃO: IMPORTAÇÃO DIRETA POR CHAVE DE ACESSO (SEFAZ) */}
        {canImportKey && (
        <Card className="p-4 sm:p-5 border-border/60 bg-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ScanBarcode size={17} className="text-primary" />
                Importar NF-e por Chave de Acesso (SEFAZ)
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Para notas dos últimos 90 dias que não vieram na varredura automática. Notas mais antigas a SEFAZ não entrega pela chave: envie o XML no upload manual abaixo.
              </p>
            </div>
            {importKeySuccess && (
              <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 text-xs py-1">
                <Check size={13} className="mr-1 inline" />
                {importKeySuccess}
              </Badge>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Input
                placeholder="Cole a chave de acesso com 44 dígitos (ex: 35260647895398000135...)"
                value={manualChaveInput}
                onChange={(e) => setManualChaveInput(e.target.value.replace(/\D/g, "").slice(0, 44))}
                inputMode="numeric"
                className="font-mono text-xs"
                disabled={isImportingKey}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleImportKey();
                  }
                }}
              />
              {manualChaveInput && (
                <span className="absolute right-3 top-2.5 text-[10px] text-muted-foreground font-mono">
                  {manualChaveInput.replace(/\D/g, "").length}/44 dígitos
                </span>
              )}
            </div>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void handleImportKey()}
              disabled={isImportingKey || manualChaveInput.replace(/\D/g, "").length !== 44}
              className="gap-2 shrink-0"
            >
              {isImportingKey ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Consultando SEFAZ...
                </>
              ) : (
                <>
                  <Search size={14} />
                  Consultar & Importar
                </>
              )}
            </Button>
          </div>
        </Card>
        )}

        {/* SEÇÃO SECUNDÁRIA: UPLOAD MANUAL DE CONTINGÊNCIA (COLAPSÁVEL) — lança no Tiny */}
        {canLaunch && (
        <div className="border border-border/50 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowManualUpload(!showManualUpload)}
            className="w-full flex items-center justify-between p-4 bg-card hover:bg-muted text-xs font-semibold text-muted-foreground transition-colors"
          >
            <span className="flex items-center gap-2">
              <UploadCloud size={16} />
              Upload Manual de Contingência (Opcional / Testes Ad-hoc)
            </span>
            {showManualUpload ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showManualUpload && (
            <div className="p-6 border-t border-border/40 bg-card">
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center p-6 text-center border-2 border-dashed rounded-lg transition-colors ${
                  dragActive ? "bg-primary/5 border-primary" : "border-border/60"
                }`}
              >
                <UploadCloud size={24} className="text-muted-foreground mb-2" />
                <p className="text-xs font-medium text-foreground">
                  Arraste arquivos aqui ou selecione manualmente para testar
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={handleFileChange}
                  className="hidden"
                  id="danfe-manual-file-upload"
                />
                <label htmlFor="danfe-manual-file-upload" className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs gap-1.5"
                  >
                    <FileText size={12} />
                    Selecionar arquivos locais
                  </Button>
                </label>
              </div>

              {selectedFiles.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold">
                      Fila Manual ({selectedFiles.length})
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearFiles}
                      className="text-xs text-muted-foreground hover:text-destructive h-6 gap-1"
                    >
                      <Trash2 size={12} />
                      Limpar
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-32 overflow-y-auto">
                    {selectedFiles.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        className="flex items-center justify-between p-2 rounded bg-muted/40 text-xs"
                      >
                        <span className="truncate font-medium">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => removeFile(idx)}
                          className="text-muted-foreground hover:text-destructive shrink-0 ml-1"
                        >
                          <XCircle size={12} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      onClick={handleProcessManualBatch}
                      disabled={isUploadingManual}
                      className="gap-2 text-xs"
                    >
                      {isUploadingManual ? (
                        <>
                          <RefreshCw className="animate-spin" size={12} />
                          Processando...
                        </>
                      ) : (
                        <>
                          <Send size={12} />
                          Processar Lote Manual
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        )}

        {/* Resultados do lote recém-processado */}
        {batchResult && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                <CheckCircle2 className="text-emerald-700 dark:text-emerald-400" size={20} />
                Resultado da Execução da Automação
              </h2>
              <span className="text-xs text-muted-foreground">
                Total: {batchResult.total} | Sucesso: {batchResult.success_count} | Falhas:{" "}
                {batchResult.failed_count}
              </span>
            </div>

            {/* Cards de resumo */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Card className="p-4 bg-card border-border">
                <span className="text-xs text-muted-foreground">Arquivos Enviados</span>
                <p className="text-xl font-bold mt-1 text-foreground">{batchResult.total}</p>
              </Card>

              <Card className="p-4 bg-emerald-500/5 border-emerald-500/20">
                <span className="text-xs text-emerald-700 dark:text-emerald-400">
                  Processadas com Sucesso
                </span>
                <p className="text-xl font-bold mt-1 text-emerald-700 dark:text-emerald-400">
                  {batchResult.success_count}
                </p>
              </Card>

              <Card className="p-4 bg-rose-500/5 border-rose-500/20">
                <span className="text-xs text-rose-600 dark:text-rose-400">Falhas / Ilegíveis</span>
                <p className="text-xl font-bold mt-1 text-rose-600 dark:text-rose-400">
                  {batchResult.failed_count}
                </p>
              </Card>

              <Card className="p-4 bg-card border-border">
                <span className="text-xs text-muted-foreground">Valor Total Lançado</span>
                <p className="text-xl font-bold mt-1 text-foreground">
                  {formatCurrency(batchResult.total_amount)}
                </p>
              </Card>
            </div>

            {/* Esteira passo a passo para cada item */}
            <div className="space-y-3">
              {batchResult.items.map((item, idx) => (
                <Card key={`${item.filename}-${idx}`} className="p-4 border-border/70 overflow-hidden">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-border/40">
                    <div className="flex items-center gap-2">
                      <FileText className="text-muted-foreground shrink-0" size={16} />
                      <span className="font-semibold text-sm text-foreground">{item.filename}</span>
                    </div>

                    <Badge
                      variant={item.status === "success" ? "default" : "destructive"}
                      className="text-xs w-fit"
                    >
                      {item.status === "success" ? "Concluído com Sucesso" : "Falha no Processamento"}
                    </Badge>
                  </div>

                  {/* Fluxo Visual das 3 Etapas */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-xs">
                    {/* Etapa 1: Extração */}
                    <div className="p-3 rounded-md bg-muted/30 border border-border/40 space-y-1.5">
                      <div className="flex items-center justify-between font-semibold text-foreground">
                        <span className="flex items-center gap-1.5">
                          <ScanBarcode size={14} className="text-primary" />
                          1. Extração 44 Dígitos
                        </span>
                        {item.key ? (
                          <Badge variant="outline" className="text-[10px] uppercase font-mono">
                            {item.scan_method === "xml" ? "XML" : item.scan_method === "barcode" ? "Código de Barras" : "OCR Tesseract"}
                          </Badge>
                        ) : (
                          <XCircle size={14} className="text-destructive" />
                        )}
                      </div>
                      {item.key ? (
                        <p className="font-mono text-[11px] text-muted-foreground break-all">
                          {item.key}
                        </p>
                      ) : (
                        <p className="text-destructive text-[11px]">Chave não identificada</p>
                      )}
                    </div>

                    {/* Etapa 2: Consulta Fiscal */}
                    <div className="p-3 rounded-md bg-muted/30 border border-border/40 space-y-1.5">
                      <div className="flex items-center justify-between font-semibold text-foreground">
                        <span className="flex items-center gap-1.5">
                          <FileSpreadsheet size={14} className="text-primary" />
                          2. Consulta Fiscal
                        </span>
                        {item.nfe_data ? (
                          <CheckCircle2 size={14} className="text-emerald-700 dark:text-emerald-400" />
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </div>
                      {item.nfe_data ? (
                        <div className="space-y-0.5 text-muted-foreground text-[11px]">
                          <p className="font-medium text-foreground truncate">
                            {item.nfe_data.emitente_nome}
                          </p>
                          <p>CNPJ: {item.nfe_data.emitente_cnpj}</p>
                          <p>
                            NF-e nº <strong>{item.nfe_data.numero_nota}</strong> ·{" "}
                            {formatCurrency(item.nfe_data.valor_total)}
                          </p>
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-[11px]">
                          {item.error_message || "Dados fiscais não obtidos"}
                        </p>
                      )}
                    </div>

                    {/* Etapa 3: Tiny ERP */}
                    <div className="p-3 rounded-md bg-muted/30 border border-border/40 space-y-1.5">
                      <div className="flex items-center justify-between font-semibold text-foreground">
                        <span className="flex items-center gap-1.5">
                          <ArrowRight size={14} className="text-primary" />
                          <TinyLogo size={14} />
                          <span>3. Lançamento Tiny ERP</span>
                        </span>
                        {item.tiny_results.length > 0 ? (
                          <CheckCircle2 size={14} className="text-emerald-700 dark:text-emerald-400" />
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </div>
                      {item.tiny_results.length > 0 ? (
                        <div className="space-y-1 text-[11px]">
                          {item.tiny_results.map((r, i) => (
                            <div
                              key={i}
                              className="flex items-center justify-between text-muted-foreground"
                            >
                              <span>Doc: {r.nro_documento}</span>
                              <Badge variant="outline" className="text-[10px] font-mono">
                                ID #{r.conta_id}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-[11px]">
                          {item.status === "error"
                            ? "Não enviado ao Tiny"
                            : item.step === "pending_review"
                              ? "Aguardando revisão e categorização"
                              : "Sem duplicatas"}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Mensagem de erro caso haja */}
                  {item.error_message && (
                    <div className="mt-3 p-2 rounded bg-destructive/5 text-destructive text-xs flex items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0" />
                      <span>{item.error_message}</span>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* PAINEL DE REVISÃO E CATEGORIZAÇÃO HUMANA (bloqueia o lançamento no Tiny até confirmação) */}
        <DanfeReviewPanel
          apiBase={apiBase}
          mode={config.mode}
          getAuthHeaders={getStoredAuthHeaders}
          refreshSignal={reviewRefreshSignal}
          onConfirmed={() => void loadStatusAndHistory()}
        />

        {/* Histórico Recente de Auditoria com Filtros e Visualização em Lotes */}
        <div className="space-y-4 pt-5 border-t border-border/40">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Clock3 size={16} />
                Histórico Recente de Processamento & Auditoria
              </h2>
              <p className="text-xs text-muted-foreground">
                Registros da varredura SEFAZ, do upload manual e das conciliações no Tiny ERP.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  type="search"
                  aria-label="Buscar no histórico por chave, número, CNPJ ou fornecedor"
                  placeholder="Chave, nº, CNPJ ou fornecedor"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  className="h-8 w-[230px] pl-7 text-xs"
                />
              </div>
              <HistoryFilter
                value={historyDateFilter}
                onChange={setHistoryDateFilter}
                totalFilteredCount={filteredHistory.length}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                disabled={filteredHistory.length === 0}
                onClick={() =>
                  downloadCsv(
                    "historico-nfe",
                    ["Processado em", "Nº nota", "Chave de acesso", "Emitente", "CNPJ emitente", "Valor", "Status", "Detalhe", "Contas no Tiny"],
                    filteredHistory.map((h) => [
                      formatDateTimeBR(h.processed_at),
                      h.numero_nota,
                      h.chave_acesso,
                      h.emitente?.razao_social,
                      h.emitente?.cnpj,
                      h.valor_total,
                      h.audit_status,
                      h.details,
                      (h.lancamentos_tiny ?? []).map((l) => l.nro_documento ?? l.conta_id).join(", "),
                    ]),
                  )
                }
              >
                <Download size={13} />
                CSV
              </Button>
            </div>
          </div>

          <BatchExecutionView<DanfeHistoryItem>
            batches={historyBatches}
            totalItemsCount={filteredHistory.length}
            viewMode={historyViewMode}
            onViewModeChange={setHistoryViewMode}
            emptyMessage={
              historyItems.length === 0
                ? "Nenhuma nota fiscal processada recentemente. Clique no botão de Executar acima."
                : "Nenhuma nota fiscal encontrada para os filtros selecionados."
            }
            renderItemHeaders={() => (
              <>
                <TableHead className="font-semibold text-xs">Data / Hora</TableHead>
                <TableHead className="font-semibold text-xs">Arquivo Original</TableHead>
                <TableHead className="font-semibold text-xs">Chave de Acesso (44 dígitos)</TableHead>
                <TableHead className="font-semibold text-xs">Método</TableHead>
                <TableHead className="font-semibold text-xs">Emitente / NF-e</TableHead>
                <TableHead className="font-semibold text-xs">Valor Total</TableHead>
                <TableHead className="font-semibold text-xs">
                  <span className="flex items-center gap-1.5">
                    <TinyLogo size={13} />
                    <span>Tiny ERP</span>
                  </span>
                </TableHead>
                <TableHead className="font-semibold text-xs">Status</TableHead>
                <TableHead className="font-semibold text-xs text-right">Ação</TableHead>
              </>
            )}
            renderItemRow={(h, i) => {
              const isError = h.audit_status === "error";
              const isResolved = isError && !!h.resolved_at;
              const incidentKey = h.chave_acesso || h.original_filename || h.error_file || `nfe-${i}`;
              const reported = isExecutionReported(incidentKey);

              return (
                <TableRow key={incidentKey} className="hover:bg-muted/40 text-sm transition-colors">
                  <TableCell className="text-muted-foreground text-sm tabular-nums whitespace-nowrap font-sans">
                    {formatDateTimeBR(h.processed_at)}
                  </TableCell>
                  <TableCell className="font-medium text-foreground max-w-[170px] truncate text-xs font-mono">
                    {h.original_filename || h.error_file || "DANFE"}
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <FormattedAccessKey chave={h.chave_acesso} />
                  </TableCell>
                  <TableCell className="uppercase">
                    {h.metodo_leitura ? (
                      <Badge variant="outline" className="text-xs font-mono">
                        {h.metodo_leitura}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-[190px] truncate">
                    {h.emitente?.razao_social ? (
                      <>
                        <span className="font-medium text-foreground block truncate text-sm">
                          {h.emitente.razao_social}
                        </span>
                        <span className="text-muted-foreground block text-xs tabular-nums">
                          NF nº {h.numero_nota}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground text-sm">{h.details || "Falha"}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-medium text-foreground whitespace-nowrap text-sm tabular-nums">
                    {h.valor_total ? formatCurrency(h.valor_total) : "—"}
                  </TableCell>
                  <TableCell>
                    {h.lancamentos_tiny && h.lancamentos_tiny.length > 0 ? (
                      // "Já existia": a automação achou a nota já lançada no Tiny e NÃO criou conta nova.
                      // Sem essa distinção, um lançamento ignorado parecia igual a um criado.
                      h.lancamentos_tiny.every((l) => l.is_duplicate) ? (
                        <Badge
                          variant="warning"
                          className="text-xs"
                          title={`Nenhuma conta criada: já existia no Tiny (conta ${h.lancamentos_tiny.map((l) => `#${l.conta_id}`).join(", ")})`}
                        >
                          Já existia no Tiny
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="text-xs font-mono"
                          title={`Conta(s) no Tiny: ${h.lancamentos_tiny.map((l) => `#${l.conta_id}${l.is_duplicate ? " (já existia)" : ""}`).join(", ")}`}
                        >
                          {h.lancamentos_tiny.length} parcela(s)
                        </Badge>
                      )
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {isResolved ? (
                      <Badge
                        variant="secondary"
                        className="text-xs font-medium"
                        title={`Marcada como resolvida em ${formatDateTimeBR(h.resolved_at!)}`}
                      >
                        Falha resolvida
                      </Badge>
                    ) : (
                      <Badge variant={isError ? "danger" : "success"} className="text-xs font-medium">
                        {isError ? "Falha" : "Sucesso"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isError && !isResolved ? (
                      <div className="flex items-center justify-end gap-1.5">
                        {h.error_file && canResolveFailure && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={resolvingFile === h.error_file}
                            onClick={() => void handleResolveFailure(h.error_file!)}
                            title="Tira esta falha das pendências (ex.: nota já lançada direto no Tiny). Ela continua no histórico."
                            className="h-7 px-2.5 text-xs font-semibold gap-1.5 cursor-pointer shadow-2xs"
                          >
                            <Check size={12} />
                            {resolvingFile === h.error_file ? "Salvando..." : "Marcar como resolvida"}
                          </Button>
                        )}
                        {reported ? (
                          <Badge
                            variant="warning"
                            className="text-xs font-semibold"
                            title="Incidente já encaminhado para a fila de resolução do administrador"
                          >
                            <CheckCircle2 size={12} />
                            Reportado
                          </Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setReportingIncident({
                                id: incidentKey,
                                node: h.metodo_leitura || "Leitura Fiscal",
                                details: h.details,
                              })
                            }
                            className="h-7 px-2.5 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:text-rose-700 hover:bg-rose-500/10 border-rose-500/30 gap-1.5 cursor-pointer shadow-2xs"
                          >
                            <Flag size={12} />
                            Reportar
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            }}
          />

          {reportingIncident && (
            <ReportIncidentModal
              isOpen={!!reportingIncident}
              onClose={() => setReportingIncident(null)}
              executionId={reportingIncident.id}
              automationId="danfe-tiny"
              automationTitle="NF-e & DANFE"
              stoppedNode={reportingIncident.node}
            />
          )}
        </div>
      </div>
      <ConfirmImpactDialog
        open={confirmForceScan}
        title="Forçar a varredura na SEFAZ agora?"
        confirmLabel="Forçar varredura"
        requireCheck="Entendo o risco"
        busy={isScanning}
        onCancel={() => setConfirmForceScan(false)}
        onConfirm={() => void handleRunSefazScan(true)}
      >
        <p>{FORCE_SEFAZ_RISK}</p>
      </ConfirmImpactDialog>
    </>
  );
}
