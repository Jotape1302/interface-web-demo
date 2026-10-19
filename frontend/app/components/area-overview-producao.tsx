'use client';

import { Download, LayoutGrid, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AREA_SUMMARY } from '@/lib/areas';

// Instalador do servidor de impressão (backend/automations/automacoes-producao, gerado por empacotar.py).
// Roda no PC do encarregado: o tablet manda a etiqueta direto para ele, sem passar por esta interface.
const INSTALADOR_ETIQUETAS = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/downloads/norvia-etiquetas-producao.zip`;

export default function AreaOverviewProducao() {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Produção</p>
        <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
          <LayoutGrid size={22} className="text-primary" />
          Visão Geral de Produção
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">{AREA_SUMMARY.producao}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Automações da área</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <a
            href={INSTALADOR_ETIQUETAS}
            download
            className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-[var(--marca-ambar)]/60 hover:shadow-[var(--shadow-hover)] hover:bg-muted/40"
          >
            <span className="space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Printer size={16} className="text-primary" />
                Impressão de etiquetas
              </span>
              <span className="block text-xs text-muted-foreground">
                Instalador para o PC do encarregado com a Elgin L42-DT na USB. O botão da OP no tablet manda a
                etiqueta direto para esse PC, na rede local. Instruções no LEIA-ME dentro do zip.
              </span>
              <span className="flex gap-1.5 pt-1">
                <Badge variant="info" className="text-[10px]">
                  Windows
                </Badge>
                <Badge variant="warning" className="text-[10px]">
                  Em teste
                </Badge>
              </span>
            </span>
            <Download size={16} className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
          </a>
        </div>
      </section>
    </div>
  );
}
