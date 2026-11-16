import test from 'node:test';
import assert from 'node:assert/strict';
import type { DanfeBatchResponse } from './contracts';
import { itemDeErroDoEnvio, juntarLotes } from './danfe-lote-manual';

function lote(nome: string, status: 'success' | 'error', valor: number): DanfeBatchResponse {
  const item = status === 'error' ? itemDeErroDoEnvio(nome, 'falhou') : { ...itemDeErroDoEnvio(nome, ''), status, error_message: null };
  return { total: 1, success_count: status === 'success' ? 1 : 0, failed_count: status === 'error' ? 1 : 0, total_amount: valor, items: [item] };
}

void test('junta as respostas de cada arquivo num resultado só', () => {
  const r = juntarLotes([lote('a.pdf', 'success', 79.89), lote('b.pdf', 'success', 23.96), lote('c.pdf', 'error', 0)]);
  assert.equal(r.total, 3);
  assert.equal(r.success_count, 2);
  assert.equal(r.failed_count, 1);
  assert.equal(r.total_amount, 103.85, 'soma em centavos, sem 103.84999');
  assert.deepEqual(r.items.map((i) => i.filename), ['a.pdf', 'b.pdf', 'c.pdf']);
});

void test('arquivo que não voltou vira item de erro do envio', () => {
  const item = itemDeErroDoEnvio('x.pdf', 'Erro na requisição (HTTP 504).', new Date('2026-11-12T12:00:00Z'));
  assert.equal(item.status, 'error');
  assert.equal(item.step, 'upload');
  assert.equal(item.error_message, 'Erro na requisição (HTTP 504).');
  assert.equal(item.processed_at, '2026-11-12T12:00:00.000Z');
  assert.deepEqual(juntarLotes([]), { total: 0, success_count: 0, failed_count: 0, total_amount: 0, items: [] });
});
