import test from 'node:test';
import assert from 'node:assert/strict';
import { camposParaMedidas, formatMedidas, medidasParaCampos, parseMedida, rotuloModo } from './fretes-helpers';

test('formatMedidas mostra o que falta com "?" e não mostra peso', () => {
  assert.equal(formatMedidas({ altura: 60, largura: 40, comprimento: 15.5, peso: 1200 }), '60 × 40 × 15,5 cm');
  assert.equal(formatMedidas({ altura: null, largura: 40, comprimento: 15 }), '? × 40 × 15 cm');
  assert.equal(formatMedidas({ altura: null, largura: null, comprimento: null, peso: 500 }), '—');
});

test('campos do formulário aceitam vírgula e ida e volta preserva o valor', () => {
  assert.equal(parseMedida(' 12,5 '), 12.5);
  assert.equal(parseMedida(''), null);
  assert.equal(parseMedida('0'), null);
  assert.equal(parseMedida('abc'), null);
  const m = { altura: 12.5, largura: 3, comprimento: null, peso: null };
  assert.deepEqual(camposParaMedidas(medidasParaCampos(m)), m);
  assert.equal(camposParaMedidas({ altura: '1', largura: '1', comprimento: '1', peso: '99,6' }).peso, 100);
});

test('rótulo do modo de envio', () => {
  assert.equal(rotuloModo('not_specified'), 'A combinar');
  assert.equal(rotuloModo('me2'), 'ME2');
  assert.equal(rotuloModo(null), '—');
});
