'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  Home,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  PackageSearch,
  MessageCircle,
  Ruler,
  Truck,
  ScanBarcode,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingBag,
  UserCircle,
  Wallet,
} from 'lucide-react';
import { Sidebar, SidebarProvider } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  accountsPayable,
  danfeAutomation,
  financialDashboard,
  fretesACombinar,
  mlReconciliation,
  padronizacaoDimensoes,
  stockCount,
} from '@/lib/automations';
import {
  PAGE_AREA,
  accessibleAreas,
  canSeeAdministration,
  visibleAreaPages,
  visibleSystemPages,
  type AreaId,
  type PageId,
} from '@/lib/areas';
import { ROLE_LABEL } from '@/lib/permissions';
import { useAuth } from '@/lib/auth-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { getPendingIncidentsCount, subscribeToIncidents } from '@/lib/incidents-store';
import UserProfileModal, { getStatusPreset } from './user-profile-modal';
import SettingsModal from './settings-modal';
import NotificationBell from './notification-bell';
import { NorviaLogo } from '@/components/ui/norvia-logo';
import { DashboardChartIcon } from '@/components/ui/dashboard-icon';
import { useDataPolling } from '@/lib/use-data-polling';

type AppShellPage = PageId;

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'norvia-sidebar-collapsed';
const CLOSED_FOLDERS_STORAGE_KEY = 'norvia-sidebar-closed-folders';

// Pasta de área no menu (Financeiro, Logística, Marketplace). Com a sidebar
// recolhida em ícones, o cabeçalho vira só um divisor e os itens ficam sempre visíveis.
function NavFolder({
  title,
  collapsed,
  open,
  active,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <fieldset className="nav-folder" aria-label={title}>
        <div className="nav-folder-divider" title={title} />
        {children}
      </fieldset>
    );
  }
  return (
    <fieldset className="nav-folder" aria-label={title}>
      <button
        type="button"
        className={`nav-folder-header${active ? ' nav-folder-header-active' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="nav-link-top">
          {open ? <FolderOpen size={16} /> : <Folder size={16} />}
          {title}
        </span>
        <ChevronDown size={14} className={`nav-folder-chevron${open ? '' : ' nav-folder-chevron-closed'}`} />
      </button>
      {open && <div className="nav-folder-items">{children}</div>}
    </fieldset>
  );
}

// Descrição curta de cada item do menu, mostrada ao passar o mouse.
const NAV_HINTS: Record<AppShellPage, string> = {
  home: 'Página inicial com as áreas que você pode acessar.',
  chat: 'Mensagens diretas com outros colaboradores.',
  'financeiro-overview': 'Resumo das automações do Financeiro: execuções, falhas e pendências.',
  'logistica-overview': 'Automações da Logística disponíveis para o seu setor.',
  'marketplace-overview': 'Automações de E-commerce e Marketplace.',
  'producao-overview': 'Automações da Produção.',
  'accounts-payable': 'Baixa de contas a pagar por conciliação bancária Banco Inter × Tiny ERP.',
  'ml-reconciliation': 'Vendas do Mercado Livre × liberações do Mercado Pago × Contas a Receber do Tiny, todo dia: baixa, lançamentos e saldo.',
  'danfe-tiny': 'Notas fiscais da SEFAZ para revisar, categorizar e lançar no Tiny ERP.',
  'financial-dashboard': 'Receitas, despesas, fluxo de caixa e contas em aberto das empresas no Tiny.',
  'stock-count': 'Contagem de pacotes na prateleira por foto, pelo bot do Telegram.',
  'shipping-review': 'Tipo de envio dos anúncios do ML pelas dimensões padronizadas, com conferência.',
  'dimension-standardization': 'Medidas dos produtos no ML e no Tiny comparadas, revisadas e padronizadas.',
  'admin-users': 'Aprovar cadastros, definir perfis e permissões e encerrar sessões.',
  'admin-errors': 'Falhas reportadas nas automações, com diagnóstico e ação recomendada.',
  'admin-health': 'Situação dos serviços, integrações, rotinas diárias e do backup.',
  'admin-audit': 'Histórico de quem fez o quê na plataforma.',
  'admin-tokens': 'Renovação automática dos tokens das integrações (n8n).',
};

// Rota, rótulo e ícone de cada página que entra no menu (as pastas e o bloco SISTEMA).
const NAV_PAGES: Record<Exclude<AppShellPage, 'home' | 'chat' | 'admin-users'>, { href: string; label: string; icon: React.ReactNode }> = {
  'financeiro-overview': { href: '/financeiro', label: 'Visão geral', icon: <LayoutGrid size={18} /> },
  'accounts-payable': { href: '/contas-a-pagar', label: accountsPayable.title, icon: <Wallet size={18} /> },
  'ml-reconciliation': { href: '/conciliacao-mercado-livre', label: mlReconciliation.title, icon: <ShoppingBag size={18} /> },
  'danfe-tiny': { href: '/danfe-tiny', label: danfeAutomation.title, icon: <ScanBarcode size={18} /> },
  'financial-dashboard': {
    href: '/dashboard-financeiro',
    label: financialDashboard.title,
    icon: <DashboardChartIcon width={18} height={18} />,
  },
  'logistica-overview': { href: '/logistica', label: 'Visão geral', icon: <LayoutGrid size={18} /> },
  'stock-count': { href: '/contagem-estoque', label: stockCount.title, icon: <PackageSearch size={18} /> },
  'marketplace-overview': { href: '/marketplace', label: 'Visão geral', icon: <LayoutGrid size={18} /> },
  'dimension-standardization': { href: '/padronizacao-dimensoes', label: padronizacaoDimensoes.title, icon: <Ruler size={18} /> },
  'shipping-review': { href: '/fretes-a-combinar', label: fretesACombinar.title, icon: <Truck size={18} /> },
  'producao-overview': { href: '/producao', label: 'Visão geral', icon: <LayoutGrid size={18} /> },
  'admin-errors': { href: '/admin/erros', label: 'Erros & Falhas', icon: <AlertTriangle size={18} /> },
  'admin-health': { href: '/admin/saude', label: 'Saúde do Sistema', icon: <Activity size={18} /> },
  'admin-audit': { href: '/admin/auditoria', label: 'Log de Auditoria', icon: <History size={18} /> },
  'admin-tokens': { href: '/admin/tokens', label: 'Tokens n8n', icon: <KeyRound size={18} /> },
};

// Item do menu lateral. A descrição aparece num tooltip ao passar o mouse; com o menu
// recolhido em ícones, o tooltip também traz o nome do item.
function NavItem({
  href,
  active,
  collapsed,
  icon,
  label,
  hint,
  tooltipTitle,
  count = 0,
  countLabel,
}: {
  href: string;
  active: boolean;
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  tooltipTitle?: string;
  count?: number;
  countLabel?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            className={active ? 'nav-active' : 'nav-idle'}
            href={href}
            aria-current={active ? 'page' : undefined}
            aria-label={collapsed ? label : undefined}
          />
        }
      >
        <span className="nav-link-top nav-link-top-badge">
          {icon}
          {!collapsed && <span className="nav-link-label">{label}</span>}
          {count > 0 &&
            (collapsed ? (
              <span className="nav-icon-badge" aria-hidden="true" />
            ) : (
              <span className="nav-count" aria-label={countLabel}>
                {count > 99 ? '99+' : count}
              </span>
            ))}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className="max-w-60 flex-col items-start gap-0.5">
        {collapsed && <span className="font-semibold">{tooltipTitle ?? label}</span>}
        <span>{hint}</span>
        {collapsed && count > 0 && countLabel && <span className="font-semibold">{countLabel}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const PAGE_TITLES: Record<AppShellPage, string> = {
  home: 'Início',
  'financeiro-overview': 'Visão Geral · Financeiro',
  'logistica-overview': 'Visão Geral · Logística',
  'marketplace-overview': 'Visão Geral · Marketplace',
  'producao-overview': 'Visão Geral · Produção',
  'accounts-payable': accountsPayable.title,
  'ml-reconciliation': mlReconciliation.title,
  'danfe-tiny': danfeAutomation.title,
  'financial-dashboard': financialDashboard.title,
  'stock-count': stockCount.title,
  'shipping-review': fretesACombinar.title,
  'dimension-standardization': padronizacaoDimensoes.title,
  'admin-users': 'Gestão de Usuários',
  'admin-errors': 'Erros & Falhas',
  'admin-audit': 'Log de Auditoria',
  'admin-health': 'Saúde do Sistema',
  'admin-tokens': 'Tokens n8n',
  chat: 'Chat',
};

export default function AppShell({
  children,
  page,
  mode,
}: {
  children: React.ReactNode;
  page: AppShellPage;
  mode: 'demo' | 'live';
}) {
  const { user, logout, pendingCount, token, apiBaseUrl, isDemoMode, session } = useAuth();
  const [reportedIncidentsCount, setReportedIncidentsCount] = useState(0);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const isMobile = useIsMobile();
  const [closedFolders, setClosedFolders] = useState<AreaId[]>([]);
  const areas = accessibleAreas(session);
  const systemPages = visibleSystemPages(session);
  const showAdministration = canSeeAdministration(session);
  const pageArea = PAGE_AREA[page];

  useEffect(() => {
    setReportedIncidentsCount(getPendingIncidentsCount());
    return subscribeToIncidents(() => {
      setReportedIncidentsCount(getPendingIncidentsCount());
    });
  }, []);

  useDataPolling(
    async (signal) => {
      if (!user) return;
      if (isDemoMode) {
        setChatUnreadCount(1);
        return;
      }
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/chat/unread-count`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { count?: number };
          setChatUnreadCount(Number(data.count) || 0);
        }
      } catch {
        // ignora falha de polling
      }
    },
    {
      intervalMs: 20000,
      enabled: Boolean(user),
      pauseOnHidden: true,
      refetchOnVisible: true,
      realtimeEvents: user && !isDemoMode ? ['chat', 'reconnected'] : undefined,
      skipWhenRealtimeConnected: true,
    },
  );

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true');
    } catch {
      // localStorage indisponível (modo privado, etc) — mantém expandido por padrão.
    }
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CLOSED_FOLDERS_STORAGE_KEY) ?? '[]');
      if (Array.isArray(saved)) setClosedFolders(saved);
    } catch {
      // localStorage indisponível ou valor inválido — todas as pastas abertas.
    }
  }, []);

  const toggleFolder = (area: AreaId) => {
    setClosedFolders((prev) => {
      const next = prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area];
      try {
        localStorage.setItem(CLOSED_FOLDERS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignora falha ao persistir preferência
      }
      return next;
    });
  };

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // ignora falha ao persistir preferência
      }
      return next;
    });
  };

  // Em telas pequenas a sidebar já vira uma barra horizontal (ver globals.css, breakpoint
  // 700px) — o recolhimento em modo ícone é um recurso de desktop, então é ignorado no mobile.
  const collapsed = sidebarCollapsed && !isMobile;


  return (
    <SidebarProvider className="app-shell">
      <a href="#conteudo" className="skip-link">
        Ir para conteúdo
      </a>
      <Sidebar
        collapsible="none"
        className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
        role="complementary"
        aria-label="NORVIA AUTOMAÇÕES"
      >
        <div className="sidebar-top">
          <div className="brand-row">
            <Link href="/" className="brand" title={collapsed ? 'NORVIA AUTOMAÇÕES' : undefined}>
              <NorviaLogo size={collapsed ? 30 : 38} className="official-logo" />
              {!collapsed && (
                <div className="brand-text">
                  <span className="brand-title">NORVIA</span>
                  <span className="brand-caption">AUTOMAÇÕES</span>
                </div>
              )}
            </Link>
            {!isMobile && (
              <button
                type="button"
                onClick={toggleSidebarCollapsed}
                className="sidebar-collapse-toggle"
                title={collapsed ? 'Expandir menu' : 'Recolher menu'}
                aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
                aria-pressed={collapsed}
              >
                <Menu size={16} />
              </button>
            )}
          </div>

          <TooltipProvider delay={350}>
          <nav className="nav-container" aria-label="Navegação principal">
            {!collapsed && <p className="nav-label">MENU PRINCIPAL</p>}
            <div className="nav-list">
              <NavItem
                href="/"
                active={page === 'home'}
                collapsed={collapsed}
                icon={<Home size={18} />}
                label="Início"
                hint={NAV_HINTS.home}
              />
              <NavItem
                href="/chat"
                active={page === 'chat'}
                collapsed={collapsed}
                icon={<MessageCircle size={18} />}
                label="Chat"
                hint={NAV_HINTS.chat}
                count={chatUnreadCount}
                countLabel={`${chatUnreadCount} mensage${chatUnreadCount > 1 ? 'ns' : 'm'} não lida${chatUnreadCount > 1 ? 's' : ''}`}
              />

              {areas.map((area) => (
                <NavFolder
                  key={area.id}
                  title={area.title}
                  collapsed={collapsed}
                  open={isMobile || !closedFolders.includes(area.id)}
                  onToggle={() => toggleFolder(area.id)}
                  active={pageArea === area.id}
                >
                  {visibleAreaPages(session, area.id).map((p) => {
                    const nav = NAV_PAGES[p as keyof typeof NAV_PAGES];
                    return (
                      <NavItem
                        key={p}
                        href={nav.href}
                        active={page === p}
                        collapsed={collapsed}
                        icon={nav.icon}
                        label={nav.label}
                        tooltipTitle={nav.label === 'Visão geral' ? `Visão geral · ${area.title}` : undefined}
                        hint={NAV_HINTS[p]}
                      />
                    );
                  })}
                  {area.id === 'producao' && (
                    <span className="nav-locked" title={collapsed ? `${area.title}: nenhuma automação ainda` : undefined}>
                      <span className="nav-link-top">
                        <Folder size={18} />
                        {!collapsed && 'Nenhuma automação'}
                      </span>
                      {!collapsed && <span className="nav-locked-caption">Em breve</span>}
                    </span>
                  )}
                </NavFolder>
              ))}

              {systemPages.length > 0 && (
                <div className="mt-4 pt-3 border-t border-sidebar-border">
                  {!collapsed && <p className="nav-label mb-2">SISTEMA</p>}
                  {systemPages.map((p) => {
                    const nav = NAV_PAGES[p as keyof typeof NAV_PAGES];
                    const count = p === 'admin-errors' ? reportedIncidentsCount : 0;
                    return (
                      <NavItem
                        key={p}
                        href={nav.href}
                        active={page === p}
                        collapsed={collapsed}
                        icon={nav.icon}
                        label={nav.label}
                        hint={NAV_HINTS[p]}
                        count={count}
                        countLabel={`${count} falha${count > 1 ? 's' : ''} pendente${count > 1 ? 's' : ''}`}
                      />
                    );
                  })}
                </div>
              )}

              {showAdministration && (
                <div className="mt-4 pt-3 border-t border-sidebar-border">
                  {!collapsed && <p className="nav-label mb-2">ADMINISTRAÇÃO</p>}
                  <NavItem
                    href="/admin/usuarios"
                    active={page === 'admin-users'}
                    collapsed={collapsed}
                    icon={<ShieldCheck size={18} />}
                    label="Gestão de Usuários"
                    hint={NAV_HINTS['admin-users']}
                    count={pendingCount}
                    countLabel={`${pendingCount} pendência${pendingCount > 1 ? 's' : ''}`}
                  />
                </div>
              )}
            </div>
          </nav>
          </TooltipProvider>
        </div>

        <div className="sidebar-bottom">
          <div className={`workspace-user flex items-center w-full ${collapsed ? 'flex-col gap-2' : 'justify-between'}`}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className={`flex items-center gap-2.5 overflow-hidden text-left p-1 rounded-lg hover:bg-muted/70 transition cursor-pointer group ${collapsed ? '' : 'flex-1'}`}
                    title="Perfil e configurações"
                  >
                    <div className="relative shrink-0">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--marca-ambar-suave)] text-xs font-bold text-[var(--marca-ambar)] border border-[var(--marca-ambar)]/30 overflow-hidden">
                        {user?.foto_perfil ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={user.foto_perfil} alt={user.nome} className="h-full w-full object-cover" />
                        ) : user?.nome ? (
                          user.nome.charAt(0).toUpperCase()
                        ) : (
                          'H'
                        )}
                      </span>
                      {user && (
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-card ${getStatusPreset(user.status_preset).dotClass}`}
                          title={user.status_presenca || 'Disponível'}
                        />
                      )}
                    </div>
                    {!collapsed && (
                      <div className="min-w-0 flex-1">
                        <strong className="block truncate text-sm font-semibold text-foreground group-hover:text-[var(--marca-ambar)] transition">
                          {user?.nome || 'NORVIA AUTOMAÇÕES'}
                        </strong>
                        <small className="block truncate text-xs text-muted-foreground">
                          {user ? (
                            <span className="flex items-center gap-1">
                              <span className="truncate">{user.status_presenca || 'Disponível'}</span>
                              <span>·</span>
                              <span className="uppercase text-[10px] font-mono">{ROLE_LABEL[user.role] ?? user.role}</span>
                            </span>
                          ) : (
                            'Gestão de operações'
                          )}
                        </small>
                      </div>
                    )}
                  </button>
                }
              />
              <DropdownMenuContent align="start" side={collapsed ? 'right' : 'top'} className="w-56">
                <DropdownMenuItem onClick={() => setIsProfileModalOpen(true)} className="gap-2">
                  <UserCircle size={15} />
                  Meu Perfil & Presença
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsSettingsModalOpen(true)} className="gap-2">
                  <SettingsIcon size={15} />
                  Configurações
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {user && (
              <button
                type="button"
                onClick={() => void logout()}
                className={`rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-500 transition cursor-pointer shrink-0 ${collapsed ? '' : 'ml-1'}`}
                title="Encerrar Sessão"
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </Sidebar>

      <div className={`main-shell${collapsed ? ' main-shell-sidebar-collapsed' : ''}`}>
        <header className="topbar">
          <div className="flex items-center gap-2">
            <span className="breadcrumb font-semibold text-xs tracking-wider text-muted-foreground uppercase">
              NORVIA <ChevronRight size={13} className="inline text-muted-foreground" />
            </span>
            <strong className="text-base font-bold text-foreground tracking-tight">
              {PAGE_TITLES[page]}
            </strong>
          </div>
          <div className="topbar-right flex items-center gap-3">
            {mode === 'demo' && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-semibold text-xs tracking-wide">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span>MODO DEMONSTRAÇÃO</span>
              </div>
            )}

            {user && <NotificationBell />}
          </div>
        </header>

        <main id="conteudo" className="main-content" tabIndex={-1}>
          {children}
          <footer className="page-footer">
            <span>
              NORVIA AUTOMAÇÕES <span>·</span> Central de controle operacional
            </span>
            <span>
              <ShieldCheck size={13} />
              Painel de consulta <span>·</span> Horários de Brasília
            </span>
          </footer>
        </main>
      </div>

      <UserProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
      />
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />
    </SidebarProvider>
  );
}
