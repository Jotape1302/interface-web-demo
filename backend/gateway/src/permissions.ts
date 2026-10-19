// RBAC por usuário: catálogo de abas × ações, regra de acesso por rota e checagem de permissão.
// Fonte da verdade do acesso. O editor do painel lê o catálogo em GET /api/admin/permissions/catalog;
// o espelho de tipos do frontend fica em frontend/lib/permissions.ts.
//
// Chave de permissão = "<aba>:<acao>" (ex.: "contas_pagar:baixar"). "ver" é a ação de abrir a aba.
// Toda chave tem ":" — é isso que separa as chaves novas das linhas legadas de usuario_permissoes
// ("overview", "accounts_payable"…), que ficam inertes até a parte 2 da migração apagá-las.

import type { Role } from "./auth.js";

export type PermissionArea = "financeiro" | "logistica" | "marketplace" | "producao" | "sistema" | "usuarios";

export interface PermissionAction {
  /** Id da ação dentro da aba ("ver", "baixar"...). A chave é `${tab.id}:${action.id}`. */
  id: string;
  /** Chave completa gravada em usuario_permissoes. */
  key: string;
  label: string;
  /** Ação de risco: nunca entra no "Marcar tudo" e pede confirmação ao conceder. */
  risk?: "force";
  /** Só pode ser concedida a Gestor (ações da Gestão de Usuários). */
  managerOnly?: boolean;
  /** Texto fixo de ajuda/risco para o editor. */
  help?: string;
}

export interface PermissionTab {
  id: string;
  label: string;
  area: PermissionArea;
  /** Toda aba tem "ver" como primeira ação. */
  actions: PermissionAction[];
}

export interface PermissionCatalog {
  /** Versão do formato do catálogo (muda só se o formato da resposta mudar). */
  version: 1;
  areas: Array<{ id: PermissionArea; label: string }>;
  tabs: PermissionTab[];
}

const AREA_LABELS: Record<PermissionArea, string> = {
  financeiro: "Financeiro",
  logistica: "Logística",
  marketplace: "Marketplace",
  producao: "Produção",
  sistema: "Sistema",
  usuarios: "Gestão de Usuários",
};

type ActionDef = Omit<PermissionAction, "key">;
function tab(id: string, label: string, area: PermissionArea, actions: ActionDef[] = []): PermissionTab {
  const managerOnly = area === "usuarios" ? { managerOnly: true } : {};
  return {
    id,
    label,
    area,
    actions: [{ id: "ver", label: "Ver", ...managerOnly }, ...actions.map((a) => ({ ...a, ...managerOnly }))].map((a) => ({
      ...a,
      key: `${id}:${a.id}`,
    })),
  };
}

const FORCE_SEFAZ_HELP =
  "Ignora o intervalo mínimo de consulta da SEFAZ. Uso repetido pode bloquear a consulta da empresa (rejeição 656) por até 1 hora.";
const FORCE_SYNC_HELP = "Ignora o intervalo entre sincronizações e consome a cota da API do Tiny das 3 empresas.";

const TABS: PermissionTab[] = [
  // Financeiro
  tab("fin_visao_geral", "Visão geral", "financeiro"),
  tab("contas_pagar", "Contas a Pagar", "financeiro", [
    { id: "importar_extrato", label: "Importar extrato (prévia)" },
    { id: "baixar", label: "Dar baixa no Tiny" },
  ]),
  tab("conciliacao_ml", "Conciliação ML", "financeiro", [
    { id: "executar", label: "Executar conciliação" },
    { id: "baixar", label: "Dar baixa" },
  ]),
  tab("revisao_nfe", "Revisão NF-e", "financeiro", [
    { id: "varrer_sefaz", label: "Varrer SEFAZ" },
    { id: "forcar_varredura", label: "Forçar varredura", risk: "force", help: FORCE_SEFAZ_HELP },
    { id: "importar_chave", label: "Importar por chave" },
    { id: "arquivar", label: "Arquivar/restaurar" },
    { id: "resolver_falha", label: "Resolver falha" },
    { id: "lancar", label: "Confirmar lançamento/lançar em lote" },
  ]),
  tab("dashboard_financeiro", "Dashboard Financeiro", "financeiro", [
    { id: "sincronizar", label: "Sincronizar" },
    { id: "forcar_sincronizacao", label: "Forçar sincronização", risk: "force", help: FORCE_SYNC_HELP },
  ]),
  // Logística
  tab("log_visao_geral", "Visão geral", "logistica"),
  tab("contagem_estoque", "Contagem de estoque", "logistica", [
    { id: "conferir", label: "Conferir contagem (confirmar/corrigir) e lançar no Tiny" },
    { id: "informar_sku", label: "Informar SKU de contagem sem produto" },
    { id: "excluir", label: "Excluir contagem da tela" },
  ]),
  // Marketplace
  tab("mkt_visao_geral", "Visão geral", "marketplace"),
  tab("dimensoes", "Padronização de dimensões", "marketplace", [
    { id: "validar", label: "Validar" },
    { id: "reenviar", label: "Reenviar" },
    { id: "executar", label: "Executar coleta" },
  ]),
  tab("fretes", "Fretes a combinar", "marketplace", [
    { id: "retentar", label: "Retentar" },
    { id: "executar", label: "Executar verificação" },
  ]),
  // Produção
  tab("prod_visao_geral", "Visão geral", "producao"),
  // Sistema
  tab("erros", "Erros & Falhas", "sistema", [{ id: "resolver", label: "Marcar como resolvido" }]),
  tab("saude", "Saúde do Sistema", "sistema"),
  tab("auditoria", "Log de Auditoria", "sistema"),
  tab("tokens_n8n", "Tokens n8n", "sistema", [{ id: "executar", label: "Executar renovação" }]),
  // Gestão de Usuários (só Gestor; sempre sobre usuários do perfil User)
  tab("usuarios", "Gestão de Usuários", "usuarios", [
    { id: "aprovar_cadastro", label: "Aprovar cadastro" },
    { id: "rejeitar_cadastro", label: "Rejeitar cadastro" },
    { id: "criar", label: "Criar usuário (User)" },
    { id: "editar_permissoes", label: "Editar permissões" },
    { id: "alterar_setor", label: "Alterar setor" },
    { id: "excluir", label: "Excluir" },
    { id: "derrubar_sessao", label: "Derrubar sessão" },
    { id: "revisar_alteracao", label: "Aprovar/rejeitar alteração de cadastro" },
  ]),
];

export const PERMISSION_CATALOG: PermissionCatalog = deepFreeze({
  version: 1,
  areas: (Object.keys(AREA_LABELS) as PermissionArea[]).map((id) => ({ id, label: AREA_LABELS[id] })),
  tabs: TABS,
});

const ACTION_BY_KEY = new Map<string, { tab: PermissionTab; action: PermissionAction }>();
for (const t of PERMISSION_CATALOG.tabs) for (const a of t.actions) ACTION_BY_KEY.set(a.key, { tab: t, action: a });

/** Todas as chaves do catálogo, na ordem do catálogo. */
export const ALL_PERMISSION_KEYS: readonly string[] = Object.freeze([...ACTION_BY_KEY.keys()]);
/** Chaves que só podem ser gravadas em Gestor (Gestão de Usuários). */
export const MANAGER_ONLY_KEYS: readonly string[] = Object.freeze(
  ALL_PERMISSION_KEYS.filter((k) => ACTION_BY_KEY.get(k)!.action.managerOnly),
);

/** Formato da chave: "<aba>:<acao>", minúsculas, ≤ 100 caracteres (tamanho de usuario_permissoes.recurso). */
export const PERMISSION_KEY_RE = /^[a-z][a-z0-9_]{0,48}:[a-z][a-z0-9_]{0,48}$/;

export function isCatalogKey(key: string): boolean {
  return ACTION_BY_KEY.has(key);
}
export function isManagerOnlyKey(key: string): boolean {
  return Boolean(ACTION_BY_KEY.get(key)?.action.managerOnly);
}
/** "Aba › Ação" para mensagens e auditoria (ex.: "Contas a Pagar › Dar baixa no Tiny"). */
export function permissionLabel(key: string): string {
  const hit = ACTION_BY_KEY.get(key);
  if (!hit) return key;
  return hit.action.id === "ver" ? `${hit.tab.label} (ver)` : `${hit.tab.label} › ${hit.action.label}`;
}
/** Área da aba da chave (ou null se a chave não é do catálogo). */
export function areaOfKey(key: string): PermissionArea | null {
  return ACTION_BY_KEY.get(key)?.tab.area ?? null;
}
export function viewKeyOf(key: string): string {
  return `${key.split(":")[0]}:ver`;
}
export function tabIdsOfArea(area: PermissionArea): string[] {
  return PERMISSION_CATALOG.tabs.filter((t) => t.area === area).map((t) => t.id);
}

/** Só as chaves do catálogo, sem duplicatas, na ordem do catálogo (descarta linhas legadas). */
export function catalogOnly(grants: readonly string[]): string[] {
  const set = new Set(grants);
  return ALL_PERMISSION_KEYS.filter((k) => set.has(k));
}

/**
 * Permissões efetivas de um perfil: admin = catálogo inteiro (acesso total implícito);
 * user nunca tem chave de Gestão de Usuários, mesmo que haja linha gravada (defesa em profundidade).
 */
export function effectivePermissions(role: Role | string, grants: readonly string[]): string[] {
  if (role === "admin") return [...ALL_PERMISSION_KEYS];
  const clean = catalogOnly(grants);
  return role === "gestor" ? clean : clean.filter((k) => !isManagerOnlyKey(k));
}

/** Contagem para a coluna "Acesso" (só chaves do catálogo). Admin = catálogo inteiro. */
export function countPermissions(role: Role | string, grants: readonly string[]): { tabs: number; actions: number } {
  const eff = effectivePermissions(role, grants);
  const tabs = eff.filter((k) => k.endsWith(":ver")).length;
  return { tabs, actions: eff.length - tabs };
}

/**
 * Negado por padrão: admin passa sempre; os demais só com a chave concedida (permitido = TRUE).
 * Ausência de linha = negado.
 */
export function hasPermission(session: { user: { role: string }; permissions?: readonly string[] }, key: string): boolean {
  if (session.user.role === "admin") return true;
  if (!isCatalogKey(key)) return false;
  if (session.user.role !== "gestor" && isManagerOnlyKey(key)) return false;
  return (session.permissions ?? []).includes(key);
}

/** Usuário (lista de usuários) com acesso a alguma aba da área — menu e notificações por área. */
export function canSeeArea(user: { role: string; permissoes?: readonly string[] }, area: PermissionArea): boolean {
  if (user.role === "admin") return true;
  const eff = effectivePermissions(user.role, user.permissoes ?? []);
  return tabIdsOfArea(area).some((t) => eff.includes(`${t}:ver`));
}

/** Usuário (lista de usuários, com `permissoes`) tem a chave? Usado para escolher destinatários de avisos. */
export function userHasPermission(user: { role: string; permissoes?: readonly string[] }, key: string): boolean {
  return hasPermission({ user, permissions: effectivePermissions(user.role, user.permissoes ?? []) }, key);
}

// ---------------------------------------------------------------------------------------------
// Validação de um conjunto de permissões a gravar
// ---------------------------------------------------------------------------------------------

export type GrantsValidation =
  | { ok: true; grants: string[] }
  | { ok: false; code: "invalid_grants" | "unknown_permission" | "manager_only_permission" | "action_requires_view"; items: string[] };

/**
 * Valida o conjunto que vai substituir as permissões de um usuário do perfil `targetRole`:
 * array de strings, só chaves do catálogo, sem chave de Gestão de Usuários fora de Gestor e
 * toda ação acompanhada do "ver" da aba. Devolve o conjunto normalizado (ordem do catálogo).
 */
export function validateGrants(raw: unknown, targetRole: Role): GrantsValidation {
  if (!Array.isArray(raw) || raw.length > ALL_PERMISSION_KEYS.length * 2 || raw.some((k) => typeof k !== "string")) {
    return { ok: false, code: "invalid_grants", items: [] };
  }
  const keys = raw as string[];
  const unknown = keys.filter((k) => !PERMISSION_KEY_RE.test(k) || !isCatalogKey(k));
  if (unknown.length) return { ok: false, code: "unknown_permission", items: [...new Set(unknown)].map((k) => k.slice(0, 100)) };
  const grants = catalogOnly(keys);
  if (targetRole !== "gestor") {
    const mo = grants.filter(isManagerOnlyKey);
    if (mo.length) return { ok: false, code: "manager_only_permission", items: mo };
  }
  const orphan = grants.filter((k) => !k.endsWith(":ver") && !grants.includes(viewKeyOf(k)));
  if (orphan.length) return { ok: false, code: "action_requires_view", items: orphan };
  return { ok: true, grants };
}

/** Diferença entre dois conjuntos (só catálogo). */
export function diffGrants(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const b = new Set(catalogOnly(before));
  const a = new Set(catalogOnly(after));
  return {
    added: ALL_PERMISSION_KEYS.filter((k) => a.has(k) && !b.has(k)),
    removed: ALL_PERMISSION_KEYS.filter((k) => b.has(k) && !a.has(k)),
  };
}

// ---------------------------------------------------------------------------------------------
// Regra de acesso por rota (rota + método → aba/ação). Negar por padrão: o servidor recusa
// qualquer /api/* que não esteja aqui (test/permissions-coverage.test.ts falha se surgir rota
// sem mapeamento).
// ---------------------------------------------------------------------------------------------

export type RouteAccess =
  /** Sem sessão (login, cadastro, health mínimo). */
  | { kind: "public" }
  /** Qualquer usuário logado, fora do catálogo (Início, Chat, perfil, notificações próprias, eventos). */
  | { kind: "free" }
  /** Logado; a rota aplica a regra pelo conteúdo (ex.: incidentes filtrados pela aba da automação). */
  | { kind: "scoped"; note: string }
  /** Só administrador (fora do catálogo). */
  | { kind: "admin" }
  /** Exige a chave do catálogo (admin passa sempre). `extra`: ações adicionais checadas na rota. */
  | { kind: "perm"; key: string; extra?: string[] }
  /** Sem mapeamento: negado. */
  | { kind: "none" };

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface RouteRule {
  method: Method;
  /** Caminho exato (string) ou padrão (RegExp ancorada). */
  path: string | RegExp;
  access: Exclude<RouteAccess, { kind: "none" }>;
  /** Exemplo concreto do caminho (testes de cobertura e de negação). */
  sample: string;
}

const ID = "[A-Za-z0-9-]{1,64}";
// Análises da conciliação ML: a visão consolidada usa `consolidado_<empresa>` (com sublinhado),
// igual ao ID_PATTERN de routes/ml-reconciliation.ts. Sem isso o RBAC respondia 404 antes da rota.
const ML_ANALISE_ID = "[A-Za-z0-9_-]{1,64}";
const p = (key: string, extra?: string[]): RouteAccess & { kind: "perm" } => (extra ? { kind: "perm", key, extra } : { kind: "perm", key });
const FREE = { kind: "free" } as const;
const PUBLIC = { kind: "public" } as const;
const re = (s: string) => new RegExp(`^${s}$`);

export const ROUTE_RULES: readonly RouteRule[] = Object.freeze([
  // ---- Públicas
  { method: "GET", path: "/api/health", access: PUBLIC, sample: "/api/health" },
  { method: "POST", path: "/api/auth/register", access: PUBLIC, sample: "/api/auth/register" },
  { method: "POST", path: "/api/auth/login", access: PUBLIC, sample: "/api/auth/login" },
  { method: "POST", path: "/api/auth/logout", access: PUBLIC, sample: "/api/auth/logout" },

  // ---- Livres para qualquer logado (fora do catálogo)
  { method: "GET", path: "/api/auth/me", access: FREE, sample: "/api/auth/me" },
  { method: "PATCH", path: "/api/auth/profile", access: FREE, sample: "/api/auth/profile" },
  { method: "GET", path: "/api/auth/username-available", access: FREE, sample: "/api/auth/username-available" },
  { method: "GET", path: "/api/auth/email-available", access: FREE, sample: "/api/auth/email-available" },
  { method: "POST", path: "/api/auth/change-username", access: FREE, sample: "/api/auth/change-username" },
  { method: "POST", path: "/api/auth/change-email", access: FREE, sample: "/api/auth/change-email" },
  { method: "POST", path: "/api/auth/change-password", access: FREE, sample: "/api/auth/change-password" },
  { method: "GET", path: "/api/events", access: FREE, sample: "/api/events" },
  { method: "GET", path: "/api/chat/contacts", access: FREE, sample: "/api/chat/contacts" },
  { method: "GET", path: "/api/chat/conversations", access: FREE, sample: "/api/chat/conversations" },
  { method: "GET", path: "/api/chat/unread-count", access: FREE, sample: "/api/chat/unread-count" },
  { method: "POST", path: "/api/chat/messages", access: FREE, sample: "/api/chat/messages" },
  { method: "GET", path: re("/api/chat/messages/\\d+"), access: FREE, sample: "/api/chat/messages/2" },
  { method: "POST", path: re("/api/chat/messages/\\d+/read"), access: FREE, sample: "/api/chat/messages/2/read" },
  { method: "GET", path: "/api/notifications", access: FREE, sample: "/api/notifications" },
  { method: "GET", path: "/api/notifications/unread-count", access: FREE, sample: "/api/notifications/unread-count" },
  { method: "POST", path: "/api/notifications/read-all", access: FREE, sample: "/api/notifications/read-all" },
  { method: "POST", path: re("/api/notifications/\\d+/read"), access: FREE, sample: "/api/notifications/1/read" },
  { method: "GET", path: "/api/admin/permissions/catalog", access: FREE, sample: "/api/admin/permissions/catalog" },

  // ---- Só administrador, fora do catálogo
  { method: "POST", path: "/api/notifications/emit", access: { kind: "admin" }, sample: "/api/notifications/emit" },
  { method: "PUT", path: re("/api/admin/users/\\d+/role"), access: { kind: "admin" }, sample: "/api/admin/users/2/role" },

  // ---- Incidentes: a regra depende da automação do incidente
  {
    method: "GET",
    path: "/api/incidents",
    access: { kind: "scoped", note: "erros:ver vê todos; os demais só os das abas que veem (revisao_nfe:ver, contas_pagar:ver)" },
    sample: "/api/incidents",
  },
  {
    method: "POST",
    path: "/api/incidents",
    access: { kind: "scoped", note: "exige o ver da aba da automação reportada" },
    sample: "/api/incidents",
  },
  { method: "POST", path: re("/api/incidents/[\\w-]+/resolve"), access: p("erros:resolver"), sample: "/api/incidents/abc/resolve" },

  // ---- Financeiro
  { method: "GET", path: "/api/overview", access: p("fin_visao_geral:ver"), sample: "/api/overview" },
  { method: "GET", path: "/api/accounts-payable/dashboard", access: p("contas_pagar:ver"), sample: "/api/accounts-payable/dashboard" },
  { method: "GET", path: "/api/reconciliation/status", access: p("contas_pagar:ver"), sample: "/api/reconciliation/status" },
  { method: "GET", path: "/api/reconciliation/estado", access: p("contas_pagar:ver"), sample: "/api/reconciliation/estado" },
  { method: "POST", path: "/api/reconciliation/preview", access: p("contas_pagar:importar_extrato"), sample: "/api/reconciliation/preview" },
  { method: "POST", path: "/api/reconciliation/jobs/preview", access: p("contas_pagar:importar_extrato"), sample: "/api/reconciliation/jobs/preview" },
  { method: "POST", path: "/api/reconciliation/baixar", access: p("contas_pagar:baixar"), sample: "/api/reconciliation/baixar" },
  { method: "POST", path: "/api/reconciliation/jobs/baixar", access: p("contas_pagar:baixar"), sample: "/api/reconciliation/jobs/baixar" },
  { method: "GET", path: re(`/api/reconciliation/jobs/${ID}`), access: p("contas_pagar:ver"), sample: "/api/reconciliation/jobs/j1" },
  { method: "GET", path: "/api/reconciliation/historico", access: p("contas_pagar:ver"), sample: "/api/reconciliation/historico" },

  { method: "GET", path: "/api/ml-reconciliation/status", access: p("conciliacao_ml:ver"), sample: "/api/ml-reconciliation/status" },
  { method: "POST", path: "/api/ml-reconciliation/tokens/sincronizar", access: p("conciliacao_ml:executar"), sample: "/api/ml-reconciliation/tokens/sincronizar" },
  { method: "POST", path: "/api/ml-reconciliation/executar", access: p("conciliacao_ml:executar"), sample: "/api/ml-reconciliation/executar" },
  { method: "GET", path: "/api/ml-reconciliation/execucoes", access: p("conciliacao_ml:ver"), sample: "/api/ml-reconciliation/execucoes" },
  { method: "GET", path: re(`/api/ml-reconciliation/execucoes/${ID}`), access: p("conciliacao_ml:ver"), sample: "/api/ml-reconciliation/execucoes/e1" },
  { method: "POST", path: "/api/ml-reconciliation/jobs/baixar", access: p("conciliacao_ml:baixar"), sample: "/api/ml-reconciliation/jobs/baixar" },
  { method: "GET", path: re(`/api/ml-reconciliation/jobs/${ID}`), access: p("conciliacao_ml:ver"), sample: "/api/ml-reconciliation/jobs/j1" },
  { method: "GET", path: "/api/ml-reconciliation/analises", access: p("conciliacao_ml:ver"), sample: "/api/ml-reconciliation/analises" },
  { method: "GET", path: re(`/api/ml-reconciliation/analises/${ML_ANALISE_ID}`), access: p("conciliacao_ml:ver"), sample: "/api/ml-reconciliation/analises/consolidado_norvia_campinas" },
  {
    method: "GET",
    path: re(`/api/ml-reconciliation/analises/${ML_ANALISE_ID}/arquivos/[a-z-]{1,32}`),
    access: p("conciliacao_ml:ver"),
    sample: "/api/ml-reconciliation/analises/consolidado_norvia_campinas/arquivos/vendas",
  },

  { method: "GET", path: "/api/danfe/status", access: p("revisao_nfe:ver"), sample: "/api/danfe/status" },
  { method: "GET", path: "/api/danfe/sefaz-status", access: p("revisao_nfe:ver"), sample: "/api/danfe/sefaz-status" },
  {
    method: "POST",
    path: "/api/danfe/scan-sefaz",
    access: p("revisao_nfe:varrer_sefaz", ["revisao_nfe:forcar_varredura (com ?force=true)"]),
    sample: "/api/danfe/scan-sefaz",
  },
  { method: "POST", path: "/api/danfe/import-key", access: p("revisao_nfe:importar_chave"), sample: "/api/danfe/import-key" },
  { method: "GET", path: "/api/danfe/history", access: p("revisao_nfe:ver"), sample: "/api/danfe/history" },
  { method: "GET", path: "/api/danfe/tiny-categories", access: p("revisao_nfe:ver"), sample: "/api/danfe/tiny-categories" },
  { method: "GET", path: "/api/danfe/pending-review", access: p("revisao_nfe:ver"), sample: "/api/danfe/pending-review" },
  { method: "GET", path: "/api/danfe/notas", access: p("revisao_nfe:ver"), sample: "/api/danfe/notas" },
  { method: "POST", path: "/api/danfe/archive", access: p("revisao_nfe:arquivar"), sample: "/api/danfe/archive" },
  { method: "POST", path: "/api/danfe/restore", access: p("revisao_nfe:arquivar"), sample: "/api/danfe/restore" },
  { method: "POST", path: "/api/danfe/failures/resolve", access: p("revisao_nfe:resolver_falha"), sample: "/api/danfe/failures/resolve" },
  { method: "POST", path: "/api/danfe/confirm-lancamento", access: p("revisao_nfe:lancar"), sample: "/api/danfe/confirm-lancamento" },
  { method: "POST", path: "/api/danfe/process-batch", access: p("revisao_nfe:lancar"), sample: "/api/danfe/process-batch" },

  { method: "GET", path: "/api/financial-dashboard", access: p("dashboard_financeiro:ver"), sample: "/api/financial-dashboard" },
  { method: "GET", path: "/api/financial-dashboard/status", access: p("dashboard_financeiro:ver"), sample: "/api/financial-dashboard/status" },
  {
    method: "POST",
    path: "/api/financial-dashboard/sync",
    access: p("dashboard_financeiro:sincronizar", ["dashboard_financeiro:forcar_sincronizacao (com ?force=true)"]),
    sample: "/api/financial-dashboard/sync",
  },

  // ---- Marketplace (proxy para automacoes-marketplace; a automação não tem PUT: negado)
  { method: "GET", path: re("/api/marketplace/dimensoes(/[A-Za-z0-9_-]+)*"), access: p("dimensoes:ver"), sample: "/api/marketplace/dimensoes/status" },
  { method: "POST", path: "/api/marketplace/dimensoes/validar", access: p("dimensoes:validar"), sample: "/api/marketplace/dimensoes/validar" },
  { method: "POST", path: "/api/marketplace/dimensoes/reenviar", access: p("dimensoes:reenviar"), sample: "/api/marketplace/dimensoes/reenviar" },
  { method: "POST", path: "/api/marketplace/dimensoes/executar", access: p("dimensoes:executar"), sample: "/api/marketplace/dimensoes/executar" },
  { method: "GET", path: re("/api/marketplace/fretes(/[A-Za-z0-9_-]+)*"), access: p("fretes:ver"), sample: "/api/marketplace/fretes/anuncios" },
  { method: "POST", path: "/api/marketplace/fretes/retentar", access: p("fretes:retentar"), sample: "/api/marketplace/fretes/retentar" },
  { method: "POST", path: "/api/marketplace/fretes/executar", access: p("fretes:executar"), sample: "/api/marketplace/fretes/executar" },

  // ---- Logística (Contagem de Estoque)
  { method: "GET", path: "/api/stock-count/contagens", access: p("contagem_estoque:ver"), sample: "/api/stock-count/contagens" },
  { method: "DELETE", path: re("/api/stock-count/contagens/[A-Za-z0-9-]{1,64}"), access: p("contagem_estoque:excluir"), sample: "/api/stock-count/contagens/abc123def456" },
  { method: "POST", path: re("/api/stock-count/contagens/[A-Za-z0-9-]{1,64}/conferir"), access: p("contagem_estoque:conferir"), sample: "/api/stock-count/contagens/abc123def456/conferir" },
  // Reenvio ao Tiny: mesma permissão da conferência (conferir já lança a entrada no Tiny).
  { method: "POST", path: re("/api/stock-count/contagens/[A-Za-z0-9-]{1,64}/tiny"), access: p("contagem_estoque:conferir"), sample: "/api/stock-count/contagens/abc123def456/tiny" },
  // Nome do produto e saldo atual no Tiny (só leitura) para conferir o SKU e comparar com a foto.
  { method: "GET", path: re("/api/stock-count/contagens/[A-Za-z0-9-]{1,64}/tiny"), access: p("contagem_estoque:ver"), sample: "/api/stock-count/contagens/abc123def456/tiny" },
  { method: "POST", path: re("/api/stock-count/contagens/[A-Za-z0-9-]{1,64}/sku"), access: p("contagem_estoque:informar_sku"), sample: "/api/stock-count/contagens/abc123def456/sku" },
  { method: "GET", path: re("/api/stock-count/imagens/[A-Za-z0-9-]{1,64}/(anotada|original)"), access: p("contagem_estoque:ver"), sample: "/api/stock-count/imagens/j1/anotada" },

  // ---- Sistema
  { method: "GET", path: "/api/admin/system-health", access: p("saude:ver"), sample: "/api/admin/system-health" },
  { method: "GET", path: re("/api/health/(circuits|tiny|inter|n8n)"), access: p("saude:ver"), sample: "/api/health/circuits" },
  { method: "GET", path: "/api/admin/audit", access: p("auditoria:ver"), sample: "/api/admin/audit" },
  { method: "GET", path: "/api/admin/token-automation", access: p("tokens_n8n:ver"), sample: "/api/admin/token-automation" },
  { method: "POST", path: "/api/admin/token-automation/execute", access: p("tokens_n8n:executar"), sample: "/api/admin/token-automation/execute" },

  // ---- Gestão de Usuários (Gestor: só sobre usuários do perfil User — escopo aplicado em routes/admin.ts)
  { method: "GET", path: "/api/admin/users", access: p("usuarios:ver"), sample: "/api/admin/users" },
  { method: "POST", path: "/api/admin/users", access: p("usuarios:criar"), sample: "/api/admin/users" },
  { method: "POST", path: re("/api/admin/users/\\d+/approve"), access: p("usuarios:aprovar_cadastro"), sample: "/api/admin/users/2/approve" },
  { method: "POST", path: re("/api/admin/users/\\d+/reject"), access: p("usuarios:rejeitar_cadastro"), sample: "/api/admin/users/2/reject" },
  { method: "DELETE", path: re("/api/admin/users/\\d+"), access: p("usuarios:excluir"), sample: "/api/admin/users/2" },
  { method: "GET", path: re("/api/admin/users/\\d+/permissions"), access: p("usuarios:ver"), sample: "/api/admin/users/2/permissions" },
  { method: "PUT", path: re("/api/admin/users/\\d+/permissions"), access: p("usuarios:editar_permissoes"), sample: "/api/admin/users/2/permissions" },
  { method: "PUT", path: re("/api/admin/users/\\d+/setor"), access: p("usuarios:alterar_setor"), sample: "/api/admin/users/2/setor" },
  { method: "GET", path: "/api/admin/sessions", access: p("usuarios:ver"), sample: "/api/admin/sessions" },
  {
    method: "POST",
    path: re("/api/admin/sessions/[a-f0-9]{24}/force-logout"),
    access: p("usuarios:derrubar_sessao"),
    sample: `/api/admin/sessions/${"a".repeat(24)}/force-logout`,
  },
  { method: "POST", path: re("/api/admin/users/\\d+/force-logout"), access: p("usuarios:derrubar_sessao"), sample: "/api/admin/users/2/force-logout" },
  { method: "GET", path: "/api/admin/pending-count", access: p("usuarios:ver"), sample: "/api/admin/pending-count" },
  { method: "GET", path: "/api/admin/change-requests", access: p("usuarios:ver"), sample: "/api/admin/change-requests" },
  {
    method: "POST",
    path: re("/api/admin/change-requests/\\d+/(approve|reject)"),
    access: p("usuarios:revisar_alteracao"),
    sample: "/api/admin/change-requests/1/approve",
  },
] satisfies RouteRule[]);

/** Rotas sempre liberadas a qualquer logado (lista explícita, conferida no teste de cobertura). */
export const FREE_FOR_LOGGED_IN: readonly string[] = Object.freeze(
  ROUTE_RULES.filter((r) => r.access.kind === "free").map((r) => `${r.method} ${r.sample}`),
);

/** Regra de acesso de uma requisição. HEAD segue a regra do GET. */
export function routeAccess(method: string, path: string): RouteAccess {
  const m = method === "HEAD" ? "GET" : method;
  for (const r of ROUTE_RULES) {
    if (r.method !== m) continue;
    if (typeof r.path === "string" ? r.path === path : r.path.test(path)) return r.access;
  }
  return { kind: "none" };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
