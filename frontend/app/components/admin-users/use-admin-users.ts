'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { createAdminUsersService } from '@/lib/admin-users-service';
import type { AdminChangeRequest, AdminSession, AdminUserView } from '@/lib/admin-users-contracts';
import type { PermissionCatalog, PolicyActor } from '@/lib/permissions';

export type LoadState = 'loading' | 'error' | 'ready';

/**
 * Dados da Gestão de Usuários: serviço (real ou demo), listas, catálogo de permissões e recargas.
 * Cada carga cancela a anterior (AbortController) e descarta o que chegar depois de cancelada.
 */
export function useAdminUsers() {
  const { user, token, isDemoMode, permissions, refreshPendingCount } = useAuth();

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

  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [changeRequests, setChangeRequests] = useState<AdminChangeRequest[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const listRef = useRef<AbortController | null>(null);
  const catalogRef = useRef<AbortController | null>(null);

  // Busca (sem estado) e aplicação (com estado) separadas: o efeito inicial aplica no `.then`.
  const fetchCatalog = useCallback(
    async (signal: AbortSignal) => (service ? service.catalog(signal) : null),
    [service],
  );
  const applyCatalog = useCallback((res: Awaited<ReturnType<typeof fetchCatalog>>, signal: AbortSignal) => {
    if (!res || signal.aborted) return;
    setCatalogError(res.ok ? null : res.error.message);
    if (res.ok) setCatalog(res.data);
  }, []);
  const loadCatalog = useCallback(async () => {
    catalogRef.current?.abort();
    const controller = new AbortController();
    catalogRef.current = controller;
    applyCatalog(await fetchCatalog(controller.signal), controller.signal);
  }, [applyCatalog, fetchCatalog]);

  const fetchAll = useCallback(
    async (signal: AbortSignal) =>
      service
        ? Promise.all([service.listUsers(signal), service.listSessions(signal), service.listChangeRequests(signal)])
        : null,
    [service],
  );
  const applyAll = useCallback(
    (result: Awaited<ReturnType<typeof fetchAll>>, signal: AbortSignal) => {
      if (!result || signal.aborted) return;
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
  const refreshAll = useCallback(async () => {
    listRef.current?.abort();
    const controller = new AbortController();
    listRef.current = controller;
    applyAll(await fetchAll(controller.signal), controller.signal);
  }, [applyAll, fetchAll]);

  useEffect(() => {
    const lista = new AbortController();
    const cat = new AbortController();
    listRef.current = lista;
    catalogRef.current = cat;
    void fetchAll(lista.signal).then((r) => applyAll(r, lista.signal));
    void fetchCatalog(cat.signal).then((r) => applyCatalog(r, cat.signal));
    return () => {
      lista.abort();
      cat.abort();
    };
  }, [fetchAll, applyAll, fetchCatalog, applyCatalog]);

  const reloadNow = useCallback(
    (showSkeleton = false) => {
      if (showSkeleton) setLoadState('loading');
      setRefreshing(true);
      void refreshAll();
    },
    [refreshAll],
  );

  return {
    actor,
    service,
    users,
    setUsers,
    sessions,
    changeRequests,
    loadState,
    loadError,
    refreshing,
    catalog,
    catalogError,
    loadCatalog,
    refreshAll,
    reloadNow,
  };
}
