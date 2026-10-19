import { FinancialDashboardNotSyncedError, type FinancialDashboardService } from "../financial-dashboard.js";
import type { AuditService } from "../audit.js";
import { sendError, type RequestContext } from "../http.js";
import { hasPermission } from "../permissions.js";

// Dashboard Financeiro (/api/financial-dashboard*), agregação read-only do Tiny ERP.
export function createFinancialDashboardRoutes(deps: {
  financialDashboard?: FinancialDashboardService;
  audit?: AuditService;
}) {
  const { financialDashboard, audit } = deps;

  return async function handleFinancialDashboard(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, send } = ctx;
    if (!path.startsWith("/api/financial-dashboard")) return false;
    if (!financialDashboard) return send(503, { error: "Serviço de Dashboard Financeiro não inicializado" });

    if (path === "/api/financial-dashboard/status" && method === "GET") {
      try {
        return send(200, await financialDashboard.readStatus());
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar status do Dashboard Financeiro.");
      }
    }

    if (path === "/api/financial-dashboard/sync" && method === "POST") {
      const force = url.searchParams.get("force") === "true" || url.searchParams.get("force") === "1";
      if (force && !(ctx.session && hasPermission(ctx.session, "dashboard_financeiro:forcar_sincronizacao"))) {
        return send(403, {
          error: "Você não tem permissão para forçar a sincronização.",
          code: "forbidden",
          permission: "dashboard_financeiro:forcar_sincronizacao",
        });
      }
      try {
        const result = await financialDashboard.sync(ctx, { force });
        void audit?.record({
          actor: ctx.session?.user ?? null,
          actorLabel: "Modo demonstração",
          acao: "dashboard_financeiro_sincronizado",
          detalhes: force ? { forcado: true } : undefined,
          ip: ctx.ip,
        });
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao sincronizar o Dashboard Financeiro.");
      }
    }

    if (path === "/api/financial-dashboard" && method === "GET") {
      const dateFrom = url.searchParams.get("date_from");
      const dateTo = url.searchParams.get("date_to");
      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateFrom || !dateTo || !isoDate.test(dateFrom) || !isoDate.test(dateTo)) {
        return send(422, { error: "Parâmetros 'date_from' e 'date_to' (YYYY-MM-DD) são obrigatórios." });
      }
      const company = (url.searchParams.get("company") || "").slice(0, 64) || undefined;
      try {
        return send(200, await financialDashboard.readDashboard(dateFrom, dateTo, company));
      } catch (e) {
        if (e instanceof FinancialDashboardNotSyncedError) {
          return send(404, { error: e.message });
        }
        return sendError(ctx, e, "Falha ao consultar o Dashboard Financeiro.");
      }
    }

    return send(404, { error: "Endpoint de Dashboard Financeiro não encontrado" });
  };
}
