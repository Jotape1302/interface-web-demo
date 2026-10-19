'use client';

import { useState } from 'react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AdminUserView } from '@/lib/admin-users-contracts';
import { ROLE_LABEL, ROLES, type Role, type TargetPolicy } from '@/lib/permissions';
import { ConfirmImpactDialog } from './confirm-impact-dialog';
import { RoleBadge } from './admin-user-badges';

/** Texto do dialog de troca de perfil (spec C.3.1). */
export function roleChangeCopy(
  target: Pick<AdminUserView, 'nome' | 'role' | 'username' | 'permissions_count' | 'permissoes'>,
  to: Role,
): { title: string; body: string; requireText?: string; confirmLabel: string } {
  const { nome, role: from, permissions_count: c } = target;
  if (to === 'admin') {
    return {
      title: `Tornar ${nome} Administrador(a)?`,
      body:
        'Administradores têm acesso total: todas as abas, todas as ações (inclusive forçar varredura SEFAZ e sincronização) e a gestão de qualquer usuário, exceto o ROOT. As permissões individuais deixam de ser usadas.',
      requireText: `@${target.username}`,
      confirmLabel: 'Tornar Administrador(a)',
    };
  }
  if (from === 'admin') {
    return {
      title: `Remover o perfil Admin de ${nome}?`,
      body: `Passa a ser ${ROLE_LABEL[to]} sem nenhuma permissão: até você marcar no editor, só verá Início e Chat. A sessão atual é atualizada no próximo acesso.`,
      confirmLabel: 'Remover Admin',
    };
  }
  if (to === 'gestor') {
    return {
      title: `Tornar ${nome} Gestor(a)?`,
      body: `Mantém as ${c.tabs} abas e ${c.actions} ações atuais. Como Gestor(a), poderá receber ações de Gestão de Usuários, sempre sobre usuários do perfil User. Nada novo é liberado até você marcar no editor.`,
      confirmLabel: 'Tornar Gestor(a)',
    };
  }
  const k = target.permissoes.filter((p) => p.startsWith('usuarios:') && !p.endsWith(':ver')).length;
  return {
    title: `Tornar ${nome} User?`,
    body: `Perde todas as ações de Gestão de Usuários (${k} marcada${k === 1 ? '' : 's'} hoje) e a aba Gestão de Usuários. As demais abas e ações continuam.`,
    confirmLabel: 'Tornar User',
  };
}

/** Perfil na tabela: select para o Admin (com confirmação) ou selo somente leitura. */
export function RoleSelect({
  target,
  policy,
  onConfirm,
}: {
  target: AdminUserView;
  policy: TargetPolicy;
  /** Aplica a troca; devolve true se deu certo. */
  onConfirm: (role: Role) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<Role | null>(null);
  const [saving, setSaving] = useState(false);

  if (!policy.canChangeRole) {
    if (!policy.roleReason || policy.roleReason === 'Só o administrador altera perfis.') return <RoleBadge role={target.role} />;
    return (
      <Tooltip>
        <TooltipTrigger render={<button type="button" className="inline-flex cursor-help" aria-label={policy.roleReason} />}>
          <RoleBadge role={target.role} />
        </TooltipTrigger>
        <TooltipContent>{policy.roleReason}</TooltipContent>
      </Tooltip>
    );
  }

  const copy = pending ? roleChangeCopy(target, pending) : null;

  return (
    <div className="flex items-center gap-1.5">
      <NativeSelect
        size="sm"
        value={target.role}
        disabled={saving}
        aria-label={`Perfil de ${target.nome}`}
        onChange={(e) => {
          const next = e.target.value as Role;
          if (next !== target.role) setPending(next);
        }}
        className="[&_select]:rounded-[4px] [&_select]:text-xs"
      >
        {ROLES.map((r) => (
          <NativeSelectOption key={r} value={r}>
            {ROLE_LABEL[r]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {saving && <Spinner aria-hidden="true" className="size-3.5" />}
      {copy && pending && (
        <ConfirmImpactDialog
          open
          title={copy.title}
          confirmLabel={copy.confirmLabel}
          requireText={copy.requireText}
          busy={saving}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setSaving(true);
            void onConfirm(pending).finally(() => {
              setSaving(false);
              setPending(null);
            });
          }}
        >
          <p>{copy.body}</p>
        </ConfirmImpactDialog>
      )}
    </div>
  );
}
