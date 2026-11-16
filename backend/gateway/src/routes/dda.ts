import type { AuditAction, AuditService } from "../audit.js";
import {
  actorHeaders,
  automationFetch,
  callAutomation,
  createAutomationUrlResolver,
  financeiroCandidateUrls,
  relayedError,
  withAutomationAuth,
} from "../automation-http.js";
import { CircuitBreakerOpenError } from "../circuit-breaker.js";
import type { AutomationJob } from "../contracts.js";
import { asJsonObject, logRequestError, parseJsonBody, type JsonObject, type RequestContext, type Session } from "../http.js";

// Boletos do DDA (Polp) → contas a pagar do Tiny → pagamento agendado no Inter → baixa.
// Proxy para o motor financeiro (app/dda_pagamentos.py). A rotina roda sozinha no Python a cada
// DDA_INTERVALO_MINUTOS; aqui ficam a leitura do painel e as decisões manuais (escolher conta,
// criar conta, descartar, reabrir), todas registradas na auditoria.

const ID_PATTERN = "[A-Za-z0-9_-]{1,64}";
const CIRCUITO_ABERTO = "Automação de boletos DDA temporariamente indisponível: circuito aberto. Tente novamente em instantes.";
// "criar" no gateway = POST .../criar-conta no motor.
const ACOES = {
  vincular: "dda_conta_vinculada",
  criar: "dda_conta_criada",
  descartar: "dda_boleto_descartado",
  reabrir: "dda_boleto_reaberto",
} as const satisfies Record<string, AuditAction>;
type Acao = keyof typeof ACOES;

export function createDdaRoutes(deps: { audit?: AuditService; pythonApiUrl?: string; jobPollIntervalMs?: number; fetchImpl?: typeof fetch }) {
  const { audit } = deps;
  const rawFetch = deps.fetchImpl ? withAutomationAuth(deps.fetchImpl) : automationFetch;
  const resolvePythonUrl = createAutomationUrlResolver(financeiroCandidateUrls(deps.pythonApiUrl ?? process.env.PYTHON_API_URL), rawFetch);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    callAutomation("financeiro", () => rawFetch(input, init), { invalidate: resolvePythonUrl.invalidate })) as typeof fetch;
  const pollIntervalMs = deps.jobPollIntervalMs ?? 3000;
  const JOB_WATCH_LIMIT_MS = 30 * 60 * 1000;

  async function proxyJson(ctx: RequestContext, pythonPath: string, init: RequestInit = {}, timeoutMs = 15000) {
    try {
      const baseUrl = await resolvePythonUrl();
      const headers = { ...((init.headers as Record<string, string>) ?? {}), ...actorHeaders(ctx, { asUser: init.method === "POST" }) };
      const res = await fetchImpl(`${baseUrl}${pythonPath}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const { status, body } = relayedError(res.status, data, "Falha na automação de boletos DDA", ctx.requestId);
        return { status, data: body as unknown };
      }
      return { status: res.status, data: data ?? { error: "Resposta inválida da automação de boletos DDA" } };
    } catch (e) {
      if (e instanceof CircuitBreakerOpenError) return { status: 503, data: { error: CIRCUITO_ABERTO, requestId: ctx.requestId } as unknown };
      logRequestError(ctx, e, "dda_upstream_error");
      return { status: 502, data: { error: "Automação de boletos DDA indisponível.", requestId: ctx.requestId } as unknown };
    }
  }

  function watchJob(jobId: string, onDone: (job: AutomationJob) => void) {
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      let job: AutomationJob | null = null;
      try {
        const res = await fetchImpl(`${await resolvePythonUrl()}/api/v1/dda/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10000) });
        if (res.status === 404) job = { status: "erro", erro: "Tarefa perdida: a API foi reiniciada durante a execução." };
        else if (res.ok) job = (await res.json()) as AutomationJob;
      } catch {
        // rede instável: tenta no próximo ciclo
      }
      if (!job || job.status === "executando") {
        if (Date.now() - startedAt < JOB_WATCH_LIMIT_MS) {
          setTimeout(() => void tick(), pollIntervalMs).unref?.();
          return;
        }
        job = { status: "erro", erro: "Tempo máximo de acompanhamento da tarefa excedido." };
      }
      onDone(job);
    };
    setTimeout(() => void tick(), pollIntervalMs).unref?.();
  }

  function auditar(actor: Session["user"] | null, ip: string, acao: AuditAction, alvo: string | undefined, detalhes: JsonObject, sucesso: boolean) {
    void audit?.record({ actor, actorLabel: actor?.nome || "Usuário Financeiro", acao, alvo, detalhes, sucesso, ip });
  }

  return async function handleDda(ctx: RequestContext): Promise<boolean> {
    const { path, method, send } = ctx;
    if (!path.startsWith("/api/dda/")) return false;
    const actor = ctx.session?.user ?? null;

    if (method === "GET" && (path === "/api/dda/status" || path === "/api/dda/boletos" || path === "/api/dda/execucoes")) {
      const { status, data } = await proxyJson(ctx, path.replace("/api/dda/", "/api/v1/dda/"), {}, 15000);
      return send(status, data);
    }

    if (path === "/api/dda/executar" && method === "POST") {
      const { status, data } = await proxyJson(ctx, "/api/v1/dda/jobs/executar", { method: "POST" }, 15000);
      const jobId = asJsonObject(data).job_id;
      if (status === 200 && typeof jobId === "string") {
        watchJob(jobId, (job) => {
          const resultado = job.status === "concluido" ? asJsonObject(job.resultado) : null;
          const erros = Array.isArray(resultado?.erros) ? resultado.erros.map(String) : [];
          auditar(actor, ctx.ip, "dda_executado", undefined,
            resultado ? { erros } : { erro: String(job.erro ?? "falha na rodada") }, resultado !== null && erros.length === 0);
        });
      }
      return send(status, data);
    }

    if (path === "/api/dda/categorias" && method === "GET") {
      const empresa = ctx.url.searchParams.get("empresa") ?? "";
      if (!/^[a-z_]{1,40}$/.test(empresa)) return send(400, { error: "Empresa inválida." });
      const { status, data } = await proxyJson(ctx, `/api/v1/dda/categorias?empresa=${encodeURIComponent(empresa)}`, {}, 30000);
      return send(status, data);
    }

    // Validação humana dos casamentos automáticos (libera o agendamento no Inter).
    if (path === "/api/dda/validar" && method === "POST") {
      let corpo: JsonObject;
      try {
        corpo = asJsonObject(await parseJsonBody(ctx.request));
      } catch {
        return send(400, { error: "JSON inválido" });
      }
      const ids = Array.isArray(corpo.ids) ? corpo.ids.map(String).filter((id) => new RegExp(`^${ID_PATTERN}$`).test(id)) : [];
      if (ids.length === 0 || ids.length > 300) return send(400, { error: "Informe de 1 a 300 boletos." });
      const { status, data } = await proxyJson(ctx, "/api/v1/dda/boletos/validar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const resultado = asJsonObject(data);
      const validados = Array.isArray(resultado.validados) ? resultado.validados.length : 0;
      auditar(actor, ctx.ip, "dda_boletos_validados", undefined, { boletos: ids.length, validados }, status === 200);
      return send(status, data);
    }

    // Criação em lote das contas dos boletos sem conta: tarefa no motor (uma chamada ao Tiny por boleto).
    if (path === "/api/dda/criar-contas" && method === "POST") {
      let corpo: JsonObject;
      try {
        corpo = asJsonObject(await parseJsonBody(ctx.request));
      } catch {
        return send(400, { error: "JSON inválido" });
      }
      const itens = (Array.isArray(corpo.itens) ? corpo.itens : []).map((i) => {
        const o = asJsonObject(i);
        return { boleto_id: String(o.boleto_id ?? ""), categoria_id: Number(o.categoria_id), historico: String(o.historico ?? "").slice(0, 500) };
      });
      if (itens.length === 0 || itens.length > 200 || itens.some((i) => !new RegExp(`^${ID_PATTERN}$`).test(i.boleto_id) || !(i.categoria_id > 0))) {
        return send(400, { error: "Informe de 1 a 200 boletos, cada um com a categoria." });
      }
      const { status, data } = await proxyJson(ctx, "/api/v1/dda/jobs/criar-contas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens }),
      });
      const jobId = asJsonObject(data).job_id;
      if (status === 200 && typeof jobId === "string") {
        watchJob(jobId, (job) => {
          const r = job.status === "concluido" ? asJsonObject(job.resultado) : null;
          auditar(actor, ctx.ip, "dda_contas_criadas_lote", undefined,
            { boletos: itens.length, sucessos: Number(r?.total_sucessos ?? 0), falhas: r ? Number(r.total_falhas ?? 0) : itens.length,
              ...(r ? {} : { erro: String(job.erro ?? "falha na tarefa") }) },
            r !== null && Number(r.total_falhas ?? 0) === 0);
        });
      }
      return send(status, data);
    }

    const jobMatch = new RegExp(`^/api/dda/jobs/(${ID_PATTERN})$`).exec(path);
    if (jobMatch && method === "GET") {
      const { status, data } = await proxyJson(ctx, `/api/v1/dda/jobs/${jobMatch[1]}`, {}, 10000);
      return send(status, data);
    }

    const acaoMatch = new RegExp(`^/api/dda/boletos/(${ID_PATTERN})/(vincular|criar|descartar|reabrir)$`).exec(path);
    if (acaoMatch && method === "POST") {
      const [, boletoId, acaoBruta] = acaoMatch;
      const acao = acaoBruta as Acao;
      let corpo: JsonObject = {};
      if (acao !== "reabrir") {
        try {
          corpo = asJsonObject(await parseJsonBody(ctx.request));
        } catch {
          return send(400, { error: "JSON inválido" });
        }
      }
      const payload: JsonObject =
        acao === "vincular" ? { conta_id: Number(corpo.conta_id) }
        : acao === "criar" ? { categoria_id: Number(corpo.categoria_id), historico: String(corpo.historico ?? "").slice(0, 500) }
        : acao === "descartar" ? { motivo: String(corpo.motivo ?? "").slice(0, 300) }
        : {};
      const { status, data } = await proxyJson(
        ctx,
        `/api/v1/dda/boletos/${boletoId}/${acao === "criar" ? "criar-conta" : acao}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        // Criar conta procura o contato e faz o POST no Tiny (throttle por token).
        acao === "criar" || acao === "vincular" ? 60000 : 15000,
      );
      const ok = status >= 200 && status < 300;
      auditar(actor, ctx.ip, ACOES[acao], boletoId, { ...payload, ...(ok ? {} : { erro: String(asJsonObject(data).error ?? asJsonObject(data).detail ?? status) }) }, ok);
      return send(status, data);
    }

    return send(404, { error: "Endpoint da automação de boletos DDA não encontrado" });
  };
}
