import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_DELAY_AFTER,
  createLoginThrottle,
  LOGIN_LOCK_MS,
  LOGIN_WINDOW_MS,
  MAX_ACCOUNT_DELAY_MS,
  MAX_FAILURES_PER_IP,
  MAX_FAILURES_PER_PAIR,
} from "../src/login-throttle.js";

test("bloqueia o par login+IP após MAX_FAILURES_PER_PAIR falhas e libera após LOGIN_LOCK_MS", () => {
  const throttle = createLoginThrottle();
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_PAIR - 1; i++) throttle.recordFailure("Maria@norvia.example", "10.0.0.1", t0 + i);
  assert.equal(throttle.check("maria@norvia.example", "10.0.0.1", t0 + 10), 0);
  throttle.recordFailure("maria@norvia.example", "10.0.0.1", t0 + 20);
  assert.ok(throttle.check("maria@norvia.example", "10.0.0.1", t0 + 30) > 0);
  // GW-05: o dono da conta, de outro IP, continua entrando (terceiro não tranca a conta).
  assert.equal(throttle.check("maria@norvia.example", "10.0.0.99", t0 + 30), 0);
  // Outro login no mesmo IP segue liberado.
  assert.equal(throttle.check("joao", "10.0.0.1", t0 + 30), 0);
  assert.equal(throttle.check("maria@norvia.example", "10.0.0.1", t0 + 20 + LOGIN_LOCK_MS), 0);
});

test("falhas fora da janela não acumulam", () => {
  const throttle = createLoginThrottle();
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_PAIR - 1; i++) throttle.recordFailure("ana", "10.0.0.1", t0);
  throttle.recordFailure("ana", "10.0.0.1", t0 + LOGIN_WINDOW_MS + 1);
  assert.equal(throttle.check("ana", "10.0.0.1", t0 + LOGIN_WINDOW_MS + 2), 0);
});

test("sucesso zera o contador do par e o atraso da conta", () => {
  const throttle = createLoginThrottle();
  for (let i = 0; i < MAX_FAILURES_PER_PAIR - 1; i++) throttle.recordFailure("ana", "10.0.0.1", 1000);
  throttle.recordSuccess("ana", "10.0.0.1");
  throttle.recordFailure("ana", "10.0.0.1", 1001);
  assert.equal(throttle.check("ana", "10.0.0.1", 1002), 0);
  assert.equal(throttle.accountDelayMs("ana", 1002), 0);
});

test("bloqueia o IP que testa muitos logins diferentes", () => {
  const throttle = createLoginThrottle();
  for (let i = 0; i < MAX_FAILURES_PER_IP; i++) throttle.recordFailure(`user${i}`, "203.0.113.5", 1000 + i);
  assert.ok(throttle.check("qualquer", "203.0.113.5", 2000) > 0);
  assert.equal(throttle.check("qualquer", "10.0.0.1", 2000), 0);
});

test("ataque distribuído contra uma conta: só atraso progressivo e limitado, nunca bloqueio", () => {
  const throttle = createLoginThrottle();
  const t0 = 1_000_000;
  for (let i = 0; i < ACCOUNT_DELAY_AFTER; i++) throttle.recordFailure("admin_jp", `198.51.100.${i}`, t0 + i);
  assert.equal(throttle.accountDelayMs("admin_jp", t0 + 10), 1000);
  throttle.recordFailure("admin_jp", "198.51.100.200", t0 + 11);
  assert.equal(throttle.accountDelayMs("admin_jp", t0 + 12), 2000);
  for (let i = 0; i < 100; i++) throttle.recordFailure("admin_jp", `198.51.101.${i % 250}`, t0 + 20 + i);
  assert.equal(throttle.accountDelayMs("admin_jp", t0 + 200), MAX_ACCOUNT_DELAY_MS);
  // O admin, do IP dele, não está bloqueado.
  assert.equal(throttle.check("admin_jp", "10.0.0.5", t0 + 200), 0);
  assert.equal(throttle.accountDelayMs("admin_jp", t0 + LOGIN_WINDOW_MS + 500), 0);
});
