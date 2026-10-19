import test from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "./csv-export";

test("usa ; como separador e vírgula decimal", () => {
  assert.equal(toCsv(["Empresa", "Valor"], [["Fabrilux", 1234.5]]), "Empresa;Valor\r\nFabrilux;1234,5");
});

test("escapa aspas, ; e quebras de linha", () => {
  assert.equal(toCsv(["A"], [['Fornecedor "X"; filial\nSP']]), 'A\r\n"Fornecedor ""X""; filial\nSP"');
});

test("vazio para null/undefined e Sim/Não para boolean", () => {
  assert.equal(toCsv(["a", "b", "c"], [[null, undefined, true]]), "a;b;c\r\n;;Sim");
});

test("neutraliza fórmulas em texto, mas não números negativos", () => {
  assert.equal(toCsv(["a", "b"], [["=HYPERLINK(1)", -10]]), "a;b\r\n'=HYPERLINK(1);-10");
});
