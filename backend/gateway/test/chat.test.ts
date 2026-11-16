import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { createChatService } from "../src/chat.js";

const PASS = "senha-forte-123";
const ADMIN_PASS = "test-admin-bootstrap-password";
const json = { "Content-Type": "application/json" };

async function startChat(t: any) {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = ADMIN_PASS;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
  });
  const config = readConfig({});
  const auth = createAuthService(config);
  await auth.bootstrap();
  const chat = createChatService(config, undefined, {
    listApprovedUsers: async () =>
      (await auth.listUsers())
        .filter((u) => u.status === "approved")
        .map((u) => ({ id: u.id, nome: u.nome, username: u.username, setor: u.setor, role: u.role })),
  });
  const eventos: Array<[unknown, string]> = [];
  const events = {
    publish: (alvo: unknown, tipo: string) => void eventos.push([alvo, tipo]),
    attach: () => () => undefined,
    closeAll: () => undefined,
    connectionCount: () => 0,
  };
  const demo = createDemo();
  const server = createApi(config, {
    dashboard: createDashboardService("demo", demo.database, demo.n8n),
    auth,
    chat,
    events: events as any,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  const base = `http://127.0.0.1:${a.port}`;
  const login = async (l: string, senha: string) => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ login: l, senha }) });
    assert.equal(res.status, 200, l);
    return { Authorization: `Bearer ${((await res.json()) as any).token}` };
  };
  const admin = await login("admin_jp", ADMIN_PASS);
  const mk = async (username: string) => {
    const res = await fetch(`${base}/api/admin/users`, {
      method: "POST",
      headers: { ...admin, ...json },
      body: JSON.stringify({ nome: username, username, email: `${username}@norvia.example`, setor: "SAC", senha: PASS, grants: [] }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    return { id: ((await res.json()) as any).id as number, h: await login(username, PASS) };
  };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: body === undefined ? h : { ...h, ...json }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, mk, admin, eventos, base };
}

test("chat: exige sessão", async (t) => {
  const { base } = await startChat(t);
  assert.equal((await fetch(`${base}/api/chat/contacts`)).status, 401);
});

test("chat: contatos, envio, conversas, histórico, não lidas e marcar como lida", async (t) => {
  const { call, mk, eventos } = await startChat(t);
  const ana = await mk("ana");
  const beto = await mk("beto");

  const contatos = (await (await call(ana.h, "GET", "/api/chat/contacts")).json()) as any[];
  assert.ok(contatos.some((c) => c.id === beto.id));
  assert.ok(contatos.every((c) => c.id !== ana.id), "o próprio usuário não é contato");

  const enviada = await call(ana.h, "POST", "/api/chat/messages", { destinatarioId: beto.id, conteudo: "Oi, Beto" });
  assert.equal(enviada.status, 201);
  const msg = (await enviada.json()) as any;
  assert.equal(msg.remetente_id, ana.id);
  assert.equal(msg.destinatario_id, beto.id);
  assert.equal(msg.lida, false);
  assert.ok(eventos.some(([, tipo]) => tipo === "chat"), "SSE avisa os dois lados");

  assert.deepEqual(await (await call(beto.h, "GET", "/api/chat/unread-count")).json(), { count: 1 });
  assert.deepEqual(await (await call(ana.h, "GET", "/api/chat/unread-count")).json(), { count: 0 });

  const conversas = (await (await call(beto.h, "GET", "/api/chat/conversations")).json()) as any[];
  assert.equal(conversas.length, 1);
  assert.equal(conversas[0].outroUsuarioId, ana.id);
  assert.equal(conversas[0].naoLidas, 1);
  assert.equal(conversas[0].ultimaMensagem, "Oi, Beto");

  const historico = (await (await call(beto.h, "GET", `/api/chat/messages/${ana.id}`)).json()) as any[];
  assert.deepEqual(historico.map((m) => m.conteudo), ["Oi, Beto"]);

  assert.equal((await call(beto.h, "POST", `/api/chat/messages/${ana.id}/read`)).status, 200);
  assert.deepEqual(await (await call(beto.h, "GET", "/api/chat/unread-count")).json(), { count: 0 });
  const depois = (await (await call(beto.h, "GET", "/api/chat/conversations")).json()) as any[];
  assert.equal(depois[0].naoLidas, 0);
});

test("chat: mensagem vazia ou longa demais é recusada com 400", async (t) => {
  const { call, mk } = await startChat(t);
  const ana = await mk("ana");
  const beto = await mk("beto");
  const vazia = await call(ana.h, "POST", "/api/chat/messages", { destinatarioId: beto.id, conteudo: "   " });
  assert.equal(vazia.status, 400);
  const longa = await call(ana.h, "POST", "/api/chat/messages", { destinatarioId: beto.id, conteudo: "x".repeat(4001) });
  assert.equal(longa.status, 400);
});
