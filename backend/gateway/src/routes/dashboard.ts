import type { Dashboard, OverviewResponse } from "../contracts.js";
import { hasPermission } from "../permissions.js";
import { semRoiNasMetricas } from "../roi.js";
import { lerPeriodo } from "../periodo.js";
import type { RoiPeriodo, RoiResponse } from "../contracts.js";
import { methodNotAllowed, type RequestContext } from "../http.js";

// Visão geral do Financeiro e painel de Contas a Pagar. Último módulo da cadeia:
// o que chegar até aqui sem rota conhecida responde 404/405.
export function createDashboardRoutes(deps: {
  dashboard: { read(): Promise<Dashboard> };
  overview?: { read(): Promise<OverviewResponse> };
  roi?: { read(periodo?: RoiPeriodo): Promise<RoiResponse> };
}) {
  const { dashboard, overview, roi } = deps;

  return async function handleDashboard(ctx: RequestContext): Promise<boolean> {
    const { path, send } = ctx;

    if (path === "/api/roi" && roi) {
      if (ctx.method !== "GET") {
        methodNotAllowed(ctx, "GET, OPTIONS");
        return true;
      }
      const lido = lerPeriodo(ctx.url.searchParams);
      if ("erro" in lido) return send(400, { error: lido.erro });
      try {
        return send(200, await roi.read(lido.periodo));
      } catch {
        return send(500, { error: "Falha interna ao calcular o ROI" });
      }
    }

    const isDashboardPath =
      path === "/api/accounts-payable/dashboard" || (path === "/api/overview" && !!overview);

    if (isDashboardPath) {
      if (ctx.method !== "GET") {
        methodNotAllowed(ctx, "GET, OPTIONS");
        return true;
      }
      try {
        // Horas e R$ economizados só vão para quem tem `roi:ver` (corte no servidor; sem sessão = sem ROI).
        const veRoi = !!ctx.session && hasPermission(ctx.session, "roi:ver");
        if (path === "/api/overview" && overview) {
          const o = await overview.read();
          return send(200, veRoi ? o : { ...o, automations: o.automations.map((a) => ({ ...a, dashboard: semRoiNasMetricas(a.dashboard) })) });
        }
        const d = await dashboard.read();
        return send(200, veRoi ? d : semRoiNasMetricas(d));
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
