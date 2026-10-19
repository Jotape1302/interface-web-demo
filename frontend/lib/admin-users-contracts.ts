// Contratos da Gestão de Usuários — espelho de backend/gateway/src/auth.ts (AdminUserView,
// ActiveSession, ChangeRequest) e das respostas de backend/gateway/src/routes/admin.ts.

import type { ApiErrorDetail } from './api-errors';
import type { PermissionState, PermissionStateView, Role } from './permissions';

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'blocked';

export interface AdminUserView {
  id: number;
  username: string;
  nome: string;
  email: string;
  setor: string;
  role: Role;
  status: UserStatus;
  criado_em?: string;
  /** Só chaves do catálogo (Admin: [] — acesso total implícito). */
  permissoes: string[];
  is_root: boolean;
  version: number;
  permissions_count: { tabs: number; actions: number };
  permissions_updated_by: number | null;
  permissions_updated_by_name: string | null;
  permissions_updated_at: string | null;
}

export interface AdminSession {
  /** Id público da sessão (nunca o token). */
  id: string;
  usuario_id: number;
  nome: string;
  email: string;
  username: string;
  setor: string;
  role: Role;
  ip_address: string;
  user_agent: string;
  ultimo_acesso: string;
  criado_em: string;
  is_root: boolean;
  /** É a sessão de quem está vendo. */
  current: boolean;
}

export interface AdminChangeRequest {
  id: number;
  usuario_id: number;
  tipo: 'username' | 'email';
  valor_atual: string;
  valor_novo: string;
  status: 'pending' | 'approved' | 'rejected';
  solicitado_em: string;
  usuario_nome?: string;
  usuario_role: Role | null;
  usuario_is_root: boolean;
}

/** POST /api/admin/users */
export interface NewUserPayload {
  nome: string;
  username: string;
  email: string;
  setor: string;
  senha: string;
  role: Role;
  grants: string[];
}

/** POST /api/admin/users/:id/approve */
export interface ApprovePayload {
  username: string;
  setor: string;
  grants: string[];
}

export interface ApproveResult {
  success: boolean;
  setor: string;
  grants: string[];
  /** false = aprovado, mas as permissões não foram gravadas (aprovado sem permissões). */
  permissionsSaved: boolean;
}

/** PUT /api/admin/users/:id/role */
export interface RoleChangeResult {
  success: boolean;
  previousRole: Role;
  role: Role;
  permissions: PermissionState;
}

export type { PermissionStateView };

/** Corpo de erro do gateway: { error, code?, field?, items?, labels?, current?, requestId }. */
export type AdminApiError = ApiErrorDetail;

export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: AdminApiError };
