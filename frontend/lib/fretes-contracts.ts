// Automação "Fretes a combinar" (área Marketplace). Espelha as respostas da API Python
// backend/automations/automacoes-marketplace/app/api.py, repassadas pelo gateway em
// /api/marketplace/fretes/*.

export type Filial = 'revesta' | 'norvia';

export interface Medidas {
  altura: number | null; // cm
  largura: number | null; // cm
  comprimento: number | null; // cm
  /** Opcional na interface; obrigatório só quando o anúncio não tem peso no ML (`precisa_peso`). */
  peso?: number | null; // g
}

/**
 * conferindo = alteração enviada, aguardando a conferência de 10 min; bloqueado = a combinar que
 * a automação não pode trocar (sem dimensões padronizadas, não cabe na embalagem…).
 */
export type SituacaoAnuncio = 'a_combinar' | 'bloqueado' | 'conferindo' | 'falha' | 'ok';

export type BloqueioFrete = 'sem_padrao' | 'sem_sku' | 'sem_embalagem' | 'sem_peso' | 'sem_me1';

export interface AnuncioFrete {
  filial: Filial;
  mlb: string;
  titulo: string;
  sku: string | null;
  skus: string[];
  status: string;
  permalink: string | null;
  thumbnail: string | null;
  modo_envio: string | null;
  tags_envio: string[];
  /** Dimensões padronizadas do produto (dimensoes_produtos), se houver. */
  padrao: (Medidas & { sku: string }) | null;
  /** Embalagem padrão (5 x 7 x 100/200/300) que vai ao ML. */
  embalagem: Medidas | null;
  embalagem_ml: Medidas;
  envio_indicado: 'me1' | 'me2' | null;
  bloqueio: BloqueioFrete | null;
  bloqueio_texto: string | null;
  falha_envio: { mensagem: string; em: string } | null;
  situacao: SituacaoAnuncio;
  sincronizado_em: string | null;
}

export interface AnunciosPage {
  itens: AnuncioFrete[];
  total: number;
  page: number;
  page_size: number;
}

export interface TrocaFrete {
  id: string;
  filial: Filial;
  mlb: string;
  titulo: string | null;
  de: string | null;
  para: string | null;
  dims: Medidas | null;
  origem: 'rotina' | 'manual';
  usuario: string | null;
  feita_em: string;
  verificar_em: string | null;
  verificado_em?: string;
  status: 'aguardando' | 'ok' | 'revertido' | 'erro';
  mensagem: string | null;
}

export interface ExecucaoFretes {
  iniciada_em: string;
  concluida_em: string;
  origem: 'agendada' | 'manual';
  status: 'ok' | 'parcial' | 'erro';
  resumo: {
    novos: number;
    pendencias_novas: number;
    trocas: number;
    erros: string[];
    contas: Record<string, { status: string; mensagem?: string; anuncios?: number }>;
  };
}

export interface FretesStatus {
  configurado: boolean;
  contas: Record<Filial, { rotulo: string; conectada: boolean; renovado_em: string | null; me1: boolean }>;
  em_execucao: string | null;
  ultima_execucao: ExecucaoFretes | null;
  proxima_execucao: string;
  total_anuncios: number;
  contagem: Partial<Record<SituacaoAnuncio, number>>;
  /** Anúncios ativos por modo de envio do ML (me1, me2, not_specified...). */
  envios: Record<string, number>;
  /** Anúncios em que o ML desfez a última alteração (aba "ML desfez"). */
  desfeitos: number;
  /** Anúncios com alteração enviada, esperando a conferência de 10 min. */
  aguardando_conferencia: number;
  /** Anúncios sem dimensões padronizadas (ou sem SKU): esperam a Padronização de dimensões. */
  sem_padrao: number;
  minutos_conferencia: number;
}

export interface HistoricoFretes {
  itens: TrocaFrete[];
  total: number;
  execucoes: ExecucaoFretes[];
}
