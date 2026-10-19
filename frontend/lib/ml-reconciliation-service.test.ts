import test from 'node:test';
import assert from 'node:assert/strict';
import { createMlReconciliationService } from './ml-reconciliation-service';

void test('I5: serviço de conciliação ML em sessão demo sincroniza tokens sem chamar fetch', async (t) => {
  const prevEnv = process.env.NEXT_PUBLIC_DATA_MODE;
  process.env.NEXT_PUBLIC_DATA_MODE = 'demo';
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (prevEnv === undefined) delete process.env.NEXT_PUBLIC_DATA_MODE;
    else process.env.NEXT_PUBLIC_DATA_MODE = prevEnv;
  });

  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch não deve ser chamado no modo demonstração!');
  }) as typeof fetch;

  const service = createMlReconciliationService();

  const res = await service.sincronizarTokens();

  assert.equal(fetchCalled, false, 'fetch foi chamado pelo DemoMlReconciliationService');
  assert.equal(res.ok, true);
  assert.equal(res.mock, true);
  assert.deepEqual(res.tokens_atualizados, ['norvia', 'revesta']);
  assert.equal('token_prefixo' in res.contas.norvia, false);
});

void test('I5: formatarMensagemSincronizacaoTokens cobre os 4 estados esperados', async () => {
  const { formatarMensagemSincronizacaoTokens } = await import('./ml-reconciliation-helpers');

  // Estado 1: Mock
  const feedbackMock = formatarMensagemSincronizacaoTokens({
    ok: true,
    mock: true,
    contas: { norvia: { conectado: true, renovado: true } },
    tokens_atualizados: ['norvia'],
  });
  assert.equal(feedbackMock.tipo, 'sucesso');
  assert.match(feedbackMock.msg, /simula[çc][ãa]o/i);

  // Estado 2: 429 / Cooldown
  const feedback429 = formatarMensagemSincronizacaoTokens(
    new Error('Aguarde 35 segundos antes de tentar novamente (HTTP 429).'),
  );
  assert.equal(feedback429.tipo, 'erro');
  assert.match(feedback429.msg, /35 segundos/);

  // Estado 3: Todas renovadas
  const feedbackTodas = formatarMensagemSincronizacaoTokens({
    ok: true,
    contas: {
      norvia: { conectado: true, renovado: true },
      revesta: { conectado: true, renovado: true },
    },
    tokens_atualizados: ['norvia', 'revesta'],
  });
  assert.equal(feedbackTodas.tipo, 'sucesso');
  assert.match(feedbackTodas.msg, /sucesso/i);

  // Estado 4: Parcial com motivos
  const feedbackParcial = formatarMensagemSincronizacaoTokens({
    ok: true,
    contas: {
      norvia: { conectado: true, renovado: true },
      revesta: { conectado: true, renovado: false, motivo: 'TMS offline' },
    },
    tokens_atualizados: ['norvia'],
  });
  assert.equal(feedbackParcial.tipo, 'aviso');
  assert.match(feedbackParcial.msg, /parcialmente/i);
  assert.match(feedbackParcial.msg, /TMS offline/);

  // Estado 4b: Todas com falha
  const feedbackFalhaTotal = formatarMensagemSincronizacaoTokens({
    ok: false,
    contas: {
      norvia: { conectado: false, renovado: false, motivo: 'OAuth expirado' },
      revesta: { conectado: false, renovado: false, motivo: 'TMS indisponível' },
    },
    tokens_atualizados: [],
  });
  assert.equal(feedbackFalhaTotal.tipo, 'erro');
  assert.match(feedbackFalhaTotal.msg, /OAuth expirado/);
  assert.match(feedbackFalhaTotal.msg, /TMS indispon[íi]vel/);
});
