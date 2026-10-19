import { actorHeaders, automationFetch, relayedError } from "../automation-http.js";
import type { Config } from "../config.js";
import type { AuditService } from "../audit.js";
import { parseJsonBody, sendError, type RequestContext, type Session } from "../http.js";
import {
  parseBaixaHistoricoQuery,
  type BaixaRequestItem,
  type BaixaResultItem,
  type ReconciliationHistoryService,
} from "../reconciliation-history.js";

export function createReconciliationRoutes(deps: {
  config: Config;
  audit?: AuditService;
  history?: ReconciliationHistoryService;
  pythonApiUrl?: string;
  jobPollIntervalMs?: number;
}) {
  const { config, audit } = deps;
  const candidateUrls = Array.from(
    new Set(
      [
        deps.pythonApiUrl,
        process.env.PYTHON_API_URL,
        "http://127.0.0.1:8000",
        "http://automacao-nfe:8000",
      ]
        .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        .map((u) => u.trim().replace(/\/$/, "")),
    ),
  );
  let activePythonUrl = candidateUrls[0] || "http://127.0.0.1:8000";

  async function resolvePythonUrl(): Promise<string> {
    try {
      const res = await automationFetch(`${activePythonUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return activePythonUrl;
    } catch {
      // url ativa falhou
    }
    for (const url of candidateUrls) {
      if (url === activePythonUrl) continue;
      try {
        const res = await automationFetch(`${url}/api/v1/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          activePythonUrl = url;
          return activePythonUrl;
        }
      } catch {
        // continua tentando outros
      }
    }
    return activePythonUrl;
  }

  const pollIntervalMs = deps.jobPollIntervalMs ?? 3000;
  const JOB_WATCH_LIMIT_MS = 30 * 60 * 1000;

  // Acompanha uma tarefa de baixa até o fim e grava o histórico/auditoria. Roda no gateway
  // (e não a partir do navegador) para o registro não depender de a tela continuar aberta.
  // As contas entram no histórico como `pendente` já no início (lote = id da tarefa); se o
  // gateway reiniciar no meio (ex.: deploy), `resumePendingBaixas` retoma o acompanhamento.
  async function watchBaixaJob(
    jobId: string,
    itens: BaixaRequestItem[] | null,
    actor: Session["user"] | null,
    ip: string,
  ) {
    const pendente =
      itens === null
        ? true
        : ((await deps.history?.recordPending({
            loteId: jobId,
            usuarioId: actor?.id ?? null,
            usuarioNome: actor?.nome ?? null,
            itens,
          })) ?? false);
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      let job: any = null;
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/jobs/${encodeURIComponent(jobId)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404) {
          job = { status: "erro", erro: "Tarefa perdida: a API de conciliação foi reiniciada durante a baixa." };
        } else if (res.ok) {
          job = await res.json();
        }
      } catch {
        // rede instável: tenta de novo no próximo ciclo
      }

      if (!job || job.status === "executando") {
        if (Date.now() - startedAt < JOB_WATCH_LIMIT_MS) {
          setTimeout(() => void tick(), pollIntervalMs).unref?.();
          return;
        }
        job = { status: "erro", erro: "Tempo máximo de acompanhamento da baixa excedido." };
      }

      const concluido = job.status === "concluido" && Array.isArray(job.resultado?.resultados);
      const resultados: BaixaResultItem[] = concluido ? job.resultado.resultados : [];
      const erroGeral = concluido ? null : (job.erro ?? "falha na tarefa de baixa");
      if (pendente) {
        await deps.history?.completeBatch({ loteId: jobId, resultados, erroGeral });
      } else if (itens) {
        await deps.history?.recordBatch({
          usuarioId: actor?.id ?? null,
          usuarioNome: actor?.nome ?? null,
          itens,
          resultados: concluido
            ? resultados
            : itens.map((item) => ({
                conta_pagar_id: item.conta_pagar_id,
                empresa: item.empresa,
                status: "erro",
                mensagem: `Situação desconhecida, confira no Tiny: ${erroGeral}`,
              })),
        });
      }
      const total = itens?.length ?? resultados.length;
      void audit?.record({
        actor: actor ?? null,
        actorLabel: actor?.nome || "Usuário Financeiro",
        acao: "baixa_conciliacao_executada",
        detalhes: {
          totalContas: total,
          sucessos: job.resultado?.total_sucessos ?? 0,
          falhas: job.resultado?.total_falhas ?? total,
          ...(itens === null ? { retomada: true } : {}),
        },
        ip,
      });
    };
    setTimeout(() => void tick(), pollIntervalMs).unref?.();
  }

  // Lotes que ficaram `pendente` porque o gateway reiniciou durante a baixa.
  void deps.history
    ?.pendingLotes()
    .then((lotes) => {
      for (const loteId of lotes) void watchBaixaJob(loteId, null, null, "");
    })
    .catch(() => undefined);

  return async function handleReconciliation(ctx: RequestContext): Promise<boolean> {
    const { path, method, send } = ctx;
    if (!path.startsWith("/api/reconciliation")) return false;

    // 1. Status das integrações
    if (path === "/api/reconciliation/status" && method === "GET") {
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/status`, {
          headers: actorHeaders(ctx),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          return send(200, await res.json());
        }
      } catch {
        // Fallback demo caso Python esteja temporariamente indisponível
      }

      return send(200, {
        status: "ok",
        timestamp: new Date().toISOString(),
        empresas: [
          { id: "fabrilux", nome: "Fabrilux", cnpj: "43820617000166", inter_configurado: true, tiny_configurado: true },
          { id: "revesta", nome: "Revesta", cnpj: "36592814000100", inter_configurado: true, tiny_configurado: true },
          { id: "norvia_campinas", nome: "Norvia Campinas", cnpj: "27184930000107", inter_configurado: true, tiny_configurado: true },
          { id: "norvia_curitiba", nome: "Norvia Curitiba", cnpj: "27184930000280", inter_configurado: true, tiny_configurado: true },
        ],
      });
    }

    // 1b. Estado persistente das pendências
    if (path === "/api/reconciliation/estado" && method === "GET") {
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/estado`, {
          headers: actorHeaders(ctx),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          return send(200, await res.json());
        }
      } catch {
        // Fallback demo/seguro se indisponível
      }

      return send(200, {
        status: "vazio",
        atualizado_em: null,
        data_inicio: null,
        data_fim: null,
        summary: {
          total_casados: 0,
          valor_total_casados: 0,
          total_inter_sem_par: 0,
          valor_inter_sem_par: 0,
          total_tiny_sem_par: 0,
          valor_tiny_sem_par: 0,
          total_ja_baixadas: 0,
          valor_ja_baixadas: 0,
          total_transferencias_internas: 0,
          valor_transferencias_internas: 0,
          total_transferencias_aptas: 0,
          valor_transferencias_aptas: 0,
        },
        matches: [],
        unmatched_inter: [],
        unmatched_tiny: [],
        ja_baixadas: [],
        transferencias_internas: [],
        avisos: [],
      });
    }

    // Repassa a resposta da automação: sucesso como veio; erro com status mapeado (401/403
    // da automação = chave interna, nunca sessão do usuário) e a mensagem de negócio em `detail`.
    const relay = (res: Response, data: unknown, fallback: string) => {
      if (res.ok) return send(res.status, data ?? { error: "Resposta inválida da API de conciliação" });
      const { status, body } = relayedError(res.status, data, fallback, ctx.requestId);
      return send(status, body);
    };

    // 2. Prévia / Cruzamento (Preview)
    if (path === "/api/reconciliation/preview" && method === "POST") {
      try {
        const body = await parseJsonBody(ctx.request);
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...actorHeaders(ctx, { asUser: true }) },
          body: JSON.stringify(body),
          // Por filial: extrato do Inter + 3 consultas paginadas no Tiny (aberto, atrasadas, pago).
          signal: AbortSignal.timeout(120000),
        });
        return relay(res, await res.json().catch(() => null), "Erro ao gerar prévia da conciliação");
      } catch (e) {
        return sendError(ctx, e, "Falha na conciliação.");
      }
    }

    // 3. Execução da Baixa (Baixar)
    if (path === "/api/reconciliation/baixar" && method === "POST") {
      try {
        const body = await parseJsonBody(ctx.request);
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/baixar`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...actorHeaders(ctx, { asUser: true }) },
          body: JSON.stringify(body),
          // Uma chamada ao Tiny por conta (mín. 0,5s entre chamadas, até 3 tentativas): um lote
          // grande passa de 1 min. Se este fetch fosse abortado, as baixas já feitas no Tiny
          // ficariam fora do histórico — o gateway segue até o fim mesmo se o navegador/NGINX desistir.
          signal: AbortSignal.timeout(600000),
        });
        const data = (await res.json().catch(() => null)) as any;
        if (!res.ok && res.status < 500) {
          // 409 = conta já em baixa noutro pedido; 400/422 = pedido inválido. Nada foi baixado.
          return relay(res, data, res.status === 409 ? "Baixa recusada" : "Falha ao executar baixa");
        }
        const itens: BaixaRequestItem[] = Array.isArray(body?.itens) ? body.itens : [];
        const resultados: BaixaResultItem[] = Array.isArray(data?.resultados) ? data.resultados : [];

        await deps.history?.recordBatch({
          usuarioId: ctx.session?.user?.id ?? null,
          usuarioNome: ctx.session?.user?.nome ?? null,
          itens,
          resultados,
        });

        void audit?.record({
          actor: ctx.session?.user ?? null,
          actorLabel: ctx.session?.user?.nome || "Usuário Financeiro",
          acao: "baixa_conciliacao_executada",
          detalhes: {
            totalContas: itens.length,
            sucessos: data?.total_sucessos || 0,
            falhas: data?.total_falhas || 0,
          },
          ip: ctx.ip,
        });

        // 5xx: a situação de cada conta é incerta — ficou registrada como erro no histórico acima.
        return relay(res, data, "Falha ao executar baixa");
      } catch (e) {
        return sendError(ctx, e, "Falha ao executar baixa.");
      }
    }

    // 4. Tarefas em segundo plano (prévia e baixa passam do timeout do NGINX)
    if ((path === "/api/reconciliation/jobs/preview" || path === "/api/reconciliation/jobs/baixar") && method === "POST") {
      const tipo = path.endsWith("/preview") ? "preview" : "baixar";
      try {
        const body = await parseJsonBody(ctx.request);
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/jobs/${tipo}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...actorHeaders(ctx, { asUser: true }) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        const data = (await res.json().catch(() => null)) as any;
        if (res.ok && tipo === "baixar" && typeof data?.job_id === "string") {
          const itens: BaixaRequestItem[] = Array.isArray(body?.itens) ? body.itens : [];
          void watchBaixaJob(data.job_id, itens, ctx.session?.user ?? null, ctx.ip);
        }
        if (res.status === 409 && tipo === "baixar") {
          // Outra tarefa já está baixando alguma destas contas: nada foi enviado ao Tiny.
          return relay(res, data, "Já existe uma baixa em andamento para estas contas. Aguarde terminar e compare de novo");
        }
        return relay(res, data, tipo === "baixar" ? "Falha ao iniciar a baixa" : "Falha ao iniciar a comparação");
      } catch (e) {
        return sendError(ctx, e, "Falha ao iniciar a tarefa.");
      }
    }

    const jobMatch = /^\/api\/reconciliation\/jobs\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (jobMatch && method === "GET") {
      try {
        const baseUrl = await resolvePythonUrl();
        const res = await automationFetch(`${baseUrl}/api/v1/reconciliacao/jobs/${jobMatch[1]}`, {
          headers: actorHeaders(ctx),
          signal: AbortSignal.timeout(10000),
        });
        return relay(res, await res.json().catch(() => null), "Falha ao consultar a tarefa");
      } catch (e) {
        return sendError(ctx, e, "API de conciliação indisponível.");
      }
    }

    // 5. Histórico de baixas executadas
    if (path === "/api/reconciliation/historico" && method === "GET") {
      if (!deps.history) {
        return send(200, { disponivel: false, itens: [], total: 0, page: 1, pageSize: 50 });
      }
      try {
        return send(200, await deps.history.list(parseBaixaHistoricoQuery(ctx.url.searchParams)));
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar histórico de baixas.");
      }
    }

    return send(404, { error: "Endpoint de conciliação não encontrado" });
  };
}
