import { actorHeaders, automationFetch, financeiroCandidateUrls, upstreamError, type ActorContext } from "./automation-http.js";
import type { FinancialDashboardResponse, FinancialDashboardStatus } from "./contracts.js";

/**
 * Erro específico pra "ainda não sincronizado" (404 real do Python, não uma
 * falha) — sem essa distinção, server.ts jogava QUALQUER erro (inclusive esse
 * 404 legítimo) como HTTP 500 genérico pro frontend, que só sabe mostrar a
 * tela de "sincronizar agora" quando recebe um 404 de verdade.
 */
export class FinancialDashboardNotSyncedError extends Error {}

export interface FinancialDashboardService {
  readStatus(): Promise<FinancialDashboardStatus>;
  /** `force` (ignorar o intervalo mínimo entre sincronizações) só é repassado para admin. */
  sync(actor?: ActorContext, opts?: { force?: boolean }): Promise<FinancialDashboardStatus>;
  readDashboard(dateFrom: string, dateTo: string, company?: string): Promise<FinancialDashboardResponse>;
}

const DEMO_COMPANIES = [
  { account_id: "fabrilux", label: "Fabrilux" },
  { account_id: "revesta", label: "Revesta" },
  { account_id: "norvia_campinas", label: "Norvia Campinas" },
  { account_id: "norvia_curitiba", label: "Norvia Curitiba" },
];

const DEMO_MONTH_NAMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function buildDemoFluxoCaixa(now: Date): FinancialDashboardResponse["fluxo_caixa_mensal"] {
  const months = [];
  for (let i = 12; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const seasonal = 1 + 0.12 * Math.sin(i / 2);
    const receita = Math.round(185000 * seasonal + i * 900);
    const despesa = Math.round(142000 * seasonal + (12 - i) * 600);
    months.push({
      mes: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: `${DEMO_MONTH_NAMES[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`,
      receita,
      despesa,
      saldo: receita - despesa,
    });
  }
  return months;
}

function buildDemoDespesasPorCategoria(fraction: number): FinancialDashboardResponse["despesas_por_categoria"] {
  const raw: Array<[string, string, string, number]> = [
    ["480897321", "Compras", "3.Custos", 48200],
    ["483351497", "Salários", "4.Despesas Operacionais", 39500],
    ["484437383", "Aluguel", "4.Despesas Operacionais", 18000],
    ["484441546", "Comissões", "4.Despesas Operacionais", 11200],
    ["484436608", "Impostos", "2.Deduções", 9800],
    ["484437478", "Energia Elétrica", "4.Despesas Operacionais", 4300],
    ["484437541", "Propaganda/ Publicidade", "4.Despesas Operacionais", 3900],
    ["488380104", "Software", "4.Despesas Operacionais", 3200],
    ["484437787", "Combustível", "4.Despesas Operacionais", 2100],
    ["484437483", "Material de Escritório", "4.Despesas Operacionais", 950],
  ];
  return raw.map(([categoria_id, categoria_nome, grupo, base], idx) => {
    const valor = Math.round(base * fraction);
    const valor_anterior = Math.round(valor * (0.85 + (idx % 3) * 0.08));
    const total = raw.reduce((acc, [, , , v]) => acc + Math.round(v * fraction), 0);
    return {
      categoria_id,
      categoria_nome,
      grupo,
      valor,
      valor_anterior,
      variacao_pct: valor_anterior ? Math.round(((valor - valor_anterior) / valor_anterior) * 1000) / 10 : null,
      percentual_do_total: total ? Math.round((valor / total) * 1000) / 10 : 0,
    };
  });
}

function buildDemoReceitasPorCategoria(fraction: number): FinancialDashboardResponse["receitas_por_categoria"] {
  const raw: Array<[string, string, string, number]> = [
    ["484450322", "Vendas Loja", "1.Receitas", 128500],
    ["484450325", "Vendas Online", "1.Receitas", 56300],
    ["484438533", "Receita de Aplicações", "5.Receitas Financeiras", 2100],
  ];
  const total = raw.reduce((acc, [, , , v]) => acc + Math.round(v * fraction), 0);
  return raw.map(([categoria_id, categoria_nome, grupo, base]) => {
    const valor = Math.round(base * fraction);
    return {
      categoria_id,
      categoria_nome,
      grupo,
      valor,
      valor_anterior: Math.round(valor * 0.94),
      variacao_pct: 6.4,
      percentual_do_total: total ? Math.round((valor / total) * 1000) / 10 : 0,
    };
  });
}

export function createFinancialDashboardService(
  mode: "demo" | "live",
  pythonApiUrl?: string,
): FinancialDashboardService {
  if (mode === "demo") {
    const now = new Date();
    return {
      async readStatus(): Promise<FinancialDashboardStatus> {
        const next = new Date(now);
        next.setDate(next.getDate() + (now.getHours() >= 4 ? 1 : 0));
        next.setHours(4, 0, 0, 0);
        return {
          last_sync_started_at: new Date(now.getTime() - 3 * 3600000).toISOString(),
          last_sync_finished_at: new Date(now.getTime() - 3 * 3600000 + 210000).toISOString(),
          next_sync_at: next.toISOString(),
          companies: DEMO_COMPANIES.map((c) => ({
            account_id: c.account_id,
            cnpj: "00000000000000",
            ok: true,
            erro: null,
            caixa_lancamentos: 340,
            contas_pagar_abertas: 18,
            contas_receber_abertas: 9,
          })),
          is_running: false,
          cooldown_seconds_remaining: 0,
        };
      },
      async sync(): Promise<FinancialDashboardStatus> {
        return this.readStatus();
      },
      async readDashboard(dateFrom: string, dateTo: string, company?: string): Promise<FinancialDashboardResponse> {
        const porEmpresaBase = [
          { account_id: "fabrilux", label: "Fabrilux", receita: 74200, despesa: 58100 },
          { account_id: "revesta", label: "Revesta", receita: 51300, despesa: 41900 },
          { account_id: "norvia_campinas", label: "Norvia Campinas", receita: 39800, despesa: 33200 },
          { account_id: "norvia_curitiba", label: "Norvia Curitiba", receita: 21500, despesa: 18900 },
        ];
        const empresa = company ? porEmpresaBase.find((e) => e.account_id === company) : undefined;
        const totalReceita = porEmpresaBase.reduce((acc, e) => acc + e.receita, 0);
        const totalDespesa = porEmpresaBase.reduce((acc, e) => acc + e.despesa, 0);
        const receitaFraction = empresa ? empresa.receita / totalReceita : 1;
        const despesaFraction = empresa ? empresa.despesa / totalDespesa : 1;

        const despesas = buildDemoDespesasPorCategoria(despesaFraction);
        const receitas = buildDemoReceitasPorCategoria(receitaFraction);
        const despesaTotal = despesas.reduce((acc, d) => acc + d.valor, 0);
        const receitaTotal = receitas.reduce((acc, d) => acc + d.valor, 0);
        const despesaAnterior = despesas.reduce((acc, d) => acc + d.valor_anterior, 0);
        const receitaAnterior = receitas.reduce((acc, d) => acc + d.valor_anterior, 0);
        const resultadoLiquido = receitaTotal - despesaTotal;
        const resultadoAnterior = receitaAnterior - despesaAnterior;
        const faturamentoBruto = receitas.filter((r) => r.grupo === "1.Receitas").reduce((acc, r) => acc + r.valor, 0);
        const faturamentoBrutoAnterior = receitas
          .filter((r) => r.grupo === "1.Receitas")
          .reduce((acc, r) => acc + r.valor_anterior, 0);

        const start = new Date(dateFrom);
        const end = new Date(dateTo);
        const lengthDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
        const prevEnd = new Date(start.getTime() - 86400000);
        const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * 86400000);

        return {
          generated_at: new Date(now.getTime() - 3 * 3600000 + 210000).toISOString(),
          period: {
            from: dateFrom,
            to: dateTo,
            previous_from: prevStart.toISOString().slice(0, 10),
            previous_to: prevEnd.toISOString().slice(0, 10),
          },
          companies_available: DEMO_COMPANIES,
          company_selected: company ?? null,
          summary: {
            receita_total: receitaTotal,
            receita_total_anterior: receitaAnterior,
            receita_variacao_pct: receitaAnterior ? Math.round(((receitaTotal - receitaAnterior) / receitaAnterior) * 1000) / 10 : null,
            faturamento_bruto: faturamentoBruto,
            faturamento_bruto_anterior: faturamentoBrutoAnterior,
            faturamento_bruto_variacao_pct: faturamentoBrutoAnterior
              ? Math.round(((faturamentoBruto - faturamentoBrutoAnterior) / faturamentoBrutoAnterior) * 1000) / 10
              : null,
            despesa_total: despesaTotal,
            despesa_total_anterior: despesaAnterior,
            despesa_variacao_pct: despesaAnterior ? Math.round(((despesaTotal - despesaAnterior) / despesaAnterior) * 1000) / 10 : null,
            resultado_liquido: resultadoLiquido,
            resultado_liquido_anterior: resultadoAnterior,
            resultado_liquido_variacao_pct: resultadoAnterior
              ? Math.round(((resultadoLiquido - resultadoAnterior) / Math.abs(resultadoAnterior)) * 1000) / 10
              : null,
            margem_liquida_pct: receitaTotal ? Math.round((resultadoLiquido / receitaTotal) * 1000) / 10 : null,
            margem_liquida_pct_anterior: receitaAnterior ? Math.round((resultadoAnterior / receitaAnterior) * 1000) / 10 : null,
          },
          fluxo_caixa_mensal: buildDemoFluxoCaixa(now),
          despesas_por_categoria: despesas,
          receitas_por_categoria: receitas,
          concentracao_despesas_top3_pct:
            Math.round(despesas.slice(0, 3).reduce((acc, d) => acc + d.percentual_do_total, 0) * 10) / 10,
          categoria_maior_alta: { categoria_nome: "Comissões", variacao_pct: 22.4 },
          contas_a_pagar: {
            vencido_valor: Math.round(8420 * despesaFraction),
            vencido_qtd: empresa ? Math.max(1, Math.round(4 * despesaFraction)) : 4,
            proximos_7_dias_valor: Math.round(15600 * despesaFraction),
            proximos_7_dias_qtd: empresa ? Math.max(1, Math.round(6 * despesaFraction)) : 6,
            proximos_30_dias_valor: Math.round(61200 * despesaFraction),
            proximos_30_dias_qtd: empresa ? Math.max(1, Math.round(18 * despesaFraction)) : 18,
            top: [
              { nome: "Distribuidora Alfa Ltda", valor: Math.round(12400 * despesaFraction), qtd: 3 },
              { nome: "Fornecedor Beta S.A.", valor: Math.round(9800 * despesaFraction), qtd: 2 },
              { nome: "Transportadora Gama", valor: Math.round(7100 * despesaFraction), qtd: 4 },
              { nome: "Gráfica Delta", valor: Math.round(5200 * despesaFraction), qtd: 1 },
              { nome: "Escritório Contábil Épsilon", valor: Math.round(3600 * despesaFraction), qtd: 1 },
            ],
          },
          contas_a_receber: {
            vencido_valor: Math.round(4100 * receitaFraction),
            vencido_qtd: empresa ? Math.max(1, Math.round(2 * receitaFraction)) : 2,
            proximos_7_dias_valor: Math.round(9200 * receitaFraction),
            proximos_7_dias_qtd: empresa ? Math.max(1, Math.round(5 * receitaFraction)) : 5,
            proximos_30_dias_valor: Math.round(38500 * receitaFraction),
            proximos_30_dias_qtd: empresa ? Math.max(1, Math.round(14 * receitaFraction)) : 14,
            top: [
              { nome: "Cliente Corporativo Zeta", valor: Math.round(6200 * receitaFraction), qtd: 1 },
              { nome: "Cliente Varejo Theta", valor: Math.round(2900 * receitaFraction), qtd: 3 },
            ],
            taxa_inadimplencia_pct: 9.6,
          },
          forma_pagamento: [
            { marcador: "Outros / Pix / Boleto", valor: Math.round(despesaTotal * 0.52), percentual: 52 },
            { marcador: "Cartão Clara", valor: Math.round(despesaTotal * 0.24), percentual: 24 },
            { marcador: "Caixa Visa Norvia", valor: Math.round(despesaTotal * 0.13), percentual: 13 },
            { marcador: "Caixa Elo", valor: Math.round(despesaTotal * 0.11), percentual: 11 },
          ],
          por_empresa: company
            ? null
            : porEmpresaBase.map((e) => ({ ...e, resultado_liquido: e.receita - e.despesa })),
        };
      },
    };
  }

  // MODO LIVE: comunica com a API Python do automacao-nfe (mesmo motor da NF-e & DANFE).
  const candidateUrls = financeiroCandidateUrls(pythonApiUrl);

  let activePythonUrl = candidateUrls[0] || "http://127.0.0.1:8000";

  async function resolvePythonUrl(): Promise<string> {
    try {
      const res = await automationFetch(`${activePythonUrl}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return activePythonUrl;
    } catch {
      // URL ativa falhou, tenta outros candidatos
    }
    for (const url of candidateUrls) {
      if (url === activePythonUrl) continue;
      try {
        const res = await automationFetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          activePythonUrl = url;
          return activePythonUrl;
        }
      } catch {
        // tenta o próximo candidato
      }
    }
    return activePythonUrl;
  }

  return {
    async readStatus(): Promise<FinancialDashboardStatus> {
      const baseUrl = await resolvePythonUrl();
      const res = await automationFetch(`${baseUrl}/api/v1/financial-dashboard/status`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as FinancialDashboardStatus;
    },
    async sync(actor?: ActorContext, opts?: { force?: boolean }): Promise<FinancialDashboardStatus> {
      const baseUrl = await resolvePythonUrl();
      const res = await automationFetch(`${baseUrl}/api/v1/financial-dashboard/sync${opts?.force ? "?force=true" : ""}`, {
        method: "POST",
        headers: actorHeaders(actor, { asUser: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao sincronizar o Dashboard Financeiro");
      return (await res.json()) as FinancialDashboardStatus;
    },
    async readDashboard(dateFrom: string, dateTo: string, company?: string): Promise<FinancialDashboardResponse> {
      const baseUrl = await resolvePythonUrl();
      const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
      if (company) query.set("company", company);
      const res = await automationFetch(`${baseUrl}/api/v1/financial-dashboard?${query.toString()}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404) {
        const errBody = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new FinancialDashboardNotSyncedError(
          errBody?.detail || "Dashboard Financeiro ainda não foi sincronizado.",
        );
      }
      if (!res.ok) throw await upstreamError(res, "Falha ao consultar o Dashboard Financeiro");
      return (await res.json()) as FinancialDashboardResponse;
    },
  };
}
