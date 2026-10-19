import type { AuthService } from "../auth.js";
import type { EventHub } from "../events.js";
import { requireSession, type RequestContext } from "../http.js";

// Canal de eventos em tempo real (SSE) — qualquer sessão válida.
export function createEventRoutes(deps: { auth: AuthService; events?: EventHub }) {
  const { auth, events } = deps;

  return async function handleEvents(ctx: RequestContext): Promise<boolean> {
    if (ctx.path !== "/api/events" || ctx.method !== "GET") return false;
    const session = await requireSession(ctx, auth);
    if (!session) return true;
    if (!events) return ctx.send(503, { error: "Canal de eventos não inicializado" });
    events.attach(session.user.id, ctx.response);
    return true;
  };
}
