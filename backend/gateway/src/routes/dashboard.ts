import type { Dashboard, OverviewResponse } from "../contracts.js";
import { methodNotAllowed, type RequestContext } from "../http.js";

// Visão geral do Financeiro e painel de Contas a Pagar. Último módulo da cadeia:
// o que chegar até aqui sem rota conhecida responde 404/405.
export function createDashboardRoutes(deps: {
  dashboard: { read(): Promise<Dashboard> };
  overview?: { read(): Promise<OverviewResponse> };
}) {
  const { dashboard, overview } = deps;

  return async function handleDashboard(ctx: RequestContext): Promise<boolean> {
    const { path, send } = ctx;

    const isDashboardPath =
      path === "/api/accounts-payable/dashboard" || (path === "/api/overview" && !!overview);

    if (isDashboardPath) {
      if (ctx.method !== "GET") {
        methodNotAllowed(ctx, "GET, OPTIONS");
        return true;
      }
      try {
        return send(200, path === "/api/overview" && overview ? await overview.read() : await dashboard.read());
      } catch {
        return send(500, { error: "Falha interna ao consultar o dashboard" });
      }
    }

    // Não intercepta rotas de conciliação ou outras rotas registradas
    if (path.startsWith("/api/reconciliation")) {
      return false;
    }

    if (ctx.method !== "GET") {
      methodNotAllowed(ctx, "GET, POST, OPTIONS");
      return true;
    }

    return send(404, { error: "Endpoint não encontrado" });
  };
}
