import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "mariadb";
import { readConfig } from "../src/config.js";
import { createReconciliationHistoryService, parseBaixaHistoricoQuery } from "../src/reconciliation-history.js";

test("parseBaixaHistoricoQuery ignora filtros inválidos e limita a página", () => {
  const q = parseBaixaHistoricoQuery(
    new URLSearchParams("status=talvez&de=28/09/2026&ate=2026-09-28&page=-3&pageSize=5000&q=%20alumpar%20&empresa=fabrilux"),
  );
  assert.equal(q.status, undefined);
  assert.equal(q.de, undefined);
  assert.equal(q.ate, "2026-09-28");
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, 200);
  assert.equal(q.q, "alumpar");
  assert.deepEqual(q.empresa, ["fabrilux"]);
});

test("parseBaixaHistoricoQuery aceita listas e filtros de coluna separados", () => {
  const q = parseBaixaHistoricoQuery(
    new URLSearchParams("empresa=fabrilux,curitiba,fabrilux&status=erro,talvez,pendente&fornecedor=acme&documento=%20123%20&usuario=ana"),
  );
  assert.deepEqual(q.empresa, ["fabrilux", "curitiba"]);
  assert.deepEqual(q.status, ["erro", "pendente"]);
  assert.equal(q.fornecedor, "acme");
  assert.equal(q.documento, "123");
  assert.equal(q.usuario, "ana");
});

test("Histórico de baixas: filtros de coluna viram condições separadas (E), não um termo só", async () => {
  const consultas: { sql: string; values: unknown[] }[] = [];
  const pool = {
    getConnection: async () => ({
      query: async (opts: { sql: string } | string, values: unknown[]) => {
        consultas.push({ sql: typeof opts === "string" ? opts : opts.sql, values });
        return (typeof opts === "string" ? opts : opts.sql).includes("COUNT(*)") ? [{ total: 0 }] : [];
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
  const history = createReconciliationHistoryService(readConfig(), pool);
  await history.list(
    parseBaixaHistoricoQuery(new URLSearchParams("empresa=fabrilux,curitiba&status=erro,sucesso&fornecedor=acme&documento=123")),
  );
  const contagem = consultas.find((c) => c.sql.includes("COUNT(*)"));
  assert.ok(contagem, "consulta de contagem executada");
  assert.match(contagem.sql, /empresa IN \(\?, \?\)/);
  assert.match(contagem.sql, /status IN \(\?, \?\)/);
  assert.match(contagem.sql, /fornecedor_nome LIKE \? AND \(numero_documento LIKE \?/);
  assert.deepEqual(contagem.values, ["fabrilux", "curitiba", "erro", "sucesso", "%acme%", "%123%", "123", "123"]);
});

test("Histórico de baixas: sem MariaDB responde indisponível e não grava", async () => {
  const history = createReconciliationHistoryService(readConfig(), undefined);
  await history.recordBatch({ usuarioId: 1, usuarioNome: "Ana", itens: [{ conta_pagar_id: 1 }], resultados: [] });
  const page = await history.list(parseBaixaHistoricoQuery(new URLSearchParams()));
  assert.equal(page.disponivel, false);
  assert.deepEqual(page.itens, []);
});

test("Histórico de baixas: grava uma linha por conta com o resultado certo de cada uma", async () => {
  const batches: { sql: string; rows: unknown[][] }[] = [];
  const pool = {
    getConnection: async () => ({
      batch: async (opts: { sql: string; timeout?: number }, rows: unknown[][]) => {
        // Igual ao driver mariadb: batch() com timeout é recusado.
        if (opts.timeout) throw new Error("Cannot use timeout for Batch statement");
        batches.push({ sql: opts.sql, rows });
      },
      query: async () => [],
      release: () => undefined,
    }),
  } as unknown as Pool;
  const history = createReconciliationHistoryService(readConfig(), pool);

  await history.recordBatch({
    usuarioId: 7,
    usuarioNome: "João",
    itens: [
      { empresa: "fabrilux", conta_pagar_id: 10, valor_pago: 150.5, data_pagamento: "2026-09-25", fornecedor_nome: "Alumix" },
      { empresa: "revesta", conta_pagar_id: 20, valor_pago: "99.9", data_pagamento: "25/09/2026" },
    ],
    // Fora de ordem: tem de casar por conta + empresa, não pela posição.
    resultados: [
      { conta_pagar_id: 20, empresa: "revesta", status: "erro", mensagem: "Conta já baixada" },
      { conta_pagar_id: 10, empresa: "fabrilux", status: "sucesso", mensagem: "ok" },
    ],
  });

  assert.equal(batches.length, 1);
  const [a, b] = batches[0]!.rows;
  // [lote, usuario_id, usuario_nome, empresa, conta, doc, fornecedor, venc, pgto, valor_tiny, valor_pago, ..., status, mensagem]
  assert.equal(a![0], b![0], "mesmo lote");
  assert.equal(a![1], 7);
  assert.equal(a![4], 10);
  assert.equal(a![6], "Alumix");
  assert.equal(a![8], "2026-09-25");
  assert.equal(a![10], 150.5);
  assert.equal(a![16], "sucesso");
  assert.equal(b![8], null, "data fora do formato ISO não é gravada");
  assert.equal(b![10], 99.9);
  assert.equal(b![16], "erro");
  assert.equal(b![17], "Conta já baixada");
});

function fakePool(respond: (sql: string, values: unknown[]) => unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let releases = 0;
  const pool = {
    getConnection: async () => ({
      query: async (opts: { sql: string }, values: unknown[] = []) => {
        calls.push({ sql: opts.sql, values });
        return respond(opts.sql, values);
      },
      release: () => {
        releases++;
      },
    }),
  } as unknown as Pool;
  return { pool, calls, releases: () => releases };
}

test("Painel Contas a Pagar: ROI vem das baixas com sucesso (5 min por conta, R$ 11/h)", async () => {
  const { pool, releases } = fakePool((sql) => {
    if (sql.includes("COUNT(*)")) return [{ total: 13n, sucessos: "12" }];
    return [
      {
        id: 9, lote_id: "L1", executado_em: "2026-09-28 14:00:00", usuario_nome: "Ana", empresa: "fabrilux",
        conta_pagar_id: 55, numero_documento: "NF-1", fornecedor_nome: null, data_vencimento: null,
        data_pagamento: "2026-09-27", valor_tiny: null, valor_pago: "150.50", juros: "0", multa: "0", desconto: "0",
        inter_transacao_id: "TX", metodo_match: "CNPJ_VALOR", status: "erro", mensagem: "Conta já baixada",
      },
    ];
  });
  const snap = await createReconciliationHistoryService(readConfig(), pool).snapshot();
  assert.equal(snap.metrics.totalQueue, 13);
  assert.equal(snap.metrics.paidCount, 12);
  assert.equal(snap.metrics.hoursSaved, 1);
  assert.equal(snap.metrics.estimatedSavings, 11);
  assert.deepEqual(snap.approvals, []);
  assert.equal(snap.failures[0]!.beneficiary, "Conta #55");
  assert.equal(snap.failures[0]!.amount, "150.50");
  assert.equal(snap.failures[0]!.dueDate, "2026-09-27");
  assert.equal(snap.failures[0]!.errorLog, "Conta já baixada");
  assert.equal(snap.failures[0]!.updatedAt, "2026-09-28T14:00:00.000Z");
  assert.equal(releases(), 2);
});

test("Painel Contas a Pagar: sem MariaDB a fonte fica indisponível, não zerada", async () => {
  await assert.rejects(createReconciliationHistoryService(readConfig(), undefined).snapshot());
});

test("Histórico de 14 dias: cada lote vira uma execução; lote com falha conta como erro", async () => {
  const { pool, calls } = fakePool(() => [
    { lote_id: "L-OK", inicio: "2026-09-28 13:00:00", fim: "2026-09-28 13:01:30", total: 3n, sucessos: "3" },
    { lote_id: "L-PARCIAL", inicio: "2026-09-27 10:00:00", fim: "2026-09-27 10:00:10", total: 2n, sucessos: "1" },
  ]);
  const { executions, complete } = await createReconciliationHistoryService(readConfig(), pool).readHistory({
    days: 14,
    from: "2026-09-15T03:00:00.000Z",
    to: "2026-09-28T15:00:00.000Z",
  });
  assert.equal(complete, true);
  assert.deepEqual(calls[0]!.values, ["2026-09-15 03:00:00", "2026-09-28 15:00:00"]);
  assert.equal(executions[0]!.status, "success");
  assert.equal(executions[0]!.startedAt, "2026-09-28T13:00:00.000Z");
  assert.equal(executions[0]!.durationMs, 90000);
  assert.equal(executions[1]!.status, "error");
});

test("Baixa em segundo plano: o gateway acompanha a tarefa e grava o histórico sozinho", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { createReconciliationRoutes } = await import("../src/routes/reconciliation.js");

  // API Python falsa: a tarefa fica "executando" nas 2 primeiras consultas.
  let consultas = 0;
  const python = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/health") return res.end("{}");
    if (req.url === "/api/v1/reconciliacao/jobs/baixar" && req.method === "POST") {
      return res.end(JSON.stringify({ job_id: "job-1", status: "executando" }));
    }
    if (req.url === "/api/v1/reconciliacao/jobs/job-1") {
      consultas++;
      if (consultas < 3) return res.end(JSON.stringify({ job_id: "job-1", status: "executando" }));
      return res.end(JSON.stringify({
        job_id: "job-1",
        status: "concluido",
        resultado: {
          total_sucessos: 1,
          total_falhas: 0,
          resultados: [{ conta_pagar_id: 10, empresa: "fabrilux", status: "sucesso", mensagem: "ok" }],
        },
      }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  python.listen(0, "127.0.0.1");
  await once(python, "listening");
  t.after(() => python.close());
  const pyAddr = python.address();
  assert.ok(pyAddr && typeof pyAddr !== "string");

  const gravados: unknown[] = [];
  const pendentes: unknown[] = [];
  const handler = createReconciliationRoutes({
    config: readConfig(),
    pythonApiUrl: `http://127.0.0.1:${pyAddr.port}`,
    jobPollIntervalMs: 5,
    history: {
      bootstrap: async () => undefined,
      recordBatch: async () => {
        throw new Error("com banco, o lote é gravado como pendente e fechado depois");
      },
      recordPending: async (input) => {
        pendentes.push(input);
        return true;
      },
      completeBatch: async (input) => {
        gravados.push(input);
      },
      pendingLotes: async () => [],
      list: async () => ({ disponivel: true, itens: [], total: 0, page: 1, pageSize: 50 }),
      resumo: async () => null,
      snapshot: async () => {
        throw new Error("não usado");
      },
      readHistory: async () => ({ complete: true, executions: [] }),
    },
  });
  const gateway = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://gateway.test");
    void handler({
      request,
      response,
      url,
      path: url.pathname,
      method: request.method ?? "GET",
      ip: "127.0.0.1",
      session: { user: { id: 7, nome: "João" } as never, permissions: [] },
      send(status, body) {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(body));
        return true;
      },
    });
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => gateway.close());
  const gwAddr = gateway.address();
  assert.ok(gwAddr && typeof gwAddr !== "string");

  const res = await fetch(`http://127.0.0.1:${gwAddr.port}/api/reconciliation/jobs/baixar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itens: [{ empresa: "fabrilux", conta_pagar_id: 10, valor_pago: 150.5 }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { job_id: string }).job_id, "job-1");

  for (let i = 0; i < 200 && gravados.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(gravados.length, 1);
  const [pend] = pendentes as Array<{ loteId: string; usuarioId: number }>;
  assert.equal(pend!.loteId, "job-1", "o lote é o id da tarefa, para poder retomar");
  assert.equal(pend!.usuarioId, 7);
  const [lote] = gravados as Array<{ loteId: string; resultados: Array<{ status: string }> }>;
  assert.equal(lote!.loteId, "job-1");
  assert.equal(lote!.resultados[0]!.status, "sucesso");
  assert.ok(consultas >= 3);
});

test("Baixa em segundo plano: lote pendente é retomado depois de o gateway reiniciar", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { createReconciliationRoutes } = await import("../src/routes/reconciliation.js");

  const python = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/health") return res.end("{}");
    if (req.url === "/api/v1/reconciliacao/jobs/job-ok") {
      return res.end(JSON.stringify({
        status: "concluido",
        resultado: { total_sucessos: 1, total_falhas: 0, resultados: [{ conta_pagar_id: 10, empresa: "fabrilux", status: "sucesso" }] },
      }));
    }
    res.statusCode = 404; // job-perdido: a API Python também reiniciou
    res.end("{}");
  });
  python.listen(0, "127.0.0.1");
  await once(python, "listening");
  t.after(() => python.close());
  const pyAddr = python.address();
  assert.ok(pyAddr && typeof pyAddr !== "string");

  const fechados: Array<{ loteId: string; resultados: unknown[]; erroGeral?: string | null }> = [];
  createReconciliationRoutes({
    config: readConfig(),
    pythonApiUrl: `http://127.0.0.1:${pyAddr.port}`,
    jobPollIntervalMs: 5,
    history: {
      bootstrap: async () => undefined,
      recordBatch: async () => undefined,
      recordPending: async () => {
        throw new Error("lote retomado não é gravado de novo");
      },
      completeBatch: async (input) => {
        fechados.push(input);
      },
      pendingLotes: async () => ["job-ok", "job-perdido"],
      list: async () => ({ disponivel: true, itens: [], total: 0, page: 1, pageSize: 50 }),
      resumo: async () => null,
      snapshot: async () => {
        throw new Error("não usado");
      },
      readHistory: async () => ({ complete: true, executions: [] }),
    },
  });

  for (let i = 0; i < 200 && fechados.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const porLote = Object.fromEntries(fechados.map((f) => [f.loteId, f]));
  assert.equal(porLote["job-ok"]!.resultados.length, 1);
  assert.equal(porLote["job-ok"]!.erroGeral, null);
  assert.match(String(porLote["job-perdido"]!.erroGeral), /reiniciada/);
});

test("Histórico: lote pendente é fechado conta a conta e o que ficou sem resultado vira erro", async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.startsWith("SELECT id")) {
      return [
        { id: 1, empresa: "fabrilux", conta_pagar_id: 10n },
        { id: 2, empresa: "revesta", conta_pagar_id: 20n },
      ];
    }
    return [];
  });
  await createReconciliationHistoryService(readConfig(), pool).completeBatch({
    loteId: "job-1",
    resultados: [{ conta_pagar_id: 10, empresa: "fabrilux", status: "sucesso", mensagem: "ok" }],
    erroGeral: null,
  });
  const updates = calls.filter((c) => c.sql.startsWith("UPDATE"));
  assert.deepEqual(updates[0]!.values, ["sucesso", "ok", 1]);
  assert.equal(updates[1]!.values[0], "erro");
  assert.match(String(updates[1]!.values[1]), /confira no Tiny/);
  assert.equal(updates[1]!.values[2], 2);
});
