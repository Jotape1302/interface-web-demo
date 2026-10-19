'use client';

import { Lock, ShieldCheck, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ROLE_LABEL, formatAccessCount, hasNoAccess, type Role } from '@/lib/permissions';
import { cn } from '@/lib/utils';

// Selos da Gestão de Usuários (spec C.2): perfil, ROOT e acesso. Só tokens de globals.css.

const ROLE_CLASS: Record<Role, string> = {
  admin: 'border-[var(--badge-purple-fg)]/25 bg-[var(--badge-purple-bg)] text-[var(--badge-purple-fg)]',
  gestor: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info-fg)]',
  user: 'border-border bg-muted text-muted-foreground',
};

export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-bold uppercase', ROLE_CLASS[role], className)}>
      {ROLE_LABEL[role]}
    </Badge>
  );
}

export function RootBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-bold', className)}>
      <Lock aria-hidden="true" />
      ROOT
    </Badge>
  );
}

/** "4 abas · 6 ações", "Acesso total" (Admin) ou o selo "Sem acesso". */
export function AccessBadge({ role, count }: { role: Role; count: { tabs: number; actions: number } }) {
  if (role === 'admin') {
    return (
      <Badge variant="info" className="text-[11px]">
        <ShieldCheck aria-hidden="true" />
        Acesso total
      </Badge>
    );
  }
  if (hasNoAccess(role, count)) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge variant="warning" className="cursor-help text-[11px]" tabIndex={0}>
              <ShieldOff aria-hidden="true" />
              Sem acesso
            </Badge>
          }
        />
        <TooltipContent className="max-w-60">
          Entra no painel, mas só vê Início e Chat. Clique em Permissões para liberar abas.
        </TooltipContent>
      </Tooltip>
    );
  }
  return <span className="font-mono text-[11px] text-foreground">{formatAccessCount(count)}</span>;
}
