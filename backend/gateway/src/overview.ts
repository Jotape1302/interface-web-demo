import type { Dashboard, HistoryAdapter, HistoryWindow, OverviewResponse } from "./contracts.js";
export interface AutomationProvider {
  id: string;
  title: string;
  href: string;
  dashboard: { read(): Promise<Dashboard> };
  history: HistoryAdapter;
}
export function historyWindow(now: Date = new Date()): HistoryWindow {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // São Paulo has observed UTC-03 without daylight saving since 2019.
  const from = new Date(`${day}T00:00:00-03:00`);
  from.setUTCDate(from.getUTCDate() - 13);
  return { days: 14, from: from.toISOString(), to: now.toISOString() };
}
export interface ServiceHealthResult {
  connected: boolean;
  message: string;
}

export interface ServiceHealthCheckers {
  checkTiny?: () => Promise<ServiceHealthResult> | ServiceHealthResult;
  checkInter?: () => Promise<ServiceHealthResult> | ServiceHealthResult;
}

export function createOverviewService(
  mode: Dashboard["mode"],
  providers: AutomationProvider[],
  clock = () => new Date(),
  healthCheckers?: ServiceHealthCheckers,
) {
  if (new Set(providers.map((p) => p.id)).size !== providers.length)
    throw new Error("Identificadores de automação duplicados");
  let inflight: Promise<OverviewResponse> | null = null;
  return {
    read(): Promise<OverviewResponse> {
      if (inflight) return inflight;
      inflight = (async () => {
        const window = historyWindow(clock());
        const results = await Promise.all(
          providers.map(async (provider) => {
            const [snapshot, history] = await Promise.allSettled([
              provider.dashboard.read(),
              provider.history.readHistory(window),
            ]);
            const dashboard: Dashboard =
              snapshot.status === "fulfilled"
                ? snapshot.value
                : {
                    mode,
                    generatedAt: window.to,
                    metrics: null,
                    approvals: null,
                    failures: null,
                    executions: null,
                    sources: {
                      database: { status: "error", message: "Automação indisponível." },
                      n8n: { status: "error", message: "Automação indisponível." },
                    },
                  };
            return { provider, dashboard, history };
          }),
        );
        const failed = results.some((r) => r.history.status === "rejected");
        const complete =
          !failed &&
          results.every((r) => r.history.status === "fulfilled" && r.history.value.complete);
        const executions = results.flatMap((r) =>
          r.history.status === "fulfilled"
            ? r.history.value.executions.map((e) => ({ ...e, automationId: r.provider.id }))
            : [],
        );
        const ap = results.find((r) => r.provider.id === "accounts-payable") ?? results[0];
        const sourceStatus = (source: "database" | "n8n") => {
          if (!ap) return false;
          if (source === "database") {
            return ap.dashboard.sources.database.status === "ok";
          }
          const apFailed = ap.history.status === "rejected";
          return ap.dashboard.sources.n8n.status === "ok" && !apFailed;
        };
        const [tinyHealth, interHealth] = await Promise.all([
          healthCheckers?.checkTiny
            ? Promise.resolve()
                .then(() => healthCheckers.checkTiny!())
                .catch(() => ({
                  connected: false,
                  message: "Falha na verificação de saúde do Tiny ERP.",
                }))
            : Promise.resolve(null),
          healthCheckers?.checkInter
            ? Promise.resolve()
                .then(() => healthCheckers.checkInter!())
                .catch(() => ({
                  connected: false,
                  message: "Falha na verificação de saúde do Banco Inter.",
                }))
            : Promise.resolve(null),
        ]);

        return {
          mode,
          generatedAt: window.to,
          automations: results.map(({ provider, dashboard }) => ({
            id: provider.id,
            title: provider.title,
            href: provider.href,
            dashboard,
          })),
          history: {
            ...window,
            complete,
            executions,
            error: failed
              ? "Histórico indisponível para uma ou mais automações."
              : complete
                ? null
                : "Histórico parcial: limite de consulta ou datas ausentes.",
          },
          services: (
            [
              ["mariadb", "MariaDB"],
              ["n8n", "n8n"],
              ["tiny", "Tiny ERP"],
              ["inter", "Banco Inter"],
            ] as const
          ).map(([id, name]) => {
            if (mode === "demo")
              return {
                id,
                name,
                status: "demo" as const,
                message: "Demonstração com dados fictícios; conexão real não verificada.",
              };
            if (id === "tiny") {
              if (tinyHealth) {
                return {
                  id,
                  name,
                  status: tinyHealth.connected ? ("connected" as const) : ("error" as const),
                  message: tinyHealth.message,
                };
              }
              return {
                id,
                name,
                status: "unverified" as const,
                message: "Conexão direta não verificada; endpoint de saúde não configurado.",
              };
            }
            if (id === "inter") {
              if (interHealth) {
                return {
                  id,
                  name,
                  status: interHealth.connected ? ("connected" as const) : ("error" as const),
                  message: interHealth.message,
                };
              }
              return {
                id,
                name,
                status: "unverified" as const,
                message: "Conexão direta não verificada; endpoint de saúde não configurado.",
              };
            }
            const connected = sourceStatus(id === "mariadb" ? "database" : "n8n");
            const errorMessage =
              id === "n8n"
                ? (ap?.dashboard?.sources?.n8n?.message || "Falha na consulta da fonte.")
                : "Falha na consulta da fonte.";
            return {
              id,
              name,
              status: connected ? ("connected" as const) : ("error" as const),
              message: connected ? "Consulta realizada com sucesso." : errorMessage,
            };
          }),
        };
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
export function createDemoHistory(): HistoryAdapter {
  return {
    async readHistory(window) {
      const executions = [];
      for (let day = 0; day < 14; day++) {
        for (let i = 0; i < 6 + (day % 5); i++) {
          const start = new Date(
            Date.parse(window.from) + day * 86400000 + (8 * 60 + i * 45) * 60000,
          );
          if (start.getTime() > Date.parse(window.to)) continue;
          const status = i === 2 && day % 4 === 0 ? ("error" as const) : ("success" as const);
          const end = new Date(start.getTime() + 18000 + i * 1000);
          if (end.getTime() > Date.parse(window.to)) continue;
          executions.push({
            id: `DEMO-HISTORY-${start.toISOString()}`,
            startedAt: start.toISOString(),
            stoppedAt: end.toISOString(),
            durationMs: end.getTime() - start.getTime(),
            status,
            stoppedNode: status === "error" ? "Validar boleto" : null,
          });
        }
      }
      return { complete: true, executions };
    },
  };
}
