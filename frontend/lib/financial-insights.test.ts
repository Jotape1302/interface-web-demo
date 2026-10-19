import assert from "node:assert/strict";
import test from "node:test";
import { generateFinancialInsights } from "./financial-insights";
import type { FinancialDashboardResponse } from "./contracts";

function baseData(overrides: Partial<FinancialDashboardResponse> = {}): FinancialDashboardResponse {
  return {
    generated_at: "2026-09-21T10:00:00.000Z",
    period: { from: "2026-09-01", to: "2026-09-21", previous_from: "2026-08-11", previous_to: "2026-08-31" },
    companies_available: [{ account_id: "fabrilux", label: "Fabrilux" }],
    company_selected: null,
    summary: {
      receita_total: 100000,
      receita_total_anterior: 95000,
      receita_variacao_pct: 5.3,
      faturamento_bruto: 90000,
      faturamento_bruto_anterior: 88000,
      faturamento_bruto_variacao_pct: 2.3,
      despesa_total: 70000,
      despesa_total_anterior: 68000,
      despesa_variacao_pct: 2.9,
      resultado_liquido: 30000,
      resultado_liquido_anterior: 27000,
      resultado_liquido_variacao_pct: 11.1,
      margem_liquida_pct: 30,
      margem_liquida_pct_anterior: 28.4,
    },
    fluxo_caixa_mensal: [],
    despesas_por_categoria: [],
    receitas_por_categoria: [],
    concentracao_despesas_top3_pct: 40,
    categoria_maior_alta: null,
    contas_a_pagar: {
      vencido_valor: 0,
      vencido_qtd: 0,
      proximos_7_dias_valor: 0,
      proximos_7_dias_qtd: 0,
      proximos_30_dias_valor: 0,
      proximos_30_dias_qtd: 0,
      top: [],
    },
    contas_a_receber: {
      vencido_valor: 0,
      vencido_qtd: 0,
      proximos_7_dias_valor: 0,
      proximos_7_dias_qtd: 0,
      proximos_30_dias_valor: 0,
      proximos_30_dias_qtd: 0,
      top: [],
      taxa_inadimplencia_pct: 0,
    },
    forma_pagamento: [],
    por_empresa: null,
    ...overrides,
  };
}

test("flags despesas growing faster than receita as a warning", () => {
  const data = baseData({
    summary: {
      ...baseData().summary,
      receita_variacao_pct: 2,
      despesa_variacao_pct: 15,
    },
  });
  const insights = generateFinancialInsights(data);
  const found = insights.find((i) => i.id === "despesa-cresceu-mais");
  assert.ok(found, "expected a despesa-cresceu-mais insight");
  assert.equal(found?.tone, "warning");
});

test("flags receita growing faster than despesas as positive", () => {
  const data = baseData({
    summary: { ...baseData().summary, receita_variacao_pct: 15, despesa_variacao_pct: 2 },
  });
  const insights = generateFinancialInsights(data);
  const found = insights.find((i) => i.id === "receita-cresceu-mais");
  assert.ok(found);
  assert.equal(found?.tone, "positive");
});

test("negative resultado_liquido is always tone negative regardless of trend", () => {
  const data = baseData({
    summary: {
      ...baseData().summary,
      resultado_liquido: -5000,
      resultado_liquido_anterior: -8000,
      resultado_liquido_variacao_pct: 37.5,
    },
  });
  const insights = generateFinancialInsights(data);
  const found = insights.find((i) => i.id === "lucro-trend");
  assert.equal(found?.tone, "negative");
});

test("overdue contas a pagar always surfaces a negative insight", () => {
  const data = baseData({
    contas_a_pagar: {
      vencido_valor: 8000,
      vencido_qtd: 3,
      proximos_7_dias_valor: 0,
      proximos_7_dias_qtd: 0,
      proximos_30_dias_valor: 0,
      proximos_30_dias_qtd: 0,
      top: [],
    },
  });
  const insights = generateFinancialInsights(data);
  const found = insights.find((i) => i.id === "contas-pagar-vencidas");
  assert.ok(found);
  assert.equal(found?.tone, "negative");
  assert.match(found!.description, /3 conta/);
});

test("high inadimplencia rate triggers a warning", () => {
  const data = baseData({
    contas_a_receber: { ...baseData().contas_a_receber, taxa_inadimplencia_pct: 12.5 },
  });
  const insights = generateFinancialInsights(data);
  assert.ok(insights.find((i) => i.id === "inadimplencia"));
});

test("worst company with negative resultado surfaces a negative insight", () => {
  const data = baseData({
    por_empresa: [
      { account_id: "a", label: "Empresa A", receita: 100, despesa: 50, resultado_liquido: 50 },
      { account_id: "b", label: "Empresa B", receita: 40, despesa: 60, resultado_liquido: -20 },
    ],
  });
  const insights = generateFinancialInsights(data);
  assert.ok(insights.find((i) => i.id === "melhor-empresa" && i.title.includes("Empresa A")));
  assert.ok(insights.find((i) => i.id === "pior-empresa" && i.title.includes("Empresa B")));
});

test("insights are sorted negative/warning before positive/neutral", () => {
  const data = baseData({
    summary: { ...baseData().summary, receita_variacao_pct: 15, despesa_variacao_pct: 2 },
    contas_a_pagar: {
      vencido_valor: 1000,
      vencido_qtd: 1,
      proximos_7_dias_valor: 0,
      proximos_7_dias_qtd: 0,
      proximos_30_dias_valor: 0,
      proximos_30_dias_qtd: 0,
      top: [],
    },
  });
  const insights = generateFinancialInsights(data);
  const negativeIdx = insights.findIndex((i) => i.tone === "negative");
  const positiveIdx = insights.findIndex((i) => i.tone === "positive");
  assert.ok(negativeIdx !== -1 && positiveIdx !== -1);
  assert.ok(negativeIdx < positiveIdx);
});

test("caps the number of insights returned", () => {
  const data = baseData({
    categoria_maior_alta: { categoria_nome: "Comissões", variacao_pct: 40 },
    concentracao_despesas_top3_pct: 80,
    contas_a_pagar: {
      vencido_valor: 500,
      vencido_qtd: 1,
      proximos_7_dias_valor: 0,
      proximos_7_dias_qtd: 0,
      proximos_30_dias_valor: 0,
      proximos_30_dias_qtd: 0,
      top: [],
    },
    contas_a_receber: { ...baseData().contas_a_receber, taxa_inadimplencia_pct: 20 },
    por_empresa: [
      { account_id: "a", label: "A", receita: 100, despesa: 50, resultado_liquido: 50 },
      { account_id: "b", label: "B", receita: 40, despesa: 60, resultado_liquido: -20 },
    ],
  });
  const insights = generateFinancialInsights(data);
  assert.ok(insights.length <= 8);
});
