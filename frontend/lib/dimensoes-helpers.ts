import type { SituacaoAnuncioDimensoes, StatusPadronizacao } from './dimensoes-contracts';

export const STATUS_PADRONIZACAO_INFO: Record<StatusPadronizacao, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' }> = {
  pendente: { label: 'A enviar ao ML', variant: 'warning' },
  bloqueado: { label: 'Bloqueado no ML', variant: 'warning' },
  sem_medida: { label: 'Sem medida no Tiny', variant: 'danger' },
  padronizado: { label: 'Igual ao Tiny', variant: 'success' },
};

export const SITUACAO_ANUNCIO_INFO: Record<SituacaoAnuncioDimensoes, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
  diferente: { label: 'Diferente do Tiny', variant: 'warning' },
  igual: { label: 'Igual ao Tiny', variant: 'success' },
  sem_tiny: { label: 'SKU fora do Tiny', variant: 'danger' },
  sem_medida: { label: 'Tiny sem medida', variant: 'danger' },
  bloqueado_ml: { label: 'Bloqueado no ML', variant: 'warning' },
};

/** Atributo da ficha do ML → nome na tela. */
export const ATRIBUTO_ROTULO: Record<string, string> = {
  HEIGHT: 'Altura',
  THICKNESS: 'Espessura',
  WIDTH: 'Largura',
  LENGTH: 'Comprimento',
  WEIGHT: 'Peso',
  NET_WEIGHT: 'Peso líquido',
};

/** "300 cm", "850 g" (atributos de peso em g, o resto em cm). */
export function valorAtributo(attrId: string, v: number | null | undefined): string {
  if (v == null) return 'vazio';
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${attrId.includes('WEIGHT') ? 'g' : 'cm'}`;
}

/** Produto pode ir na confirmação em lote: tem anúncio diferente do Tiny e não está enviando. */
export function podeConfirmar(p: { status: StatusPadronizacao; envio?: { status: string } }): boolean {
  return p.status === 'pendente' && p.envio?.status !== 'enviando';
}
