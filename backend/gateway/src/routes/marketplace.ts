import type { AuditAction, AuditService } from "../audit.js";
import { logRequestError, parseJsonBody, type RequestContext } from "../http.js";
import { actorHeaders, automationFetch, relayedError, withAutomationAuth } from "../automation-http.js";
import { getCircuitBreaker, CircuitBreakerOpenError } from "../circuit-breaker.js";

/**
 * Automações de Marketplace: repassa /api/marketplace/{fretes|dimensoes}/* para a API Python
 * do serviço automacoes-marketplace (/api/v1/{fretes|dimensoes}/*) — Tipo de frete e
 * Padronização de dimensões. O login e a permissão (aba × ação) já foram checados pelo servidor
 * antes de chegar aqui (permissions.ts → ROUTE_RULES; POST/PUT fora da lista é recusado lá).
 */
export function marketplaceApiUrl(): string {
  return (process.env.MARKETPLACE_API_URL || "http://automacoes-marketplace:8001").trim().replace(/\/$/, "");
}

const AUTOMACOES = ["fretes", "dimensoes"] as const;

/** Ações feitas em nome do usuário: vão com X-Usuario (autor gravado pela automação). */
const ACOES_DO_USUARIO = [/^fretes\/retentar$/, /^fretes\/executar$/, /^dimensoes\/validar$/, /^dimensoes\/reenviar$/, /^dimensoes\/executar$/];

const ACOES_AUDITADAS: Array<{ re: RegExp; metodo: string; acao: AuditAction }> = [
  { re: /^fretes\/executar$/, metodo: "POST", acao: "fretes_verificacao_manual" },
  { re: /^fretes\/retentar$/, metodo: "POST", acao: "fretes_nova_tentativa" },
  { re: /^dimensoes\/validar$/, metodo: "POST", acao: "dimensoes_validadas" },
  { re: /^dimensoes\/reenviar$/, metodo: "POST", acao: "dimensoes_reenviadas" },
  { re: /^dimensoes\/executar$/, metodo: "POST", acao: "dimensoes_coleta_manual" },
];

export function createMarketplaceRoutes(deps: { audit?: AuditService; baseUrl?: string; fetchImpl?: typeof fetch }) {
  const { audit } = deps;
  // Toda chamada ao motor de marketplace leva a chave interna (contrato C1).
  const doFetch = deps.fetchImpl ? withAutomationAuth(deps.fetchImpl) : automationFetch;

  return async function handleMarketplace(ctx: RequestContext): Promise<boolean> {
    const { path, method, send, url } = ctx;
    const automacao = AUTOMACOES.find((a) => path === `/api/marketplace/${a}` || path.startsWith(`/api/marketplace/${a}/`));
    if (!automacao) return false;
    const resto = path.slice("/api/marketplace/".length);
    if (!/^[A-Za-z0-9_\-/]*$/.test(resto) || resto.includes("..")) {
      return send(400, { error: "Caminho inválido" });
    }
    // A automação não tem PUT: só GET (leitura) e POST (ações mapeadas em permissions.ts).
    if (!["GET", "POST"].includes(method)) return send(405, { error: "Método não permitido" });

    let body: any = undefined;
    if (method !== "GET") {
      body = await parseJsonBody(ctx.request);
      // Quem fez a alteração vai junto para o histórico da automação.
      if (body && typeof body === "object") body.usuario = ctx.session?.user?.nome ?? body.usuario ?? null;
    }

    const base = deps.baseUrl ?? marketplaceApiUrl();
    // Enviar ao ML faz PUT das medidas + troca de envio + releitura do anúncio.
    const timeoutMs = method === "GET" ? 20_000 : 90_000;
    const breaker = getCircuitBreaker("marketplace");

    let res: Response;
    try {
      res = await breaker.execute(
        (signal) =>
          doFetch(`${base}/api/v1/${resto}${url.search}`, {
            method,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...actorHeaders(ctx, { asUser: method !== "GET" && ACOES_DO_USUARIO.some((re) => re.test(resto)) }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
          }),
        { clientSignal: ctx.signal, timeoutMs },
      );
    } catch (e) {
      if (e instanceof CircuitBreakerOpenError) {
        return send(503, {
          error: "Automação de marketplace temporariamente indisponível: circuito aberto. Tente novamente em instantes.",
        });
      }
      logRequestError(ctx, e, "marketplace_upstream_error");
      return send(502, { error: "Automação de marketplace indisponível.", requestId: ctx.requestId });
    }
    const data = (await res.json().catch(() => null)) as any;

    const auditada = ACOES_AUDITADAS.find((a) => a.metodo === method && a.re.test(resto));
    if (auditada && res.ok) {
      void audit?.record({
        actor: ctx.session?.user ?? null,
        actorLabel: ctx.session?.user?.nome || "Usuário Marketplace",
        acao: auditada.acao,
        alvo: alvoAuditoria(body),
        detalhes: body && typeof body === "object" ? { ...body, usuario: undefined } : undefined,
        ip: ctx.ip,
      });
    }
    if (data === null) return send(res.ok ? 502 : res.status, { error: "Resposta inválida da automação de marketplace" });
    if (!res.ok) {
      const relayed = relayedError(res.status, data, "Falha na automação de marketplace");
      return send(relayed.status, { error: relayed.body.error, ...(relayed.body.erro_id ? { erro_id: relayed.body.erro_id } : {}) });
    }
    return send(res.status, data);
  };
}

/** SKUs (padronização) ou MLBs (nova tentativa de frete) da ação, para o Log de Auditoria. */
function alvoAuditoria(body: any): string | undefined {
  const ids: string[] = [
    ...(Array.isArray(body?.produtos) ? body.produtos.map((p: any) => p?.sku) : []),
    ...(Array.isArray(body?.skus) ? body.skus : []),
    ...(Array.isArray(body?.anuncios) ? body.anuncios.map((a: any) => a?.mlb) : []),
  ].filter(Boolean);
  if (ids.length === 0) return undefined;
  return ids.length > 5 ? `${ids.slice(0, 5).join(", ")} e mais ${ids.length - 5}` : ids.join(", ");
}
