import test from 'node:test';
import assert from 'node:assert/strict';
import { demoDimensoes, demoFretes, demoMarketplaceAdiantar } from './demo-marketplace';
import { demoReconciliation } from './demo-reconciliation';

void test('demo dimensões: cards batem com a lista e confirmar envia as medidas do Tiny ao ML', () => {
  const st = demoDimensoes.status();
  const aEnviar = demoDimensoes.produtos({ status: 'pendente', pageSize: 200 });
  assert.equal(aEnviar.total, st.por_status.pendente ?? 0);
  assert.equal(
    st.anuncios_a_enviar,
    aEnviar.itens.reduce((n, p) => n + p.anuncios.filter((a) => a.situacao === 'diferente').length, 0),
  );

  const antes = demoDimensoes.produtos({ q: 'PF-ALU-3M-BR' }).itens[0];
  assert.equal(antes.status, 'pendente');
  assert.deepEqual(antes.anuncios[0].ficha_alvo, { LENGTH: 300, WEIGHT: 420 }, 'peso bruto do Tiny na ficha');
  assert.deepEqual(antes.anuncios[0].embalagem_alvo, { altura: 1.2, largura: 1.7, comprimento: 300, peso: 420 }, 'embalagem = medidas do Tiny');

  const r = demoDimensoes.validar(['PF-ALU-3M-BR', 'PERF-U-ACM']);
  assert.deepEqual(r.aceitos, ['PF-ALU-3M-BR']);
  assert.match(r.recusados[0], /PERF-U-ACM/, 'sem peso bruto no Tiny: nada a enviar');
  demoMarketplaceAdiantar(60_000);
  const depois = demoDimensoes.produtos({ q: 'PF-ALU-3M-BR' }).itens[0];
  assert.equal(depois.status, 'padronizado');
  assert.equal(depois.envio?.status, 'ok');
  assert.equal(depois.anuncios[0].ficha_atual?.LENGTH, 300);
});

void test('demo fretes: 1 m/2 m é ME2, 3 m é ME1 e a varredura corrige o tipo errado', () => {
  const inconsistentes = demoFretes.anuncios({ situacao: 'tipo_inconsistente' }).itens;
  assert.ok(inconsistentes.some((a) => a.sku === 'PF-RDP-LED-2M' && a.modo_envio === 'me1' && a.envio_indicado === 'me2'));
  assert.ok(inconsistentes.some((a) => a.sku === 'PF-SOB-3M' && a.modo_envio === 'me2' && a.envio_indicado === 'me1'));
  assert.equal(demoFretes.anuncios({ q: 'PF-EMB-3M' }).itens[0].bloqueio, 'sem_me1', 'Revesta sem ME1 e a embalagem de 3 m é ME1');
  assert.equal(demoFretes.anuncios({ q: 'RDP-MDF-10CM' }).itens[0].bloqueio, 'sem_me1', 'embalagem do Tiny (10 cm x 2,40 m) vai no ME1');

  demoFretes.executar();
  demoMarketplaceAdiantar(60_000);
  assert.ok(demoFretes.anuncios({ situacao: 'tipo_inconsistente' }).total > 0, 'a rotina diária só cuida dos a combinar');

  demoFretes.corrigirTipo();
  demoMarketplaceAdiantar(60_000);
  assert.equal(demoFretes.anuncios({ situacao: 'tipo_inconsistente' }).total, 0);
  assert.equal(demoFretes.historico().execucoes[0].resumo.corrigidos, inconsistentes.length);
  demoMarketplaceAdiantar(11 * 60_000); // conferência de 10 min
  assert.equal(demoFretes.anuncios({ q: 'PF-RDP-LED-2M' }).itens[0].modo_envio, 'me2');
});

void test('demo fretes: cards contam o mesmo que os filtros da aba Anúncios', () => {
  const st = demoFretes.status();
  assert.equal(demoFretes.anuncios({ modo: 'not_specified' }).total, st.envios.not_specified);
  assert.equal(demoFretes.anuncios({ bloqueio: 'sem_padrao,sem_sku' }).total, st.sem_padrao);
  assert.equal(demoFretes.desfeitos().total, st.desfeitos);
  assert.equal(st.total_anuncios, demoFretes.anuncios({ pageSize: 200 }).total);
});

void test('demo conciliação: job de prévia devolve casamentos e job desconhecido some', () => {
  const job = demoReconciliation.iniciarPrevia({ empresa: 'fabrilux', data_inicio: '2026-09-01', data_fim: '2026-09-30' });
  assert.equal(job.status, 'executando');
  assert.equal(job.total, 1);
  assert.equal(demoReconciliation.job('nao-existe'), null);
  assert.ok(demoReconciliation.historico({}).total > 0);
});
