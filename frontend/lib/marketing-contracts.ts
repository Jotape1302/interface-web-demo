export interface CarrosselSlide {
  tipo: 'capa' | 'texto' | 'produto' | 'cta';
  titulo: string;
  texto: string;
}

export interface CardTecnico {
  produto_slug: string;
  pasta_tema: string;
  frase: string;
  etiqueta_tecnica: string;
}

export interface CopyEdicaoNorvia {
  assunto: string;
  assunto_alt?: string;
  preheader: string;
  selo_pauta?: string;
  titulo_principal: string;
  texto_hero?: string;
  destaque_hero?: string;
  cta_hero_texto?: string;
  cards?: CardTecnico[];
  carrossel?: CarrosselSlide[];
  legenda_instagram: string;
  // Campos legados (compatibilidade com rascunhos antigos/mock)
  chapeu_categoria?: string;
  subtitulo?: string;
  legenda_foto?: string;
  paragrafos_corpo?: string[];
  titulo_box_motivos?: string;
  motivos_destaque?: Array<{ titulo: string; texto: string }>;
  chamada_produto_titulo?: string;
  chamada_produto_texto?: string;
  slides_instagram?: string[];
}

export interface AmbienteImagem {
  id: string;
  produto_slug: string;
  linha: string;
  status: 'candidata' | 'aprovada' | 'recusada';
  aprovada_por: string | null;
  aprovada_em: string | null;
  recusada_por?: string | null;
  recusada_em?: string | null;
  gerada_em: string;
  gerada_por: string;
  descricao: string;
  provedor: string;
  modelo: string;
  prompt: string;
  proporcao: string;
  largura: number;
  altura: number;
  tamanho_bytes: number;
  url_publica: string;
  url_preview: string;
  formato_4x5?: 'gerado' | 'recorte';
}

export interface RascunhoEdicao {
  id: string;
  dia_semana: string;
  data_prevista: string;
  edicao_numero: number;
  status: 'pendente_aprovacao' | 'aprovado';
  aprovado_por?: string | null;
  aprovado_em?: string | null;
  produto_slug: string;
  produto_nome: string;
  produto_referencia: string;
  marca: string;
  artigo_fonte?: string | null;
  artigo_titulo?: string | null;
  artigo_url?: string | null;
  artigo_resumo?: string | null;
  pauta?: 'artigo_rss' | 'guia_tecnico' | null;
  carrossel_slides?: number;
  carrossel_erro?: string | null;
  imagens?: {
    hero: string;
    cards: string[];
    carrossel: string;
  };
  copy: CopyEdicaoNorvia;
  html_email_preview: string;
  html_email_rd_station: string;
  criado_em: string;
  atualizado_em: string;
}

export interface ProdutoEditorial {
  slug: string;
  nome: string;
  nome_curto: string;
  referencia: string;
  categoria_tag: string;
  categoria_oficial: string;
  imagem_preview: string;
  imagem_rd_station: string;
  render_3d?: string;
  url_produto: string;
  especificacoes_site: string;
  resumo_card: string;
  marca: string;
  marca_propria: boolean;
}

export interface ProdutoCatalogoNorvia {
  nome: string;
  url: string;
  imagem_principal: string;
  referencia: string;
  preco_de?: number | null;
  preco_por?: number | null;
  descricao_completa_site: string;
  categoria_oficial: string;
  marca: string;
  marca_propria: boolean;
  atributos: {
    tamanho?: string[];
    cor?: string[];
    tom?: string[];
  };
}

export interface GeracaoMarketing {
  em_andamento: boolean;
  iniciada_em: string | null;
  iniciada_por: string | null;
  ultimo_erro: string | null;
}

export interface MarketingStatus {
  status: string;
  servico: string;
  total_rascunhos_semana: number;
  aprovados: number;
  pendentes: number;
  /** null = geração automática de sexta desligada. */
  proxima_geracao_sexta: string | null;
  total_produtos_catalogo: number;
  total_produtos_marca_propria: number;
  marca_oficial_ativa: string;
  mock_mode: boolean;
  ia_configurada: string[];
  geracao: GeracaoMarketing;
  geracao_imagens?: GeracaoMarketing;
  imagens_geradas_hoje?: number;
  imagens_limite_dia?: number;
  provedor_imagem?: string;
}

export interface ExecucaoMarketing {
  id: string;
  tipo: string;
  sucesso: boolean;
  detalhes: Record<string, unknown>;
  timestamp: string;
}
