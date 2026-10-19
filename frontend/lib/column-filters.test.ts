import test from "node:test";
import assert from "node:assert/strict";
import {
  aplicaFiltros,
  carregarFiltrosSession,
  converterParaDateRange,
  filtrosAtivosCount,
  isFiltroAtivo,
  normalizarDataLinha,
  normalizarTexto,
  obterValoresUnicos,
  parseNumeroBR,
  textoCombina,
  contarValores,
  salvarFiltrosSession,
  type ColumnFilterDef,
  type ColumnFiltersState,
} from "./column-filters";

interface ItemExemplo {
  id: string;
  nome: string;
  empresa: string;
  data: string;
  valor: number;
  status: string;
}

const ITENS_TESTE: ItemExemplo[] = [
  { id: "1", nome: "Café Especial & Grãos", empresa: "Norvia", data: "10/10/2026", valor: 1500.5, status: "pago" },
  { id: "2", nome: "Açúcar Cristal", empresa: "Revesta", data: "11/10/2026", valor: 250.0, status: "pendente" },
  { id: "3", nome: "Serviço de Limpeza São Paulo", empresa: "Norvia", data: "2026-10-12", valor: 3400.0, status: "pago" },
  { id: "4", nome: "Embalagens Papelão", empresa: "Revesta", data: "2026-09-01", valor: 90.75, status: "cancelado" },
];

const DEFS_TESTE: Record<string, ColumnFilterDef<ItemExemplo>> = {
  nome: { id: "nome", label: "Nome", tipo: "texto", accessor: (i) => i.nome },
  empresa: { id: "empresa", label: "Empresa", tipo: "lista", accessor: (i) => i.empresa },
  data: { id: "data", label: "Data", tipo: "data", accessor: (i) => i.data },
  valor: { id: "valor", label: "Valor", tipo: "numero", accessor: (i) => i.valor },
  status: { id: "status", label: "Status", tipo: "lista", accessor: (i) => i.status },
};

test("normalizarTexto: remove acentos e converte para minúsculas", () => {
  assert.equal(normalizarTexto("Café com Açúcar"), "cafe com acucar");
  assert.equal(normalizarTexto("  SÃO PAULO  "), "sao paulo");
  assert.equal(normalizarTexto(""), "");
  assert.equal(normalizarTexto(null), "");
});

test("parseNumeroBR: converte números e strings em formato brasileiro", () => {
  assert.equal(parseNumeroBR(1500.5), 1500.5);
  assert.equal(parseNumeroBR("1.234,56"), 1234.56);
  assert.equal(parseNumeroBR("1234,56"), 1234.56);
  assert.equal(parseNumeroBR("250"), 250);
  assert.equal(parseNumeroBR("250.75"), 250.75);
  assert.equal(parseNumeroBR(""), null);
  assert.equal(parseNumeroBR("abc"), null);
  assert.equal(parseNumeroBR(null), null);
});

test("normalizarDataLinha: converte formato brasileiro e ISO para meio-dia Brasília", () => {
  assert.equal(normalizarDataLinha("10/10/2026"), "2026-10-10T12:00:00-03:00");
  assert.equal(normalizarDataLinha("2026-10-12"), "2026-10-12T12:00:00-03:00");
  assert.equal(normalizarDataLinha(""), null);
  assert.equal(normalizarDataLinha(null), null);
});

test("aplicaFiltros: tipo texto insensível a maiúsculas e acentos", () => {
  // Busca "cafe" acha "Café Especial & Grãos"
  const res1 = aplicaFiltros(ITENS_TESTE, { nome: "cafe" }, DEFS_TESTE);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].id, "1");

  // Busca "sao paulo" acha "Serviço de Limpeza São Paulo"
  const res2 = aplicaFiltros(ITENS_TESTE, { nome: "sao paulo" }, DEFS_TESTE);
  assert.equal(res2.length, 1);
  assert.equal(res2[0].id, "3");

  // Busca sem correspondência
  const res3 = aplicaFiltros(ITENS_TESTE, { nome: "inexistente" }, DEFS_TESTE);
  assert.equal(res3.length, 0);
});

test("aplicaFiltros: tipo lista seleciona valores correspondentes", () => {
  const res1 = aplicaFiltros(ITENS_TESTE, { empresa: ["Norvia"] }, DEFS_TESTE);
  assert.equal(res1.length, 2);
  assert.deepEqual(res1.map((i) => i.id), ["1", "3"]);

  const res2 = aplicaFiltros(ITENS_TESTE, { status: ["pendente", "cancelado"] }, DEFS_TESTE);
  assert.equal(res2.length, 2);
  assert.deepEqual(res2.map((i) => i.id), ["2", "4"]);
});

test("aplicaFiltros: tipo numero suporta =, >=, <= e entre", () => {
  // Operador =
  const resIgual = aplicaFiltros(ITENS_TESTE, { valor: { op: "=", val: 250 } }, DEFS_TESTE);
  assert.equal(resIgual.length, 1);
  assert.equal(resIgual[0].id, "2");

  // Operador >=
  const resMaior = aplicaFiltros(ITENS_TESTE, { valor: { op: ">=", val: 1500 } }, DEFS_TESTE);
  assert.equal(resMaior.length, 2);
  assert.deepEqual(resMaior.map((i) => i.id), ["1", "3"]);

  // Operador <=
  const resMenor = aplicaFiltros(ITENS_TESTE, { valor: { op: "<=", val: 250 } }, DEFS_TESTE);
  assert.equal(resMenor.length, 2);
  assert.deepEqual(resMenor.map((i) => i.id), ["2", "4"]);

  // Operador entre
  const resEntre = aplicaFiltros(ITENS_TESTE, { valor: { op: "entre", val: 100, valFim: 2000 } }, DEFS_TESTE);
  assert.equal(resEntre.length, 2);
  assert.deepEqual(resEntre.map((i) => i.id), ["1", "2"]);
});

test("aplicaFiltros: tipo data com intervalo de e ate", () => {
  const res = aplicaFiltros(
    ITENS_TESTE,
    { data: { de: "2026-10-10", ate: "2026-10-11" } },
    DEFS_TESTE,
  );
  assert.equal(res.length, 2);
  assert.deepEqual(res.map((i) => i.id), ["1", "2"]);
});

test("aplicaFiltros: combina múltiplos filtros de coluna simultaneamente", () => {
  const filtros: ColumnFiltersState = {
    empresa: ["Norvia"],
    valor: { op: ">=", val: 2000 },
  };
  const res = aplicaFiltros(ITENS_TESTE, filtros, DEFS_TESTE);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, "3");
});

test("obterValoresUnicos: extrai valores ordenados e sem duplicatas", () => {
  const empresas = obterValoresUnicos(ITENS_TESTE, (i) => i.empresa);
  assert.deepEqual(empresas, ["Norvia", "Revesta"]);
});

test("filtrosAtivosCount e isFiltroAtivo", () => {
  assert.equal(isFiltroAtivo("", "texto"), false);
  assert.equal(isFiltroAtivo("abc", "texto"), true);
  assert.equal(isFiltroAtivo([], "lista"), false);
  assert.equal(isFiltroAtivo(["Norvia"], "lista"), true);
  assert.equal(isFiltroAtivo({ op: ">=", val: null }, "numero"), false);
  assert.equal(isFiltroAtivo({ op: ">=", val: 10 }, "numero"), true);
  assert.equal(isFiltroAtivo({ preset: "all" }, "data"), false);
  assert.equal(isFiltroAtivo({ de: "2026-10-01" }, "data"), true);

  const filtros: ColumnFiltersState = {
    nome: "teste",
    empresa: ["Norvia"],
    valor: { op: ">=", val: null }, // inativo
  };
  assert.equal(filtrosAtivosCount(filtros, DEFS_TESTE), 2);
});

test("salvarFiltrosSession e carregarFiltrosSession: trata ausência de storage sem estourar", () => {
  // No ambiente Node sem window, deve rodar sem erros
  salvarFiltrosSession("teste", "aba1", { nome: "filtro" });
  const carregado = carregarFiltrosSession("teste", "aba1", { padrao: "abc" });
  assert.deepEqual(carregado, { padrao: "abc" });
});

test("parseNumeroBR: ponto só de milhar vale mil, e aceita R$", () => {
  assert.equal(parseNumeroBR("1.500"), 1500);
  assert.equal(parseNumeroBR("12.345.678"), 12345678);
  assert.equal(parseNumeroBR("R$ 1.500,00"), 1500);
  assert.equal(parseNumeroBR("-1.500"), -1500);
  assert.equal(parseNumeroBR("1.5"), 1.5);
});

test("textoCombina: termo numérico compara só os dígitos (CNPJ, documento)", () => {
  assert.equal(textoCombina("12345678000190", "ACME LTDA 12.345.678/0001-90"), true);
  assert.equal(textoCombina("12.345.678/0001-90", "ACME 12345678000190"), true);
  assert.equal(textoCombina("acme", "Ácme Ltda"), true);
  assert.equal(textoCombina("999", "ACME 12345678000190"), false);
  assert.equal(textoCombina("", "qualquer"), true);
});

test("contarValores: conta linhas por valor e ignora vazios", () => {
  assert.deepEqual(contarValores([{ v: "a" }, { v: "b" }, { v: "a" }, { v: "" }, { v: null }], (i) => i.v), { a: 2, b: 1 });
});
