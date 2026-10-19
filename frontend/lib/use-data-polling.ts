'use client';

import { useEffect, useRef, useCallback } from 'react';
import { subscribeRealtime, isRealtimeConnected, type RealtimeEvent } from './realtime';

export type { RealtimeEvent };

export interface DataPollerConfig<T> {
  fetcher: (signal: AbortSignal) => Promise<T>;
  intervalMs?: number;
  enabled?: boolean;
  pauseOnHidden?: boolean;
  refetchOnVisible?: boolean;
  realtimeEvents?: RealtimeEvent[];
  skipWhenRealtimeConnected?: boolean;
  onError?: (error: unknown) => void;

  // Injetáveis para testes determinísticos e abstração SSR
  getVisibilityState?: () => 'visible' | 'hidden';
  addVisibilityListener?: (listener: () => void) => () => void;
  subscribeRealtimeFn?: typeof subscribeRealtime;
  isRealtimeConnectedFn?: typeof isRealtimeConnected;
  setIntervalFn?: (cb: () => void, ms: number) => any;
  clearIntervalFn?: (id: any) => void;
}

/**
 * Motor central de polling de dados, desacoplado do ciclo de vida React.
 * Gerencia timers com segurança, suspensão em aba oculta, ciclo de vida de AbortController
 * e sincronização orientada a eventos SSE do Gateway.
 */
export class DataPoller<T> {
  private config: DataPollerConfig<T>;
  private controller: AbortController | null = null;
  private intervalTimerId: any = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private unsubscribeRealtime: (() => void) | null = null;
  private isExecuting = false;
  private destroyed = false;
  private isTabVisible = true;

  constructor(config: DataPollerConfig<T>) {
    this.config = { ...config };
    this.isTabVisible = this.resolveVisibilityState() === 'visible';
  }

  private resolveVisibilityState(): 'visible' | 'hidden' {
    if (this.config.getVisibilityState) {
      return this.config.getVisibilityState();
    }
    if (typeof document !== 'undefined' && typeof document.visibilityState !== 'undefined') {
      return document.visibilityState;
    }
    return 'visible';
  }

  /**
   * Inicia o ciclo do poller:
   * 1. Registra ouvintes de visibilidade de aba;
   * 2. Registra assinaturas SSE se configuradas;
   * 3. Dispara a carga inicial se habilitado;
   * 4. Inicia o temporizador periódico.
   */
  public start(): void {
    if (this.destroyed) return;

    this.setupVisibilityListener();
    this.setupRealtimeListener();

    if (this.config.enabled !== false) {
      void this.executeFetch();
      this.armInterval();
    }
  }

  private setupVisibilityListener(): void {
    if (this.unsubscribeVisibility) return;

    const onVisibilityChange = () => {
      if (this.destroyed) return;
      const state = this.resolveVisibilityState();
      const becameVisible = state === 'visible' && !this.isTabVisible;
      const becameHidden = state === 'hidden' && this.isTabVisible;
      this.isTabVisible = state === 'visible';

      if (this.config.pauseOnHidden !== false) {
        if (becameHidden) {
          this.disarmInterval();
        } else if (becameVisible) {
          this.armInterval();
          if (this.config.refetchOnVisible !== false && this.config.enabled !== false) {
            void this.executeFetch();
          }
        }
      }
    };

    if (this.config.addVisibilityListener) {
      this.unsubscribeVisibility = this.config.addVisibilityListener(onVisibilityChange);
    } else if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      this.unsubscribeVisibility = () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    }
  }

  private setupRealtimeListener(): void {
    if (this.unsubscribeRealtime) return;
    const events = this.config.realtimeEvents;
    if (!events || events.length === 0) return;

    const sub = this.config.subscribeRealtimeFn ?? subscribeRealtime;
    this.unsubscribeRealtime = sub(events, () => {
      if (this.destroyed || this.config.enabled === false) return;
      // Evento SSE do Gateway indica que os dados mudaram no servidor
      void this.refresh();
    });
  }

  private armInterval(): void {
    this.disarmInterval();
    const intervalMs = this.config.intervalMs;
    if (!intervalMs || intervalMs <= 0 || this.config.enabled === false) return;
    if (this.config.pauseOnHidden !== false && !this.isTabVisible) return;

    const setInt = this.config.setIntervalFn ?? setInterval;
    this.intervalTimerId = setInt(() => {
      if (this.destroyed || this.config.enabled === false) return;

      // Se configurado para pular polling quando o SSE está conectado e saudável
      if (this.config.skipWhenRealtimeConnected && (this.config.isRealtimeConnectedFn ?? isRealtimeConnected)()) {
        return;
      }

      // Se a aba estiver oculta e configurado para pausar
      if (this.config.pauseOnHidden !== false && this.resolveVisibilityState() === 'hidden') {
        this.disarmInterval();
        return;
      }

      // Se uma busca já estiver em curso, pula este ciclo de intervalo para não engarrafar
      if (this.isExecuting) return;

      void this.executeFetch();
    }, intervalMs);
  }

  private disarmInterval(): void {
    if (this.intervalTimerId !== null) {
      (this.config.clearIntervalFn ?? clearInterval)(this.intervalTimerId);
      this.intervalTimerId = null;
    }
  }

  /**
   * Executa a busca de dados. Cancela qualquer requisição anterior pendente via AbortController.
   */
  private async executeFetch(): Promise<void> {
    if (this.destroyed) return;

    // Cancela requisição anterior em voo
    if (this.controller) {
      this.controller.abort();
    }

    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    this.isExecuting = true;

    try {
      await this.config.fetcher(signal);
    } catch (err) {
      if (signal.aborted || this.destroyed) return;

      // Ignora AbortError (nativo ou não)
      if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError') {
        return;
      }

      this.config.onError?.(err);
    } finally {
      if (!signal.aborted && !this.destroyed) {
        this.isExecuting = false;
      }
    }
  }

  /**
   * Dispara atualização imediata forçada (ex: clique do usuário, retorno de aba ou evento SSE),
   * abortando a requisição anterior e reiniciando a contagem do intervalo.
   */
  public async refresh(): Promise<void> {
    if (this.destroyed || this.config.enabled === false) return;
    this.armInterval();
    await this.executeFetch();
  }

  public isIntervalActive(): boolean {
    return this.intervalTimerId !== null;
  }

  public isVisible(): boolean {
    return this.isTabVisible;
  }

  /**
   * Destrói completamente o poller, cancelando requisições ativas, limpando timers e listeners.
   */
  public destroy(): void {
    this.destroyed = true;
    this.isExecuting = false;

    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }

    this.disarmInterval();

    if (this.unsubscribeVisibility) {
      this.unsubscribeVisibility();
      this.unsubscribeVisibility = null;
    }

    if (this.unsubscribeRealtime) {
      this.unsubscribeRealtime();
      this.unsubscribeRealtime = null;
    }
  }
}

export interface UseDataPollingOptions {
  /** Intervalo em milissegundos entre coletas periódicas. */
  intervalMs?: number;
  /** Se o polling está habilitado. Padrão: true. */
  enabled?: boolean;
  /** Pausar periodicidade quando a aba do navegador for ocultada. Padrão: true. */
  pauseOnHidden?: boolean;
  /** Disparar busca imediata ao retornar para a aba ativa. Padrão: true. */
  refetchOnVisible?: boolean;
  /** Eventos SSE do Gateway (`/api/events`) que invalidam o cache e disparam re-fetch imediato. */
  realtimeEvents?: RealtimeEvent[];
  /** Pular polling periódico enquanto a conexão SSE estiver ativa e saudável. Padrão: false. */
  skipWhenRealtimeConnected?: boolean;
}

/**
 * Hook universal de polling de dados do frontend Norvia.
 *
 * O `fetcher` aplica o resultado no estado do próprio componente — o hook não guarda
 * dados nem estado de loading, para não re-renderizar o componente a cada ciclo.
 *
 * Garante:
 * - Cancelamento seguro de requisições pendentes via AbortController no unmount e entre ciclos;
 * - Suspensão do polling enquanto a aba estiver oculta (`document.visibilityState === 'hidden'`);
 * - Atualização imediata ao reativar a aba (`refetchOnVisible`);
 * - Invalidação por eventos em tempo real do Gateway via SSE (`realtimeEvents`);
 * - Total compatibilidade com SSR e ausência de memory leaks.
 */
export function useDataPolling(
  fetcher: (signal: AbortSignal) => Promise<void>,
  options: UseDataPollingOptions = {},
): { refresh: () => Promise<void> } {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const pollerRef = useRef<DataPoller<void> | null>(null);

  const refresh = useCallback(async () => {
    await pollerRef.current?.refresh();
  }, []);

  const realtimeEventsKey = (options.realtimeEvents ?? []).join(',');

  useEffect(() => {
    const poller = new DataPoller<void>({
      fetcher: (signal) => fetcherRef.current(signal),
      intervalMs: options.intervalMs,
      enabled: options.enabled,
      pauseOnHidden: options.pauseOnHidden,
      refetchOnVisible: options.refetchOnVisible,
      realtimeEvents: realtimeEventsKey ? (realtimeEventsKey.split(',') as RealtimeEvent[]) : undefined,
      skipWhenRealtimeConnected: options.skipWhenRealtimeConnected,
    });

    poller.start();
    pollerRef.current = poller;

    return () => {
      poller.destroy();
      if (pollerRef.current === poller) {
        pollerRef.current = null;
      }
    };
  }, [
    options.intervalMs,
    options.enabled,
    options.pauseOnHidden,
    options.refetchOnVisible,
    options.skipWhenRealtimeConnected,
    realtimeEventsKey,
  ]);

  return { refresh };
}
