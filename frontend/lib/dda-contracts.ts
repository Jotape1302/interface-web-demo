// Contratos da automação de boletos DDA (gateway /api/dda/* → motor financeiro app/dda_pagamentos.py).

export type DdaSituacao =
  | 'NOVO'
  | 'SEM_CONTA'
  | 'AMBIGUO'
  | 'CASADO'
  | 'VENCIDO_SEM_AGENDAR'
  | 'AGENDADO'
  | 'PAGO'
  | 'BAIXADO'
  | 'RECUSADO'
  | 'ENCERRADO'
  | 'DESCARTADO'
  | 'ERRO';

export interface DdaContaResumo {
  id: number;
  fornecedor: string;
  historico: string;
  numero_documento: string;
  valor: string;
  vencimento: string;
}

export interface DdaEvento {
  em: string;
  texto: string;
  usuario?: string;
}

export interface DdaSugestaoCategoria {
  categoria_id: string;
  origem: 'historico' | 'qwen';
  /** painel = última escolha no painel; tiny = categoria dominante no Tiny; tiny_fraco = histórico dividido. */
  nivel?: 'painel' | 'tiny' | 'tiny_fraco';
  confianca?: 'alta' | 'media' | 'baixa';
  motivo?: string | null;
  vezes_tiny?: number;
  distribuicao?: { categoria_id: string; vezes: number; valor_medio: number; ultima?: string }[];
}

export interface DdaBoleto {
  id: string;
  empresa: string;
  situacao: DdaSituacao;
  mensagem: string;
  beneficiario_nome: string;
  beneficiario_cnpj: string;
  sacador_cnpj?: string;
  valor: string;
  valor_atualizado?: string;
  vencimento: string;
  emissao?: string;
  documento?: string;
  linha_digitavel?: string;
  codigo_barras?: string;
  status_polp_label?: string;
  fraude?: boolean;
  conta_id?: number;
  conta?: DdaContaResumo;
  candidatos?: DdaContaResumo[];
  conta_criada_incerta?: boolean;
  /** Categoria pré-selecionada do boleto sem conta: histórico do fornecedor (Tiny/painel) ou Qwen. */
  sugestao_categoria?: DdaSugestaoCategoria | null;
  /** Validação humana do casamento (obrigatória antes do agendamento no Inter). */
  validacao?: { por: string; em: string };
  inter?: {
    codigo_transacao?: string;
    status?: string;
    aprovacoes_necessarias?: number | null;
    aprovacoes_realizadas?: number | null;
    data_agendamento?: string | null;
    valor_pago?: string;
    data_pagamento?: string;
  };
  eventos?: DdaEvento[];
  atualizado_em?: string;
}

export interface DdaCadastro {
  empresa: string;
  nome?: string;
  status?: number;
  status_label?: string;
  ativo: boolean;
  boletos_synced_at?: string | null;
  lido_em?: string;
}

export interface DdaExecucao {
  origem: string;
  usuario?: string;
  inicio: string;
  fim?: string;
  erros: string[];
  [etapa: string]: unknown;
}

export interface DdaStatus {
  configurado: boolean;
  ativo: boolean;
  agendar_no_inter: boolean;
  intervalo_minutos: number;
  cadastros: DdaCadastro[];
  por_situacao: Partial<Record<DdaSituacao, number>>;
  ultima_execucao: DdaExecucao | null;
  em_execucao: boolean;
}

export interface DdaCategoria {
  id: string;
  nome: string;
  grupo: string;
}

export interface DdaJob<R = DdaExecucao> {
  status: 'executando' | 'concluido' | 'erro';
  etapa?: string;
  atual?: number;
  total?: number;
  erro?: string;
  resultado?: R;
}

export interface DdaCriarContaItem {
  boleto_id: string;
  categoria_id: number;
  historico: string;
}

export interface DdaCriarContasResultado {
  resultados: Array<{ boleto_id: string; ok: boolean; conta_id?: number; erro?: string }>;
  total_sucessos: number;
  total_falhas: number;
}

export interface DdaValidarResultado {
  validados: string[];
  recusados: Array<{ id: string; motivo: string }>;
}
