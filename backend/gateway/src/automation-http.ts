import { UpstreamError } from "./errors.js";

/**
 * Chamadas HTTP do gateway às automações financeiro (porta 8000) e marketplace (8001).
 * Contrato C1 das correções de segurança de 2026-10-06:
 *
 * - TODA chamada leva `X-Internal-Key: <AUTOMATIONS_INTERNAL_KEY>` (inclusive /api/v1/health,
 *   que só devolve tiny_configured/nfe_provider com a chave). Sem chave a automação responde
 *   401; sem a variável no serviço, 503.
 * - Ações em nome do usuário levam `X-Usuario: <login da sessão>` (URL-encoded): a automação
 *   usa esse header como autor na auditoria e ignora o `usuario` do corpo.
 * - `X-Request-Id` vai junto quando existe, para correlacionar com o `erro_id` dos 500.
 *
 * Use `automationFetch` (ou `withAutomationAuth(fetchImpl)`) só para as automações — nunca
 * para URLs externas (Tiny, Inter, n8n), que não podem receber a chave interna.
 */

export const INTERNAL_KEY_HEADER = "X-Internal-Key";
export const USER_HEADER = "X-Usuario";

/** Lida a cada chamada (permite trocar em testes e não guarda cópia em módulo). */
export function automationsInternalKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTOMATIONS_INTERNAL_KEY?.trim() ?? "";
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k, String(v)]));
  return { ...(headers as Record<string, string>) };
}

/** Embrulha um fetch (o global ou um mock de teste) para sempre enviar a chave interna. */
export function withAutomationAuth(fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    const headers = headersToRecord(init.headers);
    const key = automationsInternalKey();
    if (key) headers[INTERNAL_KEY_HEADER] = key;
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

/** fetch para as automações, com a chave interna. Resolve `fetch` a cada chamada (mockável). */
export const automationFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
  withAutomationAuth(globalThis.fetch)(input, init)) as typeof fetch;

/** Autor e correlação de uma requisição do usuário, para repassar à automação. */
export interface ActorContext {
  session?: { user?: { username?: string } } | null;
  requestId?: string;
}

/** Login no header: só ASCII imprimível vai cru; o resto é URL-encoded (a automação faz unquote). */
export function encodeUserHeader(login: string): string {
  const clean = login.trim().slice(0, 120);
  return /^[\x21-\x7e]*$/.test(clean) && !clean.includes("%") ? clean : encodeURIComponent(clean);
}

/**
 * Headers de identidade/correlação: `X-Request-Id` sempre que houver, `X-Usuario` quando a
 * chamada é uma ação em nome do usuário (`asUser`).
 */
export function actorHeaders(ctx: ActorContext | undefined, opts: { asUser?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ctx?.requestId) headers["X-Request-Id"] = ctx.requestId;
  const login = ctx?.session?.user?.username;
  if (opts.asUser && login) headers[USER_HEADER] = encodeUserHeader(login);
  return headers;
}

/**
 * Status da automação → status para o navegador. 401/403 da automação significam chave
 * interna errada/ausente, não sessão do usuário: repassar 401 faria o frontend deslogar.
 */
export function clientStatusFor(upstreamStatus: number): number {
  if (upstreamStatus === 401 || upstreamStatus === 403) return 502;
  if (upstreamStatus >= 500) return 502;
  return upstreamStatus;
}

/** Mensagem legível do corpo de erro da automação ({detail} do FastAPI, {error}, ou texto). */
export function upstreamDetail(body: unknown): string | null {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const detail = b.detail ?? b.error ?? b.message;
    if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 1000);
    if (Array.isArray(detail) && detail.length > 0) {
      // Erro de validação do FastAPI (422): [{loc, msg, ...}]
      const msgs = detail
        .map((d) => (d && typeof d === "object" && typeof (d as any).msg === "string" ? (d as any).msg : null))
        .filter(Boolean);
      if (msgs.length) return msgs.join("; ").slice(0, 1000);
    }
  }
  return null;
}

/** Constrói o erro público a partir de uma resposta não-OK da automação. */
export async function upstreamError(res: Response, fallback: string): Promise<UpstreamError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const status = clientStatusFor(res.status);
  if (res.status === 401 || res.status === 403) {
    return new UpstreamError(status, `${fallback}: falha de autenticação entre o gateway e a automação.`, res.status);
  }
  const detail = upstreamDetail(body);
  return new UpstreamError(status, detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${res.status}).`, res.status);
}

/**
 * Corpo de erro para repassar ao navegador quando a automação respondeu não-OK: mantém a
 * mensagem de negócio (`detail`, lida pelo frontend) e o `erro_id` dos 500 para correlação.
 */
export function relayedError(
  upstreamStatus: number,
  data: unknown,
  fallback: string,
  requestId?: string,
): { status: number; body: Record<string, unknown> } {
  const status = clientStatusFor(upstreamStatus);
  const erroId = data && typeof data === "object" ? (data as Record<string, unknown>).erro_id : undefined;
  const message =
    upstreamStatus === 401 || upstreamStatus === 403
      ? `${fallback}: falha de autenticação entre o gateway e a automação.`
      : (upstreamDetail(data) ?? `${fallback} (HTTP ${upstreamStatus}).`);
  return {
    status,
    body: {
      error: message,
      detail: message,
      ...(typeof erroId === "string" ? { erro_id: erroId } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}

/**
 * Endereços possíveis do motor financeiro (automacao-nfe, porta 8000), na ordem de tentativa:
 * o preferido (parâmetro/DANFE_API_URL), o nome do container e os locais. Lista única usada
 * por danfe.ts, financial-dashboard.ts e index.ts para não divergirem.
 */
export function financeiroCandidateUrls(preferred?: string): string[] {
  return Array.from(
    new Set(
      [
        preferred,
        process.env.DANFE_API_URL,
        "http://automacao-nfe:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://host.docker.internal:8000",
      ]
        .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        .map((u) => u.trim().replace(/\/$/, "")),
    ),
  );
}

/**
 * Descobre qual candidato responde `/api/v1/health` (com a chave interna) e memoriza o que
 * funcionou; se nenhum responder, devolve o último que funcionou (ou o primeiro).
 */
export function createAutomationUrlResolver(candidates: string[], fetchImpl: typeof fetch = automationFetch) {
  let active = candidates[0] ?? "http://127.0.0.1:8000";
  return async function resolve(): Promise<string> {
    for (const url of [active, ...candidates.filter((u) => u !== active)]) {
      try {
        const res = await fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          active = url;
          return url;
        }
      } catch {
        // tenta o próximo
      }
    }
    return active;
  };
}
