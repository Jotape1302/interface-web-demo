import type {
  Account,
  DashboardConfig,
  DashboardResponse,
  DashboardService,
  Execution,
  Metrics,
  SourceState,
} from "./contracts";
import { makeDemoDashboard } from "./demo";
const invalid = (): never => {
  throw new Error("A API retornou dados incompatíveis com o contrato do painel.");
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const str = (value: unknown): string => (typeof value === "string" ? value : invalid());
const nullableString = (value: unknown): string | null => (value === null ? null : str(value));
const positive = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : invalid();
const integer = (value: unknown): number =>
  Number.isSafeInteger(positive(value)) ? (value as number) : invalid();
const timestamp = (value: unknown): string =>
  typeof value === "string" &&
  /T.*(Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : invalid();
const optionalTimestamp = (value: unknown): string | null =>
  value === null ? null : timestamp(value);
function calendarDate(value: unknown): string {
  const text = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return invalid();
  const date = new Date(`${text}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text)
    return invalid();
  return text;
}
function account(value: unknown): Account {
  const row = object(value);
  const amount = str(row.amount);
  if (!/^-?\d+(\.\d+)?$/.test(amount) || !Number.isFinite(Number(amount))) return invalid();
  return {
    id: str(row.id),
    beneficiary: str(row.beneficiary),
    cnpj: str(row.cnpj),
    amount,
    dueDate: calendarDate(row.dueDate),
    status: str(row.status),
    transactionId: nullableString(row.transactionId),
    errorLog: nullableString(row.errorLog),
    stoppedNode: nullableString(row.stoppedNode),
    updatedAt: nullableString(row.updatedAt),
  };
}
export function parseExecution(value: unknown): Execution {
  const row = object(value);
  if (!["success", "error", "waiting", "running", "unknown"].includes(str(row.status)))
    return invalid();
  return {
    id: str(row.id),
    startedAt: optionalTimestamp(row.startedAt),
    stoppedAt: optionalTimestamp(row.stoppedAt),
    durationMs: row.durationMs === null ? null : positive(row.durationMs),
    status: row.status as Execution["status"],
    stoppedNode: nullableString(row.stoppedNode),
    ...(row.workflowId !== undefined ? { workflowId: nullableString(row.workflowId) } : {}),
  };
}
function metrics(value: unknown): Metrics {
  const row = object(value);
  const result = {
    totalQueue: integer(row.totalQueue),
    paidCount: integer(row.paidCount),
    reconciledCount: integer(row.reconciledCount),
    hoursSaved: positive(row.hoursSaved),
    estimatedSavings: positive(row.estimatedSavings),
    automationRate: row.automationRate === null ? null : positive(row.automationRate),
  };
  if (
    result.paidCount > result.totalQueue ||
    result.reconciledCount > result.totalQueue ||
    (result.automationRate !== null && result.automationRate > 100) ||
    (result.totalQueue === 0) !== (result.automationRate === null)
  )
    return invalid();
  return result;
}
function source(value: unknown): SourceState {
  const row = object(value);
  if (row.status !== "ok" && row.status !== "error") return invalid();
  return {
    status: row.status,
    ...(row.message === undefined ? {} : { message: str(row.message) }),
  };
}
function list<T>(value: unknown, parse: (value: unknown) => T): T[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return invalid();
  const result = value.map(parse);
  return result;
}
export function parseDashboard(value: unknown): DashboardResponse {
  const data = object(value);
  const sources = object(data.sources);
  if (data.mode !== "demo" && data.mode !== "live") return invalid();
  const result: DashboardResponse = {
    mode: data.mode,
    generatedAt: timestamp(data.generatedAt),
    metrics: data.metrics === null ? null : metrics(data.metrics),
    approvals: list(data.approvals, account),
    failures: list(data.failures, account),
    executions: list(data.executions, parseExecution),
    sources: { database: source(sources.database), n8n: source(sources.n8n) },
  };
  const dbAvailable = result.sources.database.status === "ok";
  if (
    dbAvailable
      ? result.metrics === null || result.approvals === null || result.failures === null
      : result.metrics !== null || result.approvals !== null || result.failures !== null
  )
    return invalid();
  if ((result.sources.n8n.status === "ok") !== (result.executions !== null)) return invalid();
  return result;
}
export class MockDashboardService implements DashboardService {
  async getDashboard(signal?: AbortSignal): Promise<DashboardResponse> {
    signal?.throwIfAborted();
    return parseDashboard(makeDemoDashboard());
  }
}
export class HttpDashboardService implements DashboardService {
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly baseUrl = "",
    fetcher: typeof fetch = fetch,
  ) {
    this.fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
      Reflect.apply(fetcher, globalThis, [input, init]);
  }
  async getDashboard(signal?: AbortSignal): Promise<DashboardResponse> {
    const timeout = AbortSignal.timeout(20000);
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, "")}/api/accounts-payable/dashboard`,
      {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Acesso não autorizado. Verifique sua sessão e a configuração de acesso à API."
          : await readApiError(response, "Não foi possível consultar o painel"),
      );
    const data = parseDashboard(await response.json());
    if (data.mode !== "live")
      throw new Error(
        "O modo conectado recebeu uma resposta demonstrativa. Verifique a configuração da API.",
      );
    return data;
  }
}
import { resolveApiBaseUrl } from "./contracts";
import { readApiError } from "./api-errors";
export function createDashboardService(config: DashboardConfig): DashboardService {
  return config.mode === "demo"
    ? new MockDashboardService()
    : new HttpDashboardService(resolveApiBaseUrl(config.apiBaseUrl));
}
