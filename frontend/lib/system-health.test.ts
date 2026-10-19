import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketHistory, makeDemoSystemHealth } from './system-health';

test('bucketHistory: pior estado por faixa e faixas sem amostra ficam vazias', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
  const buckets = bucketHistory(
    [
      { at: at(3.9), state: 'ok' },
      { at: at(3.8), state: 'error' },
      { at: at(1.5), state: 'warning' },
      { at: at(0.1), state: 'ok' },
      { at: at(30), state: 'error' }, // fora da janela
    ],
    4,
    4,
    now,
  );
  assert.deepEqual(buckets, ['error', null, 'warning', 'ok']);
});

test('demonstração: estado geral é o pior dos serviços', () => {
  const report = makeDemoSystemHealth();
  const states = new Set(report.checks.map((c) => c.state));
  assert.equal(report.overall, states.has('error') ? 'error' : states.has('warning') ? 'warning' : 'ok');
});

test('demonstração: inclui verificações de circuit-breakers e motor de marketplace', () => {
  const report = makeDemoSystemHealth();
  const checkIds = report.checks.map((c) => c.id);
  assert.ok(checkIds.includes('circuit-breakers'), 'Deve incluir verificação de circuit-breakers');
  assert.ok(checkIds.includes('automacao-marketplace'), 'Deve incluir verificação de marketplace');

  const mariadb = report.checks.find((c) => c.id === 'mariadb');
  assert.ok(mariadb?.details?.some((d) => d.label === 'Latência de consulta'));
  assert.ok(mariadb?.details?.some((d) => d.label === 'Bancos operacionais'));
});

