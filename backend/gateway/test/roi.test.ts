import test from "node:test";
import assert from "node:assert/strict";
import {
  ETIQUETAS_INICIO,
  ROI_CACHE_MS,
  ROI_TAREFAS,
  VALOR_HORA_REAIS,
  createRoiService,
  diasUteisDesde,
  economia,
  economiaInteira,
  estimativaEtiquetas,
  montarRoi,
  type RoiContagem,
  type RoiId,
  type RoiSources,
} from "../src/roi.js";

const AGORA = new Date("2026-10-27T12:00:00.000Z");

function fontes(itens: number): RoiSources {
  return Object.fromEntries(ROI_TAREFAS.map((t) => [t.id, async () => ({ itens })])) as RoiSources;
}

test("roi: economia = (manual − atual) × itens, em horas e R$ com centavos exatos", () => {
  // Contas a pagar: 5 − 0,5 = 4,5 min por baixa → 100 baixas = 7,5 h = R$ 82,50.
  assert.deepEqual(economia("accounts-payable", 100), { horas: 7.5, reais: 82.5 });
  // Fretes: 60 s − 0 s = 60 s por troca → 3 trocas = 180 s = R$ 0,55.
  const f = economia("fretes", 3);
  assert.equal(f.horas, 180 / 3600);
  assert.equal(f.reais, 0.55);
  assert.deepEqual(economia("danfe-tiny", 0), { horas: 0, reais: 0 });
});

test("roi: a conta usa inteiros (segundos e centavos), sem erro de ponto flutuante", () => {
  const e = economiaInteira("fretes", 1000);
  assert.equal(Number.isInteger(e.segundos), true);
  assert.equal(Number.isInteger(e.centavos), true);
  assert.equal(e.segundos, 60_000);
  assert.equal(e.centavos, Math.round((60_000 * VALOR_HORA_REAIS * 100) / 3600));
});

test("roi: montarRoi soma só as fontes que responderam e marca o total como parcial", () => {
  const resultados = Object.fromEntries(
    ROI_TAREFAS.map((t) => [
      t.id,
      t.id === "dimensoes"
        ? ({ status: "rejected", reason: new Error("fora do ar") } as PromiseRejectedResult)
        : ({ status: "fulfilled", value: { itens: 10 } } as PromiseFulfilledResult<RoiContagem>),
    ]),
  ) as Record<RoiId, PromiseSettledResult<RoiContagem>>;
  const roi = montarRoi("live", resultados, AGORA);
  assert.equal(roi.generatedAt, AGORA.toISOString());
  assert.equal(roi.totais.parcial, true);
  const dim = roi.automacoes.find((a) => a.id === "dimensoes")!;
  assert.equal(dim.itens, null);
  assert.equal(dim.fonte.status, "erro");
  const medidas = roi.automacoes.filter((a) => a.fonte.status === "ok");
  assert.equal(medidas.length, ROI_TAREFAS.length - 1);
  const reaisEsperados = medidas.reduce((s, a) => s + Math.round((a.reais ?? 0) * 100), 0) / 100;
  assert.equal(roi.totais.reais, reaisEsperados);
  assert.deepEqual(roi.naoMedidas, []);
});

test("roi: sem falhas o total não é parcial", () => {
  const resultados = Object.fromEntries(
    ROI_TAREFAS.map((t) => [t.id, { status: "fulfilled", value: { itens: 1 } }]),
  ) as unknown as Record<RoiId, PromiseSettledResult<RoiContagem>>;
  assert.equal(montarRoi("demo", resultados, AGORA).totais.parcial, false);
});

test("roi: serviço guarda a leitura por 60 s e junta leituras simultâneas (dedupe inflight)", async () => {
  let leituras = 0;
  let agora = AGORA.getTime();
  const sources = fontes(5);
  sources["danfe-tiny"] = async () => {
    leituras++;
    await new Promise((r) => setTimeout(r, 20));
    return { itens: 5 };
  };
  const roi = createRoiService("live", sources, () => new Date(agora));

  const [a, b] = await Promise.all([roi.read(), roi.read()]);
  assert.equal(leituras, 1, "duas leituras simultâneas consultam as fontes uma vez");
  assert.equal(a, b);

  agora += ROI_CACHE_MS - 1;
  await roi.read();
  assert.equal(leituras, 1, "dentro dos 60 s vem do cache");

  agora += 2;
  await roi.read();
  assert.equal(leituras, 2, "passados 60 s consulta de novo");
});

test("roi: etiquetas estimadas em 5 OPs por dia útil desde 09/10/2026 (seg a sex, inclui hoje)", () => {
  // 09/10 (sex) + 12–16 + 19–23 + 26–27/10 = 13 dias úteis
  assert.equal(diasUteisDesde(ETIQUETAS_INICIO, new Date("2026-10-27T15:00:00Z")), 13);
  // sábado e domingo não contam
  assert.equal(diasUteisDesde(ETIQUETAS_INICIO, new Date("2026-10-11T15:00:00Z")), 1);
  // antes do início: zero
  assert.equal(diasUteisDesde(ETIQUETAS_INICIO, new Date("2026-10-08T15:00:00Z")), 0);
  // 01h UTC de 28/10 ainda é 27/10 em São Paulo
  assert.equal(diasUteisDesde(ETIQUETAS_INICIO, new Date("2026-10-28T01:00:00Z")), 13);
  const est = estimativaEtiquetas(new Date("2026-10-27T15:00:00Z"));
  assert.equal(est.itens, 65);
  assert.match(String(est.observacao), /09\/10\/2026/);
  // 65 OPs × 5 min = 5 h 25 min
  assert.deepEqual(economiaInteira("etiquetas", 65), { segundos: 65 * 300, centavos: Math.round((65 * 300 * 1100) / 3600) });
});

// ------------------------------------------------------------------- período

import { lerPeriodo, noPeriodo, periodoSql } from "../src/periodo.js";
import { createLiveRoiSources } from "../src/roi.js";

test("período: lerPeriodo aceita nenhum ou os dois; só um, formato ruim ou de > ate dão erro em pt-BR", () => {
  const ler = (q: string) => lerPeriodo(new URLSearchParams(q));
  assert.deepEqual(ler(""), { periodo: { de: null, ate: null } });
  assert.deepEqual(ler("de=2026-10-01&ate=2026-10-27"), { periodo: { de: "2026-10-01", ate: "2026-10-27" } });
  assert.deepEqual(ler("de=2026-10-05&ate=2026-10-05"), { periodo: { de: "2026-10-05", ate: "2026-10-05" } });
  for (const q of ["de=2026-10-01", "ate=2026-10-01", "de=01/10/2026&ate=2026-10-27", "de=2026-02-30&ate=2026-03-01", "de=2026-10-28&ate=2026-10-27"]) {
    const r = ler(q);
    assert.ok("erro" in r, q);
    assert.match(r.erro, /data|Informe|inicial/i);
  }
});

test("período: noPeriodo usa o dia de São Paulo e periodoSql converte para UTC", () => {
  const p = { de: "2026-10-26", ate: "2026-10-26" };
  assert.equal(noPeriodo("2026-10-27T02:59:59Z", p), true); // 23:59 em SP
  assert.equal(noPeriodo("2026-10-27T03:00:00Z", p), false);
  assert.equal(noPeriodo("2026-10-26T10:00:00", p), true); // sem fuso = São Paulo
  assert.equal(noPeriodo("2026-10-20T10:00:00Z", p), false);
  assert.equal(noPeriodo("qualquer", { de: null, ate: null }), true);
  assert.deepEqual(periodoSql("c", p).values, ["2026-10-26", "2026-10-26"]);
  assert.deepEqual(periodoSql("c", { de: null, ate: null }), { where: [], values: [] });
});

test("roi: serviço guarda cache por período e repassa o período às fontes", async () => {
  const vistos: string[] = [];
  const sources = fontes(5);
  sources["accounts-payable"] = async (p) => {
    vistos.push(`${p.de}|${p.ate}`);
    return { itens: p.de ? 1 : 9 };
  };
  const roi = createRoiService("live", sources, () => AGORA);
  const total = await roi.read();
  assert.deepEqual(total.periodo, { de: null, ate: null });
  const mes = await roi.read({ de: "2026-10-01", ate: "2026-10-27" });
  assert.deepEqual(mes.periodo, { de: "2026-10-01", ate: "2026-10-27" });
  assert.equal(total.automacoes[0]!.itens, 9);
  assert.equal(mes.automacoes[0]!.itens, 1);
  await roi.read();
  await roi.read({ de: "2026-10-01", ate: "2026-10-27" });
  assert.deepEqual(vistos, ["null|null", "2026-10-01|2026-10-27"], "repetidos vêm do cache");
  for (let d = 1; d <= 25; d++) await roi.read({ de: `2026-09-${String(d).padStart(2, "0")}`, ate: "2026-09-30" });
  await roi.read();
  assert.equal(vistos.filter((v) => v === "null|null").length, 2, "limite de entradas expulsa a mais antiga");
});

test("roi: etiquetas no período usam max(de, 09/10) e min(ate, hoje)", () => {
  const hoje = new Date("2026-10-27T15:00:00Z");
  // 12–16/10 = 5 dias úteis × 5 OPs
  const sem = estimativaEtiquetas(hoje, { de: "2026-10-12", ate: "2026-10-18" });
  assert.equal(sem.itens, 25);
  assert.match(String(sem.observacao), /12\/10\/2026 a 18\/10\/2026/);
  // período anterior ao início: zero
  assert.equal(estimativaEtiquetas(hoje, { de: "2026-09-01", ate: "2026-10-08" }).itens, 0);
  // começa antes do início e termina no futuro: 09/10 até hoje = 13 dias
  assert.equal(estimativaEtiquetas(hoje, { de: "2026-01-01", ate: "2026-12-31" }).itens, 65);
  // totalmente no futuro
  assert.equal(estimativaEtiquetas(hoje, { de: "2026-11-02", ate: "2026-11-06" }).itens, 0);
  // sem período: igual ao de antes
  assert.equal(estimativaEtiquetas(hoje).itens, 65);
});

test("roi: fontes ao vivo repassam o período a histórico, auditoria, NF-e, estoque e marketplace", async () => {
  const p = { de: "2026-10-01", ate: "2026-10-27" };
  const chamadas: Record<string, unknown> = {};
  const urls: string[] = [];
  const src = createLiveRoiSources({
    history: { resumo: async (x) => ((chamadas.history = x), { contasBaixadas: 2, valorBaixado: 0 }) },
    danfe: { contarLancadas: async (x) => ((chamadas.danfe = x), 3) },
    audit: { somarDetalhe: async (_a, _c, x) => ((chamadas.audit = x), 4) },
    stockSku: { contarLancadas: async (x) => ((chamadas.estoque = x), 5) },
    marketplaceUrl: () => "http://mk",
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ total: 7, produtos_enviados: 6 }), { status: 200 });
    }) as unknown as typeof fetch,
    clock: () => new Date("2026-10-27T15:00:00Z"),
  });
  assert.equal((await src["accounts-payable"](p)).itens, 2);
  assert.equal((await src["danfe-tiny"](p)).itens, 3);
  assert.equal((await src["conciliacao-ml"](p)).itens, 4);
  assert.equal((await src["contagem-estoque"](p)).itens, 5);
  assert.equal((await src.dimensoes(p)).itens, 6);
  assert.equal((await src.fretes(p)).itens, 7);
  for (const k of ["history", "danfe", "audit", "estoque"]) assert.deepEqual(chamadas[k], p, k);
  assert.ok(urls.includes("http://mk/api/v1/dimensoes/status?de=2026-10-01&ate=2026-10-27"));
  assert.ok(urls.includes("http://mk/api/v1/fretes/historico?status=ok&limit=1&de=2026-10-01&ate=2026-10-27"));
  assert.ok(urls.includes("http://mk/api/v1/fretes/historico?limit=1"), "o aviso de truncamento olha o histórico inteiro");
  await src.dimensoes({ de: null, ate: null });
  assert.ok(urls.includes("http://mk/api/v1/dimensoes/status"));
});

test("roi: fretes soma as trocas ok que já saíram do histórico do marketplace", async () => {
  const src = createLiveRoiSources({
    history: { resumo: async () => ({ contasBaixadas: 0, valorBaixado: 0 }) },
    danfe: { contarLancadas: async () => 0 },
    audit: { somarDetalhe: async () => 0 },
    stockSku: { contarLancadas: async () => 0 },
    marketplaceUrl: () => "http://mk",
    fetchImpl: (async () => new Response(JSON.stringify({ total: 2000, ok_arquivadas: 150 }), { status: 200 })) as unknown as typeof fetch,
    clock: () => new Date("2026-10-27T15:00:00Z"),
  });
  const fretes = await src.fretes({ de: null, ate: null });
  assert.equal(fretes.itens, 2150);
  assert.equal(fretes.observacao, null, "com ok_arquivadas o histórico cheio não é mais aviso");
});

test("roi: contagem lançada continua contando depois de um reenvio com erro", async () => {
  const { createStockSkuService } = await import("../src/stock-sku.js");
  const svc = createStockSkuService({ timeoutMs: 1000 }, undefined);
  const base = {
    registro_id: "abcdef123456", sku: "PV1", produto: null, unidades: 10, saldo_anterior: 0, entrada: 10,
    id_lancamento: 1, deposito: null, mensagem: null, usuario_nome: null,
  };
  await svc.salvarEnvioTiny({ ...base, status: "lancado", enviado_em: "2026-10-20T12:00:00.000Z" }, null);
  await svc.salvarEnvioTiny({ ...base, status: "erro", enviado_em: "2026-10-27T12:00:00.000Z" }, null);
  assert.equal(await svc.contarLancadas(), 1);
  assert.equal(await svc.contarLancadas({ de: "2026-10-20", ate: "2026-10-20" }), 1, "conta pela data do 1º lançamento");
  assert.equal(await svc.contarLancadas({ de: "2026-10-27", ate: "2026-10-27" }), 0);
});
