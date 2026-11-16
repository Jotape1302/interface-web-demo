import test from 'node:test';
import assert from 'node:assert/strict';
import { podeConfirmar, valorAtributo } from './dimensoes-helpers';

void test('atributo de peso em g e de medida em cm', () => {
  assert.equal(valorAtributo('NET_WEIGHT', 850), '850 g');
  assert.equal(valorAtributo('LENGTH', 1.5), '1,5 cm');
  assert.equal(valorAtributo('WIDTH', null), 'vazio');
});

void test('só produto a enviar e fora de envio entra na confirmação', () => {
  assert.equal(podeConfirmar({ status: 'pendente' }), true);
  assert.equal(podeConfirmar({ status: 'pendente', envio: { status: 'enviando' } }), false);
  assert.equal(podeConfirmar({ status: 'sem_medida' }), false);
  assert.equal(podeConfirmar({ status: 'padronizado', envio: { status: 'erro' } }), false);
});
