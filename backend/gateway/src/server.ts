import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Dashboard, OverviewResponse } from "./contracts.js";
import type { DanfeService } from "./danfe.js";
import type { FinancialDashboardService } from "./financial-dashboard.js";
import type { ServiceHealthCheckers } from "./overview.js";
import { createAuthService, type AuthService } from "./auth.js";
import type { NotificationService } from "./notifications.js";
import type { ChatService } from "./chat.js";
import type { IncidentService } from "./incidents.js";
import type { EventHub } from "./events.js";
import type { AuditService } from "./audit.js";
import type { ReconciliationHistoryService } from "./reconciliation-history.js";
import type { SystemHealthMonitor } from "./system-health.js";
import { areaOfKey, hasPermission, routeAccess } from "./permissions.js";
import { buildTrustedProxyList, clientIpFrom } from "./client-ip.js";
import {
  extractToken,
  isAllowedOrigin,
  preparseJsonBody,
  sendError,
  type RequestContext,
  type RouteHandler,
} from "./http.js";
import { createHealthRoutes, isPublicHealthPath } from "./routes/health.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createNotificationRoutes } from "./routes/notifications.js";
import { createEventRoutes } from "./routes/events.js";
import { createIncidentRoutes } from "./routes/incidents.js";
import { createChatRoutes } from "./routes/chat.js";
import { createDanfeRoutes } from "./routes/danfe.js";
import { createFinancialDashboardRoutes } from "./routes/financial-dashboard.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createReconciliationRoutes } from "./routes/reconciliation.js";
import { createMarketplaceRoutes } from "./routes/marketplace.js";
import { createMlReconciliationRoutes } from "./routes/ml-reconciliation.js";
import { createStockCountRoutes } from "./routes/stock-count.js";
import type { StockSkuService } from "./stock-sku.js";

export interface ApiDeps {
  dashboard: { read(): Promise<Dashboard> };
  overview?: { read(): Promise<OverviewResponse> };
  danfe?: DanfeService;
  healthCheckers?: ServiceHealthCheckers;
  auth?: AuthService;
  notifications?: NotificationService;
  chat?: ChatService;
  financialDashboard?: FinancialDashboardService;
  incidents?: IncidentService;
  events?: EventHub;
  audit?: AuditService;
  reconciliationHistory?: ReconciliationHistoryService;
  stockSku?: StockSkuService;
  systemHealth?: SystemHealthMonitor;
}

// Servidor HTTP do gateway: CORS, chave interna, limite de consultas e controle de
// acesso por área ficam aqui; cada grupo de rotas mora no seu módulo em routes/.
export function createApi(config: Config, deps: ApiDeps) {
  const auth = deps.auth ?? createAuthService(config);
  void auth.bootstrap();
  const clients = new Map<string, { since: number; count: number }>();

  const handleHealth = createHealthRoutes(config, deps.healthCheckers, auth);
  const trustedProxies = buildTrustedProxyList(config.trustedProxies);
  const internalKeyDigest = config.internalApiKey ? sha256(config.internalApiKey) : null;
  const { audit } = deps;

  // Rotas de plataforma (sessão, admin, notificações, eventos, incidentes, chat).
  const openRoutes: RouteHandler[] = [
    createAuthRoutes({ auth, notifications: deps.notifications, audit }),
    createAdminRoutes({ config, auth, notifications: deps.notifications, audit, systemHealth: deps.systemHealth, events: deps.events }),
    createNotificationRoutes({ auth, notifications: deps.notifications }),
    createEventRoutes({ auth, events: deps.events }),
    createIncidentRoutes({ auth, incidents: deps.incidents, events: deps.events, audit }),
    createChatRoutes({ auth, chat: deps.chat, events: deps.events }),
  ];

  // Rotas de negócio (automações).
  const areaRoutes: RouteHandler[] = [
    createDanfeRoutes({ danfe: deps.danfe, audit }),
    createFinancialDashboardRoutes({ financialDashboard: deps.financialDashboard, audit }),
    createReconciliationRoutes({ config, audit, history: deps.reconciliationHistory }),
    createMlReconciliationRoutes({ audit }),
    createMarketplaceRoutes({ audit }),
    createStockCountRoutes({ skus: deps.stockSku, audit }),
    createDashboardRoutes({ dashboard: deps.dashboard, overview: deps.overview }),
  ];

  /**
   * Controle de acesso central de TODO /api/* (RBAC por usuário, negado por padrão):
   * - a regra vem de `routeAccess` (permissions.ts → ROUTE_RULES): public | free | scoped | admin |
   *   perm (aba × ação) | none;
   * - rota sem mapeamento (`none`) é recusada mesmo com sessão válida (404), então rota nova só
   *   responde depois de mapeada — test/permissions-coverage.test.ts garante o mapeamento;
   * - `perm`: admin passa sempre; os demais só com a chave concedida (ausência = negado);
   * - regras de alvo (Gestor só sobre Users, ROOT, si mesmo) ficam em routes/admin.ts;
   *   regras que dependem do corpo/consulta (`?force=true`, automação do incidente) ficam na rota.
   * Só no modo demo, sem token, a LEITURA das abas de negócio segue liberada (demonstração local
   * sem login, sem chamadas externas); ações, Sistema e Gestão de Usuários exigem sessão (SEC-01).
   */
  async function authorize(ctx: RequestContext): Promise<boolean> {
    if (!ctx.path.startsWith("/api/")) return true;
    const access = routeAccess(ctx.method, ctx.path);
    if (access.kind === "public") return true;
    const token = extractToken(ctx.request);
    if (
      config.mode !== "live" &&
      !token &&
      (ctx.method === "GET" || ctx.method === "HEAD") &&
      access.kind === "perm" &&
      !["sistema", "usuarios"].includes(areaOfKey(access.key) ?? "sistema")
    ) {
      return true;
    }
    if (!token) {
      ctx.send(401, {
        error: "Não autorizado",
        message: "Autenticação necessária para acessar a plataforma.",
      });
      return false;
    }
    const session = await auth.validateSession(token);
    if (!session) {
      ctx.send(401, {
        error: "Sessão inválida ou expirada",
        message: "Sua sessão foi encerrada ou revogada. Faça login novamente.",
      });
      return false;
    }
    if (access.kind === "none") {
      ctx.send(404, { error: "Endpoint não encontrado" });
      return false;
    }
    if (access.kind === "admin" && session.user.role !== "admin") {
      ctx.send(403, {
        error: "Acesso negado",
        message: "Apenas administradores podem fazer isso.",
        code: "forbidden",
      });
      return false;
    }
    if (access.kind === "perm" && !hasPermission(session, access.key)) {
      ctx.send(403, {
        error: "Acesso negado",
        message: "Você não tem acesso a esta aba ou ação. Peça ao administrador para liberar em Gestão de Usuários.",
        code: "forbidden",
        permission: access.key,
      });
      return false;
    }
    ctx.session = session;
    return true;
  }

  // Limite elevado para acomodar SPA com navegação rápida entre abas.
  function rateLimited(ctx: RequestContext): boolean {
    const now = Date.now();
    for (const [key, value] of clients) if (now - value.since > 60_000) clients.delete(key);
    if (!clients.has(ctx.ip) && clients.size >= 10000) {
      ctx.send(503, { error: "Capacidade temporariamente esgotada" });
      return true;
    }
    const state = clients.get(ctx.ip) ?? { since: now, count: 0 };
    state.count++;
    clients.set(ctx.ip, state);
    if (state.count > 300) {
      ctx.response.setHeader("Retry-After", "60");
      ctx.send(429, { error: "Limite de consultas atingido. Tente novamente em um minuto." });
      return true;
    }
    return false;
  }

  const server = createServer(async (request, response) => {
    // Cliente desconectou antes da resposta. Não usar `request.on("close")`: no Node ≥16 ele
    // dispara assim que o corpo é lido, e abortaria toda requisição com body (POST/PUT).
    const clientAbortController = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) clientAbortController.abort();
    });

    // Aceita o X-Request-Id do cliente só se for um identificador simples (vai para logs e automações).
    const incomingId = request.headers["x-request-id"];
    const requestId =
      typeof incomingId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(incomingId) ? incomingId : randomUUID();
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Request-Id", requestId);
    const send = (status: number, body: unknown): true => {
      if (!response.writableEnded) {
        response.statusCode = status;
        response.end(JSON.stringify(body));
      }
      return true;
    };

    try {
      const origin = request.headers.origin;
      if (origin) {
        if (!isAllowedOrigin(origin, config.origins)) return send(403, { error: "Origem não permitida" });
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Session-Token, X-Request-Id");
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Session-Token, X-Request-Id");
        response.statusCode = 204;
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");
      const rawPath = url.pathname;
      const path = rawPath.startsWith("/automacoes/")
        ? rawPath.replace(/^\/automacoes/, "")
        : rawPath === "/automacoes"
          ? "/"
          : rawPath;

      const ctx: RequestContext = {
        request,
        response,
        url,
        path,
        method: request.method ?? "GET",
        ip: clientIpFrom(request, trustedProxies),
        requestId,
        signal: clientAbortController.signal,
        send,
      };

      const isPublicPath = isPublicHealthPath(path);

      // Validação de autenticação interna opcional (SEC-01), em tempo constante (GW-16).
      if (internalKeyDigest && !isPublicPath) {
        const authHeader = request.headers.authorization;
        const apiKeyHeader = request.headers["x-api-key"] as string | undefined;
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
        const providedKey = apiKeyHeader ?? bearerToken;

        if (!providedKey || !timingSafeEqual(sha256(providedKey), internalKeyDigest)) {
          return send(401, {
            error: "Não autorizado",
            message: "Acesso restrito. Chave de acesso interna inválida ou ausente.",
          });
        }
      }

      if (await handleHealth(ctx)) return;
      if (rateLimited(ctx)) return;

      // Corpo JSON lido uma vez aqui: limite de 1 MB (413), Content-Type JSON (415) e JSON
      // válido (400) antes de qualquer rota (GW-06). O upload multipart da NF-e lê o próprio stream.
      if (["POST", "PUT", "PATCH", "DELETE"].includes(ctx.method) && path !== "/api/danfe/process-batch") {
        await preparseJsonBody(request);
      }

      if (!(await authorize(ctx))) return;
      for (const handle of openRoutes) {
        if (await handle(ctx)) return;
      }
      for (const handle of areaRoutes) {
        if (await handle(ctx)) return;
      }
    } catch (globalErr) {
      // GW-09: mensagem genérica + requestId; o detalhe fica só no log.
      const url = request.url ?? "/";
      const fakeCtx = { requestId, path: url.split("?")[0] ?? url, method: request.method ?? "GET" };
      return sendError({ ...fakeCtx, send } as unknown as RequestContext, globalErr, "Erro interno no servidor gateway.");
    }
  });
  server.on("clientError", (err: any, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) return;
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n" +
        JSON.stringify({
          error: "Bad Request",
          detail: "Conexão rejeitada pelo parser HTTP. Se você tentou usar HTTPS, use HTTP (http://localhost:3100).",
        }) +
        "\n",
    );
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  return server;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
