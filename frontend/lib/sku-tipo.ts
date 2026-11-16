// Agrupamento dos produtos da padronização de dimensões pelo formato do SKU.
// "Final MP" tem prioridade: um SKU como "ABC-10MP" fica em Final MP, não em Possui "-".

export const TIPOS_SKU = ['Final MP', 'Possui "-"', 'Outros'] as const;
export type TipoSku = (typeof TIPOS_SKU)[number];

export function tipoSku(sku: string): TipoSku {
  const s = sku.trim().toUpperCase();
  if (s.endsWith('MP')) return 'Final MP';
  if (s.includes('-')) return 'Possui "-"';
  return 'Outros';
}

/** Quantidade de produtos em cada tipo de SKU. */
export function contarTiposSku(skus: readonly string[]): Record<TipoSku, number> {
  const contagem: Record<TipoSku, number> = { 'Final MP': 0, 'Possui "-"': 0, Outros: 0 };
  for (const sku of skus) contagem[tipoSku(sku)] += 1;
  return contagem;
}
