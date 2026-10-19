import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Pool } from "mariadb";
import { readConfig } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createDashboardService } from "../src/service.js";
import { createApi } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { PublicError } from "../src/errors.js";

// Botão "Novo Usuário" do painel admin (frontend/app/components/admin-user-modals.tsx):
// POST /api/admin/users com { nome, username, email, setor, senha, role }.

const ADMIN_PASS = "test-admin-bootstrap-password";
const ORIGIN = "http://localhost:3000";
// Mesma lista de frontend/lib/contracts.ts (SETORES), que alimenta o <select> do modal.
const SETORES_DO_MODAL = [
  "Financeiro",
  "Logística",
  "Diretoria",
  "Marketing",
  "T.I",
  "Vendas",
  "RH",
  "E-Commerce",
  "SAC",
  "Produção",
];

test("Novo Usuário (demo): payload exato do modal cria o usuário (201) e ele consegue entrar", async (t) => {
  const prev = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = ADMIN_PASS;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = prev;
  });
  const config = readConfig();
  const auth = createAuthService(config);
  await auth.bootstrap();
  const demo = createDemo();
  const server = createApi(config, { dashboard: createDashboardService("demo", demo.database, demo.n8n), auth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  const base = `http://127.0.0.1:${a.port}`;

  const login = (l: string, senha: string) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ login: l, senha }),
    });
  const adminToken = ((await (await login("admin_jp", ADMIN_PASS)).json()) as any).token as string;
  assert.ok(adminToken);

  // Mesmos headers de handleCreateUser (page.tsx) + os que o interceptor global acrescenta.
  const create = (payload: Record<string, unknown>) =>
    fetch(`${base}/api/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
        "x-session-token": adminToken,
        Origin: ORIGIN,
      },
      body: JSON.stringify(payload),
    });

  for (const [i, setor] of SETORES_DO_MODAL.entries()) {
    const payload = {
      nome: `Colaborador ${i}`,
      username: `colab.${i}`,
      email: `Colab.${i}@norvia.example`,
      setor,
      senha: "senha-forte-10",
      role: i % 2 === 0 ? "user" : "admin",
    };
    const res = await create(payload);
    const body = (await res.json()) as any;
    assert.equal(res.status, 201, `setor ${setor}: ${JSON.stringify(body)}`);
    assert.equal(body.username, `colab.${i}`);
    assert.equal(body.email, `colab.${i}@norvia.example`);
    assert.equal(body.setor, setor);
    assert.equal(body.status, "approved");
    assert.equal((await login(`colab.${i}`, "senha-forte-10")).status, 200, `login do criado no setor ${setor}`);
  }

  // Duplicado: 400 com mensagem legível (não 500).
  const dup = await create({ nome: "X", username: "colab.0", email: "outro@norvia.example", setor: "RH", senha: "senha-forte-10", role: "user" });
  assert.equal(dup.status, 400);
  assert.match(((await dup.json()) as any).error, /já está cadastrado/);
});

// ---------------------------------------------------------------- caminho MariaDB (pool simulado)

/**
 * MariaDB de mentira, só o suficiente para createUser: guarda as linhas de `usuarios` e
 * `usuario_permissoes`, respeita transação por conexão (beginTransaction/commit/rollback) e
 * DELETE de compensação — qualquer uma das correções possíveis passa por aqui.
 * `failPermissionInserts` faz os próximos N INSERT em usuario_permissoes falharem, como um
 * erro do banco no meio do cadastro (timeout, conexão caída, FK, etc.).
 */
function fakeMariaDb() {
  const usuarios = new Map<number, Record<string, unknown>>();
  const permissoes: Array<{ usuario_id: number; recurso: string }> = [];
  let nextId = 2;
  const state = { failPermissionInserts: 0 };

  const pool = {
    getConnection: async () => {
      let tx: Array<() => void> | null = null;
      const apply = (fn: () => void) => (tx ? tx.push(fn) : fn());
      const conn = {
        beginTransaction: async () => {
          tx = [];
        },
        commit: async () => {
          for (const fn of tx ?? []) fn();
          tx = null;
        },
        rollback: async () => {
          tx = null;
        },
        release: () => undefined,
        end: async () => undefined,
        query: async (q: string | { sql: string }, values: unknown[] = []) => {
          const sql = (typeof q === "string" ? q : q.sql).replace(/\s+/g, " ").trim();
          if (/^(START TRANSACTION|BEGIN)/i.test(sql)) return conn.beginTransaction();
          if (/^COMMIT/i.test(sql)) return conn.commit();
          if (/^ROLLBACK/i.test(sql)) return conn.rollback();
          // Seed do admin já feito: bootstrap não insere nada.
          if (sql.startsWith("SELECT id FROM usuarios WHERE email = ? OR username = ?")) return [{ id: 1 }];
          if (sql.startsWith("SELECT id FROM usuarios WHERE username = ?")) {
            const hit = [...usuarios.values()].find((u) => u.username === values[0]);
            return hit ? [{ id: hit.id }] : [];
          }
          if (sql.startsWith("SELECT id FROM usuarios WHERE email = ?")) {
            const hit = [...usuarios.values()].find((u) => u.email === values[0]);
            return hit ? [{ id: hit.id }] : [];
          }
          if (sql.startsWith("INSERT INTO usuarios")) {
            const id = nextId++;
            const [username, nome, email, setor, password_hash, salt, role, status] = values;
            apply(() => usuarios.set(id, { id, username, nome, email, setor, password_hash, salt, role, status }));
            return { insertId: id, affectedRows: 1 };
          }
          if (sql.startsWith("INSERT INTO usuario_permissoes")) {
            if (state.failPermissionInserts > 0) {
              state.failPermissionInserts--;
              throw Object.assign(new Error("Connection timeout"), { code: "ER_GET_CONNECTION_TIMEOUT" });
            }
            const rows = sql.includes("VALUES (?, ?, TRUE)") && values.length === 2
              ? [{ usuario_id: Number(values[0]), recurso: String(values[1]) }]
              : chunk(values, 2).map(([u, r]) => ({ usuario_id: Number(u), recurso: String(r) }));
            apply(() => permissoes.push(...rows));
            return { affectedRows: rows.length };
          }
          if (sql.startsWith("DELETE FROM usuario_permissoes WHERE usuario_id = ?")) {
            apply(() => {
              for (let i = permissoes.length - 1; i >= 0; i--) if (permissoes[i]!.usuario_id === Number(values[0])) permissoes.splice(i, 1);
            });
            return { affectedRows: 1 };
          }
          if (sql.startsWith("DELETE FROM usuarios WHERE id = ?")) {
            apply(() => usuarios.delete(Number(values[0])));
            return { affectedRows: 1 };
          }
          // CREATE TABLE / ALTER / UPDATE do init e o que mais não importar aqui.
          return [];
        },
      };
      return conn;
    },
  } as unknown as Pool;
  return { pool, usuarios, permissoes, state };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

test("Novo Usuário (MariaDB): falha ao gravar permissões não deixa usuário criado pela metade", async () => {
  const { pool, usuarios, permissoes, state } = fakeMariaDb();
  const auth = createAuthService(readConfig(), pool);
  const payload = {
    nome: "Maria Teste",
    username: "maria.teste",
    email: "maria.teste@norvia.example",
    setor: "Financeiro",
    senha: "senha-forte-10",
    role: "user",
    // RBAC por usuário: nada nasce marcado; o admin envia o conjunto explícito (5 chaves do catálogo,
    // equivalentes às 5 permissões padrão antigas), gravado na mesma transação do usuário.
    grants: [
      "fin_visao_geral:ver",
      "contas_pagar:ver",
      "conciliacao_ml:ver",
      "revisao_nfe:ver",
      "dashboard_financeiro:ver",
    ],
  };

  // 1ª tentativa: o banco falha no meio (depois do INSERT em usuarios). O admin vê erro.
  state.failPermissionInserts = 1;
  await assert.rejects(auth.createUser(payload), (e: unknown) => e instanceof PublicError && e.status === 503);

  // Nada pode ter ficado gravado: nem usuário sem permissões, nem permissões soltas.
  assert.equal(
    [...usuarios.values()].filter((u) => u.email === payload.email).length,
    0,
    "usuário ficou em `usuarios` sem as permissões padrão (INSERTs sem transação em createDbStore.insertUser)",
  );
  assert.equal(permissoes.length, 0);

  // 2ª tentativa, com o banco normal: tem que criar — não "O nome de usuário ... já está cadastrado."
  const created = await auth.createUser(payload);
  assert.equal(created.username, "maria.teste");
  assert.equal(permissoes.filter((p) => p.usuario_id === created.id).length, 5);
});
