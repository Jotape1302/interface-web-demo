'use client';

import { Folder } from 'lucide-react';
import { AREAS, AREA_SUMMARY, type AreaId } from '@/lib/areas';

// Visão geral de uma área que ainda não tem automações publicadas.
export default function AreaOverviewEmpty({ area }: { area: AreaId }) {
  const title = AREAS.find((a) => a.id === area)?.title ?? area;
  return (
    <section className="mx-auto max-w-xl py-16 text-center">
      <Folder size={28} className="mx-auto mb-3 text-muted-foreground" />
      <h1 className="text-lg font-bold text-foreground">Visão Geral de {title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {AREA_SUMMARY[area]} Assim que a primeira automação desta área for publicada, os indicadores dela aparecem aqui.
      </p>
    </section>
  );
}
