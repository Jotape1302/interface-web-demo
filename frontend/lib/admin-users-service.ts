// Cliente da Gestão de Usuários (GET/POST/PUT/DELETE /api/admin/*). No modo demo usa o store em
// memória de lib/demo-permissions.ts, que aplica as mesmas regras do gateway.

import { readApiErrorDetail } from './api-errors';
import type {
  AdminChangeRequest,
  AdminResult,
  AdminSession,
  AdminUserView,
  ApprovePayload,
  ApproveResult,
  NewUserPayload,
  RoleChangeResult,
} from './admin-users-contracts';
import { resolveApiBaseUrl } from './contracts';
import { demoAdminStore } from './demo-permissions';
import { demoDelay } from './demo-session';
import type { PermissionCatalog, PermissionStateView, PolicyActor, Role } from './permissions';

export interface AdminUsersService {
  catalog(): Promise<AdminResult<PermissionCatalog>>;
  listUsers(): Promise<AdminResult<AdminUserView[]>>;
  listSessions(): Promise<AdminResult<AdminSession[]>>;
  listChangeRequests(): Promise<AdminResult<AdminChangeRequest[]>>;
  getPermissions(userId: number): Promise<AdminResult<PermissionStateView>>;
  putPermissions(userId: number, grants: string[], expectedVersion: number): Promise<AdminResult<PermissionStateView>>;
  putRole(userId: number, role: Role): Promise<AdminResult<RoleChangeResult>>;
  putSetor(userId: number, setor: string): Promise<AdminResult<{ success: boolean }>>;
  deleteUser(userId: number): Promise<AdminResult<{ success: boolean }>>;
  createUser(payload: NewUserPayload): Promise<AdminResult<AdminUserView>>;
  approve(userId: number, payload: ApprovePayload): Promise<AdminResult<ApproveResult>>;
  reject(userId: number): Promise<AdminResult<{ success: boolean }>>;
  forceLogout(sessionId: string): Promise<AdminResult<{ success: boolean }>>;
  reviewChangeRequest(requestId: number, approve: boolean): Promise<AdminResult<{ success: boolean }>>;
}

const NETWORK_ERROR = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';

class LiveAdminUsersService implements AdminUsersService {
  constructor(private readonly token: string | null) {}

  private async request<T>(method: string, path: string, fallback: string, body?: unknown): Promise<AdminResult<T>> {
    let res: Response;
    try {
      res = await fetch(`${resolveApiBaseUrl().replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return {
        ok: false,
        error: { status: 0, message: NETWORK_ERROR, code: 'network', field: null, items: [], labels: [], current: null },
      };
    }
    if (!res.ok) return { ok: false, error: await readApiErrorDetail(res, fallback) };
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: true, data };
  }

  catalog() {
    return this.request<PermissionCatalog>('GET', '/api/admin/permissions/catalog', 'Falha ao carregar o catálogo de permissões');
  }
  listUsers() {
    return this.request<AdminUserView[]>('GET', '/api/admin/users', 'Falha ao carregar a lista de usuários');
  }
  listSessions() {
    return this.request<AdminSession[]>('GET', '/api/admin/sessions', 'Falha ao carregar as sessões ativas');
  }
  listChangeRequests() {
    return this.request<AdminChangeRequest[]>(
      'GET',
      '/api/admin/change-requests?status=pending',
      'Falha ao carregar as alterações de cadastro',
    );
  }
  getPermissions(userId: number) {
    return this.request<PermissionStateView>('GET', `/api/admin/users/${userId}/permissions`, 'Falha ao carregar as permissões');
  }
  putPermissions(userId: number, grants: string[], expectedVersion: number) {
    return this.request<PermissionStateView>('PUT', `/api/admin/users/${userId}/permissions`, 'Falha ao salvar as permissões', {
      grants,
      expectedVersion,
    });
  }
  putRole(userId: number, role: Role) {
    return this.request<RoleChangeResult>('PUT', `/api/admin/users/${userId}/role`, 'Falha ao alterar o perfil', { role });
  }
  putSetor(userId: number, setor: string) {
    return this.request<{ success: boolean }>('PUT', `/api/admin/users/${userId}/setor`, 'Falha ao alterar o setor', { setor });
  }
  deleteUser(userId: number) {
    return this.request<{ success: boolean }>('DELETE', `/api/admin/users/${userId}`, 'Falha ao excluir o usuário');
  }
  createUser(payload: NewUserPayload) {
    return this.request<AdminUserView>('POST', '/api/admin/users', 'Falha ao criar o usuário', payload);
  }
  approve(userId: number, payload: ApprovePayload) {
    return this.request<ApproveResult>('POST', `/api/admin/users/${userId}/approve`, 'Falha ao aprovar o cadastro', payload);
  }
  reject(userId: number) {
    return this.request<{ success: boolean }>('POST', `/api/admin/users/${userId}/reject`, 'Falha ao recusar o cadastro');
  }
  forceLogout(sessionId: string) {
    return this.request<{ success: boolean }>(
      'POST',
      `/api/admin/sessions/${encodeURIComponent(sessionId)}/force-logout`,
      'Falha ao encerrar a sessão',
    );
  }
  reviewChangeRequest(requestId: number, approve: boolean) {
    return this.request<{ success: boolean }>(
      'POST',
      `/api/admin/change-requests/${requestId}/${approve ? 'approve' : 'reject'}`,
      approve ? 'Falha ao aprovar a alteração' : 'Falha ao recusar a alteração',
    );
  }
}

class DemoAdminUsersService implements AdminUsersService {
  constructor(private readonly actor: PolicyActor) {}
  catalog() {
    return demoDelay<AdminResult<PermissionCatalog>>({ ok: true, data: demoAdminStore.catalog() }, 250);
  }
  listUsers() {
    return demoDelay(demoAdminStore.listUsers(this.actor));
  }
  listSessions() {
    return demoDelay(demoAdminStore.listSessions(this.actor));
  }
  listChangeRequests() {
    return demoDelay(demoAdminStore.listChangeRequests(this.actor));
  }
  getPermissions(userId: number) {
    return demoDelay(demoAdminStore.getPermissions(this.actor, userId), 400);
  }
  putPermissions(userId: number, grants: string[], expectedVersion: number) {
    return demoDelay(demoAdminStore.putPermissions(this.actor, userId, grants, expectedVersion), 600);
  }
  putRole(userId: number, role: Role) {
    return demoDelay(demoAdminStore.putRole(this.actor, userId, role), 500);
  }
  putSetor(userId: number, setor: string) {
    return demoDelay(demoAdminStore.putSetor(this.actor, userId, setor), 300);
  }
  deleteUser(userId: number) {
    return demoDelay(demoAdminStore.deleteUser(this.actor, userId), 500);
  }
  createUser(payload: NewUserPayload) {
    return demoDelay(demoAdminStore.createUser(this.actor, payload), 700);
  }
  approve(userId: number, payload: ApprovePayload) {
    return demoDelay(demoAdminStore.approve(this.actor, userId, payload), 600);
  }
  reject(userId: number) {
    return demoDelay(demoAdminStore.reject(this.actor, userId), 400);
  }
  forceLogout(sessionId: string) {
    return demoDelay(demoAdminStore.forceLogout(this.actor, sessionId), 400);
  }
  reviewChangeRequest(requestId: number, approve: boolean) {
    return demoDelay(demoAdminStore.reviewChangeRequest(this.actor, requestId, approve), 400);
  }
}

export function createAdminUsersService(opts: { demo: boolean; token: string | null; actor: PolicyActor }): AdminUsersService {
  return opts.demo ? new DemoAdminUsersService(opts.actor) : new LiveAdminUsersService(opts.token);
}
