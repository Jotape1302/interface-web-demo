import type { Config } from "../config.js";
import type { AuthService } from "../auth.js";
import type { ServiceHealthCheckers } from "../overview.js";
import { methodNotAllowed, requireSession, type RequestContext } from "../http.js";
import { getAllCircuitBreakers } from "../circuit-breaker.js";
import { hasPermission } from "../permissions.js";

/**
 * Health público mínimo (GW-08): só `/health` (vivo) e `/api/health` (status agregado de
 * Tiny + Inter, com cache de 30 s). Ficam fora da chave interna e do limite de consultas e
 * não expõem baseUrl, nomes de filiais, mensagens dos conectores nem estados de circuito.
 */
export function isPublicHealthPath(path: string): boolean {
  return path === "/health" || path === "/api/health";
}

/** Detalhes por conector e circuitos: só com a aba Saúde do Sistema (saude:ver). */
const DETAIL_PATHS = new Set([
  "/health/circuits",
  "/api/health/circuits",
  "/health/tiny",
  "/api/health/tiny",
  "/health/inter",
  "/api/health/inter",
  "/health/n8n",
  "/api/health/n8n",
]);

export const PUBLIC_HEALTH_CACHE_MS = 30_000;

export function createHealthRoutes(config: Config, healthCheckers?: ServiceHealthCheckers, auth?: AuthService) {
  let cached: { at: number; ok: boolean } | null = null;
  let inflight: Promise<boolean> | null = null;

  async function aggregate(): Promise<boolean> {
    if (cached && Date.now() - cached.at < PUBLIC_HEALTH_CACHE_MS) return cached.ok;
    if (!inflight) {
      inflight = (async () => {
        const [tiny, inter] = await Promise.all([
          healthCheckers?.checkTiny
            ? Promise.resolve().then(() => healthCheckers.checkTiny!()).catch(() => ({ connected: false }))
            : Promise.resolve({ connected: true }),
          healthCheckers?.checkInter
            ? Promise.resolve().then(() => healthCheckers.checkInter!()).catch(() => ({ connected: false }))
            : Promise.resolve({ connected: true }),
        ]);
        const ok = Boolean(tiny.connected && inter.connected);
        cached = { at: Date.now(), ok };
        return ok;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return async function handleHealth(ctx: RequestContext): Promise<boolean> {
    const { path, send } = ctx;
    const isPublic = isPublicHealthPath(path);
    if (!isPublic && !DETAIL_PATHS.has(path)) return false;

    if (ctx.method !== "GET") {
      methodNotAllowed(ctx, "GET, OPTIONS");
      return true;
    }

    if (path === "/health") return send(200, { status: "ok" });

    if (path === "/api/health") {
      const ok = await aggregate();
      return send(ok ? 200 : 503, { status: ok ? "ok" : "degraded" });
    }

    // Detalhes: exige a aba Saúde do Sistema.
    if (!auth) return send(401, { error: "Não autenticado" });
    const session = await requireSession(ctx, auth);
    if (!session) return true;
    if (!hasPermission(session, "saude:ver")) {
      return send(403, { error: "Acesso negado", message: "Você não tem acesso à Saúde do Sistema.", code: "forbidden", permission: "saude:ver" });
    }

    if (path.endsWith("/circuits")) {
      return send(200, { service: "circuit-breakers", circuits: getAllCircuitBreakers() });
    }

    if (path.endsWith("/tiny") || path.endsWith("/inter")) {
      const service = path.endsWith("/tiny") ? "tiny" : "inter";
      const checker = service === "tiny" ? healthCheckers?.checkTiny : healthCheckers?.checkInter;
      if (!checker) return send(200, { service, connected: true, message: "Verificação não configurada." });
      try {
        const res = await checker();
        return send(res.connected ? 200 : 503, { service, ...res });
      } catch {
        return send(503, { service, connected: false, message: "Falha na verificação de saúde." });
      }
    }

    const result = await checkN8n(config);
    return send(result.connected ? 200 : 503, result);
  };
}

/** Consulta a API do n8n (1 execução) para saber se ela responde com a chave configurada. */
export async function checkN8n(config: Config) {
  try {
    if (!config.n8n.baseUrl) {
      return {
        service: "n8n",
        connected: false,
        message: "N8N_BASE_URL não configurada no ambiente",
      };
    }
    const workflowId = config.n8n.workflowId || (config.n8n.workflowIds && config.n8n.workflowIds[0]) || "";
    const url = new URL(`${config.n8n.baseUrl.replace(/\/$/, "")}/api/v1/executions`);
    url.search = new URLSearchParams({ limit: "1", ...(workflowId ? { workflowId } : {}) }).toString();
    const res = await fetch(url, {
      headers: { "X-N8N-API-KEY": config.n8n.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs || 5000),
    });
    if (res.ok) {
      return {
        service: "n8n",
        connected: true,
        status: "ok",
        baseUrl: config.n8n.baseUrl,
        workflowCount: config.n8n.workflowIds.length,
        message: "n8n API operacional e conectada com sucesso.",
      };
    }
    return {
      service: "n8n",
      connected: false,
      status: "error",
      httpStatus: res.status,
      baseUrl: config.n8n.baseUrl,
      message:
        res.status === 401
          ? "API Key inválida (HTTP 401 Unauthorized)"
          : res.status === 404
            ? "Endpoint ou workflow não encontrado (HTTP 404)"
            : `n8n respondeu com HTTP ${res.status}`,
    };
  } catch (err) {
    const cause = err instanceof Error && "cause" in err && err.cause ? ` (${(err.cause as Error).message ?? String(err.cause)})` : "";
    const msg = (err instanceof Error ? err.message : String(err)) + cause;
    return {
      service: "n8n",
      connected: false,
      status: "error",
      baseUrl: config.n8n.baseUrl,
      message: `Falha ao conectar no n8n (${config.n8n.baseUrl}): ${msg}`,
    };
  }
}
