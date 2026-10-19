import type { AuthService } from "../auth.js";
import type { NotificationService } from "../notifications.js";
import { requireSession, parseJsonBody, type RequestContext } from "../http.js";

// Notificações do usuário logado (/api/notifications/*) — qualquer sessão válida.
export function createNotificationRoutes(deps: { auth: AuthService; notifications?: NotificationService }) {
  const { auth, notifications } = deps;

  return async function handleNotifications(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, send } = ctx;
    if (!path.startsWith("/api/notifications")) return false;
    const session = await requireSession(ctx, auth);
    if (!session) return true;
    if (!notifications) return send(503, { error: "Serviço de notificações não inicializado" });

    if (path === "/api/notifications" && method === "GET") {
      const unread = url.searchParams.get("unread") === "true";
      const limitParam = url.searchParams.get("limit");
      const limit = clampLimit(limitParam);
      return send(200, await notifications.listForUser(session.user.id, { unreadOnly: unread, limit }));
    }

    if (path === "/api/notifications/unread-count" && method === "GET") {
      return send(200, { count: await notifications.getUnreadCount(session.user.id) });
    }

    if (path === "/api/notifications/read-all" && method === "POST") {
      await notifications.markAllRead(session.user.id);
      return send(200, { success: true });
    }

    const readMatch = path.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (readMatch && method === "POST") {
      const ok = await notifications.markRead(Number(readMatch[1]), session.user.id);
      return send(ok ? 200 : 404, { success: ok });
    }

    if (path === "/api/notifications/emit" && method === "POST") {
      if (session.user.role !== "admin") {
        return send(403, { error: "Apenas administradores podem emitir notificações direcionadas." });
      }
      let body: any;
      try {
        body = await parseJsonBody<any>(ctx.request);
      } catch {
        return send(400, { error: "JSON inválido na requisição" });
      }
      if (!body || !body.tipo || !body.titulo) {
        return send(400, { error: "Campos 'tipo' e 'titulo' são obrigatórios" });
      }
      const notifData = {
        tipo: String(body.tipo),
        titulo: String(body.titulo),
        mensagem: body.mensagem ? String(body.mensagem) : undefined,
        link: body.link ? String(body.link) : undefined,
      };

      // Destino: usuário, permissão ("<aba>:<acao>" — quem tem a chave + admins), área (quem vê
      // alguma aba da área + admins), setor (rótulo de equipe, envio manual) ou perfil.
      if (body.target?.userId) {
        await notifications.notify(Number(body.target.userId), notifData);
      } else if (typeof body.target?.permission === "string") {
        await notifications.notifyPermission(body.target.permission, notifData);
      } else if (body.target?.area) {
        await notifications.notifyArea(body.target.area, notifData);
      } else if (body.target?.setor) {
        await notifications.notifySetor(body.target.setor, notifData);
      } else if (body.target?.role === "admin" || body.target?.role === "gestor" || body.target?.role === "user") {
        await notifications.notifyRole(body.target.role, notifData);
      } else {
        await notifications.notifyRole("admin", notifData);
      }
      return send(200, { success: true });
    }

    return send(404, { error: "Endpoint de notificações não encontrado" });
  };
}

/** Teto de itens por consulta (GW-16): evita respostas gigantes por `?limit=` arbitrário. */
export const MAX_LIST_LIMIT = 200;
export function clampLimit(raw: string | null): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.min(Math.max(Number(raw), 1), MAX_LIST_LIMIT);
}
