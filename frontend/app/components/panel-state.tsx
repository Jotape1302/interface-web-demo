import { Activity, CheckCheck } from "lucide-react";
import { ReportarErro } from "@/components/reportar-erro";
import type { ReportAutomationId } from "@/lib/incidents-store";

/**
 * Fonte que não respondeu. Com `reportar`, mostra o "Reportar erro" da automação (a referência
 * identifica a fonte, ex.: "status"; o mesmo erro de novo cai no mesmo reporte).
 */
export function SourceError({
  message,
  reportar,
}: {
  message?: string;
  reportar?: { automationId: ReportAutomationId; executionId: string };
}) {
  const texto = message || "Não foi possível obter os dados. Use Atualizar para tentar novamente.";
  return (
    <div role="alert" className="source-error">
      <Activity size={18} />
      <div>
        <strong>Fonte indisponível</strong>
        <p>{texto}</p>
        {reportar && <ReportarErro className="mt-2" automationId={reportar.automationId} executionId={reportar.executionId} errorMessage={texto} />}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <CheckCheck size={22} />
      <p>{children}</p>
    </div>
  );
}
