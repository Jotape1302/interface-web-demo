// RBAC por usuário (abas × ações): espelho de TIPOS de backend/gateway/src/permissions.ts e
// regras puras usadas pelo menu e pelo editor de permissões. O catálogo NÃO é duplicado aqui:
// vem de GET /api/admin/permissions/catalog (no modo demo, de lib/demo-permissions.ts).
// A barreira real é o gateway — o frontend só esconde o que a sessão não pode usar.

export type Role = 'admin' | 'gestor' | 'user';
export const ROLES: readonly Role[] = ['user', 'gestor', 'admin'];

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', gestor: 'Gestor', user: 'User' };

export type PermissionArea = 'financeiro' | 'logistica' | 'marketplace' | 'producao' | 'sistema' | 'usuarios';

export interface PermissionAction {
  /** Id da ação dentro da aba ("ver", "baixar"...). */
  id: string;
  /** Chave completa "<aba>:<acao>". */
  key: string;
  label: string;
  /** Ação de risco: fora do "Marcar tudo" e com confirmação ao conceder. */
  risk?: 'force';
  /** Só pode ser concedida a Gestor (Gestão de Usuários). */
  managerOnly?: boolean;
  /** Texto fixo de ajuda/risco. */
  help?: string;
}

export interface PermissionTab {
  id: string;
  label: string;
  area: PermissionArea;
  /** A primeira ação é sempre "ver". */
  actions: PermissionAction[];
}

export interface PermissionCatalog {
  version: 1;
  areas: Array<{ id: PermissionArea; label: string }>;
  tabs: PermissionTab[];
}

/** Estado das permissões de um usuário (GET/PUT /api/admin/users/:id/permissions). */
export interface PermissionState {
  userId: number;
  grants: string[];
  version: number;
  updatedBy: number | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

export type PermissionStateView = PermissionState & { role: Role; is_root: boolean };

/** Sessão para checar acesso: papel + permissões efetivas (GET /api/auth/me). */
export interface PermissionSession {
  role: Role;
  permissions: readonly string[];
}

export const VIEW_ACTION = 'ver';

export function viewKey(tabId: string): string {
  return `${tabId}:${VIEW_ACTION}`;
}

export function isViewKey(key: string): boolean {
  return key.endsWith(`:${VIEW_ACTION}`);
}

/** A sessão pode usar a chave? Admin tem acesso total implícito; os demais só o concedido. */
export function hasPermission(session: PermissionSession | null | undefined, key: string): boolean {
  if (!session) return false;
  if (session.role === 'admin') return true;
  return session.permissions.includes(key);
}

// ---------------------------------------------------------------------------------------------
// Catálogo → o que aparece no editor
// ---------------------------------------------------------------------------------------------

/** Ações visíveis para o perfil do alvo: Gestão de Usuários só aparece quando o alvo é Gestor. */
export function visibleActions(tab: PermissionTab, targetRole: Role): PermissionAction[] {
  if (targetRole === 'gestor') return tab.actions;
  return tab.actions.filter((a) => !a.managerOnly);
}

/** Abas visíveis para o perfil do alvo, na ordem do catálogo. */
export function visibleTabs(catalog: PermissionCatalog, targetRole: Role, area?: PermissionArea): PermissionTab[] {
  return catalog.tabs.filter((t) => (!area || t.area === area) && visibleActions(t, targetRole).length > 0);
}

/** Áreas com ao menos uma aba visível para o perfil do alvo. */
export function visibleAreas(catalog: PermissionCatalog, targetRole: Role): Array<{ id: PermissionArea; label: string }> {
  return catalog.areas.filter((a) => visibleTabs(catalog, targetRole, a.id).length > 0);
}

/** Todas as chaves visíveis para o perfil, na ordem do catálogo. */
export function visibleKeys(catalog: PermissionCatalog, targetRole: Role): string[] {
  return visibleTabs(catalog, targetRole).flatMap((t) => visibleActions(t, targetRole).map((a) => a.key));
}

function findAction(catalog: PermissionCatalog, key: string): { tab: PermissionTab; action: PermissionAction } | null {
  for (const tab of catalog.tabs) {
    const action = tab.actions.find((a) => a.key === key);
    if (action) return { tab, action };
  }
  return null;
}

/** "Contas a Pagar › Dar baixa no Tiny" ou "Contas a Pagar (ver)". */
export function permissionLabel(catalog: PermissionCatalog | null | undefined, key: string): string {
  const hit = catalog ? findAction(catalog, key) : null;
  if (!hit) return key;
  return hit.action.id === VIEW_ACTION ? `${hit.tab.label} (ver)` : `${hit.tab.label} › ${hit.action.label}`;
}

export function riskActions(catalog: PermissionCatalog): PermissionAction[] {
  return catalog.tabs.flatMap((t) => t.actions.filter((a) => a.risk === 'force'));
}

export function managerOnlyKeys(catalog: PermissionCatalog): string[] {
  return catalog.tabs.flatMap((t) => t.actions.filter((a) => a.managerOnly).map((a) => a.key));
}

/** Mantém só o que o perfil pode ter (User perde Gestão de Usuários) e só chaves do catálogo. */
export function grantsForRole(catalog: PermissionCatalog, grants: Iterable<string>, role: Role): string[] {
  const set = new Set(grants);
  return visibleKeys(catalog, role).filter((k) => set.has(k));
}

// ---------------------------------------------------------------------------------------------
// Edição da matriz (funções puras; o componente só renderiza)
// ---------------------------------------------------------------------------------------------

/**
 * Teto de quem edita: Admin = sem teto (null); Gestor = só o que ele mesmo tem. Item fora do
 * teto fica travado — não pode ser concedido nem revogado.
 */
export type Ceiling = ReadonlySet<string> | null;

export function ceilingFor(actor: PermissionSession): Ceiling {
  return actor.role === 'admin' ? null : new Set(actor.permissions);
}

export function isLocked(key: string, ceiling: Ceiling | undefined): boolean {
  return Boolean(ceiling) && !ceiling!.has(key);
}

/** "Ver" pode ser desmarcado? Não, se ele está travado ou se alguma ação travada está marcada. */
export function canUncheckView(value: ReadonlySet<string>, tab: PermissionTab, ceiling?: Ceiling): boolean {
  if (isLocked(viewKey(tab.id), ceiling)) return false;
  return !tab.actions.some((a) => a.id !== VIEW_ACTION && value.has(a.key) && isLocked(a.key, ceiling));
}

/** Marca/desmarca o "ver" da aba. Desmarcar "ver" desmarca as ações (as editáveis). */
export function toggleView(value: ReadonlySet<string>, tab: PermissionTab, checked: boolean, ceiling?: Ceiling): Set<string> {
  const next = new Set(value);
  const vk = viewKey(tab.id);
  if (isLocked(vk, ceiling)) return next;
  if (checked) {
    next.add(vk);
    return next;
  }
  if (!canUncheckView(value, tab, ceiling)) return next;
  next.delete(vk);
  for (const a of tab.actions) if (!isLocked(a.key, ceiling)) next.delete(a.key);
  return next;
}

/** Marca/desmarca uma ação. Marcar ação marca o "ver"; desmarcar a última ação não mexe no "ver". */
export function toggleAction(
  value: ReadonlySet<string>,
  tab: PermissionTab,
  key: string,
  checked: boolean,
  ceiling?: Ceiling,
): Set<string> {
  const next = new Set(value);
  const vk = viewKey(tab.id);
  if (key === vk) return toggleView(value, tab, checked, ceiling);
  if (isLocked(key, ceiling)) return next;
  if (checked) {
    if (!next.has(vk) && isLocked(vk, ceiling)) return next;
    next.add(key);
    next.add(vk);
  } else {
    next.delete(key);
  }
  return next;
}

/** Chaves que o "Marcar tudo" da área alcança: visíveis, editáveis e sem risco. */
export function bulkKeys(catalog: PermissionCatalog, area: PermissionArea, targetRole: Role, ceiling?: Ceiling): string[] {
  return visibleTabs(catalog, targetRole, area).flatMap((t) =>
    visibleActions(t, targetRole)
      .filter((a) => a.risk !== 'force' && !isLocked(a.key, ceiling))
      .map((a) => a.key),
  );
}

export type BulkState = 'all' | 'some' | 'none';

export interface AreaSummary {
  /** Itens marcados (inclui travados). */
  checked: number;
  /** Itens existentes na área para o perfil (ver + ações). */
  total: number;
  /** Estado do "Marcar tudo" (considera só o que ele alcança). */
  bulk: BulkState;
  /** Há algo que o "Marcar tudo" alcança? */
  bulkEnabled: boolean;
}

export function areaSummary(
  catalog: PermissionCatalog,
  value: ReadonlySet<string>,
  area: PermissionArea,
  targetRole: Role,
  ceiling?: Ceiling,
): AreaSummary {
  const keys = visibleTabs(catalog, targetRole, area).flatMap((t) => visibleActions(t, targetRole).map((a) => a.key));
  const bulk = bulkKeys(catalog, area, targetRole, ceiling);
  const bulkChecked = bulk.filter((k) => value.has(k)).length;
  return {
    checked: keys.filter((k) => value.has(k)).length,
    total: keys.length,
    bulk: bulk.length > 0 && bulkChecked === bulk.length ? 'all' : bulkChecked === 0 ? 'none' : 'some',
    bulkEnabled: bulk.length > 0,
  };
}

/**
 * "Marcar tudo" da área: se tudo que ele alcança já está marcado, desmarca o editável (inclusive
 * risco), preservando o "ver" de abas com ação travada marcada; senão marca tudo menos risco.
 */
export function toggleArea(
  catalog: PermissionCatalog,
  value: ReadonlySet<string>,
  area: PermissionArea,
  targetRole: Role,
  ceiling?: Ceiling,
): Set<string> {
  const next = new Set(value);
  const summary = areaSummary(catalog, value, area, targetRole, ceiling);
  if (!summary.bulkEnabled) return next;
  if (summary.bulk === 'all') {
    for (const tab of visibleTabs(catalog, targetRole, area)) {
      const keepView = !canUncheckView(value, tab, ceiling);
      for (const a of visibleActions(tab, targetRole)) {
        if (isLocked(a.key, ceiling)) continue;
        if (a.id === VIEW_ACTION && keepView) continue;
        next.delete(a.key);
      }
    }
    return next;
  }
  for (const k of bulkKeys(catalog, area, targetRole, ceiling)) next.add(k);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Diferença, contagem, risco
// ---------------------------------------------------------------------------------------------

export function diffGrants(
  catalog: PermissionCatalog,
  before: Iterable<string>,
  after: Iterable<string>,
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  const order = catalog.tabs.flatMap((t) => t.actions.map((x) => x.key));
  return {
    added: order.filter((k) => a.has(k) && !b.has(k)),
    removed: order.filter((k) => b.has(k) && !a.has(k)),
  };
}

/** Ações de risco que passam a ser concedidas. */
export function addedRiskActions(
  catalog: PermissionCatalog,
  before: Iterable<string>,
  after: Iterable<string>,
): PermissionAction[] {
  const { added } = diffGrants(catalog, before, after);
  return riskActions(catalog).filter((a) => added.includes(a.key));
}

/** Contagem "N abas · M ações" de um conjunto de chaves. */
export function countGrants(grants: Iterable<string>): { tabs: number; actions: number } {
  let tabs = 0;
  let actions = 0;
  for (const k of new Set(grants)) {
    if (isViewKey(k)) tabs++;
    else actions++;
  }
  return { tabs, actions };
}

export function formatAccessCount(count: { tabs: number; actions: number }): string {
  const t = `${count.tabs} aba${count.tabs === 1 ? '' : 's'}`;
  const a = `${count.actions} aç${count.actions === 1 ? 'ão' : 'ões'}`;
  return `${t} · ${a}`;
}

/** Selo "Sem acesso": perfil ≠ Admin e nenhuma permissão. */
export function hasNoAccess(role: Role, count: { tabs: number; actions: number }): boolean {
  return role !== 'admin' && count.tabs === 0 && count.actions === 0;
}

/** Áreas abertas por padrão no editor: todas se ≤ 2 têm algo marcado; senão só as com itens. */
export function defaultOpenAreas(
  catalog: PermissionCatalog,
  value: ReadonlySet<string>,
  targetRole: Role,
): PermissionArea[] {
  const areas = visibleAreas(catalog, targetRole).map((a) => a.id);
  const withItems = areas.filter((a) => areaSummary(catalog, value, a, targetRole).checked > 0);
  return withItems.length <= 2 ? areas : withItems;
}

// ---------------------------------------------------------------------------------------------
// Quem pode o quê sobre quem (matriz C.1.1) — o gateway aplica a mesma regra
// ---------------------------------------------------------------------------------------------

export interface PolicyActor extends PermissionSession {
  id: number;
}

export interface PolicyTarget {
  id: number;
  role: Role;
  is_root: boolean;
}

export interface TargetPolicy {
  canChangeRole: boolean;
  /** Motivo de não poder alterar o perfil (tooltip do badge). */
  roleReason: string | null;
  canEditPermissions: boolean;
  /** Motivo do "Somente leitura" no editor (null quando editável ou alvo Admin). */
  permissionsReadOnlyReason: string | null;
  canChangeSetor: boolean;
  canDelete: boolean;
  canForceLogout: boolean;
  canReviewChange: boolean;
}

export const READ_ONLY_REASON = {
  managerTarget: 'só o administrador altera Gestores e Administradores.',
  root: 'o usuário ROOT tem acesso total e não pode ser alterado.',
  self: 'você não pode alterar as próprias permissões.',
} as const;

export function targetPolicy(actor: PolicyActor, target: PolicyTarget): TargetPolicy {
  const none: TargetPolicy = {
    canChangeRole: false,
    roleReason: null,
    canEditPermissions: false,
    permissionsReadOnlyReason: null,
    canChangeSetor: false,
    canDelete: false,
    canForceLogout: false,
    canReviewChange: false,
  };
  const self = actor.id === target.id;
  if (self) {
    return {
      ...none,
      roleReason: 'Você não pode alterar o próprio perfil.',
      permissionsReadOnlyReason: actor.role === 'admin' ? null : READ_ONLY_REASON.self,
      // Admin pode mudar o próprio setor (rótulo de equipe, não dá acesso).
      canChangeSetor: actor.role === 'admin',
      canReviewChange: actor.role === 'admin',
    };
  }
  if (target.is_root) {
    return {
      ...none,
      roleReason: 'O usuário ROOT não pode ter o perfil alterado.',
      permissionsReadOnlyReason: null,
    };
  }
  if (actor.role === 'admin') {
    return {
      canChangeRole: true,
      roleReason: null,
      canEditPermissions: target.role !== 'admin',
      permissionsReadOnlyReason: null,
      canChangeSetor: true,
      canDelete: true,
      canForceLogout: true,
      canReviewChange: true,
    };
  }
  if (actor.role === 'gestor' && target.role === 'user') {
    const can = (k: string) => actor.permissions.includes(k);
    return {
      ...none,
      roleReason: 'Só o administrador altera perfis.',
      canEditPermissions: can('usuarios:editar_permissoes'),
      permissionsReadOnlyReason: can('usuarios:editar_permissoes')
        ? null
        : 'você não tem a ação Editar permissões da Gestão de Usuários.',
      canChangeSetor: can('usuarios:alterar_setor'),
      canDelete: can('usuarios:excluir'),
      canForceLogout: can('usuarios:derrubar_sessao'),
      canReviewChange: can('usuarios:revisar_alteracao'),
    };
  }
  return {
    ...none,
    roleReason: 'Só o administrador altera perfis.',
    permissionsReadOnlyReason: READ_ONLY_REASON.managerTarget,
  };
}

/** Perfis que o ator pode escolher ao criar um usuário (Gestor cria sempre User). */
export function creatableRoles(actor: PermissionSession): Role[] {
  return actor.role === 'admin' ? ['user', 'gestor', 'admin'] : ['user'];
}

// ---------------------------------------------------------------------------------------------
// Novo usuário: validação por campo e mapeamento dos erros do gateway
// ---------------------------------------------------------------------------------------------

export type NewUserField = 'nome' | 'username' | 'email' | 'setor' | 'senha' | 'role' | 'grants';
export const NEW_USER_FIELD_ORDER: readonly NewUserField[] = ['nome', 'username', 'email', 'setor', 'senha', 'role', 'grants'];
export const MIN_PASSWORD_LENGTH = 10;

/** Mesmo critério do gateway (cleanUsername), tirando acento antes para "joão" virar "joao". */
export function cleanUsername(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 100);
}

export interface NewUserForm {
  nome: string;
  username: string;
  email: string;
  setor: string;
  senha: string;
}

export type FieldErrors = Partial<Record<NewUserField, string>>;

export function validateNewUser(form: NewUserForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.nome.trim()) errors.nome = 'Informe o nome completo.';
  if (!cleanUsername(form.username)) errors.username = 'Informe o login (letras, números, ponto ou sublinhado).';
  const email = form.email.trim();
  if (!email) errors.email = 'Informe o e-mail.';
  else if (!/^[^\s@]+@[^\s@]+$/.test(email)) errors.email = 'E-mail inválido.';
  if (!form.setor) errors.setor = 'Escolha o setor.';
  if (form.senha.length < MIN_PASSWORD_LENGTH) errors.senha = `A senha precisa de no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`;
  return errors;
}

/** Primeiro campo com erro, na ordem do formulário (para o foco). */
export function firstInvalidField(errors: FieldErrors): NewUserField | null {
  return NEW_USER_FIELD_ORDER.find((f) => errors[f]) ?? null;
}

const KNOWN_FIELDS = new Set<string>(NEW_USER_FIELD_ORDER);

/** Campo do formulário a que um erro 400/409 do gateway se refere (ou null se é geral). */
export function fieldFromApiError(body: { code?: unknown; field?: unknown; error?: unknown } | null): NewUserField | null {
  if (!body) return null;
  const field = typeof body.field === 'string' ? body.field : '';
  if (field === 'novaSenha') return 'senha';
  if (KNOWN_FIELDS.has(field)) return field as NewUserField;
  if (body.code === 'weak_password') return 'senha';
  if (body.code === 'duplicate') {
    const msg = typeof body.error === 'string' ? body.error.toLowerCase() : '';
    return msg.includes('e-mail') || msg.includes('email') ? 'email' : 'username';
  }
  if (
    body.code === 'invalid_grants' ||
    body.code === 'unknown_permission' ||
    body.code === 'manager_only_permission' ||
    body.code === 'action_requires_view'
  ) {
    return 'grants';
  }
  return null;
}
