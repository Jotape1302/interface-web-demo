/** SKU informado pelo painel para contagem que o bot registrou sem produto (espelha SkuManual do gateway). */
export interface StockCountSkuManual {
  registro_id: string;
  sku: string;
  usuario_nome: string | null;
  informado_em: string;
}

/** Conferência feita no painel (espelha Conferencia do gateway). */
export interface StockCountConferencia {
  registro_id: string;
  status: 'confirmada' | 'corrigida';
  /** Fardos (marcadores) conferidos. */
  quantidade_final: number;
  unidades_por_fardo: number;
  unidades_soltas: number;
  /** fardos × unidades por fardo + soltas: o que vai para o Tiny. */
  unidades_total: number;
  usuario_nome: string | null;
  conferida_em: string;
}

/** Último envio da contagem ao estoque do Tiny (espelha EnvioTiny do gateway). */
export interface StockCountEnvioTiny {
  registro_id: string;
  /** lancado: entrou a diferença; sem_entrada: o Tiny já tinha o contado ou mais (nada sai). */
  status: 'lancado' | 'sem_entrada' | 'erro';
  sku: string;
  /** Nome do produto no Tiny. */
  produto: string | null;
  unidades: number;
  saldo_anterior: number | null;
  entrada: number | null;
  id_lancamento: number | null;
  deposito: string | null;
  mensagem: string | null;
  usuario_nome: string | null;
  enviado_em: string;
}

/** Produto e saldo atual no Tiny (só leitura), para conferir o SKU e comparar com a foto. */
export interface StockCountConsultaTiny {
  sku: string;
  id_produto: number;
  produto: string;
  unidade: string;
  deposito: string | null;
  /** null quando o produto tem mais de um depósito e nenhum está configurado (ver aviso). */
  saldo: number | null;
  aviso: string | null;
  consultado_em: string;
}

export interface StockCountConferirInput {
  quantidade: number;
  unidades_por_fardo: number;
  unidades_soltas: number;
}

/** Unidades por fardo quando nada foi informado antes para o SKU. */
export const UNIDADES_POR_FARDO_PADRAO = 5;

export type StockCountStatus = 'aguardando_confirmacao' | 'confirmada' | 'corrigida';

export interface StockCountItem {
  id: string;
  /** Número sequencial da contagem: o mesmo da observação do lançamento no Tiny. */
  numero?: number;
  criado_em: string;
  codigo: string | null;
  origem_codigo: string | null;
  sku_legenda?: string | null;
  codigos_barras?: string[];
  quantidade_detectada: number;
  /** Cor do prendedor: verde = fardo de 5 un., rosa (choque) = fardo de 10. Ausente nas contagens antigas. */
  cor?: 'verde' | 'rosa';
  /** Unidades por fardo pela cor: com ela o painel só pede as unidades soltas. */
  unidades_por_fardo?: number;
  quantidade_final: number | null;
  status: StockCountStatus;
  alertas: string[];
  telegram_user_id: number | null;
  telegram_user: string;
  telegram_chat_id: number | null;
  foto_sha256?: string;
  imagem: string;
  imagem_original?: string;
  concluido_em: string | null;
  sku_manual?: StockCountSkuManual | null;
  conferencia?: StockCountConferencia | null;
  tiny?: StockCountEnvioTiny | null;
}

export interface StockCountListResponse {
  configurado: boolean;
  itens: StockCountItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StockCountQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  sku?: string;
  data_inicio?: string;
  data_fim?: string;
}
