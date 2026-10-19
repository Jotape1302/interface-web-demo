import test from "node:test";
import assert from "node:assert/strict";
import { dividirEmParcelas, matchesNotaSearch, suggestPaymentMethod, suggestPaymentMethodForNote } from "./danfe-review-helpers";

test("termo vazio casa com tudo", () => {
  assert.equal(matchesNotaSearch("  ", ["qualquer"]), true);
});

test("texto ignora acentos e caixa", () => {
  assert.equal(matchesNotaSearch("DISTRIBUIDORA sao", ["Distribuidora São Paulo Ltda"]), true);
  assert.equal(matchesNotaSearch("gama", ["Distribuidora São Paulo Ltda"]), false);
});

test("termo numérico ignora pontuação de CNPJ e espaços da chave", () => {
  assert.equal(matchesNotaSearch("43.820.617/0001", [null, "43820617000166"]), true);
  assert.equal(matchesNotaSearch("3526 0912", ["35260912345678901234550010000012341000012345"]), true);
  assert.equal(matchesNotaSearch("999888", ["43820617000166"]), false);
});

test("parcelas iguais com a sobra de centavos na última", () => {
  assert.deepEqual(dividirEmParcelas(100, 3), [33.33, 33.33, 33.34]);
  assert.deepEqual(dividirEmParcelas(45.92, 1), [45.92]);
  assert.deepEqual(dividirEmParcelas(171.6, 2), [85.8, 85.8]);
});

test('forma de pagamento inicial: marcador do arquivo antes do padrão da empresa', () => {
  // NFC-e "NFC-e Norvia - Cartão Clara - ..." da Norvia Campinas (padrão da empresa seria outro).
  assert.equal(suggestPaymentMethodForNote('Cartão Clara', '27184930000107'), 'clara');
  assert.equal(suggestPaymentMethodForNote('Clara', '36592814000100'), 'clara'); // nome antigo do marcador
  assert.equal(suggestPaymentMethodForNote('Caixa Elo', null), 'caixa_elo');
  // Sem marcador (ou desconhecido): padrão da empresa, como antes.
  assert.equal(suggestPaymentMethodForNote(null, '36592814000100'), suggestPaymentMethod('36592814000100'));
  assert.equal(suggestPaymentMethodForNote('Outro', null), suggestPaymentMethod(null));
});
