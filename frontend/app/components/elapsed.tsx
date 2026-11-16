"use client";

import { useEffect, useState } from "react";
import { formatElapsed } from "@/lib/reconciliation-helpers";

/**
 * Cronômetro de tarefa em andamento. O relógio de 1 s vive aqui dentro para que só este nó
 * re-renderize a cada segundo (e não a tela inteira da conciliação).
 */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return <span className={className}>{formatElapsed(Math.max(0, now - since))}</span>;
}
