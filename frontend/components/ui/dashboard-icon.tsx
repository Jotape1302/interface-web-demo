import type { SVGProps } from 'react';

/**
 * Ícone customizado (a lucide-react não tem um "dashboard com gráficos dentro
 * da tela" pronto) pedido explicitamente pelo usuário: um card/monitor com um
 * gráfico de pizza, linhas de lista e um mini gráfico de barras+linha dentro.
 * Desenhado no mesmo estilo dos ícones lucide (stroke, sem preenchimento,
 * pontas arredondadas) para ficar visualmente consistente com o resto do app.
 */
export function DashboardChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9.5" r="2.4" />
      <path d="M8 7.1V9.5L10 10.8" />
      <path d="M14 7h4" />
      <circle cx="13" cy="7" r="0.4" fill="currentColor" stroke="none" />
      <path d="M14 9.5h4" />
      <circle cx="13" cy="9.5" r="0.4" fill="currentColor" stroke="none" />
      <path d="M6 17h3" />
      <circle cx="5" cy="17" r="0.4" fill="currentColor" stroke="none" />
      <path d="M13 18v-3" />
      <path d="M16 18v-4.5" />
      <path d="M19 18v-2.5" />
      <path d="M12.5 13.5 15 11.5l2.5 1.5 2-2.5" />
    </svg>
  );
}
