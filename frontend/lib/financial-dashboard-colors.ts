/**
 * Paleta padronizada do Dashboard Financeiro — cores fixas em hex (nunca
 * `var(--...)` passado direto para atributos SVG do recharts: `fill`/`stroke`
 * são atributos de apresentação e, nesta stack, não resolvem custom properties
 * de forma confiável — o valor inválido cai para o preto padrão do SVG).
 * A cor certa por modo (claro/escuro) é escolhida em runtime via `useTheme()`.
 *
 * Papéis semânticos fixos (nunca trocam de cor entre seções do dashboard):
 * - entrada (receita/recebimentos): verde/esmeralda — mesmo tom de "sucesso" já usado no resto do app.
 * - saida (despesa/pagamentos): rosa/vermelho — mesmo tom de "erro/atenção" já usado no resto do app.
 * - faturamentoBruto (vendas, sem receitas financeiras): azul.
 * - lucro (resultado líquido/margem): roxo.
 * - categorias: paleta categórica de 6 cores, ordem fixa, validada contra daltonismo (skill dataviz).
 */

export interface FinancialPalette {
  entrada: string;
  saida: string;
  faturamentoBruto: string;
  lucro: string;
  neutro: string;
  categorias: string[];
  outros: string;
}

const LIGHT: FinancialPalette = {
  entrada: '#09726d',
  saida: '#e11d48',
  faturamentoBruto: '#2a78d6',
  lucro: '#7c3aed',
  neutro: '#78716c',
  categorias: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7'],
  outros: '#a8a29e',
};

const DARK: FinancialPalette = {
  entrada: '#10b981',
  saida: '#fb7185',
  faturamentoBruto: '#3987e5',
  lucro: '#a78bfa',
  neutro: '#a1a1aa',
  categorias: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'],
  outros: '#71717a',
};

export function getFinancialPalette(theme: 'light' | 'dark'): FinancialPalette {
  return theme === 'dark' ? DARK : LIGHT;
}

export function categoryColor(palette: FinancialPalette, index: number): string {
  return palette.categorias[index % palette.categorias.length];
}
