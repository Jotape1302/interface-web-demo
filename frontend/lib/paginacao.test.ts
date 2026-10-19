import test from "node:test";
import assert from "node:assert/strict";
import { buscarTodasPaginas } from "./paginacao";

function fonte(total: number, porPagina: number) {
  const chamadas: number[] = [];
  const dados = Array.from({ length: total }, (_, i) => i);
  const buscar = async (page: number) => {
    chamadas.push(page);
    return { itens: dados.slice((page - 1) * porPagina, page * porPagina), total };
  };
  return { buscar, chamadas };
}

void test("buscarTodasPaginas junta as páginas até o total", async () => {
  const { buscar, chamadas } = fonte(250, 100);
  const res = await buscarTodasPaginas(buscar);
  assert.equal(res.itens.length, 250);
  assert.equal(res.total, 250);
  assert.deepEqual(chamadas, [1, 2, 3]);
});

void test("buscarTodasPaginas para em página vazia e respeita o máximo de páginas", async () => {
  const vazio = fonte(0, 100);
  assert.deepEqual(await buscarTodasPaginas(vazio.buscar), { itens: [], total: 0 });
  assert.deepEqual(vazio.chamadas, [1]);

  const grande = fonte(1000, 100);
  const res = await buscarTodasPaginas(grande.buscar, 3);
  assert.equal(res.itens.length, 300);
  assert.equal(res.total, 1000);
});
