import { parseTrustedProxies } from "./client-ip.js";
export interface Config {
  mode: "demo" | "live";
  host: string;
  port: number;
  origins: string[];
  timeoutMs: number;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: boolean;
  };
  n8n: {
    baseUrl: string;
    apiKey: string;
    workflowId: string;
    workflowIds: string[];
    tokenWorkflowId?: string;
  };
  internalApiKey?: string;
  /** IPs/CIDRs cujos X-Forwarded-For/X-Real-IP são aceitos (GW-04). */
  trustedProxies: string[];
}
// ID real do workflow n8n de renovação de tokens OAuth. Um "l" minúsculo foi digitado no
// lugar de um "I" maiúsculo em configurações antigas (visualmente idênticos em muitas fontes);
// normalizeTokenWorkflowId corrige isso em um único lugar em vez de duplicar o patch em cada
// ponto que recebe um workflowId (config, endpoints administrativos, etc).
export const DEFAULT_TOKEN_WORKFLOW_ID = "8AtrRCYPsIyFv6s6";
const KNOWN_TYPO_TOKEN_WORKFLOW_ID = "8AtrRCYPslyFv6s6";
export function normalizeTokenWorkflowId(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_TOKEN_WORKFLOW_ID;
  return trimmed === KNOWN_TYPO_TOKEN_WORKFLOW_ID ? DEFAULT_TOKEN_WORKFLOW_ID : trimmed;
}
function normalizeN8nBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname
      .replace(/\/home(\/workflows)?\/?$/, "")
      .replace(/\/workflows\/?$/, "")
      .replace(/\/api\/v1\/?$/, "")
      .replace(/\/$/, "");
    return url.origin + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return trimmed;
  }
}
function integer(value: string | undefined, fallback: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error("Configuração numérica inválida");
  return n;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // SEC-01: sem DATA_MODE o padrão é demo (dev local). Na imagem Docker (NODE_ENV=production)
  // isso seria fail-open — demo libera rotas sem login —, então lá a variável é obrigatória.
  if (!env.DATA_MODE?.trim() && env.NODE_ENV === "production")
    throw new Error("DATA_MODE obrigatório com NODE_ENV=production (use DATA_MODE=live no servidor).");
  const mode = env.DATA_MODE?.trim() || "demo";
  if (mode !== "demo" && mode !== "live") throw new Error("DATA_MODE deve ser demo ou live");
  const origins = (env.CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  for (const origin of origins)
    if (new URL(origin).origin !== origin || !/^https?:/.test(origin))
      throw new Error("Origem CORS inválida");
  if (env.DB_SSL && !["true", "false"].includes(env.DB_SSL))
    throw new Error("DB_SSL deve ser true ou false");
  const config: Config = {
    mode,
    host: env.HOST ?? "127.0.0.1",
    port: integer(env.PORT, 3100, 65535),
    origins,
    timeoutMs: integer(env.SOURCE_TIMEOUT_MS, 8000, 30000),
    database: {
      host: env.DB_HOST ?? "",
      port: integer(env.DB_PORT, 3306, 65535),
      user: env.DB_USER ?? "",
      password: env.DB_PASSWORD ?? "",
      database: env.DB_NAME ?? "financeiro",
      ssl: env.DB_SSL === "true",
    },
    n8n: {
      baseUrl: normalizeN8nBaseUrl(env.N8N_BASE_URL),
      apiKey: env.N8N_API_KEY ?? "",
      workflowId: (env.N8N_WORKFLOW_IDS ?? env.N8N_WORKFLOW_ID ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)[0] ?? "",
      workflowIds: (env.N8N_WORKFLOW_IDS ?? env.N8N_WORKFLOW_ID ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      tokenWorkflowId: normalizeTokenWorkflowId(env.N8N_TOKEN_WORKFLOW_ID),
    },
    internalApiKey: env.INTERNAL_API_KEY?.trim() || undefined,
    trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES),
  };
  const automationsKey = env.AUTOMATIONS_INTERNAL_KEY?.trim() ?? "";
  if (automationsKey && automationsKey.length < 32)
    throw new Error("AUTOMATIONS_INTERNAL_KEY deve ter no mínimo 32 caracteres");
  if (mode === "live") {
    // ADMIN_BOOTSTRAP_PASSWORD não é mais obrigatória: só é usada no seed do admin inicial
    // (tabela usuarios vazia) e pode sair do .env depois do primeiro boot.
    for (const key of ["DB_HOST", "DB_USER", "DB_PASSWORD"])
      if (!env[key]?.trim()) throw new Error(`Configuração obrigatória ausente: ${key}`);
    if (!automationsKey)
      console.warn(
        JSON.stringify({
          event: "automations_internal_key_missing",
          message:
            "AUTOMATIONS_INTERNAL_KEY não definida: as automações financeiro/marketplace vão recusar as chamadas do gateway (401/503).",
        }),
      );

    if (config.n8n.baseUrl) {
      const url = new URL(config.n8n.baseUrl);
      const isLocalOrInternal =
        ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
        url.hostname.endsWith(".internal") ||
        url.hostname.endsWith(".local") ||
        !url.hostname.includes(".") ||
        /^10\./.test(url.hostname) ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(url.hostname) ||
        /^192\.168\./.test(url.hostname);
      if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalOrInternal)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "N8N_BASE_URL deve usar HTTPS (ou HTTP em localhost/rede interna) sem credenciais, query ou fragmento",
        );
    }
  }
  return config;
}
