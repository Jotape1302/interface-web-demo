import type { Config } from "./config.js";
import type { Execution, ExecutionAdapter, HistoryAdapter } from "./contracts.js";
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Payload n8n inválido");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) throw new Error("Timestamp n8n inválido");
    return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  throw new Error("Timestamp n8n inválido");
}
export function mapExecution(value: unknown): Execution {
  const row = object(value);
  if (typeof row.id !== "string" && typeof row.id !== "number")
    throw new Error("Execução sem identificador");
  const status: Execution["status"] = ["success", "error", "waiting", "running"].includes(
    String(row.status),
  )
    ? (row.status as Execution["status"])
    : "unknown";
  const startedAt = timestamp(row.startedAt),
    stoppedAt = timestamp(row.stoppedAt);
  let stoppedNode: string | null = null;
  if ((status === "error" || status === "waiting") && row.data != null) {
    try {
      if (typeof row.data === "object" && row.data !== null && !Array.isArray(row.data)) {
        const data = row.data as Record<string, unknown>;
        if (data.resultData != null && typeof data.resultData === "object" && !Array.isArray(data.resultData)) {
          const result = data.resultData as Record<string, unknown>;
          const error =
            result.error != null && typeof result.error === "object" && !Array.isArray(result.error)
              ? (result.error as Record<string, unknown>)
              : null;
          const node =
            error?.node != null && typeof error.node === "object" && !Array.isArray(error.node)
              ? (error.node as Record<string, unknown>)
              : null;
          const candidate = node?.name ?? result.lastNodeExecuted;
          if (typeof candidate === "string") stoppedNode = candidate;
        }
      }
    } catch {
      // Silently ignore node extraction failure
    }
  }
  const duration =
    startedAt && stoppedAt && !["running", "waiting"].includes(status)
      ? Date.parse(stoppedAt) - Date.parse(startedAt)
      : null;
  const workflowId =
    row.workflowId !== undefined && row.workflowId !== null ? String(row.workflowId) : null;
  return {
    id: String(row.id),
    startedAt,
    stoppedAt,
    durationMs: duration !== null && duration >= 0 ? duration : null,
    status,
    stoppedNode,
    workflowId,
  };
}
export function createN8n(
  config: Config,
  request: typeof fetch = fetch,
  limit = 10,
): ExecutionAdapter {
  const workflowIds =
    config.n8n.workflowIds && config.n8n.workflowIds.length > 0
      ? config.n8n.workflowIds
      : config.n8n.workflowId
        ? [config.n8n.workflowId]
        : [];

  const limitStr = String(limit);

  return {
    async read() {
      if (!config.n8n.baseUrl || !config.n8n.apiKey || workflowIds.length === 0) return [];
      const fetchWorkflow = async (workflowId: string): Promise<Execution[]> => {
        const doFetch = async (includeData: boolean) => {
          const url = new URL(`${config.n8n.baseUrl.replace(/\/$/, "")}/api/v1/executions`);
          url.search = new URLSearchParams({
            workflowId,
            limit: limitStr,
            includeData: includeData ? "true" : "false",
          }).toString();
          const response = await request(url, {
            headers: { "X-N8N-API-KEY": config.n8n.apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(config.timeoutMs),
            redirect: "error",
          });
          if (!response.ok) throw new Error(`N8N_HTTP_${response.status}`);
          if (!response.body) throw new Error("Resposta n8n sem corpo");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 25 * 1024 * 1024) throw new Error("Payload n8n excede 25 MiB");
              chunks.push(value);
            }
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
          } finally {
            reader.releaseLock();
          }
          const payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!Array.isArray(payload.data)) throw new Error("Lista n8n inválida");
          const items = payload.data.slice(0, limit);
          const mapped: Execution[] = [];
          for (const item of items) {
            const row = object(item);
            if (row.workflowId !== undefined && String(row.workflowId) !== workflowId) {
              continue;
            }
            try {
              mapped.push(mapExecution(row));
            } catch {
              // skip unmappable item
            }
          }
          return mapped;
        };

        try {
          return await doFetch(true);
        } catch {
          // Se includeData falhou por payload grande ou timeout, faz fallback para includeData=false
          return await doFetch(false);
        }
      };

      const results = await Promise.allSettled(workflowIds.map(fetchWorkflow));
      const map = new Map<string, Execution>();
      for (const res of results) {
        if (res.status === "fulfilled") {
          for (const item of res.value) {
            map.set(item.id, item);
          }
        }
      }
      if (results.every((r) => r.status === "rejected")) {
        const firstError = (results[0] as PromiseRejectedResult).reason;
        throw firstError;
      }
      return [...map.values()]
        .sort((a, b) => {
          const timeA = a.startedAt ? Date.parse(a.startedAt) : 0;
          const timeB = b.startedAt ? Date.parse(b.startedAt) : 0;
          if (timeA !== timeB) return timeB - timeA;
          return b.id.localeCompare(a.id);
        })
        .slice(0, limit);
    },
  };
}

export function createN8nHistory(
  config: Config,
  request: typeof fetch = fetch,
  maxPages = 20,
): HistoryAdapter {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
    throw new Error("Limite de páginas inválido");
  const workflowIds =
    config.n8n.workflowIds && config.n8n.workflowIds.length > 0
      ? config.n8n.workflowIds
      : config.n8n.workflowId
        ? [config.n8n.workflowId]
        : [];

  return {
    async readHistory(window) {
      if (!config.n8n.baseUrl || !config.n8n.apiKey || workflowIds.length === 0) {
        return { executions: [], complete: true };
      }
      const signal = AbortSignal.timeout(config.timeoutMs);
      const executions = new Map<string, Execution>();
      let complete = true;

      for (const workflowId of workflowIds) {
        const seen = new Set<string>();
        let cursor: string | null = null;
        let workflowComplete = false;

        for (let page = 0; page < maxPages; page++) {
          const url = new URL(`${config.n8n.baseUrl.replace(/\/$/, "")}/api/v1/executions`);
          url.search = new URLSearchParams({
            workflowId,
            limit: "100",
            includeData: "false",
            ...(cursor ? { cursor } : {}),
          }).toString();
          const response = await request(url, {
            headers: { "X-N8N-API-KEY": config.n8n.apiKey, Accept: "application/json" },
            signal,
            redirect: "error",
          });
          if (!response.ok) throw new Error(`N8N_HISTORY_HTTP_${response.status}`);
          if (!response.body) throw new Error("Histórico sem corpo");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 25 * 1024 * 1024) throw new Error("Histórico excedeu limite de payload");
              chunks.push(value);
            }
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
          } finally {
            reader.releaseLock();
          }
          const payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!Array.isArray(payload.data)) throw new Error("Histórico inválido");
          if (payload.nextCursor != null && typeof payload.nextCursor !== "string")
            throw new Error("Cursor inválido");
          for (const item of payload.data) {
            const row = object(item);
            if (row.workflowId !== undefined && String(row.workflowId) !== workflowId)
              continue;
            let execution: Execution;
            try {
              execution = mapExecution(row);
            } catch {
              continue;
            }
            if (!execution.startedAt) {
              complete = false;
              continue;
            }
            const start = Date.parse(execution.startedAt);
            if (start >= Date.parse(window.from) && start <= Date.parse(window.to))
              executions.set(execution.id, execution);
          }
          cursor = payload.nextCursor ? String(payload.nextCursor) : null;
          if (!cursor) {
            workflowComplete = true;
            break;
          }
          if (seen.has(cursor)) {
            break;
          }
          seen.add(cursor);
        }

        if (!workflowComplete) {
          complete = false;
        }
      }

      return { complete, executions: [...executions.values()] };
    },
  };
}
