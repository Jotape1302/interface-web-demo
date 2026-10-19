'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  Clock,
  Globe,
  Info,
  LogOut,
  Monitor,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserCog,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth-context';
import { SETORES } from '@/lib/contracts';
import { formatDateTimeBR, formatTimeBR } from '@/lib/formatters';
import { createAdminUsersService } from '@/lib/admin-users-service';
import type {
  AdminChangeRequest,
  AdminSession,
  AdminUserView,
  ApprovePayload,
  NewUserPayload,
} from '@/lib/admin-users-contracts';
import {
  ROLE_LABEL,
  countGrants,
  formatAccessCount,
  hasNoAccess,
  targetPolicy,
  type PermissionCatalog,
  type PermissionStateView,
  type PolicyActor,
  type Role,
  type TargetPolicy,
} from '@/lib/permissions';
import { NewUserModal, ApproveUserModal } from '@/app/components/admin-user-modals';
import { PermissionEditorSheet } from '@/app/components/permission-editor-sheet';
import { RoleSelect } from '@/app/components/role-select';
import { ConfirmImpactDialog } from '@/app/components/confirm-impact-dialog';
import { AccessBadge, RootBadge } from '@/app/components/admin-user-badges';
import { Notice } from '@/app/components/admin-notice';

type Tab = 'pending' | 'users' | 'sessions';
type LoadState = 'loading' | 'error' | 'ready';

type Confirm =
  | { kind: 'delete'; user: AdminUserView }
  | { kind: 'reject'; user: AdminUserView }
  | { kind: 'session'; session: AdminSession }
  | { kind: 'rejectChange'; request: AdminChangeRequest };

const STATUS_LABEL: Record<AdminUserView['status'], string> = {
  pending: 'Pendente',
  approved: 'Ativo',
  rejected: 'Recusado',
  blocked: 'Bloqueado',
};

const LAST_ADMIN_MESSAGE = 'Não é possível: o sistema precisa de pelo menos um administrador.';

function readInitialTab(): Tab {
  if (typeof window === 'undefined') return 'pending';
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab === 'users' || tab === 'sessions' ? tab : 'pending';
}

function TabButton({
  active,
  onClick,
  icon,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex min-h-11 items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold transition sm:min-h-0 sm:py-3 ${
        active ? 'border-[var(--marca-ambar)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {children}
      {count !== undefined && count > 0 && (
        <Badge variant="danger" className="text-[10px] font-bold">
          {count}
        </Badge>
      )}
    </button>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 rounded-[4px] border border-border bg-card p-3" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-[4px]" />
      ))}
    </div>
  );
}

const TH = 'p-3 text-left font-mono text-[10px] font-semibold uppercase text-muted-foreground';
const TD = 'p-3 align-middle';

export default function AdminUsersPage() {
  const { user, token, isDemoMode, permissions, can, refreshPendingCount } = useAuth();

  const actorId = user?.id;
  const actorRole = user?.role;
  const actor = useMemo<PolicyActor | null>(
    () => (actorId !== undefined && actorRole ? { id: actorId, role: actorRole, permissions } : null),
    [actorId, actorRole, permissions],
  );
  const service = useMemo(
    () => (actor ? createAdminUsersService({ demo: isDemoMode, token, actor }) : null),
    [actor, isDemoMode, token],
  );

  const [activeTab, setActiveTab] = useState<Tab>(readInitialTab);
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [changeRequests, setChangeRequests] = useState<AdminChangeRequest[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [onlyNoAccess, setOnlyNoAccess] = useState(false);

  const [isNewUserOpen, setIsNewUserOpen] = useState(false);
  const [approvingUser, setApprovingUser] = useState<AdminUserView | null>(null);
  const [editorTarget, setEditorTarget] = useState<AdminUserView | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [setorBusy, setSetorBusy] = useState<number | null>(null);

  const isAdmin = actor?.role === 'admin';

  // Busca (sem estado) + aplicação (com estado) separadas: o efeito inicial aplica no `.then`,
  // e o botão Atualizar / "Tentar novamente" ligam o indicador antes (ver reloadNow).
  const fetchCatalog = useCallback(async () => (service ? service.catalog() : null), [service]);
  const applyCatalog = useCallback((res: Awaited<ReturnType<typeof fetchCatalog>>) => {
    if (!res) return;
    setCatalogError(res.ok ? null : res.error.message);
    if (res.ok) setCatalog(res.data);
  }, []);
  const loadCatalog = useCallback(async () => applyCatalog(await fetchCatalog()), [applyCatalog, fetchCatalog]);

  const fetchAll = useCallback(
    async () => (service ? Promise.all([service.listUsers(), service.listSessions(), service.listChangeRequests()]) : null),
    [service],
  );
  const applyAll = useCallback(
    (result: Awaited<ReturnType<typeof fetchAll>>) => {
      if (!result) return;
      const [u, s, c] = result;
      setRefreshing(false);
      if (!u.ok) {
        setLoadError(u.error.message);
        setLoadState('error');
        return;
      }
      setUsers(u.data);
      if (s.ok) setSessions(s.data);
      if (c.ok) setChangeRequests(c.data);
      setLoadState('ready');
      void refreshPendingCount();
    },
    [refreshPendingCount],
  );
  const refreshAll = useCallback(async () => applyAll(await fetchAll()), [applyAll, fetchAll]);

  useEffect(() => {
    let alive = true;
    void fetchAll().then((r) => alive && applyAll(r));
    void fetchCatalog().then((r) => alive && applyCatalog(r));
    return () => {
      alive = false;
    };
  }, [fetchAll, applyAll, fetchCatalog, applyCatalog]);

  const reloadNow = (showSkeleton = false) => {
    if (showSkeleton) setLoadState('loading');
    setRefreshing(true);
    void refreshAll();
  };

  const policyFor = useCallback(
    (target: { id: number; role: Role; is_root: boolean }): TargetPolicy | null => (actor ? targetPolicy(actor, target) : null),
    [actor],
  );

  // ---- Ações -------------------------------------------------------------------------------

  const openEditor = useCallback((target: AdminUserView) => setEditorTarget(target), []);

  const toastNoPermissions = (title: string, target: AdminUserView | undefined) => {
    toast.add({
      title,
      type: 'success',
      timeout: 8000,
      ...(target
        ? { actionProps: { children: 'Definir permissões', onClick: () => openEditor(target) } }
        : {}),
    });
  };

  const handleCreateUser = async (payload: NewUserPayload) => {
    if (!service) {
      return { ok: false as const, error: { status: 0, message: 'Sessão não carregada.', code: null, field: null, items: [], labels: [], current: null } };
    }
    const res = await service.createUser(payload);
    if (res.ok) {
      setIsNewUserOpen(false);
      const created = res.data;
      if (payload.role !== 'admin' && payload.grants.length === 0) {
        toastNoPermissions(`${created.nome} criado(a) sem permissões.`, created);
      } else {
        toast.add({ title: `${created.nome} criado(a) como ${ROLE_LABEL[created.role]}.`, type: 'success' });
      }
    }
    // A lista é relida fora do caminho de erro do formulário: uma falha ao recarregar não
    // pode parecer falha na criação (bug do "Novo Usuário").
    if (res.ok) void refreshAll();
    return res;
  };

  const handleApprove = async (userId: number, payload: ApprovePayload) => {
    if (!service) {
      return { ok: false as const, error: { status: 0, message: 'Sessão não carregada.', code: null, field: null, items: [], labels: [], current: null } };
    }
    const target = users.find((u) => u.id === userId);
    const res = await service.approve(userId, payload);
    if (res.ok) {
      setApprovingUser(null);
      const nome = target?.nome ?? 'Usuário';
      const approved = target ? { ...target, status: 'approved' as const, setor: res.data.setor } : undefined;
      if (!res.data.permissionsSaved || res.data.grants.length === 0) {
        toastNoPermissions(`${nome} aprovado(a) sem permissões.`, approved);
      } else {
        toast.add({ title: `${nome} aprovado(a) no setor ${res.data.setor}.`, type: 'success' });
      }
      void refreshAll();
    }
    return res;
  };

  const handleRole = async (target: AdminUserView, role: Role): Promise<boolean> => {
    if (!service) return false;
    const res = await service.putRole(target.id, role);
    if (!res.ok) {
      toast.add({ title: res.error.code === 'last_admin' ? LAST_ADMIN_MESSAGE : res.error.message, type: 'error' });
      return false;
    }
    const grants = res.data.permissions.grants;
    const updated: AdminUserView = {
      ...target,
      role,
      permissoes: role === 'admin' ? [] : grants,
      version: res.data.permissions.version,
      permissions_count: role === 'admin' ? target.permissions_count : countGrants(grants),
    };
    setUsers((prev) => prev.map((u) => (u.id === target.id ? updated : u)));
    toast.add({ title: `${target.nome} agora é ${ROLE_LABEL[role]}.`, type: 'success' });
    void refreshAll();
    // Admin rebaixado começa sem nenhuma permissão: abre o editor em seguida.
    if (res.data.previousRole === 'admin' && role !== 'admin') setEditorTarget(updated);
    return true;
  };

  const handleSetor = async (target: AdminUserView, setor: string, undo = false) => {
    if (!service || setor === target.setor) return;
    const previous = target.setor;
    setSetorBusy(target.id);
    const res = await service.putSetor(target.id, setor);
    setSetorBusy(null);
    if (!res.ok) {
      toast.add({ title: res.error.message, type: 'error' });
      return;
    }
    const updated = { ...target, setor };
    setUsers((prev) => prev.map((u) => (u.id === target.id ? updated : u)));
    if (undo) {
      toast.add({ title: `Setor de ${target.nome} voltou para ${setor}.`, type: 'success' });
      return;
    }
    toast.add({
      title: `Setor de ${target.nome} alterado de ${previous || '—'} para ${setor}.`,
      description: 'As permissões não mudaram.',
      type: 'success',
      timeout: 8000,
      actionProps: { children: 'Desfazer', onClick: () => void handleSetor(updated, previous, true) },
    });
  };

  const runConfirm = async () => {
    if (!confirm || !service) return;
    setConfirmBusy(true);
    let ok = false;
    let message = '';
    if (confirm.kind === 'delete') {
      const res = await service.deleteUser(confirm.user.id);
      ok = res.ok;
      message = res.ok ? `${confirm.user.nome} foi excluído(a).` : res.error.message;
    } else if (confirm.kind === 'reject') {
      const res = await service.reject(confirm.user.id);
      ok = res.ok;
      message = res.ok ? `Cadastro de ${confirm.user.nome} recusado.` : res.error.message;
    } else if (confirm.kind === 'session') {
      const res = await service.forceLogout(confirm.session.id);
      ok = res.ok;
      message = res.ok ? `Sessão de ${confirm.session.nome} encerrada.` : res.error.message;
    } else {
      const res = await service.reviewChangeRequest(confirm.request.id, false);
      ok = res.ok;
      message = res.ok ? 'Solicitação de alteração recusada.' : res.error.message;
    }
    setConfirmBusy(false);
    setConfirm(null);
    toast.add({ title: message, type: ok ? 'success' : 'error' });
    if (ok) void refreshAll();
  };

  const handleApproveChange = async (req: AdminChangeRequest) => {
    if (!service) return;
    const res = await service.reviewChangeRequest(req.id, true);
    toast.add({
      title: res.ok ? `Alteração de ${req.tipo === 'username' ? 'login' : 'e-mail'} aprovada.` : res.error.message,
      type: res.ok ? 'success' : 'error',
    });
    if (res.ok) void refreshAll();
  };

  const handleSaved = (userId: number, state: PermissionStateView) => {
    setUsers((prev) =>
      prev.map((u) =>
        u.id === userId
          ? {
              ...u,
              permissoes: state.grants,
              version: state.version,
              permissions_count: countGrants(state.grants),
              permissions_updated_by: state.updatedBy,
              permissions_updated_by_name: state.updatedByName,
              permissions_updated_at: state.updatedAt,
            }
          : u,
      ),
    );
  };

  // ---- Derivados ---------------------------------------------------------------------------

  const pendingUsers = useMemo(() => users.filter((u) => u.status === 'pending'), [users]);
  const activeUsers = useMemo(() => users.filter((u) => u.status !== 'pending'), [users]);
  const noAccessUsers = useMemo(
    () => activeUsers.filter((u) => u.status === 'approved' && hasNoAccess(u.role, u.permissions_count)),
    [activeUsers],
  );
  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeUsers.filter(
      (u) =>
        (roleFilter === 'all' || u.role === roleFilter) &&
        (!onlyNoAccess || hasNoAccess(u.role, u.permissions_count)) &&
        (!q || u.nome.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
    );
  }, [activeUsers, roleFilter, onlyNoAccess, search]);
  const sessionCountByUser = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of sessions) m.set(s.usuario_id, (m.get(s.usuario_id) ?? 0) + 1);
    return m;
  }, [sessions]);

  if (!actor) return null;

  const pendingTotal = pendingUsers.length + changeRequests.length;

  // ---- Células reaproveitadas na tabela e nos cards (<768px) -------------------------------

  const setorControl = (u: AdminUserView, policy: TargetPolicy | null) =>
    policy?.canChangeSetor ? (
      <NativeSelect
        size="sm"
        value={u.setor}
        disabled={setorBusy === u.id}
        onChange={(e) => void handleSetor(u, e.target.value)}
        aria-label={`Setor de ${u.nome}`}
        className="[&_select]:rounded-[4px] [&_select]:text-xs"
      >
        {(SETORES as readonly string[]).includes(u.setor) ? null : <NativeSelectOption value={u.setor}>{u.setor}</NativeSelectOption>}
        {SETORES.map((s) => (
          <NativeSelectOption key={s} value={s}>
            {s}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : (
      <span className="text-xs text-muted-foreground">{u.setor || '—'}</span>
    );

  const userActions = (u: AdminUserView, policy: TargetPolicy | null) => (
    <div className="flex items-center justify-end gap-1.5">
      <Button size="sm" variant="outline" onClick={() => openEditor(u)} aria-label={`Permissões de ${u.nome}`}>
        <SlidersHorizontal aria-hidden="true" />
        Permissões
      </Button>
      {policy?.canDelete && (
        <Button
          size="icon-sm"
          variant="destructive"
          onClick={() => setConfirm({ kind: 'delete', user: u })}
          aria-label={`Excluir ${u.nome}`}
          title="Excluir usuário"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      )}
    </div>
  );

  const nameCell = (u: AdminUserView) => (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5 font-semibold text-foreground">
        <span className="truncate">{u.nome}</span>
        {u.is_root && <RootBadge />}
        {u.status !== 'approved' && (
          <Badge variant="warning" className="text-[10px]">
            {STATUS_LABEL[u.status]}
          </Badge>
        )}
      </div>
      <div className="truncate font-mono text-[11px] font-normal text-muted-foreground">@{u.username}</div>
    </div>
  );

  const sessionAction = (s: AdminSession) => {
    if (s.current) return <span className="text-xs text-muted-foreground">Sua sessão</span>;
    const policy = policyFor({ id: s.usuario_id, role: s.role, is_root: s.is_root });
    if (policy?.canForceLogout) {
      return (
        <Button size="sm" variant="destructive" onClick={() => setConfirm({ kind: 'session', session: s })}>
          <LogOut aria-hidden="true" />
          Encerrar sessão
        </Button>
      );
    }
    const reason = s.is_root
      ? 'O usuário ROOT não pode ter a sessão encerrada por outra pessoa.'
      : 'Só o administrador encerra sessões de Gestores e Administradores';
    return (
      <Tooltip>
        <TooltipTrigger render={<button type="button" className="cursor-help text-xs text-muted-foreground" aria-label={reason} />}>
          —
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    );
  };

  const changeActions = (req: AdminChangeRequest) => {
    const policy = req.usuario_role
      ? policyFor({ id: req.usuario_id, role: req.usuario_role, is_root: req.usuario_is_root })
      : null;
    if (!policy?.canReviewChange) {
      return <span className="text-xs text-muted-foreground">Só o administrador decide</span>;
    }
    return (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void handleApproveChange(req)}>
          <CheckCircle aria-hidden="true" />
          Aprovar
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setConfirm({ kind: 'rejectChange', request: req })}>
          <XCircle aria-hidden="true" />
          Recusar
        </Button>
      </div>
    );
  };

  const signupActions = (u: AdminUserView) => (
    <div className="flex justify-end gap-1.5">
      {can('usuarios:aprovar_cadastro') && (
        <Button size="sm" variant="outline" onClick={() => setApprovingUser(u)}>
          <UserCheck aria-hidden="true" />
          Aprovar
        </Button>
      )}
      {can('usuarios:rejeitar_cadastro') && (
        <Button size="sm" variant="destructive" onClick={() => setConfirm({ kind: 'reject', user: u })}>
          <XCircle aria-hidden="true" />
          Recusar
        </Button>
      )}
    </div>
  );

  // ---- Render ------------------------------------------------------------------------------

  return (
    <TooltipProvider delay={300}>
      <div className="space-y-5">
        <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Administração</p>
            <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
              <ShieldCheck size={22} className="text-primary" aria-hidden="true" />
              Gestão de Usuários
            </h1>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {isAdmin
                ? 'Aprove cadastros, defina o perfil e as abas e ações de cada colaborador e acompanhe as sessões ativas. O setor só identifica a equipe; o acesso vem das permissões.'
                : 'Aprove cadastros e defina as abas e ações dos usuários do perfil User, dentro do que o administrador liberou para você.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {can('usuarios:criar') && (
              <Button variant="default" onClick={() => setIsNewUserOpen(true)}>
                <UserPlus aria-hidden="true" />
                Novo usuário
              </Button>
            )}
            <Button variant="outline" onClick={() => reloadNow()} disabled={refreshing} aria-busy={refreshing}>
              <RefreshCw aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
              Atualizar
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Gestão de Usuários">
          <TabButton
            active={activeTab === 'pending'}
            onClick={() => setActiveTab('pending')}
            icon={<UserCheck size={15} aria-hidden="true" />}
            count={pendingTotal}
          >
            Aprovações
          </TabButton>
          <TabButton active={activeTab === 'users'} onClick={() => setActiveTab('users')} icon={<Users size={15} aria-hidden="true" />}>
            Usuários ({activeUsers.length})
          </TabButton>
          <TabButton
            active={activeTab === 'sessions'}
            onClick={() => setActiveTab('sessions')}
            icon={<Monitor size={15} aria-hidden="true" />}
          >
            Sessões ({sessions.length})
          </TabButton>
        </div>

        {loadState === 'loading' ? (
          <TableSkeleton />
        ) : loadState === 'error' ? (
          <Notice
            tone="error"
            role="alert"
            action={
              <Button size="sm" variant="outline" onClick={() => reloadNow(true)}>
                <RefreshCw aria-hidden="true" />
                Tentar novamente
              </Button>
            }
          >
            Não foi possível carregar os usuários. {loadError}
          </Notice>
        ) : activeTab === 'pending' ? (
          <div className="space-y-6" role="tabpanel">
            {pendingTotal === 0 ? (
              <div className="rounded-[4px] border border-dashed border-border bg-card p-8 text-center">
                <CheckCircle size={32} className="mx-auto mb-2 text-[var(--status-success-fg)]" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">Nenhuma solicitação pendente no momento.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Novos cadastros e pedidos de troca de username ou e-mail aparecem aqui.
                </p>
              </div>
            ) : (
              <>
                {pendingUsers.length > 0 && (
                  <section className="space-y-2">
                    <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground">
                      <UserPlus size={14} aria-hidden="true" />
                      Novos cadastros
                    </h2>
                    <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
                      <table className="w-full text-xs text-foreground">
                        <thead className="border-b border-border bg-muted/60">
                          <tr>
                            <th scope="col" className={TH}>Colaborador</th>
                            <th scope="col" className={TH}>Setor indicado</th>
                            <th scope="col" className={TH}>E-mail</th>
                            <th scope="col" className={TH}>Solicitado em</th>
                            <th scope="col" className={`${TH} text-right`}>Ações</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {pendingUsers.map((u) => (
                            <tr key={u.id} className="hover:bg-muted/40">
                              <td className={`${TD} font-semibold`}>{u.nome}</td>
                              <td className={`${TD} text-muted-foreground`}>{u.setor || '—'}</td>
                              <td className={`${TD} font-mono text-muted-foreground`}>{u.email}</td>
                              <td className={`${TD} text-muted-foreground`}>{u.criado_em ? formatDateTimeBR(u.criado_em) : '—'}</td>
                              <td className={TD}>{signupActions(u)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ul className="space-y-2 md:hidden">
                      {pendingUsers.map((u) => (
                        <li key={u.id} className="space-y-2 rounded-[4px] border border-border bg-card p-3 text-xs">
                          <div className="font-semibold text-foreground">{u.nome}</div>
                          <div className="break-all font-mono text-muted-foreground">{u.email}</div>
                          <div className="text-muted-foreground">
                            {u.setor || '—'} · {u.criado_em ? formatDateTimeBR(u.criado_em) : '—'}
                          </div>
                          {signupActions(u)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {changeRequests.length > 0 && (
                  <section className="space-y-2">
                    <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground">
                      <UserCog size={14} aria-hidden="true" />
                      Alterações de cadastro
                    </h2>
                    <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
                      <table className="w-full text-xs text-foreground">
                        <thead className="border-b border-border bg-muted/60">
                          <tr>
                            <th scope="col" className={TH}>Colaborador</th>
                            <th scope="col" className={TH}>Tipo</th>
                            <th scope="col" className={TH}>Valor atual</th>
                            <th scope="col" className={TH}>Novo valor</th>
                            <th scope="col" className={TH}>Solicitado em</th>
                            <th scope="col" className={`${TH} text-right`}>Ações</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {changeRequests.map((req) => (
                            <tr key={req.id} className="hover:bg-muted/40">
                              <td className={`${TD} font-semibold`}>
                                {req.usuario_nome || users.find((u) => u.id === req.usuario_id)?.nome || `Usuário #${req.usuario_id}`}
                              </td>
                              <td className={TD}>
                                <Badge variant="outline" className="text-[11px]">
                                  {req.tipo === 'username' ? 'Login' : 'E-mail'}
                                </Badge>
                              </td>
                              <td className={`${TD} font-mono text-muted-foreground`}>{req.valor_atual}</td>
                              <td className={`${TD} font-mono font-semibold`}>{req.valor_novo}</td>
                              <td className={`${TD} text-muted-foreground`}>{formatDateTimeBR(req.solicitado_em)}</td>
                              <td className={`${TD} text-right`}>{changeActions(req)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ul className="space-y-2 md:hidden">
                      {changeRequests.map((req) => (
                        <li key={req.id} className="space-y-1.5 rounded-[4px] border border-border bg-card p-3 text-xs">
                          <div className="font-semibold text-foreground">
                            {req.usuario_nome || `Usuário #${req.usuario_id}`} ·{' '}
                            <span className="font-normal text-muted-foreground">{req.tipo === 'username' ? 'Login' : 'E-mail'}</span>
                          </div>
                          <div className="break-all font-mono text-muted-foreground">
                            {req.valor_atual} → <strong className="text-foreground">{req.valor_novo}</strong>
                          </div>
                          {changeActions(req)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        ) : activeTab === 'users' ? (
          <div className="space-y-3" role="tabpanel">
            {noAccessUsers.length > 0 && (
              <Notice
                tone="pending"
                action={
                  !onlyNoAccess ? (
                    <Button size="sm" variant="outline" onClick={() => setOnlyNoAccess(true)}>
                      Ver quem
                    </Button>
                  ) : null
                }
              >
                {noAccessUsers.length} usuário{noAccessUsers.length === 1 ? '' : 's'} sem nenhuma permissão só veem Início e Chat.
              </Notice>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="relative sm:w-72">
                <Search size={14} aria-hidden="true" className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por nome, login ou e-mail"
                  aria-label="Buscar usuários"
                  className="rounded-[4px] pl-8"
                />
              </div>
              <NativeSelect
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as Role | 'all')}
                aria-label="Filtrar por perfil"
                className="[&_select]:rounded-[4px]"
              >
                <NativeSelectOption value="all">Todos os perfis</NativeSelectOption>
                <NativeSelectOption value="admin">Admin</NativeSelectOption>
                <NativeSelectOption value="gestor">Gestor</NativeSelectOption>
                <NativeSelectOption value="user">User</NativeSelectOption>
              </NativeSelect>
              {noAccessUsers.length > 0 && (
                <Button
                  variant={onlyNoAccess ? 'secondary' : 'outline'}
                  aria-pressed={onlyNoAccess}
                  onClick={() => setOnlyNoAccess((v) => !v)}
                >
                  Sem acesso ({noAccessUsers.length})
                </Button>
              )}
            </div>

            {filteredUsers.length === 0 ? (
              <div className="rounded-[4px] border border-dashed border-border bg-card p-8 text-center text-xs text-muted-foreground">
                Nenhum usuário encontrado com esses filtros.
              </div>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
                  <table className="w-full text-xs text-foreground">
                    <thead className="border-b border-border bg-muted/60">
                      <tr>
                        <th scope="col" className={TH}>Usuário</th>
                        <th scope="col" className={TH}>Setor</th>
                        <th scope="col" className={TH}>Perfil</th>
                        <th scope="col" className={TH}>Acesso</th>
                        <th scope="col" className={`${TH} text-right`}>Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {filteredUsers.map((u) => {
                        const policy = policyFor(u);
                        return (
                          <tr key={u.id} className="hover:bg-muted/40">
                            <td className={`${TD} max-w-64`}>{nameCell(u)}</td>
                            <td className={TD}>{setorControl(u, policy)}</td>
                            <td className={TD}>{policy && <RoleSelect target={u} policy={policy} onConfirm={(r) => handleRole(u, r)} />}</td>
                            <td className={TD}>
                              <AccessBadge role={u.role} count={u.permissions_count} />
                            </td>
                            <td className={TD}>{userActions(u, policy)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <ul className="space-y-2 md:hidden">
                  {filteredUsers.map((u) => {
                    const policy = policyFor(u);
                    return (
                      <li key={u.id} className="space-y-2.5 rounded-[4px] border border-border bg-card p-3 text-xs">
                        {nameCell(u)}
                        <div className="flex flex-wrap items-center gap-2">
                          {policy && <RoleSelect target={u} policy={policy} onConfirm={(r) => handleRole(u, r)} />}
                          <AccessBadge role={u.role} count={u.permissions_count} />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Setor:</span>
                          {setorControl(u, policy)}
                        </div>
                        {userActions(u, policy)}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3" role="tabpanel">
            <Notice tone="muted" icon={<Info size={14} aria-hidden="true" />}>
              {isAdmin
                ? 'Colaboradores conectados agora. Você pode encerrar a sessão de qualquer um, exceto a sua.'
                : 'Colaboradores conectados agora. Você pode encerrar a sessão de usuários do perfil User.'}
            </Notice>
            {sessions.length === 0 ? (
              <div className="rounded-[4px] border border-dashed border-border bg-card p-8 text-center">
                <Users size={32} className="mx-auto mb-2 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">Nenhuma sessão ativa encontrada.</p>
              </div>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
                  <table className="w-full text-xs text-foreground">
                    <thead className="border-b border-border bg-muted/60">
                      <tr>
                        <th scope="col" className={TH}>Colaborador</th>
                        <th scope="col" className={TH}>Setor</th>
                        <th scope="col" className={TH}>Endereço IP</th>
                        <th scope="col" className={TH}>Navegador</th>
                        <th scope="col" className={TH}>Última atividade</th>
                        <th scope="col" className={`${TH} text-right`}>Ação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {sessions.map((s) => (
                        <tr key={s.id} className="hover:bg-muted/40">
                          <td className={TD}>
                            <div className="flex items-center gap-2 font-semibold">
                              {s.nome}
                              {s.current && (
                                <Badge variant="outline" className="text-[9px] font-bold">
                                  VOCÊ
                                </Badge>
                              )}
                            </div>
                            <span className="font-mono text-[11px] text-muted-foreground">{s.email}</span>
                          </td>
                          <td className={`${TD} text-muted-foreground`}>{s.setor}</td>
                          <td className={`${TD} font-mono`}>
                            <span className="flex items-center gap-1.5">
                              <Globe size={13} className="text-muted-foreground" aria-hidden="true" />
                              {s.ip_address}
                            </span>
                          </td>
                          <td className={`${TD} max-w-xs truncate text-muted-foreground`} title={s.user_agent}>
                            {s.user_agent}
                          </td>
                          <td className={`${TD} text-muted-foreground`}>
                            <span className="flex items-center gap-1">
                              <Clock size={12} aria-hidden="true" />
                              {formatTimeBR(s.ultimo_acesso)}
                            </span>
                          </td>
                          <td className={`${TD} text-right`}>{sessionAction(s)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="space-y-2 md:hidden">
                  {sessions.map((s) => (
                    <li key={s.id} className="space-y-1.5 rounded-[4px] border border-border bg-card p-3 text-xs">
                      <div className="flex items-center gap-2 font-semibold text-foreground">
                        {s.nome}
                        {s.current && (
                          <Badge variant="outline" className="text-[9px] font-bold">
                            VOCÊ
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground">
                        {s.setor} · <span className="font-mono">{s.ip_address}</span> · {formatTimeBR(s.ultimo_acesso)}
                      </div>
                      <div className="truncate text-muted-foreground">{s.user_agent}</div>
                      <div className="flex justify-end">{sessionAction(s)}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {isNewUserOpen && (
          <NewUserModal
            actor={actor}
            catalog={catalog}
            catalogError={catalogError}
            onRetryCatalog={() => void loadCatalog()}
            onClose={() => setIsNewUserOpen(false)}
            onSubmit={handleCreateUser}
          />
        )}

        {approvingUser && (
          <ApproveUserModal
            targetUser={approvingUser}
            actor={actor}
            catalog={catalog}
            catalogError={catalogError}
            onRetryCatalog={() => void loadCatalog()}
            onClose={() => setApprovingUser(null)}
            onSubmit={handleApprove}
          />
        )}

        {service && (
          <PermissionEditorSheet
            key={editorTarget?.id ?? 'fechado'}
            target={editorTarget}
            actor={actor}
            catalog={catalog}
            catalogError={catalogError}
            onRetryCatalog={() => void loadCatalog()}
            service={service}
            onClose={() => setEditorTarget(null)}
            onSaved={handleSaved}
          />
        )}

        {confirm?.kind === 'delete' && (
          <ConfirmImpactDialog
            open
            title={`Excluir ${confirm.user.nome}?`}
            confirmLabel="Excluir usuário"
            tone="destructive"
            busy={confirmBusy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void runConfirm()}
          >
            <p>
              @{confirm.user.username} · {confirm.user.setor || 'sem setor'} · {ROLE_LABEL[confirm.user.role]} ·{' '}
              {confirm.user.role === 'admin' ? 'acesso total' : formatAccessCount(confirm.user.permissions_count)}.
            </p>
            <p>
              A conta e as permissões são apagadas e as {sessionCountByUser.get(confirm.user.id) ?? 0} sessões ativas são
              encerradas. Os registros no Log de Auditoria continuam. Isso não pode ser desfeito.
            </p>
          </ConfirmImpactDialog>
        )}
        {confirm?.kind === 'reject' && (
          <ConfirmImpactDialog
            open
            title={`Recusar o cadastro de ${confirm.user.nome} (${confirm.user.email})?`}
            confirmLabel="Recusar cadastro"
            tone="destructive"
            busy={confirmBusy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void runConfirm()}
          >
            <p>Não poderá entrar e precisará se cadastrar de novo.</p>
          </ConfirmImpactDialog>
        )}
        {confirm?.kind === 'session' && (
          <ConfirmImpactDialog
            open
            title={`Encerrar a sessão de ${confirm.session.nome}?`}
            confirmLabel="Encerrar sessão"
            tone="destructive"
            busy={confirmBusy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void runConfirm()}
          >
            <p>
              {confirm.session.ip_address} · {confirm.session.user_agent} · ativa desde{' '}
              {formatDateTimeBR(confirm.session.criado_em)}. Precisará entrar de novo.
            </p>
          </ConfirmImpactDialog>
        )}
        {confirm?.kind === 'rejectChange' && (
          <ConfirmImpactDialog
            open
            title={`Recusar a troca de ${confirm.request.tipo === 'username' ? 'login' : 'e-mail'} de ${
              confirm.request.usuario_nome ?? `Usuário #${confirm.request.usuario_id}`
            }?`}
            confirmLabel="Recusar alteração"
            tone="destructive"
            busy={confirmBusy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void runConfirm()}
          >
            <p>
              Continua <strong className="font-mono text-foreground">{confirm.request.valor_atual}</strong>. A pessoa é
              avisada da recusa.
            </p>
          </ConfirmImpactDialog>
        )}
      </div>
    </TooltipProvider>
  );
}
