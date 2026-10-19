import { automationFetch } from "./automation-http.js";
import { readFile } from "node:fs/promises";
import { getAllCircuitBreakers, type CircuitBreaker } from "./circuit-breaker.js";
import type { DanfeService } from "./danfe.js";
import type { FinancialDashboardService } from "./financial-dashboard.js";
import type { ServiceHealthResult } from "./overview.js";

export type HealthState = "ok" | "warning" | "error" | "unknown";
export type HealthGroup = "Infraestrutura" | "Integrações" | "Rotinas";

export interface HealthDetail {
  label: string;
  value: string;
  state?: HealthState;
}

export interface HealthCheckOutcome {
  state: HealthState;
  message: string;
  details?: HealthDetail[];
}

export interface HealthCheckDefinition {
  id: string;
  title: string;
  group: HealthGroup;
  run(): Promise<HealthCheckOutcome>;
}

export interface HealthCheckResult extends HealthCheckOutcome {
  id: string;
  title: string;
  group: HealthGroup;
  latencyMs: number;
  checkedAt: string;
  /** % de amostras sem erro nas últimas horas (null sem amostras conclusivas). */
  uptimePct: number | null;
  history: { at: string; state: HealthState }[];
}

export interface SystemHealthReport {
  generatedAt: string;
  overall: HealthState;
  historyHours: number;
  sampleIntervalMinutes: number;
  checks: HealthCheckResult[];
}

export interface SystemHealthMonitor {
  read(force?: boolean): Promise<SystemHealthReport>;
  start(): void;
  stop(): void;
}

const HOUR = 3600_000;

/** Pior estado entre os informados: error > warning > ok > unknown. */
export function worstState(states: HealthState[]): HealthState {
  const rank: Record<HealthState, number> = { unknown: 0, ok: 1, warning: 2, error: 3 };
  return states.reduce<HealthState>((worst, s) => (rank[s] > rank[worst] ? s : worst), "unknown");
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sem resposta em ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Página "Saúde do sistema": roda as checagens sob demanda (com cache curto, para vários
 * admins com a página aberta não martelarem o Tiny) e a cada `intervalMs` em segundo
 * plano para montar o histórico. O histórico fica em memória: some num restart do gateway.
 */
export function createSystemHealthMonitor(
  checks: HealthCheckDefinition[],
  opts: { intervalMs?: number; historyHours?: number; timeoutMs?: number; cacheMs?: number; clock?: () => Date } = {},
): SystemHealthMonitor {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const historyHours = opts.historyHours ?? 24;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cacheMs = opts.cacheMs ?? 30_000;
  const clock = opts.clock ?? (() => new Date());
  const history = new Map<string, { at: string; state: HealthState }[]>();
  let last: { at: number; results: Omit<HealthCheckResult, "uptimePct" | "history">[] } | null = null;
  let inflight: Promise<Omit<HealthCheckResult, "uptimePct" | "history">[]> | null = null;
  let timer: NodeJS.Timeout | undefined;

  async function runOne(check: HealthCheckDefinition) {
    const started = Date.now();
    let outcome: HealthCheckOutcome;
    try {
      outcome = await withTimeout(check.run(), timeoutMs);
    } catch (e) {
      outcome = { state: "error", message: `Falha na verificação: ${e instanceof Error ? e.message : String(e)}` };
    }
    return {
      id: check.id,
      title: check.title,
      group: check.group,
      ...outcome,
      latencyMs: Date.now() - started,
      checkedAt: clock().toISOString(),
    };
  }

  function remember(results: Omit<HealthCheckResult, "uptimePct" | "history">[]) {
    const cutoff = clock().getTime() - historyHours * HOUR;
    for (const r of results) {
      const list = history.get(r.id) ?? [];
      list.push({ at: r.checkedAt, state: r.state });
      while (list.length > 0 && Date.parse(list[0]!.at) < cutoff) list.shift();
      history.set(r.id, list);
    }
  }

  async function sample() {
    if (!inflight) {
      inflight = Promise.all(checks.map(runOne))
        .then((results) => {
          last = { at: Date.now(), results };
          remember(results);
          return results;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    async read(force = false) {
      const results = !force && last && Date.now() - last.at < cacheMs ? last.results : await sample();
      const withHistory = results.map((r) => {
        const samples = history.get(r.id) ?? [];
        const conclusive = samples.filter((s) => s.state !== "unknown");
        const good = conclusive.filter((s) => s.state !== "error").length;
        return {
          ...r,
          history: samples,
          uptimePct: conclusive.length > 0 ? Math.round((good / conclusive.length) * 1000) / 10 : null,
        };
      });
      return {
        generatedAt: clock().toISOString(),
        overall: worstState(withHistory.map((r) => r.state)),
        historyHours,
        sampleIntervalMinutes: Math.round(intervalMs / 60_000),
        checks: withHistory,
      };
    },
    start() {
      if (timer) return;
      // 1ª amostra depois de 1 min, para os outros serviços terem subido junto.
      const first = setTimeout(() => void sample(), 60_000);
      first.unref();
      timer = setInterval(() => void sample(), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

// -----------------------------------------------------------------------------
// Checagens
// -----------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}min`;
  return `${minutes}min`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / HOUR : null;
}

export function gatewayCheck(mode: string, startedAt = new Date()): HealthCheckDefinition {
  return {
    id: "gateway",
    title: "API Gateway",
    group: "Infraestrutura",
    async run() {
      const mem = process.memoryUsage();
      return {
        state: "ok",
        message: `No ar há ${formatDuration(Date.now() - startedAt.getTime())}.`,
        details: [
          { label: "Modo", value: mode === "live" ? "Produção (dados reais)" : "Demonstração" },
          { label: "Memória", value: formatBytes(mem.rss) },
          { label: "Node.js", value: process.version },
        ],
      };
    },
  };
}

export function databaseCheck(
  ping?: () => Promise<{ latencyMs?: number; databases?: string[] } | void>,
): HealthCheckDefinition {
  return {
    id: "mariadb",
    title: "MariaDB",
    group: "Infraestrutura",
    async run() {
      if (!ping) return { state: "unknown", message: "Modo demonstração: sem banco de dados configurado." };
      const start = Date.now();
      const meta = await ping();
      const measuredLatency =
        meta && typeof meta === "object" && typeof meta.latencyMs === "number"
          ? meta.latencyMs
          : Date.now() - start;

      const details: HealthDetail[] = [
        {
          label: "Latência de consulta",
          value: `${measuredLatency}ms`,
          state: measuredLatency < 200 ? "ok" : "warning",
        },
      ];

      if (meta && typeof meta === "object" && Array.isArray(meta.databases) && meta.databases.length > 0) {
        details.push({
          label: "Bancos operacionais",
          value: meta.databases.join(", "),
          state: "ok",
        });
      }

      return {
        state: "ok",
        message: `Banco respondendo a consultas (${measuredLatency}ms).`,
        details,
      };
    },
  };
}

export function fiscalEngineCheck(danfe: DanfeService): HealthCheckDefinition {
  return {
    id: "automacao-nfe",
    title: "Motor fiscal (automacao-nfe)",
    group: "Infraestrutura",
    async run() {
      const status = await danfe.readStatus();
      const ok = status.status === "ok";
      return {
        state: ok ? "ok" : "error",
        message: ok ? "Serviço de NF-e e Dashboard Financeiro no ar." : `Serviço respondeu com status "${status.status}".`,
        details: [
          { label: "Versão", value: status.version || "—" },
          { label: "Tiny configurado", value: status.tiny_configured ? "Sim" : "Não", state: status.tiny_configured ? "ok" : "warning" },
          { label: "OCR", value: status.ocr_enabled ? "Ativo" : "Desativado" },
        ],
      };
    },
  };
}

export function marketplaceEngineCheck(
  urlOrFetcher?: string | (() => Promise<{ status: string; service?: string } | Response>),
): HealthCheckDefinition {
  return {
    id: "automacao-marketplace",
    title: "Motor de Marketplace (automacoes-marketplace)",
    group: "Infraestrutura",
    async run() {
      if (!urlOrFetcher) {
        return {
          state: "unknown",
          message: "Serviço de Marketplace não configurado neste ambiente.",
        };
      }
      try {
        let data: { status?: string; service?: string } = {};
        if (typeof urlOrFetcher === "function") {
          const res = await urlOrFetcher();
          if (res instanceof Response) {
            if (!res.ok) {
              return { state: "error", message: `Serviço respondeu com HTTP ${res.status}.` };
            }
            data = (await res.json()) as { status?: string; service?: string };
          } else {
            data = res;
          }
        } else {
          const res = await automationFetch(`${urlOrFetcher.replace(/\/$/, "")}/health`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok) {
            return { state: "error", message: `Serviço respondeu com HTTP ${res.status}.` };
          }
          data = (await res.json()) as { status?: string; service?: string };
        }
        const ok = data.status === "ok";
        return {
          state: ok ? "ok" : "error",
          message: ok
            ? "Serviço de Marketplace operacional."
            : `Serviço respondeu com status "${data.status}".`,
          details: [
            { label: "Serviço", value: data.service ?? "automacoes-marketplace" },
            { label: "Status retornado", value: data.status ?? "desconhecido", state: ok ? "ok" : "error" },
          ],
        };
      } catch (err) {
        return {
          state: "error",
          message: `Falha ao conectar no serviço de Marketplace: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

export function circuitBreakersCheck(
  getStats: () => Record<string, ReturnType<CircuitBreaker["getStats"]>> = getAllCircuitBreakers,
): HealthCheckDefinition {
  return {
    id: "circuit-breakers",
    title: "Circuit Breakers (Resiliência)",
    group: "Infraestrutura",
    async run() {
      const stats = getStats();
      const entries = Object.values(stats);
      if (entries.length === 0) {
        return {
          state: "ok",
          message: "Nenhum circuito de integração registrado.",
        };
      }

      const openCircuits = entries.filter((c) => c.state === "open");
      const halfOpenCircuits = entries.filter((c) => c.state === "half_open");

      let state: HealthState = "ok";
      let message = `Todos os ${entries.length} circuitos de integração fechados (operacionais).`;

      if (openCircuits.length > 0) {
        state = "error";
        message = `${openCircuits.length} circuito(s) ABERTO(S): fail-fast ativado para upstream indisponível.`;
      } else if (halfOpenCircuits.length > 0) {
        state = "warning";
        message = `${halfOpenCircuits.length} circuito(s) em recuperação (half-open: testando conectividade).`;
      }

      const details: HealthDetail[] = entries.map((c) => {
        let circuitState: HealthState = "ok";
        let desc = "Fechado (operacional)";
        if (c.state === "open") {
          circuitState = "error";
          desc = `Aberto (${c.failureCount} falhas consecutivas)`;
        } else if (c.state === "half_open") {
          circuitState = "warning";
          desc = `Em teste de recuperação (${c.successCount} sucessos)`;
        } else if (c.failureCount > 0) {
          desc = `Fechado (${c.failureCount} falhas registradas)`;
        }

        if (c.lastError) {
          desc += ` · Último erro: ${c.lastError}`;
        }

        return {
          label: `Circuito · ${c.name}`,
          value: desc,
          state: circuitState,
        };
      });

      return { state, message, details };
    },
  };
}

export function connectorCheck(
  id: string,
  title: string,
  check: (() => Promise<ServiceHealthResult> | ServiceHealthResult) | undefined,
): HealthCheckDefinition {
  return {
    id,
    title,
    group: "Integrações",
    async run() {
      if (!check) return { state: "unknown", message: "Verificação não configurada." };
      const res = await check();
      return { state: res.connected ? "ok" : "error", message: res.message };
    },
  };
}

export function n8nCheck(
  configured: boolean,
  check: () => Promise<{ connected: boolean; message: string }>,
): HealthCheckDefinition {
  return {
    id: "n8n",
    title: "n8n (Contas a Pagar e tokens)",
    group: "Integrações",
    async run() {
      if (!configured) return { state: "unknown", message: "N8N_BASE_URL não configurada neste ambiente." };
      const res = await check();
      return { state: res.connected ? "ok" : "error", message: res.message };
    },
  };
}

export function sefazCheck(danfe: DanfeService, clock: () => Date = () => new Date()): HealthCheckDefinition {
  return {
    id: "sefaz",
    title: "Varredura SEFAZ e certificados A1",
    group: "Rotinas",
    async run() {
      const status = await danfe.readSefazStatus();
      const details: HealthDetail[] = [];
      const states: HealthState[] = [];
      for (const cert of status.certificados ?? []) {
        const who = cert.titular ?? cert.cnpj ?? cert.arquivo;
        let state: HealthState = "ok";
        let value: string;
        if (cert.erro) {
          state = "error";
          value = `Erro: ${cert.erro}`;
        } else if (cert.dias_restantes === null) {
          state = "unknown";
          value = "Validade desconhecida";
        } else if (cert.dias_restantes < 0) {
          state = "error";
          value = "Vencido";
        } else {
          state = cert.alerta ? "warning" : "ok";
          value = `Vence em ${cert.dias_restantes} dia(s)`;
        }
        states.push(state);
        details.push({ label: `Certificado · ${who}`, value, state });
      }
      const failing = status.cnpjs.filter((c) => c.status === "erro");
      for (const c of failing) details.push({ label: `CNPJ ${c.cnpj}`, value: c.erro ?? "Erro na última varredura", state: "warning" });
      if (failing.length > 0) states.push("warning");
      const age = hoursSince(status.last_scan_finished_at, clock());
      if (age !== null) details.unshift({ label: "Última varredura", value: `há ${formatDuration(age * HOUR)}` });
      let state = worstState(states.length > 0 ? states : ["ok"]);
      let message =
        state === "error"
          ? "Há certificado vencido ou com erro: a varredura desse CNPJ para."
          : state === "warning"
            ? "Certificado perto do vencimento ou CNPJ com erro na última varredura."
            : "Certificados válidos e varredura sem erro.";
      // A varredura é diária: parada há mais de 26h passou despercebida por 3 dias em 2026-09-28.
      if (age !== null && age > 26 && state === "ok") {
        state = "warning";
        message = "A varredura diária não roda há mais de 26 horas.";
      }
      if (status.erro_gravacao) {
        state = "error";
        message = "A varredura roda, mas não consegue gravar o NSU/status no servidor (permissão em data/).";
        details.push({ label: "Erro de gravação", value: status.erro_gravacao, state: "error" });
      }
      return { state, message, details };
    },
  };
}

/** "norvia_campinas" → "Norvia Campinas". */
function companyLabel(accountId: string): string {
  return accountId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function financialSyncCheck(
  financialDashboard: FinancialDashboardService,
  clock: () => Date = () => new Date(),
): HealthCheckDefinition {
  return {
    id: "dashboard-financeiro",
    title: "Sincronização do Dashboard Financeiro",
    group: "Rotinas",
    async run() {
      const status = await financialDashboard.readStatus();
      if (!status.last_sync_finished_at && status.companies.length === 0) {
        return { state: "warning", message: "Nenhuma sincronização concluída ainda." };
      }
      const details: HealthDetail[] = status.companies.map((c) => ({
        label: companyLabel(c.account_id),
        value: c.ok ? "Sincronizada" : c.erro ?? "Falhou",
        state: c.ok ? "ok" : "warning",
      }));
      const failed = status.companies.filter((c) => !c.ok);
      const age = hoursSince(status.last_sync_finished_at, clock());
      if (age !== null) details.unshift({ label: "Última sincronização", value: `há ${formatDuration(age * HOUR)}` });
      if (status.is_running) details.unshift({ label: "Agora", value: "Sincronizando…" });
      let state: HealthState = "ok";
      let message = "Todas as empresas sincronizadas.";
      if (failed.length > 0 && failed.length === status.companies.length) {
        state = "error";
        message = "A última sincronização falhou em todas as empresas.";
      } else if (failed.length > 0) {
        state = "warning";
        message = `${failed.length} empresa(s) com falha na última sincronização.`;
      }
      if (age !== null && age > 26 && state === "ok") {
        state = "warning";
        message = "A sincronização diária não roda há mais de 26 horas.";
      }
      if (status.erro_gravacao) {
        state = "error";
        message = "A sincronização roda, mas não consegue gravar o resultado no servidor (permissão em data/).";
        details.push({ label: "Erro de gravação", value: status.erro_gravacao, state: "error" });
      }
      return { state, message, details };
    },
  };
}

export interface MlReconciliationStatus {
  empresas: Array<{ id: string; nome: string; conexoes: Record<string, boolean> }>;
  em_execucao: { iniciada_em: string } | null;
  ultima_execucao: {
    concluida_em: string;
    status: "ok" | "parcial" | "erro";
    empresas: Record<string, { status: string; mensagem?: string }>;
  } | null;
  erro_gravacao: string | null;
}

const ML_CONEXOES: Record<string, string> = { mercado_pago: "Mercado Pago", mercado_livre: "Mercado Livre", tiny: "Tiny" };

export function mlReconciliationCheck(
  readStatus: () => Promise<MlReconciliationStatus>,
  clock: () => Date = () => new Date(),
): HealthCheckDefinition {
  return {
    id: "conciliacao-ml",
    title: "Conciliação Mercado Livre",
    group: "Rotinas",
    async run() {
      const status = await readStatus();
      const ultima = status.ultima_execucao;
      const details: HealthDetail[] = status.empresas.map((e) => {
        const faltando = Object.entries(e.conexoes)
          .filter(([, ok]) => !ok)
          .map(([k]) => ML_CONEXOES[k] ?? k);
        const resultado = ultima?.empresas[e.id];
        const falhou = resultado && resultado.status !== "ok";
        return {
          label: e.nome,
          value: falhou
            ? resultado!.mensagem || "Falhou na última execução"
            : faltando.length > 0
              ? `Sem token: ${faltando.join(", ")}`
              : "Conectada",
          state: falhou || faltando.length > 0 ? "warning" : "ok",
        };
      });
      if (status.em_execucao) details.unshift({ label: "Agora", value: "Conciliando…" });
      if (!ultima) {
        return { state: "warning", message: "Nenhuma conciliação executada ainda.", details };
      }
      const age = hoursSince(ultima.concluida_em, clock());
      if (age !== null) details.unshift({ label: "Última execução", value: `há ${formatDuration(age * HOUR)}` });
      let state: HealthState = "ok";
      let message = "Última conciliação concluída em todas as empresas.";
      if (ultima.status === "erro") {
        state = "error";
        message = "A última conciliação falhou em todas as empresas.";
      } else if (ultima.status === "parcial") {
        state = "warning";
        message = "A última conciliação falhou em parte das empresas.";
      } else if (age !== null && age > 26) {
        state = "warning";
        message = "A conciliação diária não roda há mais de 26 horas.";
      }
      if (status.erro_gravacao) {
        state = "error";
        message = "A conciliação roda, mas não consegue gravar o resultado no servidor (permissão em data/).";
        details.push({ label: "Erro de gravação", value: status.erro_gravacao, state: "error" });
      }
      return { state, message, details };
    },
  };
}

interface BackupStatusFile {
  status?: string;
  finishedAt?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  retentionDays?: number;
  offsite?: boolean;
  error?: string | null;
}

export function backupCheck(statusFile: string | undefined, clock: () => Date = () => new Date()): HealthCheckDefinition {
  return {
    id: "backup",
    title: "Backup do MariaDB e caches",
    group: "Rotinas",
    async run() {
      if (!statusFile) {
        return {
          state: "unknown",
          message: "BACKUP_STATUS_FILE não configurado no gateway (ver scripts/backup/README.md).",
        };
      }
      let data: BackupStatusFile;
      try {
        data = JSON.parse(await readFile(statusFile, "utf-8")) as BackupStatusFile;
      } catch (e) {
        const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
        return {
          state: "error",
          message: missing
            ? "Nenhum backup registrado ainda (last-backup.json não existe)."
            : "Não foi possível ler o status do backup.",
        };
      }
      const age = hoursSince(data.finishedAt, clock());
      const details: HealthDetail[] = [];
      if (age !== null) details.push({ label: "Último backup", value: `há ${formatDuration(age * HOUR)}` });
      if (typeof data.sizeBytes === "number" && data.status === "ok") details.push({ label: "Tamanho", value: formatBytes(data.sizeBytes) });
      if (typeof data.retentionDays === "number") details.push({ label: "Retenção", value: `${data.retentionDays} dias` });
      details.push({
        label: "Cópia fora do servidor",
        value: data.offsite ? "Sim" : "Não configurada",
        state: data.offsite ? "ok" : "warning",
      });
      if (data.status !== "ok") {
        return { state: "error", message: data.error || "O último backup falhou.", details };
      }
      if (age === null || age > 26) {
        return { state: "warning", message: "O backup diário não roda há mais de 26 horas.", details };
      }
      return { state: "ok", message: "Último backup concluído e conferido.", details };
    },
  };
}

export function stockBotCheck(): HealthCheckDefinition {
  return {
    id: "contagem-estoque",
    title: "Contagem de Estoque (bot Telegram)",
    group: "Infraestrutura",
    async run() {
      return {
        state: "unknown",
        message:
          "Sem verificação automática: o bot usa long polling e não expõe porta. Confira no servidor com docker compose ps contagem-estoque.",
      };
    },
  };
}
