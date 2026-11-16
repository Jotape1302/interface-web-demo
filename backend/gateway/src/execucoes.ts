/**
 * Contagem de execuções por rota para o monitor dos agentes Qwen (norvia-ti/agentes-qwen).
 *
 * O gateway só loga erros; para saber se uma correção resolveu, o monitor precisa ver a rota
 * que falhava responder certo nas execuções seguintes. A cada `janelaMs` sai UMA linha com as
 * rotas que tiveram tráfego:
 *   {"event":"execucoes","janela_s":60,"rotas":{"POST /api/ml-reconciliation/baixar":{"ok":3,"erro":0}},"at":"..."}
 * ok = status < 500; erro = 5xx. O coletor da VPS (scripts/coletor-incidentes) leva as linhas ao PC.
 */

const MAX_ROTAS = 500;

export interface ExecucoesCounter {
  registrar(method: string, path: string, status: number): void;
  /** Linha da janela atual (ou null sem tráfego) e zera os contadores. */
  fechar(janelaS: number): string | null;
}

/** Tira da rota o que muda a cada chamada: ids numéricos, UUIDs, hashes e códigos como MLB123. */
export function normalizarRota(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^[A-Za-z]{2,5}\d{4,}$/.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

export function createExecucoesCounter(): ExecucoesCounter {
  let rotas = new Map<string, { ok: number; erro: number }>();
  return {
    registrar(method, path, status) {
      const chave = `${method} ${normalizarRota(path)}`;
      let item = rotas.get(chave);
      if (!item) {
        if (rotas.size >= MAX_ROTAS) return;
        item = { ok: 0, erro: 0 };
        rotas.set(chave, item);
      }
      if (status >= 500) item.erro += 1;
      else item.ok += 1;
    },
    fechar(janelaS) {
      if (rotas.size === 0) return null;
      const linha = JSON.stringify({ event: "execucoes", janela_s: janelaS, rotas: Object.fromEntries(rotas), at: new Date().toISOString() });
      rotas = new Map();
      return linha;
    },
  };
}
