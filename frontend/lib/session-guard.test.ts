import assert from "node:assert/strict";
import test from "node:test";
import {
  caminhoInterno,
  isDemoLoginAllowed,
  isProtectedApiUrl,
  linkExternoSeguro,
  shouldAttachSessionToken,
} from "./session-guard";

test("caminhoInterno aceita só caminhos internos", () => {
  assert.equal(caminhoInterno("/contas-a-pagar?x=1"), "/contas-a-pagar?x=1");
  assert.equal(caminhoInterno("/"), "/");
  assert.equal(caminhoInterno("//evil.com"), null);
  assert.equal(caminhoInterno("/\\evil.com"), null);
  assert.equal(caminhoInterno("/\\/evil.com"), null);
  assert.equal(caminhoInterno("/\t/evil.com"), null);
  assert.equal(caminhoInterno("https://evil.com"), null);
  assert.equal(caminhoInterno("javascript:alert(1)"), null);
  assert.equal(caminhoInterno(""), null);
  assert.equal(caminhoInterno(null), null);
});

test("rotas protegidas cobrem todo /api exceto health e login/cadastro", () => {
  for (const url of [
    "https://h/automacoes/api/overview",
    "http://localhost:3100/api/financial-dashboard/sync",
    "/automacoes/api/marketplace/fretes/anuncios?page=1",
    "/automacoes/api/marketplace/dimensoes/status",
    "/api/ml-reconciliation/status",
    "/api/notifications/unread-count",
    "/api/chat/messages/2",
    "/api/events",
    "/api/incidents",
    "/api/admin/users",
    "/api/auth/me",
    "/api/auth/change-password",
    "/api/accounts-payable/dashboard",
    "/api/danfe/status",
    "/api/reconciliation/jobs/abc",
  ]) {
    assert.equal(isProtectedApiUrl(url), true, url);
  }
  for (const url of [
    "/api/health",
    "/api/health/tiny",
    "/automacoes/api/auth/login",
    "/api/auth/register",
    "/automacoes/login/",
    "/automacoes/_next/static/chunk.js",
  ]) {
    assert.equal(isProtectedApiUrl(url), false, url);
  }
});

test("token só vai para a origem da API", () => {
  // API absoluta em outra porta (rede local)
  const lan = "http://192.168.50.20:3100";
  assert.equal(shouldAttachSessionToken("http://192.168.50.20:3100/api/overview", lan, "http://192.168.50.20:3001"), true);
  assert.equal(shouldAttachSessionToken("/automacoes/assets/logo.png", lan, "http://192.168.50.20:3001"), false);
  assert.equal(shouldAttachSessionToken("https://evil.example/x", lan, "http://192.168.50.20:3001"), false);
  // Atrás do NGINX: API na mesma origem, com path
  const prod = "https://servidor.norvia.example/automacoes";
  const page = "https://servidor.norvia.example";
  assert.equal(shouldAttachSessionToken("https://servidor.norvia.example/automacoes/api/danfe", prod, page), true);
  assert.equal(shouldAttachSessionToken("/automacoes/api/danfe", prod, page), true);
  assert.equal(shouldAttachSessionToken("https://servidor.norvia.example.evil.com/api", prod, page), false);
  assert.equal(shouldAttachSessionToken("http://servidor.norvia.example/automacoes/api", prod, page), false);
  // API relativa → própria origem da página
  assert.equal(shouldAttachSessionToken("/api/overview", "", "http://localhost:3000"), true);
  assert.equal(shouldAttachSessionToken("https://cdn.example/x.js", "/automacoes", "http://localhost:3000"), false);
  // Esquemas sem origem
  assert.equal(shouldAttachSessionToken("data:text/plain,oi", prod, page), false);
  assert.equal(shouldAttachSessionToken("blob:https://servidor.norvia.example/1", prod, page), true);
});

test("atalho demo só em build demo ou localhost", () => {
  assert.equal(isDemoLoginAllowed("demo", "servidor.norvia.example"), true);
  assert.equal(isDemoLoginAllowed("live", "localhost"), true);
  assert.equal(isDemoLoginAllowed(undefined, "127.0.0.1"), true);
  assert.equal(isDemoLoginAllowed("live", "servidor.norvia.example"), false);
  assert.equal(isDemoLoginAllowed(undefined, "192.168.50.20"), false);
});

test("linkExternoSeguro só deixa http(s)", () => {
  assert.equal(linkExternoSeguro("https://produto.mercadolivre.com.br/MLB-1"), "https://produto.mercadolivre.com.br/MLB-1");
  assert.equal(linkExternoSeguro("javascript:alert(1)"), undefined);
  assert.equal(linkExternoSeguro("data:text/html,x"), undefined);
  assert.equal(linkExternoSeguro("/relativo"), undefined);
  assert.equal(linkExternoSeguro(null), undefined);
});
