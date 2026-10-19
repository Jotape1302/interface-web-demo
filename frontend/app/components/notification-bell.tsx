'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, ClipboardList, PackageSearch, Ruler, Users, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/lib/auth-context';
import { caminhoInterno } from '@/lib/session-guard';
import { formatDateTimeBR } from '@/lib/formatters';
import { makeDemoNotifications, makeDemoOperationalPanel } from '@/lib/demo';
import { useDataPolling } from '@/lib/use-data-polling';
import { PAGE_HREF, canAccessPage, type PageId } from '@/lib/areas';

interface NotificationItem {
  id: number;
  destinatario_id: number;
  tipo: string;
  titulo: string;
  mensagem?: string | null;
  link?: string | null;
  lida: boolean;
  criado_em: string;
}

interface OperationalItem {
  label: string;
  count: number;
  href: string;
}

const UNREAD_POLL_MS = 45_000;

export default function NotificationBell() {
  const { user, token, apiBaseUrl, isDemoMode, session, can } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [operational, setOperational] = useState<OperationalItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchUnreadCount = useCallback(async (signal?: AbortSignal) => {
    if (!user) return;
    if (isDemoMode) {
      setUnreadCount(makeDemoNotifications(session).filter((n: NotificationItem) => !n.lida).length);
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/notifications/unread-count`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { count?: number };
        setUnreadCount(Number(data.count) || 0);
      }
    } catch {
      // ignora falha de polling
    }
  }, [user, isDemoMode, apiBaseUrl, token, session]);

  useDataPolling(
    (signal) => fetchUnreadCount(signal),
    {
      intervalMs: UNREAD_POLL_MS,
      enabled: Boolean(user),
      pauseOnHidden: true,
      refetchOnVisible: true,
      realtimeEvents: !isDemoMode ? ['notification', 'reconnected'] : undefined,
      skipWhenRealtimeConnected: true,
    },
  );

  const loadPanel = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      if (isDemoMode) {
        setNotifications(makeDemoNotifications(session));
        setOperational(makeDemoOperationalPanel(session));
        return;
      }

      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/notifications?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setNotifications((await res.json()) as NotificationItem[]);
      }

      const items: OperationalItem[] = [];

      // 1. Gestão de Usuários (Admin ou Gestor com acesso): cadastros/alterações pendentes
      if (can('usuarios:ver')) {
        try {
          const pendingRes = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/admin/pending-count`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (pendingRes.ok) {
            const data = (await pendingRes.json()) as { count?: number };
            const count = data.count ?? 0;
            if (count > 0) {
              items.push({
                label: `${count} cadastro${count > 1 ? 's' : ''} ou alteração(ões) pendente${count > 1 ? 's' : ''}`,
                count,
                href: '/admin/usuarios?tab=pending',
              });
            }
          }
        } catch {
          // painel operacional é best-effort
        }
      }

      // 2. Quem vê a Revisão NF-e: notas fiscais pendentes de revisão
      if (can('revisao_nfe:ver')) {
        try {
          const pendingRes = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/danfe/pending-review`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (pendingRes.ok) {
            const data = (await pendingRes.json()) as { pending?: unknown[] };
            const count = data.pending?.length ?? 0;
            if (count > 0) {
              items.push({
                label: `${count} nota${count > 1 ? 's' : ''} pendente${count > 1 ? 's' : ''} de revisão`,
                count,
                href: '/danfe-tiny',
              });
            }
          }
        } catch {
          // painel operacional é best-effort
        }
      }

      // 3. Quem vê a Contagem de estoque (não-admin): atalho
      if (user.role !== 'admin' && can('contagem_estoque:ver')) {
        items.push({
          label: 'Acessar Contagem de Estoque',
          count: 0,
          href: '/contagem-estoque',
        });
      }

      // 4. Quem vê a Padronização de dimensões (não-admin): atalho
      if (user.role !== 'admin' && can('dimensoes:ver')) {
        items.push({
          label: 'Acessar Padronização de Dimensões',
          count: 0,
          href: '/padronizacao-dimensoes',
        });
      }

      setOperational(items);
    } finally {
      setLoading(false);
    }
  }, [user, isDemoMode, apiBaseUrl, token, session, can]);

  useEffect(() => {
    if (open) void loadPanel();
  }, [open, loadPanel]);

  const handleMarkRead = async (notification: NotificationItem) => {
    if (!notification.lida) {
      setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, lida: true } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
      if (!isDemoMode) {
        try {
          await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/notifications/${notification.id}/read`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch {
          // otimista — se falhar, o próximo fetch reconcilia
        }
      }
    }
    if (notification.link) {
      let target = notification.link.trim();
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      if (basePath && (target === basePath || target.startsWith(`${basePath}/`))) {
        target = target.slice(basePath.length) || '/';
      }
      // FE-09: só navega para telas internas ("/…"); link externo, "//host", "/\\host" ou
      // "javascript:" vindo do banco é ignorado.
      const interno = caminhoInterno(target);
      if (!interno) {
        setOpen(false);
        return;
      }
      target = interno;
      // Link para uma aba que a sessão não vê: não navega (a página mostraria "sem acesso").
      const path = target.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
      const page = (Object.keys(PAGE_HREF) as Array<keyof typeof PAGE_HREF>).find((p) => PAGE_HREF[p] === path);
      if (page && !canAccessPage(session, page as PageId)) {
        setOpen(false);
        return;
      }
      setOpen(false);
      router.push(target);
    }
  };

  const handleMarkAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, lida: true })));
    setUnreadCount(0);
    if (!isDemoMode) {
      try {
        await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/notifications/read-all`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // idem
      }
    }
  };

  if (!user) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={`Notificações${unreadCount > 0 ? ` (${unreadCount} não lidas)` : ''}`}
            title="Notificações"
          >
            <Bell size={17} />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0 shadow-lg border-border bg-popover z-50">
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/60">
          <span className="text-xs font-bold text-foreground uppercase tracking-wider">Notificações</span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void handleMarkAllRead()}
              className="flex items-center gap-1 text-[11px] text-primary hover:underline cursor-pointer"
            >
              <CheckCheck size={12} />
              Marcar tudo como lido
            </button>
          )}
        </div>

        {operational.length > 0 && (
          <div className="px-3.5 py-2.5 border-b border-border/60 space-y-1.5 bg-muted/20">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Painel operacional
            </span>
            {operational.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(item.href);
                }}
                className="flex items-center gap-2 w-full text-left text-xs text-foreground hover:text-primary transition cursor-pointer"
              >
                {item.href.startsWith('/admin') ? (
                  <Users size={13} className="shrink-0" />
                ) : item.href === '/danfe-tiny' ? (
                  <ClipboardList size={13} className="shrink-0" />
                ) : item.href === '/contagem-estoque' ? (
                  <PackageSearch size={13} className="shrink-0" />
                ) : item.href === '/padronizacao-dimensoes' ? (
                  <Ruler size={13} className="shrink-0" />
                ) : (
                  <Wallet size={13} className="shrink-0" />
                )}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="max-h-80 overflow-y-auto">
          {loading && notifications.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-xs text-muted-foreground">Carregando...</div>
          ) : notifications.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-xs text-muted-foreground">
              Nenhuma notificação por aqui.
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void handleMarkRead(n)}
                className={`flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left border-b border-border/40 last:border-0 transition cursor-pointer hover:bg-muted/40 ${
                  n.lida ? '' : 'bg-[var(--marca-ambar-suave)]'
                }`}
              >
                <span className="flex items-center gap-1.5 w-full">
                  {!n.lida && <span className="h-1.5 w-1.5 rounded-full bg-[var(--marca-ambar)] shrink-0" />}
                  <span className={`text-xs flex-1 truncate ${n.lida ? 'text-foreground' : 'font-semibold text-foreground'}`}>
                    {n.titulo}
                  </span>
                </span>
                {n.mensagem && <span className="text-[11px] text-muted-foreground pl-3">{n.mensagem}</span>}
                <span className="text-[10px] text-muted-foreground pl-3 font-mono">{formatDateTimeBR(n.criado_em)}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
