import test from 'node:test';
import assert from 'node:assert/strict';
import { DataPoller, type RealtimeEvent } from './use-data-polling';

test('DataPoller: executa fetch inicial e agenda intervalo periódico', async () => {
  let fetchCount = 0;
  let intervalCallback: (() => void) | null = null;

  const poller = new DataPoller<string>({
    fetcher: async () => {
      fetchCount++;
      return `result-${fetchCount}`;
    },
    intervalMs: 5000,
    setIntervalFn: (cb) => {
      intervalCallback = cb;
      return 123;
    },
    clearIntervalFn: () => {
      intervalCallback = null;
    },
    getVisibilityState: () => 'visible',
  });

  poller.start();
  // Aguarda microtasks do fetch inicial
  await Promise.resolve();

  assert.equal(fetchCount, 1, 'Deve executar fetch inicial');
  assert.equal(poller.isIntervalActive(), true, 'Temporizador de intervalo deve estar armado');
  // Simula disparo do temporizador de intervalo
  assert.ok(typeof intervalCallback === 'function');
  (intervalCallback as () => void)();
  await Promise.resolve();

  assert.equal(fetchCount, 2, 'Deve executar novo fetch ao disparar o intervalo');

  poller.destroy();
  assert.equal(poller.isIntervalActive(), false, 'Temporizador deve ser limpo ao destruir');
});

test('DataPoller: propaga AbortSignal e aborta requisição em voo no destroy()', async () => {
  let signalReceived: AbortSignal | null = null;
  let errorReported: unknown = null;

  const poller = new DataPoller<string>({
    fetcher: async (signal) => {
      signalReceived = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new DOMException('This operation was aborted', 'AbortError');
          reject(err);
        });
      });
    },
    onError: (err) => {
      errorReported = err;
    },
    getVisibilityState: () => 'visible',
  });

  poller.start();
  await Promise.resolve();

  assert.ok(signalReceived !== null, 'AbortSignal deve ter sido passado ao fetcher');
  assert.equal((signalReceived as AbortSignal).aborted, false, 'Signal não deve estar abortado no início');

  poller.destroy();

  assert.equal((signalReceived as AbortSignal).aborted, true, 'Signal deve ser abortado no destroy');
  assert.equal(errorReported, null, 'AbortError não deve disparar onError');
});

test('DataPoller: refresh() cancela requisição anterior antes de iniciar a nova', async () => {
  const signals: AbortSignal[] = [];

  const poller = new DataPoller<string>({
    fetcher: async (signal) => {
      signals.push(signal);
      return new Promise((resolve) => setTimeout(resolve, 100));
    },
    getVisibilityState: () => 'visible',
  });

  poller.start();
  await Promise.resolve();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);

  // Dispara refresh antes da primeira resolver
  const refreshPromise = poller.refresh();
  await Promise.resolve();

  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, 'Primeira requisição deve ter sido abortada');
  assert.equal(signals[1].aborted, false, 'Segunda requisição deve estar ativa');

  poller.destroy();
  await refreshPromise.catch(() => {});
});

test('DataPoller: pausa polling quando a aba fica oculta e retoma ao reativar', async () => {
  let currentVisibility: 'visible' | 'hidden' = 'visible';
  let visibilityListener: (() => void) | null = null;
  let fetchCount = 0;
  let intervalCleared = false;
  let intervalArmed = false;

  const poller = new DataPoller<number>({
    fetcher: async () => {
      fetchCount++;
      return fetchCount;
    },
    intervalMs: 8000,
    pauseOnHidden: true,
    refetchOnVisible: true,
    getVisibilityState: () => currentVisibility,
    addVisibilityListener: (listener) => {
      visibilityListener = listener;
      return () => {
        visibilityListener = null;
      };
    },
    setIntervalFn: () => {
      intervalArmed = true;
      return 456;
    },
    clearIntervalFn: () => {
      intervalCleared = true;
      intervalArmed = false;
    },
  });

  poller.start();
  await Promise.resolve();

  assert.equal(fetchCount, 1);
  assert.equal(intervalArmed, true);

  // Usuário muda de aba (fica oculta)
  currentVisibility = 'hidden';
  visibilityListener!();

  assert.equal(intervalArmed, false, 'Intervalo deve ser desarmado com aba oculta');
  assert.equal(intervalCleared, true, 'ClearInterval deve ter sido invocado');
  assert.equal(poller.isVisible(), false);

  // Usuário volta para a aba
  intervalCleared = false;
  currentVisibility = 'visible';
  visibilityListener!();
  await Promise.resolve();

  assert.equal(fetchCount, 2, 'Deve ter disparado refresh imediato ao voltar para a aba');
  assert.equal(intervalArmed, true, 'Intervalo deve ter sido rearmado');
  assert.equal(poller.isVisible(), true);

  poller.destroy();
});

test('DataPoller: eventos SSE em tempo real disparam re-fetch imediato', async () => {
  let fetchCount = 0;
  let realtimeListener: (() => void) | null = null;
  let subscribedTypes: RealtimeEvent[] = [];

  const poller = new DataPoller<string>({
    fetcher: async () => {
      fetchCount++;
      return `data-${fetchCount}`;
    },
    realtimeEvents: ['notification', 'reconnected'],
    subscribeRealtimeFn: (types, cb) => {
      subscribedTypes = types;
      realtimeListener = cb;
      return () => {
        realtimeListener = null;
      };
    },
    getVisibilityState: () => 'visible',
  });

  poller.start();
  await Promise.resolve();

  assert.equal(fetchCount, 1);
  assert.deepEqual(subscribedTypes, ['notification', 'reconnected']);
  assert.ok(typeof realtimeListener === 'function');

  // Disparo do evento SSE vindo do Gateway
  (realtimeListener as () => void)();
  await Promise.resolve();

  assert.equal(fetchCount, 2, 'Evento SSE deve forçar re-fetch imediato');

  poller.destroy();
  assert.equal(realtimeListener, null, 'Deve cancelar inscrição SSE ao destruir');
});

test('DataPoller: pula polling por intervalo quando skipWhenRealtimeConnected=true e SSE está conectado', async () => {
  let fetchCount = 0;
  let intervalCb: (() => void) | null = null;
  let sseConnected = true;

  const poller = new DataPoller<string>({
    fetcher: async () => {
      fetchCount++;
      return 'ok';
    },
    intervalMs: 10000,
    skipWhenRealtimeConnected: true,
    isRealtimeConnectedFn: () => sseConnected,
    setIntervalFn: (cb) => {
      intervalCb = cb;
      return 789;
    },
    getVisibilityState: () => 'visible',
  });

  poller.start();
  await Promise.resolve();

  assert.equal(fetchCount, 1, 'Carga inicial sempre executa');

  // Disparo de tick enquanto SSE conectado
  intervalCb!();
  await Promise.resolve();
  assert.equal(fetchCount, 1, 'Tick deve ser pulado pois o SSE está conectado');

  // SSE cai (reconexão ou offline)
  sseConnected = false;
  intervalCb!();
  await Promise.resolve();
  assert.equal(fetchCount, 2, 'Fallback deve executar o fetch quando SSE cair');

  poller.destroy();
});

test('DataPoller: respeita enabled=false', async () => {
  let fetchCount = 0;

  const poller = new DataPoller<string>({
    fetcher: async () => {
      fetchCount++;
      return 'val';
    },
    enabled: false,
    intervalMs: 3000,
    getVisibilityState: () => 'visible',
  });

  poller.start();
  await Promise.resolve();

  assert.equal(fetchCount, 0, 'Não deve buscar dados quando desabilitado');
  assert.equal(poller.isIntervalActive(), false, 'Não deve armar timer quando desabilitado');

  poller.destroy();
});

test('DataPoller: falha de rede chama onError e não encerra o ciclo de polling', async () => {
  let attempts = 0;
  let lastError: unknown = null;
  let intervalCb: (() => void) | null = null;

  const poller = new DataPoller<string>({
    fetcher: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Falha de rede transitória');
      }
      return 'recuperado';
    },
    intervalMs: 5000,
    onError: (err) => {
      lastError = err;
    },
    setIntervalFn: (cb) => {
      intervalCb = cb;
      return 999;
    },
    getVisibilityState: () => 'visible',
  });

  poller.start();
  await Promise.resolve();

  assert.equal(attempts, 1);
  assert.ok(lastError instanceof Error);
  assert.equal((lastError as Error).message, 'Falha de rede transitória');

  // Próximo ciclo do intervalo
  intervalCb!();
  await Promise.resolve();

  assert.equal(attempts, 2, 'Poller deve continuar ativo para tentar se recuperar');

  poller.destroy();
});
