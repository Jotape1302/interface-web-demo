'use client';

import Link from 'next/link';
import { ChevronRight, LayoutGrid, Ruler, Truck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AREA_SUMMARY } from '@/lib/areas';
import { fretesACombinar, padronizacaoDimensoes } from '@/lib/automations';

// Visão geral do Marketplace: lista as automações da área. Os números ficam na tela de cada uma.
export default function AreaOverviewMarketplace() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Marketplace</p>
        <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
          <LayoutGrid size={22} className="text-primary" />
          Visão Geral de Marketplace
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">{AREA_SUMMARY.marketplace}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Automações da área</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Link
            href="/padronizacao-dimensoes"
            className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-[var(--marca-ambar)]/60 hover:shadow-[var(--shadow-hover)] hover:bg-muted/40"
          >
            <span className="space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Ruler size={16} className="text-primary" />
                {padronizacaoDimensoes.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                Compara as medidas de cada produto no Mercado Livre e no Tiny, você valida e elas são gravadas e enviadas a todas as plataformas.
              </span>
              <span className="flex gap-1.5 pt-1">
                <Badge variant="info" className="text-[10px]">
                  Mercado Livre
                </Badge>
                <Badge variant="info" className="text-[10px]">
                  Tiny ERP
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  Diária
                </Badge>
              </span>
            </span>
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
          </Link>
          <Link
            href="/fretes-a-combinar"
            className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-[var(--marca-ambar)]/60 hover:shadow-[var(--shadow-hover)] hover:bg-muted/40"
          >
            <span className="space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Truck size={16} className="text-primary" />
                {fretesACombinar.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                Define o tipo de envio pelas dimensões padronizadas e tira do frete a combinar os anúncios, com conferência 10 minutos depois.
              </span>
              <span className="flex gap-1.5 pt-1">
                <Badge variant="info" className="text-[10px]">
                  Mercado Livre
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  Diária
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
