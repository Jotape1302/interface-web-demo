import type { AuditService } from "../audit.js";
import {
  actorHeaders,
  automationFetch,
  callAutomation,
  createAutomationUrlResolver,
  financeiroCandidateUrls,
  relayedError,
  upstreamDetail,
  withAutomationAuth,
} from "../automation-http.js";
import { CircuitBreakerOpenError } from "../circuit-breaker.js";
import type { AutomationJob } from "../contracts.js";
import { asJsonObject, logRequestError, parseJsonBody, type RequestContext, type Session, type JsonObject } from "../http.js";

// Conciliação Mercado Livre × Contas a Receber Tiny: proxy para o motor financeiro (Python).
// Os dados vêm por API (vendas do Mercado Livre, liberações do Mercado Pago, pedidos e contas do
// Tiny); a rotina roda 1x/dia no Python e sob demanda por aqui. Execução e baixa são tarefas
// acompanhadas por /api/v1/conciliacao-ml/jobs/:id, que só enxerga as tarefas da conciliação ML
// (a conciliação Inter tem outra permissão — SEC-04).

const ID_PATTERN = "[A-Za-z0-9_-]{1,64}";
const CIRCUITO_ABERTO = "Conciliação temporariamente indisponível: circuito aberto. Tente novamente em instantes.";
const CONTAGENS_LANCAMENTOS = ["X-Lancamentos-Total", "X-Lancamentos-Ja-Exportados", "X-Lancamentos-Na-Planilha"];

export function createMlReconciliationRoutes(deps: {
  audit?: AuditService;
  pythonApiUrl?: string;
  jobPollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const { audit } = deps;
  // Toda chamada ao motor financeiro leva a chave interna (contrato C1).
  const rawFetch = deps.fetchImpl ? withAutomationAuth(deps.fetchImpl) : automationFetch;
  // URL do motor financeiro memorizada por 60 s (sem /health a cada chamada).
  const resolvePythonUrl = createAutomationUrlResolver(
    financeiroCandidateUrls(deps.pythonApiUrl ?? process.env.PYTHON_API_URL),
    rawFetch,
  );
  // Todas as chamadas passam pelo circuit breaker "financeiro" (4xx não conta como falha).
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    callAutomation("financeiro", () => rawFetch(input, init), { invalidate: resolvePythonUrl.invalidate })) as typeof fetch;

  const pollIntervalMs = deps.jobPollIntervalMs ?? 3000;
  // A execução com "Todas" passa de 1 h: o relatório do MP pode levar até 90 min por empresa
  // (ML_RECONCILIATION_RELATORIO_TIMEOUT_SECONDS). Com 60 min a auditoria gravava "Falha" com a
  // conciliação ainda rodando (05/11/2026).
  const JOB_WATCH_LIMIT_MS = 4 * 60 * 60 * 1000;

  // Acompanha a tarefa até o fim para registrar o resultado na auditoria, mesmo que a tela feche.
  function watchJob(jobId: string, onDone: (job: AutomationJob) => void) {
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      let job: AutomationJob | null = null;
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await fetchImpl(`${baseUrl}/api/v1/conciliacao-ml/jobs/${encodeURIComponent(jobId)}`, {
          signal: AbortSignal.timeout(10000),
        });
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

  function auditBaixa(job: AutomationJob, totalGrupos: number, actor: Session["user"] | null, ip: string) {
    const resultado = job.status === "concluido" ? asJsonObject(job.resultado) : null;
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
      sucesso: resultado !== null && resultado.total_falhas === 0,
      ip,
    });
  }

  function auditTarifas(job: AutomationJob, empresa: string, totalVendas: number, actor: Session["user"] | null, ip: string) {
    const resultado = job.status === "concluido" ? asJsonObject(job.resultado) : null;
    void audit?.record({
      actor: actor ?? null,
      actorLabel: actor?.nome || "Usuário Financeiro",
      acao: "conciliacao_ml_tarifas_lancadas",
      detalhes: {
        empresa,
        vendas: totalVendas,
        lancamentos: resultado?.total_lancamentos ?? 0,
        falhas: resultado ? resultado.total_falhas : totalVendas,
        ...(resultado ? {} : { erro: String(job.erro ?? "falha na tarefa de lançamento") }),
      },
      sucesso: resultado !== null && resultado.total_falhas === 0,
      ip,
    });
  }

  function auditExecucao(job: AutomationJob, pedido: Record<string, unknown>, actor: Session["user"] | null, ip: string) {
    const resultado = job.status === "concluido" ? asJsonObject(job.resultado) : null;
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

  async function proxyJson(
    ctx: RequestContext,
    pythonPath: string,
    init: RequestInit = {},
    timeoutMs = 15000,
    asUser = false,
  ): Promise<{ status: number; data: unknown }> {
    try {
      const baseUrl = await resolvePythonUrl();
      const headers = { ...((init.headers as Record<string, string>) ?? {}), ...actorHeaders(ctx, { asUser }) };
      const res = await fetchImpl(`${baseUrl}${pythonPath}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const { status, body } = relayedError(res.status, data, "Falha na API de conciliação", ctx.requestId);
        return { status, data: body };
      }
      return { status: res.status, data: data ?? { error: "Resposta inválida da API de conciliação" } };
    } catch (e) {
      if (e instanceof CircuitBreakerOpenError) return { status: 503, data: { error: CIRCUITO_ABERTO, requestId: ctx.requestId } };
      logRequestError(ctx, e, "ml_reconciliation_upstream_error");
      return { status: 502, data: { error: "API de conciliação indisponível.", requestId: ctx.requestId } };
    }
  }

  /** Repassa uma planilha xlsx do motor financeiro (binário + nome do arquivo + contagens). */
  async function relayPlanilha(
    ctx: RequestContext,
    pythonPath: string,
    init: RequestInit,
    onOk?: (res: Response) => void,
  ): Promise<boolean> {
    try {
      const baseUrl = await resolvePythonUrl();
      const res = await fetchImpl(`${baseUrl}${pythonPath}`, { ...init, signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        const err: unknown = await res.json().catch(() => null);
        const relayed = relayedError(res.status, err, "Falha ao gerar a planilha", ctx.requestId);
        return ctx.send(relayed.status, relayed.body);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      ctx.response.statusCode = 200;
      ctx.response.setHeader("Content-Type", res.headers.get("content-type") || "application/octet-stream");
      const disposition = res.headers.get("content-disposition");
      if (disposition) ctx.response.setHeader("Content-Disposition", disposition);
      // Contagens do controle de exportação dos lançamentos (ML-5).
      for (const nome of CONTAGENS_LANCAMENTOS) {
        const valor = res.headers.get(nome);
        if (valor && /^\d{1,7}$/.test(valor)) ctx.response.setHeader(nome, valor);
      }
      ctx.response.setHeader("Access-Control-Expose-Headers", ["Content-Disposition", ...CONTAGENS_LANCAMENTOS].join(", "));
      ctx.response.end(buffer);
      onOk?.(res);
      return true;
    } catch (e) {
      if (e instanceof CircuitBreakerOpenError) return ctx.send(503, { error: CIRCUITO_ABERTO, requestId: ctx.requestId });
      logRequestError(ctx, e, "ml_reconciliation_upstream_error");
      return ctx.send(502, { error: "API de conciliação indisponível.", requestId: ctx.requestId });
    }
  }

  async function readJson(ctx: RequestContext): Promise<{ ok: true; body: JsonObject } | { ok: false }> {
    try {
      return { ok: true, body: asJsonObject(await parseJsonBody(ctx.request)) };
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
      let rawData: unknown;
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
        if (e instanceof CircuitBreakerOpenError) return send(503, { error: CIRCUITO_ABERTO, requestId: ctx.requestId });
        logRequestError(ctx, e, "ml_reconciliation_upstream_error");
        return send(502, { error: "API de conciliação indisponível.", requestId: ctx.requestId });
      }

      if (!res.ok) {
        if (res.status === 429) {
          const detail = upstreamDetail(rawData) ?? "Muitas tentativas de sincronização. Tente novamente em instantes.";
          return send(429, { error: detail, detail });
        }
        if (res.status >= 500) {
          const erroId = asJsonObject(rawData).erro_id;
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
      const resposta = asJsonObject(rawData);
      if (resposta.contas && typeof resposta.contas === "object") {
        for (const [k, conta] of Object.entries(resposta.contas as JsonObject)) {
          if (conta && typeof conta === "object") {
            const v = conta as JsonObject;
            sanitizedContas[k] = {
              conectado: Boolean(v.conectado),
              renovado: Boolean(v.renovado),
              ...(v.motivo ? { motivo: String(v.motivo) } : {}),
            };
          }
        }
      }

      const clientData = {
        ok: Boolean(resposta.ok),
        ...(resposta.mock ? { mock: true } : {}),
        contas: sanitizedContas,
        tokens_atualizados: Array.isArray(resposta.tokens_atualizados) ? resposta.tokens_atualizados : [],
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
      const jobId = asJsonObject(data).job_id;
      if (status === 200 && typeof jobId === "string") {
        watchJob(jobId, (job) => auditExecucao(job, pedido, actor, ctx.ip));
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
      const jobId = asJsonObject(data).job_id;
      if (status === 200 && typeof jobId === "string") {
        watchJob(jobId, (job) => auditBaixa(job, grupos.length, actor, ctx.ip));
      }
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/tarifas" && method === "GET") {
      const empresa = url.searchParams.get("empresa") ?? "";
      if (!new RegExp(`^${ID_PATTERN}$`).test(empresa)) return send(400, { error: "Empresa inválida" });
      const qs = new URLSearchParams({ empresa, incluir_exportados: String(url.searchParams.get("incluir_exportados") === "true") });
      const { status, data } = await proxyJson(ctx, `/api/v1/conciliacao-ml/tarifas?${qs}`, {}, 30000);
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/tarifas/conferir-apagados" && method === "POST") {
      const lido = await readJson(ctx);
      if (!lido.ok) return send(400, { error: "JSON inválido" });
      const empresa = String(lido.body.empresa ?? "");
      if (!new RegExp(`^${ID_PATTERN}$`).test(empresa)) return send(400, { error: "Empresa inválida" });
      const { status, data } = await proxyJson(
        ctx,
        "/api/v1/conciliacao-ml/tarifas/conferir-apagados",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ empresa }) },
        180000,
        true,
      );
      if (status === 200) {
        const r = asJsonObject(data);
        void audit?.record({
          actor: actor ?? null,
          actorLabel: actor?.nome || "Usuário Financeiro",
          acao: "conciliacao_ml_tarifas_conferidas",
          detalhes: { empresa, conferidos: r.conferidos ?? 0, liberados: r.liberados ?? 0, nao_conferidos: r.nao_conferidos ?? 0 },
          sucesso: true,
          ip: ctx.ip,
        });
      }
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/tarifas/marcar-refeitos" && method === "POST") {
      const lido = await readJson(ctx);
      if (!lido.ok) return send(400, { error: "JSON inválido" });
      const empresa = String(lido.body.empresa ?? "");
      if (!new RegExp(`^${ID_PATTERN}$`).test(empresa)) return send(400, { error: "Empresa inválida" });
      const chaves = Array.isArray(lido.body.chaves) ? lido.body.chaves.map(String).slice(0, 1000) : [];
      if (chaves.length === 0) return send(400, { error: "Nenhum lançamento selecionado" });
      const { status, data } = await proxyJson(
        ctx,
        "/api/v1/conciliacao-ml/tarifas/marcar-refeitos",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ empresa, chaves, usuario: actor?.nome ?? "" }),
        },
        15000,
        true,
      );
      if (status === 200) {
        const r = asJsonObject(data);
        void audit?.record({
          actor: actor ?? null,
          actorLabel: actor?.nome || "Usuário Financeiro",
          acao: "conciliacao_ml_tarifas_refeitas_manual",
          alvo: `Conciliação ML · ${empresa}`,
          detalhes: { empresa, marcados: r.marcados ?? 0, ignorados: r.ignorados ?? 0 },
          sucesso: true,
          ip: ctx.ip,
        });
      }
      return send(status, data);
    }

    if (path === "/api/ml-reconciliation/jobs/lancar-tarifas" && method === "POST") {
      const lido = await readJson(ctx);
      if (!lido.ok) return send(400, { error: "JSON inválido" });
      const empresa = String(lido.body.empresa ?? "");
      const grupos = Array.isArray(lido.body.grupos) ? lido.body.grupos.map(String) : [];
      const { status, data } = await proxyJson(
        ctx,
        "/api/v1/conciliacao-ml/jobs/lancar-tarifas",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ empresa, grupos, incluir_exportados: lido.body.incluir_exportados === true, usuario: actor?.nome ?? "" }),
        },
        15000,
        true,
      );
      const jobId = asJsonObject(data).job_id;
      if (status === 200 && typeof jobId === "string") {
        watchJob(jobId, (job) => auditTarifas(job, empresa, grupos.length, actor, ctx.ip));
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
      // SEC-06: a planilha de lançamentos marca os itens como exportados, então não sai por GET.
      if (arquivoMatch[2] === "lancamentos") {
        ctx.response.setHeader("Allow", "POST");
        return send(405, { error: "A planilha de lançamentos é gerada por POST .../arquivos/lancamentos/exportar." });
      }
      return relayPlanilha(ctx, `/api/v1/conciliacao-ml/analises/${arquivoMatch[1]}/arquivos/${arquivoMatch[2]}`, {
        headers: actorHeaders(ctx),
      });
    }

    const exportarMatch = new RegExp(`^/api/ml-reconciliation/analises/(${ID_PATTERN})/arquivos/lancamentos/exportar$`).exec(path);
    if (exportarMatch && method === "POST") {
      const lido = await readJson(ctx);
      if (!lido.ok) return send(400, { error: "JSON inválido" });
      const incluirExportados = lido.body.incluir_exportados === true;
      return relayPlanilha(
        ctx,
        `/api/v1/conciliacao-ml/analises/${exportarMatch[1]}/arquivos/lancamentos/exportar`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...actorHeaders(ctx, { asUser: true }) },
          body: JSON.stringify({ incluir_exportados: incluirExportados }),
        },
        (res) => {
          const num = (n: string) => {
            const v = res.headers.get(n);
            return v && /^\d{1,7}$/.test(v) ? Number(v) : null;
          };
          void audit?.record({
            actor,
            actorLabel: actor?.nome || "Usuário Financeiro",
            acao: "conciliacao_ml_lancamentos_exportados",
            alvo: exportarMatch[1],
            detalhes: {
              analise_id: exportarMatch[1],
              incluir_exportados: incluirExportados,
              na_planilha: num("X-Lancamentos-Na-Planilha"),
              total: num("X-Lancamentos-Total"),
              ja_exportados: num("X-Lancamentos-Ja-Exportados"),
            },
            sucesso: true,
            ip: ctx.ip,
          });
        },
      );
    }

    return send(404, { error: "Endpoint da conciliação Mercado Livre não encontrado" });
  };
}
