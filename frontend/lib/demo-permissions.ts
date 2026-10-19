// Modo demo do RBAC por usuário: catálogo igual ao do gateway (GET /api/admin/permissions/catalog,
// conferido em lib/demo-permissions.test.ts contra backend/gateway/src/permissions.ts), perfis de
// exemplo espelhando seedDemoProfiles (1 Admin ROOT, 1 Gestor, 2 Users com permissões, 2 Users
// sem acesso) e um store em memória que aplica as mesmas regras de alvo/teto do gateway, para a
// tela de Gestão de Usuários funcionar em `npm run dev:mock`. Nada disto roda em produção.

import type {
  AdminApiError,
  AdminChangeRequest,
  AdminResult,
  AdminSession,
  AdminUserView,
  ApprovePayload,
  ApproveResult,
  NewUserPayload,
  RoleChangeResult,
} from './admin-users-contracts';
import {
  MIN_PASSWORD_LENGTH,
  cleanUsername,
  countGrants,
  diffGrants,
  hasPermission,
  managerOnlyKeys,
  permissionLabel,
  viewKey,
  type PermissionAction,
  type PermissionArea,
  type PermissionCatalog,
  type PermissionState,
  type PermissionStateView,
  type PermissionTab,
  type PolicyActor,
  type Role,
} from './permissions';

// ---------------------------------------------------------------------------------------------
// Catálogo (fixture idêntica ao do gateway)
// ---------------------------------------------------------------------------------------------

const AREA_LABELS: Record<PermissionArea, string> = {
  financeiro: 'Financeiro',
  logistica: 'Logística',
  marketplace: 'Marketplace',
  producao: 'Produção',
  sistema: 'Sistema',
  usuarios: 'Gestão de Usuários',
};

type ActionDef = Omit<PermissionAction, 'key'>;
function tab(id: string, label: string, area: PermissionArea, actions: ActionDef[] = []): PermissionTab {
  const managerOnly = area === 'usuarios' ? { managerOnly: true } : {};
  return {
    id,
    label,
    area,
    actions: [{ id: 'ver', label: 'Ver', ...managerOnly }, ...actions.map((a) => ({ ...a, ...managerOnly }))].map((a) => ({
      ...a,
      key: `${id}:${a.id}`,
    })),
  };
}

const FORCE_SEFAZ_HELP =
  'Ignora o intervalo mínimo de consulta da SEFAZ. Uso repetido pode bloquear a consulta da empresa (rejeição 656) por até 1 hora.';
const FORCE_SYNC_HELP = 'Ignora o intervalo entre sincronizações e consome a cota da API do Tiny das 3 empresas.';

export const DEMO_PERMISSION_CATALOG: PermissionCatalog = {
  version: 1,
  areas: (Object.keys(AREA_LABELS) as PermissionArea[]).map((id) => ({ id, label: AREA_LABELS[id] })),
  tabs: [
    tab('fin_visao_geral', 'Visão geral', 'financeiro'),
    tab('contas_pagar', 'Contas a Pagar', 'financeiro', [
      { id: 'importar_extrato', label: 'Importar extrato (prévia)' },
      { id: 'baixar', label: 'Dar baixa no Tiny' },
    ]),
    tab('conciliacao_ml', 'Conciliação ML', 'financeiro', [
      { id: 'executar', label: 'Executar conciliação' },
      { id: 'baixar', label: 'Dar baixa' },
    ]),
    tab('revisao_nfe', 'Revisão NF-e', 'financeiro', [
      { id: 'varrer_sefaz', label: 'Varrer SEFAZ' },
      { id: 'forcar_varredura', label: 'Forçar varredura', risk: 'force', help: FORCE_SEFAZ_HELP },
      { id: 'importar_chave', label: 'Importar por chave' },
      { id: 'arquivar', label: 'Arquivar/restaurar' },
      { id: 'resolver_falha', label: 'Resolver falha' },
      { id: 'lancar', label: 'Confirmar lançamento/lançar em lote' },
    ]),
    tab('dashboard_financeiro', 'Dashboard Financeiro', 'financeiro', [
      { id: 'sincronizar', label: 'Sincronizar' },
      { id: 'forcar_sincronizacao', label: 'Forçar sincronização', risk: 'force', help: FORCE_SYNC_HELP },
    ]),
    tab('log_visao_geral', 'Visão geral', 'logistica'),
    tab('contagem_estoque', 'Contagem de estoque', 'logistica', [
      { id: 'conferir', label: 'Conferir contagem (confirmar/corrigir) e lançar no Tiny' },
      { id: 'informar_sku', label: 'Informar SKU de contagem sem produto' },
      { id: 'excluir', label: 'Excluir contagem da tela' },
    ]),
    tab('mkt_visao_geral', 'Visão geral', 'marketplace'),
    tab('dimensoes', 'Padronização de dimensões', 'marketplace', [
      { id: 'validar', label: 'Validar' },
      { id: 'reenviar', label: 'Reenviar' },
      { id: 'executar', label: 'Executar coleta' },
    ]),
    tab('fretes', 'Fretes a combinar', 'marketplace', [
      { id: 'retentar', label: 'Retentar' },
      { id: 'executar', label: 'Executar verificação' },
    ]),
    tab('prod_visao_geral', 'Visão geral', 'producao'),
    tab('erros', 'Erros & Falhas', 'sistema', [{ id: 'resolver', label: 'Marcar como resolvido' }]),
    tab('saude', 'Saúde do Sistema', 'sistema'),
    tab('auditoria', 'Log de Auditoria', 'sistema'),
    tab('tokens_n8n', 'Tokens n8n', 'sistema', [{ id: 'executar', label: 'Executar renovação' }]),
    tab('usuarios', 'Gestão de Usuários', 'usuarios', [
      { id: 'aprovar_cadastro', label: 'Aprovar cadastro' },
      { id: 'rejeitar_cadastro', label: 'Rejeitar cadastro' },
      { id: 'criar', label: 'Criar usuário (User)' },
      { id: 'editar_permissoes', label: 'Editar permissões' },
      { id: 'alterar_setor', label: 'Alterar setor' },
      { id: 'excluir', label: 'Excluir' },
      { id: 'derrubar_sessao', label: 'Derrubar sessão' },
      { id: 'revisar_alteracao', label: 'Aprovar/rejeitar alteração de cadastro' },
    ]),
  ],
};

const ALL_KEYS: string[] = DEMO_PERMISSION_CATALOG.tabs.flatMap((t) => t.actions.map((a) => a.key));
const MANAGER_ONLY = new Set(managerOnlyKeys(DEMO_PERMISSION_CATALOG));

/** Permissões efetivas (mesma regra do gateway): Admin = catálogo inteiro; User nunca tem Gestão de Usuários. */
export function demoEffectivePermissions(role: Role, grants: readonly string[]): string[] {
  if (role === 'admin') return [...ALL_KEYS];
  const set = new Set(grants);
  return ALL_KEYS.filter((k) => set.has(k) && (role === 'gestor' || !MANAGER_ONLY.has(k)));
}

// ---------------------------------------------------------------------------------------------
// Perfis demo (espelho de DEMO_PROFILES do gateway + cadastros pendentes para a tela)
// ---------------------------------------------------------------------------------------------

export const DEMO_ROOT_USERNAME = 'admin_jp';

export interface DemoProfile {
  id: number;
  username: string;
  nome: string;
  email: string;
  setor: string;
  role: Role;
  status: AdminUserView['status'];
  is_root: boolean;
  grants: string[];
  criado_em: string;
}

const DEMO_PROFILES_BASE: DemoProfile[] = [
  {
    id: 1,
    username: DEMO_ROOT_USERNAME,
    nome: 'Administrador Demo',
    email: 'admin.demo@exemplo.com.br',
    setor: 'T.I',
    role: 'admin',
    status: 'approved',
    is_root: true,
    grants: [],
    criado_em: '2026-08-01T10:00:00Z',
  },
  {
    id: 2,
    username: 'gestora.demo',
    nome: 'Gabriela Gestora (demo)',
    email: 'gestora.demo@demo.norvia.local',
    setor: 'Diretoria',
    role: 'gestor',
    status: 'approved',
    is_root: false,
    grants: [
      'fin_visao_geral:ver',
      'contas_pagar:ver',
      'erros:ver',
      'usuarios:ver',
      'usuarios:aprovar_cadastro',
      'usuarios:rejeitar_cadastro',
      'usuarios:criar',
      'usuarios:editar_permissoes',
      'usuarios:alterar_setor',
      'usuarios:derrubar_sessao',
    ],
    criado_em: '2026-08-05T09:00:00Z',
  },
  {
    id: 3,
    username: 'fin.demo',
    nome: 'Fernanda Financeiro (demo)',
    email: 'fin.demo@demo.norvia.local',
    setor: 'Financeiro',
    role: 'user',
    status: 'approved',
    is_root: false,
    grants: [
      'fin_visao_geral:ver',
      'contas_pagar:ver',
      'contas_pagar:importar_extrato',
      'contas_pagar:baixar',
      'conciliacao_ml:ver',
      'revisao_nfe:ver',
      'revisao_nfe:varrer_sefaz',
      'dashboard_financeiro:ver',
      'dashboard_financeiro:sincronizar',
    ],
    criado_em: '2026-08-10T09:00:00Z',
  },
  {
    id: 4,
    username: 'mkt.demo',
    nome: 'Marcos Marketplace (demo)',
    email: 'mkt.demo@demo.norvia.local',
    setor: 'E-Commerce',
    role: 'user',
    status: 'approved',
    is_root: false,
    grants: ['mkt_visao_geral:ver', 'dimensoes:ver', 'dimensoes:validar', 'fretes:ver', 'fretes:retentar'],
    criado_em: '2026-08-12T09:00:00Z',
  },
  {
    id: 5,
    username: 'log.demo',
    nome: 'Lucas Logística (demo)',
    email: 'log.demo@demo.norvia.local',
    setor: 'Logística',
    role: 'user',
    status: 'approved',
    is_root: false,
    grants: [],
    criado_em: '2026-08-15T09:00:00Z',
  },
  {
    id: 6,
    username: 'sac.demo',
    nome: 'Sara SAC (demo)',
    email: 'sac.demo@demo.norvia.local',
    setor: 'SAC',
    role: 'user',
    status: 'approved',
    is_root: false,
    grants: [],
    criado_em: '2026-08-18T09:00:00Z',
  },
  // Cadastros aguardando aprovação (aba Aprovações).
  {
    id: 7,
    username: 'mariana_c',
    nome: 'Mariana Castro',
    email: 'mariana.castro@norvia.example',
    setor: 'Financeiro',
    role: 'user',
    status: 'pending',
    is_root: false,
    grants: [],
    criado_em: '2026-09-14T09:20:00Z',
  },
  {
    id: 8,
    username: 'user',
    nome: 'Felipe Santos',
    email: 'felipe.santos@norvia.example',
    setor: 'Diretoria',
    role: 'user',
    status: 'pending',
    is_root: false,
    grants: [],
    criado_em: '2026-09-14T08:45:00Z',
  },
];

/** Perfis que dão para entrar no modo demo (tela de login). */
export const DEMO_LOGIN_PROFILES: ReadonlyArray<Pick<DemoProfile, 'username' | 'nome' | 'role'> & { resumo: string }> = [
  { username: DEMO_ROOT_USERNAME, nome: 'Administrador Demo', role: 'admin', resumo: 'Admin ROOT · acesso total' },
  { username: 'gestora.demo', nome: 'Gabriela Gestora (demo)', role: 'gestor', resumo: 'Gestor · parcial + Gestão de Usuários' },
  { username: 'fin.demo', nome: 'Fernanda Financeiro (demo)', role: 'user', resumo: 'User · Financeiro' },
  { username: 'mkt.demo', nome: 'Marcos Marketplace (demo)', role: 'user', resumo: 'User · Marketplace' },
  { username: 'log.demo', nome: 'Lucas Logística (demo)', role: 'user', resumo: 'User · sem acesso' },
  { username: 'sac.demo', nome: 'Sara SAC (demo)', role: 'user', resumo: 'User · sem acesso' },
];

// ---------------------------------------------------------------------------------------------
// Store em memória (por aba; recarregar a página volta ao estado inicial)
// ---------------------------------------------------------------------------------------------

interface DemoUserRecord extends DemoProfile {
  version: number;
  updatedBy: number | null;
  updatedAt: string | null;
}

interface DemoDb {
  users: DemoUserRecord[];
  sessions: AdminSession[];
  changeRequests: Array<Omit<AdminChangeRequest, 'usuario_role' | 'usuario_is_root'>>;
  nextId: number;
}

let db: DemoDb | null = null;

function initialDb(): DemoDb {
  const users: DemoUserRecord[] = DEMO_PROFILES_BASE.map((p) => ({
    ...p,
    grants: [...p.grants],
    version: p.grants.length ? 1 : 0,
    updatedBy: p.grants.length ? 1 : null,
    updatedAt: p.grants.length ? '2026-10-01T12:00:00Z' : null,
  }));
  const session = (n: number, u: DemoUserRecord, ip: string, ua: string): AdminSession => ({
    id: n.toString(16).padStart(24, 'a'),
    usuario_id: u.id,
    nome: u.nome,
    email: u.email,
    username: u.username,
    setor: u.setor,
    role: u.role,
    ip_address: ip,
    user_agent: ua,
    ultimo_acesso: '2026-10-08T11:20:00Z',
    criado_em: '2026-10-08T08:00:00Z',
    is_root: u.is_root,
    current: false,
  });
  const byName = (username: string) => users.find((u) => u.username === username)!;
  return {
    users,
    sessions: [
      session(1, byName(DEMO_ROOT_USERNAME), '192.168.1.45', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0'),
      session(2, byName('gestora.demo'), '192.168.1.60', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edge/128.0'),
      session(3, byName('fin.demo'), '192.168.1.82', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Firefox/130.0'),
      session(4, byName('mkt.demo'), '192.168.1.109', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'),
    ],
    changeRequests: [
      {
        id: 901,
        usuario_id: byName('fin.demo').id,
        tipo: 'email',
        valor_atual: 'fin.demo@demo.norvia.local',
        valor_novo: 'fernanda.financeiro@norvia.example',
        status: 'pending',
        solicitado_em: '2026-10-08T09:00:00Z',
        usuario_nome: byName('fin.demo').nome,
      },
      {
        id: 902,
        usuario_id: byName('gestora.demo').id,
        tipo: 'username',
        valor_atual: 'gestora.demo',
        valor_novo: 'gabriela.gestora',
        status: 'pending',
        solicitado_em: '2026-10-08T10:30:00Z',
        usuario_nome: byName('gestora.demo').nome,
      },
    ],
    nextId: 100,
  };
}

function store(): DemoDb {
  if (!db) db = initialDb();
  return db;
}

/** Volta o store ao estado inicial (testes). */
export function resetDemoAdminStore(): void {
  db = null;
}

/** Sessão demo do perfil (usuário + permissões efetivas), lida do store. */
export function demoSessionFor(username: string): { user: DemoProfile; permissions: string[] } | null {
  const u = store().users.find((x) => x.username === username && x.status === 'approved');
  if (!u) return null;
  const { version: _v, updatedBy: _b, updatedAt: _a, ...profile } = u;
  return { user: { ...profile, grants: [...u.grants] }, permissions: demoEffectivePermissions(u.role, u.grants) };
}

// ---------------------------------------------------------------------------------------------
// Operações (mesmas regras de backend/gateway/src/routes/admin.ts)
// ---------------------------------------------------------------------------------------------

function fail<T>(status: number, message: string, extra: Partial<AdminApiError> = {}): AdminResult<T> {
  return {
    ok: false,
    error: { status, message, code: null, field: null, items: [], labels: [], current: null, ...extra },
  };
}

const ok = <T>(data: T): AdminResult<T> => ({ ok: true, data });

function stateOf(u: DemoUserRecord): PermissionState {
  const by = u.updatedBy !== null ? store().users.find((x) => x.id === u.updatedBy) : undefined;
  return {
    userId: u.id,
    grants: u.role === 'admin' ? [] : demoEffectivePermissions(u.role, u.grants),
    version: u.version,
    updatedBy: u.updatedBy,
    updatedByName: by?.nome ?? null,
    updatedAt: u.updatedAt,
  };
}

function view(u: DemoUserRecord): AdminUserView {
  const s = stateOf(u);
  return {
    id: u.id,
    username: u.username,
    nome: u.nome,
    email: u.email,
    setor: u.setor,
    role: u.role,
    status: u.status,
    criado_em: u.criado_em,
    permissoes: s.grants,
    is_root: u.is_root,
    version: u.version,
    permissions_count: countGrants(demoEffectivePermissions(u.role, u.grants)),
    permissions_updated_by: u.updatedBy,
    permissions_updated_by_name: s.updatedByName,
    permissions_updated_at: u.updatedAt,
  };
}

function requirePerm<T>(actor: PolicyActor, key: string): AdminResult<T> | null {
  return hasPermission(actor, key) ? null : fail(403, 'Seu usuário não tem permissão para este recurso.', { code: 'forbidden' });
}

function findUser<T>(id: number): DemoUserRecord | AdminResult<T> {
  const u = store().users.find((x) => x.id === id);
  return u ?? fail(404, 'Usuário não encontrado.', { code: 'not_found' });
}

/** `selfMessage` null = pode agir sobre si mesmo; senão, a mensagem do 403 self_change. */
function guardTarget<T>(actor: PolicyActor, target: DemoUserRecord, selfMessage: string | null): AdminResult<T> | null {
  const isSelf = target.id === actor.id;
  if (isSelf && selfMessage !== null) return fail(403, selfMessage, { code: 'self_change' });
  if (!isSelf && target.is_root) {
    return fail(403, 'O usuário ROOT tem acesso total e não pode ser alterado.', { code: 'root_protected' });
  }
  if (actor.role !== 'admin' && target.role !== 'user') {
    return fail(403, 'Só o administrador altera Gestores e Administradores.', { code: 'target_forbidden' });
  }
  return null;
}

function guardCeiling<T>(actor: PolicyActor, touched: readonly string[]): AdminResult<T> | null {
  if (actor.role === 'admin') return null;
  const own = new Set(actor.permissions);
  const items = [...new Set(touched)].filter((k) => ALL_KEYS.includes(k) && !own.has(k));
  if (!items.length) return null;
  const labels = items.map((k) => permissionLabel(DEMO_PERMISSION_CATALOG, k));
  return fail(403, `Você tentou conceder ou revogar algo fora das suas permissões: ${labels.join(', ')}. Peça ao administrador.`, {
    code: 'outside_ceiling',
    items,
    labels,
  });
}

function validateGrants<T>(raw: readonly string[], role: Role): { grants: string[] } | AdminResult<T> {
  const unknown = raw.filter((k) => !ALL_KEYS.includes(k));
  if (unknown.length) return fail(400, 'Permissão fora do catálogo.', { code: 'unknown_permission', field: 'grants', items: unknown });
  const set = new Set(raw);
  const grants = ALL_KEYS.filter((k) => set.has(k));
  if (role !== 'gestor') {
    const mo = grants.filter((k) => MANAGER_ONLY.has(k));
    if (mo.length) {
      return fail(400, 'As ações da Gestão de Usuários só podem ser dadas a Gestores.', {
        code: 'manager_only_permission',
        field: 'grants',
        items: mo,
      });
    }
  }
  const orphan = grants.filter((k) => !k.endsWith(':ver') && !set.has(viewKey(k.split(':')[0])));
  if (orphan.length) return fail(400, 'Ação sem o acesso de ver a aba.', { code: 'action_requires_view', field: 'grants', items: orphan });
  return { grants };
}

function bump(u: DemoUserRecord, grants: string[], actor: PolicyActor) {
  u.grants = grants;
  u.version += 1;
  u.updatedBy = actor.id;
  u.updatedAt = new Date().toISOString();
}

export const demoAdminStore = {
  catalog(): PermissionCatalog {
    return structuredClone(DEMO_PERMISSION_CATALOG);
  },

  listUsers(actor: PolicyActor): AdminResult<AdminUserView[]> {
    return requirePerm<AdminUserView[]>(actor, 'usuarios:ver') ?? ok(store().users.map(view));
  },

  getPermissions(actor: PolicyActor, id: number): AdminResult<PermissionStateView> {
    const denied = requirePerm<PermissionStateView>(actor, 'usuarios:ver');
    if (denied) return denied;
    const u = findUser<PermissionStateView>(id);
    if ('ok' in u) return u;
    return ok({ ...stateOf(u), role: u.role, is_root: u.is_root });
  },

  putPermissions(actor: PolicyActor, id: number, grants: string[], expectedVersion: number): AdminResult<PermissionStateView> {
    const denied = requirePerm<PermissionStateView>(actor, 'usuarios:editar_permissoes');
    if (denied) return denied;
    const u = findUser<PermissionStateView>(id);
    if ('ok' in u) return u;
    const g = guardTarget<PermissionStateView>(actor, u, 'Você não pode alterar as próprias permissões.');
    if (g) return g;
    if (u.role === 'admin') {
      return fail(400, 'Administradores têm acesso total; altere o perfil para limitar.', { code: 'target_is_admin', field: 'grants' });
    }
    const v = validateGrants<PermissionStateView>(grants, u.role);
    if ('ok' in v) return v;
    const { added, removed } = diffGrants(DEMO_PERMISSION_CATALOG, u.grants, v.grants);
    const c = guardCeiling<PermissionStateView>(actor, [...added, ...removed]);
    if (c) return c;
    if (expectedVersion !== u.version) {
      const s = stateOf(u);
      return fail(409, 'As permissões foram alteradas por outra pessoa.', {
        code: 'version_conflict',
        current: { updatedByName: s.updatedByName, updatedAt: s.updatedAt, version: s.version },
      });
    }
    bump(u, v.grants, actor);
    return ok({ ...stateOf(u), role: u.role, is_root: u.is_root });
  },

  putRole(actor: PolicyActor, id: number, role: Role): AdminResult<RoleChangeResult> {
    if (actor.role !== 'admin') return fail(403, 'Só o administrador altera perfis.', { code: 'forbidden' });
    const u = findUser<RoleChangeResult>(id);
    if ('ok' in u) return u;
    if (u.id === actor.id) return fail(403, 'Você não pode alterar o próprio perfil.', { code: 'self_change' });
    if (u.is_root) return fail(403, 'O usuário ROOT não pode ter o perfil alterado.', { code: 'root_protected' });
    if (u.role === 'admin' && role !== 'admin' && store().users.filter((x) => x.role === 'admin' && x.status === 'approved').length <= 1) {
      return fail(409, 'Não é possível: o sistema precisa de pelo menos um administrador.', { code: 'last_admin' });
    }
    const previousRole = u.role;
    u.role = role;
    if (previousRole === 'admin' && role !== 'admin') bump(u, [], actor);
    else if (previousRole === 'gestor' && role === 'user') bump(u, u.grants.filter((k) => !MANAGER_ONLY.has(k)), actor);
    for (const s of store().sessions) if (s.usuario_id === u.id) s.role = role;
    return ok({ success: true, previousRole, role, permissions: stateOf(u) });
  },

  putSetor(actor: PolicyActor, id: number, setor: string): AdminResult<{ success: boolean }> {
    const denied = requirePerm<{ success: boolean }>(actor, 'usuarios:alterar_setor');
    if (denied) return denied;
    const u = findUser<{ success: boolean }>(id);
    if ('ok' in u) return u;
    const g = guardTarget<{ success: boolean }>(actor, u, null);
    if (g) return g;
    if (!setor.trim()) return fail(400, 'Setor é obrigatório.', { code: 'validation', field: 'setor' });
    u.setor = setor.trim();
    for (const s of store().sessions) if (s.usuario_id === u.id) s.setor = u.setor;
    return ok({ success: true });
  },

  deleteUser(actor: PolicyActor, id: number): AdminResult<{ success: boolean }> {
    const denied = requirePerm<{ success: boolean }>(actor, 'usuarios:excluir');
    if (denied) return denied;
    const u = findUser<{ success: boolean }>(id);
    if ('ok' in u) return u;
    const g = guardTarget<{ success: boolean }>(actor, u, 'Você não pode excluir o próprio usuário.');
    if (g) return g;
    const d = store();
    d.users = d.users.filter((x) => x.id !== id);
    d.sessions = d.sessions.filter((s) => s.usuario_id !== id);
    d.changeRequests = d.changeRequests.filter((c) => c.usuario_id !== id);
    return ok({ success: true });
  },

  createUser(actor: PolicyActor, payload: NewUserPayload): AdminResult<AdminUserView> {
    const denied = requirePerm<AdminUserView>(actor, 'usuarios:criar');
    if (denied) return denied;
    if (actor.role !== 'admin' && payload.role !== 'user') {
      return fail(403, 'Gestores só criam usuários do perfil User.', { code: 'role_forbidden', field: 'role' });
    }
    if (!payload.nome.trim()) return fail(400, 'Nome é obrigatório.', { code: 'validation', field: 'nome' });
    const email = payload.email.trim().toLowerCase();
    if (!email) return fail(400, 'E-mail é obrigatório.', { code: 'validation', field: 'email' });
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return fail(400, 'E-mail inválido.', { code: 'validation', field: 'email' });
    if (!payload.setor.trim()) return fail(400, 'Setor é obrigatório.', { code: 'validation', field: 'setor' });
    if (payload.senha.length < MIN_PASSWORD_LENGTH) {
      return fail(400, `A senha deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`, { code: 'weak_password', field: 'senha' });
    }
    const username = cleanUsername(payload.username) || cleanUsername(email.split('@')[0] ?? '') || 'user';
    const d = store();
    if (d.users.some((u) => u.username === username)) {
      return fail(400, `O nome de usuário "${username}" já está cadastrado.`, { code: 'duplicate', field: 'username' });
    }
    if (d.users.some((u) => u.email === email)) {
      return fail(400, 'Este e-mail já está cadastrado.', { code: 'duplicate', field: 'email' });
    }
    const v = validateGrants<AdminUserView>(payload.role === 'admin' ? [] : payload.grants, payload.role);
    if ('ok' in v) return v;
    const c = guardCeiling<AdminUserView>(actor, v.grants);
    if (c) return c;
    const record: DemoUserRecord = {
      id: d.nextId++,
      username,
      nome: payload.nome.trim(),
      email,
      setor: payload.setor.trim(),
      role: payload.role,
      status: 'approved',
      is_root: false,
      grants: v.grants,
      criado_em: new Date().toISOString(),
      version: 1,
      updatedBy: actor.id,
      updatedAt: new Date().toISOString(),
    };
    d.users.push(record);
    return ok(view(record));
  },

  approve(actor: PolicyActor, id: number, payload: ApprovePayload): AdminResult<ApproveResult> {
    const denied = requirePerm<ApproveResult>(actor, 'usuarios:aprovar_cadastro');
    if (denied) return denied;
    const u = findUser<ApproveResult>(id);
    if ('ok' in u) return u;
    const g = guardTarget<ApproveResult>(actor, u, 'Você não pode aprovar o próprio cadastro.');
    if (g) return g;
    if (!payload.setor.trim()) return fail(400, 'Escolha o setor.', { code: 'validation', field: 'setor' });
    const username = cleanUsername(payload.username);
    if (!username) return fail(400, 'Informe o login.', { code: 'validation', field: 'username' });
    if (store().users.some((x) => x.username === username && x.id !== id)) {
      return fail(400, `O nome de usuário "${username}" já está cadastrado.`, { code: 'duplicate', field: 'username' });
    }
    const v = validateGrants<ApproveResult>(payload.grants, u.role);
    if ('ok' in v) return v;
    const c = guardCeiling<ApproveResult>(actor, v.grants);
    if (c) return c;
    u.status = 'approved';
    u.username = username;
    u.setor = payload.setor.trim();
    bump(u, v.grants, actor);
    return ok({ success: true, setor: u.setor, grants: v.grants, permissionsSaved: true });
  },

  reject(actor: PolicyActor, id: number): AdminResult<{ success: boolean }> {
    const denied = requirePerm<{ success: boolean }>(actor, 'usuarios:rejeitar_cadastro');
    if (denied) return denied;
    const u = findUser<{ success: boolean }>(id);
    if ('ok' in u) return u;
    const g = guardTarget<{ success: boolean }>(actor, u, 'Você não pode recusar o próprio cadastro.');
    if (g) return g;
    u.status = 'rejected';
    return ok({ success: true });
  },

  listSessions(actor: PolicyActor): AdminResult<AdminSession[]> {
    const denied = requirePerm<AdminSession[]>(actor, 'usuarios:ver');
    if (denied) return denied;
    const visible = actor.role === 'admin'
      ? store().sessions
      : store().sessions.filter((s) => s.role === 'user' || s.usuario_id === actor.id);
    return ok(visible.map((s) => ({ ...s, current: s.usuario_id === actor.id })));
  },

  forceLogout(actor: PolicyActor, sessionId: string): AdminResult<{ success: boolean }> {
    const denied = requirePerm<{ success: boolean }>(actor, 'usuarios:derrubar_sessao');
    if (denied) return denied;
    const s = store().sessions.find((x) => x.id === sessionId);
    if (!s) return fail(404, 'Sessão não encontrada ou já encerrada.', { code: 'not_found' });
    const u = findUser<{ success: boolean }>(s.usuario_id);
    if ('ok' in u) return u;
    const g = guardTarget<{ success: boolean }>(actor, u, 'Você não pode encerrar a própria sessão por aqui. Use Sair.');
    if (g) return g;
    store().sessions = store().sessions.filter((x) => x.id !== sessionId);
    return ok({ success: true });
  },

  listChangeRequests(actor: PolicyActor): AdminResult<AdminChangeRequest[]> {
    const denied = requirePerm<AdminChangeRequest[]>(actor, 'usuarios:ver');
    if (denied) return denied;
    const users = store().users;
    return ok(
      store()
        .changeRequests.filter((c) => c.status === 'pending')
        .map((c) => {
          const u = users.find((x) => x.id === c.usuario_id);
          return { ...c, usuario_role: u?.role ?? null, usuario_is_root: Boolean(u?.is_root) };
        }),
    );
  },

  reviewChangeRequest(actor: PolicyActor, requestId: number, approve: boolean): AdminResult<{ success: boolean }> {
    const denied = requirePerm<{ success: boolean }>(actor, 'usuarios:revisar_alteracao');
    if (denied) return denied;
    const req = store().changeRequests.find((c) => c.id === requestId && c.status === 'pending');
    if (!req) return fail(404, 'Solicitação não encontrada ou já processada', { code: 'not_found' });
    const u = findUser<{ success: boolean }>(req.usuario_id);
    if ('ok' in u) return u;
    const g = guardTarget<{ success: boolean }>(actor, u, null);
    if (g) return g;
    req.status = approve ? 'approved' : 'rejected';
    if (approve) {
      if (req.tipo === 'username') u.username = req.valor_novo;
      else u.email = req.valor_novo;
    }
    return ok({ success: true });
  },

  pendingCount(actor: PolicyActor): number {
    if (!hasPermission(actor, 'usuarios:ver')) return 0;
    const d = store();
    const signups = d.users.filter((u) => u.status === 'pending').length;
    const changes = d.changeRequests.filter(
      (c) => c.status === 'pending' && (actor.role === 'admin' || d.users.find((u) => u.id === c.usuario_id)?.role === 'user'),
    ).length;
    return signups + changes;
  },
};
