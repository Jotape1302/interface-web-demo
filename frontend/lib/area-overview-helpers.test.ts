import assert from 'node:assert/strict';
import test from 'node:test';
import { resumirVisaoGeral } from './area-overview-helpers';
import { normalizarVisaoGeral } from './area-overview-service';
import { makeDemoVisaoGeral } from './demo-area-overview';

const AREAS = ['financeiro', 'logistica', 'marketplace', 'producao'] as const;

void test('demo existe para as 4 áreas e é coerente', () => {
  for (const a of AREAS) {
    const v = makeDemoVisaoGeral(a, '2026-10-27T12:00:00Z');
    assert.equal(v.area, a);
    assert.ok(v.automacoes.length > 0);
    assert.ok(v.servicos.length > 0);
    const r = resumirVisaoGeral(v);
    assert.equal(r.totalAcoes, v.acoesPendentes.length);
    assert.ok(r.servicosConectados <= r.servicosTotal);
  }
});

void test('normalizarVisaoGeral tolera corpo vazio', () => {
  const v = normalizarVisaoGeral(null, 'producao');
  assert.deepEqual(v.acoesPendentes, []);
  assert.equal(v.area, 'producao');
});
