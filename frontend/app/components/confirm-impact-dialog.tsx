'use client';

import { useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/**
 * Confirmação de impacto (substitui todo `confirm()` da Gestão de Usuários — spec C.3.6).
 * `requireCheck`: checkbox obrigatório (ex.: "Entendo o risco"); `requireText`: texto a digitar
 * (ex.: @username para tornar Admin).
 */
export function ConfirmImpactDialog({
  open,
  onCancel,
  busy = false,
  ...props
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  tone?: 'cta' | 'destructive';
  requireCheck?: string;
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <AlertDialogContent className="rounded-[4px] data-[size=default]:sm:max-w-md">
        {/* O corpo só monta com o dialog aberto: checkbox e texto digitado recomeçam a cada abertura. */}
        <ConfirmBody busy={busy} {...props} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConfirmBody({
  title,
  children,
  confirmLabel,
  tone = 'cta',
  requireCheck,
  requireText,
  busy,
  onConfirm,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  tone?: 'cta' | 'destructive';
  requireCheck?: string;
  requireText?: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const ready = (!requireCheck || checked) && (!requireText || typed.trim() === requireText);

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="font-semibold">{title}</AlertDialogTitle>
        <AlertDialogDescription render={<div />} className="space-y-2 text-left">
          {children}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {requireCheck && (
        <label className="flex min-h-11 items-center gap-2 text-sm text-foreground sm:min-h-0">
          <Checkbox checked={checked} onCheckedChange={(v) => setChecked(Boolean(v))} disabled={busy} />
          {requireCheck}
        </label>
      )}
      {requireText && (
        <div className="space-y-1">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            Para confirmar, digite <strong className="font-mono text-foreground">{requireText}</strong>
          </label>
          <Input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="rounded-[4px] font-mono"
            disabled={busy}
          />
        </div>
      )}
      <AlertDialogFooter className="rounded-b-[4px]">
        <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
        <Button variant={tone} onClick={onConfirm} disabled={!ready || busy} aria-busy={busy}>
          {busy && <Spinner aria-hidden="true" />}
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
