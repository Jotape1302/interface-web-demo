import type { AuthService } from "../auth.js";
import type { EventHub } from "../events.js";
import type { AuditService } from "../audit.js";
import { AUTOMACOES_REPORTAVEIS, parseIncidentReport, type IncidentService } from "../incidents.js";
import { AGENTES_QWEN_PERMISSAO } from "../agentes-qwen.js";
import { hasPermission } from "../permissions.js";
import { parseJsonBody, requireSession, sendError, type RequestContext } from "../http.js";

// Reportes de erro (/api/incidents) — botão "Reportar erro" das abas; quem resolve são os agentes
// Qwen (agentes-qwen.ts). Listar: quem vê a aba Agentes Qwen vê todos, os demais só os das abas que
// veem; reportar: quem vê a aba da automação (GW-16).
export function createIncidentRoutes(deps: {
  auth: AuthService;
  incidents?: IncidentService;
  events?: EventHub;
  audit?: AuditService;
}) {
  const { auth, incidents, events, audit } = deps;

  return async function handleIncidents(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, request, send } = ctx;
    if (!path.startsWith("/api/incidents")) return false;
    const session = await requireSession(ctx, auth);
    if (!session) return true;
    if (!incidents) return send(503, { error: "Serviço de incidentes não inicializado" });

    if (path === "/api/incidents" && method === "GET") {
      const statusParam = url.searchParams.get("status");
      const status = statusParam === "pending" || statusParam === "resolved" ? statusParam : undefined;
      const all = await incidents.list({ status });
      return send(
        200,
        hasPermission(session, AGENTES_QWEN_PERMISSAO)
          ? all
          : all.filter((i) => hasPermission(session, AUTOMACOES_REPORTAVEIS[i.automationId].ver)),
      );
    }

    if (path === "/api/incidents" && method === "POST") {
      try {
        const input = parseIncidentReport(await parseJsonBody(request));
        const view = AUTOMACOES_REPORTAVEIS[input.automationId].ver;
        if (!hasPermission(session, view)) {
          return send(403, { error: "Você não tem acesso à aba desta automação.", code: "forbidden", permission: view });
        }
        const incident = await incidents.report(
          { id: session.user.id, nome: session.user.nome, role: session.user.setor || session.user.role },
          input,
        );
        events?.publish("all", "incidents");
        void audit?.record({
          actor: session.user,
          acao: "incidente_reportado",
          alvo: `${incident.automationTitle} · ${incident.executionId}`,
          detalhes: incident.stoppedNode ? { etapa: incident.stoppedNode } : undefined,
          ip: ctx.ip,
        });
        return send(201, incident);
      } catch (e) {
        return sendError(ctx, e, "Falha ao reportar incidente.");
      }
    }

    return send(404, { error: "Endpoint de incidentes não encontrado" });
  };
}
