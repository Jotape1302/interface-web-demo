import test from 'node:test';
import assert from 'node:assert/strict';
import { createStockCountService } from './stock-count-service';

void test('StockCountService (modo demo): lista itens e suporta filtros', async (t) => {
  const prevEnv = process.env.NEXT_PUBLIC_DATA_MODE;
  process.env.NEXT_PUBLIC_DATA_MODE = 'demo';
  t.after(() => {
    if (prevEnv === undefined) delete process.env.NEXT_PUBLIC_DATA_MODE;
    else process.env.NEXT_PUBLIC_DATA_MODE = prevEnv;
  });

  const service = createStockCountService();
  const res = await service.listarContagens({ pageSize: 10 });

  assert.equal(res.configurado, true);
  assert.ok(res.itens.length > 0);
  assert.ok(res.total >= res.itens.length);

  // Filtro por status
  const filtrados = await service.listarContagens({ status: 'confirmada' });
  for (const item of filtrados.itens) {
    assert.equal(item.status, 'confirmada');
  }

  // URL da imagem
  const imgUrl = service.imagemUrl(res.itens[0]!.id, 'anotada');
  assert.ok(typeof imgUrl === 'string');
  assert.ok(imgUrl.length > 0);
});
