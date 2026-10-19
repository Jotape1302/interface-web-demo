import type { Confiabilidade, StatusPadronizacao } from './dimensoes-contracts';
import type { Medidas } from './fretes-contracts';

// Mesma embalagem padrão do backend (dimensoes.embalagem_para): seção 5 x 7 cm e o menor
// comprimento padrão que caiba o produto. Só para a tela mostrar a consequência ao digitar.
export const EMBALAGEM_SECAO: [number, number] = [5, 7];
export const EMBALAGEM_COMPRIMENTOS = [100, 200, 300];

export function embalagemPara(m: Medidas): { comprimento: number } | null {
  const lados = [m.altura, m.largura, m.comprimento];
  if (lados.some((v) => v == null || v <= 0)) return null;
  const [menor, meio, maior] = (lados as number[]).slice().sort((a, b) => a - b);
  if (menor > EMBALAGEM_SECAO[0] || meio > EMBALAGEM_SECAO[1]) return null;
  const comprimento = EMBALAGEM_COMPRIMENTOS.find((c) => maior <= c);
  return comprimento ? { comprimento } : null;
}

/** Tamanho + peso preenchidos (o ML exige peso junto com as medidas). */
export function medidasValidas(m: Medidas): boolean {
  return [m.altura, m.largura, m.comprimento, m.peso].every((v) => v != null && v > 0);
}

export const CONFIABILIDADE_INFO: Record<Confiabilidade, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
  alta: { label: 'Alta confiabilidade', variant: 'success' },
  media: { label: 'Média confiabilidade', variant: 'warning' },
  baixa: { label: 'Baixa confiabilidade', variant: 'danger' },
};

export const STATUS_PADRONIZACAO_INFO: Record<StatusPadronizacao, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' }> = {
  pendente: { label: 'A revisar', variant: 'warning' },
  divergente: { label: 'Divergente do padrão', variant: 'danger' },
  padronizado: { label: 'Padronizado', variant: 'success' },
};
