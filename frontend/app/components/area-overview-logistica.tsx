'use client';

import Link from 'next/link';
import { ChevronRight, LayoutGrid, PackageSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AREA_SUMMARY } from '@/lib/areas';
import { stockCount } from '@/lib/automations';

// Visão geral da Logística: lista as automações da área. A Contagem de Estoque roda no
// Telegram e não expõe indicadores ao gateway, então aqui não há métricas.
export default function AreaOverviewLogistica() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Logística</p>
        <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
          <LayoutGrid size={22} className="text-primary" />
          Visão Geral de Logística
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">{AREA_SUMMARY.logistica}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Automações da área</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Link
            href="/contagem-estoque"
            className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-[var(--marca-ambar)]/60 hover:shadow-[var(--shadow-hover)] hover:bg-muted/40"
          >
            <span className="space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <PackageSearch size={16} className="text-primary" />
                {stockCount.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                Conta os pacotes de uma prateleira pela foto, identificando o prendedor verde de cada pacote.
              </span>
              <span className="flex gap-1.5 pt-1">
                <Badge variant="info" className="text-[10px]">
                  Bot no Telegram
                </Badge>
                <Badge variant="warning" className="text-[10px]">
                  Em calibração
                </Badge>
              </span>
            </span>
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
          </Link>
        </div>
      </section>
    </div>
  );
}
