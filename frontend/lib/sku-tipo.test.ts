import test from 'node:test';
import assert from 'node:assert/strict';
import { contarTiposSku, tipoSku } from './sku-tipo';

void test('tipoSku: Final MP tem prioridade sobre o hífen', () => {
  assert.equal(tipoSku('NRV123MP'), 'Final MP');
  assert.equal(tipoSku('NRV-123-MP'), 'Final MP');
  assert.equal(tipoSku(' abc10mp '), 'Final MP');
  assert.equal(tipoSku('NRVBPF01-1M'), 'Possui "-"');
  assert.equal(tipoSku('3907'), 'Outros');
  assert.equal(tipoSku('MPX100'), 'Outros');
});

void test('contarTiposSku', () => {
  assert.deepEqual(contarTiposSku(['A-1', 'B2MP', '4035', 'C-3']), { 'Final MP': 1, 'Possui "-"': 2, Outros: 1 });
});
