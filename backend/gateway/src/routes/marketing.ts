import type { AuditAction, AuditService } from "../audit.js";
import { asJsonObject, logRequestError, parseJsonBody, type RequestContext } from "../http.js";
import { actorHeaders, automationFetch, relayedError, withAutomationAuth } from "../automation-http.js";
import { CircuitBreakerOpenError, getCircuitBreaker } from "../circuit-breaker.js";

/**
 * E-mail marketing (automacoes-marketing, porta 8004): repassa /api/marketing/* para /api/v1/*.
 * Permissões em permissions.ts (email_marketing:ver/gerar/aprovar). Quem gera/aprova vai no
 * X-Usuario (sessão), nunca no corpo. A geração do lote e a troca de produto respondem 202.
 */
export function marketingApiUrl(): string {
  return (process.env.MARKETING_API_URL || "http://automacoes-marketing:8004").trim().replace(/\/$/, "");
}

const LEITURAS = new Set(["status", "rascunhos", "produtos", "catalogo", "execucoes", "ambientes"]);
const LEITURAS_BINARIAS: ReadonlyArray<RegExp> = [
  /^rascunhos\/[A-Za-z0-9-]{1,64}\/carrossel\/([1-9]|1[0-9]|20)$/,
  /^rascunhos\/[A-Za-z0-9-]{1,64}\/carrossel\.zip$/,
  /^ambientes\/[A-Za-z0-9_-]{1,64}\.jpg$/,
];
const ACOES: ReadonlyArray<{ re: RegExp; acao: AuditAction }> = [
  { re: /^gerar-lote-semanal$/, acao: "marketing_lote_gerado" },
  { re: /^rascunhos\/[A-Za-z0-9-]{1,64}\/aprovar$/, acao: "marketing_rascunho_aprovado" },
  { re: /^rascunhos\/[A-Za-z0-9-]{1,64}\/produto$/, acao: "marketing_produto_alterado" },
  { re: /^ambientes\/gerar$/, acao: "marketing_ambientes_gerar" },
  { re: /^ambientes\/[A-Za-z0-9_-]{1,64}\/aprovar$/, acao: "marketing_ambiente_aprovado" },
  { re: /^ambientes\/[A-Za-z0-9_-]{1,64}\/recusar$/, acao: "marketing_ambiente_recusado" },
];

export function createMarketingRoutes(deps: { audit?: AuditService; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const { audit } = deps;
  const doFetch = deps.fetchImpl ? withAutomationAuth(deps.fetchImpl) : automationFetch;

  return async function handleMarketing(ctx: RequestContext): Promise<boolean> {
    const { path, method, send, url } = ctx;
    if (!path.startsWith("/api/marketing/")) return false;
    const resto = path.slice("/api/marketing/".length);
    const isLeituraJson = method === "GET" && LEITURAS.has(resto);
    const isLeituraBinaria = method === "GET" && LEITURAS_BINARIAS.some((re) => re.test(resto));
    const acao = method === "POST" ? ACOES.find((a) => a.re.test(resto)) : undefined;

    if (!isLeituraJson && !isLeituraBinaria && !acao) {
      return send(404, { error: "Rota de e-mail marketing não encontrada" });
    }

    const body = method === "POST" ? asJsonObject(await parseJsonBody(ctx.request)) : undefined;
    const base = deps.baseUrl ?? marketingApiUrl();
    const breaker = getCircuitBreaker("marketing");

    let res: Response;
    try {
      res = await breaker.execute(
        (signal) =>
          doFetch(`${base}/api/v1/${resto}${url.search}`, {
            method,
            headers: {
              ...(isLeituraBinaria ? {} : { "Content-Type": "application/json" }),
              Accept: isLeituraBinaria ? "*/*" : "application/json",
              ...actorHeaders(ctx, { asUser: method === "POST" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
          }),
        { clientSignal: ctx.signal, timeoutMs: 20_000 },
      );
    } catch (e) {
      if (e instanceof CircuitBreakerOpenError) {
        return send(503, { error: "Automação de e-mail marketing temporariamente indisponível: circuito aberto." });
      }
      // O navegador desistiu (trocou de página, recarregou): não há a quem responder (#20).
      if (ctx.signal?.aborted) return true;
      logRequestError(ctx, e, "marketing_upstream_error");
      return send(502, { error: "Automação de e-mail marketing indisponível.", requestId: ctx.requestId });
    }

    if (isLeituraBinaria) {
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const relayed = relayedError(res.status, errJson, "Arquivo do carrossel não encontrado");
        return send(relayed.status, { error: relayed.body.error });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      ctx.response.setHeader("Content-Type", res.headers.get("content-type") || "application/octet-stream");
      const disp = res.headers.get("content-disposition");
      if (disp) ctx.response.setHeader("Content-Disposition", disp);
      ctx.response.setHeader("Cache-Control", "private, max-age=3600");
      ctx.response.writeHead(res.status);
      ctx.response.end(buf);
      return true;
    }

    const data: unknown = await res.json().catch(() => null);

    if (acao && res.ok) {
      void audit?.record({
        actor: ctx.session?.user ?? null,
        actorLabel: ctx.session?.user?.nome || "Usuário Marketing",
        acao: acao.acao,
        alvo: resto.startsWith("rascunhos/") || resto.startsWith("ambientes/") ? resto.split("/")[1] : undefined,
        detalhes: body && Object.keys(body).length > 0 ? body : undefined,
        ip: ctx.ip,
      });
    }
    if (data === null) return send(res.ok ? 502 : res.status, { error: "Resposta inválida da automação de e-mail marketing" });
    if (!res.ok) {
      const relayed = relayedError(res.status, data, "Falha na automação de e-mail marketing");
      return send(relayed.status, { error: relayed.body.error });
    }
    return send(res.status, data);
  };
}
