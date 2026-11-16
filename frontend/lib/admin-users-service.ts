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
import { loadDemoPermissions } from './demo-permissions-loader';

const demoStore = () => loadDemoPermissions().then((m) => m.demoAdminStore);
import { demoDelay } from './demo-session';
import type { PermissionCatalog, PermissionStateView, PolicyActor, Role } from './permissions';

export interface AdminUsersService {
  catalog(signal?: AbortSignal): Promise<AdminResult<PermissionCatalog>>;
  listUsers(signal?: AbortSignal): Promise<AdminResult<AdminUserView[]>>;
  listSessions(signal?: AbortSignal): Promise<AdminResult<AdminSession[]>>;
  listChangeRequests(signal?: AbortSignal): Promise<AdminResult<AdminChangeRequest[]>>;
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

  private async request<T>(method: string, path: string, fallback: string, body?: unknown, signal?: AbortSignal): Promise<AdminResult<T>> {
    let res: Response;
    try {
      res = await fetch(`${resolveApiBaseUrl().replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
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

  catalog(signal?: AbortSignal) {
    return this.request<PermissionCatalog>('GET', '/api/admin/permissions/catalog', 'Falha ao carregar o catálogo de permissões', undefined, signal);
  }
  listUsers(signal?: AbortSignal) {
    return this.request<AdminUserView[]>('GET', '/api/admin/users', 'Falha ao carregar a lista de usuários', undefined, signal);
  }
  listSessions(signal?: AbortSignal) {
    return this.request<AdminSession[]>('GET', '/api/admin/sessions', 'Falha ao carregar as sessões ativas', undefined, signal);
  }
  listChangeRequests(signal?: AbortSignal) {
    return this.request<AdminChangeRequest[]>(
      'GET',
      '/api/admin/change-requests?status=pending',
      'Falha ao carregar as alterações de cadastro',
      undefined,
      signal,
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
  async catalog() {
    const store = await demoStore();
    return demoDelay<AdminResult<PermissionCatalog>>({ ok: true, data: store.catalog() }, 250);
  }
  async listUsers() {
    const store = await demoStore();
    return demoDelay(store.listUsers(this.actor));
  }
  async listSessions() {
    const store = await demoStore();
    return demoDelay(store.listSessions(this.actor));
  }
  async listChangeRequests() {
    const store = await demoStore();
    return demoDelay(store.listChangeRequests(this.actor));
  }
  async getPermissions(userId: number) {
    const store = await demoStore();
    return demoDelay(store.getPermissions(this.actor, userId), 400);
  }
  async putPermissions(userId: number, grants: string[], expectedVersion: number) {
    const store = await demoStore();
    return demoDelay(store.putPermissions(this.actor, userId, grants, expectedVersion), 600);
  }
  async putRole(userId: number, role: Role) {
    const store = await demoStore();
    return demoDelay(store.putRole(this.actor, userId, role), 500);
  }
  async putSetor(userId: number, setor: string) {
    const store = await demoStore();
    return demoDelay(store.putSetor(this.actor, userId, setor), 300);
  }
  async deleteUser(userId: number) {
    const store = await demoStore();
    return demoDelay(store.deleteUser(this.actor, userId), 500);
  }
  async createUser(payload: NewUserPayload) {
    const store = await demoStore();
    return demoDelay(store.createUser(this.actor, payload), 700);
  }
  async approve(userId: number, payload: ApprovePayload) {
    const store = await demoStore();
    return demoDelay(store.approve(this.actor, userId, payload), 600);
  }
  async reject(userId: number) {
    const store = await demoStore();
    return demoDelay(store.reject(this.actor, userId), 400);
  }
  async forceLogout(sessionId: string) {
    const store = await demoStore();
    return demoDelay(store.forceLogout(this.actor, sessionId), 400);
  }
  async reviewChangeRequest(requestId: number, approve: boolean) {
    const store = await demoStore();
    return demoDelay(store.reviewChangeRequest(this.actor, requestId, approve), 400);
  }
}

export function createAdminUsersService(opts: { demo: boolean; token: string | null; actor: PolicyActor }): AdminUsersService {
  return opts.demo ? new DemoAdminUsersService(opts.actor) : new LiveAdminUsersService(opts.token);
}
