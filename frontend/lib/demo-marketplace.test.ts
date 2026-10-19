import test from 'node:test';
import assert from 'node:assert/strict';
import { demoDimensoes, demoFretes } from './demo-marketplace';
import { demoReconciliation } from './demo-reconciliation';

test('demo dimensões: cards batem com a lista e validar padroniza e libera o frete', () => {
  const st = demoDimensoes.status();
  const aRevisar = demoDimensoes.produtos({ status: 'pendente,divergente', pageSize: 200 });
  assert.equal(aRevisar.total, (st.por_status.pendente ?? 0) + (st.por_status.divergente ?? 0));

  const bloqueadoAntes = demoFretes.anuncios({ q: 'RDP-MDF-10CM' }).itens[0];
  assert.equal(bloqueadoAntes.bloqueio, 'sem_padrao');

  const r = demoDimensoes.validar([{ sku: 'RDP-MDF-10CM', altura: 1.5, largura: 10, comprimento: 240, peso: 1650 }]);
  assert.deepEqual(r.gravados, ['RDP-MDF-10CM']);
  assert.equal(demoDimensoes.produtos({ q: 'RDP-MDF-10CM' }).itens[0].status, 'padronizado');
  // Revesta sem ME1 e 240 cm só cabe no ME1: sai de "sem padrão" para "sem ME1".
  assert.equal(demoFretes.anuncios({ q: 'RDP-MDF-10CM' }).itens[0].bloqueio, 'sem_me1');
});

test('demo fretes: cards contam o mesmo que os filtros da aba Anúncios', () => {
  const st = demoFretes.status();
  assert.equal(demoFretes.anuncios({ modo: 'not_specified' }).total, st.envios.not_specified);
  assert.equal(demoFretes.anuncios({ bloqueio: 'sem_padrao,sem_sku' }).total, st.sem_padrao);
  assert.equal(demoFretes.desfeitos().total, st.desfeitos);
  assert.equal(st.total_anuncios, demoFretes.anuncios({ pageSize: 200 }).total);
});

test('demo conciliação: job de prévia devolve casamentos e job desconhecido some', () => {
  const job = demoReconciliation.iniciarPrevia({ empresa: 'fabrilux', data_inicio: '2026-09-01', data_fim: '2026-09-30' });
  assert.equal(job.status, 'executando');
  assert.equal(job.total, 1);
  assert.equal(demoReconciliation.job('nao-existe'), null);
  assert.ok(demoReconciliation.historico({}).total > 0);
});
