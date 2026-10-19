import assert from "node:assert/strict";
import test from "node:test";
import {
  AREAS,
  accessibleAreas,
  canAccessArea,
  canAccessPage,
  canSeeAdministration,
  visibleAreaPages,
  visibleSystemPages,
} from "./areas";
import { DEMO_PERMISSION_CATALOG } from "./demo-permissions";
import type { PermissionSession } from "./permissions";

const ADMIN: PermissionSession = { role: "admin", permissions: [] };
const SEM_NADA: PermissionSession = { role: "user", permissions: [] };
const FIN: PermissionSession = { role: "user", permissions: ["contas_pagar:ver", "contas_pagar:baixar", "erros:ver"] };
const GESTOR: PermissionSession = { role: "gestor", permissions: ["fin_visao_geral:ver", "usuarios:ver"] };

void test("Admin vê todas as áreas, o bloco SISTEMA inteiro e a Administração", () => {
  assert.deepEqual(accessibleAreas(ADMIN).map((a) => a.id), ["financeiro", "logistica", "marketplace", "producao"]);
  for (const a of AREAS) assert.deepEqual(visibleAreaPages(ADMIN, a.id), [...a.pages]);
  assert.deepEqual(visibleSystemPages(ADMIN), ["admin-errors", "admin-health", "admin-audit", "admin-tokens"]);
  assert.equal(canSeeAdministration(ADMIN), true);
});

void test("User sem nenhuma permissão vê só Início e Chat", () => {
  assert.deepEqual(accessibleAreas(SEM_NADA), []);
  assert.deepEqual(visibleSystemPages(SEM_NADA), []);
  assert.equal(canSeeAdministration(SEM_NADA), false);
  assert.equal(canAccessPage(SEM_NADA, "home"), true);
  assert.equal(canAccessPage(SEM_NADA, "chat"), true);
  assert.equal(canAccessPage(SEM_NADA, "accounts-payable"), false);
});

void test("menu e páginas seguem o 'ver' de cada aba; o setor não dá acesso", () => {
  assert.deepEqual(accessibleAreas(FIN).map((a) => a.id), ["financeiro"]);
  // Só a aba liberada aparece na pasta (a Visão geral também é uma aba).
  assert.deepEqual(visibleAreaPages(FIN, "financeiro"), ["accounts-payable"]);
  assert.equal(canAccessArea(FIN, "logistica"), false);
  assert.deepEqual(visibleSystemPages(FIN), ["admin-errors"]);
  assert.equal(canAccessPage(FIN, "admin-users"), false);
  // Objeto com setor "Diretoria" sem permissões continua sem nada.
  const diretoria = { role: "user" as const, permissions: [] as string[], setor: "Diretoria" };
  assert.deepEqual(accessibleAreas(diretoria), []);
  assert.equal(canAccessArea(null, "financeiro"), false);
});

void test("Gestor com ver da Gestão de Usuários vê o bloco ADMINISTRAÇÃO", () => {
  assert.equal(canSeeAdministration(GESTOR), true);
  assert.deepEqual(visibleAreaPages(GESTOR, "financeiro"), ["financeiro-overview"]);
});

void test("toda página com chave aponta para um 'ver' que existe no catálogo", async () => {
  const { PAGE_VIEW_KEY } = await import("./areas");
  const keys = new Set(DEMO_PERMISSION_CATALOG.tabs.flatMap((t) => t.actions.map((a) => a.key)));
  for (const key of Object.values(PAGE_VIEW_KEY)) assert.ok(keys.has(key!), key);
});
