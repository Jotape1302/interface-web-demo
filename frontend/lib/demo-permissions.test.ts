import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEMO_PERMISSION_CATALOG,
  DEMO_ROOT_USERNAME,
  demoAdminStore,
  demoSessionFor,
  resetDemoAdminStore,
} from "./demo-permissions";
import type { PermissionCatalog } from "./permissions";

const GATEWAY_PERMISSIONS = fileURLToPath(new URL("../../backend/gateway/src/permissions.ts", import.meta.url));

void test("catálogo demo é idêntico ao do gateway", { skip: !existsSync(GATEWAY_PERMISSIONS) }, async () => {
  const path: string = GATEWAY_PERMISSIONS;
  const mod = (await import(path)) as { PERMISSION_CATALOG: PermissionCatalog };
  assert.deepEqual(JSON.parse(JSON.stringify(DEMO_PERMISSION_CATALOG)), JSON.parse(JSON.stringify(mod.PERMISSION_CATALOG)));
});

function actor(username: string) {
  const s = demoSessionFor(username)!;
  return { id: s.user.id, role: s.user.role, permissions: s.permissions };
}

void test("perfis demo: Admin ROOT, Gestor parcial, 2 Users com e 2 sem permissões", () => {
  resetDemoAdminStore();
  const root = demoSessionFor(DEMO_ROOT_USERNAME)!;
  assert.equal(root.user.is_root, true);
  assert.equal(root.permissions.length, 46);
  assert.equal(demoSessionFor("gestora.demo")!.user.role, "gestor");
  assert.ok(demoSessionFor("fin.demo")!.permissions.length > 0);
  assert.ok(demoSessionFor("mkt.demo")!.permissions.length > 0);
  assert.deepEqual(demoSessionFor("log.demo")!.permissions, []);
  assert.deepEqual(demoSessionFor("sac.demo")!.permissions, []);
});

void test("store demo aplica as regras do gateway: teto, alvo, versão e criação", () => {
  resetDemoAdminStore();
  const gestora = actor("gestora.demo");
  const admin = actor(DEMO_ROOT_USERNAME);
  const fin = demoSessionFor("fin.demo")!.user;

  // Gestor não mexe em Admin/Gestor.
  const r1 = demoAdminStore.putPermissions(gestora, 1, [], 0);
  assert.equal(r1.ok, false);
  // Gestor fora do teto: fin.demo já tem itens que a gestora não tem → revogar = 403.
  const st = demoAdminStore.getPermissions(gestora, fin.id);
  assert.ok(st.ok);
  const r2 = demoAdminStore.putPermissions(gestora, fin.id, ["contas_pagar:ver"], st.ok ? st.data.version : 0);
  assert.equal(!r2.ok && r2.error.code, "outside_ceiling");
  // Conflito de versão.
  const r3 = demoAdminStore.putPermissions(admin, fin.id, ["contas_pagar:ver"], 999);
  assert.equal(!r3.ok && r3.error.code, "version_conflict");
  // Gestor cria só User; username duplicado e senha fraca viram erro de campo.
  const base = { nome: "Novo", username: "novo.user", email: "novo@h.com", setor: "SAC", senha: "1234567890", grants: [] };
  const r4 = demoAdminStore.createUser(gestora, { ...base, role: "admin" });
  assert.equal(!r4.ok && r4.error.code, "role_forbidden");
  const r5 = demoAdminStore.createUser(admin, { ...base, username: "fin.demo", role: "user" });
  assert.equal(!r5.ok && r5.error.field, "username");
  const r6 = demoAdminStore.createUser(admin, { ...base, senha: "123", role: "user" });
  assert.equal(!r6.ok && r6.error.field, "senha");
  const r7 = demoAdminStore.createUser(admin, { ...base, role: "user", grants: ["contas_pagar:ver"] });
  assert.ok(r7.ok);
  // Admin rebaixado começa sem permissões; ROOT não muda de perfil.
  assert.ok(demoAdminStore.putRole(admin, fin.id, "admin").ok);
  const r8 = demoAdminStore.putRole(admin, fin.id, "user");
  assert.ok(r8.ok && r8.data.permissions.grants.length === 0);
  // Gestor → User perde só a Gestão de Usuários.
  const r9 = demoAdminStore.putRole(admin, 2, "user");
  assert.ok(r9.ok && r9.data.permissions.grants.includes("contas_pagar:ver"));
  assert.ok(r9.ok && !r9.data.permissions.grants.some((k) => k.startsWith("usuarios:")));
  assert.equal(demoAdminStore.putRole(admin, 1, "user").ok, false);
});
