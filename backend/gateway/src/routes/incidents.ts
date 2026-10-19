import type { AuthService } from "../auth.js";
import type { EventHub } from "../events.js";
import type { AuditService } from "../audit.js";
import { parseIncidentReport, type IncidentAutomationId, type IncidentService } from "../incidents.js";
import { hasPermission } from "../permissions.js";
import { parseJsonBody, requireSession, sendError, type RequestContext } from "../http.js";

/** Aba de cada automação que gera incidentes — só quem vê a aba reporta/vê o incidente dela (GW-16). */
const INCIDENT_VIEW: Record<IncidentAutomationId, string> = {
  "accounts-payable": "contas_pagar:ver",
  "danfe-tiny": "revisao_nfe:ver",
};

// Incidentes (/api/incidents/*) — listar: quem vê Erros & Falhas vê todos, os demais só os das
// abas que veem; reportar: quem vê a aba da automação; resolver: erros:resolver (server.ts).
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
        hasPermission(session, "erros:ver")
          ? all
          : all.filter((i) => {
              const view = INCIDENT_VIEW[i.automationId];
              return view ? hasPermission(session, view) : false;
            }),
      );
    }

    if (path === "/api/incidents" && method === "POST") {
      try {
        const input = parseIncidentReport(await parseJsonBody(request));
        const view = INCIDENT_VIEW[input.automationId];
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
          alvo: `${incident.automationTitle} · execução ${incident.executionId}`,
          detalhes: incident.stoppedNode ? { etapa: incident.stoppedNode } : undefined,
          ip: ctx.ip,
        });
        return send(201, incident);
      } catch (e) {
        return sendError(ctx, e, "Falha ao reportar incidente.");
      }
    }

    const resolveMatch = path.match(/^\/api\/incidents\/([\w-]+)\/resolve$/);
    if (resolveMatch && method === "POST") {
      if (!hasPermission(session, "erros:resolver")) {
        return send(403, { error: "Você não tem permissão para resolver incidentes.", code: "forbidden", permission: "erros:resolver" });
      }
      const ok = await incidents.resolve(resolveMatch[1] ?? "", session.user.nome);
      if (ok) {
        events?.publish("all", "incidents");
        void audit?.record({ actor: session.user, acao: "incidente_resolvido", alvo: `Incidente #${resolveMatch[1]}`, ip: ctx.ip });
      }
      return send(ok ? 200 : 404, { success: ok });
    }

    return send(404, { error: "Endpoint de incidentes não encontrado" });
  };
}
