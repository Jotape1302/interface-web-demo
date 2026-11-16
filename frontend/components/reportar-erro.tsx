'use client';

import { useEffect, useId, useState } from 'react';
import { Bot, CheckCircle2, Send, ShieldAlert } from 'lucide-react';
import { ModalShell } from '@/app/components/modal-shell';
import { useAuth } from '@/lib/auth-context';
import {
  REPORT_AUTOMATIONS,
  findPendingReport,
  reportIncident,
  reportStatusLabel,
  subscribeToIncidents,
  type ReportAutomationId,
} from '@/lib/incidents-store';

/**
 * Botão "Reportar erro" das abas com automação: manda o erro que a tela mostra aos agentes Qwen
 * (gateway → repasse do coletor → PC). Reportado, o botão vira o andamento do caso nos agentes.
 * O PC junta reportes do mesmo erro (e o log que o coletor já mandou) num incidente só.
 */
export function ReportarErro({
  automationId,
  executionId,
  errorMessage,
  stoppedNode,
  className,
}: {
  automationId: ReportAutomationId;
  /** O que falhou: execução, SKU, chave da NF-e, empresa... (um reporte aberto por referência). */
  executionId: string;
  /** Mensagem de erro que a tela mostra. */
  errorMessage: string;
  stoppedNode?: string;
  className?: string;
}) {
  const { user } = useAuth();
  const [, setVersao] = useState(0);
  const [aberto, setAberto] = useState(false);
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const tituloId = useId();
  const notaId = useId();

  useEffect(() => subscribeToIncidents(() => setVersao((v) => v + 1)), []);

  const reporte = findPendingReport(automationId, executionId);
  if (reporte && !aberto) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground ${className ?? ''}`}
        title={`Reportado por ${reporte.reportedBy}`}
      >
        <Bot size={13} className="shrink-0" />
        {reportStatusLabel(reporte)}
      </span>
    );
  }

  const fechar = () => {
    setAberto(false);
    setEnviado(false);
    setErro(null);
    setNota('');
  };

  const enviar = async () => {
    setEnviando(true);
    setErro(null);
    try {
      await reportIncident(
        { automationId, executionId, errorMessage, stoppedNode, operatorNote: nota.trim() || undefined },
        user?.nome,
      );
      setEnviado(true);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao reportar o erro.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-none border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-muted ${className ?? ''}`}
      >
        <ShieldAlert size={13} className="shrink-0" />
        Reportar erro
      </button>
      {aberto && (
        <ModalShell
          onClose={fechar}
          labelledBy={tituloId}
          className="relative w-full max-w-lg rounded-none border border-border bg-card p-6 text-card-foreground shadow-lg space-y-4"
        >
          {enviado ? (
            <div className="space-y-3 py-6 text-center">
              <CheckCircle2 size={28} className="mx-auto text-emerald-600 dark:text-emerald-400" />
              <h2 id={tituloId} className="text-base font-bold text-foreground">
                Erro enviado aos agentes Qwen
              </h2>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                Eles analisam e propõem a correção; o andamento aparece no lugar do botão. Se o mesmo erro já tinha sido reportado
                ou apareceu no log, entra no mesmo caso.
              </p>
              <button
                type="button"
                onClick={fechar}
                className="cursor-pointer rounded-none border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
              >
                Fechar
              </button>
            </div>
          ) : (
            <>
              <div>
                <h2 id={tituloId} className="text-base font-bold text-foreground">
                  Reportar erro
                </h2>
                <p className="text-xs text-muted-foreground">Vai para os agentes Qwen, que diagnosticam e propõem a correção ao TI.</p>
              </div>
              <dl className="grid grid-cols-2 gap-2 border border-border bg-muted/40 p-3 text-xs">
                <div>
                  <dt className="text-[11px] text-muted-foreground">Automação</dt>
                  <dd className="font-medium text-foreground">{REPORT_AUTOMATIONS[automationId]}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">Referência</dt>
                  <dd className="break-all font-mono font-medium text-foreground">{executionId}</dd>
                </div>
                {stoppedNode && (
                  <div className="col-span-2">
                    <dt className="text-[11px] text-muted-foreground">Etapa</dt>
                    <dd className="font-medium text-foreground">{stoppedNode}</dd>
                  </div>
                )}
                <div className="col-span-2 border-t border-border/50 pt-1">
                  <dt className="text-[11px] text-muted-foreground">Erro na tela</dt>
                  <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-rose-700 dark:text-rose-400">{errorMessage}</dd>
                </div>
              </dl>
              <div className="space-y-1.5">
                <label htmlFor={notaId} className="block text-xs font-semibold text-foreground">
                  O que aconteceu? (opcional)
                </label>
                <textarea
                  id={notaId}
                  rows={3}
                  maxLength={2000}
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  placeholder="Ex.: tentei de novo às 14h e parou na mesma etapa"
                  className="w-full rounded-none border border-input bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary"
                />
              </div>
              {erro && (
                <p role="alert" className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {erro}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={fechar}
                  className="cursor-pointer rounded-none border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={enviando}
                  onClick={() => void enviar()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-none bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
                >
                  <Send size={13} />
                  {enviando ? 'Enviando…' : 'Enviar aos agentes'}
                </button>
              </div>
            </>
          )}
        </ModalShell>
      )}
    </>
  );
}
