import type { ServerResponse } from "node:http";

/**
 * Canal de eventos em tempo real (Server-Sent Events) para o frontend.
 *
 * Substitui o polling curto (chat a cada 5s, notificações/contadores a cada 20–45s) por
 * um aviso "algo mudou, recarregue X": os eventos não carregam dados, só o tipo — o
 * frontend continua buscando pelas rotas REST de sempre, que já fazem a checagem de
 * permissão. Assim o canal não duplica regra de acesso nem vaza dado de outro usuário.
 *
 * Conexões ficam em memória (gateway é processo único). Atrás do NGINX, o header
 * `X-Accel-Buffering: no` desliga o buffer do proxy e o heartbeat mantém a conexão viva
 * abaixo do `proxy_read_timeout` padrão (60s).
 */
/**
 * `session`: o perfil, as permissões ou a conta do próprio usuário mudaram (admin/gestor editou,
 * excluiu ou derrubou a sessão) — o frontend relê GET /api/auth/me e redesenha menu/botões
 * (401 ali = sessão encerrada → volta ao login).
 */
export type RealtimeEventType = "notification" | "chat" | "incidents" | "session";

const HEARTBEAT_MS = 25_000;
const MAX_CONNECTIONS_PER_USER = 10;

export interface EventHub {
  /** Registra a resposta HTTP como stream SSE do usuário; retorna função de encerramento. */
  attach(userId: number, response: ServerResponse): () => void;
  publish(target: number | number[] | "all", type: RealtimeEventType): void;
  closeAll(): void;
  connectionCount(): number;
}

export function createEventHub(): EventHub {
  const connections = new Map<number, Set<ServerResponse>>();

  function write(response: ServerResponse, chunk: string) {
    if (response.writableEnded || response.destroyed) return;
    response.write(chunk);
  }

  return {
    attach(userId, response) {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      write(response, `retry: 5000\nevent: ready\ndata: {}\n\n`);

      const userConnections = connections.get(userId) ?? new Set<ServerResponse>();
      if (userConnections.size >= MAX_CONNECTIONS_PER_USER) {
        // Muitas abas abertas: derruba a conexão mais antiga em vez de recusar a nova.
        const oldest = userConnections.values().next().value;
        if (oldest) {
          userConnections.delete(oldest);
          oldest.end();
        }
      }
      userConnections.add(response);
      connections.set(userId, userConnections);

      const heartbeat = setInterval(() => write(response, `: ping\n\n`), HEARTBEAT_MS);
      heartbeat.unref();

      const detach = () => {
        clearInterval(heartbeat);
        const set = connections.get(userId);
        set?.delete(response);
        if (set && set.size === 0) connections.delete(userId);
      };
      response.on("close", detach);
      return () => {
        detach();
        response.end();
      };
    },

    publish(target, type) {
      const chunk = `event: ${type}\ndata: {}\n\n`;
      const userIds = target === "all" ? [...connections.keys()] : Array.isArray(target) ? target : [target];
      for (const id of new Set(userIds)) {
        for (const response of connections.get(id) ?? []) write(response, chunk);
      }
    },

    closeAll() {
      for (const set of connections.values()) for (const response of set) response.end();
      connections.clear();
    },

    connectionCount() {
      let total = 0;
      for (const set of connections.values()) total += set.size;
      return total;
    },
  };
}
