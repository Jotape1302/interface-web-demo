import type { Config } from "../config.js";
import type { AdminUserView, AuthService, User } from "../auth.js";
import type { NotificationService } from "../notifications.js";
import type { EventHub } from "../events.js";
import { parseAuditQuery, type AuditAction, type AuditService } from "../audit.js";
import { PublicError } from "../errors.js";
import { parseJsonBody, requireSession, sendError, type RequestContext, type Session } from "../http.js";
import {
  PERMISSION_CATALOG,
  catalogOnly,
  countPermissions,
  diffGrants,
  effectivePermissions,
  isCatalogKey,
  permissionLabel,
} from "../permissions.js";
import type { SystemHealthMonitor } from "../system-health.js";
import { createTokenAutomationRoutes } from "./token-automation.js";

/**
 * Rotas administrativas (/api/admin/*). A permissão da rota (aba × ação) já foi conferida em
 * server.ts (permissions.ts → ROUTE_RULES); aqui ficam as regras de ALVO:
 * - Gestor só age sobre usuários do perfil User (Admin/Gestor são só leitura para ele) e nunca
 *   concede nem revoga chave que não tem (403 `outside_ceiling`);
 * - ninguém altera a si mesmo (perfil, permissões, exclusão, sessões) — o setor próprio, sim;
 * - o ROOT é intocável por terceiros, inclusive por outro Admin;
 * - perfil: só Admin (rota `admin`), sempre ≥ 1 Admin.
 */
export function createAdminRoutes(deps: {
  config: Config;
  auth: AuthService;
  notifications?: NotificationService;
  audit?: AuditService;
  systemHealth?: SystemHealthMonitor;
  events?: EventHub;
}) {
  const { auth, notifications, audit, events } = deps;
  const handleTokenAutomation = createTokenAutomationRoutes(deps.config, audit);

  /** "Nome (#id)" do usuário alvo, para o log de auditoria ficar legível. */
  const labelOf = (u: Pick<User, "id" | "nome"> | null, id: number) => (u ? `${u.nome} (#${u.id})` : `Usuário #${id}`);

  /** Avisa as abas abertas do usuário que perfil/permissões mudaram (o frontend relê /api/auth/me). */
  const sessionChanged = (userId: number) => events?.publish(userId, "session");

  async function loadTarget(id: number): Promise<User> {
    const target = await auth.getUser(id);
    if (!target) throw new PublicError(404, "Usuário não encontrado.", "not_found");
    return target;
  }

  /** Regras de alvo comuns a toda ação de Gestão de Usuários. Lança PublicError 403. */
  function guardTarget(session: Session, target: User, opts: { self: "allow" | string }) {
    const isSelf = target.id === session.user.id;
    if (isSelf && opts.self !== "allow") throw new PublicError(403, opts.self, "self_change");
    if (!isSelf && target.is_root) {
      throw new PublicError(403, "O usuário ROOT tem acesso total e não pode ser alterado.", "root_protected");
    }
    if (session.user.role !== "admin" && target.role !== "user") {
      throw new PublicError(403, "Só o administrador altera Gestores e Administradores.", "target_forbidden");
    }
  }

  /** Gestor nunca concede nem revoga o que não tem (decisão B.1). Admin passa sempre. */
  function guardCeiling(session: Session, touched: readonly string[]) {
    if (session.user.role === "admin") return;
    const own = new Set(session.permissions);
    const items = [...new Set(touched)].filter((k) => isCatalogKey(k) && !own.has(k));
    if (items.length === 0) return;
    const labels = items.map(permissionLabel);
    throw new PublicError(
      403,
      `Você tentou conceder ou revogar algo fora das suas permissões: ${labels.join(", ")}. Peça ao administrador.`,
      "outside_ceiling",
      { items, labels },
    );
  }

  function toAdminView(u: User, byId: Map<number, User>): AdminUserView {
    const grants = u.role === "admin" ? [] : effectivePermissions(u.role, u.permissoes ?? []);
    const by = u.permissoes_alterado_por ?? null;
    return {
      ...u,
      permissoes: grants,
      is_root: Boolean(u.is_root),
      version: u.permissoes_versao ?? 0,
      permissions_count: countPermissions(u.role, u.permissoes ?? []),
      permissions_updated_by: by,
      permissions_updated_by_name: by !== null ? (byId.get(by)?.nome ?? null) : null,
      permissions_updated_at: u.permissoes_alterado_em ?? null,
    };
  }

  return async function handleAdmin(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, request, send } = ctx;
    if (!path.startsWith("/api/admin")) return false;

    const session = await requireSession(ctx, auth);
    if (!session) return true;
    const actor = session.user;
    const isAdmin = actor.role === "admin";

    const record = (acao: AuditAction, alvo?: string, detalhes?: Record<string, unknown>) =>
      void audit?.record({ actor, acao, alvo, detalhes, ip: ctx.ip });

    try {
      if (path === "/api/admin/permissions/catalog" && method === "GET") {
        return send(200, PERMISSION_CATALOG);
      }

      if (path === "/api/admin/system-health" && method === "GET") {
        if (!deps.systemHealth) return send(503, { error: "Monitor de saúde não inicializado" });
        return send(200, await deps.systemHealth.read(url.searchParams.get("refresh") === "1"));
      }

      if (path === "/api/admin/audit" && method === "GET") {
        if (!audit) return send(503, { error: "Serviço de auditoria não inicializado" });
        return send(200, await audit.list(parseAuditQuery(url.searchParams)));
      }

      if (path === "/api/admin/users" && method === "GET") {
        const users = await auth.listUsers();
        const byId = new Map(users.map((u) => [u.id, u]));
        return send(200, users.map((u) => toAdminView(u, byId)));
      }

      if (path === "/api/admin/users" && method === "POST") {
        const body = ((await parseJsonBody(request)) ?? {}) as Record<string, unknown>;
        if (!isAdmin) {
          // Usuário criado por Gestor é sempre User, dentro do teto do Gestor.
          if (body.role !== undefined && body.role !== null && body.role !== "" && body.role !== "user") {
            throw new PublicError(403, "Gestores só criam usuários do perfil User.", "role_forbidden", { field: "role" });
          }
          body.role = "user";
          guardCeiling(session, Array.isArray(body.grants) ? body.grants.filter((k): k is string => typeof k === "string") : []);
        }
        const created = await auth.createUser(body, { actorId: actor.id });
        record("usuario_criado", labelOf(created, created.id), {
          setor: created.setor,
          role: created.role,
          permissoes: created.permissoes ?? [],
        });
        return send(201, created);
      }

      const approveMatch = path.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
      if (approveMatch && method === "POST") {
        const target = await loadTarget(Number(approveMatch[1]));
        guardTarget(session, target, { self: "Você não pode aprovar o próprio cadastro." });
        if (target.status !== "pending") {
          throw new PublicError(409, "Usuário não está pendente de aprovação.", "not_pending");
        }
        const body = ((await parseJsonBody(request)) ?? {}) as Record<string, unknown>;
        if (Array.isArray(body.grants)) guardCeiling(session, body.grants.filter((k): k is string => typeof k === "string"));
        const result = await auth.approveUser(target.id, actor.id, {
          username: body.username,
          setor: body.setor,
          grants: body.grants,
        });
        record("usuario_aprovado", labelOf(target, target.id), {
          setor: result.setor,
          ...(result.setorSugerido !== result.setor ? { setorSugerido: result.setorSugerido } : {}),
          permissoes: result.grants,
          ...(result.permissionsSaved ? {} : { permissoesNaoGravadas: true }),
        });
        return send(200, { success: true, setor: result.setor, grants: result.grants, permissionsSaved: result.permissionsSaved });
      }

      const rejectMatch = path.match(/^\/api\/admin\/users\/(\d+)\/reject$/);
      if (rejectMatch && method === "POST") {
        const target = await loadTarget(Number(rejectMatch[1]));
        guardTarget(session, target, { self: "Você não pode recusar o próprio cadastro." });
        if (target.status !== "pending") {
          throw new PublicError(409, "Usuário não está pendente de aprovação.", "not_pending");
        }
        await auth.rejectUser(target.id, actor.id);
        record("usuario_rejeitado", labelOf(target, target.id));
        sessionChanged(target.id);
        return send(200, { success: true });
      }

      const deleteMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
      if (deleteMatch && method === "DELETE") {
        const target = await loadTarget(Number(deleteMatch[1]));
        guardTarget(session, target, { self: "Você não pode excluir o próprio usuário." });
        if (!(await auth.deleteUser(target.id))) return send(404, { error: "Usuário não encontrado.", code: "not_found" });
        record("usuario_excluido", labelOf(target, target.id), {
          setor: target.setor,
          role: target.role,
          permissoes: catalogOnly(target.permissoes ?? []),
        });
        sessionChanged(target.id);
        return send(200, { success: true });
      }

      const permMatch = path.match(/^\/api\/admin\/users\/(\d+)\/permissions$/);
      if (permMatch && method === "GET") {
        const target = await loadTarget(Number(permMatch[1]));
        const state = await auth.getPermissionState(target.id);
        if (!state) return send(404, { error: "Usuário não encontrado.", code: "not_found" });
        return send(200, { ...state, role: target.role, is_root: Boolean(target.is_root) });
      }
      if (permMatch && method === "PUT") {
        const target = await loadTarget(Number(permMatch[1]));
        guardTarget(session, target, { self: "Você não pode alterar as próprias permissões." });
        const body = ((await parseJsonBody(request)) ?? {}) as Record<string, unknown>;
        if (!Array.isArray(body.grants)) {
          throw new PublicError(400, "Envie o conjunto completo de permissões em `grants`.", "invalid_grants", { field: "grants" });
        }
        if (typeof body.expectedVersion !== "number") {
          throw new PublicError(400, "Envie a versão das permissões (`expectedVersion`) lida no editor.", "validation", {
            field: "expectedVersion",
          });
        }
        const before = (await auth.getPermissionState(target.id))?.grants ?? [];
        const requested = body.grants.filter((k): k is string => typeof k === "string");
        const { added, removed } = diffGrants(before, requested);
        guardCeiling(session, [...added, ...removed]);
        const state = await auth.replacePermissions(target.id, body.grants, {
          actorId: actor.id,
          expectedVersion: body.expectedVersion,
        });
        record("permissoes_alteradas", labelOf(target, target.id), {
          antes: before,
          depois: state.grants,
          concedidas: added,
          revogadas: removed,
          versao: state.version,
        });
        sessionChanged(target.id);
        return send(200, { ...state, role: target.role, is_root: Boolean(target.is_root) });
      }

      const roleMatch = path.match(/^\/api\/admin\/users\/(\d+)\/role$/);
      if (roleMatch && method === "PUT") {
        // Rota só de Admin (server.ts). Si mesmo, ROOT e último admin: regras no serviço.
        const id = Number(roleMatch[1]);
        const body = ((await parseJsonBody(request)) ?? {}) as Record<string, unknown>;
        const target = await loadTarget(id);
        const result = await auth.updateRole(id, body.role, { actorId: actor.id });
        record("perfil_alterado", labelOf(target, id), {
          de: result.previousRole,
          para: result.role,
          ...(result.previousRole === "admin" && result.role !== "admin" ? { permissoesZeradas: true } : {}),
          ...(result.removed.length ? { permissoesRemovidas: result.removed } : {}),
        });
        sessionChanged(id);
        return send(200, { success: true, previousRole: result.previousRole, role: result.role, permissions: result.state });
      }

      const setorMatch = path.match(/^\/api\/admin\/users\/(\d+)\/setor$/);
      if (setorMatch && method === "PUT") {
        const target = await loadTarget(Number(setorMatch[1]));
        // Setor não dá acesso: o próprio setor pode ser alterado (Admin).
        guardTarget(session, target, { self: "allow" });
        const body = ((await parseJsonBody(request)) ?? {}) as Record<string, unknown>;
        const ok = await auth.updateSetor(target.id, String(body?.setor ?? ""));
        if (!ok) return send(404, { error: "Usuário não encontrado.", code: "not_found" });
        record("setor_alterado", labelOf(target, target.id), { de: target.setor, setor: String(body?.setor ?? "").trim() });
        return send(200, { success: true });
      }

      if (path === "/api/admin/sessions" && method === "GET") {
        const [sessions, users] = await Promise.all([auth.listActiveSessions(), auth.listUsers()]);
        const roots = new Set(users.filter((u) => u.is_root).map((u) => u.id));
        // Gestor não vê as sessões de Admins e Gestores (só as de Users e as próprias).
        const visible = isAdmin ? sessions : sessions.filter((s) => s.role === "user" || s.usuario_id === actor.id);
        return send(
          200,
          visible.map((s) => ({ ...s, is_root: roots.has(s.usuario_id), current: s.id === session.sessionId })),
        );
      }

      // GW-03: o id é o público (public_id) listado em GET /api/admin/sessions, nunca o token.
      const forceSessionMatch = path.match(/^\/api\/admin\/sessions\/([a-f0-9]{24})\/force-logout$/);
      if (forceSessionMatch && forceSessionMatch[1] && method === "POST") {
        const publicId = forceSessionMatch[1];
        const alvoSessao = (await auth.listActiveSessions()).find((s) => s.id === publicId);
        if (!alvoSessao) return send(404, { error: "Sessão não encontrada ou já encerrada.", code: "not_found" });
        const target = await loadTarget(alvoSessao.usuario_id);
        guardTarget(session, target, { self: "Você não pode encerrar a própria sessão por aqui. Use Sair." });
        const ok = await auth.forceLogoutSession(publicId);
        if (!ok) return send(404, { error: "Sessão não encontrada ou já encerrada.", code: "not_found" });
        record("sessao_encerrada", labelOf(target, target.id));
        sessionChanged(target.id);
        return send(200, { success: true });
      }

      const forceUserMatch = path.match(/^\/api\/admin\/users\/(\d+)\/force-logout$/);
      if (forceUserMatch && method === "POST") {
        const target = await loadTarget(Number(forceUserMatch[1]));
        guardTarget(session, target, { self: "Você não pode encerrar as próprias sessões por aqui. Use Sair." });
        await auth.forceLogoutUser(target.id);
        record("sessoes_usuario_encerradas", labelOf(target, target.id));
        sessionChanged(target.id);
        return send(200, { success: true });
      }

      if (path === "/api/admin/pending-count" && method === "GET") {
        if (isAdmin) {
          const [signups, changes] = await Promise.all([auth.getPendingCount(), auth.getPendingChangeRequestsCount()]);
          return send(200, { count: signups + changes });
        }
        // Gestor: só o que ele pode decidir (cadastros são sempre User; alterações de Users).
        const [signups, changes, users] = await Promise.all([
          auth.getPendingCount(),
          auth.listChangeRequests("pending"),
          auth.listUsers(),
        ]);
        const userRole = new Map(users.map((u) => [u.id, u.role]));
        return send(200, { count: signups + changes.filter((c) => userRole.get(c.usuario_id) === "user").length });
      }

      if (path === "/api/admin/change-requests" && method === "GET") {
        const raw = url.searchParams.get("status");
        const status = raw === "pending" || raw === "approved" || raw === "rejected" ? raw : undefined;
        const [changes, users] = await Promise.all([auth.listChangeRequests(status), auth.listUsers()]);
        const byId = new Map(users.map((u) => [u.id, u]));
        return send(
          200,
          changes.map((c) => ({
            ...c,
            usuario_role: byId.get(c.usuario_id)?.role ?? null,
            usuario_is_root: Boolean(byId.get(c.usuario_id)?.is_root),
          })),
        );
      }

      const changeMatch = path.match(/^\/api\/admin\/change-requests\/(\d+)\/(approve|reject)$/);
      if (changeMatch && method === "POST") {
        const requestId = Number(changeMatch[1]);
        const pending = (await auth.listChangeRequests("pending")).find((c) => c.id === requestId);
        if (!pending) return send(404, { error: "Solicitação não encontrada ou já processada", code: "not_found" });
        const target = await loadTarget(pending.usuario_id);
        guardTarget(session, target, { self: "allow" });

        if (changeMatch[2] === "approve") {
          const result = await auth.approveChangeRequest(requestId, actor.id);
          if (!result) return send(404, { error: "Solicitação não encontrada ou já processada", code: "not_found" });
          record("alteracao_cadastro_aprovada", labelOf(target, result.usuario_id), {
            campo: result.tipo,
            valorNovo: result.valor_novo,
          });
          if (notifications) {
            void notifications.notify(result.usuario_id, {
              tipo: "alteracao_aprovada",
              titulo: "Alteração de cadastro aprovada",
              mensagem: `Seu novo ${result.tipo === "username" ? "nome de usuário" : "e-mail"} é "${result.valor_novo}".`,
            });
          }
          return send(200, { success: true });
        }

        const result = await auth.rejectChangeRequest(requestId, actor.id);
        if (!result) return send(404, { error: "Solicitação não encontrada ou já processada", code: "not_found" });
        record("alteracao_cadastro_rejeitada", labelOf(target, result.usuario_id));
        if (notifications) {
          void notifications.notify(result.usuario_id, {
            tipo: "alteracao_rejeitada",
            titulo: "Alteração de cadastro recusada",
            mensagem: "Sua solicitação de alteração de cadastro foi recusada pelo administrador.",
          });
        }
        return send(200, { success: true });
      }

      if (await handleTokenAutomation({ ...ctx, session })) return true;

      return send(404, { error: "Endpoint administrativo não encontrado" });
    } catch (e) {
      return sendError(ctx, e, "Falha na operação administrativa.");
    }
  };
}
