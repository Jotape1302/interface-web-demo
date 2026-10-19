import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationService } from "../src/notifications.js";
import { createNotificationRoutes } from "../src/routes/notifications.js";
import type { Config } from "../src/config.js";
import type { User } from "../src/auth.js";
import type { RequestContext } from "../src/http.js";

const DUMMY_CONFIG: Config = {
  port: 3100,
  origins: ["http://localhost:3000"],
  mode: "demo",
  timeoutMs: 1000,
  internalApiKey: undefined,
};

function makeUser(
  id: number,
  setor: string,
  role: User["role"] = "user",
  status: User["status"] = "approved",
  permissoes: string[] = [],
): User {
  return { id, username: `u${id}`, nome: `U${id}`, email: `u${id}@test.com`, setor, role, status, criado_em: "", permissoes };
}

// RBAC por usuário: o setor é só rótulo; quem recebe é quem tem a permissão (+ admins).
const TEST_USERS: User[] = [
  makeUser(1, "TI", "admin"),
  makeUser(2, "Marketing", "user", "approved", ["contas_pagar:ver", "erros:ver"]),
  makeUser(3, "Financeiro", "user", "approved", ["contagem_estoque:ver"]),
  makeUser(4, "Logística", "user", "approved", ["fretes:ver"]),
  makeUser(5, "Diretoria", "user"),
  makeUser(6, "Financeiro", "user", "pending", ["contas_pagar:ver"]),
  // Linha legada (sem ":") e chave de Gestão de Usuários num User: inertes.
  makeUser(7, "Financeiro", "user", "approved", ["accounts_payable", "usuarios:ver"]),
  makeUser(8, "RH", "gestor", "approved", ["usuarios:ver", "usuarios:aprovar_cadastro"]),
];

test("NotificationService: notifyPermission e notifyArea seguem as permissões, não o setor", async () => {
  const notified: number[] = [];
  const svc = createNotificationService(DUMMY_CONFIG, undefined, {
    getRecipientIds: async (role) => TEST_USERS.filter((u) => u.role === role && u.status === "approved").map((u) => u.id),
    listUsers: async () => TEST_USERS,
    onNotify: (id) => notified.push(id),
  });
  await svc.notifyPermission("erros:ver", { tipo: "t", titulo: "Incidente" });
  assert.deepEqual(notified.sort(), [1, 2]);
  notified.length = 0;
  await svc.notifyPermission("usuarios:aprovar_cadastro", { tipo: "t", titulo: "Cadastro" });
  assert.deepEqual(notified.sort(), [1, 8], "user com linha usuarios:* não recebe; gestor com a ação recebe");
  notified.length = 0;
  await svc.notifyPermission("nao:existe", { tipo: "t", titulo: "x" });
  assert.deepEqual(notified, [1], "chave fora do catálogo: só admins");
});

test("NotificationService: notifyArea distribui para quem vê alguma aba da área e admins", async () => {
  const notifiedIds: number[] = [];
  const svc = createNotificationService(DUMMY_CONFIG, undefined, {
    getRecipientIds: async (role) => TEST_USERS.filter((u) => u.role === role && u.status === "approved").map((u) => u.id),
    listUsers: async () => TEST_USERS,
    onNotify: (id) => notifiedIds.push(id),
  });

  // Área Financeiro: Admin (1) e quem vê Contas a Pagar (2) — não o setor Financeiro (3, 7).
  await svc.notifyArea("financeiro", { tipo: "teste", titulo: "Alerta Financeiro" });
  assert.deepEqual(notifiedIds.sort(), [1, 2]);

  // Logística: Admin (1) e quem vê Contagem de estoque (3)
  notifiedIds.length = 0;
  await svc.notifyArea("logistica", { tipo: "teste", titulo: "Alerta Estoque" });
  assert.deepEqual(notifiedIds.sort(), [1, 3]);

  // Marketplace: Admin (1) e quem vê Fretes (4)
  notifiedIds.length = 0;
  await svc.notifyArea("marketplace", { tipo: "teste", titulo: "Alerta Anúncio" });
  assert.deepEqual(notifiedIds.sort(), [1, 4]);
});

test("NotificationService: notifySetor entrega com normalização sem acento", async () => {
  const notifiedIds: number[] = [];
  const svc = createNotificationService(DUMMY_CONFIG, undefined, {
    getRecipientIds: async (role) => TEST_USERS.filter((u) => u.role === role && u.status === "approved").map((u) => u.id),
    listUsers: async () => TEST_USERS,
    onNotify: (id) => notifiedIds.push(id),
  });

  // Envio manual por setor (rótulo de equipe) continua: setor + admins.
  await svc.notifySetor("logistica", { tipo: "teste", titulo: "Aviso de Carga" });
  assert.deepEqual(notifiedIds.sort(), [1, 4]);
});

test("POST /api/notifications/emit: exclusivo do admin", async () => {
  const svc = createNotificationService(DUMMY_CONFIG, undefined, {
    getRecipientIds: async (role) => [1],
    listUsers: async () => TEST_USERS,
  });

  const authMock: any = {
    validateSession: async (t: string) => {
      if (t === "user-tok") return { user: makeUser(2, "Financeiro"), permissions: [] };
      if (t === "admin-tok") return { user: makeUser(1, "TI", "admin"), permissions: [] };
      return null;
    },
  };
  const handler = createNotificationRoutes({ auth: authMock, notifications: svc });

  // 1. Usuário comum recebe 403
  let sentStatus = 0;
  let sentBody: any = null;
  const nonAdminCtx: RequestContext = {
    request: { headers: { authorization: "Bearer user-tok" } } as any,
    response: {} as any,
    url: new URL("http://gw/api/notifications/emit"),
    path: "/api/notifications/emit",
    method: "POST",
    ip: "127.0.0.1",
    send: (s, b) => {
      sentStatus = s;
      sentBody = b;
      return true;
    },
  };

  const handledNonAdmin = await handler(nonAdminCtx);
  assert.equal(handledNonAdmin, true);
  assert.equal(sentStatus, 403);
});
