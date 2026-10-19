import type { DanfeService } from "../danfe.js";
import type { AuditAction, AuditService } from "../audit.js";
import { parseJsonBody, sendError, type RequestContext } from "../http.js";
import { hasPermission } from "../permissions.js";

// Automação de DANFE/NF-e (/api/danfe/*). A permissão da rota já foi checada em server.ts.
export function createDanfeRoutes(deps: { danfe?: DanfeService; audit?: AuditService }) {
  const { danfe, audit } = deps;

  return async function handleDanfe(ctx: RequestContext): Promise<boolean> {
    const { path, method, url, request, response, send } = ctx;
    if (!path.startsWith("/api/danfe")) return false;
    const record = (acao: AuditAction, alvo?: string, detalhes?: Record<string, unknown>, sucesso = true) =>
      void audit?.record({
        actor: ctx.session?.user ?? null,
        actorLabel: "Modo demonstração",
        acao,
        alvo,
        detalhes,
        sucesso,
        ip: ctx.ip,
      });
    if (!danfe) return send(503, { error: "Serviço de automação DANFE não inicializado" });

    if (path === "/api/danfe/status" && method === "GET") {
      try {
        return send(200, await danfe.readStatus());
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar status da automação DANFE.");
      }
    }

    if (path === "/api/danfe/sefaz-status" && method === "GET") {
      try {
        return send(200, await danfe.readSefazStatus());
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar status da varredura SEFAZ.");
      }
    }

    if (path === "/api/danfe/scan-sefaz" && method === "POST") {
      try {
        // `force` ignora o cooldown da SEFAZ (risco de cStat 656): ação própria, concedível.
        const force = url.searchParams.get("force") === "true" || url.searchParams.get("force") === "1";
        if (force && !(ctx.session && hasPermission(ctx.session, "revisao_nfe:forcar_varredura"))) {
          return send(403, {
            error: "Você não tem permissão para forçar a varredura SEFAZ.",
            code: "forbidden",
            permission: "revisao_nfe:forcar_varredura",
          });
        }
        const result = await danfe.scanSefaz(ctx, { force });
        record("nfe_varredura_sefaz", undefined, force ? { forcado: true } : undefined);
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao executar a varredura SEFAZ.");
      }
    }

    if (path === "/api/danfe/import-key" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        if (!body.chave) return send(422, { error: "Campo 'chave' é obrigatório" });
        const result = await danfe.importKey(String(body.chave), ctx);
        record("nfe_importada_chave", `NF-e ${body.chave}`);
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao importar NF-e pela chave.");
      }
    }

    if (path === "/api/danfe/history" && method === "GET") {
      try {
        return send(200, await danfe.readHistory());
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar histórico de processamento.");
      }
    }

    if (path === "/api/danfe/tiny-categories" && method === "GET") {
      try {
        const cnpj = url.searchParams.get("cnpj") || undefined;
        return send(200, await danfe.getTinyCategories(cnpj));
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar categorias do Tiny ERP.");
      }
    }

    if (path === "/api/danfe/pending-review" && method === "GET") {
      try {
        return send(200, await danfe.getPendingReview());
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar notas aguardando revisão.");
      }
    }

    if (path === "/api/danfe/notas" && method === "GET") {
      const statusParam = url.searchParams.get("status");
      const status = statusParam === "confirmed" || statusParam === "archived" ? statusParam : "pending";
      try {
        return send(200, await danfe.getNotas(status));
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar notas.");
      }
    }

    if (path === "/api/danfe/archive" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        if (!body.chave) return send(422, { error: "Campo 'chave' é obrigatório" });
        const result = await danfe.archiveNota(String(body.chave), ctx);
        record("nfe_arquivada", `NF-e ${body.chave}`);
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao arquivar a nota.");
      }
    }

    if (path === "/api/danfe/restore" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        if (!body.chave) return send(422, { error: "Campo 'chave' é obrigatório" });
        const result = await danfe.restoreNota(String(body.chave), ctx);
        record("nfe_restaurada", `NF-e ${body.chave}`);
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao restaurar a nota.");
      }
    }

    if (path === "/api/danfe/failures/resolve" && method === "POST") {
      try {
        const body = await parseJsonBody(request);
        if (!body.error_file) return send(422, { error: "Campo 'error_file' é obrigatório" });
        const result = await danfe.resolveFailure(String(body.error_file), ctx);
        record("nfe_falha_resolvida", String(body.error_file));
        return send(200, result);
      } catch (e) {
        return sendError(ctx, e, "Falha ao marcar a falha como resolvida.");
      }
    }

    if (path === "/api/danfe/confirm-lancamento" && method === "POST") {
      let body: any = {};
      try {
        body = await parseJsonBody(request);
        const result = await danfe.confirmLancamento(
          body.chave,
          body.itens ?? [],
          body.forma_pagamento,
          body.meio_pagamento_nfe,
          body.parcelas,
          ctx,
        );
        record(
          "nfe_lancada",
          `NF-e ${body.chave}`,
          {
            formaPagamento: body.forma_pagamento,
            itens: Array.isArray(body.itens) ? body.itens.length : 0,
            parcelas: body.parcelas ?? 1,
            status: result.status,
          },
          result.status === "success",
        );
        return send(200, result);
      } catch (e) {
        record("nfe_lancada", `NF-e ${body?.chave ?? ""}`.trim(), { erro: e instanceof Error ? e.message.slice(0, 500) : String(e) }, false);
        return sendError(ctx, e, "Falha ao confirmar lançamento no Tiny.");
      }
    }

    if (path === "/api/danfe/process-batch" && method === "POST") {
      const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
      const contentLength = Number(request.headers["content-length"] || 0);
      if (contentLength > MAX_UPLOAD_BYTES) {
        return send(413, {
          error: "Payload muito grande",
          message: "O lote enviado excede o limite máximo permitido de 50MB.",
        });
      }

      let totalBytes = 0;
      let isTooLarge = false;
      const chunks: Buffer[] = [];

      request.on("data", (chunk: Buffer) => {
        if (isTooLarge) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          isTooLarge = true;
          request.destroy();
          return send(413, {
            error: "Payload muito grande",
            message: "O lote enviado excede o limite máximo permitido de 50MB.",
          });
        }
        chunks.push(Buffer.from(chunk));
      });

      request.on("end", async () => {
        if (isTooLarge || response.writableEnded) return;
        try {
          const body = Buffer.concat(chunks);
          const contentType = request.headers["content-type"] || "multipart/form-data";
          const result = await danfe.processBatch(body, contentType, ctx);
          record("nfe_lote_enviado", undefined, {
            arquivos: result.total,
            sucesso: result.success_count,
            falhas: result.failed_count,
          });
          return send(200, result);
        } catch (e) {
          return sendError(ctx, e, "Falha ao processar lote de DANFEs.");
        }
      });
      return true;
    }

    return send(404, { error: "Endpoint DANFE não encontrado" });
  };
}
