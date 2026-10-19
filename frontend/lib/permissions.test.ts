import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_PERMISSION_CATALOG as CAT } from "./demo-permissions";
import {
  addedRiskActions,
  areaSummary,
  canUncheckView,
  ceilingFor,
  cleanUsername,
  countGrants,
  creatableRoles,
  diffGrants,
  fieldFromApiError,
  firstInvalidField,
  grantsForRole,
  hasNoAccess,
  hasPermission,
  targetPolicy,
  toggleAction,
  toggleArea,
  toggleView,
  validateNewUser,
  visibleKeys,
  visibleTabs,
  type PermissionTab,
} from "./permissions";

const tabOf = (id: string): PermissionTab => CAT.tabs.find((t) => t.id === id)!;
const sorted = (s: Iterable<string>) => [...s].sort();

void test("hasPermission: Admin tem tudo; demais só o concedido", () => {
  assert.equal(hasPermission({ role: "admin", permissions: [] }, "revisao_nfe:forcar_varredura"), true);
  assert.equal(hasPermission({ role: "user", permissions: ["contas_pagar:ver"] }, "contas_pagar:ver"), true);
  assert.equal(hasPermission({ role: "user", permissions: ["contas_pagar:ver"] }, "contas_pagar:baixar"), false);
  assert.equal(hasPermission(null, "contas_pagar:ver"), false);
});

void test("ações de Gestão de Usuários só aparecem quando o alvo é Gestor", () => {
  assert.equal(visibleTabs(CAT, "user").some((t) => t.area === "usuarios"), false);
  assert.equal(visibleKeys(CAT, "user").some((k) => k.startsWith("usuarios:")), false);
  assert.equal(visibleTabs(CAT, "gestor").some((t) => t.area === "usuarios"), true);
  assert.equal(visibleKeys(CAT, "gestor").filter((k) => k.startsWith("usuarios:")).length, 9);
  // Gestor → User perde as chaves de Gestão de Usuários.
  assert.deepEqual(grantsForRole(CAT, ["usuarios:ver", "contas_pagar:ver"], "user"), ["contas_pagar:ver"]);
});

void test("'ver' é pré-requisito: marcar ação marca ver; desmarcar ver desmarca ações", () => {
  const cp = tabOf("contas_pagar");
  let v = toggleAction(new Set(), cp, "contas_pagar:baixar", true);
  assert.deepEqual(sorted(v), ["contas_pagar:baixar", "contas_pagar:ver"]);
  // Desmarcar a última ação não mexe no ver.
  v = toggleAction(v, cp, "contas_pagar:baixar", false);
  assert.deepEqual(sorted(v), ["contas_pagar:ver"]);
  v = toggleAction(v, cp, "contas_pagar:importar_extrato", true);
  v = toggleView(v, cp, false);
  assert.deepEqual(sorted(v), []);
  v = toggleView(v, cp, true);
  assert.deepEqual(sorted(v), ["contas_pagar:ver"]);
});

void test("Marcar tudo marca a área sem as ações de risco; de novo, desmarca", () => {
  let v = toggleArea(CAT, new Set(), "financeiro", "user");
  assert.equal(v.has("revisao_nfe:forcar_varredura"), false);
  assert.equal(v.has("dashboard_financeiro:forcar_sincronizacao"), false);
  assert.equal(v.has("revisao_nfe:lancar"), true);
  assert.equal(v.has("fin_visao_geral:ver"), true);
  const s = areaSummary(CAT, v, "financeiro", "user");
  assert.equal(s.bulk, "all");
  assert.equal(s.total, 17);
  assert.equal(s.checked, 15);
  v.add("revisao_nfe:forcar_varredura");
  v = toggleArea(CAT, v, "financeiro", "user");
  assert.equal(v.size, 0);
  assert.equal(areaSummary(CAT, toggleView(new Set(), tabOf("contas_pagar"), true), "financeiro", "user").bulk, "some");
});

void test("teto do Gestor: fora do teto fica travado (não concede nem revoga)", () => {
  const gestor = { role: "gestor" as const, permissions: ["contas_pagar:ver", "contas_pagar:baixar"] };
  const ceiling = ceilingFor(gestor);
  const cp = tabOf("contas_pagar");
  // Não concede o que não tem.
  let v = toggleAction(new Set(), cp, "contas_pagar:importar_extrato", true, ceiling);
  assert.equal(v.size, 0);
  // Concede o que tem.
  v = toggleAction(v, cp, "contas_pagar:baixar", true, ceiling);
  assert.deepEqual(sorted(v), ["contas_pagar:baixar", "contas_pagar:ver"]);
  // Alvo já tinha uma ação fora do teto: ver não pode ser desmarcado e a ação fica.
  const alvo = new Set(["contas_pagar:ver", "contas_pagar:importar_extrato"]);
  assert.equal(canUncheckView(alvo, cp, ceiling), false);
  assert.deepEqual(sorted(toggleView(alvo, cp, false, ceiling)), sorted(alvo));
  assert.deepEqual(sorted(toggleAction(alvo, cp, "contas_pagar:importar_extrato", false, ceiling)), sorted(alvo));
  // Marcar tudo do Gestor atua só no teto.
  const all = toggleArea(CAT, new Set(), "financeiro", "user", ceiling);
  assert.deepEqual(sorted(all), ["contas_pagar:baixar", "contas_pagar:ver"]);
  // Desmarcar tudo preserva o travado e o ver de que ele depende.
  const off = toggleArea(CAT, new Set([...alvo, "contas_pagar:baixar"]), "financeiro", "user", ceiling);
  assert.deepEqual(sorted(off), sorted(alvo));
  assert.equal(ceilingFor({ role: "admin", permissions: [] }), null);
});

void test("diferença e ações de risco concedidas", () => {
  const d = diffGrants(CAT, ["contas_pagar:ver", "erros:ver"], ["contas_pagar:ver", "revisao_nfe:ver", "revisao_nfe:forcar_varredura"]);
  assert.deepEqual(d.added, ["revisao_nfe:ver", "revisao_nfe:forcar_varredura"]);
  assert.deepEqual(d.removed, ["erros:ver"]);
  assert.deepEqual(
    addedRiskActions(CAT, [], ["revisao_nfe:ver", "revisao_nfe:forcar_varredura"]).map((a) => a.key),
    ["revisao_nfe:forcar_varredura"],
  );
  assert.deepEqual(countGrants(["contas_pagar:ver", "contas_pagar:baixar", "erros:ver"]), { tabs: 2, actions: 1 });
  assert.equal(hasNoAccess("user", { tabs: 0, actions: 0 }), true);
  assert.equal(hasNoAccess("admin", { tabs: 0, actions: 0 }), false);
});

void test("Gestor não tem controles sobre Admin/Gestor; Admin não mexe no ROOT nem em si", () => {
  const gestor = {
    id: 2,
    role: "gestor" as const,
    permissions: ["usuarios:ver", "usuarios:editar_permissoes", "usuarios:excluir", "usuarios:derrubar_sessao", "usuarios:alterar_setor"],
  };
  for (const role of ["admin", "gestor"] as const) {
    const p = targetPolicy(gestor, { id: 9, role, is_root: false });
    assert.equal(p.canChangeRole || p.canEditPermissions || p.canDelete || p.canForceLogout || p.canChangeSetor || p.canReviewChange, false);
    assert.equal(p.permissionsReadOnlyReason, "só o administrador altera Gestores e Administradores.");
  }
  const sobreUser = targetPolicy(gestor, { id: 9, role: "user", is_root: false });
  assert.equal(sobreUser.canEditPermissions, true);
  assert.equal(sobreUser.canDelete, true);
  assert.equal(sobreUser.canReviewChange, false);
  assert.equal(sobreUser.canChangeRole, false);
  assert.deepEqual(creatableRoles(gestor), ["user"]);

  const admin = { id: 1, role: "admin" as const, permissions: [] };
  const root = targetPolicy(admin, { id: 5, role: "admin", is_root: true });
  assert.equal(root.canChangeRole || root.canDelete || root.canForceLogout || root.canChangeSetor, false);
  const self = targetPolicy(admin, { id: 1, role: "admin", is_root: true });
  assert.equal(self.canChangeRole, false);
  assert.equal(self.canChangeSetor, true);
  const outroAdmin = targetPolicy(admin, { id: 7, role: "admin", is_root: false });
  assert.equal(outroAdmin.canChangeRole, true);
  assert.equal(outroAdmin.canEditPermissions, false);
  assert.deepEqual(creatableRoles(admin), ["user", "gestor", "admin"]);
  const userSelf = targetPolicy({ id: 3, role: "user", permissions: [] }, { id: 3, role: "user", is_root: false });
  assert.equal(userSelf.permissionsReadOnlyReason, "você não pode alterar as próprias permissões.");
});

void test("Novo usuário: validação por campo, foco no primeiro inválido e username limpo", () => {
  const errors = validateNewUser({ nome: "", username: "!!", email: "x", setor: "", senha: "123" });
  assert.deepEqual(Object.keys(errors).sort(), ["email", "nome", "senha", "setor", "username"]);
  assert.equal(firstInvalidField(errors), "nome");
  assert.equal(firstInvalidField({ senha: "x", email: "y" }), "email");
  assert.deepEqual(validateNewUser({ nome: "João", username: "joao.pedro", email: "j@h.com", setor: "T.I", senha: "1234567890" }), {});
  assert.equal(cleanUsername("  João Pedro! "), "joaopedro");
  assert.equal(cleanUsername("Joao.Pedro_1"), "joao.pedro_1");
});

void test("mapeamento do field dos erros 400/409 do gateway para o campo do formulário", () => {
  assert.equal(fieldFromApiError({ code: "validation", field: "email" }), "email");
  assert.equal(fieldFromApiError({ code: "weak_password" }), "senha");
  assert.equal(fieldFromApiError({ code: "weak_password", field: "novaSenha" }), "senha");
  assert.equal(fieldFromApiError({ code: "duplicate", field: "username" }), "username");
  assert.equal(fieldFromApiError({ code: "duplicate", error: "Este e-mail já está cadastrado." }), "email");
  assert.equal(fieldFromApiError({ code: "duplicate", error: 'O nome de usuário "x" já está cadastrado.' }), "username");
  assert.equal(fieldFromApiError({ code: "action_requires_view" }), "grants");
  assert.equal(fieldFromApiError({ code: "role_forbidden", field: "role" }), "role");
  assert.equal(fieldFromApiError({ code: "validation", field: "expectedVersion" }), null);
  assert.equal(fieldFromApiError({ code: "forbidden" }), null);
  assert.equal(fieldFromApiError(null), null);
});
