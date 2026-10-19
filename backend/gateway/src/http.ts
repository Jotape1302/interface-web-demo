import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService, User } from "./auth.js";
import { PublicError } from "./errors.js";

export type Session = {
  user: User;
  /**
   * Permissões efetivas ("<aba>:<acao>"): admin = catálogo inteiro; demais = chaves concedidas do
   * catálogo (negado por padrão — ausência de linha = negado).
   */
  permissions: string[];
  /** Id público da sessão (o mesmo que o admin vê em /api/admin/sessions). */
  sessionId?: string;
};

/** Estado de uma requisição, repassado a cada módulo de rotas (routes/*). */
export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** Caminho já sem o prefixo /automacoes do NGINX. */
  path: string;
  method: string;
  ip: string;
  /** Identificador de correlação para rastreamento de requisições. */
  requestId?: string;
  /** Sinal abortado precocemente caso o cliente feche a conexão HTTP. */
  signal?: AbortSignal;
  /** Sessão já validada pela checagem de área (rotas de negócio); ausente no modo demo sem login. */
  session?: Session;
  /** Responde em JSON (se ainda não respondeu). Devolve true para `return send(...)` num RouteHandler. */
  send(status: number, body: unknown): true;
}

/**
 * Um módulo de rotas devolve true quando tratou a requisição (respondeu ou vai responder
 * de forma assíncrona) e false para o servidor seguir para o próximo módulo.
 */
export type RouteHandler = (ctx: RequestContext) => Promise<boolean>;

/** CORS (GW-14): só as origens de CORS_ORIGINS — sem curingas de IP privado ou domínio. */
export function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(origin);
}

/** Limite do corpo JSON (GW-06), contado em bytes. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const PARSED_BODY = Symbol("norvia.parsedJsonBody");

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  return mime === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mime);
}

/** Lê o corpo cru com teto em bytes; lança PublicError 413 ao passar do limite. */
export async function readBodyLimited(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Buffer> {
  const declared = Number(request.headers?.["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PublicError(413, `Corpo da requisição excede o limite de ${Math.round(maxBytes / 1024)} KB.`, "payload_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new PublicError(413, `Corpo da requisição excede o limite de ${Math.round(maxBytes / 1024)} KB.`, "payload_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseRaw<T>(raw: string): T {
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new PublicError(400, "JSON inválido na requisição.", "invalid_json");
  }
}

/**
 * Pré-leitura feita pelo servidor antes das rotas: aplica o limite de 1 MB, exige
 * Content-Type JSON quando há corpo (415) e valida o JSON (400). O resultado fica guardado na
 * requisição e `parseJsonBody` só o devolve.
 */
export async function preparseJsonBody(request: IncomingMessage): Promise<void> {
  const raw = (await readBodyLimited(request)).toString("utf-8");
  if (raw.trim() && !isJsonContentType(request.headers["content-type"])) {
    throw new PublicError(415, "Content-Type deve ser application/json.", "unsupported_media_type");
  }
  (request as any)[PARSED_BODY] = { value: parseRaw(raw) };
}

export async function parseJsonBody<T = any>(request: IncomingMessage): Promise<T> {
  const stash = (request as any)[PARSED_BODY] as { value: unknown } | undefined;
  if (stash) return stash.value as T;
  // Sem pré-leitura (handlers chamados direto em testes): mesmo limite de tamanho.
  const raw = (await readBodyLimited(request)).toString("utf-8");
  return parseRaw<T>(raw);
}

export function extractToken(request: IncomingMessage): string | null {
  const auth = request.headers.authorization;
  if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const sessionToken = request.headers["x-session-token"];
  if (sessionToken && typeof sessionToken === "string") {
    return sessionToken.trim() || null;
  }
  return null;
}

export function methodNotAllowed(ctx: RequestContext, allow: string): void {
  ctx.response.setHeader("Allow", allow);
  ctx.send(405, { error: "Método não permitido" });
}

/** Sessão válida da requisição, ou null depois de já ter respondido 401. */
export async function requireSession(ctx: RequestContext, auth: AuthService): Promise<Session | null> {
  // Já validada pela checagem central de acesso (server.ts): não relê o banco.
  if (ctx.session) return ctx.session;
  const token = extractToken(ctx.request);
  if (!token) {
    ctx.send(401, { error: "Não autenticado" });
    return null;
  }
  const session = await auth.validateSession(token);
  if (!session) {
    ctx.send(401, { error: "Sessão inválida ou expirada" });
    return null;
  }
  return session;
}

/** Mensagem do erro só quando ela foi feita para o usuário (PublicError); senão o fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof PublicError ? e.message : fallback;
}

/** Registra o detalhe do erro só no log, com o requestId para correlação. */
export function logRequestError(ctx: Pick<RequestContext, "requestId" | "path" | "method">, e: unknown, event = "request_error") {
  console.error(
    JSON.stringify({
      event,
      requestId: ctx.requestId,
      method: ctx.method,
      path: ctx.path,
      name: e instanceof Error ? e.name : typeof e,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      at: new Date().toISOString(),
    }),
  );
}

/**
 * Resposta de erro padrão (GW-09). PublicError → status e mensagem dela (mensagens de negócio
 * que o frontend mostra). Qualquer outro erro → 500 genérico + requestId; detalhe só no log.
 */
export function sendError(ctx: RequestContext, e: unknown, fallback = "Erro interno no servidor."): true {
  if (e instanceof PublicError) {
    if (e.status >= 500) logRequestError(ctx, e, "request_public_error");
    return ctx.send(e.status, {
      error: e.message,
      ...(e.code ? { code: e.code } : {}),
      ...(e.extra ?? {}),
      requestId: ctx.requestId,
    });
  }
  logRequestError(ctx, e);
  return ctx.send(500, { error: fallback, requestId: ctx.requestId });
}
