// Automação "Padronização de dimensões" (área Marketplace). Espelha as respostas da API Python
// backend/automations/automacoes-marketplace/app/api.py (/api/v1/dimensoes/*), repassadas pelo
// gateway em /api/marketplace/dimensoes/*.

import type { Filial, Medidas } from './fretes-contracts';

export type Confiabilidade = 'alta' | 'media' | 'baixa';
export type StatusPadronizacao = 'pendente' | 'divergente' | 'padronizado';
export type FonteId = 'ml_titulo' | 'ml_descricao' | 'ml_ficha' | 'tiny_titulo' | 'tiny_descricao' | 'tiny_ficha';

export interface FonteMedida {
  fonte: FonteId;
  rotulo: string;
  local: string;
  dims: Medidas;
  /** Trecho do texto de onde a medida saiu (título/descrição). */
  texto: string | null;
}

export interface DestinoEnvio {
  status: 'ok' | 'erro';
  local: string;
  mensagem?: string;
  em: string;
}

export interface ProdutoDimensoes {
  sku: string;
  descricao: string;
  fontes: FonteMedida[];
  sugestao: Medidas;
  confiabilidade: Confiabilidade;
  confiabilidade_tamanho: Confiabilidade;
  confiabilidade_peso: Confiabilidade;
  /** "fonte|local" das fontes que concordam com a sugestão de tamanho. */
  fontes_concordantes: string[];
  anuncios: Array<{ filial: Filial; mlb: string; titulo: string; permalink: string | null }>;
  tiny: Array<{ conta: string; id: number }>;
  status: StatusPadronizacao;
  motivos: string[];
  padrao?: Medidas & {
    embalagem_comprimento: number | null;
    confiabilidade: Confiabilidade;
    validado_por: string | null;
    validado_em: string;
  };
  envio?: { status: 'enviando' | 'ok' | 'erro'; em: string | null; destinos: Record<string, DestinoEnvio> };
  coletado_em: string;
}

export interface ExecucaoColeta {
  iniciada_em: string;
  concluida_em: string;
  origem: 'agendada' | 'manual';
  status: 'ok' | 'parcial' | 'erro';
  resumo: { produtos?: number; pendentes?: number; pendencias_novas?: number; anuncios_sem_sku?: number; erros: string[] };
}

export interface DimensoesStatus {
  banco_configurado: boolean;
  contas_tiny: Array<{ id: string; rotulo: string }>;
  em_execucao: string | null;
  /** Etapa da coleta em andamento ("Tiny Revesta: cadastros…", 300 de 1.020). */
  progresso: { etapa: string; feitos: number; total: number; em: string } | null;
  ultima_execucao: ExecucaoColeta | null;
  proxima_execucao: string;
  total_produtos: number;
  por_status: Partial<Record<StatusPadronizacao, number>>;
  pendentes_por_confiabilidade: Partial<Record<Confiabilidade, number>>;
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
