'use client';

import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Flag,
  Send,
  X,
  Info,
  ShieldAlert,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import {
  getIncidentDiagnostic,
  reportIncident,
} from '@/lib/incidents-store';

interface ReportIncidentModalProps {
  isOpen: boolean;
  onClose: () => void;
  executionId: string;
  automationId: 'accounts-payable' | 'danfe-tiny';
  automationTitle: string;
  stoppedNode?: string;
  onReported?: () => void;
}

export function ReportIncidentModal({
  isOpen,
  onClose,
  executionId,
  automationId,
  automationTitle,
  stoppedNode,
  onReported,
}: ReportIncidentModalProps) {
  const { user } = useAuth();
  const [operatorNote, setOperatorNote] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!isOpen) return null;

  const { diagnostic, action } = getIncidentDiagnostic(automationId, stoppedNode);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await reportIncident({
        executionId,
        automationId,
        automationTitle,
        stoppedNode,
        reportedBy: user?.nome || 'Operador Local',
        userRole: user?.role || 'operador',
        diagnosticExplanation: diagnostic,
        recommendedAction: action,
        operatorNote: operatorNote.trim() || undefined,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Falha ao reportar incidente.');
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    setIsSubmitted(true);
    setTimeout(() => {
      setIsSubmitted(false);
      onReported?.();
      onClose();
    }, 1400);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg space-y-5 text-card-foreground">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer"
        >
          <X size={18} />
        </button>

        {isSubmitted ? (
          <div className="py-8 text-center space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
              <CheckCircle2 size={26} />
            </div>
            <h3 className="text-base font-bold text-foreground">Incidente enviado ao administrador</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              A falha foi registrada na fila de pendências do painel administrativo com diagnóstico técnico completo para resolução.
            </p>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div className="flex items-center gap-2.5 text-rose-500">
              <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
                <ShieldAlert size={20} />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">Reportar Falha de Execução</h3>
                <p className="text-xs text-muted-foreground">
                  Encaminhe esta ocorrência para a fila de atividades pendentes do administrador.
                </p>
              </div>
            </div>

            {/* Metadados da Execução */}
            <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-muted/40 border border-border text-xs">
              <div>
                <span className="text-muted-foreground block text-[11px] font-medium">Execução:</span>
                <span className="font-mono font-semibold text-foreground">#{executionId}</span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[11px] font-medium">Automação:</span>
                <span className="font-medium text-foreground">{automationTitle}</span>
              </div>
              <div className="col-span-2 pt-1 border-t border-border/50">
                <span className="text-muted-foreground block text-[11px] font-medium">Nó de parada / Falha:</span>
                <span className="font-medium text-rose-400">{stoppedNode || 'Erro no processamento'}</span>
              </div>
            </div>

            {/* Diagnóstico Assertivo Pré-configurado */}
            <div className="rounded-lg p-3.5 bg-amber-500/10 border border-amber-500/25 space-y-2 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400 text-xs">
                <Info size={14} />
                <span>Diagnóstico Assertivo Identificado:</span>
              </div>
              <p className="text-foreground/90 leading-relaxed text-xs">
                {diagnostic}
              </p>
              <div className="pt-2 border-t border-amber-500/20 text-[11px] text-muted-foreground">
                <strong className="text-amber-700 dark:text-amber-400 block mb-0.5">Ação Recomendada para o Admin:</strong>
                {action}
              </div>
            </div>

            {/* Observação Adicional do Operador */}
            <div className="space-y-1.5">
              <label htmlFor="operator-note" className="block text-xs font-semibold text-foreground">
                Observação adicional do operador (opcional):
              </label>
              <textarea
                id="operator-note"
                rows={2}
                value={operatorNote}
                onChange={(e) => setOperatorNote(e.target.value)}
                placeholder="Ex: Tentei reprocessar o lote às 14h e continuou travando na mesma etapa..."
                className="w-full rounded-md border border-input bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary"
              />
            </div>

            {submitError && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {submitError}
              </p>
            )}

            {/* Botões de Ação */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={submitting}
                className="bg-rose-600 hover:bg-rose-500 text-white gap-1.5 text-xs font-semibold cursor-pointer shadow-xs"
              >
                <Send size={13} />
                Enviar Reporte ao Admin
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
