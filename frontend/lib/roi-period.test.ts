import assert from 'node:assert/strict';
import test from 'node:test';
import { roiPeriodoDaEscolha, roiPeriodoDoPreset, roiPeriodoRotulo, roiPeriodoSufixoArquivo, roiQuery } from './roi-period';

// 31/10 23:00 em São Paulo (já é 01/11 em UTC) (UTC já virou o mês).
const virada = new Date('2026-11-01T02:00:00Z');
const meio = new Date('2026-10-27T15:00:00Z');

void test('roiQuery monta só os parâmetros presentes', () => {
  assert.equal(roiQuery(), '');
  assert.equal(roiQuery({ de: null, ate: null }), '');
  assert.equal(roiQuery({ de: '2026-10-01' }), '?de=2026-10-01');
  assert.equal(roiQuery({ de: '2026-10-01', ate: '2026-10-27' }), '?de=2026-10-01&ate=2026-10-27');
});

void test('atalhos usam o calendário de São Paulo', () => {
  assert.deepEqual(roiPeriodoDoPreset('inicio', meio), { de: null, ate: null });
  assert.deepEqual(roiPeriodoDoPreset('mes', meio), { de: '2026-10-01', ate: '2026-10-27' });
  assert.deepEqual(roiPeriodoDoPreset('mes-passado', meio), { de: '2026-09-01', ate: '2026-09-30' });
  assert.deepEqual(roiPeriodoDoPreset('30dias', meio), { de: '2026-09-28', ate: '2026-10-27' });
  assert.deepEqual(roiPeriodoDoPreset('ano', meio), { de: '2026-01-01', ate: '2026-10-27' });
  assert.deepEqual(roiPeriodoDoPreset('mes', virada), { de: '2026-10-01', ate: '2026-10-31' });
  assert.deepEqual(roiPeriodoDoPreset('mes-passado', new Date('2027-01-10T12:00:00Z')), { de: '2026-12-01', ate: '2026-12-31' });
});

void test('personalizado ignora datas inválidas e ordena', () => {
  assert.deepEqual(roiPeriodoDaEscolha({ preset: 'personalizado', de: '2026-10-20', ate: '2026-10-05' }), { de: '2026-10-05', ate: '2026-10-20' });
  assert.deepEqual(roiPeriodoDaEscolha({ preset: 'personalizado', de: '2026-02-31', ate: '' }), { de: null, ate: null });
});

void test('rótulo e sufixo do arquivo', () => {
  assert.equal(roiPeriodoRotulo({ de: '2026-10-01', ate: '2026-10-27' }), 'de 01/10/2026 a 27/10/2026');
  assert.equal(roiPeriodoRotulo({ de: null, ate: null }), 'desde o início');
  assert.equal(roiPeriodoSufixoArquivo({ de: '2026-10-01', ate: '2026-10-27' }), '_2026-10-01_a_2026-10-27');
  assert.equal(roiPeriodoSufixoArquivo({ de: null, ate: null }), '');
});
