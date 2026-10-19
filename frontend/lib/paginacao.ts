/**
 * Lê todas as páginas de um endpoint paginado. As telas com filtro por coluna filtram no
 * navegador, então precisam da lista inteira; cada API tem o seu teto de itens por página
 * (gateway da contagem: 100; marketplace: 200), e pedir acima dele corta a lista ou dá 422.
 */
export async function buscarTodasPaginas<T>(
  buscarPagina: (page: number) => Promise<{ itens: T[]; total: number }>,
  maxPaginas = 50,
): Promise<{ itens: T[]; total: number }> {
  const itens: T[] = [];
  let total = 0;
  for (let page = 1; page <= maxPaginas; page++) {
    const res = await buscarPagina(page);
    total = res.total;
    itens.push(...res.itens);
    if (res.itens.length === 0 || itens.length >= res.total) break;
  }
  return { itens, total };
}
