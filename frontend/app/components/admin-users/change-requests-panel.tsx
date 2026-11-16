"use client";

import { memo } from "react";
import { CheckCircle, UserCog, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTimeBR } from "@/lib/formatters";
import type { AdminChangeRequest, AdminUserView } from "@/lib/admin-users-contracts";
import type { Role, TargetPolicy } from "@/lib/permissions";
import { TD, TH } from "./styles";

interface Handlers {
  policyFor: (target: { id: number; role: Role; is_root: boolean }) => TargetPolicy | null;
  onApprove: (req: AdminChangeRequest) => void;
  onReject: (req: AdminChangeRequest) => void;
}

function ChangeActions({ req, policyFor, onApprove, onReject }: { req: AdminChangeRequest } & Handlers) {
  const policy = req.usuario_role ? policyFor({ id: req.usuario_id, role: req.usuario_role, is_root: req.usuario_is_root }) : null;
  if (!policy?.canReviewChange) {
    return <span className="text-xs text-muted-foreground">Só o administrador decide</span>;
  }
  return (
    <div className="flex justify-end gap-1.5">
      <Button size="sm" variant="outline" onClick={() => onApprove(req)}>
        <CheckCircle aria-hidden="true" />
        Aprovar
      </Button>
      <Button size="sm" variant="destructive" onClick={() => onReject(req)}>
        <XCircle aria-hidden="true" />
        Recusar
      </Button>
    </div>
  );
}

const ChangeRow = memo(function ChangeRow({ req, nome, ...handlers }: { req: AdminChangeRequest; nome: string } & Handlers) {
  return (
    <tr className="hover:bg-muted/40">
      <td className={`${TD} font-semibold`}>{nome}</td>
      <td className={TD}>
        <Badge variant="outline" className="text-[11px]">
          {req.tipo === "username" ? "Login" : "E-mail"}
        </Badge>
      </td>
      <td className={`${TD} font-mono text-muted-foreground`}>{req.valor_atual}</td>
      <td className={`${TD} font-mono font-semibold`}>{req.valor_novo}</td>
      <td className={`${TD} text-muted-foreground`}>{formatDateTimeBR(req.solicitado_em)}</td>
      <td className={`${TD} text-right`}>
        <ChangeActions req={req} {...handlers} />
      </td>
    </tr>
  );
});

const ChangeCard = memo(function ChangeCard({ req, ...handlers }: { req: AdminChangeRequest } & Handlers) {
  return (
    <li className="space-y-1.5 rounded-[4px] border border-border bg-card p-3 text-xs">
      <div className="font-semibold text-foreground">
        {req.usuario_nome || `Usuário #${req.usuario_id}`} ·{" "}
        <span className="font-normal text-muted-foreground">{req.tipo === "username" ? "Login" : "E-mail"}</span>
      </div>
      <div className="break-all font-mono text-muted-foreground">
        {req.valor_atual} → <strong className="text-foreground">{req.valor_novo}</strong>
      </div>
      <ChangeActions req={req} {...handlers} />
    </li>
  );
});

/** Pedidos de troca de login/e-mail aguardando decisão. */
export function ChangeRequestsPanel({ requests, users, ...handlers }: { requests: AdminChangeRequest[]; users: AdminUserView[] } & Handlers) {
  if (requests.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground">
        <UserCog size={14} aria-hidden="true" />
        Alterações de cadastro
      </h2>
      <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
        <table className="w-full text-xs text-foreground">
          <thead className="border-b border-border bg-muted/60">
            <tr>
              <th scope="col" className={TH}>Colaborador</th>
              <th scope="col" className={TH}>Tipo</th>
              <th scope="col" className={TH}>Valor atual</th>
              <th scope="col" className={TH}>Novo valor</th>
              <th scope="col" className={TH}>Solicitado em</th>
              <th scope="col" className={`${TH} text-right`}>Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {requests.map((req) => (
              <ChangeRow
                key={req.id}
                req={req}
                nome={req.usuario_nome || users.find((u) => u.id === req.usuario_id)?.nome || `Usuário #${req.usuario_id}`}
                {...handlers}
              />
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {requests.map((req) => (
          <ChangeCard key={req.id} req={req} {...handlers} />
        ))}
      </ul>
    </section>
  );
}
