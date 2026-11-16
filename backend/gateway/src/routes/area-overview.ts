import type { AreaVisaoGeralId } from "../contracts.js";
import { AREA_IDS, areaViewKey, type AreaOverviewService } from "../area-overview.js";
import { hasPermission } from "../permissions.js";
import { methodNotAllowed, sendError, type RequestContext } from "../http.js";

/**
 * GET /api/areas/{financeiro|logistica|marketplace|producao}/visao-geral — ações pendentes,
 * automações e serviços da área. A aba "Visão geral" da área é checada em ROUTE_RULES; cada
 * item só sai se o usuário vê a aba de origem (filtro aplicado aqui, depois do cache).
 */
export function createAreaOverviewRoutes(deps: { areaOverview?: AreaOverviewService; mode: "demo" | "live" }) {
  return async function handleAreaOverview(ctx: RequestContext): Promise<boolean> {
    const m = ctx.path.match(/^\/api\/areas\/(financeiro|logistica|marketplace|producao)\/visao-geral$/);
    if (!m || !deps.areaOverview) return false;
    if (m && ctx.method !== "GET") {
      methodNotAllowed(ctx, "GET, OPTIONS");
      return true;
    }
    if (m && ctx.method === "GET") {
      // segue: única operação da rota
    }
    const area = m[1] as AreaVisaoGeralId;
    if (!AREA_IDS.includes(area)) return false;
    // Sem sessão só existe no demo local (leitura liberada pelo servidor): enxerga tudo.
    const can = (perm: string) => (ctx.session ? hasPermission(ctx.session, perm) : deps.mode === "demo");
    if (!can(areaViewKey(area))) {
      return ctx.send(403, { error: "Acesso negado", code: "forbidden", permission: areaViewKey(area) });
    }
    try {
      return ctx.send(200, await deps.areaOverview.read(area, can));
    } catch (err) {
      return sendError(ctx, err, "Falha interna ao montar a visão geral da área.");
    }
  };
}
