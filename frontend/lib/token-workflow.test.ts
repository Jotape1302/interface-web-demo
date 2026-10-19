import assert from "node:assert/strict";
import test from "node:test";
import { isValidWorkflowId } from "./token-workflow";

test("aceita só IDs alfanuméricos de 1 a 32 caracteres", () => {
  assert.equal(isValidWorkflowId("8AtrRCYPsIyFv6s6"), true);
  assert.equal(isValidWorkflowId("a".repeat(32)), true);
  assert.equal(isValidWorkflowId("a".repeat(33)), false);
  assert.equal(isValidWorkflowId(""), false);
  assert.equal(isValidWorkflowId("abc/../x"), false);
  assert.equal(isValidWorkflowId("abc?x=1"), false);
  assert.equal(isValidWorkflowId("javascript:alert(1)"), false);
  assert.equal(isValidWorkflowId(null), false);
});
