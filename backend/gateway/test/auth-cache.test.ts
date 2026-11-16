import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";
import { createAuthService, createAuthStore } from "../src/auth.js";

const ADMIN_PASS = "test-admin-bootstrap-password";

async function setup(t: any) {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = ADMIN_PASS;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
  });
  const config = readConfig({});
  const store = createAuthStore(config);
  const contagem = { touch: 0, permissions: 0 };
  const spy = new Proxy(store, {
    get(target, prop) {
      const v = (target as any)[prop];
      if (prop === "touchSession")
        return (...a: unknown[]) => {
          contagem.touch++;
          return v.apply(target, a);
        };
      if (prop === "permissionsOf")
        return (...a: unknown[]) => {
          contagem.permissions++;
          return v.apply(target, a);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const auth = createAuthService(config, undefined, { store: spy as any });
  await auth.bootstrap();
  return { auth, contagem };
}

test("GW-03: touchSession acontece no máximo 1x por minuto por sessão", async (t) => {
  const { auth, contagem } = await setup(t);
  const { token } = await auth.login({ login: "admin_jp", senha: ADMIN_PASS });
  for (let i = 0; i < 10; i++) assert.ok(await auth.validateSession(token));
  assert.equal(contagem.touch, 1);
});

test("GW-03: permissões ficam 5 s em cache e a alteração de permissões invalida na hora", async (t) => {
  const { auth, contagem } = await setup(t);
  const user = await auth.createUser({
    nome: "Ana",
    username: "ana",
    email: "ana@norvia.example",
    setor: "SAC",
    senha: "senha-forte-123",
    grants: ["contas_pagar:ver"],
  });
  const { token } = await auth.login({ login: "ana", senha: "senha-forte-123" });
  const base = contagem.permissions;
  const a = await auth.validateSession(token);
  const b = await auth.validateSession(token);
  assert.equal(contagem.permissions - base, 0, "o login já aqueceu o cache: validações não consultam o store");
  assert.deepEqual(a!.permissions, ["contas_pagar:ver"]);
  assert.deepEqual(b!.permissions, ["contas_pagar:ver"]);

  const estado = await auth.getPermissionState(user.id);
  await auth.replacePermissions(user.id, ["contas_pagar:ver", "contas_pagar:baixar"], {
    actorId: 1,
    expectedVersion: estado!.version,
  });
  const c = await auth.validateSession(token);
  assert.ok(c!.permissions.includes("contas_pagar:baixar"), "mudança vale já na próxima requisição");
});
