import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStockCountRoutes } from "../src/routes/stock-count.js";
import type { StockTinyClient, TinyAjuste } from "../src/stock-tiny.js";
import { UpstreamError } from "../src/errors.js";
import type { RequestContext } from "../src/http.js";

function mockCtx(options: {
  path: string;
  method?: string;
  searchParams?: Record<string, string>;
  headers?: Record<string, string>;
}): { ctx: RequestContext; getStatus: () => number; getBody: () => any; getHeaders: () => Record<string, string> } {
  let status = 200;
  let body: any = null;
  const resHeaders: Record<string, string> = {};

  const url = new URL(`http://localhost${options.path}`);
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }

  const response = {
    setHeader(name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
    },
    writeHead(code: number) {
      status = code;
    },
    end(data?: any) {
      if (data && Buffer.isBuffer(data)) {
        body = data;
      }
    },
  } as any;

  const ctx: RequestContext = {
    request: { headers: options.headers ?? {} } as any,
    response,
    url,
    path: url.pathname,
    method: options.method ?? "GET",
    ip: "127.0.0.1",
    send(s: number, b: any) {
      status = s;
      body = b;
      return true;
    },
  };

  return { ctx, getStatus: () => status, getBody: () => body, getHeaders: () => resHeaders };
}

test("stock-count: sem CONTAGEM_REGISTRO_DIR retorna configurado: false", async () => {
  const handler = createStockCountRoutes({ registroDir: "" });
  const { ctx, getStatus, getBody } = mockCtx({ path: "/api/stock-count/contagens" });

  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(getStatus(), 200);
  assert.deepEqual(getBody(), {
    configurado: false,
    itens: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
});

test("stock-count: com registros lista, filtra e pagina corretamente", async () => {
  const tempDir = join(tmpdir(), `stock-count-test-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  const contagens = {
    "111111111111": {
      id: "111111111111",
      criado_em: "2026-10-10T10:00:00-03:00",
      codigo: "SKU-A",
      origem_codigo: "legenda",
      sku_legenda: "SKU-A",
      codigos_barras: ["BAR-1"],
      quantidade_detectada: 5,
      quantidade_final: 5,
      status: "confirmada",
      alertas: [],
      telegram_user_id: 1,
      telegram_user: "User 1",
      telegram_chat_id: 1,
      imagem: "111111111111.jpg",
      imagem_original: "111111111111_original.jpg",
      concluido_em: "2026-10-10T10:05:00-03:00",
    },
    "222222222222": {
      id: "222222222222",
      criado_em: "2026-10-12T14:00:00-03:00",
      codigo: "SKU-B",
      origem_codigo: "codigo_de_barras",
      sku_legenda: null,
      codigos_barras: ["BAR-2"],
      quantidade_detectada: 3,
      quantidade_final: null,
      status: "aguardando_confirmacao",
      alertas: ["reflexo"],
      telegram_user_id: 2,
      telegram_user: "User 2",
      telegram_chat_id: 2,
      imagem: "222222222222.jpg",
      imagem_original: "222222222222_original.jpg",
      concluido_em: null,
    },
  };

  await writeFile(join(tempDir, "contagens.json"), JSON.stringify(contagens));

  const handler = createStockCountRoutes({ registroDir: tempDir });

  // Lista geral ordenada desc
  {
    const { ctx, getStatus, getBody } = mockCtx({ path: "/api/stock-count/contagens" });
    const handled = await handler(ctx);
    assert.equal(handled, true);
    assert.equal(getStatus(), 200);
    const body = getBody();
    assert.equal(body.configurado, true);
    assert.equal(body.total, 2);
    assert.equal(body.itens[0].id, "222222222222"); // mais recente
    assert.equal(body.itens[1].id, "111111111111");
  }

  // Filtro por status
  {
    const { ctx, getStatus, getBody } = mockCtx({
      path: "/api/stock-count/contagens",
      searchParams: { status: "confirmada" },
    });
    await handler(ctx);
    assert.equal(getStatus(), 200);
    const body = getBody();
    assert.equal(body.total, 1);
    assert.equal(body.itens[0].id, "111111111111");
  }

  // Filtro por SKU
  {
    const { ctx, getStatus, getBody } = mockCtx({
      path: "/api/stock-count/contagens",
      searchParams: { sku: "sku-b" },
    });
    await handler(ctx);
    assert.equal(getStatus(), 200);
    const body = getBody();
    assert.equal(body.total, 1);
    assert.equal(body.itens[0].id, "222222222222");
  }
});

test("stock-count: entrega imagem anotada e original com validação segura", async () => {
  const tempDir = join(tmpdir(), `stock-count-img-test-${Date.now()}`);
  const imagesDir = join(tempDir, "imagens");
  await mkdir(imagesDir, { recursive: true });

  const id = "abcdef123456";
  await writeFile(join(imagesDir, `${id}.jpg`), Buffer.from("jpg_anotada_bytes"));
  await writeFile(join(imagesDir, `${id}_original.jpg`), Buffer.from("jpg_original_bytes"));

  const handler = createStockCountRoutes({ registroDir: tempDir });

  // Imagem anotada
  {
    const { ctx, getStatus, getBody, getHeaders } = mockCtx({
      path: `/api/stock-count/imagens/${id}/anotada`,
    });
    const handled = await handler(ctx);
    assert.equal(handled, true);
    assert.equal(getStatus(), 200);
    assert.equal(getHeaders()["content-type"], "image/jpeg");
    assert.equal(getBody().toString(), "jpg_anotada_bytes");
  }

  // Imagem original
  {
    const { ctx, getStatus, getBody } = mockCtx({
      path: `/api/stock-count/imagens/${id}/original`,
    });
    const handled = await handler(ctx);
    assert.equal(handled, true);
    assert.equal(getStatus(), 200);
    assert.equal(getBody().toString(), "jpg_original_bytes");
  }

  // Imagem não encontrada (404)
  {
    const { ctx, getStatus } = mockCtx({
      path: "/api/stock-count/imagens/000000000000/anotada",
    });
    await handler(ctx);
    assert.equal(getStatus(), 404);
  }

  // ID inválido (400)
  {
    const { ctx, getStatus } = mockCtx({
      path: "/api/stock-count/imagens/invalido/anotada",
    });
    await handler(ctx);
    assert.equal(getStatus(), 400);
  }
});

async function registroTemporario(registros: Record<string, any>): Promise<string> {
  const dir = join(tmpdir(), `stock-sku-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, "imagens"), { recursive: true });
  await writeFile(join(dir, "contagens.json"), JSON.stringify(registros), "utf-8");
  return dir;
}

function comCorpo(ctx: RequestContext, body: unknown): RequestContext {
  const raw = Buffer.from(JSON.stringify(body));
  (ctx as any).request = Object.assign(
    (async function* () {
      yield raw;
    })(),
    { headers: { "content-type": "application/json", "content-length": String(raw.length) } },
  );
  return ctx;
}

const base = {
  numero: 7, criado_em: "2026-10-13T17:34:46-03:00", origem_codigo: "sem_produto", quantidade_detectada: 8,
  quantidade_final: null, status: "aguardando_confirmacao", alertas: [], telegram_user_id: 1,
  telegram_user: "op", telegram_chat_id: 1, imagem: "x.jpg", concluido_em: null,
};

test("stock-count: informa SKU de contagem sem produto e a lista passa a mostrar e filtrar por ele", async () => {
  const dir = await registroTemporario({
    aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: null },
    bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-BOT", origem_codigo: "legenda" },
  });
  const handler = createStockCountRoutes({ registroDir: dir });

  const post = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/sku", method: "POST" });
  await handler(comCorpo(post.ctx, { sku: "  ab-123 " }));
  assert.equal(post.getStatus(), 200);
  assert.equal(post.getBody().sku_manual.sku, "AB-123");

  const lista = mockCtx({ path: "/api/stock-count/contagens", searchParams: { sku: "ab-123" } });
  await handler(lista.ctx);
  assert.deepEqual(lista.getBody().itens.map((i: any) => i.id), ["aaaaaaaaaaaa"]);
  assert.equal(lista.getBody().itens[0].sku_manual.sku, "AB-123");

  // Contagem com SKU do bot: o do bot é o que vale.
  const conflito = mockCtx({ path: "/api/stock-count/contagens/bbbbbbbbbbbb/sku", method: "POST" });
  await handler(comCorpo(conflito.ctx, { sku: "OUTRO" }));
  assert.equal(conflito.getStatus(), 409);

  const invalido = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/sku", method: "POST" });
  await handler(comCorpo(invalido.ctx, { sku: "<script>" }));
  assert.equal(invalido.getStatus(), 400);

  const inexistente = mockCtx({ path: "/api/stock-count/contagens/cccccccccccc/sku", method: "POST" });
  await handler(comCorpo(inexistente.ctx, { sku: "AB-1" }));
  assert.equal(inexistente.getStatus(), 404);
});

test("stock-count: contagem excluída some da lista", async () => {
  const dir = await registroTemporario({
    aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: null },
    bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-BOT" },
  });
  const handler = createStockCountRoutes({ registroDir: dir });

  const del = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa", method: "DELETE" });
  await handler(del.ctx);
  assert.equal(del.getStatus(), 200);

  const lista = mockCtx({ path: "/api/stock-count/contagens" });
  await handler(lista.ctx);
  assert.deepEqual(lista.getBody().itens.map((i: any) => i.id), ["bbbbbbbbbbbb"]);
  assert.equal(lista.getBody().total, 1);

  const idRuim = mockCtx({ path: "/api/stock-count/contagens/..%2F", method: "DELETE" });
  assert.equal(await handler(idRuim.ctx), false);
});

/** Tiny falso com saldo por SKU: entra só a diferença, como a automação. */
function tinyFalso(saldos: Record<string, number> = {}, falha?: Error) {
  const chamadas: { registro_id: string; sku: string; quantidade: number; numero: number; criado_em: string }[] = [];
  let consultas = 0;
  const client: StockTinyClient = {
    async consultar(sku) {
      consultas++;
      if (falha) throw falha;
      return { sku, id_produto: 1, produto: `Produto ${sku}`, unidade: "UN", deposito: "Geral", saldo: saldos[sku] ?? 0, aviso: null };
    },
    async ajustar(req) {
      chamadas.push(req);
      if (falha) throw falha;
      const saldo = saldos[req.sku] ?? 0;
      const entrada = Math.max(0, req.quantidade - saldo);
      saldos[req.sku] = saldo + entrada;
      return {
        status: entrada > 0 ? "lancado" : "sem_entrada",
        sku: req.sku, id_produto: 1, produto: "P", deposito: "Geral",
        saldo_anterior: saldo, contado: req.quantidade, auditoria: String(req.numero).padStart(6, "0"), entrada, id_lancamento: entrada > 0 ? 9 : null,
      } satisfies TinyAjuste;
    },
  };
  return { client, chamadas, saldos, consultas: () => consultas };
}

test("stock-count: conferência no painel confirma ou corrige e prevalece na lista", async () => {
  const dir = await registroTemporario({
    aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: "SKU-1", quantidade_detectada: 8 },
    bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-2", quantidade_detectada: 5 },
  });
  const handler = createStockCountRoutes({ registroDir: dir, tiny: tinyFalso().client });

  const ok = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
  await handler(comCorpo(ok.ctx, { quantidade: 8 }));
  assert.equal(ok.getStatus(), 200);
  assert.equal(ok.getBody().conferencia.status, "confirmada");

  const fix = mockCtx({ path: "/api/stock-count/contagens/bbbbbbbbbbbb/conferir", method: "POST" });
  await handler(comCorpo(fix.ctx, { quantidade: 6 }));
  assert.equal(fix.getBody().conferencia.status, "corrigida");

  const lista = mockCtx({ path: "/api/stock-count/contagens", searchParams: { status: "corrigida" } });
  await handler(lista.ctx);
  assert.deepEqual(lista.getBody().itens.map((i: any) => [i.id, i.status, i.quantidade_final]), [["bbbbbbbbbbbb", "corrigida", 6]]);

  for (const quantidade of [-1, 2.5, "abc"]) {
    const ruim = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
    await handler(comCorpo(ruim.ctx, { quantidade }));
    assert.equal(ruim.getStatus(), 400);
  }
});

test("stock-count: excluir exige contagem existente e contagem excluída não é conferida", async () => {
  const dir = await registroTemporario({ aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: "SKU-1" } });
  const handler = createStockCountRoutes({ registroDir: dir });

  const inexistente = mockCtx({ path: "/api/stock-count/contagens/cccccccccccc", method: "DELETE" });
  await handler(inexistente.ctx);
  assert.equal(inexistente.getStatus(), 404);

  const del = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa", method: "DELETE" });
  await handler(del.ctx);
  assert.equal(del.getStatus(), 200);

  const conf = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
  await handler(comCorpo(conf.ctx, { quantidade: 3 }));
  assert.equal(conf.getStatus(), 409);
});

test("stock-count: conferir lança no Tiny fardos × unidades por fardo + soltas, só a entrada que falta", async () => {
  const dir = await registroTemporario({
    aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: "SKU-1", quantidade_detectada: 8 },
    bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-2", quantidade_detectada: 4 },
  });
  const tiny = tinyFalso({ "SKU-1": 10, "SKU-2": 100 });
  const handler = createStockCountRoutes({ registroDir: dir, tiny: tiny.client });

  // Padrão: 5 unidades por fardo. 8 fardos = 40, + 10 soltas = 50; Tiny tem 10 → entra 40.
  const a = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
  await handler(comCorpo(a.ctx, { quantidade: 8, unidades_soltas: 10 }));
  assert.equal(a.getStatus(), 200);
  assert.equal(a.getBody().conferencia.unidades_por_fardo, 5);
  assert.equal(a.getBody().conferencia.unidades_total, 50);
  assert.deepEqual(tiny.chamadas[0], {
    registro_id: "aaaaaaaaaaaa", sku: "SKU-1", quantidade: 50, numero: 7, criado_em: base.criado_em,
  });
  assert.equal(a.getBody().tiny.status, "lancado");
  assert.equal(a.getBody().tiny.entrada, 40);

  // Fardo de 10: 4 × 10 = 40; Tiny tem 100 → nada sai do Tiny.
  const b = mockCtx({ path: "/api/stock-count/contagens/bbbbbbbbbbbb/conferir", method: "POST" });
  await handler(comCorpo(b.ctx, { quantidade: 4, unidades_por_fardo: 10 }));
  assert.equal(b.getBody().conferencia.unidades_total, 40);
  assert.equal(b.getBody().tiny.status, "sem_entrada");
  assert.equal(tiny.saldos["SKU-2"], 100);

  const lista = mockCtx({ path: "/api/stock-count/contagens" });
  await handler(lista.ctx);
  const porId = Object.fromEntries(lista.getBody().itens.map((i: any) => [i.id, i]));
  assert.equal(porId.aaaaaaaaaaaa.tiny.entrada, 40);
  assert.equal(porId.bbbbbbbbbbbb.tiny.status, "sem_entrada");

  for (const corpo of [{ quantidade: 8, unidades_por_fardo: 0 }, { quantidade: 8, unidades_soltas: -1 }, { quantidade: 8, unidades_por_fardo: 2.5 }]) {
    const ruim = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
    await handler(comCorpo(ruim.ctx, corpo));
    assert.equal(ruim.getStatus(), 400);
  }
});

test("stock-count: fardo pela cor do prendedor (verde 5, rosa 10) ignora o informado", async () => {
  const dir = await registroTemporario({
    aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: "SKU-1", quantidade_detectada: 3, cor: "rosa", unidades_por_fardo: 10 },
    bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-2", quantidade_detectada: 3, cor: "verde", unidades_por_fardo: 5 },
  });
  const tiny = tinyFalso({});
  const handler = createStockCountRoutes({ registroDir: dir, tiny: tiny.client });

  // Rosa: 3 × 10 + 2 soltas = 32, mesmo que venha outro valor por fardo.
  const a = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
  await handler(comCorpo(a.ctx, { quantidade: 3, unidades_por_fardo: 7, unidades_soltas: 2 }));
  assert.equal(a.getStatus(), 200);
  assert.equal(a.getBody().conferencia.unidades_por_fardo, 10);
  assert.equal(a.getBody().conferencia.unidades_total, 32);

  const b = mockCtx({ path: "/api/stock-count/contagens/bbbbbbbbbbbb/conferir", method: "POST" });
  await handler(comCorpo(b.ctx, { quantidade: 3 }));
  assert.equal(b.getBody().conferencia.unidades_total, 15);
});

test("stock-count: sem SKU o Tiny espera o SKU; falha fica gravada e o reenvio funciona", async () => {
  const dir = await registroTemporario({ aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: null } });
  const tiny = tinyFalso({ "AB-1": 0 });
  const handler = createStockCountRoutes({ registroDir: dir, tiny: tiny.client });

  const reenvioAntes = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/tiny", method: "POST" });
  await handler(reenvioAntes.ctx);
  assert.equal(reenvioAntes.getStatus(), 409);

  const conf = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
  await handler(comCorpo(conf.ctx, { quantidade: 8 }));
  assert.equal(conf.getBody().tiny, null);
  assert.equal(tiny.chamadas.length, 0);

  const sku = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/sku", method: "POST" });
  await handler(comCorpo(sku.ctx, { sku: "ab-1" }));
  assert.equal(sku.getBody().tiny.status, "lancado");
  assert.deepEqual(tiny.chamadas[0], {
    registro_id: "aaaaaaaaaaaa", sku: "AB-1", quantidade: 40, numero: 7, criado_em: base.criado_em,
  });

  // Falha da automação: envio "erro" com a mensagem; reenvio com o Tiny de volta.
  const dir2 = await registroTemporario({ bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-X" } });
  const quebrado = tinyFalso({}, new UpstreamError(409, "Tiny: SKU SKU-X não encontrado no Tiny.", 409));
  const h2 = createStockCountRoutes({ registroDir: dir2, tiny: quebrado.client });
  const c2 = mockCtx({ path: "/api/stock-count/contagens/bbbbbbbbbbbb/conferir", method: "POST" });
  await h2(comCorpo(c2.ctx, { quantidade: 2 }));
  assert.equal(c2.getStatus(), 200);
  assert.equal(c2.getBody().tiny.status, "erro");
  assert.match(c2.getBody().tiny.mensagem, /não encontrado/);
});

test("stock-count: consulta mostra produto e saldo do Tiny, com cache por SKU e sem SKU dá 409", async () => {
  const dir = await registroTemporario({
    aaaaaaaaaaaa: { ...base, id: "aaaaaaaaaaaa", codigo: "SKU-1" },
    bbbbbbbbbbbb: { ...base, id: "bbbbbbbbbbbb", codigo: "SKU-1" },
    cccccccccccc: { ...base, id: "cccccccccccc", codigo: null },
  });
  const tiny = tinyFalso({ "SKU-1": 12 });
  const handler = createStockCountRoutes({ registroDir: dir, tiny: tiny.client });

  const a = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/tiny" });
  await handler(a.ctx);
  assert.equal(a.getStatus(), 200);
  assert.equal(a.getBody().produto, "Produto SKU-1");
  assert.equal(a.getBody().saldo, 12);

  const b = mockCtx({ path: "/api/stock-count/contagens/bbbbbbbbbbbb/tiny" });
  await handler(b.ctx);
  assert.equal(tiny.consultas(), 1); // mesmo SKU: veio do cache

  // Depois de lançar, o cache do SKU cai e a próxima consulta lê o saldo novo.
  const conf = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/conferir", method: "POST" });
  await handler(comCorpo(conf.ctx, { quantidade: 8 }));
  assert.equal(conf.getBody().tiny.produto, "P");
  const depois = mockCtx({ path: "/api/stock-count/contagens/aaaaaaaaaaaa/tiny" });
  await handler(depois.ctx);
  assert.equal(depois.getBody().saldo, 40);

  const semSku = mockCtx({ path: "/api/stock-count/contagens/cccccccccccc/tiny" });
  await handler(semSku.ctx);
  assert.equal(semSku.getStatus(), 409);
});
