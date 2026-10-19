import test from "node:test";
import assert from "node:assert/strict";
import mariadb, { type Pool } from "mariadb";
import { readConfig } from "../src/config.js";
import { createAuthStore, type AuthStore } from "../src/auth.js";
import { PublicError } from "../src/errors.js";

// Store de usuários/permissões do RBAC por usuário: troca atômica com versão (409), perfil
// Gestor, ROOT persistente, contagem de admins e criação com permissões numa transação.

const ADMIN_PASS = "test-admin-bootstrap-password";

function withBootstrapPassword(t: { after: (fn: () => void) => void }) {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = ADMIN_PASS;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
  });
}

const novo = (username: string, role: "admin" | "gestor" | "user" = "user") => ({
  username,
  nome: `Nome ${username}`,
  email: `${username}@norvia.example`,
  setor: "Financeiro",
  role,
  status: "approved" as const,
  password_hash: "h",
  salt: "s",
});

/** Cenário comum aos dois stores (memória e MariaDB real). */
async function exerciseStore(store: AuthStore) {
  await store.init();
  await store.init(); // idempotente

  // ROOT persistente: o admin do seed, sem nenhuma linha de permissão (acesso total implícito).
  const rootId = await store.findRootUserId();
  assert.ok(rootId);
  const root = await store.findUserById(rootId!);
  assert.equal(root?.username, "admin_jp");
  assert.equal(root?.role, "admin");
  assert.equal(root?.is_root, true);
  assert.deepEqual((await store.getPermissionState(rootId!))?.grants, []);
  assert.equal(await store.countApprovedAdmins(), 1);

  // Criação com conjunto explícito (duplicata ignorada) e com conjunto vazio.
  const userId = await store.insertUser(novo("ana"), ["financeiro:ver", "contas_pagar:ver", "financeiro:ver"], { actorId: rootId });
  let st = await store.getPermissionState(userId);
  assert.deepEqual(st?.grants, ["contas_pagar:ver", "financeiro:ver"]);
  assert.equal(st?.version, 0);
  assert.equal(st?.updatedBy, rootId);
  assert.equal(st?.updatedByName, root?.nome);
  assert.ok(st?.updatedAt);
  const vazioId = await store.insertUser(novo("bia"), [], { actorId: rootId });
  st = await store.getPermissionState(vazioId);
  assert.deepEqual(st?.grants, []);
  assert.equal(st?.updatedBy, null);
  assert.equal((await store.findUserById(vazioId))?.is_root, false);

  // Troca atômica: substitui TODO o conjunto e incrementa a versão.
  const r1 = await store.replacePermissions(userId, ["dashboard_financeiro:ver"], { actorId: rootId!, expectedVersion: 0 });
  assert.ok(r1.ok);
  assert.deepEqual(r1.state.grants, ["dashboard_financeiro:ver"]);
  assert.equal(r1.state.version, 1);

  // Conflito: versão velha não grava nada e devolve o estado atual.
  const r2 = await store.replacePermissions(userId, ["financeiro:ver"], { actorId: vazioId, expectedVersion: 0 });
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok && r2.reason === "version_conflict");
  assert.equal(r2.current.version, 1);
  assert.deepEqual(r2.current.grants, ["dashboard_financeiro:ver"]);
  assert.equal(r2.current.updatedBy, rootId);

  // Sem expectedVersion grava direto; conjunto vazio = sem acesso.
  const r3 = await store.replacePermissions(userId, [], { actorId: rootId! });
  assert.ok(r3.ok && r3.state.version === 2 && r3.state.grants.length === 0);
  assert.deepEqual((await store.permissionsOf(userId)).allowed, []);

  // Inexistente.
  assert.deepEqual(await store.replacePermissions(99999, ["x:ver"], { actorId: rootId! }), { ok: false, reason: "not_found" });
  assert.equal(await store.getPermissionState(99999), null);
  assert.deepEqual(await store.updateRole(99999, "gestor", { actorId: rootId! }), { ok: false, reason: "not_found" });

  // Perfil: user → gestor mantém as permissões; ROOT é intocável.
  await store.replacePermissions(userId, ["financeiro:ver"], { actorId: rootId! });
  const g = await store.updateRole(userId, "gestor", { actorId: rootId! });
  assert.ok(g.ok && g.previousRole === "user");
  assert.deepEqual(g.state.grants, ["financeiro:ver"]);
  assert.equal((await store.findUserById(userId))?.role, "gestor");
  assert.deepEqual(await store.updateRole(rootId!, "user", { actorId: rootId! }), { ok: false, reason: "root" });
  assert.equal(await store.deleteUser(rootId!), false);
  assert.ok(await store.findUserById(rootId!));

  // Admin rebaixado começa sem permissões (replaceGrants na mesma transação).
  const admId = await store.insertUser(novo("carla", "admin"), []);
  assert.equal(await store.countApprovedAdmins(), 2);
  await store.replacePermissions(admId, ["sobra:ver"], { actorId: rootId! });
  const d = await store.updateRole(admId, "user", { actorId: rootId!, replaceGrants: [] });
  assert.ok(d.ok && d.previousRole === "admin");
  assert.deepEqual(d.state.grants, []);
  assert.equal(await store.countApprovedAdmins(), 1);

  // Último admin aprovado: com o ROOT bloqueado, o único admin restante não pode ser rebaixado.
  const ultimo = await store.insertUser(novo("dora", "admin"), []);
  await store.updateUser(rootId!, { status: "blocked" });
  assert.equal(await store.countApprovedAdmins(), 1);
  assert.deepEqual(await store.updateRole(ultimo, "gestor", { actorId: rootId! }), { ok: false, reason: "last_admin" });
  assert.equal((await store.findUserById(ultimo))?.role, "admin");
  await store.updateUser(rootId!, { status: "approved" });
  assert.ok((await store.updateRole(ultimo, "gestor", { actorId: rootId! })).ok);

  // listUsers expõe is_root e a versão.
  const lista = await store.listUsers();
  assert.equal(lista.find((u) => u.id === rootId)?.is_root, true);
  assert.equal(lista.find((u) => u.id === userId)?.permissoes_versao, 3);
  return { rootId: rootId!, userId };
}

test("store em memória: RBAC por usuário (ROOT, troca atômica, versão, perfil, último admin)", async (t) => {
  withBootstrapPassword(t);
  await exerciseStore(createAuthStore(readConfig()));
});

// ---------------------------------------------------------------- pool simulado (transação)

/** Registra o que cada conexão executou; `updateAffected` simula o UPDATE condicional da versão. */
function recordingPool(opts: { updateAffected: number; failOn?: RegExp }) {
  const log: string[] = [];
  let conns = 0;
  const pool = {
    getConnection: async () => {
      const c = ++conns;
      return {
        beginTransaction: async () => void log.push(`${c}:BEGIN`),
        commit: async () => void log.push(`${c}:COMMIT`),
        rollback: async () => void log.push(`${c}:ROLLBACK`),
        release: () => undefined,
        query: async (q: { sql: string } | string) => {
          const sql = (typeof q === "string" ? q : q.sql).replace(/\s+/g, " ").trim();
          log.push(`${c}:${sql.slice(0, 40)}`);
          if (opts.failOn?.test(sql)) throw Object.assign(new Error("boom"), { code: "ER_LOCK_WAIT_TIMEOUT" });
          if (sql.startsWith("UPDATE usuarios SET permissoes_versao")) return { affectedRows: opts.updateAffected };
          if (sql.startsWith("SELECT u.id, u.permissoes_versao")) return [{ id: 7, permissoes_versao: 3, permissoes_alterado_por: 1, alterado_por_nome: "Root", permissoes_alterado_em: "2026-10-08T10:00:00Z" }];
          if (sql.startsWith("SELECT recurso FROM usuario_permissoes")) return [{ recurso: "financeiro:ver" }];
          if (sql.startsWith("DELETE") || sql.startsWith("INSERT")) return { affectedRows: 1 };
          return [];
        },
      };
    },
  } as unknown as Pool;
  return { pool, log };
}

test("store MariaDB: troca de permissões roda numa transação só; conflito faz ROLLBACK sem DELETE", async () => {
  const ok = recordingPool({ updateAffected: 1 });
  const res = await createAuthStore(readConfig(), ok.pool).replacePermissions(7, ["financeiro:ver"], { actorId: 1, expectedVersion: 2 });
  assert.ok(res.ok);
  assert.ok(ok.log.every((l) => l.startsWith("1:")), "tudo na mesma conexão");
  assert.equal(ok.log[0], "1:BEGIN");
  assert.equal(ok.log.at(-1), "1:COMMIT");
  assert.ok(ok.log.some((l) => l.includes("DELETE FROM usuario_permissoes")));
  assert.ok(ok.log.some((l) => l.includes("INSERT INTO usuario_permissoes")));

  const conflict = recordingPool({ updateAffected: 0 });
  const res2 = await createAuthStore(readConfig(), conflict.pool).replacePermissions(7, [], { actorId: 1, expectedVersion: 2 });
  assert.ok(!res2.ok && res2.reason === "version_conflict" && res2.current.version === 3);
  assert.equal(conflict.log.at(-1), "1:ROLLBACK");
  assert.ok(!conflict.log.some((l) => l.includes("DELETE")));

  const falha = recordingPool({ updateAffected: 1, failOn: /^INSERT INTO usuario_permissoes/ });
  await assert.rejects(
    createAuthStore(readConfig(), falha.pool).replacePermissions(7, ["a:ver"], { actorId: 1 }),
    (e: unknown) => e instanceof PublicError && e.status === 503,
  );
  assert.equal(falha.log.at(-1), "1:ROLLBACK");
  assert.ok(!falha.log.includes("1:COMMIT"));
});

// ---------------------------------------------------------------- MariaDB real (opcional)
// Só roda com um banco DESCARTÁVEL: AUTH_TEST_DB_HOST/PORT/USER/PASSWORD e AUTH_TEST_DB_NAME
// terminando em "_test" (as tabelas de auth dele são apagadas). Ex. local:
//   podman run -d --name rbac-test-db -e MARIADB_ROOT_PASSWORD=testpw -p 127.0.0.1:33099:3306 mariadb:11.4
//   AUTH_TEST_DB_HOST=127.0.0.1 AUTH_TEST_DB_PORT=33099 AUTH_TEST_DB_USER=root AUTH_TEST_DB_PASSWORD=testpw \
//   AUTH_TEST_DB_NAME=auth_store_test npx tsx --test test/auth-store.test.ts

const dbName = process.env.AUTH_TEST_DB_NAME ?? "";
const realDb = Boolean(process.env.AUTH_TEST_DB_HOST) && /^[a-z0-9_]+_test$/.test(dbName);

test("store MariaDB real: DDL do bootstrap, troca atômica e corridas", { skip: !realDb && "AUTH_TEST_DB_* não definido" }, async (t) => {
  withBootstrapPassword(t);
  const admin = await mariadb.createConnection({
    host: process.env.AUTH_TEST_DB_HOST,
    port: Number(process.env.AUTH_TEST_DB_PORT || 3306),
    user: process.env.AUTH_TEST_DB_USER,
    password: process.env.AUTH_TEST_DB_PASSWORD,
  });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  for (const tb of ["usuario_alteracoes_pendentes", "usuario_sessoes", "usuario_permissoes", "usuarios"]) {
    await admin.query(`DROP TABLE IF EXISTS \`${dbName}\`.\`${tb}\``);
  }
  await admin.end();
  const pool = mariadb.createPool({
    host: process.env.AUTH_TEST_DB_HOST,
    port: Number(process.env.AUTH_TEST_DB_PORT || 3306),
    user: process.env.AUTH_TEST_DB_USER,
    password: process.env.AUTH_TEST_DB_PASSWORD,
    database: dbName,
    connectionLimit: 8,
  });
  t.after(() => pool.end());
  const store = createAuthStore(readConfig(), pool);
  const { rootId, userId } = await exerciseStore(store);

  // Corrida de dois editores com a mesma versão: exatamente um grava, o outro recebe conflito.
  const v = (await store.getPermissionState(userId))!.version;
  const [a, b] = await Promise.all([
    store.replacePermissions(userId, ["a:ver"], { actorId: rootId, expectedVersion: v }),
    store.replacePermissions(userId, ["b:ver"], { actorId: rootId, expectedVersion: v }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].filter((r) => !r.ok && r.reason === "version_conflict").length, 1);
  const final = (await store.getPermissionState(userId))!;
  assert.equal(final.version, v + 1);
  assert.equal(final.grants.length, 1);

  // Dois admins se rebaixando ao mesmo tempo (ROOT bloqueado): sobra pelo menos um admin.
  const x = await store.insertUser(novo("xavier", "admin"), []);
  const y = await store.insertUser(novo("yara", "admin"), []);
  await store.updateUser(rootId, { status: "blocked" });
  const outros = (await store.listUsers()).filter((u) => u.role === "admin" && u.status === "approved" && u.id !== x && u.id !== y);
  for (const o of outros) await store.updateRole(o.id, "user", { actorId: rootId });
  const corrida = await Promise.allSettled([
    store.updateRole(x, "user", { actorId: rootId, replaceGrants: [] }),
    store.updateRole(y, "user", { actorId: rootId, replaceGrants: [] }),
  ]);
  assert.ok(await store.countApprovedAdmins() >= 1, JSON.stringify(corrida));
  await store.updateUser(rootId, { status: "approved" });

  // Criação com permissões: falha no meio (chave longa demais p/ VARCHAR(100)) não deixa nada.
  await assert.rejects(store.insertUser(novo("zeca"), ["ok:ver", "x".repeat(150)]), (e: unknown) => e instanceof PublicError && e.status === 503);
  assert.equal(await store.findUserIdByUsername("zeca"), null);
});
