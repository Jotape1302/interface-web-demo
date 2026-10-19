import type { AuditService } from "../audit.js";
import { actorHeaders, automationFetch, relayedError, upstreamDetail, withAutomationAuth } from "../automation-http.js";
import { logRequestError, parseJsonBody, type RequestContext, type Session } from "../http.js";

// Conciliação Mercado Livre × Contas a Receber Tiny: proxy para o motor financeiro (Python).
// Os dados vêm por API (vendas do Mercado Livre, liberações do Mercado Pago, pedidos e contas do
// Tiny); a rotina roda 1x/dia no Python e sob demanda por aqui. Execução e baixa são tarefas
// acompanhadas por /api/v1/conciliacao-ml/jobs/:id, que só enxerga as tarefas da conciliação ML
// (a conciliação Inter tem outra permissão — SEC-04).

const ID_PATTERN = "[A-Za-z0-9_-]{1,64}";

export function createMlReconciliationRoutes(deps: {
  audit?: AuditService;
  pythonApiUrl?: string;
  jobPollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const { audit } = deps;
  // Toda chamada ao motor financeiro leva a chave interna (contrato C1).
  const fetchImpl = deps.fetchImpl ? withAutomationAuth(deps.fetchImpl) : automationFetch;
  const candidateUrls = Array.from(
    new Set(
      [deps.pythonApiUrl, process.env.PYTHON_API_URL, "http://127.0.0.1:8000", "http://automacao-nfe:8000"]
        .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        .map((u) => u.trim().replace(/\/$/, "")),
    ),
  );
  let activePythonUrl = candidateUrls[0] || "http://127.0.0.1:8000";

  // Mesma descoberta de URL da conciliação Inter (local × container), com /health de 2s.
  async function resolvePythonUrl(): Promise<string> {
    for (const url of [activePythonUrl, ...candidateUrls.filter((u) => u !== activePythonUrl)]) {
      try {
        const res = await fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          activePythonUrl = url;
          return url;
        }
      } catch {
        // tenta a próxima
      }
    }
    return activePythonUrl;
  }

  const pollIntervalMs = deps.jobPollIntervalMs ?? 3000;
  const JOB_WATCH_LIMIT_MS = 60 * 60 * 1000;

  // Acompanha a tarefa até o fim para registrar o resultado na auditoria, mesmo que a tela feche.
  function watchJob(jobId: string, onDone: (job: any) => void) {
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      let job: any = null;
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await fetchImpl(`${baseUrl}/api/v1/conciliacao-ml/jobs/${encodeURIComponent(jobId)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404) job = { status: "erro", erro: "Tarefa perdida: a API foi reiniciada durante a execução." };
        else if (res.ok) job = await res.json();
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

  function auditBaixa(job: any, totalGrupos: number, actor: Session["user"] | null, ip: string) {
    const resultado = job.status === "concluido" ? job.resultado : null;
    void audit?.record({
      actor: actor ?? null,
      actorLabel: actor?.nome || "Usuário Financeiro",
      acao: "baixa_conciliacao_ml_executada",
      detalhes: {
        recebimentos: totalGrupos,
        sucessos: resultado?.total_sucessos ?? 0,
        falhas: resultado ? resultado.total_falhas : totalGrupos,
        ignorados: resultado?.total_ignorados ?? 0,
        ...(resultado ? {} : { erro: String(job.erro ?? "falha na tarefa de baixa") }),
      },
      sucesso: Boolean(resultado) && resultado.total_falhas === 0,
      ip,
    });
  }

  function auditExecucao(job: any, pedido: Record<string, unknown>, actor: Session["user"] | null, ip: string) {
    const resultado = job.status === "concluido" ? job.resultado : null;
    void audit?.record({
      actor: actor ?? null,
      actorLabel: actor?.nome || "Usuário Financeiro",
      acao: "conciliacao_ml_executada",
      detalhes: {
        ...pedido,
        status: resultado?.status ?? "erro",
        ...(resultado ? {} : { erro: String(job.erro ?? "falha na execução") }),
      },
      sucesso: resultado?.status === "ok",
      ip,
    });
  }

  async function proxyJson(ctx: RequestContext, pythonPath: string, init: RequestInit = {}, timeoutMs = 15000, asUser = false) {
    try {
      const baseUrl = await resolvePythonUrl();
      const headers = { ...((init.headers as Record<string, string>) ?? {}), ...actorHeaders(ctx, { asUser }) };
      const res = await fetchImpl(`${baseUrl}${pythonPath}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      const data = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        const { status, body } = relayedError(res.status, data, "Falha na API de conciliação", ctx.requestId);
        return { status, data: body as any };
      }
      return { status: res.status, data: data ?? { error: "Resposta inválida da API de conciliação" } };
    } catch (e) {
      logRequestError(ctx, e, "ml_reconciliation_upstream_error");
      return { status: 502, data: { error: "API de conciliação indisponível.", requestId: ctx.requestId } };
    }
  }

  async function readJson(ctx: RequestContext): Promise<{ ok: true; body: any } | { ok: false }> {
    try {
      return { ok: true, body: (await parseJsonBody(ctx.request)) ?? {} };
    } catch {
      return { ok: false };
    }
  }

  return async function handleMlReconciliation(ctx: RequestContext): Promise<boolean> {
    const { path, method, send, url } = ctx;
    if (!path.startsWith("/api/ml-reconciliation")) return false;
    const actor = ctx.session?.user ?? null;

    if (path === "/api/ml-reconciliation/status" && method === "GET") {
      const { status, data } = await proxyJson(ctx, "/api/v1/conciliacao-ml/status", {}, 15000);
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/tokens/sincronizar" && method === "POST") {
      let res: Response;
      let rawData: any;
      try {
        const baseUrl = await resolvePythonUrl();
        const headers = { "Content-Type": "application/json", ...actorHeaders(ctx, { asUser: true }) };
        res = await fetchImpl(`${baseUrl}/api/v1/conciliacao-ml/tokens/sincronizar`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(30000),
        });
        rawData = await res.json().catch(() => null);
      } catch (e) {
        logRequestError(ctx, e, "ml_reconciliation_upstream_error");
        return send(502, { error: "API de conciliação indisponível.", requestId: ctx.requestId });
      }

      if (!res.ok) {
        if (res.status === 429) {
          const detail = upstreamDetail(rawData) ?? "Muitas tentativas de sincronização. Tente novamente em instantes.";
          return send(429, { error: detail, detail });
        }
        if (res.status >= 500) {
          const erroId = rawData && typeof rawData === "object" ? rawData.erro_id : undefined;
          return send(502, {
            error: "Falha na sincronização de tokens de conciliação.",
            detail: "Falha na sincronização de tokens de conciliação.",
            ...(erroId ? { erro_id: erroId } : {}),
            ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          });
        }
        const { status, body } = relayedError(res.status, rawData, "Falha na sincronização de tokens", ctx.requestId);
        return send(status, body);
      }

      const sanitizedContas: Record<string, { conectado: boolean; renovado: boolean; motivo?: string }> = {};
      if (rawData?.contas && typeof rawData.contas === "object") {
        for (const [k, v] of Object.entries(rawData.contas as Record<string, any>)) {
          if (v && typeof v === "object") {
            sanitizedContas[k] = {
              conectado: Boolean(v.conectado),
              renovado: Boolean(v.renovado),
              ...(v.motivo ? { motivo: String(v.motivo) } : {}),
            };
          }
        }
      }

      const clientData = {
        ok: Boolean(rawData?.ok),
        ...(rawData?.mock ? { mock: true } : {}),
        contas: sanitizedContas,
        tokens_atualizados: Array.isArray(rawData?.tokens_atualizados) ? rawData.tokens_atualizados : [],
      };

      const auditContas: Record<string, { conectado: boolean; renovado: boolean }> = {};
      for (const [k, v] of Object.entries(sanitizedContas)) {
        auditContas[k] = { conectado: v.conectado, renovado: v.renovado };
      }

      void audit?.record({
        actor: actor ?? null,
        actorLabel: actor?.nome || "Usuário Financeiro",
        acao: "sincronizacao_tokens_ml_solicitada",
        detalhes: {
          ok: clientData.ok,
          tokens_atualizados: clientData.tokens_atualizados,
          contas: auditContas,
        },
        sucesso: Boolean(clientData.ok),
        ip: ctx.ip,
      });

      return send(200, clientData);
    }

    if (path === "/api/ml-reconciliation/executar" && method === "POST") {
      const lido = await readJson(ctx);
      if (!lido.ok) return send(400, { error: "JSON inválido" });
      const pedido = {
        empresas: Array.isArray(lido.body.empresas) ? lido.body.empresas : null,
        de: typeof lido.body.de === "string" ? lido.body.de : null,
        ate: typeof lido.body.ate === "string" ? lido.body.ate : null,
      };
      const { status, data } = await proxyJson(
        ctx,
        "/api/v1/conciliacao-ml/executar",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pedido) },
        15000,
        true,
      );
      if (status === 200 && typeof data?.job_id === "string") {
        watchJob(data.job_id, (job) => auditExecucao(job, pedido, actor, ctx.ip));
      }
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/execucoes" && method === "GET") {
      const { status, data } = await proxyJson(ctx, `/api/v1/conciliacao-ml/execucoes${url.search}`, {}, 15000);
      return send(status, data);
    }

    const execucaoMatch = new RegExp(`^/api/ml-reconciliation/execucoes/(${ID_PATTERN})$`).exec(path);
    if (execucaoMatch && method === "GET") {
      const { status, data } = await proxyJson(ctx, `/api/v1/conciliacao-ml/execucoes/${execucaoMatch[1]}`, {}, 15000);
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/jobs/baixar" && method === "POST") {
      const lido = await readJson(ctx);
      if (!lido.ok) return send(400, { error: "JSON inválido" });
      const grupos = Array.isArray(lido.body.grupos) ? lido.body.grupos.map(String) : [];
      const { status, data } = await proxyJson(
        ctx,
        "/api/v1/conciliacao-ml/jobs/baixar",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Autor: header X-Usuario (login da sessão). `usuario` no corpo só por compatibilidade.
          body: JSON.stringify({ analise_id: String(lido.body.analise_id ?? ""), grupos, usuario: actor?.nome ?? "" }),
        },
        15000,
        true,
      );
      if (status === 200 && typeof data?.job_id === "string") {
        watchJob(data.job_id, (job) => auditBaixa(job, grupos.length, actor, ctx.ip));
      }
      return send(status, data);
    }

    const jobMatch = new RegExp(`^/api/ml-reconciliation/jobs/(${ID_PATTERN})$`).exec(path);
    if (jobMatch && method === "GET") {
      const { status, data } = await proxyJson(ctx, `/api/v1/conciliacao-ml/jobs/${jobMatch[1]}`, {}, 10000);
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/analises" && method === "GET") {
      const { status, data } = await proxyJson(ctx, `/api/v1/conciliacao-ml/analises${url.search}`, {}, 15000);
      return send(status, data);
    }

    const analiseMatch = new RegExp(`^/api/ml-reconciliation/analises/(${ID_PATTERN})$`).exec(path);
    if (analiseMatch && method === "GET") {
      const { status, data } = await proxyJson(ctx, `/api/v1/conciliacao-ml/analises/${analiseMatch[1]}`, {}, 30000);
      return send(status, data);
    }

    const arquivoMatch = new RegExp(`^/api/ml-reconciliation/analises/(${ID_PATTERN})/arquivos/([a-z-]{1,32})$`).exec(path);
    if (arquivoMatch && method === "GET") {
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await fetchImpl(
          `${baseUrl}/api/v1/conciliacao-ml/analises/${arquivoMatch[1]}/arquivos/${arquivoMatch[2]}${
            url.searchParams.get("incluir_exportados") === "true" ? "?incluir_exportados=true" : ""
          }`,
          { headers: actorHeaders(ctx), signal: AbortSignal.timeout(60000) },
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as any;
          const relayed = relayedError(res.status, err, "Falha ao gerar a planilha", ctx.requestId);
          return send(relayed.status, relayed.body);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        ctx.response.statusCode = 200;
        ctx.response.setHeader("Content-Type", res.headers.get("content-type") || "application/octet-stream");
        const disposition = res.headers.get("content-disposition");
        if (disposition) ctx.response.setHeader("Content-Disposition", disposition);
        // Contagens do controle de exportação dos lançamentos (ML-5).
        const contagens = ["X-Lancamentos-Total", "X-Lancamentos-Ja-Exportados", "X-Lancamentos-Na-Planilha"];
        for (const nome of contagens) {
          const valor = res.headers.get(nome);
          if (valor && /^\d{1,7}$/.test(valor)) ctx.response.setHeader(nome, valor);
        }
        ctx.response.setHeader("Access-Control-Expose-Headers", ["Content-Disposition", ...contagens].join(", "));
        ctx.response.end(buffer);
        return true;
      } catch (e) {
        logRequestError(ctx, e, "ml_reconciliation_upstream_error");
        return send(502, { error: "API de conciliação indisponível.", requestId: ctx.requestId });
      }
    }

    return send(404, { error: "Endpoint da conciliação Mercado Livre não encontrado" });
  };
}
