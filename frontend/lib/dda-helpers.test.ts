import test from 'node:test';
import assert from 'node:assert/strict';
import type { DdaBoleto, DdaSituacao } from './dda-contracts';
import { acoesDoBoleto, aguardandoValidacao, aprovacoesTexto, boletoNoFiltro, categoriaSugerida, contarPorFiltro, dataBR, documentoFormatado, historicoPadrao, situacaoMeta, textoSugestaoCategoria } from './dda-helpers';

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

void test('categoria sugerida só pré-seleciona se existe no catálogo da empresa', () => {
  const cats = [{ id: '7', nome: 'Aluguel', grupo: 'Fixas' }];
  const sem = b('SEM_CONTA', { sugestao_categoria: { categoria_id: '7', origem: 'historico', nivel: 'tiny' } });
  assert.equal(categoriaSugerida(sem, cats), '7');
  assert.equal(categoriaSugerida(sem, null), '');
  assert.equal(categoriaSugerida(b('SEM_CONTA', { sugestao_categoria: { categoria_id: '9', origem: 'qwen' } }), cats), '');
  assert.equal(categoriaSugerida(b('SEM_CONTA'), cats), '');
});

void test('origem da sugestão em texto: painel, Tiny dominante, dividido e Qwen', () => {
  assert.match(textoSugestaoCategoria({ categoria_id: '7', origem: 'historico', nivel: 'painel' }).texto, /escolhida no painel/);
  const dist = [{ categoria_id: '7', vezes: 9, valor_medio: 100 }];
  assert.equal(textoSugestaoCategoria({ categoria_id: '7', origem: 'historico', nivel: 'tiny', vezes_tiny: 10, distribuicao: dist }).texto,
    'Histórico do Tiny: 9 de 10 lançamento(s) deste fornecedor nesta categoria.');
  assert.match(textoSugestaoCategoria({ categoria_id: '7', origem: 'historico', nivel: 'tiny_fraco', vezes_tiny: 16, distribuicao: dist }).texto, /dividido.*9 de 16/);
  const q = textoSugestaoCategoria({ categoria_id: '7', origem: 'qwen', confianca: 'media', motivo: 'Conta de luz.' });
  assert.deepEqual(q, { icone: 'qwen', texto: 'Sugerida pelo Qwen (confiança média): Conta de luz.' });
});
