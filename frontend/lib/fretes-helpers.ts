import type { Medidas, SituacaoAnuncio } from './fretes-contracts';

/** "60 × 40 × 15 cm"; campos vazios aparecem como "?". Só tamanho: peso não é usado. */
export function formatMedidas(m: Medidas | null | undefined): string {
  if (!m || [m.altura, m.largura, m.comprimento].every((v) => v == null)) return '—';
  const lado = (v: number | null) => (v == null ? '?' : numero(v));
  return `${lado(m.altura)} × ${lado(m.largura)} × ${lado(m.comprimento)} cm`;
}

function numero(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/** Campo do formulário ("12,5", "", " 30 ") → número ou null. */
export function parseMedida(texto: string): number | null {
  const t = texto.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type CampoMedida = 'altura' | 'largura' | 'comprimento' | 'peso';

export function medidasParaCampos(m: Medidas | null | undefined): Record<CampoMedida, string> {
  const txt = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','));
  return { altura: txt(m?.altura), largura: txt(m?.largura), comprimento: txt(m?.comprimento), peso: txt(m?.peso) };
}

export function camposParaMedidas(c: Record<CampoMedida, string>): Medidas {
  const peso = parseMedida(c.peso);
  return {
    altura: parseMedida(c.altura),
    largura: parseMedida(c.largura),
    comprimento: parseMedida(c.comprimento),
    peso: peso == null ? null : Math.round(peso),
  };
}

export function rotuloModo(modo: string | null | undefined): string {
  switch (modo) {
    case 'me1':
      return 'ME1';
    case 'me2':
      return 'ME2';
    case 'not_specified':
      return 'A combinar';
    case 'custom':
      return 'Personalizado';
    default:
      return modo || '—';
  }
}

export const SITUACAO_INFO: Record<SituacaoAnuncio, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' }> = {
  a_combinar: { label: 'A combinar', variant: 'danger' },
  bloqueado: { label: 'A combinar (bloqueado)', variant: 'warning' },
  conferindo: { label: 'Conferindo', variant: 'info' },
  falha: { label: 'ML desfez', variant: 'danger' },
  ok: { label: 'Ok', variant: 'success' },
};

