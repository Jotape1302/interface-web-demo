import type { User } from "./auth.js";
import { userHasPermission } from "./permissions.js";

export interface MarketplaceAviso {
  id: number;
  tipo: string;
  titulo: string;
  mensagem?: string;
  criado_em: string;
}

/**
 * Transforma os avisos das automações de Marketplace (produtos com dimensões a padronizar,
 * frete que o ML desfez, falha da rotina) em notificações — só para quem vê a aba do aviso
 * (Padronização de dimensões ou Fretes a combinar) e os admins. `cursor.ultimoId` guarda o último aviso já notificado; ele vive em memória, então,
 * na primeira leitura depois de o gateway subir, só avisos recentes (JANELA_INICIAL_MS) são
 * notificados, para um reinício não reenviar o histórico todo.
 */
export const JANELA_INICIAL_MS = 30 * 60_000;

export interface AlertDeps {
  readAvisos: (depoisDe: number) => Promise<{ itens: MarketplaceAviso[]; ultimo_id: number }>;
  listUsers: () => Promise<User[]>;
  notify: (userId: number, data: { tipo: string; titulo: string; mensagem?: string; link?: string }) => Promise<void>;
  cursor: { ultimoId: number | null };
  now?: () => Date;
}

/**
 * Avisos de uma automação (fila com id crescente no Python) -> notificações de quem tem o "ver"
 * da aba do aviso (`permissionFor`) e dos admins. Usado pelo Marketplace e pela conciliação
 * Mercado Livre (Financeiro). Setor não conta.
 */
export async function checkAutomationAlerts(
  deps: AlertDeps & { permissionFor: (aviso: MarketplaceAviso) => string; linkFor: (aviso: MarketplaceAviso) => string },
): Promise<number> {
  const { cursor } = deps;
  const primeira = cursor.ultimoId === null;
  const { itens, ultimo_id } = await deps.readAvisos(cursor.ultimoId ?? 0);
  const limite = (deps.now?.() ?? new Date()).getTime() - JANELA_INICIAL_MS;
  const novos = primeira ? itens.filter((a) => Date.parse(a.criado_em) >= limite) : itens;

  if (novos.length > 0) {
    const aprovados = (await deps.listUsers()).filter((u) => u.status === "approved");
    for (const aviso of novos) {
      const chave = deps.permissionFor(aviso);
      for (const u of aprovados.filter((x) => userHasPermission(x, chave))) {
        await deps.notify(u.id, {
          tipo: aviso.tipo,
          titulo: aviso.titulo,
          mensagem: aviso.mensagem,
          link: deps.linkFor(aviso),
        });
      }
    }
  }
  cursor.ultimoId = Math.max(ultimo_id, cursor.ultimoId ?? 0);
  return novos.length;
}

export function checkMarketplaceAlerts(deps: AlertDeps): Promise<number> {
  return checkAutomationAlerts({
    ...deps,
    permissionFor: (aviso) => (aviso.tipo.startsWith("dimensoes_") ? "dimensoes:ver" : "fretes:ver"),
    linkFor: (aviso) => (aviso.tipo.startsWith("dimensoes_") ? "/padronizacao-dimensoes" : "/fretes-a-combinar"),
  });
}
