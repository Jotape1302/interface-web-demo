'use client';

import { AlertTriangle, CheckCircle, Info, Lock, OctagonX } from 'lucide-react';
import { cn } from '@/lib/utils';

export type NoticeTone = 'info' | 'pending' | 'error' | 'success' | 'muted';

const TONE_CLASS: Record<NoticeTone, string> = {
  info: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info-fg)]',
  pending: 'border-[var(--status-pending-border)] bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]',
  error: 'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error-fg)]',
  success: 'border-[var(--status-success-border)] bg-[var(--status-success-bg)] text-[var(--status-success-fg)]',
  muted: 'border-border bg-muted/60 text-muted-foreground',
};

const TONE_ICON: Record<NoticeTone, React.ReactNode> = {
  info: <Info size={14} aria-hidden="true" />,
  pending: <AlertTriangle size={14} aria-hidden="true" />,
  error: <OctagonX size={14} aria-hidden="true" />,
  success: <CheckCircle size={14} aria-hidden="true" />,
  muted: <Lock size={14} aria-hidden="true" />,
};

/** Bloco de aviso com os tokens de status de globals.css (sem cores cruas). */
export function Notice({
  tone,
  icon,
  children,
  action,
  className,
  role,
  live = false,
}: {
  tone: NoticeTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  role?: 'alert';
  /** Anuncia mudanças de texto (aria-live="polite"). */
  live?: boolean;
}) {
  return (
    <div
      role={role}
      aria-live={live ? 'polite' : undefined}
      className={cn('flex items-start gap-2 rounded-[4px] border p-3 text-xs leading-relaxed', TONE_CLASS[tone], className)}
    >
      <span className="mt-0.5 shrink-0">{icon ?? TONE_ICON[tone]}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
