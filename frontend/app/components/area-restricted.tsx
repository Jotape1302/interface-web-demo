'use client';

import { Lock } from 'lucide-react';
import { PAGE_TAB_LABEL, type PageId } from '@/lib/areas';

// Mostrado no lugar da página quando a sessão não tem o "ver" da aba (RBAC por usuário).
export default function AreaRestricted({ page }: { page: PageId }) {
  const aba = PAGE_TAB_LABEL[page] ?? 'esta aba';

  return (
    <section role="alert" className="mx-auto max-w-xl py-16 text-center">
      <Lock size={28} className="mx-auto mb-3 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-bold text-foreground">Você não tem acesso a esta aba</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Peça ao administrador para liberar <strong className="text-foreground">{aba}</strong> em Gestão de Usuários.
      </p>
    </section>
  );
}
