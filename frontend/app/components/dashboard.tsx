"use client";

import { Wallet } from "lucide-react";
import type { DashboardConfig } from "@/lib/contracts";
import ReconciliationView from "./reconciliation-view";

export default function Dashboard({
  config,
}: {
  config: DashboardConfig;
  service?: unknown;
}) {
  return (
    <>
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-border/60">
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Conciliação Bancária & Baixa
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Wallet className="text-primary" size={26} />
            Contas a Pagar
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Baixa assistida de contas a pagar por conciliação bancária Banco Inter × Tiny ERP.
          </p>
        </div>
      </div>

      {/* Visão de Conciliação e Baixa */}
      <ReconciliationView apiBaseUrl={config.apiBaseUrl} />
    </>
  );
}
