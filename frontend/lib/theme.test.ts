import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { themeInitScript } from "./theme";

// O hash abaixo está documentado em frontend/README.md ("Headers de segurança (NGINX)").
// Mudou o script inline de tema? Atualize o hash aqui E no README/CSP do NGINX.
test("hash CSP do script inline de tema está em dia com o README", () => {
  const hash = createHash("sha256").update(themeInitScript, "utf8").digest("base64");
  assert.equal(hash, "KqTsCsNcNh8qBmrJYgaeUdxL7wYqFY8oEtEX6h7m8zw=");
});
