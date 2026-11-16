import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDemoRoi } from './demo-roi';
import { HttpRoiService, MockRoiService, minutosEconomizados, parseRoi, roiCsvRows } from './roi-service';

const live = () => ({ ...makeDemoRoi(new Date('2026-10-23T12:00:00Z')), mode: 'live' as const });

void test('fixture demo é válida e a conta é (manual − atual) × itens × R$ 11/h', async () => {
  const roi = await new MockRoiService().getRoi();
  assert.equal(roi.mode, 'demo');
  assert.equal(roi.automacoes.length, 7);
  const ap = roi.automacoes.find((a) => a.id === 'accounts-payable')!;
  assert.equal(ap.horasEconomizadas, (ap.itens! * 4.5) / 60);
  assert.equal(ap.reais, Math.round(ap.horasEconomizadas! * 11 * 100) / 100);
  assert.equal(roi.totais.parcial, false);
  assert.equal(roi.totais.reais, Math.round(roi.automacoes.reduce((s, a) => s + a.reais!, 0) * 100) / 100);
  assert.deepEqual(roi.naoMedidas, []);
});

void test('minutosEconomizados e CSV', () => {
  const roi = live();
  assert.equal(minutosEconomizados(roi.automacoes[0]!), 4.5);
  assert.equal(roiCsvRows(roi).length, 7);
});

void test('fonte com erro: números nulos são aceitos', () => {
  const roi = live();
  roi.automacoes[1] = { ...roi.automacoes[1]!, itens: null, horasEconomizadas: null, reais: null, fonte: { status: 'erro', mensagem: 'fora do ar' } };
  roi.totais.parcial = true;
  const parsed = parseRoi(roi);
  assert.equal(parsed.automacoes[1]?.fonte.status, 'erro');
  assert.equal(parsed.totais.parcial, true);
});

void test('rejeita payload incoerente', () => {
  const ruim = live();
  ruim.automacoes[0] = { ...ruim.automacoes[0]!, reais: null };
  assert.throws(() => parseRoi(ruim), /incompatíveis/);
  const erroComNumeros = live();
  erroComNumeros.automacoes[0] = { ...erroComNumeros.automacoes[0]!, fonte: { status: 'erro' } };
  assert.throws(() => parseRoi(erroComNumeros), /incompatíveis/);
  assert.throws(() => parseRoi({ ...live(), automacoes: 'x' }), /incompatíveis/);
  assert.throws(() => parseRoi({ ...live(), automacoes: [live().automacoes[0], live().automacoes[0]] }), /incompatíveis/);
});

void test('cliente http: endpoint, 403 e recusa de resposta demo', async () => {
  const ok: typeof fetch = async (input, init) => {
    assert.equal(input, '/api/roi');
    assert.equal(init?.cache, 'no-store');
    return new Response(JSON.stringify(live()), { status: 200 });
  };
  assert.equal((await new HttpRoiService('', ok).getRoi()).mode, 'live');
  const proibido: typeof fetch = async () => new Response('{}', { status: 403 });
  await assert.rejects(new HttpRoiService('', proibido).getRoi(), /não autorizado/);
  const demo: typeof fetch = async () => new Response(JSON.stringify(makeDemoRoi()), { status: 200 });
  await assert.rejects(new HttpRoiService('', demo).getRoi(), /demonstrativa/);
});

void test('parseRoi aceita periodo ausente como null/null e lê o informado', () => {
  const { periodo: _omitido, ...semPeriodo } = live();
  assert.deepEqual(parseRoi(semPeriodo).periodo, { de: null, ate: null });
  assert.deepEqual(parseRoi({ ...semPeriodo, periodo: { de: '2026-10-01', ate: null } }).periodo, { de: '2026-10-01', ate: null });
  assert.throws(() => parseRoi({ ...semPeriodo, periodo: { de: '01/10/2026', ate: null } }), /incompatíveis/);
});

void test('HttpRoiService manda de/ate na query e demo reduz os números com o período', async () => {
  let url = '';
  const spy: typeof fetch = async (input) => {
    url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify(live()), { status: 200 });
  };
  await new HttpRoiService('', spy).getRoi(undefined, { de: '2026-10-01', ate: '2026-10-27' });
  assert.equal(url, '/api/roi?de=2026-10-01&ate=2026-10-27');
  await new HttpRoiService('', spy).getRoi();
  assert.equal(url, '/api/roi');
  const tudo = await new MockRoiService().getRoi();
  const mes = await new MockRoiService().getRoi(undefined, { de: '2026-10-01', ate: '2026-10-27' });
  assert.deepEqual(mes.periodo, { de: '2026-10-01', ate: '2026-10-27' });
  assert.ok(mes.totais.reais < tudo.totais.reais);
});
