import { economia } from "./roi.js";
import { noPeriodo } from "./periodo.js";
import { nextDailyRunSaoPaulo } from "./overview.js";
import { actorHeaders, automationFetch, callAutomation, createAutomationUrlResolver, financeiroCandidateUrls, upstreamError, type ActorContext } from "./automation-http.js";
import type {
  Account,
  ConfirmLancamentoItemInput,
  ConfirmLancamentoResponse,
  DanfeBatchResponse,
  DanfeNotasResponse,
  DanfeNotaStatus,
  DanfePendingReviewResponse,
  DanfeSefazStatus,
  DanfeStatusResponse,
  Dashboard,
  HistoryAdapter,
  DanfeHistoryItem,
  DanfeHistoryResponse,
  DanfeImportKeyResponse,
  HistoryWindow,
  RoiPeriodo,
  TinyCategory,
} from "./contracts.js";

export interface DanfeService {
  readDashboard(): Promise<Dashboard>;
  readStatus(): Promise<DanfeStatusResponse>;
  readHistory(): Promise<DanfeHistoryResponse>;
  readSefazStatus(): Promise<DanfeSefazStatus>;
  /** Notas lançadas com sucesso (histórico de auditoria, `processed_at`); com `periodo`, só as do período. Rejeita se o motor estiver fora. */
  contarLancadas(periodo?: RoiPeriodo): Promise<number>;
  /** `force` (ignorar o cooldown da SEFAZ) só é repassado quando a rota já validou role admin. */
  scanSefaz(actor?: ActorContext, opts?: { force?: boolean }): Promise<DanfeSefazStatus>;
  importKey(chave: string, actor?: ActorContext): Promise<DanfeImportKeyResponse>;
  processBatch(body: Buffer, contentType: string, actor?: ActorContext): Promise<DanfeBatchResponse>;
  getTinyCategories(cnpj?: string): Promise<TinyCategory[]>;
  getPendingReview(): Promise<DanfePendingReviewResponse>;
  getNotas(status: DanfeNotaStatus): Promise<DanfeNotasResponse>;
  archiveNota(chave: string, actor?: ActorContext): Promise<{ chave: string; status: string }>;
  restoreNota(chave: string, actor?: ActorContext): Promise<{ chave: string; status: string }>;
  resolveFailure(errorFile: string, actor?: ActorContext): Promise<{ error_file: string; resolved_at: string }>;
  confirmLancamento(
    chave: string,
    itens: ConfirmLancamentoItemInput[],
    formaPagamento: string,
    meioPagamentoNfe?: string,
    parcelas?: number,
    actor?: ActorContext,
  ): Promise<ConfirmLancamentoResponse>;
  /**
   * Ponte do classificador Qwen (coletor da VPS → automação): repassa GET qwen/pendentes,
   * GET qwen/confirmadas-recentes e POST qwen/sugestoes com a chave interna e devolve status e
   * corpo da automação como vieram. Só no modo live.
   */
  qwenRepasse?(metodo: "GET" | "POST", caminho: string, corpo?: unknown): Promise<{ status: number; corpo: unknown }>;
  historyAdapter: HistoryAdapter;
}

export function createDanfeService(
  mode: "demo" | "live",
  pythonApiUrl?: string,
): DanfeService {
  const historyAdapter: HistoryAdapter = {
    async readHistory(window: HistoryWindow) {
      const executions = [];
      const count = mode === "demo" ? 14 : 10;
      for (let day = 0; day < count; day++) {
        const start = new Date(Date.parse(window.from) + day * 86400000 + 10 * 3600000);
        if (start.getTime() > Date.parse(window.to)) continue;
        const status = day === 3 ? ("error" as const) : ("success" as const);
        const end = new Date(start.getTime() + 12000);
        executions.push({
          id: `NFE-EXEC-${day + 1}`,
          startedAt: start.toISOString(),
          stoppedAt: end.toISOString(),
          durationMs: end.getTime() - start.getTime(),
          status,
          stoppedNode: status === "error" ? "OCR Fallback" : null,
        });
      }
      return { complete: true, executions };
    },
  };

  if (mode === "demo") {
    return {
      historyAdapter,
      async readStatus(): Promise<DanfeStatusResponse> {
        return {
          status: "ok",
          version: "1.0.0",
          nfe_provider: "receita_oficial",
          ocr_enabled: true,
          tiny_configured: true,
          timestamp: new Date().toISOString(),
        };
      },
      async readSefazStatus(): Promise<DanfeSefazStatus> {
        const now = new Date();
        const next = nextDailyRunSaoPaulo(now, 6);
        return {
          last_scan_started_at: new Date(now.getTime() - 3600000).toISOString(),
          last_scan_finished_at: new Date(now.getTime() - 3590000).toISOString(),
          next_scan_at: next.toISOString(),
          total_novas_notas: 2,
          pending_review_count: 1,
          cnpjs: [
            { cnpj: "43820617000166", novas_notas: 1, duplicadas_ignoradas: 3, canceladas_ignoradas: 0, eventos_ignorados: 1, ult_nsu: "000000000000042", status: "ok", erro: null },
            { cnpj: "36592814000100", novas_notas: 1, duplicadas_ignoradas: 5, canceladas_ignoradas: 1, eventos_ignorados: 0, ult_nsu: "000000000000018", status: "ok", erro: null },
          ],
          cooldown_seconds_remaining: 0,
        };
      },
      async scanSefaz(): Promise<DanfeSefazStatus> {
        return this.readSefazStatus();
      },
      async contarLancadas(): Promise<number> {
        return 318;
      },
      async readDashboard(): Promise<Dashboard> {
        // Reaproveita a mesma nota fictícia de getPendingReview() para que a contagem de
        // "notas aguardando categorização" seja idêntica em toda a interface (Visão Geral,
        // Ações Globais Pendentes e o console de NF-e & DANFE).
        const pending = await this.getPendingReview();
        const approvals: Account[] = pending.pending.map((entry) => ({
          id: `danfe-pending-${entry.chave.slice(-8)}`,
          beneficiary: entry.nfe_data.emitente_nome,
          cnpj: entry.nfe_data.emitente_cnpj,
          amount: String(entry.nfe_data.valor_total),
          dueDate: entry.nfe_data.data_emissao,
          status: "AGUARDANDO_CATEGORIZACAO",
          transactionId: null,
          errorLog: null,
          stoppedNode: null,
          updatedAt: entry.staged_at,
        }));
        return {
          mode: "demo",
          generatedAt: new Date().toISOString(),
          metrics: {
            totalQueue: 340,
            paidCount: 318,
            reconciledCount: 310,
            hoursSaved: economia("danfe-tiny", 318).horas,
            estimatedSavings: economia("danfe-tiny", 318).reais,
            automationRate: 93.5,
          },
          approvals,
          failures: [],
          executions: [
            {
              id: "DEMO-NFE-01",
              startedAt: new Date(Date.now() - 3600000).toISOString(),
              stoppedAt: new Date(Date.now() - 3590000).toISOString(),
              durationMs: 10000,
              status: "success",
              stoppedNode: null,
            },
          ],
          sources: {
            database: { status: "ok" },
            n8n: { status: "ok" },
          },
        };
      },
      async readHistory() {
        return {
          total: 3,
          history: [
            {
              processed_at: new Date(Date.now() - 1200000).toISOString(),
              original_filename: "DANFE_FORNECEDOR_ALFA.pdf",
              chave_acesso: "35230912345678000123550010000001231000000123",
              metodo_leitura: "barcode",
              numero_nota: "1420",
              emitente: { razao_social: "ALFA SUPRIMENTOS LTDA", cnpj: "12.345.678/0001-90" },
              valor_total: 1850.0,
              audit_status: "success",
              lancamentos_tiny: [
                {
                  conta_id: 10452,
                  nro_documento: "1420/001",
                  valor: 1850.0,
                  vencimento: "2026-09-25",
                  situacao: "aberto",
                  is_duplicate: false,
                },
              ],
            },
            {
              processed_at: new Date(Date.now() - 3600000).toISOString(),
              original_filename: "NOTA_FISCAL_BETA.png",
              chave_acesso: "35230998765432000188550010000004561000000456",
              metodo_leitura: "ocr",
              numero_nota: "852",
              emitente: { razao_social: "BETA EQUIPAMENTOS S.A.", cnpj: "98.765.432/0001-88" },
              valor_total: 4320.5,
              audit_status: "success",
              lancamentos_tiny: [
                {
                  conta_id: 10453,
                  nro_documento: "852/001",
                  valor: 2160.25,
                  vencimento: "2026-09-20",
                  situacao: "aberto",
                  is_duplicate: false,
                },
                {
                  conta_id: 10454,
                  nro_documento: "852/002",
                  valor: 2160.25,
                  vencimento: "2026-10-20",
                  situacao: "aberto",
                  is_duplicate: false,
                },
              ],
            },
          ],
        };
      },
      async importKey(chave: string): Promise<DanfeImportKeyResponse> {
        return {
          status: "success",
          message: `NF-e ${chave.slice(25, 34)} importada com sucesso (modo demonstração).`,
          chave,
        };
      },
      async processBatch(): Promise<DanfeBatchResponse> {
        return {
          total: 2,
          success_count: 2,
          failed_count: 0,
          total_amount: 6170.5,
          items: [
            {
              filename: "danfe_distribuidora_sp.pdf",
              status: "success",
              step: "completed",
              key: "35230912345678000123550010000001231000000123",
              scan_method: "barcode",
              page_number: 1,
              nfe_data: {
                chave: "35230912345678000123550010000001231000000123",
                numero_nota: "1420",
                data_emissao: "2026-09-08",
                emitente_nome: "DISTRIBUIDORA DE MATERIAIS SP LTDA",
                emitente_cnpj: "12.345.678/0001-90",
                valor_total: 1850.0,
                duplicatas: [{ numero: "001", vencimento: "2026-09-25", valor: 1850.0 }],
                destinatario_cnpj: "36592814000100",
                destinatario_nome: "Revesta",
                meio_pagamento_nfe: "17",
              },
              tiny_results: [
                {
                  conta_id: 20541,
                  nro_documento: "1420/001",
                  valor: 1850.0,
                  vencimento: "2026-09-25",
                  situacao: "aberto",
                  is_duplicate: false,
                },
              ],
              error_message: null,
              processed_at: new Date().toISOString(),
            },
            {
              filename: "danfe_eletronicos_br.png",
              status: "success",
              step: "completed",
              key: "35230998765432000188550010000004561000000456",
              scan_method: "ocr",
              page_number: 1,
              nfe_data: {
                chave: "35230998765432000188550010000004561000000456",
                numero_nota: "852",
                data_emissao: "2026-09-08",
                emitente_nome: "ELETRONICOS DO BRASIL S.A.",
                emitente_cnpj: "98.765.432/0001-88",
                valor_total: 4320.5,
                duplicatas: [
                  { numero: "001", vencimento: "2026-09-20", valor: 2160.25 },
                  { numero: "002", vencimento: "2026-10-20", valor: 2160.25 },
                ],
                destinatario_cnpj: "27184930000107",
                destinatario_nome: "NORVIA ACABAMENTOS LTDA (CAMPINAS)",
                meio_pagamento_nfe: null,
              },
              tiny_results: [
                {
                  conta_id: 20542,
                  nro_documento: "852/001",
                  valor: 2160.25,
                  vencimento: "2026-09-20",
                  situacao: "aberto",
                  is_duplicate: false,
                },
                {
                  conta_id: 20543,
                  nro_documento: "852/002",
                  valor: 2160.25,
                  vencimento: "2026-10-20",
                  situacao: "aberto",
                  is_duplicate: false,
                },
              ],
              error_message: null,
              processed_at: new Date().toISOString(),
            },
          ],
        };
      },
      async getTinyCategories(_cnpj?: string): Promise<TinyCategory[]> {
        return [
          { id: "480897321", nome: "Compras", grupo: "3.Custos", label: "3.Custos → Compras" },
          { id: "701885961", nome: "Materiais de Limpeza", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Materiais de Limpeza" },
          { id: "484437483", nome: "Material de Escritório", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Material de Escritório" },
          { id: "484437789", nome: "Outras Despesas", grupo: "4.Despesas Operacionais", label: "4.Despesas Operacionais → Outras Despesas" },
        ];
      },
      async getPendingReview(): Promise<DanfePendingReviewResponse> {
        return {
          total: 1,
          pending: [
            {
              chave: "35230912345678000123550010000001231000000123",
              filename: "danfe_distribuidora_sp.pdf",
              staged_at: new Date().toISOString(),
              nfe_data: {
                chave: "35230912345678000123550010000001231000000123",
                numero_nota: "1420",
                data_emissao: "2026-09-08",
                emitente_nome: "DISTRIBUIDORA DE MATERIAIS SP LTDA",
                emitente_cnpj: "12.345.678/0001-90",
                valor_total: 1850.0,
                duplicatas: [{ numero: "001", vencimento: "2026-09-25", valor: 1850.0 }],
                destinatario_cnpj: "36592814000100",
                destinatario_nome: "Revesta",
                meio_pagamento_nfe: "17",
              },
              itens: [
                {
                  item_id: "1",
                  descricao: "Detergente Neutro 500ml (12un)",
                  valor_total: 950.0,
                  codigo: "001",
                  ncm: "34022000",
                  quantidade: 12,
                  valor_unitario: 79.17,
                  categoria_sugerida_id: "701885961",
                  categoria_sugerida_nome: "Materiais de Limpeza",
                },
                {
                  item_id: "2",
                  descricao: "Papel A4 Sulfite (5 resmas)",
                  valor_total: 900.0,
                  codigo: "002",
                  ncm: "48025700",
                  quantidade: 5,
                  valor_unitario: 180.0,
                  categoria_sugerida_id: "484437483",
                  categoria_sugerida_nome: "Material de Escritório",
                },
              ],
            },
          ],
        };
      },
      async getNotas(status: DanfeNotaStatus): Promise<DanfeNotasResponse> {
        if (status !== "pending") {
          return { total: 0, status, notas: [] };
        }
        const pending = await this.getPendingReview();
        return { total: pending.total, status, notas: pending.pending };
      },
      async archiveNota(chave: string): Promise<{ chave: string; status: string }> {
        return { chave, status: "archived" };
      },
      async restoreNota(chave: string): Promise<{ chave: string; status: string }> {
        return { chave, status: "pending" };
      },
      async resolveFailure(errorFile: string): Promise<{ error_file: string; resolved_at: string }> {
        return { error_file: errorFile, resolved_at: new Date().toISOString() };
      },
      async confirmLancamento(chave: string, _itens?: ConfirmLancamentoItemInput[], _formaPagamento?: string): Promise<ConfirmLancamentoResponse> {
        return {
          chave,
          status: "success",
          grupos: [
            {
              categoria_id: "701885961",
              categoria_nome: "Materiais de Limpeza",
              valor_total: 950.0,
              item_ids: ["1"],
              tiny_result: {
                conta_id: 20541,
                nro_documento: "1420-1",
                valor: 950.0,
                vencimento: "2026-09-25",
                situacao: "aberto",
                is_duplicate: false,
              },
              status: "success",
              error_message: null,
            },
            {
              categoria_id: "484437483",
              categoria_nome: "Material de Escritório",
              valor_total: 900.0,
              item_ids: ["2"],
              tiny_result: {
                conta_id: 20542,
                nro_documento: "1420-2",
                valor: 900.0,
                vencimento: "2026-09-25",
                situacao: "aberto",
                is_duplicate: false,
              },
              status: "success",
              error_message: null,
            },
          ],
        };
      },
    };
  }

  // MODO LIVE: Comunica com a API Python do automacao-nfe com resolução dinâmica de candidatos
  // URL do motor financeiro memorizada por 60 s (sem /health a cada chamada) + breaker "financeiro".
  const resolvePythonUrl = createAutomationUrlResolver(financeiroCandidateUrls(pythonApiUrl));
  const fetchFin = (url: string, init?: RequestInit): Promise<Response> =>
    callAutomation("financeiro", () => automationFetch(url, init), { invalidate: resolvePythonUrl.invalidate });

  const HISTORY_LIMIT = 1000;

  // Histórico real da esteira fiscal (para o gráfico "Evolução das Execuções" da Visão
  // Geral) — usa a mesma auditoria de /api/v1/danfe/history já usada em readDashboard(),
  // em vez do gerador sintético (historyAdapter) reservado ao modo demo.
  const liveHistoryAdapter: HistoryAdapter = {
    async readHistory(window: HistoryWindow) {
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await fetchFin(`${baseUrl}/api/v1/danfe/history?limit=${HISTORY_LIMIT}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const histData = (await res.json()) as Partial<DanfeHistoryResponse>;
        const historyItems = Array.isArray(histData.history) ? histData.history : [];

        const fromMs = Date.parse(window.from);
        const toMs = Date.parse(window.to);
        const executions = historyItems
          .filter((item) => item.processed_at && Number.isFinite(Date.parse(item.processed_at)))
          .filter((item) => {
            const t = Date.parse(item.processed_at ?? "");
            return t >= fromMs && t <= toMs;
          })
          .map((item, idx) => {
            const timeMs = item.processed_at ? new Date(item.processed_at).getTime() : idx;
            const executionId = item.chave_acesso
              ? `DANFE-${String(item.chave_acesso).slice(-8)}-${timeMs}`
              : `DANFE-EXEC-${idx + 1}-${timeMs}`;
            return {
              id: executionId,
              startedAt: new Date(item.processed_at ?? "").toISOString(),
              stoppedAt: new Date(item.processed_at ?? "").toISOString(),
              // A auditoria só grava o instante do processamento, não a duração.
              durationMs: null,
              status: (item.audit_status === "error" ? "error" : "success") as "error" | "success",
              stoppedNode: item.audit_status === "error" ? (item.details?.slice(0, 60) || "Erro fiscal") : null,
            };
          });

        // A API devolve os `HISTORY_LIMIT` eventos mais recentes: se veio cheia e o mais antigo
        // ainda está dentro da janela, podem faltar dias no começo do gráfico.
        const oldest = historyItems
          .map((item) => Date.parse(item.processed_at ?? ""))
          .filter(Number.isFinite)
          .reduce((min, t) => Math.min(min, t), Infinity);
        const complete = historyItems.length < HISTORY_LIMIT || oldest < fromMs;
        return { complete, executions };
      } catch (e) {
        console.error(`[DANFE Service] readHistory falhou: ${(e as Error).message}`);
        return { complete: false, executions: [] };
      }
    },
  };

  return {
    historyAdapter: liveHistoryAdapter,
    async qwenRepasse(metodo, caminho, corpo) {
      const baseUrl = await resolvePythonUrl();
      // "boletos/..." é o classificador dos boletos DDA; o resto, o da revisão de NF-e.
      const destino = caminho.startsWith("boletos/") ? `/api/v1/dda/qwen/${caminho.slice("boletos/".length)}` : `/api/v1/danfe/qwen/${caminho}`;
      const res = await fetchFin(`${baseUrl}${destino}`, {
        method: metodo,
        headers: corpo === undefined ? undefined : { "Content-Type": "application/json" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(30000),
      });
      const texto = await res.text();
      let lido: unknown;
      try {
        lido = texto ? JSON.parse(texto) : {};
      } catch {
        lido = { error: texto.slice(0, 500) };
      }
      return { status: res.status, corpo: lido };
    },
    async readStatus(): Promise<DanfeStatusResponse> {
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await fetchFin(`${baseUrl}/api/v1/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as DanfeStatusResponse;
      } catch (e) {
        console.error(`[DANFE Service] readStatus falhou: ${(e as Error).message}`);
        return {
          status: "unreachable",
          version: "unknown",
          nfe_provider: "unknown",
          ocr_enabled: false,
          tiny_configured: false,
          timestamp: new Date().toISOString(),
        };
      }
    },
    async readSefazStatus(): Promise<DanfeSefazStatus> {
      // Responde em ~150 ms; em 08/11/2026 às 05:52 um único timeout de 8 s (motor fiscal ocupado
      // com a conciliação ML das 5h) virou incidente. Uma nova tentativa antes do ERROR: só a falha
      // que se repete é problema de verdade.
      const ler = async (): Promise<DanfeSefazStatus> => {
        const baseUrl = await resolvePythonUrl();
        const res = await fetchFin(`${baseUrl}/api/v1/danfe/sefaz-status`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as DanfeSefazStatus;
      };
      try {
        try {
          return await ler();
        } catch (e) {
          console.warn(`[DANFE Service] readSefazStatus: 1ª tentativa falhou (${(e as Error).message}); tentando de novo`);
          return await ler();
        }
      } catch (e) {
        console.error(`[DANFE Service] readSefazStatus falhou: ${(e as Error).message}`);
        return {
          last_scan_started_at: null,
          last_scan_finished_at: null,
          next_scan_at: new Date().toISOString(),
          total_novas_notas: 0,
          pending_review_count: 0,
          cnpjs: [],
          cooldown_seconds_remaining: 0,
        };
      }
    },
    async scanSefaz(actor?: ActorContext, opts?: { force?: boolean }): Promise<DanfeSefazStatus> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/scan-sefaz${opts?.force ? "?force=true" : ""}`, {
        method: "POST",
        headers: actorHeaders(actor, { asUser: true }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao executar a varredura SEFAZ");
      return (await res.json()) as DanfeSefazStatus;
    },
    async contarLancadas(periodo?: RoiPeriodo): Promise<number> {
      const baseUrl = await resolvePythonUrl();
      // Limite alto: o ROI conta tudo, não só as últimas 100 notas do painel.
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/history?limit=1000000`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Partial<DanfeHistoryResponse> | null;
      if (!Array.isArray(data?.history)) throw new Error("Histórico de NF-e indisponível");
      return data.history.filter((i) => i.audit_status === "success" && noPeriodo(i.processed_at, periodo)).length;
    },
    async readDashboard(): Promise<Dashboard> {
      try {
        const baseUrl = await resolvePythonUrl();
        const [healthRes, histRes, pendingRes] = await Promise.all([
          fetchFin(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(3000) }),
          fetchFin(`${baseUrl}/api/v1/danfe/history?limit=100`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
          fetchFin(`${baseUrl}/api/v1/danfe/pending-review`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
        ]);

        if (!healthRes.ok) {
          throw new Error(`Motor Python indisponível (${healthRes.status})`);
        }

        let historyItems: DanfeHistoryItem[] = [];
        if (histRes && histRes.ok) {
          try {
            const histData = (await histRes.json()) as Partial<DanfeHistoryResponse> | null;
            if (Array.isArray(histData?.history)) {
              historyItems = histData.history;
            }
          } catch {
            // Se json falhar, mantém lista vazia
          }
        }

        // Notas aguardando categorização também entram como "approvals" (revisão humana
        // pendente), pro card de "Ações Globais Pendentes" da Visão Geral enxergá-las.
        let approvals: Account[] = [];
        if (pendingRes && pendingRes.ok) {
          try {
            const pendingData = (await pendingRes.json()) as Partial<DanfePendingReviewResponse>;
            approvals = (pendingData.pending ?? []).map((entry) => ({
              id: `danfe-pending-${String(entry.chave ?? "").slice(-8)}`,
              beneficiary: entry.nfe_data?.emitente_nome ?? "Fornecedor não identificado",
              cnpj: entry.nfe_data?.emitente_cnpj ?? "",
              amount: String(entry.nfe_data?.valor_total ?? 0),
              dueDate: entry.nfe_data?.data_emissao ?? "",
              status: "AGUARDANDO_CATEGORIZACAO",
              transactionId: null,
              errorLog: null,
              stoppedNode: null,
              updatedAt: entry.staged_at ?? null,
            }));
          } catch {
            // Se json falhar, mantém lista vazia — não deve derrubar o resto do dashboard.
          }
        }

        const successItems = historyItems.filter((item) => item.audit_status === "success");
        const total = historyItems.length;
        const successCount = successItems.length;
        const automationRate = total > 0 ? Math.round((successCount / total) * 1000) / 10 : null;

        // ROI = (manual − atual) por nota lançada com sucesso (constantes em roi.ts).
        const { horas: hoursSaved, reais: estimatedSavings } = economia("danfe-tiny", successCount);

        const executions = historyItems.slice(0, 10).map((item, idx) => {
          const timeMs = item.processed_at ? new Date(item.processed_at).getTime() : idx;
          const executionId = item.chave_acesso
            ? `DANFE-${String(item.chave_acesso).slice(-8)}-${timeMs}`
            : `DANFE-EXEC-${idx + 1}-${timeMs}`;
          return {
            id: executionId,
            startedAt: item.processed_at ? new Date(item.processed_at).toISOString() : new Date().toISOString(),
            stoppedAt: item.processed_at ? new Date(item.processed_at).toISOString() : new Date().toISOString(),
            durationMs: 2500,
            status: (item.audit_status === "error" ? "error" : "success") as "error" | "success",
            stoppedNode: item.audit_status === "error" ? (item.details?.slice(0, 60) || "Erro fiscal") : null,
          };
        });

        // O .error.json fica em failed/ para sempre (alimenta o gráfico de 14 dias), então uma
        // falha só é pendência enquanto a mesma nota não tiver sido lançada com sucesso nem
        // marcada manualmente como resolvida (resolved_at).
        // Várias tentativas com erro da mesma nota contam como uma pendência só.
        const launchedChaves = new Set<string>(
          successItems.map((item) => item.chave_acesso).filter((chave): chave is string => Boolean(chave)),
        );
        const seenFailedChaves = new Set<string>();
        const failureItems = historyItems.filter((item) => {
          if (
            item.audit_status !== "error" ||
            item.resolved_at ||
            item.original_filename?.startsWith("SEFAZ-SCAN") ||
            item.metodo_leitura === "sefaz_dist_dfe" ||
            item.error_file?.includes("SEFAZ-SCAN")
          ) {
            return false;
          }
          const chave = item.chave_acesso;
          if (!chave) return true;
          if (launchedChaves.has(chave) || seenFailedChaves.has(chave)) return false;
          seenFailedChaves.add(chave);
          return true;
        });
        const failures: Account[] = failureItems.slice(0, 10).map((item, idx) => ({
          id: item.chave_acesso
            ? `danfe-failed-${String(item.chave_acesso).slice(-8)}`
            : `danfe-failed-${idx + 1}`,
          beneficiary:
            item.emitente?.razao_social ||
            item.original_filename ||
            item.error_file ||
            "Nota com falha fiscal",
          cnpj: item.emitente?.cnpj || "",
          amount: String(item.valor_total ?? 0),
          dueDate: item.processed_at ? new Date(item.processed_at).toISOString().slice(0, 10) : "",
          status: "FALHA_PROCESSAMENTO",
          transactionId: item.chave_acesso || null,
          errorLog: item.details || "Falha na esteira fiscal / Tiny ERP",
          stoppedNode: item.details?.slice(0, 60) || "Erro fiscal",
          updatedAt: item.processed_at ?? null,
        }));

        return {
          mode: "live",
          generatedAt: new Date().toISOString(),
          metrics: {
            totalQueue: total,
            paidCount: successCount,
            reconciledCount: successCount,
            hoursSaved,
            estimatedSavings,
            automationRate,
          },
          approvals,
          failures,
          executions,
          sources: {
            database: { status: "ok" },
            n8n: { status: "ok" },
          },
        };
      } catch (err) {
        console.error(`[DANFE Service] readDashboard falhou: ${(err as Error).message}`);
        return {
          mode: "live",
          generatedAt: new Date().toISOString(),
          metrics: null,
          approvals: null,
          failures: null,
          executions: null,
          sources: {
            database: {
              status: "error",
              message: "Motor de automação fiscal Python indisponível.",
            },
            n8n: {
              status: "error",
              message: "Telemetria de NF-e indisponível.",
            },
          },
        };
      }
    },
    async readHistory() {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/history`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as DanfeHistoryResponse;
    },
    async processBatch(body: Buffer, contentType: string, actor?: ActorContext): Promise<DanfeBatchResponse> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/process-batch`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          ...actorHeaders(actor, { asUser: true }),
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(120000), // 2 minutos para processar lotes
      });
      if (!res.ok) throw await upstreamError(res, "Falha no motor de automação fiscal");
      return (await res.json()) as DanfeBatchResponse;
    },
    async getTinyCategories(cnpj?: string): Promise<TinyCategory[]> {
      const baseUrl = await resolvePythonUrl();
      const query = cnpj ? `?cnpj=${encodeURIComponent(cnpj)}` : "";
      const res = await fetchFin(`${baseUrl}/api/v1/tiny/categories${query}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as TinyCategory[];
    },
    async getPendingReview(): Promise<DanfePendingReviewResponse> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/pending-review`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as DanfePendingReviewResponse;
    },
    async getNotas(status: DanfeNotaStatus): Promise<DanfeNotasResponse> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/notas?status_filter=${status}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as DanfeNotasResponse;
    },
    async archiveNota(chave: string, actor?: ActorContext): Promise<{ chave: string; status: string }> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...actorHeaders(actor, { asUser: true }) },
        body: JSON.stringify({ chave }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao arquivar a nota");
      return (await res.json()) as { chave: string; status: string };
    },
    async resolveFailure(errorFile: string, actor?: ActorContext): Promise<{ error_file: string; resolved_at: string }> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/failures/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...actorHeaders(actor, { asUser: true }) },
        body: JSON.stringify({ error_file: errorFile }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao marcar a falha como resolvida");
      return (await res.json()) as { error_file: string; resolved_at: string };
    },
    async restoreNota(chave: string, actor?: ActorContext): Promise<{ chave: string; status: string }> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...actorHeaders(actor, { asUser: true }) },
        body: JSON.stringify({ chave }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao restaurar a nota");
      return (await res.json()) as { chave: string; status: string };
    },
    async confirmLancamento(
      chave: string,
      itens: ConfirmLancamentoItemInput[],
      formaPagamento: string,
      meioPagamentoNfe?: string,
      parcelas?: number,
      actor?: ActorContext,
    ): Promise<ConfirmLancamentoResponse> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/confirm-lancamento`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...actorHeaders(actor, { asUser: true }) },
        body: JSON.stringify({
          chave,
          itens,
          forma_pagamento: formaPagamento,
          meio_pagamento_nfe: meioPagamentoNfe || null,
          parcelas: parcelas ?? 1,
        }),
        // Cada parcela é uma conta no Tiny (com throttle): nota parcelada demora mais.
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao confirmar lançamento no Tiny");
      return (await res.json()) as ConfirmLancamentoResponse;
    },
    async importKey(chave: string, actor?: ActorContext): Promise<DanfeImportKeyResponse> {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchFin(`${baseUrl}/api/v1/danfe/import-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...actorHeaders(actor, { asUser: true }) },
        body: JSON.stringify({ chave }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao importar NF-e pela chave");
      return (await res.json()) as DanfeImportKeyResponse;
    },
  };
}
