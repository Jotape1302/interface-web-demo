import test from "node:test";
import assert from "node:assert/strict";
import type { User } from "../src/auth.js";
import { routeAccess, userHasPermission } from "../src/permissions.js";
import { checkMarketplaceAlerts, type MarketplaceAviso } from "../src/marketplace-alerts.js";
import { createMarketplaceRoutes } from "../src/routes/marketplace.js";

function user(
  id: number,
  setor: string,
  role: User["role"] = "user",
  status: User["status"] = "approved",
  permissoes: string[] = [],
): User {
  return { id, username: `u${id}`, nome: `U${id}`, email: "", setor, role, status, criado_em: "", permissoes };
}

// Setor não conta mais: quem recebe é quem vê a aba do aviso (+ admins).
const USUARIOS = [
  user(1, "TI", "admin"),
  user(2, "E-Commerce", "user", "approved", ["fretes:ver"]),
  user(3, "Financeiro", "user", "approved", ["fretes:ver", "dimensoes:ver"]),
  user(4, "Diretoria"),
  user(5, "Marketplace", "user", "approved", ["dimensoes:ver"]),
  user(6, "E-Commerce", "user", "pending", ["fretes:ver"]),
];

test("rotas de fretes exigem a aba Fretes a combinar; PUT não existe", () => {
  assert.deepEqual(routeAccess("GET", "/api/marketplace/fretes/anuncios"), { kind: "perm", key: "fretes:ver" });
  assert.deepEqual(routeAccess("POST", "/api/marketplace/fretes/retentar"), { kind: "perm", key: "fretes:retentar" });
  assert.equal(routeAccess("PUT", "/api/marketplace/fretes/anuncios").kind, "none");
  assert.equal(routeAccess("POST", "/api/marketplace/fretes/qualquer").kind, "none");
});

test("notificação de Fretes: quem vê a aba + admins (setor não conta)", () => {
  const recebem = USUARIOS.filter((u) => userHasPermission(u, "fretes:ver")).map((u) => u.id);
  assert.deepEqual(recebem, [1, 2, 3, 6]);
});

test("avisos viram notificação só para aprovados que veem a aba + admins, sem repetir", async () => {
  const enviados: Array<[number, string]> = [];
  const agora = new Date("2026-09-28T12:00:00");
  let avisos: MarketplaceAviso[] = [
    { id: 1, tipo: "fretes_pendencias", titulo: "antigo", criado_em: "2026-09-27T07:00:00" },
    { id: 2, tipo: "fretes_revertido", titulo: "recente", criado_em: "2026-09-28T11:50:00" },
  ];
  const cursor = { ultimoId: null as number | null };
  const deps = {
    readAvisos: async (depoisDe: number) => ({ itens: avisos.filter((a) => a.id > depoisDe), ultimo_id: avisos.at(-1)!.id }),
    listUsers: async () => USUARIOS,
    notify: async (id: number, d: { titulo: string }) => {
      enviados.push([id, d.titulo]);
    },
    cursor,
    now: () => agora,
  };

  // Primeira leitura depois de subir: só o aviso recente (não reenvia o histórico).
  assert.equal(await checkMarketplaceAlerts(deps), 1);
  assert.deepEqual(enviados, [[1, "recente"], [2, "recente"], [3, "recente"]]);

  enviados.length = 0;
  assert.equal(await checkMarketplaceAlerts(deps), 0);
  avisos = [...avisos, { id: 3, tipo: "fretes_erro", titulo: "novo", criado_em: "2026-09-28T11:59:00" }];
  assert.equal(await checkMarketplaceAlerts(deps), 1);
  assert.deepEqual(enviados.map(([id]) => id), [1, 2, 3]);
});

function ctx(path: string, method: string, body?: unknown) {
  const url = new URL(`http://gw${path}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const sent: { status?: number; body?: any } = {};
  return {
    sent,
    ctx: {
      request: (async function* () {
        yield* chunks;
      })() as any,
      response: {} as any,
      url,
      path: url.pathname,
      method,
      ip: "10.0.0.1",
      session: { user: { id: 2, nome: "Ana" } as any, permissions: [] },
      send(status: number, b: unknown) {
        sent.status = status;
        sent.body = b;
        return true;
      },
    },
  };
}

test("proxy repassa para a API Python com query, grava o usuário e audita o envio", async () => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const auditados: any[] = [];
  const handler = createMarketplaceRoutes({
    baseUrl: "http://py:8001",
    audit: { record: async (e: any) => void auditados.push(e) } as any,
    fetchImpl: (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any,
  });

  const get = ctx("/api/marketplace/fretes/anuncios?q=painel&page=2", "GET");
  await handler(get.ctx as any);
  assert.equal(chamadas[0]!.url, "http://py:8001/api/v1/fretes/anuncios?q=painel&page=2");
  assert.equal(auditados.length, 0);

  const post = ctx("/api/marketplace/dimensoes/validar", "POST", {
    produtos: [{ sku: "PV83", altura: 1 }],
    usuario: "forjado",
  });
  await handler(post.ctx as any);
  assert.equal(chamadas[1]!.url, "http://py:8001/api/v1/dimensoes/validar");
  assert.equal(JSON.parse(String(chamadas[1]!.init.body)).usuario, "Ana", "o usuário vem da sessão, não do corpo");
  assert.equal(auditados[0].acao, "dimensoes_validadas");
  assert.equal(auditados[0].alvo, "PV83");

  const retentar = ctx("/api/marketplace/fretes/retentar", "POST", { anuncios: [{ filial: "norvia", mlb: "MLB1" }] });
  await handler(retentar.ctx as any);
  assert.equal(auditados[1].acao, "fretes_nova_tentativa");
  assert.equal(auditados[1].alvo, "MLB1");

  const outra = ctx("/api/marketplace/outra/coisa", "GET");
  assert.equal(await handler(outra.ctx as any), false, "só fretes e dimensoes são repassados");
});

test("proxy devolve o erro da automação e recusa caminho estranho", async () => {
  const handler = createMarketplaceRoutes({
    baseUrl: "http://py:8001",
    fetchImpl: (async () => new Response(JSON.stringify({ detail: "Preencha o peso" }), { status: 422 })) as any,
  });
  const r = ctx("/api/marketplace/dimensoes/validar", "POST", {});
  await handler(r.ctx as any);
  assert.deepEqual([r.sent.status, r.sent.body], [422, { error: "Preencha o peso" }]);

  const ruim = ctx("/api/marketplace/fretes/..%2F..%2Fadmin", "GET");
  await handler(ruim.ctx as any);
  assert.equal(ruim.sent.status, 400);
});
