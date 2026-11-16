// Automação "Padronização de dimensões" (área Marketplace). Espelha as respostas da API Python
// backend/automations/automacoes-marketplace/app/api.py (/api/v1/dimensoes/*), repassadas pelo
// gateway em /api/marketplace/dimensoes/*.

import type { Filial, Medidas } from './fretes-contracts';

/**
 * pendente = algum anúncio diferente do Tiny (a enviar); bloqueado = o ML não aceita a alteração
 * (pendência a corrigir no Tiny ou no ML; reenviar não adianta); sem_medida = falta medida/peso bruto no Tiny.
 */
export type StatusPadronizacao = 'pendente' | 'bloqueado' | 'sem_medida' | 'padronizado';
/** Anúncio diante do cadastro do Tiny da mesma empresa. */
export type SituacaoAnuncioDimensoes = 'igual' | 'diferente' | 'sem_tiny' | 'sem_medida' | 'bloqueado_ml';

export interface DestinoEnvio {
  status: 'ok' | 'erro' | 'bloqueado';
  local: string;
  mensagem?: string;
  em: string;
}

export interface AnuncioDimensoes {
  filial: Filial;
  mlb: string;
  titulo: string;
  permalink: string | null;
  /** Atributos de medida que o anúncio já usa na ficha (LENGTH, WIDTH, WEIGHT…). */
  atributos: string[];
  /** Valor atual de cada atributo da ficha (cm; os de peso em g), null se vazio. */
  ficha_atual?: Record<string, number | null>;
  ficha_ml: Medidas;
  embalagem_ml: Medidas;
  situacao: SituacaoAnuncioDimensoes;
  conta_tiny: string;
  /** Medidas do Tiny (com o peso bruto) que valem para este anúncio. */
  alvo: Medidas | null;
  ficha_alvo: Record<string, number>;
  embalagem_alvo: Medidas | null;
  /** O que vai no envio: só os atributos e a embalagem diferentes do Tiny. */
  ficha_diferente?: string[];
  embalagem_diferente?: boolean;
  diferencas: string[];
  mensagem: string | null;
}

export interface CadastroTiny {
  conta: string;
  rotulo: string;
  id: number;
  medidas: Medidas;
  peso_liquido: number | null;
}

export interface ProdutoDimensoes {
  sku: string;
  descricao: string;
  tiny: CadastroTiny[];
  anuncios: AnuncioDimensoes[];
  status: StatusPadronizacao;
  motivos: string[];
  envio?: { status: 'enviando' | 'ok' | 'erro' | 'bloqueado'; em: string | null; destinos: Record<string, DestinoEnvio>; por?: string | null };
  coletado_em: string;
}

export interface ExecucaoColeta {
  iniciada_em: string;
  concluida_em: string;
  origem: 'agendada' | 'manual';
  status: 'ok' | 'parcial' | 'erro';
  resumo: { produtos?: number; pendentes?: number; bloqueados?: number; sem_medida?: number; pendencias_novas?: number; anuncios_sem_sku?: number; erros: string[] };
}

export interface DimensoesStatus {
  banco_configurado: boolean;
  contas_tiny: Array<{ id: string; rotulo: string; filial: Filial }>;
  em_execucao: string | null;
  /** Etapa da coleta em andamento ("Tiny Revesta: cadastros…", 300 de 1.020). */
  progresso: { etapa: string; feitos: number; total: number; em: string } | null;
  ultima_execucao: ExecucaoColeta | null;
  proxima_execucao: string;
  total_produtos: number;
  por_status: Partial<Record<StatusPadronizacao, number>>;
  /** Anúncios diferentes do Tiny, somados de todos os produtos. */
  anuncios_a_enviar: number;
  /** Produtos cujo último envio ao ML deu certo (base do ROI). */
  produtos_enviados: number;
  com_erro_de_envio: number;
  enviando: number;
  anuncios_sem_sku: number;
}

export interface ProdutosPage {
  itens: ProdutoDimensoes[];
  total: number;
  page: number;
  page_size: number;
}

export interface AnuncioSemSku {
  filial: Filial;
  mlb: string;
  titulo: string;
  permalink: string | null;
}
