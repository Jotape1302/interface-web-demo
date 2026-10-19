// Áreas ("pastas") e páginas do menu, filtradas pelas permissões da sessão (RBAC por usuário).
// Cada página do painel corresponde ao "ver" de uma aba do catálogo do gateway
// (backend/gateway/src/permissions.ts). Início, Chat, perfil e notificações próprias são de
// todos os logados. O setor é só rótulo de equipe: não dá acesso a nada.
// A barreira real é o gateway (403/404); aqui só se decide o que aparece.

import { hasPermission, type PermissionSession } from './permissions';

export type AreaId = 'financeiro' | 'logistica' | 'marketplace' | 'producao';

export type PageId =
  | 'home'
  | 'chat'
  | 'financeiro-overview'
  | 'accounts-payable'
  | 'ml-reconciliation'
  | 'danfe-tiny'
  | 'financial-dashboard'
  | 'logistica-overview'
  | 'stock-count'
  | 'marketplace-overview'
  | 'dimension-standardization'
  | 'shipping-review'
  | 'producao-overview'
  | 'admin-errors'
  | 'admin-health'
  | 'admin-audit'
  | 'admin-tokens'
  | 'admin-users';

export interface AreaDefinition {
  id: AreaId;
  title: string;
  /** Rota da Visão geral da área. */
  href: string;
  /** Páginas da área na ordem do menu (a primeira é a Visão geral). */
  pages: readonly PageId[];
}

export const AREAS: readonly AreaDefinition[] = [
  {
    id: 'financeiro',
    title: 'Financeiro',
    href: '/financeiro',
    pages: ['financeiro-overview', 'accounts-payable', 'ml-reconciliation', 'danfe-tiny', 'financial-dashboard'],
  },
  { id: 'logistica', title: 'Logística', href: '/logistica', pages: ['logistica-overview', 'stock-count'] },
  {
    id: 'marketplace',
    title: 'Marketplace',
    href: '/marketplace',
    pages: ['marketplace-overview', 'dimension-standardization', 'shipping-review'],
  },
  { id: 'producao', title: 'Produção', href: '/producao', pages: ['producao-overview'] },
];

/** Bloco SISTEMA do menu, na ordem de exibição. */
export const SYSTEM_PAGES: readonly PageId[] = ['admin-errors', 'admin-health', 'admin-audit', 'admin-tokens'];

/** Página → chave "ver" da aba. Páginas fora do mapa (Início, Chat) são de todos os logados. */
export const PAGE_VIEW_KEY: Readonly<Partial<Record<PageId, string>>> = {
  'financeiro-overview': 'fin_visao_geral:ver',
  'accounts-payable': 'contas_pagar:ver',
  'ml-reconciliation': 'conciliacao_ml:ver',
  'danfe-tiny': 'revisao_nfe:ver',
  'financial-dashboard': 'dashboard_financeiro:ver',
  'logistica-overview': 'log_visao_geral:ver',
  'stock-count': 'contagem_estoque:ver',
  'marketplace-overview': 'mkt_visao_geral:ver',
  'dimension-standardization': 'dimensoes:ver',
  'shipping-review': 'fretes:ver',
  'producao-overview': 'prod_visao_geral:ver',
  'admin-errors': 'erros:ver',
  'admin-health': 'saude:ver',
  'admin-audit': 'auditoria:ver',
  'admin-tokens': 'tokens_n8n:ver',
  'admin-users': 'usuarios:ver',
};

/** Nome da aba de cada página (mensagem "Peça ao administrador para liberar {aba}"). */
export const PAGE_TAB_LABEL: Readonly<Partial<Record<PageId, string>>> = {
  'financeiro-overview': 'Financeiro › Visão geral',
  'accounts-payable': 'Contas a Pagar',
  'ml-reconciliation': 'Conciliação ML',
  'danfe-tiny': 'Revisão NF-e',
  'financial-dashboard': 'Dashboard Financeiro',
  'logistica-overview': 'Logística › Visão geral',
  'stock-count': 'Contagem de estoque',
  'marketplace-overview': 'Marketplace › Visão geral',
  'dimension-standardization': 'Padronização de dimensões',
  'shipping-review': 'Fretes a combinar',
  'producao-overview': 'Produção › Visão geral',
  'admin-errors': 'Erros & Falhas',
  'admin-health': 'Saúde do Sistema',
  'admin-audit': 'Log de Auditoria',
  'admin-tokens': 'Tokens n8n',
  'admin-users': 'Gestão de Usuários',
};

/** Rota de cada página com aba. */
export const PAGE_HREF: Readonly<Record<Exclude<PageId, 'home' | 'chat'>, string>> = {
  'financeiro-overview': '/financeiro',
  'accounts-payable': '/contas-a-pagar',
  'ml-reconciliation': '/conciliacao-mercado-livre',
  'danfe-tiny': '/danfe-tiny',
  'financial-dashboard': '/dashboard-financeiro',
  'logistica-overview': '/logistica',
  'stock-count': '/contagem-estoque',
  'marketplace-overview': '/marketplace',
  'dimension-standardization': '/padronizacao-dimensoes',
  'shipping-review': '/fretes-a-combinar',
  'producao-overview': '/producao',
  'admin-errors': '/admin/erros',
  'admin-health': '/admin/saude',
  'admin-audit': '/admin/auditoria',
  'admin-tokens': '/admin/tokens',
  'admin-users': '/admin/usuarios',
};

// Página → área (pasta) a que pertence, para destacar a pasta ativa.
export const PAGE_AREA: Readonly<Partial<Record<PageId, AreaId>>> = Object.fromEntries(
  AREAS.flatMap((a) => a.pages.map((p) => [p, a.id] as const)),
);

export function canAccessPage(session: PermissionSession | null | undefined, page: PageId): boolean {
  if (!session) return false;
  const key = PAGE_VIEW_KEY[page];
  return key === undefined || hasPermission(session, key);
}

/** Páginas visíveis da área (vazio = a pasta não aparece). */
export function visibleAreaPages(session: PermissionSession | null | undefined, area: AreaId): PageId[] {
  const def = AREAS.find((a) => a.id === area);
  return def ? def.pages.filter((p) => canAccessPage(session, p)) : [];
}

/** A pasta aparece se a sessão tem ao menos um "ver" da área. */
export function canAccessArea(session: PermissionSession | null | undefined, area: AreaId): boolean {
  return visibleAreaPages(session, area).length > 0;
}

/** Para onde o atalho da área leva: a Visão geral, ou a primeira aba liberada se ela não for. */
export function areaEntryHref(session: PermissionSession | null | undefined, area: AreaId): string | null {
  const first = visibleAreaPages(session, area)[0];
  return first && first !== 'home' && first !== 'chat' ? PAGE_HREF[first] : null;
}

export function accessibleAreas(session: PermissionSession | null | undefined): AreaDefinition[] {
  return AREAS.filter((a) => canAccessArea(session, a.id));
}

/** Itens do bloco SISTEMA visíveis (vazio = o bloco não aparece). */
export function visibleSystemPages(session: PermissionSession | null | undefined): PageId[] {
  return SYSTEM_PAGES.filter((p) => canAccessPage(session, p));
}

/** Bloco ADMINISTRAÇÃO: Admin, ou Gestor com "ver" da Gestão de Usuários. */
export function canSeeAdministration(session: PermissionSession | null | undefined): boolean {
  return canAccessPage(session, 'admin-users');
}

// Resumo do que cada área reúne, usado na página inicial e nas visões gerais.
export const AREA_SUMMARY: Readonly<Record<AreaId, string>> = {
  financeiro: 'Contas a pagar, conciliação do Mercado Livre, lançamento de NF-e no Tiny e dashboards financeiros.',
  logistica: 'Contagem de estoque por foto da prateleira, pelo bot do Telegram.',
  marketplace: 'Medidas e frete dos anúncios do Mercado Livre.',
  producao: 'Impressão de etiquetas de produto direto do tablet da Produção.',
};
