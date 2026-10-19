import {
  actorHeaders,
  automationFetch,
  createAutomationUrlResolver,
  upstreamError,
  type ActorContext,
} from "./automation-http.js";

/**
 * Contagem conferida → estoque do Tiny, pela API interna do serviço contagem-estoque (porta 8002,
 * com a chave interna). Quem fala com o Tiny é a automação; aqui só vai SKU + unidades contadas.
 * A automação lança só a entrada que falta (nunca tira estoque).
 */
export interface TinyAjuste {
  status: "lancado" | "sem_entrada";
  sku: string;
  id_produto: number;
  produto: string;
  deposito: string;
  saldo_anterior: number;
  contado: number;
  /** Número da contagem com 6 dígitos, como abre a observação no Tiny ("Auditoria ... lançamento 000001"). */
  auditoria: string;
  entrada: number;
  id_lancamento: number | null;
}

/** Consulta só de leitura para a conferência: nome do produto e saldo atual no Tiny. */
export interface TinyConsulta {
  sku: string;
  id_produto: number;
  produto: string;
  unidade: string;
  deposito: string | null;
  /** null quando o depósito é ambíguo (ver aviso). */
  saldo: number | null;
  aviso: string | null;
}

export interface StockTinyClient {
  consultar(sku: string, actor?: ActorContext): Promise<TinyConsulta>;
  ajustar(
    req: { registro_id: string; sku: string; quantidade: number; numero: number; criado_em: string },
    actor?: ActorContext,
  ): Promise<TinyAjuste>;
}

export function contagemCandidateUrls(preferred?: string): string[] {
  return Array.from(
    new Set(
      [preferred, process.env.CONTAGEM_API_URL, "http://contagem-estoque:8002", "http://127.0.0.1:8002"]
        .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        .map((u) => u.trim().replace(/\/$/, "")),
    ),
  );
}

export function createStockTinyClient(opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): StockTinyClient {
  const fetchImpl = opts.fetchImpl ?? automationFetch;
  const resolveUrl = createAutomationUrlResolver(contagemCandidateUrls(opts.baseUrl), fetchImpl);
  return {
    async consultar(sku, actor) {
      const base = await resolveUrl();
      const res = await fetchImpl(`${base}/api/v1/estoque/consultar?sku=${encodeURIComponent(sku)}`, {
        headers: actorHeaders(actor),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao consultar o Tiny");
      return (await res.json()) as TinyConsulta;
    },
    async ajustar(req, actor) {
      const base = await resolveUrl();
      const res = await fetchImpl(`${base}/api/v1/estoque/ajustar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...actorHeaders(actor, { asUser: true }) },
        body: JSON.stringify(req),
        // Busca do produto + estoque + entrada, com a pausa entre chamadas do Tiny.
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw await upstreamError(res, "Falha ao lançar no estoque");
      return (await res.json()) as TinyAjuste;
    },
  };
}
