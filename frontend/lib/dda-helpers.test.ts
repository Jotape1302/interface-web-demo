import test from 'node:test';
import assert from 'node:assert/strict';
import type { DdaBoleto, DdaSituacao } from './dda-contracts';
import { acoesDoBoleto, aguardandoValidacao, aprovacoesTexto, boletoNoFiltro, contarPorFiltro, dataBR, documentoFormatado, historicoPadrao, situacaoMeta } from './dda-helpers';

const b = (situacao: DdaSituacao, extra: Partial<DdaBoleto> = {}): DdaBoleto => ({
  id: situacao, empresa: 'revesta', situacao, mensagem: '', beneficiario_nome: 'F', beneficiario_cnpj: '11222333000181',
  valor: '10.00', vencimento: '2026-11-20', ...extra,
});

void test('vencimento sem fuso não muda de dia', () => {
  assert.equal(dataBR('2026-11-20'), '20/11/2026');
  assert.equal(dataBR(''), '—');
});

void test('CNPJ e CPF com máscara', () => {
  assert.equal(documentoFormatado('11222333000181'), '11.222.333/0001-81');
  assert.equal(documentoFormatado('12345678901'), '123.456.789-01');
});

void test('filtros separam o que pede ação, o andamento e os finalizados', () => {
  const validado = { validacao: { por: 'G', em: '2026-11-16' } };
  const lista = [b('SEM_CONTA'), b('AMBIGUO'), b('AGENDADO'), b('CASADO'), b('CASADO', validado), b('BAIXADO'), b('DESCARTADO'), b('NOVO', { fraude: true })];
  assert.deepEqual(contarPorFiltro(lista), { acao: 4, andamento: 2, finalizados: 2, todos: 8 });
  assert.equal(boletoNoFiltro(b('PAGO'), 'andamento'), true);
});

void test('agendado no Inter não pode ser descartado nem reaberto pelo painel', () => {
  assert.deepEqual(acoesDoBoleto(b('AGENDADO')), { escolher: false, criar: false, descartar: false, reabrir: false });
  assert.equal(acoesDoBoleto(b('SEM_CONTA')).criar, true);
  assert.equal(acoesDoBoleto(b('SEM_CONTA', { conta_criada_incerta: true })).criar, false);
  assert.equal(acoesDoBoleto(b('RECUSADO')).reabrir, true);
});

void test('aprovações do Inter', () => {
  assert.equal(aprovacoesTexto(b('AGENDADO', { inter: { aprovacoes_necessarias: 2, aprovacoes_realizadas: 1 } })), '1 de 2 aprovações');
  assert.equal(aprovacoesTexto(b('AGENDADO')), null);
});

void test('casado sem conferência pede ação até validar', () => {
  assert.equal(aguardandoValidacao(b('CASADO')), true);
  assert.equal(situacaoMeta(b('CASADO')).label, 'Conferir conta');
  assert.equal(situacaoMeta(b('CASADO', { validacao: { por: 'G', em: 'x' } })).label, 'Validado');
  assert.equal(boletoNoFiltro(b('CASADO', { validacao: { por: 'G', em: 'x' } }), 'andamento'), true);
});

void test('histórico sugerido leva o beneficiário e o documento', () => {
  assert.equal(historicoPadrao(b('SEM_CONTA', { documento: '77' })), 'Boleto DDA - F - doc. 77');
});
