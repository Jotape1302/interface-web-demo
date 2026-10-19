import test from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getCircuitBreaker,
  getAllCircuitBreakers,
  resetAllCircuitBreakers,
} from "../src/circuit-breaker.js";

test("CircuitBreaker: opera em CLOSED normalmente e reseta contador em sucesso", async () => {
  const breaker = new CircuitBreaker({
    name: "test-normal",
    failureThreshold: 3,
  });

  assert.equal(breaker.getState(), "closed");

  const res = await breaker.execute(async () => "sucesso");
  assert.equal(res, "sucesso");
  assert.equal(breaker.getState(), "closed");
});

test("CircuitBreaker: abre o circuito após atingir failureThreshold", async () => {
  const breaker = new CircuitBreaker({
    name: "test-open",
    failureThreshold: 3,
    resetTimeoutMs: 500,
  });

  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () =>
        breaker.execute(async () => {
          throw new Error(`Falha upstream ${i + 1}`);
        }),
      /Falha upstream/,
    );
  }

  assert.equal(breaker.getState(), "open");

  // Próxima chamada deve falhar imediatamente sem invocar a função
  let executed = false;
  await assert.rejects(
    () =>
      breaker.execute(async () => {
        executed = true;
        return "nao deve rodar";
      }),
    CircuitBreakerOpenError,
  );

  assert.equal(executed, false, "Função protegida não deve ter sido executada com circuito aberto");
});

test("CircuitBreaker: transita para HALF_OPEN e fecha após sucessos de teste", async () => {
  const breaker = new CircuitBreaker({
    name: "test-half-open",
    failureThreshold: 2,
    resetTimeoutMs: 50,
    successThreshold: 2,
  });

  // Força 2 falhas para abrir
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() =>
      breaker.execute(async () => {
        throw new Error("erro");
      }),
    );
  }
  assert.equal(breaker.getState(), "open");

  // Aguarda resetTimeoutMs passar
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(breaker.getState(), "half_open");

  // Primeiro probe bem-sucedido
  await breaker.execute(async () => "probe-1");
  assert.equal(breaker.getState(), "half_open");

  // Segundo probe bem-sucedido: deve fechar
  await breaker.execute(async () => "probe-2");
  assert.equal(breaker.getState(), "closed");
  assert.equal(breaker.getStats().failureCount, 0);
});

test("CircuitBreaker: abort pelo cliente não conta como falha do upstream", async () => {
  const breaker = new CircuitBreaker({
    name: "test-client-abort",
    failureThreshold: 2,
  });

  const clientController = new AbortController();

  const promise = breaker.execute(
    async (signal) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
    { clientSignal: clientController.signal },
  );

  // Cliente desconecta
  clientController.abort();

  await assert.rejects(promise);

  assert.equal(breaker.getState(), "closed");
  assert.equal(breaker.getStats().failureCount, 0, "Abort do cliente não pode incrementar falhas");
});

test("CircuitBreaker: erro 4xx do cliente não abre o circuito", async () => {
  const breaker = new CircuitBreaker({
    name: "test-4xx",
    failureThreshold: 2,
  });

  // Simula erro 404/422 de negócio
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() =>
      breaker.execute(async () => {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      }),
    );
  }

  assert.equal(breaker.getState(), "closed", "Erros 4xx não devem abrir o circuito");
  assert.equal(breaker.getStats().failureCount, 0);
});

test("CircuitBreaker: registro central armazena e expõe instâncias", () => {
  resetAllCircuitBreakers();

  const b1 = getCircuitBreaker("tiny", { failureThreshold: 4 });
  const b2 = getCircuitBreaker("tiny");
  assert.equal(b1, b2, "Deve retornar a mesma instância pelo nome");

  const all = getAllCircuitBreakers();
  assert.ok("tiny" in all);
  assert.equal(all.tiny.state, "closed");
});
