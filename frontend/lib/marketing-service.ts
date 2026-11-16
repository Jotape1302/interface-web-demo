import { apiErrorMessage } from './api-errors';
import { demoDelay } from './demo-session';
import type {
  AmbienteImagem,
  ExecucaoMarketing,
  MarketingStatus,
  ProdutoCatalogoNorvia,
  ProdutoEditorial,
  RascunhoEdicao,
} from './marketing-contracts';

const DEMO_AMBIENTES: AmbienteImagem[] = [
  {
    id: 'mod-rodape-invertido-sala',
    produto_slug: 'rodape_invertido',
    linha: 'rodape_invertido',
    status: 'aprovada',
    aprovada_por: 'modelo aprovado pelo usuário em 12/11/2026',
    aprovada_em: '2026-11-12T00:00:00',
    gerada_em: '2026-11-12T00:00:00',
    gerada_por: 'modelo',
    descricao: 'Sala de estar contemporânea com rodapé invertido iluminado',
    provedor: 'modelo_aprovado',
    modelo: 'manual_12/11/2026',
    prompt: 'Sala contemporânea com rodapé invertido e luz indireta',
    proporcao: '3:2',
    largura: 1200,
    altura: 800,
    tamanho_bytes: 147530,
    url_publica: 'https://servidor.norvia.example/marketing-imagens/ambientes/rodape_invertido/mod-rodape-invertido-sala.jpg',
    url_preview: '/api/marketing/ambientes/mod-rodape-invertido-sala.jpg',
  },
  {
    id: 'mod-perfil-led-corredor',
    produto_slug: 'perfil_led_embutir',
    linha: 'perfil_led_embutir',
    status: 'aprovada',
    aprovada_por: 'modelo aprovado pelo usuário em 12/11/2026',
    aprovada_em: '2026-11-12T00:00:00',
    gerada_em: '2026-11-12T00:00:00',
    gerada_por: 'modelo',
    descricao: 'Corredor minimalista com iluminação linear contínua',
    provedor: 'modelo_aprovado',
    modelo: 'manual_12/11/2026',
    prompt: 'Corredor com perfil de LED embutido no gesso',
    proporcao: '3:2',
    largura: 1200,
    altura: 800,
    tamanho_bytes: 85400,
    url_publica: 'https://servidor.norvia.example/marketing-imagens/ambientes/perfil_led_embutir/mod-perfil-led-corredor.jpg',
    url_preview: '/api/marketing/ambientes/mod-perfil-led-corredor.jpg',
  },
  {
    id: 'mod-listelo-ripado',
    produto_slug: 'listelo_velino',
    linha: 'listelo_velino',
    status: 'aprovada',
    aprovada_por: 'modelo aprovado pelo usuário em 12/11/2026',
    aprovada_em: '2026-11-12T00:00:00',
    gerada_em: '2026-11-12T00:00:00',
    gerada_por: 'modelo',
    descricao: 'Painel ripado em madeira nobre com detalhe metálico linear',
    provedor: 'modelo_aprovado',
    modelo: 'manual_12/11/2026',
    prompt: 'Madeira ripada com filete metálico',
    proporcao: '3:2',
    largura: 1200,
    altura: 800,
    tamanho_bytes: 63100,
    url_publica: 'https://servidor.norvia.example/marketing-imagens/ambientes/listelo_velino/mod-listelo-ripado.jpg',
    url_preview: '/api/marketing/ambientes/mod-listelo-ripado.jpg',
  },
];

const DEMO_STATUS: MarketingStatus = {
  status: 'operacional',
  servico: 'automacoes-marketing',
  total_rascunhos_semana: 2,
  aprovados: 0,
  pendentes: 2,
  proxima_geracao_sexta: '13/11/2026 às 08:00',
  total_produtos_catalogo: 213,
  total_produtos_marca_propria: 84,
  marca_oficial_ativa: 'Norvia',
  mock_mode: true,
  ia_configurada: [],
  geracao: { em_andamento: false, iniciada_em: null, iniciada_por: null, ultimo_erro: null },
};

const DEMO_PRODUTOS: ProdutoEditorial[] = [
  {
    slug: 'rodape_invertido',
    nome: 'Rodapé Invertido Veles em Aluminio com Aba para LED 50mm x 20mm - Norvia',
    nome_curto: 'Rodapé Invertido Veles com Aba para LED',
    referencia: 'NRVRPI02',
    categoria_tag: 'RODAPÉ INVERTIDO & ILUMINAÇÃO LED',
    categoria_oficial: 'Rodapés › Rodapés Invertidos',
    imagem_preview: '/marketing/produto-rodape-invertido-led.jpg',
    imagem_rd_station: 'https://cdn.vnda.com.br/norvia/2025/10/15/13_18_54_920_ca2a2a89e47f712bd9b963d7ca214bc2.png?v=1764684163',
    url_produto: 'https://www.norvia.example/rodapes/rodape-invertido',
    especificacoes_site: 'Tamanhos: 1m, 2m, 3m | Cores: Branco, Chumbo Microtexturizado, Natural Fosco, Preto',
    resumo_card: 'Efeito de parede suspensa com canaleta para fita de LED indireta.',
    marca: 'Norvia',
    marca_propria: true,
  },
  {
    slug: 'perfil_t',
    nome: 'Perfil T 45mm em Alumínio Para Piso Laminado - Norvia',
    nome_curto: 'Perfil T 45mm em Alumínio (Mesmo Nível)',
    referencia: 'NRVPTL02',
    categoria_tag: 'TRANSIÇÃO DE PISOS NO MESMO NÍVEL',
    categoria_oficial: 'Acabamentos de Piso › Perfis T',
    imagem_preview: '/marketing/produto-perfil-t.jpg',
    imagem_rd_station: 'https://cdn.vnda.com.br/norvia/2025/10/17/17_45_28_178_ac57196d33e15cadff2d80611e071a51.png?v=1761934179',
    url_produto: 'https://www.norvia.example/acabamento-de-piso/perfis-t',
    especificacoes_site: 'Tamanhos: 1m, 2m, 3m | Cores: Bege, Branco, Champanhe, Fumê, Marrom, Natural Fosco, Preto',
    resumo_card: 'Solução técnica para acabamento e dilatação entre pisos no mesmo nível.',
    marca: 'Norvia',
    marca_propria: true,
  },
  {
    slug: 'cantoneira',
    nome: 'Cantoneira Alumínio Para Canto Parede 1/1 - 25mm x 25mm - Norvia',
    nome_curto: 'Cantoneira Alumínio Parede 25x25mm',
    referencia: 'NRVCMP04',
    categoria_tag: 'PROTEÇÃO DE QUINAS & CANTOS DE PAREDE',
    categoria_oficial: 'Cantoneiras › Cantoneira de Parede',
    imagem_preview: '/marketing/produto-cantoneira.jpg',
    imagem_rd_station: 'https://cdn.vnda.com.br/norvia/2025/10/17/14_48_50_619_1fb40fb8dbecdf31484cf0e2ebbc38fa.jpg?v=1764681150',
    url_produto: 'https://www.norvia.example/cantoneira/cantoneira-de-parede',
    especificacoes_site: 'Tamanhos: 1m, 2m, 3m | Cores: Branco, Bronze, Natural Fosco, Preto',
    resumo_card: 'Protege quinas de parede contra impactos e disfarça irregularidades.',
    marca: 'Norvia',
    marca_propria: true,
  },
];

const demoRascunhosArmazenados: RascunhoEdicao[] = [
  {
    id: 'draft-seg-20261116',
    dia_semana: 'Segunda-feira',
    data_prevista: '2026-11-16',
    edicao_numero: 104,
    status: 'pendente_aprovacao',
    produto_slug: 'rodape_invertido',
    produto_nome: 'Rodapé Invertido Veles em Aluminio com Aba para LED 50mm x 20mm - Norvia',
    produto_referencia: 'NRVRPI02',
    marca: 'Norvia',
    artigo_fonte: 'ArchDaily Brasil',
    artigo_titulo: 'Apartamento Contemporâneo em São Paulo / Studio Arquitetura',
    artigo_url: 'https://www.archdaily.com.br',
    copy: {
      assunto: 'Linhas puras na arquitetura: o rodapé invertido e a iluminação linear',
      assunto_alt: 'Rodapé Invertido Norvia: acabamento técnico para paredes suspensas',
      preheader: 'Como a arquitetura contemporânea elimina interferências visuais no encontro de pisos e paredes.',
      chapeu_categoria: 'DESTAQUE DE SEGUNDA-FEIRA • RODAPÉ INVERTIDO',
      titulo_principal: 'Arquitetura Minimalista: O Detalhe Técnico do Rodapé Invertido em Alumínio',
      subtitulo: 'Em projetos onde piso e parede se encontram com precisão milimétrica, o rodapé invertido cria a sensação de parede flutuante com canaleta para fita de LED.',
      legenda_foto: 'Rodapé Invertido Veles 50mm x 20mm em alumínio com aba para LED — Norvia Acabamentos.',
      paragrafos_corpo: [
        'Projetos residenciais modernos exigem transições limpas e sem sobreposições. O rodapé tradicional sobreposto, embora funcional, cria um degrau na parede que acumula poeira e quebra a continuidade visual do ambiente.',
        'O Rodapé Invertido em Alumínio Norvia (Ref. NRVRPI02) resolve essa questão estruturalmente durante a fase de alvenaria e reboco. Com medidas de 50mm x 20mm e opções com aba difusora para fita de LED, ele proporciona um rasgo de luz indireta de alta sofisticação estética.',
      ],
      titulo_box_motivos: 'Especificações e diferenciais técnicos Norvia na obra:',
      motivos_destaque: [
        { titulo: '1. Efeito Parede Flutuante:', texto: 'Embutido na alvenaria ou drywall, dispensa rodapés salientes e valoriza o revestimento.' },
        { titulo: '2. Iluminação Indireta Embutida:', texto: 'Canaleta projetada para alojar fitas de LED com difusor em acrílico leitoso.' },
        { titulo: '3. Fabricação em Alumínio:', texto: 'Resistência à umidade, não oxida e não empena como modelos em madeira ou poliestireno.' },
      ],
      chamada_produto_titulo: 'Rodapé Invertido Veles 50mm x 20mm com Aba para LED',
      chamada_produto_texto: 'Transforme seus espaços com o Rodapé Invertido Veles Com Aba da Norvia, uma combinação perfeita de design moderno, alta qualidade e funcionalidade. Fabricado em alumínio resistente.',
      carrossel: [
        { tipo: 'capa', titulo: 'Parede Flutuante & Luz Indireta: O Rodapé Invertido', texto: 'Como a arquitetura moderna valoriza o encontro entre piso e parede com precisão.' },
        { tipo: 'texto', titulo: 'O Desafio do Rodapé Convencional', texto: 'Modelos tradicionais quebram a continuidade visual e acumulam poeira na alvenaria.' },
        { tipo: 'texto', titulo: 'A Solução em Alumínio', texto: 'O rodapé invertido cria um vão estruturado embutido que valoriza o revestimento.' },
        { tipo: 'produto', titulo: 'Rodapé Invertido Veles Norvia', texto: 'Alumínio de alta resistência com canaleta difusora para fita de LED indireta.' },
        { tipo: 'produto', titulo: 'Especificações Técnicas', texto: 'Barras em 1m, 2m e 3m nas cores Branco, Chumbo, Natural Fosco e Preto.' },
        { tipo: 'cta', titulo: 'Consulte o Catálogo Completo', texto: 'Acesse norvia.example e conheça todas as opções para o seu projeto.' },
      ],
      slides_instagram: [
        'Slide 1 (Capa): Parede Flutuante & Luz Indireta: O Rodapé Invertido',
        'Slide 2: Por que arquitetos estão substituindo o rodapé convencional?',
        'Slide 3: Detalhamento do Rodapé Invertido Norvia (Ref. NRVRPI02)',
        'Slide 4: Opções com aba para fita de LED em barras de 1m, 2m e 3m',
        'Slide 5 (CTA): Acesse norvia.example — Centros de Distribuição em SP e PR',
      ],
      legenda_instagram: 'A precisão do acabamento invisível.\n\nO Rodapé Invertido em Alumínio Norvia cria o desejado efeito de parede suspensa, com alojamento perfeito para iluminação linear indireta em LED.\n\nDisponível nas medidas 50x20mm, 62x13mm e 100x20mm em barras de alumínio de alta durabilidade.\n\nConfira todos os modelos em norvia.example.\n\n#NorviaAcabamentos #RodapeInvertido #ArquiteturaDeInteriores',
    },
    carrossel_slides: 6,
    html_email_preview: '',
    html_email_rd_station: '',
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  },
  {
    id: 'draft-qui-20261119',
    dia_semana: 'Quinta-feira',
    data_prevista: '2026-11-19',
    edicao_numero: 105,
    status: 'pendente_aprovacao',
    produto_slug: 'perfil_t',
    produto_nome: 'Perfil T 45mm em Alumínio Para Piso Laminado - Norvia',
    produto_referencia: 'NRVPTL02',
    marca: 'Norvia',
    artigo_fonte: 'Revista Projeto',
    artigo_titulo: 'Residência em Curitiba aposta em integração de salas e cozinhas',
    artigo_url: 'https://revistaprojeto.com.br',
    copy: {
      assunto: 'Transição perfeita de pisos: o papel técnico do Perfil T em Alumínio',
      assunto_alt: 'Perfil T Norvia: acabamento e dilatação entre pisos no mesmo nível',
      preheader: 'Evite descolamentos e trincas: como especificar a transição entre laminados e porcelanatos.',
      chapeu_categoria: 'DESTAQUE DE QUINTA-FEIRA • TRANSIÇÃO DE PISOS',
      titulo_principal: 'Encontro de Revestimentos: Como Fazer a Transição no Mesmo Nível com Perfil T',
      subtitulo: 'Na integração de ambientes com diferentes pisos, o Perfil T Norvia garante a junta de dilatação necessária sem criar ressaltos.',
      legenda_foto: 'Perfil T 45mm em alumínio para transição de pisos — Norvia Acabamentos.',
      paragrafos_corpo: [
        'A integração de ambientes é uma das maiores marcas da arquitetura contemporânea. No entanto, unir pisos de naturezas diferentes requer cuidado técnico com a dilatação dos materiais.',
        'O Perfil T em Alumínio Norvia (Ref. NRVPTL02) foi desenvolvido especificamente para fazer o acabamento e a união entre dois pisos instalados NO MESMO NÍVEL. Ele protege as bordas dos revestimentos e permite que pisos flutuantes trabalhem livremente.',
      ],
      titulo_box_motivos: 'Especificações e diferenciais técnicos Norvia na obra:',
      motivos_destaque: [
        { titulo: '1. Acabamento Discreto no Mesmo Nível:', texto: 'Projetado para unir superfícies niveladas sem criar degraus tropeçáveis no piso.' },
        { titulo: '2. Proteção de Bordas e Dilatação:', texto: 'Absorve a movimentação natural de pisos laminados e vinílicos, prevenindo estufamento.' },
        { titulo: '3. Acabamentos Anodizados:', texto: 'Disponível em diversas larguras e cores no site norvia.example, com alta resistência ao tráfego.' },
      ],
      chamada_produto_titulo: 'Perfil T 45mm em Alumínio Para Piso Laminado e Vinílico',
      chamada_produto_texto: 'O perfil T 45mm em alumínio para piso laminado da Norvia é uma solução para realizar o acabamento e a transição entre pisos no mesmo nível.',
      carrossel: [
        { tipo: 'capa', titulo: 'Transição de Pisos sem Erros: Perfil T no Mesmo Nível', texto: 'A especificação correta para encontros perfeitos entre laminados e porcelanatos.' },
        { tipo: 'texto', titulo: 'Dilatação Térmica e Estufamento', texto: 'Pisos flutuantes exigem juntas de dilatação adequadas para evitar empenamento.' },
        { tipo: 'texto', titulo: 'A Função Técnica do Perfil T', texto: 'Protege as bordas dos revestimentos sem criar desníveis ou degraus.' },
        { tipo: 'produto', titulo: 'Perfil T 45mm Norvia (Ref. NRVPTL02)', texto: 'Alumínio de alta resistência projetado especificamente para transições no mesmo nível.' },
        { tipo: 'produto', titulo: 'Variedade de Acabamentos', texto: 'Disponível em diversas cores e medidas em barras de 1m, 2m e 3m.' },
        { tipo: 'cta', titulo: 'Especificações Técnicas no Site', texto: 'Acesse norvia.example e solicite o catálogo com envio para todo o Brasil.' },
      ],
      slides_instagram: [
        'Slide 1 (Capa): Transição de Pisos sem Erros: Perfil T no Mesmo Nível',
        'Slide 2: O que acontece quando você não deixa espaço de dilatação no piso?',
        'Slide 3: A função técnica do Perfil T Norvia (Ref. NRVPTL02)',
        'Slide 4: Aplicações em porcelanatos, laminados e vinílicos nivelados',
        'Slide 5 (CTA): Acesse norvia.example — Entregas rápidas para todo o Brasil',
      ],
      legenda_instagram: 'Transição precisa entre revestimentos no mesmo nível.\n\nAo integrar sala e cozinha com pisos diferentes, a especificação correta do Perfil T Norvia evita o estufamento do piso laminado e protege as quinas dos porcelanatos.\n\nFabricado em alumínio reforçado, disponível em diversas larguras no site.\n\nConfira em norvia.example.\n\n#NorviaAcabamentos #PerfilT #PisoVinilico #PisoLaminado #Revestimentos',
    },
    carrossel_slides: 6,
    html_email_preview: '',
    html_email_rd_station: '',
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  },
];

export interface MarketingService {
  status(): Promise<MarketingStatus>;
  rascunhos(): Promise<RascunhoEdicao[]>;
  produtos(): Promise<ProdutoEditorial[]>;
  catalogo(): Promise<{ total: number; produtos: ProdutoCatalogoNorvia[] }>;
  execucoes(): Promise<ExecucaoMarketing[]>;
  /** Dispara a geração (202): ela roda na automação e o andamento vem em status().geracao. */
  gerarLote(): Promise<string>;
  aprovar(rascunhoId: string): Promise<RascunhoEdicao>;
  trocarProduto(rascunhoId: string, produtoSlug: string): Promise<string>;
  carrosselSlideBlob(rascunhoId: string, slideNum: number): Promise<Blob>;
  carrosselZipBlob(rascunhoId: string): Promise<Blob>;
  listarAmbientes(filtroSlug?: string): Promise<AmbienteImagem[]>;
  gerarAmbientes(produtoSlug: string, quantidade?: number): Promise<string>;
  aprovarAmbiente(id: string): Promise<AmbienteImagem>;
  recusarAmbiente(id: string): Promise<AmbienteImagem>;
  ambienteImagemBlob(id: string): Promise<Blob>;
}

/** Live: gateway em /api/marketing (erro vira exceção na tela, nunca dado de exemplo). Demo: dados locais. */
export function createMarketingService(baseUrl: string, mode: 'demo' | 'live', token?: string | null): MarketingService {
  return mode === 'demo' ? demoService() : liveService(baseUrl, token);
}

function liveService(baseUrl: string, token?: string | null): MarketingService {
  function authHeaders(): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/marketing${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(apiErrorMessage(body, res.status, 'Falha na automação de e-mail marketing'));
    if (body === null) throw new Error('Resposta incompleta do serviço (pode estar reiniciando). Clique em Atualizar.');
    return body as T;
  }
  const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  return {
    status: () => request('/status'),
    rascunhos: () => request('/rascunhos'),
    produtos: () => request('/produtos'),
    catalogo: () => request('/catalogo?apenas_proprios=true'),
    execucoes: () => request('/execucoes'),
    gerarLote: async () => (await post<{ mensagem: string }>('/gerar-lote-semanal')).mensagem,
    aprovar: async (id) => (await post<{ rascunho: RascunhoEdicao }>(`/rascunhos/${encodeURIComponent(id)}/aprovar`)).rascunho,
    trocarProduto: async (id, slug) =>
      (await post<{ mensagem: string }>(`/rascunhos/${encodeURIComponent(id)}/produto`, { produto_slug: slug })).mensagem,
    carrosselSlideBlob: async (id: string, n: number) => {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/marketing/rascunhos/${encodeURIComponent(id)}/carrossel/${n}`, {
        headers: {
          ...authHeaders(),
        },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(body, res.status, `Slide ${n} não encontrado`));
      }
      return await res.blob();
    },
    carrosselZipBlob: async (id: string) => {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/marketing/rascunhos/${encodeURIComponent(id)}/carrossel.zip`, {
        headers: {
          ...authHeaders(),
        },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(body, res.status, 'Arquivo ZIP do carrossel não encontrado'));
      }
      return await res.blob();
    },
    listarAmbientes: (filtroSlug?: string) =>
      request<AmbienteImagem[]>(`/ambientes${filtroSlug ? `?filtro_slug=${encodeURIComponent(filtroSlug)}` : ''}`),
    gerarAmbientes: async (slug: string, qtd = 4) =>
      (await post<{ mensagem: string }>('/ambientes/gerar', { produto_slug: slug, quantidade: qtd })).mensagem,
    aprovarAmbiente: async (id: string) =>
      (await post<{ ambiente: AmbienteImagem }>(`/ambientes/${encodeURIComponent(id)}/aprovar`)).ambiente,
    recusarAmbiente: async (id: string) =>
      (await post<{ ambiente: AmbienteImagem }>(`/ambientes/${encodeURIComponent(id)}/recusar`)).ambiente,
    ambienteImagemBlob: async (id: string) => {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/marketing/ambientes/${encodeURIComponent(id)}.jpg`, {
        headers: {
          ...authHeaders(),
        },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(body, res.status, 'Imagem de ambiente não encontrada'));
      }
      return await res.blob();
    },
  };
}

function demoService(): MarketingService {
  const achar = (id: string) => {
    const item = demoRascunhosArmazenados.find((r) => r.id === id);
    if (!item) throw new Error('Rascunho não encontrado.');
    return item;
  };
  return {
    status: () => demoDelay(DEMO_STATUS),
    rascunhos: () => demoDelay(demoRascunhosArmazenados.map((r) => ({ ...r }))),
    produtos: () => demoDelay(DEMO_PRODUTOS),
    catalogo: () => demoDelay({ total: 0, produtos: [] }),
    execucoes: () => demoDelay([]),
    gerarLote: () => demoDelay('Modo demonstração: a geração não roda aqui.'),
    aprovar: async (id) => {
      const item = achar(id);
      item.status = 'aprovado';
      item.aprovado_por = 'demo';
      item.aprovado_em = new Date().toISOString();
      return demoDelay({ ...item });
    },
    trocarProduto: async (id, slug) => {
      const item = achar(id);
      const prod = DEMO_PRODUTOS.find((p) => p.slug === slug);
      if (!prod) throw new Error('Produto inválido.');
      item.produto_slug = prod.slug;
      item.produto_nome = prod.nome;
      item.produto_referencia = prod.referencia;
      return demoDelay(`Edição refazendo com o produto ${prod.nome_curto}.`);
    },
    carrosselSlideBlob: async () => {
      throw new Error('Slides visuais não disponíveis no modo demonstração.');
    },
    carrosselZipBlob: async () => {
      throw new Error('Download ZIP não disponível no modo demonstração.');
    },
    listarAmbientes: () => demoDelay(DEMO_AMBIENTES),
    gerarAmbientes: async () => demoDelay('Geração de imagens não disponível no modo demonstração.'),
    aprovarAmbiente: async (id) => {
      const img = DEMO_AMBIENTES.find((a) => a.id === id);
      if (!img) throw new Error('Imagem não encontrada');
      img.status = 'aprovada';
      img.aprovada_por = 'demo';
      return demoDelay({ ...img });
    },
    recusarAmbiente: async (id) => {
      const img = DEMO_AMBIENTES.find((a) => a.id === id);
      if (!img) throw new Error('Imagem não encontrada');
      img.status = 'recusada';
      return demoDelay({ ...img });
    },
    ambienteImagemBlob: async () => {
      throw new Error('Imagens de ambiente não disponíveis no modo demonstração.');
    },
  };
}

/**
 * A prévia do e-mail aponta as imagens para /marketing/... (public/ do painel). O painel é servido
 * em /automacoes/ e o basePath não reescreve HTML montado à mão: sem o prefixo, as imagens dão 404.
 */
export function prefixarImagensDaPrevia(html: string, basePath: string): string {
  if (!basePath) return html;
  return html.replace(/(src=")\/marketing\//g, `$1${basePath.replace(/\/$/, '')}/marketing/`);
}

export function extrairIdsAmbienteDaPrevia(html: string): string[] {
  const ids = new Set<string>();
  const re = /src="\/api\/marketing\/ambientes\/([A-Za-z0-9_-]+)\.jpg"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

export function substituirAmbientesPorDataUrls(html: string, dataUrls: Record<string, string>): string {
  return html.replace(
    /(src=")\/api\/marketing\/ambientes\/([A-Za-z0-9_-]+)\.jpg(")/g,
    (full, prefix: string, id: string, suffix: string) => {
      const dataUrl = dataUrls[id];
      return dataUrl ? `${prefix}${dataUrl}${suffix}` : full;
    }
  );
}
