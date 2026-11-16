import test from 'node:test';
import assert from 'node:assert/strict';
import { agruparIncidentes, desatualizado, makeDemoAgentesQwen, textoAcompanhamento } from './agentes-qwen';

void test('acompanhamento: execuções acompanhadas e sucessos, ou a janela sem rota', () => {
  const rota = { acompanhamento: { modo: 'rota' as const, rota: 'POST /x', alvo: 5, acompanhadas: 5, sucessos: 4 } };
  assert.equal(textoAcompanhamento(rota, (v) => v), '5/5 execuções acompanhadas com 4/5 sucessos');
  assert.match(textoAcompanhamento({ acompanhamento: { modo: 'janela', ate: '2026-11-01' } }, (v) => v)!, /até 2026-11-01/);
  assert.equal(textoAcompanhamento({ acompanhamento: null }, (v) => v), null);
});

void test('agrupar: cada incidente no bloco do grupo, mais recente primeiro', () => {
  const { estado } = makeDemoAgentesQwen(new Date('2026-10-30T12:00:00Z'));
  const grupos = agruparIncidentes(estado!.incidentes);
  assert.deepEqual(grupos.pr_pendente.map((i) => i.id), [12]);
  assert.deepEqual(grupos.precisa_ti.map((i) => i.id), [9]);
  assert.deepEqual(grupos.monitorando.map((i) => i.id), [11]);
  assert.deepEqual(grupos.resolvido.map((i) => i.id), [7]);
  assert.deepEqual(grupos.em_andamento, []);
});

void test('desatualizado: sem estado ou mais de 10 min sem repasse', () => {
  const agora = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(desatualizado(null, agora), true);
  assert.equal(desatualizado('2026-10-30T11:55:00Z', agora), false);
  assert.equal(desatualizado('2026-10-30T11:49:00Z', agora), true);
});
