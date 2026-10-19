'use client';

import { resolveApiBaseUrl } from './contracts';

/**
 * Cliente do canal de eventos em tempo real do gateway (`GET /api/events`, SSE).
 *
 * Usa fetch + leitura do stream em vez de `EventSource` porque o EventSource não envia o
 * header Authorization — e colocar o token de sessão na URL faria ele aparecer nos logs de
 * acesso do NGINX. Os eventos não trazem dados, só avisam "recarregue X"; quem assina
 * continua buscando pelas rotas REST normais.
 *
 * Uma única conexão por aba, aberta enquanto houver alguém inscrito. `reconnected` é
 * emitido a cada (re)conexão para os inscritos buscarem o que mudou enquanto o canal
 * estava fora. Enquanto conectado, os pollings de fallback podem pular seus ciclos
 * (`isRealtimeConnected`).
 */
// `session`: perfil/permissões do próprio usuário mudaram (ou a sessão foi encerrada) — relê /api/auth/me.
export type RealtimeEvent = 'notification' | 'chat' | 'incidents' | 'session' | 'reconnected';

const TOKEN_STORAGE_KEY = 'norvia_session_token';
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

const listeners = new Map<RealtimeEvent, Set<() => void>>();
let subscriberCount = 0;
let connected = false;
let controller: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = MIN_RETRY_MS;

function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function emit(type: RealtimeEvent) {
  for (const cb of listeners.get(type) ?? []) {
    try {
      cb();
    } catch {
      // um inscrito com erro não derruba os outros
    }
  }
}

/** Extrai os nomes de evento de um bloco SSE ("event: chat\ndata: {}"). */
export function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  const events: string[] = [];
  for (const block of blocks) {
    const line = block.split(/\r?\n/).find((l) => l.startsWith('event:'));
    if (line) events.push(line.slice('event:'.length).trim());
  }
  return { events, rest };
}

function scheduleReconnect() {
  if (subscriberCount === 0 || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

async function connect() {
  const token = readToken();
  if (!token || token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo') return;
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const res = await fetch(`${resolveApiBaseUrl().replace(/\/$/, '')}/api/events`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event === 'ready') {
          connected = true;
          retryMs = MIN_RETRY_MS;
          emit('reconnected');
        } else if (event === 'notification' || event === 'chat' || event === 'incidents' || event === 'session') {
          emit(event);
        }
      }
    }
  } catch {
    // rede caiu, sessão expirou ou abort — tratado abaixo
  } finally {
    connected = false;
    if (!signal.aborted) scheduleReconnect();
  }
}

function start() {
  if (typeof window === 'undefined' || controller) return;
  void connect();
}

function stop() {
  controller?.abort();
  controller = null;
  connected = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryMs = MIN_RETRY_MS;
}

export function isRealtimeConnected(): boolean {
  return connected;
}

export function subscribeRealtime(types: RealtimeEvent[], callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  for (const type of types) {
    const set = listeners.get(type) ?? new Set();
    set.add(callback);
    listeners.set(type, set);
  }
  subscriberCount++;
  if (subscriberCount === 1) start();
  return () => {
    for (const type of types) listeners.get(type)?.delete(callback);
    subscriberCount--;
    if (subscriberCount === 0) stop();
  };
}
