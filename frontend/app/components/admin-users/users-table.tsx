"use client";

import { memo } from "react";
import { SlidersHorizontal, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { SETORES } from "@/lib/contracts";
import type { AdminUserView } from "@/lib/admin-users-contracts";
import type { Role, TargetPolicy } from "@/lib/permissions";
import { AccessBadge, RootBadge } from "@/app/components/admin-user-badges";
import { RoleSelect } from "@/app/components/role-select";
import { TD, TH } from "./styles";

const STATUS_LABEL: Record<AdminUserView["status"], string> = {
  pending: "Pendente",
  approved: "Ativo",
  rejected: "Recusado",
  blocked: "Bloqueado",
};

export interface UsersTableHandlers {
  policyFor: (target: { id: number; role: Role; is_root: boolean }) => TargetPolicy | null;
  setorBusy: number | null;
  onSetor: (user: AdminUserView, setor: string) => void;
  onRole: (user: AdminUserView, role: Role) => Promise<boolean>;
  onEditPermissions: (user: AdminUserView) => void;
  onDelete: (user: AdminUserView) => void;
}

function NameCell({ u }: { u: AdminUserView }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5 font-semibold text-foreground">
        <span className="truncate">{u.nome}</span>
        {u.is_root && <RootBadge />}
        {u.status !== "approved" && (
          <Badge variant="warning" className="text-[10px]">
            {STATUS_LABEL[u.status]}
          </Badge>
        )}
      </div>
      <div className="truncate font-mono text-[11px] font-normal text-muted-foreground">@{u.username}</div>
    </div>
  );
}

function SetorControl({ u, policy, busy, onSetor }: { u: AdminUserView; policy: TargetPolicy | null; busy: boolean; onSetor: UsersTableHandlers["onSetor"] }) {
  return policy?.canChangeSetor ? (
    <NativeSelect
      size="sm"
      value={u.setor}
      disabled={busy}
      onChange={(e) => onSetor(u, e.target.value)}
      aria-label={`Setor de ${u.nome}`}
      className="[&_select]:rounded-[4px] [&_select]:text-xs"
    >
      {(SETORES as readonly string[]).includes(u.setor) ? null : <NativeSelectOption value={u.setor}>{u.setor}</NativeSelectOption>}
      {SETORES.map((s) => (
        <NativeSelectOption key={s} value={s}>
          {s}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  ) : (
    <span className="text-xs text-muted-foreground">{u.setor || "—"}</span>
  );
}

function UserActions({ u, policy, onEditPermissions, onDelete }: { u: AdminUserView; policy: TargetPolicy | null } & Pick<UsersTableHandlers, "onEditPermissions" | "onDelete">) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button size="sm" variant="outline" onClick={() => onEditPermissions(u)} aria-label={`Permissões de ${u.nome}`}>
        <SlidersHorizontal aria-hidden="true" />
        Permissões
      </Button>
      {policy?.canDelete && (
        <Button size="icon-sm" variant="destructive" onClick={() => onDelete(u)} aria-label={`Excluir ${u.nome}`} title="Excluir usuário">
          <Trash2 aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

interface RowProps extends UsersTableHandlers {
  u: AdminUserView;
}

const UserRow = memo(function UserRow({ u, policyFor, setorBusy, onSetor, onRole, onEditPermissions, onDelete }: RowProps) {
  const policy = policyFor(u);
  return (
    <tr className="hover:bg-muted/40">
      <td className={`${TD} max-w-64`}>
        <NameCell u={u} />
      </td>
      <td className={TD}>
        <SetorControl u={u} policy={policy} busy={setorBusy === u.id} onSetor={onSetor} />
      </td>
      <td className={TD}>{policy && <RoleSelect target={u} policy={policy} onConfirm={(r) => onRole(u, r)} />}</td>
      <td className={TD}>
        <AccessBadge role={u.role} count={u.permissions_count} />
      </td>
      <td className={TD}>
        <UserActions u={u} policy={policy} onEditPermissions={onEditPermissions} onDelete={onDelete} />
      </td>
    </tr>
  );
});

const UserCard = memo(function UserCard({ u, policyFor, setorBusy, onSetor, onRole, onEditPermissions, onDelete }: RowProps) {
  const policy = policyFor(u);
  return (
    <li className="space-y-2.5 rounded-[4px] border border-border bg-card p-3 text-xs">
      <NameCell u={u} />
      <div className="flex flex-wrap items-center gap-2">
        {policy && <RoleSelect target={u} policy={policy} onConfirm={(r) => onRole(u, r)} />}
        <AccessBadge role={u.role} count={u.permissions_count} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Setor:</span>
        <SetorControl u={u} policy={policy} busy={setorBusy === u.id} onSetor={onSetor} />
      </div>
      <UserActions u={u} policy={policy} onEditPermissions={onEditPermissions} onDelete={onDelete} />
    </li>
  );
});

/** Usuários ativos: tabela em telas largas e cartões abaixo de 768px. */
export function UsersTable({ users, ...handlers }: { users: AdminUserView[] } & UsersTableHandlers) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
        <table className="w-full text-xs text-foreground">
          <thead className="border-b border-border bg-muted/60">
            <tr>
              <th scope="col" className={TH}>Usuário</th>
              <th scope="col" className={TH}>Setor</th>
              <th scope="col" className={TH}>Perfil</th>
              <th scope="col" className={TH}>Acesso</th>
              <th scope="col" className={`${TH} text-right`}>Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {users.map((u) => (
              <UserRow key={u.id} u={u} {...handlers} />
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {users.map((u) => (
          <UserCard key={u.id} u={u} {...handlers} />
        ))}
      </ul>
    </>
  );
}
