"use client";

import { Clock, Globe, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTimeBR } from "@/lib/formatters";
import type { AdminSession } from "@/lib/admin-users-contracts";
import type { Role, TargetPolicy } from "@/lib/permissions";
import { TD, TH } from "./styles";

interface Props {
  policyFor: (target: { id: number; role: Role; is_root: boolean }) => TargetPolicy | null;
  onForceLogout: (session: AdminSession) => void;
}

function SessionAction({ s, policyFor, onForceLogout }: { s: AdminSession } & Props) {
  if (s.current) return <span className="text-xs text-muted-foreground">Sua sessão</span>;
  const policy = policyFor({ id: s.usuario_id, role: s.role, is_root: s.is_root });
  if (policy?.canForceLogout) {
    return (
      <Button size="sm" variant="destructive" onClick={() => onForceLogout(s)}>
        <LogOut aria-hidden="true" />
        Encerrar sessão
      </Button>
    );
  }
  const reason = s.is_root
    ? "O usuário ROOT não pode ter a sessão encerrada por outra pessoa."
    : "Só o administrador encerra sessões de Gestores e Administradores";
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" className="cursor-help text-xs text-muted-foreground" aria-label={reason} />}>
        —
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** Sessões ativas: tabela em telas largas e cartões abaixo de 768px. */
export function SessionsTable({ sessions, policyFor, onForceLogout }: { sessions: AdminSession[] } & Props) {
  return (
    <>
            <div className="hidden overflow-hidden rounded-[4px] border border-border bg-card md:block">
              <table className="w-full text-xs text-foreground">
                <thead className="border-b border-border bg-muted/60">
                  <tr>
                    <th scope="col" className={TH}>Colaborador</th>
                    <th scope="col" className={TH}>Setor</th>
                    <th scope="col" className={TH}>Endereço IP</th>
                    <th scope="col" className={TH}>Navegador</th>
                    <th scope="col" className={TH}>Última atividade</th>
                    <th scope="col" className={`${TH} text-right`}>Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {sessions.map((s) => (
                    <tr key={s.id} className="hover:bg-muted/40">
                      <td className={TD}>
                        <div className="flex items-center gap-2 font-semibold">
                          {s.nome}
                          {s.current && (
                            <Badge variant="outline" className="text-[9px] font-bold">
                              VOCÊ
                            </Badge>
                          )}
                        </div>
                        <span className="font-mono text-[11px] text-muted-foreground">{s.email}</span>
                      </td>
                      <td className={`${TD} text-muted-foreground`}>{s.setor}</td>
                      <td className={`${TD} font-mono`}>
                        <span className="flex items-center gap-1.5">
                          <Globe size={13} className="text-muted-foreground" aria-hidden="true" />
                          {s.ip_address}
                        </span>
                      </td>
                      <td className={`${TD} max-w-xs truncate text-muted-foreground`} title={s.user_agent}>
                        {s.user_agent}
                      </td>
                      <td className={`${TD} text-muted-foreground`}>
                        <span className="flex items-center gap-1">
                          <Clock size={12} aria-hidden="true" />
                          {formatTimeBR(s.ultimo_acesso)}
                        </span>
                      </td>
                      <td className={`${TD} text-right`}><SessionAction s={s} policyFor={policyFor} onForceLogout={onForceLogout} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 md:hidden">
              {sessions.map((s) => (
                <li key={s.id} className="space-y-1.5 rounded-[4px] border border-border bg-card p-3 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-foreground">
                    {s.nome}
                    {s.current && (
                      <Badge variant="outline" className="text-[9px] font-bold">
                        VOCÊ
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    {s.setor} · <span className="font-mono">{s.ip_address}</span> · {formatTimeBR(s.ultimo_acesso)}
                  </div>
                  <div className="truncate text-muted-foreground">{s.user_agent}</div>
                  <div className="flex justify-end"><SessionAction s={s} policyFor={policyFor} onForceLogout={onForceLogout} /></div>
                </li>
              ))}
            </ul>
    </>
  );
}
