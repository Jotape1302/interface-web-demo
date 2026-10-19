import type { DashboardResponse } from "./contracts";

export interface AutomationDefinition {
  id: string;
  title: string;
  providers: readonly string[];
  enabled: boolean;
}

export const accountsPayable: AutomationDefinition = {
  id: "accounts-payable",
  title: "Contas a Pagar",
  providers: ["Tiny ERP", "Banco Inter"],
  enabled: true,
};

export const mlReconciliation: AutomationDefinition = {
  id: "ml-reconciliation",
  title: "Conciliação Mercado Livre",
  providers: ["Mercado Livre", "Mercado Pago", "Tiny ERP"],
  enabled: true,
};

export const danfeAutomation: AutomationDefinition = {
  id: "danfe-tiny",
  title: "NF-e & DANFE",
  providers: ["SEFAZ", "Tiny ERP"],
  enabled: true,
};

export const financialDashboard: AutomationDefinition = {
  id: "financial-dashboard",
  title: "Dashboards Financeiro",
  providers: ["Tiny ERP"],
  enabled: true,
};

export const stockCount: AutomationDefinition = {
  id: "stock-count",
  title: "Contagem de Estoque",
  providers: ["Telegram"],
  enabled: true,
};

export const padronizacaoDimensoes: AutomationDefinition = {
  id: "dimension-standardization",
  title: "Padronização de dimensões",
  providers: ["Mercado Livre", "Tiny ERP"],
  enabled: true,
};

// Tela em /fretes-a-combinar (rota mantida: links de notificações antigas apontam para ela).
export const fretesACombinar: AutomationDefinition = {
  id: "shipping-review",
  title: "Tipo de frete",
  providers: ["Mercado Livre"],
  enabled: true,
};

export const futureAutomations: AutomationDefinition = {
  id: "future",
  title: "Novas automações",
  providers: [],
  enabled: false,
};

export type AutomationStatus =
  | "Carregando"
  | "Falha"
  | "Falha de conexão"
  | "Requer atenção"
  | "Operacional";
export function automationStatus(
  data: DashboardResponse | null,
  loading: boolean,
  hasRequestError: boolean,
): AutomationStatus {
  if (!data) return loading ? "Carregando" : "Falha";
  if (
    hasRequestError ||
    data.sources.database.status === "error" ||
    data.sources.n8n.status === "error"
  )
    return "Falha de conexão";
  if (
    (data.failures?.length ?? 0) > 0 ||
    (data.approvals?.length ?? 0) > 0 ||
    data.executions?.some((execution) => execution.status === "error")
  )
    return "Requer atenção";
  return "Operacional";
}
