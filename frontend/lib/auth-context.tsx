'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { resolveApiBaseUrl } from './contracts';
import { readApiError } from './api-errors';
import { hasPermission, type PermissionSession, type Role } from './permissions';
import { DEMO_ROOT_USERNAME, demoAdminStore, demoSessionFor } from './demo-permissions';
import { subscribeRealtime } from './realtime';
import { toast } from '@/components/ui/toast';
import {
  caminhoInterno,
  isDemoLoginAllowed,
  isProtectedApiUrl,
  shouldAttachSessionToken,
} from './session-guard';

export { caminhoInterno } from './session-guard';

export type StatusPreset = 'disponivel' | 'ocupado' | 'reuniao' | 'focado' | 'almoco' | 'ausente';

export interface User {
  id: number;
  username: string;
  nome: string;
  email: string;
  setor: string;
  /** Perfil: Admin (acesso total), Gestor ou User. O acesso real vem das permissões. */
  role: Role;
  /** Admin raiz: não pode ser rebaixado, excluído nem alterado por terceiros. */
  is_root?: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'blocked';
  permissoes?: string[];
  criado_em?: string;
  atualizado_em?: string;
  foto_perfil?: string | null;
  status_presenca?: string | null;
  status_preset?: StatusPreset | null;
}

export interface ChangeRequest {
  id: number;
  usuario_id: number;
  tipo: 'username' | 'email';
  valor_atual: string;
  valor_novo: string;
  status: 'pending' | 'approved' | 'rejected';
  solicitado_em: string;
  revisado_por?: number | null;
  revisado_em?: string | null;
  usuario_nome?: string;
}

export interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  pendingCount: number;
  /** Permissões efetivas da sessão ("<aba>:<acao>"; Admin = catálogo inteiro). */
  permissions: string[];
  /** Papel + permissões para as regras de lib/areas.ts e lib/permissions.ts. */
  session: PermissionSession | null;
  /** A sessão pode usar a chave? (Admin sempre.) */
  can: (key: string) => boolean;
  /** Relê GET /api/auth/me (perfil e permissões). 401 → login. */
  refreshSession: () => Promise<void>;
  login: (login: string, senha: string) => Promise<void>;
  /** Entra no modo demo com um dos perfis de lib/demo-permissions.ts (padrão: Admin ROOT). */
  loginDemo: (username?: string) => void;
  isDemoMode: boolean;
  register: (data: { nome: string; email: string; setor: string; senha: string }) => Promise<{ message: string }>;
  logout: () => Promise<void>;
  refreshPendingCount: () => Promise<void>;
  updateProfile: (profile: {
    foto_perfil?: string | null;
    status_presenca?: string | null;
    status_preset?: StatusPreset | null;
    nome?: string;
  }) => Promise<void>;
  apiBaseUrl: string;
  pendingChangeRequests: ChangeRequest[];
  checkUsernameAvailable: (username: string) => Promise<boolean>;
  checkEmailAvailable: (email: string) => Promise<boolean>;
  requestUsernameChange: (novoUsername: string) => Promise<void>;
  requestEmailChange: (novoEmail: string) => Promise<void>;
  changePassword: (senhaAtual: string, novaSenha: string) => Promise<void>;
}

interface MeResponse {
  user: User;
  /** Permissões efetivas (Admin = catálogo inteiro). */
  permissions?: string[];
  sessionId?: string;
  pendingChangeRequests?: ChangeRequest[];
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_STORAGE_KEY = 'norvia_session_token';
// Perfil demo escolhido no login (só modo demo; ver lib/demo-permissions.ts).
const DEMO_PROFILE_STORAGE_KEY = 'norvia_demo_profile';

function readDemoProfile(): string {
  try {
    return localStorage.getItem(DEMO_PROFILE_STORAGE_KEY) || DEMO_ROOT_USERNAME;
  } catch {
    return DEMO_ROOT_USERNAME;
  }
}

/** Usuário + permissões da sessão demo (perfil guardado no login). */
function demoSession(username: string): { user: User; permissions: string[] } {
  const s = demoSessionFor(username) ?? demoSessionFor(DEMO_ROOT_USERNAME)!;
  const { grants, ...profile } = s.user;
  const stored = getStoredProfile(profile.id);
  return {
    user: {
      ...profile,
      permissoes: grants,
      foto_perfil: stored?.foto_perfil ?? null,
      status_presenca: stored?.status_presenca ?? 'Disponível',
      status_preset: stored?.status_preset ?? 'disponivel',
      nome: stored?.nome ?? profile.nome,
    },
    permissions: s.permissions,
  };
}

/** Evento disparado pelo interceptor quando o gateway responde 403 por falta de permissão. */
const FORBIDDEN_EVENT = 'norvia:forbidden';
const PROFILE_STORAGE_KEY_PREFIX = 'norvia_user_profile_';

function getStoredProfile(userId: number): Partial<User> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${PROFILE_STORAGE_KEY_PREFIX}${userId}`);
    return raw ? (JSON.parse(raw) as Partial<User>) : null;
  } catch {
    return null;
  }
}

function saveStoredProfile(userId: number, profile: Partial<User>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${PROFILE_STORAGE_KEY_PREFIX}${userId}`, JSON.stringify(profile));
  } catch {}
}

export function getApiBaseUrl(): string {
  return resolveApiBaseUrl();
}

export function isLoginRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  const clean = pathname.replace(/\/$/, '');
  return clean === '/login' || clean.endsWith('/login');
}

// Endereço que o usuário tentava abrir quando caiu no login (ex.: um link de notificação
// apontando para uma tela interna): depois de entrar ele volta
// para lá em vez do Início. Só caminhos internos ("/…"), nunca outro site.
const DESTINO_APOS_LOGIN_KEY = 'norvia-destino-apos-login';

export function lembrarDestinoAposLogin(caminho: string | null): void {
  if (typeof window === 'undefined' || !caminho || caminho === '/' || isLoginRoute(caminho)) return;
  try {
    const destino = caminhoInterno(`${caminho}${window.location.search}`);
    if (destino) sessionStorage.setItem(DESTINO_APOS_LOGIN_KEY, destino);
  } catch {
    // sem sessionStorage: volta para o Início, como antes
  }
}

/** Para onde ir depois do login. Fica guardado até a página de destino abrir (ver esquecerDestinoAposLogin). */
export function destinoAposLogin(): string {
  try {
    return caminhoInterno(sessionStorage.getItem(DESTINO_APOS_LOGIN_KEY)) ?? '/';
  } catch {
    return '/';
  }
}

export function esquecerDestinoAposLogin(): void {
  try {
    sessionStorage.removeItem(DESTINO_APOS_LOGIN_KEY);
  } catch {
    // nada a limpar
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Demo permitido neste navegador? (build demo ou localhost — ver session-guard.ts) */
function demoAllowedHere(): boolean {
  return isDemoLoginAllowed(
    process.env.NEXT_PUBLIC_DATA_MODE,
    typeof window !== 'undefined' ? window.location.hostname : undefined,
  );
}

// Interceptor global: injeta o token de sessão SÓ nas chamadas à API do gateway (FE-02) e
// manda para o login quando uma rota protegida responde 401 com token salvo (sessão morta
// no meio da navegação). Só o 401 do próprio gateway desloga: 403 é falta de permissão e
// 502 ("falha de autenticação entre o gateway e a automação") é problema de servidor.
type InterceptedWindow = Window & { __norvia_fetch_intercepted?: boolean };

function setupGlobalFetchInterceptor() {
  if (typeof window !== 'undefined' && !(window as InterceptedWindow).__norvia_fetch_intercepted) {
    const originalFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const storedToken = readStoredToken();
      const url = requestUrl(input);
      const toApi = shouldAttachSessionToken(url, resolveApiBaseUrl(), window.location.origin);
      if (storedToken && toApi) {
        // Request com headers próprios e sem init.headers: parte deles para não descartá-los.
        const baseHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
        const headers = new Headers(baseHeaders);
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${storedToken}`);
        }
        if (!headers.has('x-session-token')) {
          headers.set('x-session-token', storedToken);
        }
        init = { ...init, headers };
      }

      const response = await originalFetch(input, init);

      if (
        response.status === 401 &&
        toApi &&
        storedToken &&
        storedToken !== 'mock-demo-token' &&
        !isLoginRoute(window.location.pathname) &&
        isProtectedApiUrl(url)
      ) {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
        const atual = window.location.pathname;
        lembrarDestinoAposLogin(basePath && atual.startsWith(basePath) ? atual.slice(basePath.length) || '/' : atual);
        // window.location (ao contrário do router do Next) não conhece o basePath
        // configurado (/automacoes) — sem o prefixo manual aqui, o navegador cai
        // fora do basePath e o servidor devolve a página de aviso "did you mean
        // /automacoes/login instead?" em vez de navegar para o login de verdade.
        window.location.href = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/login`;
      }

      // 403 de permissão (code "forbidden"): não desloga; o AuthProvider avisa e relê /api/auth/me
      // (as permissões podem ter mudado no meio da navegação).
      if (response.status === 403 && toApi && storedToken && isProtectedApiUrl(url)) {
        void response
          .clone()
          .json()
          .then((body: unknown) => {
            const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
            if (code === 'forbidden') window.dispatchEvent(new CustomEvent(FORBIDDEN_EVENT));
          })
          .catch(() => {
            // corpo não-JSON: não é o 403 de permissão do gateway
          });
      }

      return response;
    };
    (window as InterceptedWindow).__norvia_fetch_intercepted = true;
  }
}

// Executa imediatamente na inicialização do bundle no navegador
setupGlobalFetchInterceptor();

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingChangeRequests, setPendingChangeRequests] = useState<ChangeRequest[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [sessionCheckFailed, setSessionCheckFailed] = useState(false);
  const [sessionRetryCount, setSessionRetryCount] = useState(0);
  const router = useRouter();
  const pathname = usePathname();

  const apiBaseUrl = getApiBaseUrl();

  const isDemoMode = process.env.NEXT_PUBLIC_DATA_MODE === 'demo' || token === 'mock-demo-token';

  // Garante a instalação do interceptor caso o componente seja montado
  useEffect(() => {
    setupGlobalFetchInterceptor();
  }, []);

  const refreshPendingCount = useCallback(async () => {
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!currentToken) return;
    if (currentToken === 'mock-demo-token') {
      const s = demoSession(readDemoProfile());
      setPendingCount(demoAdminStore.pendingCount({ id: s.user.id, role: s.user.role, permissions: s.permissions }));
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/admin/pending-count`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = (await res.json()) as { count?: number };
        setPendingCount(Number(data.count) || 0);
      }
    } catch {
      // ignora falhas de polling
    }
  }, [apiBaseUrl]);

  const loginDemo = useCallback((username: string = DEMO_ROOT_USERNAME) => {
    // FE-03: fora de localhost e de build demo, nada de sessão fictícia.
    if (!demoAllowedHere()) return;
    localStorage.setItem(TOKEN_STORAGE_KEY, 'mock-demo-token');
    try {
      localStorage.setItem(DEMO_PROFILE_STORAGE_KEY, username);
    } catch {
      // sem localStorage: fica o Admin ROOT
    }
    const s = demoSession(username);
    setUser(s.user);
    setPermissions(s.permissions);
    setToken('mock-demo-token');
    setPendingCount(demoAdminStore.pendingCount({ id: s.user.id, role: s.user.role, permissions: s.permissions }));
    setPendingChangeRequests([]);
    setIsLoading(false);
    router.push(destinoAposLogin());
  }, [router]);

  // Inicializa sessão verificando o token salvo
  useEffect(() => {
    async function loadUserSession() {
      const storedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!storedToken) {
        setIsLoading(false);
        if (!isLoginRoute(pathname)) {
          lembrarDestinoAposLogin(pathname);
          router.push('/login');
        }
        return;
      }

      // Se o usuário já está autenticado em memória com o mesmo token, a navegação entre abas
      // não deve disparar nova validação de rede nem travar a tela
      if (user && token === storedToken) {
        setIsLoading(false);
        return;
      }

      if (storedToken === 'mock-demo-token' && !demoAllowedHere()) {
        // Token fictício esquecido/forjado num host de produção: descarta e vai para o login.
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setIsLoading(false);
        if (!isLoginRoute(pathname)) {
          lembrarDestinoAposLogin(pathname);
          router.push('/login');
        }
        return;
      }

      if (storedToken === 'mock-demo-token') {
        const s = demoSession(readDemoProfile());
        setUser(s.user);
        setPermissions(s.permissions);
        setToken('mock-demo-token');
        setPendingCount(demoAdminStore.pendingCount({ id: s.user.id, role: s.user.role, permissions: s.permissions }));
        setPendingChangeRequests([]);
        setIsLoading(false);
        return;
      }

      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/me`, {
          headers: { Authorization: `Bearer ${storedToken}` },
        });

        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            throw new Error('Resposta inesperada do servidor ao validar a sessão (formato não é JSON).');
          }
          const data = (await res.json()) as MeResponse;
          const stored = getStoredProfile(data.user.id);
          const enrichedUser: User = {
            ...data.user,
            foto_perfil: stored?.foto_perfil ?? data.user.foto_perfil ?? null,
            status_presenca: stored?.status_presenca ?? data.user.status_presenca ?? 'Disponível',
            status_preset: stored?.status_preset ?? data.user.status_preset ?? 'disponivel',
            nome: stored?.nome ?? data.user.nome,
          };
          setUser(enrichedUser);
          setPermissions(Array.isArray(data.permissions) ? data.permissions : []);
          setToken(storedToken);
          setSessionCheckFailed(false);
          setPendingChangeRequests(data.pendingChangeRequests || []);
          if (hasPermission({ role: data.user.role, permissions: data.permissions ?? [] }, 'usuarios:ver')) {
            void refreshPendingCount();
          }
        } else if (res.status === 401 || res.status === 403) {
          // Token inválido ou expirado
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          setUser(null);
          setToken(null);
          setSessionCheckFailed(false);
          if (!isLoginRoute(pathname)) {
            lembrarDestinoAposLogin(pathname);
            router.push('/login');
          }
        } else if (res.status === 429) {
          // Rate limit temporário: se o usuário já estiver autenticado ou tiver token,
          // não trava a tela nem desloga
          console.warn('Rate limit atingido ao validar sessão (/api/auth/me). Mantendo sessão ativa.');
          if (!user) {
            setSessionCheckFailed(true);
          }
        } else {
          if (!user) {
            throw new Error(`O servidor respondeu com status ${res.status} ao validar a sessão.`);
          }
        }
      } catch (err) {
        // Falha de rede ou do servidor (ex.: Gateway fora do ar) não prova que o token é
        // inválido — remover a sessão aqui deslogaria o usuário por uma instabilidade
        // temporária.
        console.error('Falha ao validar sessão:', err);
        // Só exibe a tela cheia de erro se o usuário ainda NÃO possuía sessão ativa carregada
        if (!user) {
          setSessionCheckFailed(true);
        }
      } finally {
        setIsLoading(false);
      }
    }

    void loadUserSession();
  }, [apiBaseUrl, pathname, refreshPendingCount, router, sessionRetryCount, token, user]);

  const userRole = user?.role;
  const hasUser = Boolean(user);
  const session = useMemo<PermissionSession | null>(
    () => (userRole ? { role: userRole, permissions } : null),
    [userRole, permissions],
  );
  const can = useCallback((key: string) => hasPermission(session, key), [session]);

  // Relê perfil e permissões (evento SSE `session`, 403 de permissão). Mantém o que é só local
  // (foto, presença, nome editado) e manda para o login se a sessão foi encerrada (401).
  const refreshSession = useCallback(async () => {
    const currentToken = readStoredToken();
    if (!currentToken) return;
    if (currentToken === 'mock-demo-token') {
      const s = demoSession(readDemoProfile());
      setUser((prev) => (prev ? { ...prev, role: s.user.role, is_root: s.user.is_root, setor: s.user.setor } : prev));
      setPermissions(s.permissions);
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/me`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setUser(null);
        setToken(null);
        setPermissions([]);
        router.push('/login');
        return;
      }
      if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return;
      const data = (await res.json()) as MeResponse;
      const nextPermissions = Array.isArray(data.permissions) ? data.permissions : [];
      setUser((prev) =>
        prev
          ? {
              ...prev,
              ...data.user,
              foto_perfil: prev.foto_perfil,
              status_presenca: prev.status_presenca,
              status_preset: prev.status_preset,
              nome: prev.nome,
            }
          : prev,
      );
      setPermissions(nextPermissions);
      setPendingChangeRequests(data.pendingChangeRequests || []);
      if (hasPermission({ role: data.user.role, permissions: nextPermissions }, 'usuarios:ver')) {
        void refreshPendingCount();
      } else {
        setPendingCount(0);
      }
    } catch {
      // rede instável: mantém a sessão atual; o gateway continua barrando o que não pode
    }
  }, [apiBaseUrl, refreshPendingCount, router]);

  // 403 de permissão: avisa sem deslogar e relê a sessão (no máximo uma vez a cada 3 s).
  const lastForbiddenRef = useRef(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onForbidden = () => {
      const now = Date.now();
      if (now - lastForbiddenRef.current < 3000) return;
      lastForbiddenRef.current = now;
      toast.add({ title: 'Seu usuário não tem permissão para este recurso', type: 'error' });
      void refreshSession();
    };
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);
    return () => window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
  }, [refreshSession]);

  // Evento SSE `session`: perfil/permissões mudaram ou a sessão foi encerrada → relê /api/auth/me.
  useEffect(() => {
    if (!hasUser || isDemoMode) return;
    return subscribeRealtime(['session'], () => void refreshSession());
  }, [hasUser, isDemoMode, refreshSession]);

  const updateProfile = useCallback(async (updates: {
    foto_perfil?: string | null;
    status_presenca?: string | null;
    status_preset?: StatusPreset | null;
    nome?: string;
  }) => {
    setUser((prev) => {
      if (!prev) return null;
      const updated: User = {
        ...prev,
        ...(updates.foto_perfil !== undefined ? { foto_perfil: updates.foto_perfil } : {}),
        ...(updates.status_presenca !== undefined ? { status_presenca: updates.status_presenca } : {}),
        ...(updates.status_preset !== undefined ? { status_preset: updates.status_preset } : {}),
        ...(updates.nome !== undefined ? { nome: updates.nome } : {}),
      };
      saveStoredProfile(prev.id, {
        foto_perfil: updated.foto_perfil,
        status_presenca: updated.status_presenca,
        status_preset: updated.status_preset,
        nome: updated.nome,
      });
      return updated;
    });

    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (currentToken && currentToken !== 'mock-demo-token') {
      try {
        await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/profile`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentToken}`,
          },
          body: JSON.stringify(updates),
        });
      } catch {
        // Salvo localmente caso endpoint de backend não responda
      }
    }
  }, [apiBaseUrl]);

  const checkUsernameAvailable = useCallback(async (username: string): Promise<boolean> => {
    if (isDemoMode) return true;
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    try {
      const res = await fetch(
        `${apiBaseUrl.replace(/\/$/, '')}/api/auth/username-available?username=${encodeURIComponent(username)}`,
        { headers: { Authorization: `Bearer ${currentToken}` } },
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { available?: boolean };
      return Boolean(data.available);
    } catch {
      return false;
    }
  }, [apiBaseUrl, isDemoMode]);

  const checkEmailAvailable = useCallback(async (email: string): Promise<boolean> => {
    if (isDemoMode) return true;
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    try {
      const res = await fetch(
        `${apiBaseUrl.replace(/\/$/, '')}/api/auth/email-available?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${currentToken}` } },
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { available?: boolean };
      return Boolean(data.available);
    } catch {
      return false;
    }
  }, [apiBaseUrl, isDemoMode]);

  const requestUsernameChange = useCallback(async (novoUsername: string): Promise<void> => {
    if (isDemoMode) {
      const req: ChangeRequest = {
        id: Date.now(),
        usuario_id: user?.id ?? 0,
        tipo: 'username',
        valor_atual: user?.username ?? '',
        valor_novo: novoUsername,
        status: 'pending',
        solicitado_em: new Date().toISOString(),
      };
      setPendingChangeRequests((prev) => [req, ...prev]);
      return;
    }
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/change-username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({ novoUsername }),
    });
    if (!res.ok) throw new Error(await readApiError(res, 'Falha ao solicitar alteração de usuário'));
    const data = (await res.json()) as ChangeRequest;
    setPendingChangeRequests((prev) => [data, ...prev]);
  }, [apiBaseUrl, isDemoMode, user]);

  const requestEmailChange = useCallback(async (novoEmail: string): Promise<void> => {
    if (isDemoMode) {
      const req: ChangeRequest = {
        id: Date.now(),
        usuario_id: user?.id ?? 0,
        tipo: 'email',
        valor_atual: user?.email ?? '',
        valor_novo: novoEmail,
        status: 'pending',
        solicitado_em: new Date().toISOString(),
      };
      setPendingChangeRequests((prev) => [req, ...prev]);
      return;
    }
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/change-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({ novoEmail }),
    });
    if (!res.ok) throw new Error(await readApiError(res, 'Falha ao solicitar alteração de e-mail'));
    const data = (await res.json()) as ChangeRequest;
    setPendingChangeRequests((prev) => [data, ...prev]);
  }, [apiBaseUrl, isDemoMode, user]);

  const changePassword = useCallback(async (senhaAtual: string, novaSenha: string): Promise<void> => {
    if (isDemoMode) {
      return;
    }
    const currentToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({ senhaAtual, novaSenha }),
    });
    if (!res.ok) throw new Error(await readApiError(res, 'Falha ao trocar senha'));
  }, [apiBaseUrl, isDemoMode]);

  const login = async (email: string, pass: string) => {
    // Atalho offline (build demo, ou credenciais "demo" em localhost/127.0.0.1). Em produção
    // as mesmas credenciais seguem para o gateway como qualquer outra (FE-03).
    // No demo, "<perfil demo>" + senha "demo" entra com aquele perfil (ver lib/demo-permissions.ts).
    const demoProfile = demoSessionFor(email.trim()) ? email.trim() : undefined;
    if (
      demoAllowedHere() &&
      (process.env.NEXT_PUBLIC_DATA_MODE === 'demo' || email === 'demo' || (demoProfile !== undefined && pass === 'demo'))
    ) {
      loginDemo(demoProfile);
      return;
    }

    // Sem timeout no cliente: sob muitas tentativas o gateway atrasa a resposta (até ~8 s)
    // de propósito; a tela de login mostra o estado de carregamento enquanto isso.

    const targetUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/auth/login`;
    let res: Response;
    try {
      res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: email, email, senha: pass }),
      });
    } catch {
      throw new Error(
        `Não foi possível conectar ao servidor (${targetUrl}). Verifique sua conexão e se o Gateway está em execução.`
      );
    }

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        throw new Error(await readApiError(res, 'Erro ao realizar login'));
      }
      throw new Error(
        `Servidor retornou erro HTTP ${res.status} (${res.statusText || 'Não-JSON'}). Verifique se o serviço Gateway está em execução e se o Nginx está encaminhando para o Gateway.`
      );
    }

    let data: { token?: string; user?: User; permissions?: string[] } | null;
    try {
      data = (await res.json()) as { token?: string; user?: User; permissions?: string[] } | null;
    } catch {
      throw new Error('Falha ao interpretar resposta do servidor de login (formato inválido).');
    }

    if (!data?.token || !data?.user) {
      throw new Error('Resposta de login inválida: token ou usuário não informados pelo servidor.');
    }

    const loggedUser = data.user;
    const loggedPermissions = Array.isArray(data.permissions) ? data.permissions : [];
    localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
    setToken(data.token);
    const stored = getStoredProfile(loggedUser.id);
    const enrichedUser: User = {
      ...loggedUser,
      foto_perfil: stored?.foto_perfil ?? loggedUser.foto_perfil ?? null,
      status_presenca: stored?.status_presenca ?? loggedUser.status_presenca ?? 'Disponível',
      status_preset: stored?.status_preset ?? loggedUser.status_preset ?? 'disponivel',
      nome: stored?.nome ?? loggedUser.nome,
    };
    setUser(enrichedUser);
    setPermissions(loggedPermissions);
    setPendingChangeRequests([]);

    if (hasPermission({ role: loggedUser.role, permissions: loggedPermissions }, 'usuarios:ver')) {
      void refreshPendingCount();
    }

    router.push(destinoAposLogin());
  };

  const register = async (formData: { nome: string; email: string; setor: string; senha: string }) => {
    const targetUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/auth/register`;
    let res: Response;
    try {
      res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
    } catch {
      throw new Error(
        `Não foi possível conectar ao servidor (${targetUrl}). Verifique se o Gateway está em execução.`
      );
    }

    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        throw new Error(await readApiError(res, 'Erro ao criar conta'));
      }
      throw new Error(
        `Servidor retornou erro HTTP ${res.status} (${res.statusText || 'Não-JSON'}). Verifique se o serviço Gateway está ativo.`
      );
    }

    // O gateway responde a mesma mensagem neutra para cadastro novo ou e-mail já existente
    // (não revela quem tem conta): não presumir que um cadastro foi criado.
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    return {
      message: data?.message || 'Cadastro recebido! Aguarde a aprovação do administrador para acessar a plataforma.',
    };
  };

  const logout = async () => {
    const currentToken = token || localStorage.getItem(TOKEN_STORAGE_KEY);
    if (currentToken) {
      try {
        await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${currentToken}` },
        });
      } catch {}
    }

    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setUser(null);
    setToken(null);
    setPermissions([]);
    router.push('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        pendingCount,
        permissions,
        session,
        can,
        refreshSession,
        login,
        loginDemo,
        isDemoMode,
        register,
        logout,
        refreshPendingCount,
        updateProfile,
        apiBaseUrl,
        pendingChangeRequests,
        checkUsernameAvailable,
        checkEmailAvailable,
        requestUsernameChange,
        requestEmailChange,
        changePassword,
      }}
    >
      {isLoading && !isLoginRoute(pathname) ? (
        <div className="flex min-h-screen w-full items-center justify-center bg-slate-950 text-slate-300">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            <span className="text-xs text-slate-400 font-medium tracking-wide">Validando autenticação...</span>
          </div>
        </div>
      ) : sessionCheckFailed && !isLoginRoute(pathname) ? (
        <div className="flex min-h-screen w-full items-center justify-center bg-slate-950 text-slate-300">
          <div className="flex flex-col items-center gap-3 max-w-sm text-center px-4">
            <span className="text-sm font-semibold text-amber-400">
              Não foi possível verificar sua sessão
            </span>
            <span className="text-xs text-slate-400">
              Verifique se o servidor Gateway está no ar e sua conexão com a rede, depois tente novamente.
            </span>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => {
                  setSessionCheckFailed(false);
                  setIsLoading(true);
                  setSessionRetryCount((n) => n + 1);
                }}
                className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-1.5 cursor-pointer"
              >
                Tentar novamente
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem(TOKEN_STORAGE_KEY);
                  setSessionCheckFailed(false);
                  router.push('/login');
                }}
                className="rounded-md border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs font-semibold px-3 py-1.5 cursor-pointer"
              >
                Ir para login
              </button>
            </div>
          </div>
        </div>
      ) : !user && !isLoginRoute(pathname) ? (
        <div className="flex min-h-screen w-full items-center justify-center bg-slate-950 text-slate-300">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            <span className="text-xs text-slate-400 font-medium tracking-wide">Redirecionando para login...</span>
          </div>
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser utilizado dentro de um AuthProvider');
  }
  return context;
}
