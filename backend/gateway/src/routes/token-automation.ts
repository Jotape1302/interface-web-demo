import type { Config } from "../config.js";
import { normalizeTokenWorkflowId } from "../config.js";
import type { AuditService } from "../audit.js";
import { parseJsonBody, type RequestContext } from "../http.js";

// Painel do workflow n8n de renovação de tokens OAuth do Tiny (/api/admin/token-automation*).
// Só é chamado de dentro de routes/admin.ts, depois da checagem de admin. Sem n8n
// configurado (ou indisponível), devolve a telemetria de demonstração abaixo.
/** Id de workflow do n8n: só alfanumérico (GW-13) — vai para a URL da API do n8n. */
export const WORKFLOW_ID_RE = /^[A-Za-z0-9]{1,32}$/;

export function createTokenAutomationRoutes(config: Config, audit?: AuditService) {
  return async function handleTokenAutomation(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, request, send } = ctx;

    if (path === "/api/admin/token-automation" && method === "GET") {
      const targetWfId = normalizeTokenWorkflowId(
        url.searchParams.get("workflowId") || config.n8n.tokenWorkflowId,
      );
      if (!WORKFLOW_ID_RE.test(targetWfId)) return send(400, { error: "workflowId inválido." });

      if (config.mode === "live") {
        if (!config.n8n.baseUrl || !config.n8n.apiKey) {
          return send(503, { error: "n8n não configurado neste ambiente." });
        }
        try {
          const fetchUrl = new URL(`${config.n8n.baseUrl.replace(/\/$/, "")}/api/v1/executions`);
          fetchUrl.search = new URLSearchParams({
            workflowId: targetWfId,
            limit: "30",
            includeData: "false",
          }).toString();
          const n8nRes = await fetch(fetchUrl, {
            headers: { "X-N8N-API-KEY": config.n8n.apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(config.timeoutMs),
          });
          if (n8nRes.ok) {
            const n8nData = (await n8nRes.json()) as { data?: any[] };
            if (Array.isArray(n8nData?.data)) {
              const mapped = n8nData.data.map((item: any) => {
                const started = item.startedAt ? new Date(item.startedAt).toISOString() : new Date().toISOString();
                const stopped = item.stoppedAt ? new Date(item.stoppedAt).toISOString() : null;
                const dur = started && stopped ? Date.parse(stopped) - Date.parse(started) : null;
                const isSucc = item.status === "success";
                return {
                  id: String(item.id),
                  startedAt: started,
                  stoppedAt: stopped,
                  durationMs: dur && dur >= 0 ? dur : null,
                  status: isSucc ? "success" : item.status === "error" ? "error" : "running",
                  stoppedNode: isSucc ? "SALVAR_NOVO_TOKEN" : "REFRESH_TOKEN_TINY",
                  tokensProcessed: isSucc ? 1 : 0,
                  message: isSucc
                    ? "Execução concluída com sucesso no n8n."
                    : "Execução com falha ou interrupção no n8n.",
                };
              });
              return send(200, {
                workflow: {
                  id: targetWfId,
                  name: "ATUALIZACAO_REFRESH_TOKEN",
                  status: "published",
                  schedule: "1h",
                },
                executions: mapped,
              });
            }
          }
          return send(502, { error: `n8n respondeu HTTP ${n8nRes.status} ao listar as execuções.` });
        } catch {
          return send(502, { error: "n8n indisponível ao listar as execuções." });
        }
      }

      // Somente no modo demo: telemetria fictícia.
      return send(200, {
        workflow: {
          id: targetWfId,
          name: "ATUALIZACAO_REFRESH_TOKEN",
          status: "published",
          schedule: "1h",
        },
        executions: [
          {
            id: "TOKEN-4105",
            startedAt: "2026-09-14T14:00:00Z",
            stoppedAt: "2026-09-14T14:00:01.420Z",
            durationMs: 1420,
            status: "success",
            stoppedNode: "SALVAR_NOVO_TOKEN",
            tokensProcessed: 2,
            message: "Tokens renovados com sucesso e gravados no MariaDB (api_tokens).",
            details: {
              accountsChecked: ["NORVIA-MATRIZ-01", "NORVIA-FILIAL-02", "NORVIA-DISTRIB-03"],
              renewedAccounts: ["NORVIA-MATRIZ-01", "NORVIA-FILIAL-02"],
            },
          },
          {
            id: "TOKEN-4104",
            startedAt: "2026-09-14T13:00:00Z",
            stoppedAt: "2026-09-14T13:00:00.610Z",
            durationMs: 610,
            status: "success",
            stoppedNode: "PRECISA_RENOVAR?",
            tokensProcessed: 0,
            message: "Nenhum token com expiração iminente (< 4h). Ciclo concluído sem necessidade de renovação.",
            details: {
              accountsChecked: ["NORVIA-MATRIZ-01", "NORVIA-FILIAL-02", "NORVIA-DISTRIB-03"],
              renewedAccounts: [],
            },
          },
          {
            id: "TOKEN-4103",
            startedAt: "2026-09-14T12:00:00Z",
            stoppedAt: "2026-09-14T12:00:01.150Z",
            durationMs: 1150,
            status: "success",
            stoppedNode: "SALVAR_NOVO_TOKEN",
            tokensProcessed: 1,
            message: "Token da filial renovado com sucesso e persistido no banco.",
            details: {
              accountsChecked: ["NORVIA-MATRIZ-01", "NORVIA-FILIAL-02", "NORVIA-DISTRIB-03"],
              renewedAccounts: ["NORVIA-DISTRIB-03"],
            },
          },
          {
            id: "TOKEN-4102",
            startedAt: "2026-09-14T11:00:00Z",
            stoppedAt: "2026-09-14T11:00:02.300Z",
            durationMs: 2300,
            status: "error",
            stoppedNode: "REFRESH_TOKEN_TINY",
            tokensProcessed: 0,
            message: "Erro HTTP 401 no nó REFRESH_TOKEN_TINY: refresh_token inválido ou expirado.",
            details: {
              accountsChecked: ["NORVIA-MATRIZ-01", "NORVIA-FILIAL-02", "NORVIA-DISTRIB-03"],
              errorDetail: "Tiny OAuth retornou status 401 Unauthorized para a conta NORVIA-MATRIZ-01.",
            },
          },
          {
            id: "TOKEN-4101",
            startedAt: "2026-09-14T10:00:00Z",
            stoppedAt: "2026-09-14T10:00:00.580Z",
            durationMs: 580,
            status: "success",
            stoppedNode: "PRECISA_RENOVAR?",
            tokensProcessed: 0,
            message: "Tokens válidos. Nenhuma ação requerida no ciclo.",
            details: {
              accountsChecked: ["NORVIA-MATRIZ-01", "NORVIA-FILIAL-02", "NORVIA-DISTRIB-03"],
              renewedAccounts: [],
            },
          },
        ],
      });
    }

    if (path === "/api/admin/token-automation/execute" && method === "POST") {
      let bodyObj: any = {};
      try {
        bodyObj = await parseJsonBody(request).catch(() => ({}));
      } catch {}
      const rawWf = typeof bodyObj?.workflowId === "string" ? bodyObj.workflowId : "";
      const targetWfId = normalizeTokenWorkflowId(rawWf || config.n8n.tokenWorkflowId);
      if (!WORKFLOW_ID_RE.test(targetWfId)) return send(400, { error: "workflowId inválido." });
      const registrar = (sucesso: boolean, extra?: Record<string, unknown>) =>
        void audit?.record({
          actor: ctx.session?.user ?? null,
          acao: "workflow_token_disparado",
          alvo: "ATUALIZACAO_REFRESH_TOKEN",
          detalhes: { workflowId: targetWfId, ...extra },
          sucesso,
          ip: ctx.ip,
        });

      if (config.mode === "live") {
        if (!config.n8n.baseUrl || !config.n8n.apiKey) {
          registrar(false, { erro: "n8n não configurado" });
          return send(503, { success: false, error: "n8n não configurado neste ambiente." });
        }
        try {
          const runUrl = `${config.n8n.baseUrl.replace(/\/$/, "")}/api/v1/workflows/${encodeURIComponent(targetWfId)}/run`;
          const runRes = await fetch(runUrl, {
            method: "POST",
            headers: {
              "X-N8N-API-KEY": config.n8n.apiKey,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(config.timeoutMs),
            body: JSON.stringify({ destination: "manual_trigger" }),
          });
          if (runRes.ok) {
            const runData = (await runRes.json().catch(() => ({}))) as any;
            registrar(true);
            return send(200, {
              success: true,
              executionId: runData?.data?.executionId ?? null,
              message: `Workflow ${targetWfId} disparado com sucesso no n8n!`,
            });
          }
          // Sem sucesso falso: o n8n recusou o disparo (GW-13).
          registrar(false, { httpStatus: runRes.status });
          return send(502, { success: false, error: `O n8n recusou o disparo do workflow (HTTP ${runRes.status}).` });
        } catch {
          registrar(false, { erro: "n8n indisponível" });
          return send(502, { success: false, error: "n8n indisponível: o workflow não foi disparado." });
        }
      }

      // Somente no modo demo: disparo simulado.
      registrar(true, { demo: true });
      return send(200, {
        demo: true,
        success: true,
        executionId: `TOKEN-${Math.floor(4106 + Math.random() * 100)}`,
        message: `Workflow ${targetWfId} disparado com sucesso!`,
      });
    }

    return false;
  };
}
