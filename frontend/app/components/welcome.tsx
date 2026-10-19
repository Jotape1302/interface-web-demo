'use client';

import Link from 'next/link';
import { ChevronRight, Folder, Lock } from 'lucide-react';
import { AREA_SUMMARY, accessibleAreas, areaEntryHref } from '@/lib/areas';
import { useAuth } from '@/lib/auth-context';
import { NorviaLogo } from '@/components/ui/norvia-logo';

// Página inicial, comum a todos os setores: apresenta a plataforma e leva às
// áreas que o usuário pode abrir. Os dados de cada área ficam na Visão geral dela.
export default function Welcome() {
  const { user, session } = useAuth();
  const areas = accessibleAreas(session);
  const firstName = user?.nome?.split(' ')[0];

  return (
    <section className="mx-auto max-w-3xl py-10">
      <NorviaLogo size={44} className="official-logo mb-4" />
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        {firstName ? `Bem-vindo(a), ${firstName}` : 'Bem-vindo(a)'}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Esta é a interface de controle das automações da <strong className="text-foreground">Norvia Acabamentos</strong>.
        Aqui cada setor acompanha as automações que trabalham para ele: o que foi executado, o que falhou e o que
        precisa de uma decisão sua.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        As automações ficam organizadas em pastas por setor no menu lateral, e cada pasta tem uma Visão geral própria.
        Você vê apenas as pastas e abas liberadas para você. Para falar com outro colaborador, use o Chat.
      </p>

      <h2 className="mt-8 mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Suas áreas</h2>
      {areas.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {areas.map((area) => (
            <Link
              key={area.id}
              href={areaEntryHref(session, area.id) ?? area.href}
              className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-[var(--marca-ambar)]/60 hover:shadow-[var(--shadow-hover)] hover:bg-muted/40"
            >
              <span>
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Folder size={16} className="text-primary" />
                  {area.title}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{AREA_SUMMARY[area.id]}</span>
              </span>
              <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          <Lock size={16} className="mt-0.5 shrink-0" />
          <span>
            Nenhuma aba foi liberada para você ainda: por enquanto você vê só o Início e o Chat. Peça ao administrador
            para liberar as abas de que precisa em Gestão de Usuários.
          </span>
        </div>
      )}
    </section>
  );
}
