import { readConfig } from "./config.js";
// Resolução de servidor.norvia.example para a infraestrutura interna é responsabilidade do
// `extra_hosts` do docker-compose.yml (ou do /etc/hosts do host), não do código da aplicação:
// manter os dois mecanismos duplicava um endereço IP fixo em dois lugares divergentes.
import { createDbPool } from "./database.js";
import { createN8n, createN8nHistory } from "./n8n.js";
import { createDemo } from "./demo.js";
import { createDashboardService } from "./service.js";
import { createApi } from "./server.js";
import { createOverviewService, createDemoHistory } from "./overview.js";
import { createDanfeService } from "./danfe.js";
import { createFinancialDashboardService } from "./financial-dashboard.js";
import { createAuthService, seedDemoProfiles } from "./auth.js";
import { createNotificationService } from "./notifications.js";
import { createChatService } from "./chat.js";
import { createIncidentService } from "./incidents.js";
import { checkCertificateAlerts } from "./cert-alerts.js";
import { checkAutomationAlerts, checkMarketplaceAlerts, type MarketplaceAviso } from "./marketplace-alerts.js";
import { marketplaceApiUrl } from "./routes/marketplace.js";
import { createEventHub } from "./events.js";
import { createAuditService } from "./audit.js";
import { createReconciliationHistoryService } from "./reconciliation-history.js";
import {
  backupCheck,
  circuitBreakersCheck,
  connectorCheck,
  createSystemHealthMonitor,
  databaseCheck,
  financialSyncCheck,
  fiscalEngineCheck,
  gatewayCheck,
  marketplaceEngineCheck,
  mlReconciliationCheck,
  n8nCheck,
  type MlReconciliationStatus,
  sefazCheck,
  stockBotCheck,
} from "./system-health.js";
import { checkN8n } from "./routes/health.js";
import { automationFetch, createAutomationUrlResolver, financeiroCandidateUrls } from "./automation-http.js";
import { createStockSkuService } from "./stock-sku.js";

const config = readConfig();
const dbPool = config.mode === "live" ? createDbPool(config) : undefined;
const authService = createAuthService(config, dbPool);
void authService.bootstrap().then(async () => {
  // Demo: perfis de exemplo do RBAC (Gestor, Users com e sem permissões) no store em memória.
  if (config.mode === "demo") {
    await seedDemoProfiles(authService).catch((err) =>
      console.warn(JSON.stringify({ event: "demo_profiles_seed_failed", message: String(err) })),
    );
  }
});

const eventHub = createEventHub();

const notificationService = createNotificationService(config, dbPool, {
  getRecipientIds: async (role) =>
    (await authService.listUsers()).filter((u) => u.role === role && u.status === "approved").map((u) => u.id),
  listUsers: async () => authService.listUsers(),
  onNotify: (destinatarioId) => eventHub.publish(destinatarioId, "notification"),
});
void notificationService.bootstrap();

const chatService = createChatService(config, dbPool, {
  listApprovedUsers: async () =>
    (await authService.listUsers())
      .filter((u) => u.status === "approved")
      .map((u) => ({ id: u.id, nome: u.nome, username: u.username, foto_perfil: null, setor: u.setor, role: u.role })),
});
void chatService.bootstrap();

const incidentService = createIncidentService(config, dbPool, {
  // Incidente reportado → quem vê Erros & Falhas (e os admins).
  notifyAdmins: (data) => notificationService.notifyPermission("erros:ver", data),
});
void incidentService.bootstrap();

const auditService = createAuditService(config, dbPool);
void auditService.bootstrap();
const reconciliationHistory = createReconciliationHistoryService(config, dbPool);
const stockSku = createStockSkuService(config, dbPool);
void stockSku.bootstrap();
void reconciliationHistory.bootstrap();

const adapters =
  config.mode === "demo"
    ? createDemo()
    : {
        // Métricas/falhas do Contas a Pagar vêm do histórico de baixas da conciliação
        // (a tabela conciliacao_contas_pagar do antigo fluxo n8n foi aposentada).
        database: { read: () => reconciliationHistory.snapshot() },
        n8n: createN8n(config, fetch, 100),
      };
const service = createDashboardService(
  config.mode,
  adapters.database,
  adapters.n8n,
  (source, error) => {
    // Do not log SQL, request URLs, credentials, financial rows or execution payloads.
    const code = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ event: "source_unavailable", source, code, message, at: new Date().toISOString() }),
    );
  },
);
const danfeService = createDanfeService(
  config.mode,
  process.env.DANFE_API_URL,
);
const financialDashboardService = createFinancialDashboardService(
  config.mode,
  process.env.DANFE_API_URL,
);
// Motor financeiro (8000): mesma lista de candidatos e descoberta de danfe.ts (DANFE_API_URL,
// automacao-nfe:8000, 127.0.0.1...), sempre com a chave interna.
const resolveFinanceiroUrl = createAutomationUrlResolver(financeiroCandidateUrls(process.env.DANFE_API_URL));

const healthCheckers = {
  checkTiny: async () => {
    if (config.mode === "demo") {
      return { connected: true, message: "Demonstração com dados fictícios; conexão real não verificada." };
    }
    if (process.env.TINY_HEALTH_URL) {
      try {
        const res = await fetch(process.env.TINY_HEALTH_URL, {
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (res.ok) {
          return { connected: true, message: "Endpoint de saúde Tiny ERP operacional." };
        }
        return { connected: false, message: `Endpoint Tiny respondeu com HTTP ${res.status}.` };
      } catch {
        return { connected: false, message: "Falha ao conectar no endpoint Tiny ERP." };
      }
    }
    try {
      const danfeStatus = await danfeService.readStatus();
      if (danfeStatus.status === "ok" && danfeStatus.tiny_configured) {
        return { connected: true, message: "API v3 e integração fiscal operacional." };
      }
      if (danfeStatus.status === "ok") {
        return { connected: true, message: "Motor fiscal operacional (autenticação ativa)." };
      }
      return { connected: false, message: "Motor fiscal Tiny ERP indisponível." };
    } catch {
      return { connected: false, message: "Falha ao verificar serviço Tiny ERP." };
    }
  },
  checkInter: async () => {
    if (config.mode === "demo") {
      return { connected: true, message: "Demonstração com dados fictícios; conexão real não verificada." };
    }
    if (process.env.INTER_HEALTH_URL) {
      try {
        const res = await fetch(process.env.INTER_HEALTH_URL, {
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (res.ok) {
          return { connected: true, message: "Endpoint de saúde Banco Inter operacional." };
        }
        return { connected: false, message: `Endpoint Banco Inter respondeu com HTTP ${res.status}.` };
      } catch {
        return { connected: false, message: "Falha ao conectar no endpoint Banco Inter." };
      }
    }
    // Antes lia a tabela conciliacao_contas_pagar como "prova" de que o Inter estava no ar;
    // agora pergunta à API de conciliação o status real do mTLS/OAuth2 de cada filial.
    try {
      const res = await automationFetch(`${await resolveFinanceiroUrl()}/api/v1/reconciliacao/status`, {
        signal: AbortSignal.timeout(Math.max(config.timeoutMs, 15000)),
      });
      if (!res.ok) return { connected: false, message: `API de conciliação respondeu HTTP ${res.status}.` };
      const body = (await res.json()) as { empresas?: Array<{ nome?: string; inter_status?: string }> };
      const empresas = Array.isArray(body.empresas) ? body.empresas : [];
      const conectadas = empresas.filter((e) => e.inter_status === "conectado");
      if (empresas.length === 0) return { connected: false, message: "Nenhuma filial configurada no Banco Inter." };
      if (conectadas.length === empresas.length) {
        return { connected: true, message: `mTLS e OAuth2 operacionais nas ${empresas.length} filiais.` };
      }
      const fora = empresas.filter((e) => e.inter_status !== "conectado").map((e) => e.nome ?? "?");
      return {
        connected: conectadas.length > 0,
        message: `${conectadas.length} de ${empresas.length} filiais conectadas; sem conexão: ${fora.join(", ")}.`,
      };
    } catch {
      return { connected: false, message: "API de conciliação bancária indisponível." };
    }
  },
};

const overview = createOverviewService(
  config.mode,
  [
    {
      id: "accounts-payable",
      title: "Contas a Pagar (Conciliação Inter × Tiny)",
      href: "/contas-a-pagar",
      dashboard: service,
      history: config.mode === "demo" ? createDemoHistory() : { readHistory: (w) => reconciliationHistory.readHistory(w) },
    },
    {
      id: "danfe-tiny",
      title: "NF-e & DANFE (Tiny ERP)",
      href: "/danfe-tiny",
      dashboard: { read: () => danfeService.readDashboard() },
      history: danfeService.historyAdapter,
    },
  ],
  () => new Date(),
  healthCheckers,
);
// Alerta de vencimento dos certificados A1 da SEFAZ: checa a cada 6h (1ª vez 1 min após
// subir, para o motor fiscal já estar no ar) e notifica os admins por marco.
if (config.mode === "live") {
  const sentCertAlerts = new Set<string>();
  const runCertCheck = () =>
    checkCertificateAlerts(
      () => danfeService.readSefazStatus(),
      // Certificados A1 da SEFAZ → quem vê a Revisão NF-e (varredura) e os admins.
      (data) => notificationService.notifyPermission("revisao_nfe:ver", data),
      sentCertAlerts,
    ).catch((err) =>
      console.warn(JSON.stringify({ event: "cert_alert_check_failed", message: String(err), at: new Date().toISOString() })),
    );
  setTimeout(() => void runCertCheck(), 60_000).unref();
  setInterval(() => void runCertCheck(), 6 * 3600_000).unref();
}

// Avisos de Marketplace → quem vê Padronização de dimensões / Fretes a combinar + admins.
if (config.mode === "live") {
  const cursorMarketplace = { ultimoId: null as number | null };
  const runMarketplaceCheck = () =>
    checkMarketplaceAlerts({
      readAvisos: async (depoisDe) => {
        const res = await automationFetch(`${marketplaceApiUrl()}/api/v1/fretes/avisos?depois_de=${encodeURIComponent(String(depoisDe))}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { itens: MarketplaceAviso[]; ultimo_id: number };
      },
      listUsers: () => authService.listUsers(),
      notify: (id, data) => notificationService.notify(id, data),
      cursor: cursorMarketplace,
    }).catch((err) =>
      console.warn(JSON.stringify({ event: "marketplace_alert_check_failed", message: String(err), at: new Date().toISOString() })),
    );
  setTimeout(() => void runMarketplaceCheck(), 90_000).unref();
  setInterval(() => void runMarketplaceCheck(), 5 * 60_000).unref();
}

// Avisos da conciliação Mercado Livre (execução diária pronta, falha) → quem vê Conciliação ML + admins.

if (config.mode === "live") {
  const cursorConciliacaoMl = { ultimoId: null as number | null };
  const runMlAlertCheck = () =>
    checkAutomationAlerts({
      permissionFor: () => "conciliacao_ml:ver",
      linkFor: () => "/conciliacao-mercado-livre",
      readAvisos: async (depoisDe) => {
        const res = await automationFetch(`${await resolveFinanceiroUrl()}/api/v1/conciliacao-ml/avisos?depois_de=${encodeURIComponent(String(depoisDe))}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { itens: MarketplaceAviso[]; ultimo_id: number };
      },
      listUsers: () => authService.listUsers(),
      notify: (id, data) => notificationService.notify(id, data),
      cursor: cursorConciliacaoMl,
    }).catch((err) =>
      console.warn(JSON.stringify({ event: "ml_reconciliation_alert_check_failed", message: String(err), at: new Date().toISOString() })),
    );
  setTimeout(() => void runMlAlertCheck(), 100_000).unref();
  setInterval(() => void runMlAlertCheck(), 5 * 60_000).unref();
}

// Página "Saúde do sistema" (admin): cada serviço da plataforma, amostrado a cada 5 min.
const systemHealth = createSystemHealthMonitor(
  [
    gatewayCheck(config.mode),
    databaseCheck(
      dbPool
        ? async () => {
            const conn = await dbPool.getConnection();
            try {
              const start = Date.now();
              await conn.query({ sql: "SELECT 1", timeout: config.timeoutMs });
              const latencyMs = Date.now() - start;
              let databases: string[] = [];
              try {
                const rows = (await conn.query({
                  sql: "SELECT SCHEMA_NAME as db FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('financeiro', 'marketplace', 'producao')",
                  timeout: 3000,
                })) as Array<{ db?: string; SCHEMA_NAME?: string }>;
                databases = rows.map((r) => r.db || r.SCHEMA_NAME || "").filter(Boolean);
              } catch {
                // Se não conseguir inspecionar os esquemas, não impede o ping básico
              }
              return { latencyMs, databases };
            } finally {
              conn.release();
            }
          }
        : undefined,
    ),
    circuitBreakersCheck(),
    fiscalEngineCheck(danfeService),
    marketplaceEngineCheck(config.mode === "live" ? marketplaceApiUrl() : undefined),
    stockBotCheck(),
    connectorCheck("tiny", "Tiny ERP", healthCheckers.checkTiny),
    connectorCheck("inter", "Banco Inter", healthCheckers.checkInter),
    n8nCheck(Boolean(config.n8n.baseUrl), () => checkN8n(config)),
    sefazCheck(danfeService),
    financialSyncCheck(financialDashboardService),
    mlReconciliationCheck(async () => {
      if (config.mode !== "live") {
        return { empresas: [], em_execucao: null, ultima_execucao: null, erro_gravacao: null } as MlReconciliationStatus;
      }
      const res = await automationFetch(`${await resolveFinanceiroUrl()}/api/v1/conciliacao-ml/status`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as MlReconciliationStatus;
    }),
    backupCheck(process.env.BACKUP_STATUS_FILE || undefined),
  ],
  { timeoutMs: config.timeoutMs + 2000 },
);
systemHealth.start();

const server = createApi(config, {
  dashboard: service,
  overview,
  danfe: danfeService,
  healthCheckers,
  auth: authService,
  notifications: notificationService,
  chat: chatService,
  financialDashboard: financialDashboardService,
  incidents: incidentService,
  events: eventHub,
  audit: auditService,
  reconciliationHistory,
  stockSku,
  systemHealth,
});
server.listen(config.port, config.host, () =>
  console.log(`Norvia integration: ${config.mode}, ${config.host}:${config.port}`),
);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  // Streams SSE nunca terminam sozinhos — sem isso, server.close() esperaria os 15s do
  // timeout de segurança e sairia com código 1.
  eventHub.closeAll();
  server.close(() => {
    void adapters.database.close?.().finally(() => process.exit(0));
    if (!adapters.database.close) process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error(JSON.stringify({ event: "uncaught_exception", message: err.message, stack: err.stack }));
});
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ event: "unhandled_rejection", reason: String(reason) }));
});

