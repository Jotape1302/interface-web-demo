import test from "node:test";
import assert from "node:assert/strict";
import { dividirEmParcelas, matchesNotaSearch, origemSugestaoCategoria, suggestMeioPagamentoNfe, suggestPaymentMethod, suggestPaymentMethodForNote } from "./danfe-review-helpers";

void test("termo vazio casa com tudo", () => {
  assert.equal(matchesNotaSearch("  ", ["qualquer"]), true);
});

void test("texto ignora acentos e caixa", () => {
  assert.equal(matchesNotaSearch("DISTRIBUIDORA sao", ["Distribuidora São Paulo Ltda"]), true);
  assert.equal(matchesNotaSearch("gama", ["Distribuidora São Paulo Ltda"]), false);
});

void test("termo numérico ignora pontuação de CNPJ e espaços da chave", () => {
  assert.equal(matchesNotaSearch("43.820.617/0001", [null, "43820617000166"]), true);
  assert.equal(matchesNotaSearch("3526 0912", ["35260912345678901234550010000012341000012345"]), true);
  assert.equal(matchesNotaSearch("999888", ["43820617000166"]), false);
});

void test("parcelas iguais com a sobra de centavos na última", () => {
  assert.deepEqual(dividirEmParcelas(100, 3), [33.33, 33.33, 33.34]);
  assert.deepEqual(dividirEmParcelas(45.92, 1), [45.92]);
  assert.deepEqual(dividirEmParcelas(171.6, 2), [85.8, 85.8]);
});

void test('forma de pagamento inicial: marcador do arquivo antes do padrão da empresa', () => {
  // NFC-e "NFC-e Norvia - Cartão Clara - ..." da Norvia Campinas (padrão da empresa seria outro).
  assert.equal(suggestPaymentMethodForNote('Cartão Clara', '27184930000107'), 'clara');
  assert.equal(suggestPaymentMethodForNote('Clara', '36592814000100'), 'clara'); // nome antigo do marcador
  assert.equal(suggestPaymentMethodForNote('Caixa Elo', null), 'caixa_elo');
  // Sem marcador (ou desconhecido): padrão da empresa, como antes.
  assert.equal(suggestPaymentMethodForNote(null, '36592814000100'), suggestPaymentMethod('36592814000100'));
  assert.equal(suggestPaymentMethodForNote('Outro', null), suggestPaymentMethod(null));
});

void test("forma de pagamento: marcador do arquivo > sugestão da automação > padrão da empresa", () => {
  assert.equal(suggestPaymentMethodForNote("Cartão Clara", "27184930000107", "boleto"), "clara");
  assert.equal(suggestPaymentMethodForNote(null, "27184930000107", "boleto"), "boleto");
  assert.equal(suggestPaymentMethodForNote(null, "27184930000107", "inexistente"), "caixa_visa_norvia");
  assert.equal(suggestPaymentMethodForNote(null, "27184930000107", null), "caixa_visa_norvia");
});

void test("origem da categoria: Qwen mostra confiança e motivo; histórico diz o que casou", () => {
  assert.deepEqual(
    origemSugestaoCategoria({ categoria_sugerida_origem: "qwen", categoria_sugerida_confianca: "media", categoria_sugerida_motivo: " detergente é limpeza " }),
    { icone: "qwen", titulo: "Sugerido pelo Qwen (confiança média): detergente é limpeza" },
  );
  assert.equal(origemSugestaoCategoria({ categoria_sugerida_origem: "qwen", categoria_sugerida_confianca: "alta" }).titulo, "Sugerido pelo Qwen (confiança alta)");
  assert.match(origemSugestaoCategoria({ categoria_sugerida_origem: "historico", categoria_sugerida_nivel: "ncm" }).titulo, /mesmo NCM/);
  assert.match(origemSugestaoCategoria({ categoria_sugerida_origem: "historico" }).titulo, /mais usada/);
  assert.equal(origemSugestaoCategoria({}).icone, "regra");
});

void test("suggestMeioPagamentoNfe: o meio da NFe acompanha a forma; o XML só refina o cartão", () => {
  // Nota 1051 (03/11): forma Caixa Visa Norvia e XML "99 Outros" → Cartão de Crédito.
  assert.equal(suggestMeioPagamentoNfe("caixa_visa_norvia", "99"), "03");
  assert.equal(suggestMeioPagamentoNfe("clara", null), "03");
  assert.equal(suggestMeioPagamentoNfe("caixa_elo", "04"), "04");
  assert.equal(suggestMeioPagamentoNfe("pix", "03"), "17");
  assert.equal(suggestMeioPagamentoNfe("boleto", "99"), "15");
  // Sem forma conhecida, vale o XML (código inválido é ignorado).
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", "16"), "16");
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", "77"), "");
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", null), "");
});

void test("suggestMeioPagamentoNfe: histórico do fornecedor quando a forma e o XML não definem", () => {
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", "99", "15"), "15");
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", null, "17"), "17");
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", "16", "15"), "16"); // XML específico vence
  assert.equal(suggestMeioPagamentoNfe("sem_marcador", "99", null), "99");
  // Cartão: débito do histórico só quando o XML não crava crédito/débito.
  assert.equal(suggestMeioPagamentoNfe("caixa_elo", "99", "04"), "04");
  assert.equal(suggestMeioPagamentoNfe("caixa_elo", "03", "04"), "03");
  assert.equal(suggestMeioPagamentoNfe("pix", "99", "04"), "17");
});
