import { CheckCheck, CircleDollarSign, Clock3, Workflow } from "lucide-react";
import type { Metrics } from "@/lib/contracts";
import { count, formatTimeSaved, money, percentage } from "@/lib/formatters";
import { SourceError } from "./panel-state";

export default function MetricCards({
  metrics,
  error,
  loading,
}: {
  metrics: Metrics | null;
  error?: string;
  loading: boolean;
}) {
  if (!metrics)
    return loading ? (
      <div className="metric-grid" aria-label="Carregando indicadores">
        {[1, 2, 3, 4].map((i) => (
          <div className="metric-card skeleton" key={i} />
        ))}
      </div>
    ) : (
      <SourceError message={error} reportar={{ automationId: "accounts-payable", executionId: "painel" }} />
    );
  // Horas e R$ só chegam para quem tem `roi:ver` (o gateway corta as duas chaves).
  const roiCards =
    metrics.hoursSaved === undefined || metrics.estimatedSavings === undefined
      ? []
      : [
          {
            label: "Horas economizadas",
            value: formatTimeSaved(metrics.hoursSaved),
            detail: `${count(metrics.paidCount)} contas pagas · 4,5 min poupados por conta`,
            icon: Clock3,
            tone: "teal",
          },
          {
            label: "Economia financeira",
            value: money(metrics.estimatedSavings),
            detail: "Capacidade estimada a R$ 11,00/h",
            icon: CircleDollarSign,
            tone: "blue",
          },
        ];
  const cards = [
    ...roiCards,
    {
      label: "Boletos conciliados",
      value: count(metrics.reconciledCount),
      detail: "Registros enriquecidos ou pagos",
      icon: CheckCheck,
      tone: "purple",
    },
    {
      label: "Taxa de automação",
      value: percentage(metrics.automationRate),
      detail: `Sobre ${count(metrics.totalQueue)} registros da fila`,
      icon: Workflow,
      tone: "teal",
    },
  ];
  return (
    <div className="metric-grid">
      {cards.map(({ label, value, detail, icon: Icon, tone }) => (
        <article className="metric-card" key={label}>
          <div className="metric-top">
            <span>{label}</span>
            <span className={`metric-icon ${tone}`}>
              <Icon size={19} />
            </span>
          </div>
          <div className="metric-value">{value}</div>
          <div className="metric-detail">{detail}</div>
          {label === "Taxa de automação" && (
            <div className="rate-track" aria-hidden="true">
              <span style={{ width: `${metrics.automationRate ?? 0}%` }} />
            </div>
          )}
          {roiCards.length > 0 && label !== "Boletos conciliados" && label !== "Taxa de automação" && <span className="estimate-label">Ganho estimado</span>}
        </article>
      ))}
    </div>
  );
}
