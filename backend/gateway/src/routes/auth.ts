import { setTimeout as sleep } from "node:timers/promises";
import { InvalidCredentialsError, type AuthService } from "../auth.js";
import type { AuditService } from "../audit.js";
import type { NotificationService } from "../notifications.js";
import { createLoginThrottle } from "../login-throttle.js";
import { PublicError } from "../errors.js";
import { extractToken, parseJsonBody, requireSession, sendError, type RequestContext } from "../http.js";

// Rotas de autenticação e do próprio perfil (/api/auth/*).
export function createAuthRoutes(deps: { auth: AuthService; notifications?: NotificationService; audit?: AuditService }) {
  const { auth, notifications, audit } = deps;
  const loginThrottle = createLoginThrottle();

  /** Pedido de troca de username/e-mail: Gestor só decide pedidos de usuários do perfil User. */
  function notifyChangeReviewers(role: string, data: { tipo: string; titulo: string; mensagem?: string; link?: string }) {
    if (!notifications) return;
    return role === "user"
      ? notifications.notifyPermission("usuarios:revisar_alteracao", data)
      : notifications.notifyRole("admin", data);
  }

  return async function handleAuth(ctx: RequestContext): Promise<boolean> {
    const { path, method, send, request } = ctx;
    if (!path.startsWith("/api/auth/")) return false;

    if (path === "/api/auth/register" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        const { created, ...res } = await auth.register(body);
        // Mesma resposta para e-mail novo e repetido (não revela cadastro existente);
        // só o cadastro novo de fato avisa quem pode aprovar (admins + gestores com a ação).
        if (created && notifications) {
          void notifications.notifyPermission("usuarios:aprovar_cadastro", {
            tipo: "cadastro_pendente",
            titulo: "Novo cadastro aguardando aprovação",
            mensagem: `${typeof body?.nome === "string" ? body.nome.slice(0, 100) : "Um colaborador"} solicitou acesso à plataforma.`,
            link: "/admin/usuarios?tab=pending",
          });
        }
        return send(201, res);
      } catch (e) {
        return sendError(ctx, e, "Falha ao registrar.");
      }
    }

    if (path === "/api/auth/login" && method === "POST") {
      let login = "";
      try {
        const body = await parseJsonBody(request);
        login = typeof body.login === "string" ? body.login.trim().slice(0, 255) : "";
        const lockedFor = loginThrottle.check(login, ctx.ip);
        if (lockedFor > 0) {
          ctx.response.setHeader("Retry-After", String(lockedFor));
          const minutes = Math.max(1, Math.ceil(lockedFor / 60));
          return send(429, { error: `Muitas tentativas de login sem sucesso. Tente novamente em ${minutes} min.` });
        }
        // Atraso progressivo por conta (não bloqueia): o dono sempre consegue entrar.
        const delay = loginThrottle.accountDelayMs(login);
        if (delay > 0) await sleep(delay);

        const ua = (request.headers["user-agent"] as string) || "unknown";
        const res = await auth.login({ login: body.login, senha: body.senha, ip: ctx.ip, userAgent: ua });
        loginThrottle.recordSuccess(login, ctx.ip);
        void audit?.record({ actor: res.user, acao: "login", ip: ctx.ip });
        return send(200, res);
      } catch (e) {
        if (e instanceof InvalidCredentialsError) {
          // Só senha/usuário errados contam — cadastro pendente ou bloqueado já passou pela
          // senha correta. O texto digitado só vai para a auditoria se for um usuário real
          // (evita gravar senhas digitadas no campo de login por engano).
          void audit?.record({
            actor: null,
            actorLabel: e.knownUser ? login.slice(0, 100) : "Não identificado",
            acao: "login_falhou",
            alvo: e.knownUser ? login.slice(0, 100) : undefined,
            sucesso: false,
            ip: ctx.ip,
          });
          loginThrottle.recordFailure(login, ctx.ip);
          if (loginThrottle.check(login, ctx.ip) > 0) {
            console.warn(JSON.stringify({ event: "login_locked", ip: ctx.ip, at: new Date().toISOString() }));
          }
        }
        return sendError(ctx, e, "Falha no login.");
      }
    }

    if (path === "/api/auth/logout" && method === "POST") {
      const token = extractToken(request);
      if (token) {
        const session = await auth.validateSession(token);
        await auth.logout(token);
        if (session) void audit?.record({ actor: session.user, acao: "logout", ip: ctx.ip });
      }
      return send(200, { success: true });
    }

    if (path === "/api/auth/me" && method === "GET") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      const pendingChangeRequests = await auth.listChangeRequestsForUser(session.user.id);
      return send(200, { ...session, pendingChangeRequests });
    }

    if (path === "/api/auth/profile" && method === "PATCH") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      // Perfil é só local no frontend; nada é gravado aqui. Não ecoa o corpo de volta.
      await parseJsonBody(request);
      return send(200, { success: true });
    }

    if (path === "/api/auth/username-available" && method === "GET") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      const username = (ctx.url.searchParams.get("username") || "").slice(0, 100);
      return send(200, { available: await auth.checkUsernameAvailable(username, session.user.id) });
    }

    if (path === "/api/auth/email-available" && method === "GET") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      const email = (ctx.url.searchParams.get("email") || "").slice(0, 255);
      return send(200, { available: await auth.checkEmailAvailable(email, session.user.id) });
    }

    if (path === "/api/auth/change-username" && method === "POST") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      try {
        const body = await parseJsonBody(request);
        const result = await auth.requestChangeUsername(session.user.id, body.novoUsername);
        void audit?.record({
          actor: session.user,
          acao: "alteracao_cadastro_solicitada",
          detalhes: { campo: "username", valorNovo: result.valor_novo },
          ip: ctx.ip,
        });
        if (notifications) {
          // Quem pode decidir: admins e, se o pedido é de um User, gestores com a ação.
          void notifyChangeReviewers(session.user.role, {
            tipo: "alteracao_pendente",
            titulo: "Solicitação de alteração de cadastro",
            mensagem: `${session.user.nome} solicitou novo nome de usuário: "${result.valor_novo}".`,
            link: "/admin/usuarios?tab=pending",
          });
        }
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao solicitar alteração.");
      }
    }

    if (path === "/api/auth/change-email" && method === "POST") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      try {
        const body = await parseJsonBody(request);
        const result = await auth.requestChangeEmail(session.user.id, body.novoEmail);
        void audit?.record({
          actor: session.user,
          acao: "alteracao_cadastro_solicitada",
          detalhes: { campo: "email", valorNovo: result.valor_novo },
          ip: ctx.ip,
        });
        if (notifications) {
          // Quem pode decidir: admins e, se o pedido é de um User, gestores com a ação.
          void notifyChangeReviewers(session.user.role, {
            tipo: "alteracao_pendente",
            titulo: "Solicitação de alteração de cadastro",
            mensagem: `${session.user.nome} solicitou novo e-mail: "${result.valor_novo}".`,
            link: "/admin/usuarios?tab=pending",
          });
        }
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao solicitar alteração.");
      }
    }

    if (path === "/api/auth/change-password" && method === "POST") {
      const session = await requireSession(ctx, auth);
      if (!session) return true;
      try {
        const body = await parseJsonBody(request);
        if (!session.sessionId) throw new PublicError(401, "Sessão inválida ou expirada");
        await auth.changePassword(session.user.id, body.senhaAtual, body.novaSenha, session.sessionId);
        void audit?.record({ actor: session.user, acao: "senha_alterada", ip: ctx.ip });
        return send(200, { success: true });
      } catch (e) {
        return sendError(ctx, e, "Falha ao trocar senha.");
      }
    }

    return false;
  };
}
