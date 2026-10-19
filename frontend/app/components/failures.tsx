import { AlertTriangle, ChevronDown, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TinyLogo, InterLogo } from "@/components/ui/brand-logos";
import type { Account } from "@/lib/contracts";
import { money } from "@/lib/formatters";
import { Empty, SourceError } from "./panel-state";

export default function Failures({
  accounts,
  loading,
  error,
}: {
  accounts: Account[] | null;
  loading: boolean;
  error?: string;
}) {
  return (
    <section className="panel failures-panel" aria-labelledby="failures-title">
      <div className="panel-header">
        <div className="section-title">
          <span className="section-icon red">
            <AlertTriangle size={18} />
          </span>
          <div>
            <h3 id="failures-title">
              Falhas e bloqueios{" "}
              <Badge className="count-badge red">{accounts?.length ?? "—"}</Badge>
            </h3>
            <p>Até 20 falhas de negócio mais recentes. Expanda para investigar.</p>
          </div>
        </div>
        <Badge variant="outline" className="source-label flex items-center gap-1.5 font-medium">
          <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
            <TinyLogo size={12} />
          </span>
          <span>Tiny ERP</span>
          <span className="text-muted-foreground">+</span>
          <span className="w-4 h-4 rounded-xs bg-white flex items-center justify-center p-0.5 shadow-2xs">
            <InterLogo size={12} />
          </span>
          <span>Banco Inter</span>
        </Badge>
      </div>
      {accounts === null ? (
        loading ? (
          <div className="table-loading">Carregando falhas…</div>
        ) : (
          <SourceError message={error} />
        )
      ) : accounts.length === 0 ? (
        <Empty>Nenhuma falha de negócio registrada.</Empty>
      ) : (
        <div className="failure-list">
          {accounts.map((account) => (
            <details key={account.id} className="failure-item">
              <summary>
                <span className="failure-dot">
                  <AlertTriangle size={15} />
                </span>
                <span className="failure-summary">
                  <strong>{account.beneficiary}</strong>
                  <span>
                    {account.errorLog?.split("\n")[0] || "O registro não contém detalhes do erro."}
                  </span>
                </span>
                <span className="failure-side">
                  <span>{money(account.amount)}</span>
                  <Badge className="status-badge red">Falha</Badge>
                </span>
                <ChevronDown className="details-chevron" size={16} />
              </summary>
              <div className="failure-detail">
                <div className="failure-node">
                  <Workflow size={14} />
                  <strong>Nó de parada:</strong>
                  <code>{account.stoppedNode ?? "Não informado pela origem"}</code>
                </div>
                <div className="failure-metadata">
                  <span>
                    Registro: <code>{account.id}</code>
                  </span>
                  <span>CNPJ: {account.cnpj}</span>
                  {account.transactionId && (
                    <span>
                      Transação Inter: <code>{account.transactionId}</code>
                    </span>
                  )}
                </div>
                <h4>Log de erro completo</h4>
                <pre>
                  {account.errorLog ?? "A origem não forneceu log_erro para este registro."}
                </pre>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
