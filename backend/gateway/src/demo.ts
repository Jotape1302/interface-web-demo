import type { DatabaseAdapter, ExecutionAdapter } from "./contracts.js";
import { metricsFromCounts } from "./database.js";
export function createDemo(): { database: DatabaseAdapter; n8n: ExecutionAdapter } {
  return {
    database: {
      async read() {
        return {
          metrics: metricsFromCounts(1280, 1092, 1184),
          approvals: Array.from({ length: 12 }, (_, i) => ({
            id: `demo-approval-${i + 1}`,
            beneficiary: `Fornecedor demonstração ${String(i + 1).padStart(2, "0")}`,
            cnpj: "00.000.000/0000-00",
            amount: `${1250 + i * 125}.00`,
            dueDate: `2026-09-${String(8 + i).padStart(2, "0")}`,
            status: "AGUARDANDO_APROVACAO",
            transactionId: `DEMO-INTER-${i + 1}`,
            errorLog: null,
            stoppedNode: null,
            updatedAt: "2026-09-08 09:00:00",
          })),
          failures: Array.from({ length: 4 }, (_, i) => ({
            id: `demo-failure-${i + 1}`,
            beneficiary: `Fornecedor teste ${i + 1}`,
            cnpj: "00.000.000/0000-00",
            amount: `${780 + i * 210}.50`,
            dueDate: "2026-09-10",
            status: "FALHA",
            transactionId: null,
            errorLog: [
              "Código de barras não localizado no retorno do ERP.",
              "Divergência entre o valor nominal e o boleto consultado.",
              "Tempo limite excedido na consulta de dados do favorecido.",
              "Cadastro do favorecido incompleto para conciliação.",
            ][i]!,
            stoppedNode: [
              "Consultar boleto",
              "Validar valor",
              "Consultar favorecido",
              "Validar cadastro",
            ][i]!,
            updatedAt: "2026-09-08 09:00:00",
          })),
        };
      },
    },
    n8n: {
      async read() {
        return [
          {
            id: "DEMO-1043",
            startedAt: "2026-09-08T12:00:00Z",
            stoppedAt: null,
            durationMs: null,
            status: "waiting",
            stoppedNode: "Aguardar aprovação do gestor",
          },
          {
            id: "DEMO-1042",
            startedAt: "2026-09-08T11:45:00Z",
            stoppedAt: "2026-09-08T11:45:24Z",
            durationMs: 24000,
            status: "success",
            stoppedNode: null,
          },
          {
            id: "DEMO-1041",
            startedAt: "2026-09-08T11:30:00Z",
            stoppedAt: "2026-09-08T11:30:12Z",
            durationMs: 12000,
            status: "error",
            stoppedNode: "Validar valor",
          },
        ];
      },
    },
  };
}
