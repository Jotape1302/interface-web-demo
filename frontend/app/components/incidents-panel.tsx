'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth-context';
import { formatDateTimeBR } from '@/lib/formatters';
import {
  type ReportedIncident,
  getReportedIncidents,
  refreshIncidents,
  resolveIncident,
  subscribeToIncidents,
} from '@/lib/incidents-store';

// Erros & Falhas (bloco SISTEMA, /admin/erros): fila de incidentes reportados pelos operadores.
// Ver exige erros:ver; "Marcar como resolvido" exige erros:resolver (o gateway confere as duas).
export default function IncidentsPanel() {
  const { user, can } = useAuth();
  const [incidents, setIncidents] = useState<ReportedIncident[]>([]);
  const canResolve = can('erros:resolver');

  useEffect(() => {
    const update = () => setIncidents(getReportedIncidents());
    const unsubscribe = subscribeToIncidents(update);
    void refreshIncidents().finally(update);
    return unsubscribe;
  }, []);

  const pending = useMemo(() => incidents.filter((i) => i.status === 'pending'), [incidents]);

  const handleResolve = async (incidentId: string) => {
    try {
      await resolveIncident(incidentId, user?.nome || 'Administrador');
      toast.add({ title: 'Incidente marcado como resolvido.', type: 'success' });
    } catch (e) {
      toast.add({ title: e instanceof Error ? e.message : 'Falha ao resolver incidente.', type: 'error' });
    }
    setIncidents(getReportedIncidents());
  };

  return (
    <div className="space-y-4">
      <div className="border-b border-border pb-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sistema</p>
        <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
          <AlertTriangle size={20} className="text-primary" aria-hidden="true" />
          Erros &amp; Falhas
        </h1>
      </div>

      <div className="flex flex-col justify-between gap-3 rounded-[4px] border border-border bg-card p-3.5 text-xs text-muted-foreground sm:flex-row sm:items-center">
        <span>
          Fila de incidentes operacionais reportados pelos colaboradores. O diagnóstico já detalha a causa raiz e a ação
          recomendada para resolver.
        </span>
        <span className="shrink-0 text-xs font-semibold text-foreground" aria-live="polite">
          {pending.length} pendente{pending.length !== 1 ? 's' : ''}
        </span>
      </div>

      {incidents.length === 0 ? (
        <div className="rounded-[4px] border border-dashed border-border bg-card p-10 text-center text-muted-foreground">
          <CheckCircle size={36} className="mx-auto mb-2 text-[var(--status-success-fg)]" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">Nenhum incidente reportado pendente.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Quando um operador reportar um erro em Contas a Pagar ou NF-e &amp; DANFE, ele aparecerá aqui com diagnóstico
            completo.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {incidents.map((inc) => {
            const isPending = inc.status === 'pending';
            return (
              <article
                key={inc.id}
                className={`rounded-[4px] border bg-card p-5 shadow-xs ${
                  isPending ? 'border-[var(--status-error-border)]' : 'border-border opacity-80'
                }`}
              >
                <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-3 sm:flex-row sm:items-center">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="rounded-[4px] border border-border bg-muted px-2 py-0.5 font-mono text-xs font-bold text-foreground">
                      #{inc.executionId}
                    </span>
                    <span className="text-xs font-semibold text-foreground">{inc.automationTitle}</span>
                    <span className="text-muted-foreground" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Nó de parada:{' '}
                      <strong className="font-semibold text-[var(--status-error-fg)]">{inc.stoppedNode || 'Geral'}</strong>
                    </span>
                  </div>
                  <Badge variant={isPending ? 'danger' : 'success'} className="text-xs font-semibold">
                    {isPending ? 'Pendente de resolução' : 'Resolvido'}
                  </Badge>
                </div>

                <div className="my-4 grid grid-cols-1 gap-3.5 md:grid-cols-2">
                  <div className="space-y-1.5 rounded-[4px] border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3.5 text-xs">
                    <strong className="flex items-center gap-1.5 text-xs font-semibold text-[var(--status-error-fg)]">
                      <AlertTriangle size={13} aria-hidden="true" />
                      Diagnóstico da falha:
                    </strong>
                    <p className="text-xs leading-relaxed text-foreground/90">{inc.diagnosticExplanation}</p>
                  </div>
                  <div className="space-y-1.5 rounded-[4px] border border-[var(--status-success-border)] bg-[var(--status-success-bg)] p-3.5 text-xs">
                    <strong className="flex items-center gap-1.5 text-xs font-semibold text-[var(--status-success-fg)]">
                      <CheckCircle size={13} aria-hidden="true" />
                      Ação recomendada:
                    </strong>
                    <p className="text-xs leading-relaxed text-foreground/90">{inc.recommendedAction}</p>
                  </div>
                </div>

                {inc.operatorNote && (
                  <div className="mb-4 rounded-[4px] border border-border/70 bg-muted/40 p-2.5 text-xs">
                    <span className="font-semibold text-muted-foreground">Observação do operador: </span>
                    <span className="italic text-foreground">&ldquo;{inc.operatorNote}&rdquo;</span>
                  </div>
                )}

                <div className="flex flex-col justify-between gap-3 border-t border-border/40 pt-2 text-xs text-muted-foreground sm:flex-row sm:items-center">
                  <div>
                    Reportado por <strong>{inc.reportedBy}</strong> ({inc.userRole}) em {formatDateTimeBR(inc.reportedAt)}
                  </div>
                  <div>
                    {isPending ? (
                      canResolve && (
                        <Button size="sm" variant="cta" onClick={() => void handleResolve(inc.id)}>
                          <CheckCircle aria-hidden="true" />
                          Marcar como resolvido
                        </Button>
                      )
                    ) : (
                      <span className="font-medium text-[var(--status-success-fg)]">
                        Resolvido por {inc.resolvedBy || 'Admin'} em {formatDateTimeBR(inc.resolvedAt)}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
