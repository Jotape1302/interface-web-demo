import type { FinancialDashboardResponse } from "./contracts";

/**
 * Motor de comparação entre períodos: lê os deltas já calculados pelo backend
 * (receita, despesa, faturamento bruto, lucro, categorias, aging) e traduz em
 * insights financeiros textuais, ordenados por relevância (o que exige atenção
 * primeiro). Função pura — sem chamada de rede, fácil de testar isoladamente.
 */

export type FinancialInsightTone = "positive" | "negative" | "warning" | "neutral";

export interface FinancialInsight {
  id: string;
  tone: FinancialInsightTone;
  title: string;
  description: string;
}

const TONE_PRIORITY: Record<FinancialInsightTone, number> = {
  negative: 0,
  warning: 1,
  positive: 2,
  neutral: 3,
};

function fmtPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1).replace(".", ",")}%`;
}

function fmtMoney(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

export function generateFinancialInsights(data: FinancialDashboardResponse): FinancialInsight[] {
  const insights: FinancialInsight[] = [];
  const { summary } = data;

  if (summary.receita_variacao_pct !== null && summary.despesa_variacao_pct !== null) {
    const gap = summary.receita_variacao_pct - summary.despesa_variacao_pct;
    if (gap < -2) {
      insights.push({
        id: "despesa-cresceu-mais",
        tone: "warning",
        title: "Despesas crescendo mais rápido que a receita",
        description: `Despesas variaram ${fmtPct(summary.despesa_variacao_pct)} contra ${fmtPct(summary.receita_variacao_pct)} da receita no período — margem sob pressão.`,
      });
    } else if (gap > 2) {
      insights.push({
        id: "receita-cresceu-mais",
        tone: "positive",
        title: "Receita crescendo mais rápido que as despesas",
        description: `Receita variou ${fmtPct(summary.receita_variacao_pct)} contra ${fmtPct(summary.despesa_variacao_pct)} das despesas — ganho real de eficiência no período.`,
      });
    }
  }

  if (summary.faturamento_bruto_variacao_pct !== null) {
    const alta = summary.faturamento_bruto_variacao_pct >= 0;
    insights.push({
      id: "faturamento-bruto",
      tone: alta ? "positive" : "negative",
      title: alta ? "Faturamento bruto em alta" : "Faturamento bruto em queda",
      description: `Vendas somaram ${fmtMoney(summary.faturamento_bruto)} no período, variação de ${fmtPct(summary.faturamento_bruto_variacao_pct)} vs. período anterior.`,
    });
  }

  if (summary.resultado_liquido_variacao_pct !== null) {
    const negativo = summary.resultado_liquido < 0;
    const subiu = summary.resultado_liquido_variacao_pct >= 0;
    insights.push({
      id: "lucro-trend",
      tone: negativo ? "negative" : subiu ? "positive" : "warning",
      title: negativo ? "Resultado líquido negativo no período" : subiu ? "Lucro em crescimento" : "Lucro em queda",
      description: `Resultado líquido de ${fmtMoney(summary.resultado_liquido)} (${fmtPct(summary.resultado_liquido_variacao_pct)} vs. período anterior).`,
    });
  }

  if (summary.margem_liquida_pct !== null && summary.margem_liquida_pct_anterior !== null) {
    const deltaPontos = Math.round((summary.margem_liquida_pct - summary.margem_liquida_pct_anterior) * 10) / 10;
    if (Math.abs(deltaPontos) >= 1) {
      insights.push({
        id: "margem-trend",
        tone: deltaPontos >= 0 ? "positive" : "warning",
        title: deltaPontos >= 0 ? "Margem líquida melhorou" : "Margem líquida piorou",
        description: `Margem foi de ${summary.margem_liquida_pct_anterior.toFixed(1).replace(".", ",")}% para ${summary.margem_liquida_pct.toFixed(1).replace(".", ",")}% (${deltaPontos >= 0 ? "+" : ""}${deltaPontos.toFixed(1).replace(".", ",")} p.p.).`,
      });
    }
  }

  if (data.categoria_maior_alta) {
    insights.push({
      id: "categoria-maior-alta",
      tone: "warning",
      title: `Categoria "${data.categoria_maior_alta.categoria_nome}" com maior alta`,
      description: `Cresceu ${fmtPct(data.categoria_maior_alta.variacao_pct)} vs. período anterior — vale revisar o motivo do aumento.`,
    });
  }

  if (data.concentracao_despesas_top3_pct >= 60) {
    insights.push({
      id: "concentracao-despesas",
      tone: "neutral",
      title: "Despesas concentradas em poucas categorias",
      description: `As 3 maiores categorias respondem por ${data.concentracao_despesas_top3_pct.toFixed(1).replace(".", ",")}% do total gasto no período.`,
    });
  }

  if (data.contas_a_pagar.vencido_valor > 0) {
    insights.push({
      id: "contas-pagar-vencidas",
      tone: "negative",
      title: "Contas a pagar vencidas precisam de atenção",
      description: `${fmtMoney(data.contas_a_pagar.vencido_valor)} em ${data.contas_a_pagar.vencido_qtd} conta(s) já estão vencidas.`,
    });
  }

  if ((data.contas_a_receber.taxa_inadimplencia_pct ?? 0) >= 5) {
    insights.push({
      id: "inadimplencia",
      tone: "warning",
      title: "Taxa de inadimplência acima do ideal",
      description: `${(data.contas_a_receber.taxa_inadimplencia_pct ?? 0).toFixed(1).replace(".", ",")}% do saldo a receber em aberto já está vencido.`,
    });
  }

  if (data.por_empresa && data.por_empresa.length > 1) {
    const ordenado = [...data.por_empresa].sort((a, b) => b.resultado_liquido - a.resultado_liquido);
    const melhor = ordenado[0];
    const pior = ordenado[ordenado.length - 1];
    if (melhor.resultado_liquido > 0) {
      insights.push({
        id: "melhor-empresa",
        tone: "positive",
        title: `${melhor.label} lidera o resultado do grupo`,
        description: `Resultado líquido de ${fmtMoney(melhor.resultado_liquido)} no período, o melhor entre as empresas monitoradas.`,
      });
    }
    if (pior.resultado_liquido < 0) {
      insights.push({
        id: "pior-empresa",
        tone: "negative",
        title: `${pior.label} operando no prejuízo`,
        description: `Resultado líquido de ${fmtMoney(pior.resultado_liquido)} no período — vale investigar as despesas dessa unidade.`,
      });
    }
  }

  return insights.sort((a, b) => TONE_PRIORITY[a.tone] - TONE_PRIORITY[b.tone]).slice(0, 8);
}
