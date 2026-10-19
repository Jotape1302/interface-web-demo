import type { AuthService } from "../auth.js";
import type { ChatService } from "../chat.js";
import type { EventHub } from "../events.js";
import { parseJsonBody, requireSession, sendError, type RequestContext } from "../http.js";
import { clampLimit } from "./notifications.js";

// Chat direto (/api/chat/*) — qualquer sessão válida.
export function createChatRoutes(deps: { auth: AuthService; chat?: ChatService; events?: EventHub }) {
  const { auth, chat, events } = deps;

  return async function handleChat(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, request, send } = ctx;
    if (!path.startsWith("/api/chat")) return false;
    const session = await requireSession(ctx, auth);
    if (!session) return true;
    if (!chat) return send(503, { error: "Serviço de chat não inicializado" });

    if (path === "/api/chat/contacts" && method === "GET") {
      return send(200, await chat.listContacts(session.user.id));
    }

    if (path === "/api/chat/conversations" && method === "GET") {
      return send(200, await chat.listConversations(session.user.id));
    }

    if (path === "/api/chat/unread-count" && method === "GET") {
      return send(200, { count: await chat.getTotalUnreadCount(session.user.id) });
    }

    if (path === "/api/chat/messages" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        const message = await chat.sendMessage(session.user.id, Number(body.destinatarioId), String(body.conteudo));
        events?.publish([session.user.id, Number(body.destinatarioId)], "chat");
        return send(201, message);
      } catch (e) {
        return sendError(ctx, e, "Falha ao enviar mensagem.");
      }
    }

    const messagesMatch = path.match(/^\/api\/chat\/messages\/(\d+)$/);
    if (messagesMatch && method === "GET") {
      const otherUserId = Number(messagesMatch[1]);
      const before = url.searchParams.get("before") || undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = clampLimit(limitParam);
      return send(200, await chat.listMessages(session.user.id, otherUserId, { before: before?.slice(0, 64), limit }));
    }

    const readConvMatch = path.match(/^\/api\/chat\/messages\/(\d+)\/read$/);
    if (readConvMatch && method === "POST") {
      await chat.markConversationRead(session.user.id, Number(readConvMatch[1]));
      // Atualiza o contador de não lidas nas outras abas do mesmo usuário.
      events?.publish(session.user.id, "chat");
      return send(200, { success: true });
    }

    return send(404, { error: "Endpoint de chat não encontrado" });
  };
}
