"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";

const FOCUSAVEIS =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Casca acessível para modais próprios: role="dialog", aria-modal, aria-labelledby, Escape fecha,
 * foco inicial dentro do diálogo, Tab/Shift+Tab presos nele e devolução do foco ao gatilho ao fechar.
 * Monte-o só enquanto o modal estiver aberto.
 */
export function ModalShell({
  onClose,
  labelledBy,
  className,
  initialFocusRef,
  children,
}: {
  onClose: () => void;
  /** id do título (h2) do diálogo. */
  labelledBy: string;
  /** Classes do painel do diálogo. */
  className?: string;
  /** Elemento que recebe o foco ao abrir (padrão: primeiro campo focável, ou o próprio diálogo). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const alvo =
      initialFocusRef?.current ??
      dialog.querySelector<HTMLElement>("input:not([disabled]):not([type='hidden']),textarea:not([disabled]),select:not([disabled])") ??
      dialog;
    alvo.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const itens = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSAVEIS)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (itens.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const primeiro = itens[0];
      const ultimo = itens[itens.length - 1];
      const ativo = document.activeElement;
      if (e.shiftKey && (ativo === primeiro || ativo === dialog || !dialog.contains(ativo))) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (ativo === ultimo || !dialog.contains(ativo))) {
        e.preventDefault();
        primeiro.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (anterior?.isConnected) anterior.focus();
    };
  }, [initialFocusRef]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-150">
      <div
        ref={dialogRef}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role explícito é intencional neste componente (a tag semântica alteraria estilo/comportamento do primitivo)
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn("outline-none", className)}
      >
        {children}
      </div>
    </div>
  );
}
