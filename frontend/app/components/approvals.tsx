"use client";
import { useState } from "react";
import { Building2, CalendarDays, Clock3, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InterLogo } from "@/components/ui/brand-logos";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Account } from "@/lib/contracts";
import { dateOnly, money } from "@/lib/formatters";
import { Empty, SourceError } from "./panel-state";

export default function Approvals({
  accounts,
  loading,
  error,
}: {
  accounts: Account[] | null;
  loading: boolean;
  error?: string;
}) {
  const [page, setPage] = useState(0);
  const size = 5;
  const pages = Math.max(1, Math.ceil((accounts?.length ?? 0) / size));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="panel approvals">
      <div className="panel-header">
        <div className="section-title">
          <span className="section-icon amber">
            <Clock3 size={19} />
          </span>
          <div>
            <h3>
              Aguardando aprovação do gestor{" "}
              <Badge className="count-badge amber">{accounts?.length ?? "—"}</Badge>
            </h3>
            <p>Contas aguardando liberação no Banco Inter.</p>
          </div>
        </div>
        <Badge variant="outline" className="source-label flex items-center gap-1.5 font-medium">
          <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
            <InterLogo size={12} />
          </span>
          <span>Banco Inter</span>
        </Badge>
      </div>
      {accounts === null ? (
        loading ? (
          <div className="table-loading">Carregando contas…</div>
        ) : (
          <SourceError message={error} />
        )
      ) : accounts.length === 0 ? (
        <Empty>Nenhuma conta aguardando aprovação.</Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Favorecido / CNPJ</TableHead>
                <TableHead className="text-right">Valor nominal</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>ID da transação Inter</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.slice(currentPage * size, (currentPage + 1) * size).map((account) => (
                <TableRow key={account.id}>
                  <TableCell>
                    <div className="beneficiary">
                      <span className="company-avatar">
                        <Building2 size={16} />
                      </span>
                      <div>
                        <strong>{account.beneficiary}</strong>
                        <span>{account.cnpj}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {money(account.amount)}
                  </TableCell>
                  <TableCell>
                    <span className="date-cell">
                      <CalendarDays size={14} />
                      {dateOnly(account.dueDate)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code>{account.transactionId ?? "Não informado"}</code>
                  </TableCell>
                  <TableCell>
                    <Badge className="status-badge amber">
                      <span className="status-dot" />
                      Aguardando aprovação
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="table-footer">
            <span>
              {currentPage * size + 1}–{Math.min((currentPage + 1) * size, accounts.length)} de{" "}
              {accounts.length} pendências
            </span>
            <div className="pagination">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                aria-label="Página anterior de aprovações"
              >
                <ChevronLeft />
              </Button>
              <span>
                Página {currentPage + 1} de {pages}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={currentPage + 1 >= pages}
                onClick={() => setPage(currentPage + 1)}
                aria-label="Próxima página de aprovações"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
