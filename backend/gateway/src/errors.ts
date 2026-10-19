/**
 * Erros com mensagem pensada para o usuário final (GW-09). Tudo que NÃO for PublicError é
 * tratado como falha interna: o cliente recebe só uma mensagem genérica + requestId, e o
 * detalhe (stack, SQL, URL interna) fica apenas no log do gateway.
 */
export class PublicError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Código estável para a lógica do gateway e do frontend (não muda com o texto da mensagem). */
    readonly code?: string,
    /**
     * Dados extras seguros para o cliente: `field` (campo do formulário que causou o erro:
     * "nome" | "username" | "email" | "setor" | "senha" | "role" | "grants") e itens/estado
     * (ex.: permissões fora do teto do Gestor, versão atual num conflito).
     */
    readonly extra?: { field?: string } & Record<string, unknown>,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

/** Dependência indisponível (ex.: MariaDB fora em modo live) → 503, sem fallback em memória. */
export class ServiceUnavailableError extends PublicError {
  constructor(message = "Serviço temporariamente indisponível. Tente novamente em instantes.") {
    super(503, message, "service_unavailable");
    this.name = "ServiceUnavailableError";
  }
}

/** Resposta de erro de uma automação (financeiro/marketplace), já com status mapeado para o cliente. */
export class UpstreamError extends PublicError {
  constructor(
    status: number,
    message: string,
    readonly upstreamStatus: number,
  ) {
    super(status, message, "upstream_error");
    this.name = "UpstreamError";
  }
}
