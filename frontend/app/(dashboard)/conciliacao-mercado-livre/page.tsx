'use client';

import { ShoppingBag } from 'lucide-react';
import MlReconciliationView from '../../components/ml-reconciliation-view';

export default function MlReconciliationPage() {
  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-border/60">
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Conciliação Mercado Livre & Baixa
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <ShoppingBag className="text-primary" size={26} />
            Conciliação Mercado Livre
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Vendas do Mercado Livre × liberações do Mercado Pago × Contas a Receber do Tiny ERP, todo dia: baixa dos recebimentos, lançamentos de caixa e saldo por dia.
          </p>
        </div>
      </div>

      {/* Modo demo/live é decidido pelo serviço (isDemoSession), como na conciliação Inter. */}
      <MlReconciliationView apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ''} />
    </>
  );
}
