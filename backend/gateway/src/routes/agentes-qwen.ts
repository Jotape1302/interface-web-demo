import type { AgentesQwenService } from "../agentes-qwen.js";
import { parseAgentesQwenEstado } from "../agentes-qwen.js";
import type { AuditService } from "../audit.js";
import type { DanfeService } from "../danfe.js";
import { logWarn } from "../errors.js";
import { methodNotAllowed, parseJsonBody, type RequestContext } from "../http.js";

// Aba Agentes Qwen (/api/agentes-qwen): GET para quem tem `agentes_qwen:ver` (RBAC central);
// POST /estado é o repasse do coletor da VPS, sem sessão, com AGENTES_QWEN_TOKEN. O coletor fala
// direto com 127.0.0.1:3100: requisição que passou pelo NGINX (X-Forwarded-For) é recusada.
// POST /incidentes/{id}/resolver (`agentes_qwen:resolver`): pedido entregue ao PC no próximo repasse.
// /financeiro/* é a ponte do classificador Qwen da revisão de NF-e: o coletor roda no host e não
// alcança a automação (porta 8000 só na rede do compose), então o gateway repassa com a chave
// interna, com a mesma proteção do /estado. Status da automação (404/409/422) volta como veio.
// /financeiro/boletos/* faz o mesmo para o classificador dos boletos DDA (rotas /api/v1/dda/qwen/*).
const FINANCEIRO_PREFIXO = "/api/agentes-qwen/financeiro/";

export function createAgentesQwenRoutes(deps: { agentesQwen?: AgentesQwenService; audit?: AuditService; danfe?: DanfeService }) {
  const { agentesQwen, audit, danfe } = deps;

  return async function handleAgentesQwen(ctx: RequestContext): Promise<boolean> {
    const { path, method, request, send } = ctx;
    if (!path.startsWith("/api/agentes-qwen")) return false;
    if (!agentesQwen) return send(503, { error: "Serviço dos agentes Qwen não inicializado" });

    if (path === "/api/agentes-qwen/estado" && method === "POST") {
      if (request.headers["x-forwarded-for"] || !agentesQwen.tokenValido(request.headers.authorization)) {
        return send(401, { error: "Não autorizado" });
      }
      let estado;
      try {
        estado = parseAgentesQwenEstado(await parseJsonBody(request));
      } catch (err) {
        return send(400, { error: err instanceof Error ? err.message : "Estado inválido" });
      }
      try {
        return send(202, await agentesQwen.receber(estado));
      } catch (err) {
        logWarn("agentes_qwen_receber_failed", err);
        return send(500, { error: "Falha ao gravar o estado dos agentes" });
      }
    }

    // /financeiro/boletos/* é a mesma ponte para o classificador dos boletos DDA sem conta.
    if (
      (path === "/api/agentes-qwen/financeiro/pendentes" && method === "GET") ||
      (path === "/api/agentes-qwen/financeiro/confirmadas-recentes" && method === "GET") ||
      (path === "/api/agentes-qwen/financeiro/boletos/pendentes" && method === "GET") ||
      (path === "/api/agentes-qwen/financeiro/boletos/confirmadas-recentes" && method === "GET") ||
      // Gravação das sugestões prontas (resposta do PC):
      (path === "/api/agentes-qwen/financeiro/sugestoes" && method === "POST") ||
      (path === "/api/agentes-qwen/financeiro/boletos/sugestoes" && method === "POST")
    ) {
      if (request.headers["x-forwarded-for"] || !agentesQwen.tokenValido(request.headers.authorization)) {
        return send(401, { error: "Não autorizado" });
      }
      if (!danfe?.qwenRepasse) return send(503, { error: "Automação financeira indisponível neste modo" });
      let corpo: unknown;
      if (method === "POST") {
        try {
          corpo = await parseJsonBody(request);
        } catch (err) {
          return send(400, { error: err instanceof Error ? err.message : "JSON inválido" });
        }
      }
      const query = new URLSearchParams();
      for (const nome of ["limit", "cursor"]) {
        const valor = ctx.url.searchParams.get(nome);
        if (valor !== null) query.set(nome, valor);
      }
      const recurso = path.slice(FINANCEIRO_PREFIXO.length);
      const caminho = query.size ? `${recurso}?${query}` : recurso;
      try {
        const r = await danfe.qwenRepasse(method as "GET" | "POST", caminho, corpo);
        return send(r.status, r.corpo);
      } catch (err) {
        logWarn("agentes_qwen_financeiro_failed", err);
        return send(502, { error: "Automação financeira fora do ar" });
      }
    }

    if (path === "/api/agentes-qwen" && method === "GET") return send(200, await agentesQwen.ler());

    const resolverMatch = /^\/api\/agentes-qwen\/incidentes\/(\d+)\/resolver$/.exec(path);
    if (resolverMatch && method === "POST" && ctx.session) {
      const corpo = (await parseJsonBody(request).catch(() => ({}))) as { nota?: unknown };
      const nota = typeof corpo?.nota === "string" ? corpo.nota : "";
      const incidente = Number(resolverMatch[1]);
      const r = await agentesQwen.pedirResolucao(incidente, nota, ctx.session.user.nome);
      if (r === "nao_encontrado") return send(404, { error: "Incidente não encontrado no último estado dos agentes." });
      if (r === "ja_resolvido") return send(409, { error: "O incidente já está resolvido." });
      void audit?.record({ actor: ctx.session.user, acao: "agentes_qwen_resolvido", alvo: `Incidente #${incidente} dos agentes Qwen`, detalhes: nota ? { nota } : undefined, ip: ctx.ip });
      return send(202, { ok: true, resolucoesPendentes: (await agentesQwen.ler()).resolucoesPendentes });
    }
    methodNotAllowed(ctx, path.endsWith("/estado") || path.endsWith("/sugestoes") ? "POST" : "GET, OPTIONS");
    return true;
  };
}
