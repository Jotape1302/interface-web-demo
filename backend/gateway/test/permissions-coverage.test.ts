import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FREE_FOR_LOGGED_IN, ROUTE_RULES, routeAccess } from "../src/permissions.js";

// Cobertura do mapa rota + método → (aba, ação): lê as rotas declaradas em src/routes/*.ts e
// falha se alguma não tiver regra em permissions.ts (ROUTE_RULES). Rota sem regra é negada pelo
// servidor (404) — este teste é o aviso para quem criou a rota de que falta mapeá-la.

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

/** Exemplo concreto para um padrão de rota (regex ou template literal). */
function samplesFor(pattern: string): string[] {
  let p = pattern.replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "");
  p = p
    .replace(/\(?\$\{ID_PATTERN\}\)?/g, "j1")
    .replace(/\(\\d\+\)/g, "7")
    .replace(/\(\[a-f0-9\]\{24\}\)/g, "a".repeat(24))
    .replace(/\(\[\\w-\]\+\)/g, "abc")
    .replace(/\(\[A-Za-z0-9-\]\{1,64\}\)/g, "j1")
    .replace(/\(\[a-z-\]\{1,32\}\)/g, "vendas");
  const alt = /\(([a-z]+(?:\|[a-z]+)+)\)/.exec(p);
  if (alt) return alt[1]!.split("|").flatMap((v) => samplesFor(p.replace(alt[0], v)));
  return [p];
}

/** Rotas (método + caminho de exemplo) declaradas num módulo de rotas. */
function declaredRoutes(file: string, src: string): Array<{ method: string; path: string; where: string }> {
  const out: Array<{ method: string; path: string; where: string }> = [];
  const lines = src.split("\n");
  const patterns: RegExp[] = [
    /path === "(\/api\/[^"]+)"/g,
    /path !== "(\/api\/[^"]+)"/g,
    /path\.match\(\/(\^\\\/api[^/]*(?:\\\/[^/]*)*\$)\/\)/g,
    /\/(\^\\\/api\\\/[^\s]*?\$)\/\.exec\(path\)/g,
    /new RegExp\(`(\^\/api\/[^`]+\$)`\)/g,
  ];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const window = `${line}\n${lines[i + 1] ?? ""}`;
    const methods = [...window.matchAll(/method (?:===|!==) "([A-Z]+)"/g)].map((m) => m[1]!);
    // `const xMatch = path.match(...)`: o método vem de cada `if (xMatch ... && method === "X")` do módulo.
    const varName = /const (\w+) = /.exec(line)?.[1];
    if (varName) {
      const uses = new RegExp(`\\b${varName}\\b[^\\n]*?method === "([A-Z]+)"`, "g");
      methods.push(...[...src.matchAll(uses)].map((m) => m[1]!));
    }
    for (const re of patterns) {
      for (const m of line.matchAll(re)) {
        const ms = methods.length ? [...new Set(methods)] : (OVERRIDES[`${file} ${m[1]}`] ?? ["?"]);
        for (const method of ms) for (const path of samplesFor(m[1]!)) out.push({ method, path, where: `${file}:${i + 1}` });
      }
    }
  });
  return out;
}

/** Rotas sem `method ===` na mesma linha (o método é checado de outro jeito no módulo). */
const OVERRIDES: Record<string, string[]> = {
  "dashboard.ts /api/accounts-payable/dashboard": ["GET"],
  "dashboard.ts /api/overview": ["GET"],
  "health.ts /api/health": ["GET"],
};

// Rotas montadas dinamicamente (proxy do marketplace e detalhes de health): lista explícita.
const DYNAMIC: Array<{ method: string; path: string }> = [
  ...["status", "anuncios", "desfeitos", "historico", "avisos"].map((s) => ({ method: "GET", path: `/api/marketplace/fretes/${s}` })),
  ...["retentar", "executar"].map((s) => ({ method: "POST", path: `/api/marketplace/fretes/${s}` })),
  ...["status", "produtos", "sem-sku"].map((s) => ({ method: "GET", path: `/api/marketplace/dimensoes/${s}` })),
  ...["validar", "reenviar", "executar"].map((s) => ({ method: "POST", path: `/api/marketplace/dimensoes/${s}` })),
  ...["circuits", "tiny", "inter", "n8n"].map((s) => ({ method: "GET", path: `/api/health/${s}` })),
];

/** Sempre liberados a qualquer logado, fora do catálogo (A.5 + catálogo do editor). */
const EXPECTED_FREE = [
  "GET /api/auth/me",
  "PATCH /api/auth/profile",
  "GET /api/auth/username-available",
  "GET /api/auth/email-available",
  "POST /api/auth/change-username",
  "POST /api/auth/change-email",
  "POST /api/auth/change-password",
  "GET /api/events",
  "GET /api/chat/contacts",
  "GET /api/chat/conversations",
  "GET /api/chat/unread-count",
  "POST /api/chat/messages",
  "GET /api/chat/messages/2",
  "POST /api/chat/messages/2/read",
  "GET /api/notifications",
  "GET /api/notifications/unread-count",
  "POST /api/notifications/read-all",
  "POST /api/notifications/1/read",
  "GET /api/admin/permissions/catalog",
];

test("toda rota /api declarada em src/routes tem regra de acesso (negar por padrão)", () => {
  const all: Array<{ method: string; path: string; where: string }> = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
    all.push(...declaredRoutes(file, readFileSync(join(ROUTES_DIR, file), "utf8")));
  }
  all.push(...DYNAMIC.map((d) => ({ ...d, where: "dinâmica" })));
  assert.ok(all.length >= 70, `poucas rotas encontradas (${all.length}): o leitor de rotas quebrou?`);
  const semMetodo = all.filter((r) => r.method === "?");
  assert.deepEqual(semMetodo, [], "rota sem método identificável: acrescente em OVERRIDES");
  const semRegra = all.filter((r) => routeAccess(r.method, r.path).kind === "none");
  assert.deepEqual(semRegra, [], "rota sem regra em permissions.ts (ROUTE_RULES)");

  // E o contrário: toda regra corresponde a uma rota que existe (sem regra órfã).
  const declared = new Set(all.map((r) => `${r.method} ${r.path}`));
  const orfas = ROUTE_RULES.filter((r) => ![...declared].some((d) => {
    const [m, ...rest] = d.split(" ");
    const path = rest.join(" ");
    return m === r.method && (typeof r.path === "string" ? r.path === path : r.path.test(path));
  }));
  assert.deepEqual(orfas.map((r) => `${r.method} ${r.sample}`), []);
});

test("regras: exemplo de cada regra resolve para ela; HEAD segue o GET; métodos não mapeados são negados", () => {
  for (const r of ROUTE_RULES) assert.deepEqual(routeAccess(r.method, r.sample), r.access, `${r.method} ${r.sample}`);
  assert.equal(routeAccess("HEAD", "/api/overview").kind, "perm");
  for (const [m, p] of [
    ["PUT", "/api/marketplace/fretes/anuncios"],
    ["DELETE", "/api/overview"],
    ["POST", "/api/marketplace/dimensoes/apagar"],
    ["GET", "/api/admin/qualquer"],
    ["GET", "/api/nao-existe"],
  ] as const) {
    assert.equal(routeAccess(m, p).kind, "none", `${m} ${p}`);
  }
});

test("lista explícita de rotas livres para qualquer logado (Início, Chat, perfil, notificações, eventos)", () => {
  assert.deepEqual([...FREE_FOR_LOGGED_IN].sort(), [...EXPECTED_FREE].sort());
  // Emissão manual de notificação e troca de perfil: só Admin, fora do catálogo.
  assert.equal(routeAccess("POST", "/api/notifications/emit").kind, "admin");
  assert.equal(routeAccess("PUT", "/api/admin/users/3/role").kind, "admin");
});

test("RBAC: análise consolidada da conciliação ML (ID com sublinhado) tem regra de acesso", () => {
  // A rota aceita `_` no ID; se a regra do RBAC não aceitar, o gateway responde 404 antes da rota.
  for (const path of [
    "/api/ml-reconciliation/analises/consolidado_norvia_campinas",
    "/api/ml-reconciliation/analises/consolidado_revesta/arquivos/vendas",
  ]) {
    assert.deepEqual(routeAccess("GET", path), { kind: "perm", key: "conciliacao_ml:ver" }, path);
  }
});
