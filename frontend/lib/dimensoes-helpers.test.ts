import test from 'node:test';
import assert from 'node:assert/strict';
import { embalagemPara, medidasValidas } from './dimensoes-helpers';

test('embalagem padrão pelo comprimento do produto (igual ao backend)', () => {
  assert.deepEqual(embalagemPara({ altura: 1.6, largura: 1.6, comprimento: 98 }), { comprimento: 100 });
  assert.deepEqual(embalagemPara({ altura: 300, largura: 1, comprimento: 1.2 }), { comprimento: 300 });
  assert.equal(embalagemPara({ altura: 8, largura: 1, comprimento: 100 }), null, '8 cm não cabe na seção 5 x 7');
  assert.equal(embalagemPara({ altura: 1, largura: 1, comprimento: 310 }), null);
  assert.equal(embalagemPara({ altura: null, largura: 1, comprimento: 100 }), null);
});

test('validar exige os três lados e o peso', () => {
  assert.equal(medidasValidas({ altura: 1, largura: 1, comprimento: 1, peso: 10 }), true);
  assert.equal(medidasValidas({ altura: 1, largura: 1, comprimento: 1 }), false);
});
