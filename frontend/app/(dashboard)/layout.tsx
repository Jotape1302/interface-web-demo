'use client';

import { usePathname } from 'next/navigation';
import AppShell from '@/app/components/app-shell';
import { useEffect } from 'react';
import { esquecerDestinoAposLogin, useAuth } from '@/lib/auth-context';
import { canAccessPage, type PageId } from '@/lib/areas';
import AreaRestricted from '@/app/components/area-restricted';

const PAGE_BY_PATH: Record<string, PageId> = {
  '/': 'home',
  '/financeiro': 'financeiro-overview',
  '/logistica': 'logistica-overview',
  '/marketplace': 'marketplace-overview',
  '/chat': 'chat',
  '/admin/usuarios': 'admin-users',
  '/admin/auditoria': 'admin-audit',
  '/admin/saude': 'admin-health',
  '/admin/erros': 'admin-errors',
  '/admin/tokens': 'admin-tokens',
  '/contas-a-pagar': 'accounts-payable',
  '/conciliacao-mercado-livre': 'ml-reconciliation',
  '/danfe-tiny': 'danfe-tiny',
  '/dashboard-financeiro': 'financial-dashboard',
  '/contagem-estoque': 'stock-count',
  '/fretes-a-combinar': 'shipping-review',
  '/padronizacao-dimensoes': 'dimension-standardization',
  '/producao': 'producao-overview',
};

function resolvePage(pathname: string | null): PageId {
  const normalized = (pathname ?? '/').replace(/\/+$/, '') || '/';
  return PAGE_BY_PATH[normalized] ?? 'home';
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { token, user, session } = useAuth();
  const page = resolvePage(pathname);
  // Chegou a uma página logado: o destino guardado no login já foi usado (ou não vale mais).
  useEffect(() => {
    if (user) esquecerDestinoAposLogin();
  }, [user, pathname]);
  // O gateway também bloqueia (403) — aqui só evita montar a página e mostra o motivo.
  const blocked = !canAccessPage(session, page);

  // Login via "Modo Demonstração" (token 'mock-demo-token') força dados mock mesmo
  // que NEXT_PUBLIC_DATA_MODE=live esteja setada (ex.: dev local apontando pro backend real).
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  // Gestão de Usuários também tem modo demo (store em memória de lib/demo-permissions.ts).
  const mode = !isDemo && process.env.NEXT_PUBLIC_DATA_MODE === 'live' ? 'live' : 'demo';

  return (
    <AppShell page={page} mode={mode}>
      {blocked ? <AreaRestricted page={page} /> : children}
    </AppShell>
  );
}

// Layout persistente: o AppShell (sidebar, topbar) monta uma única vez e
// sobrevive à navegação entre as páginas do grupo — só o conteúdo interno
// troca, em vez de remontar sidebar/topbar a cada clique de menu.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>{children}</Shell>
  );
}
