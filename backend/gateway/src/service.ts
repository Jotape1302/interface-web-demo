import type { Dashboard, DatabaseAdapter, ExecutionAdapter } from "./contracts.js";

function formatN8nErrorMessage(reason: unknown): string {
  const errStr = reason instanceof Error ? reason.message : String(reason);
  if (errStr.includes("401")) return "Falha de autenticação no n8n (API Key inválida ou expirada).";
  if (errStr.includes("403")) return "Acesso negado no n8n (API Key sem permissão).";
  if (errStr.includes("404")) return "Endpoint ou workflow não encontrado no n8n (verifique N8N_WORKFLOW_IDS).";
  if (errStr.includes("ECONNREFUSED") || errStr.includes("fetch failed")) {
    return "Não foi possível conectar ao n8n. Verifique se o n8n está ativo e acessível na rede.";
  }
  if (errStr.toLowerCase().includes("timeout")) {
    return "Tempo limite esgotado ao consultar o n8n.";
  }
  return "Telemetria indisponível. Verifique a conexão e a configuração do n8n no servidor.";
}

export function createDashboardService(
  mode: Dashboard["mode"],
  database: DatabaseAdapter,
  n8n: ExecutionAdapter,
  report: (source: string, error: unknown) => void = () => undefined,
) {
  // Coalesce concurrent requests without persisting financial responses or retry storms.
  let inflight: Promise<Dashboard> | null = null;
  return {
    read(): Promise<Dashboard> {
      if (inflight) return inflight;
      inflight = Promise.allSettled([database.read(), n8n.read()])
        .then(([db, executions]): Dashboard => {
          if (db.status === "rejected") report("database", db.reason);
          if (executions.status === "rejected") report("n8n", executions.reason);
          return {
            mode,
            generatedAt: new Date().toISOString(),
            metrics: db.status === "fulfilled" ? db.value.metrics : null,
            approvals: db.status === "fulfilled" ? db.value.approvals : null,
            failures: db.status === "fulfilled" ? db.value.failures : null,
            executions: executions.status === "fulfilled" ? executions.value : null,
            sources: {
              database:
                db.status === "fulfilled"
                  ? { status: "ok" }
                  : {
                      status: "error",
                      message:
                        "Dados financeiros indisponíveis. Verifique a conexão e o esquema no servidor.",
                    },
              n8n:
                executions.status === "fulfilled"
                  ? { status: "ok" }
                  : {
                      status: "error",
                      message: formatN8nErrorMessage(executions.reason),
                    },
            },
          };
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
