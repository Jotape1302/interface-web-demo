// Dados fictícios das automações de Marketplace (Padronização de dimensões e Tipo de frete) para o
// modo demonstração. Imita as regras da API Python (backend/automations/automacoes-marketplace):
// filtros, contagens dos cards, validação → envio em segundo plano, coleta com progresso,
// verificação de fretes com conferência. O estado vive em memória e volta ao início ao recarregar.

import type {
  AnuncioSemSku,
  Confiabilidade,
  DimensoesStatus,
  ExecucaoColeta,
  FonteId,
  FonteMedida,
  ProdutoDimensoes,
  ProdutosPage,
  StatusPadronizacao,
} from './dimensoes-contracts';
import type {
  AnuncioFrete,
  AnunciosPage,
  BloqueioFrete,
  ExecucaoFretes,
  Filial,
  FretesStatus,
  HistoricoFretes,
  Medidas,
  SituacaoAnuncio,
  TrocaFrete,
} from './fretes-contracts';

const MIN = 60_000;
const HORA = 60 * MIN;
const iso = (msAtras: number) => new Date(Date.now() - msAtras).toISOString();
const normalizar = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ROTULO_FONTE: Record<FonteId, string> = {
  ml_titulo: 'Título ML',
  ml_descricao: 'Descrição ML',
  ml_ficha: 'Ficha técnica ML',
  tiny_titulo: 'Nome Tiny',
  tiny_descricao: 'Descrição Tiny',
  tiny_ficha: 'Dimensões Tiny',
};
const ROTULO_FILIAL: Record<Filial, string> = { norvia: 'Norvia Campinas', revesta: 'Revesta' };
const ROTULO_TINY: Record<string, string> = { norvia_campinas: 'Tiny Norvia Campinas', revesta: 'Tiny Revesta' };
const MINUTOS_CONFERENCIA = 10;
const DURACAO_COLETA_MS = 45_000;
const DURACAO_VERIFICACAO_MS = 12_000;
const DURACAO_ENVIO_MS = 6_000;

type Dims = [number | null, number | null, number | null, number | null]; // altura, largura, comprimento (cm), peso (g)
const medidas = ([altura, largura, comprimento, peso]: Dims): Medidas => ({ altura, largura, comprimento, peso });

interface SeedProduto {
  sku: string;
  descricao: string;
  real: Dims;
  status: StatusPadronizacao;
  confiabilidade: Confiabilidade;
  anuncios: Array<[Filial, string, string]>; // filial, MLB, título do anúncio
  tiny: Array<[string, number]>; // conta Tiny, id
  /** Fonte com medida diferente da real (gera confiabilidade menor ou divergência). */
  desvio?: { fonte: FonteId; dims: Dims; texto?: string | null };
  envio?: 'ok' | 'erro';
}

const SEED_PRODUTOS: SeedProduto[] = [
  {
    sku: 'PF-ALU-3M-BR', descricao: 'Perfil de Alumínio para Fita LED 3 metros Branco', real: [1.2, 1.7, 300, 380],
    status: 'pendente', confiabilidade: 'alta', anuncios: [['norvia', 'MLB3456789012', 'Perfil Alumínio Fita Led 3m Branco Embutir Com Difusor']],
    tiny: [['norvia_campinas', 812345], ['revesta', 522101]],
  },
  {
    sku: 'RDP-MDF-10CM', descricao: 'Rodapé MDF Branco 10cm x 2,40m', real: [1.5, 10, 240, 1650],
    status: 'pendente', confiabilidade: 'alta', anuncios: [['revesta', 'MLB4012345678', 'Rodapé Mdf Branco 10cm Ultra Resistente Barra 2,40m']],
    tiny: [['revesta', 522188]],
  },
  {
    sku: 'CANT-ALU-25', descricao: 'Cantoneira de Alumínio 25x25mm 3m Natural', real: [2.5, 2.5, 300, 420],
    status: 'pendente', confiabilidade: 'alta', anuncios: [['norvia', 'MLB3498761234', 'Cantoneira Alumínio 25x25mm Barra 3 Metros Acabamento']],
    tiny: [['norvia_campinas', 812410]],
  },
  {
    sku: 'SOL-GRAN-90', descricao: 'Soleira de Granito Cinza Andorinha 90cm', real: [2, 15, 90, 5800],
    status: 'pendente', confiabilidade: 'alta', anuncios: [['revesta', 'MLB4023456789', 'Soleira Granito Cinza Andorinha 90x15cm Polida']],
    tiny: [['revesta', 522230]],
  },
  {
    sku: 'PF-LED-SOB-2M', descricao: 'Perfil de Sobrepor para LED 2 metros Preto', real: [0.9, 1.6, 200, 240],
    status: 'pendente', confiabilidade: 'media', anuncios: [['norvia', 'MLB3511122233', 'Perfil Led Sobrepor Preto 2m Com Tampa Leitosa']],
    tiny: [['norvia_campinas', 812502]],
    desvio: { fonte: 'tiny_ficha', dims: [1, 2, 200, 240] },
  },
  {
    sku: 'TRILHO-CORT-2M', descricao: 'Trilho Suíço para Cortina 2 metros', real: [1.8, 3, 200, 520],
    status: 'pendente', confiabilidade: 'media', anuncios: [['norvia', 'MLB3522233344', 'Trilho Suíço Cortina 2 Metros Completo Com Deslizantes']],
    tiny: [['norvia_campinas', 812577]],
    desvio: { fonte: 'ml_titulo', dims: [null, null, 200, null], texto: 'Trilho Suíço Cortina 2 Metros' },
  },
  {
    sku: 'PISO-VIN-CX', descricao: 'Piso Vinílico Click Carvalho Caixa 2,2m²', real: [6, 18, 122, 14200],
    status: 'pendente', confiabilidade: 'media', anuncios: [['revesta', 'MLB4034567890', 'Piso Vinílico Click Carvalho Natural 5mm Caixa 2,2m²']],
    tiny: [['revesta', 522301]],
    desvio: { fonte: 'tiny_ficha', dims: [6, 18, 122, 14000] },
  },
  {
    sku: 'ESP-ACAB-JUNTA', descricao: 'Perfil de Transição Piso/Piso Inox 90cm', real: [0.6, 3, 90, 180],
    status: 'pendente', confiabilidade: 'baixa', anuncios: [['norvia', 'MLB3533344455', 'Perfil Transição Piso Inox Escovado 90cm Junta Dilatação']],
    tiny: [['norvia_campinas', 812633]],
    desvio: { fonte: 'ml_ficha', dims: [3, 9, 90, 180] },
  },
  {
    sku: 'MOLD-GESSO-2M', descricao: 'Moldura de Poliestireno para Teto 2m', real: [4, 6, 200, 310],
    status: 'pendente', confiabilidade: 'baixa', anuncios: [['revesta', 'MLB4045678901', 'Moldura Teto Sanca Poliestireno 6cm Barra 2m Branca']],
    tiny: [['revesta', 522355]],
    desvio: { fonte: 'tiny_ficha', dims: [10, 10, 100, 500] },
  },
  {
    sku: 'PERF-U-ACM', descricao: 'Perfil U para ACM 4mm 3m', real: [1, 1.2, 300, null],
    status: 'pendente', confiabilidade: 'baixa', anuncios: [['norvia', 'MLB3544455566', 'Perfil U Acabamento Acm 4mm Barra 3 Metros']],
    tiny: [['norvia_campinas', 812701]],
    desvio: { fonte: 'ml_titulo', dims: [null, null, 300, null], texto: 'Barra 3 Metros' },
  },
  {
    sku: 'RDP-POL-7CM', descricao: 'Rodapé de Poliestireno 7cm x 2,40m Branco', real: [1.3, 7, 240, 600],
    status: 'divergente', confiabilidade: 'alta', anuncios: [['revesta', 'MLB4056789012', 'Rodapé Poliestireno 7cm Branco Resistente Água 2,40m']],
    tiny: [['revesta', 522410]],
    desvio: { fonte: 'ml_ficha', dims: [1.3, 7, 220, 600] },
  },
  {
    sku: 'CANT-PVC-PISO', descricao: 'Cantoneira PVC para Degrau 1m', real: [2, 3.5, 100, 150],
    status: 'divergente', confiabilidade: 'media', anuncios: [['norvia', 'MLB3555566677', 'Cantoneira Pvc Degrau Escada Antiderrapante 1 Metro']],
    tiny: [['norvia_campinas', 812780]],
    desvio: { fonte: 'tiny_ficha', dims: [2, 3.5, 120, 150] },
  },
  {
    sku: 'PF-ALU-1M-PT', descricao: 'Perfil de Alumínio para Fita LED 1 metro Preto', real: [1.2, 1.7, 100, 140],
    status: 'padronizado', confiabilidade: 'alta', envio: 'ok', anuncios: [['norvia', 'MLB3566677788', 'Perfil Alumínio Led 1m Preto Embutir Com Difusor']],
    tiny: [['norvia_campinas', 812811], ['revesta', 522455]],
  },
  {
    sku: 'RDP-MDF-15CM', descricao: 'Rodapé MDF Branco 15cm x 2,40m', real: [1.5, 15, 240, 2400],
    status: 'padronizado', confiabilidade: 'alta', envio: 'ok', anuncios: [['revesta', 'MLB4067890123', 'Rodapé Mdf Branco 15cm Barra 2,40m Frisado']],
    tiny: [['revesta', 522470]],
  },
  {
    sku: 'SOL-MARM-80', descricao: 'Soleira de Mármore Branco 80cm', real: [2, 14, 80, 4900],
    status: 'padronizado', confiabilidade: 'alta', envio: 'ok', anuncios: [['norvia', 'MLB3577788899', 'Soleira Mármore Branco Piguês 80x14cm']],
    tiny: [['norvia_campinas', 812855]],
  },
  {
    sku: 'PF-CANT-LED-2M', descricao: 'Perfil de Canto para LED 2 metros', real: [1.6, 1.6, 200, 260],
    status: 'padronizado', confiabilidade: 'media', envio: 'erro', anuncios: [['norvia', 'MLB3588899900', 'Perfil Led Canto 45 Graus 2 Metros Alumínio']],
    tiny: [['norvia_campinas', 812870]],
  },
  {
    sku: 'FITA-VED-10M', descricao: 'Fita de Vedação para Esquadrias 10m', real: [3, 10, 10, 200],
    status: 'padronizado', confiabilidade: 'alta', envio: 'ok', anuncios: [['revesta', 'MLB4078901234', 'Fita Vedação Esquadria Espuma 10 Metros']],
    tiny: [['revesta', 522512]],
  },
];

const SEM_SKU: AnuncioSemSku[] = [
  { filial: 'norvia', mlb: 'MLB3599900011', titulo: 'Kit 5 Perfis Led 1m Alumínio Com Tampa', permalink: null },
  { filial: 'revesta', mlb: 'MLB4089012345', titulo: 'Rodapé Poliestireno Ecológico 10cm Barra', permalink: null },
];

function textoMedidas([a, l, c]: Dims): string {
  const partes = [a, l, c].filter((v): v is number => v != null).map((v) => String(v).replace('.', ','));
  return `${partes.join(' x ')} cm`;
}

function fonte(fonteId: FonteId, local: string, dims: Dims, texto: string | null): FonteMedida {
  return { fonte: fonteId, rotulo: ROTULO_FONTE[fonteId], local, dims: medidas(dims), texto };
}

function montarProduto(s: SeedProduto): ProdutoDimensoes {
  const fontes: FonteMedida[] = [];
  for (const [filial, mlb, titulo] of s.anuncios) {
    const local = `ML ${ROTULO_FILIAL[filial]} · ${mlb}`;
    fontes.push(fonte('ml_titulo', local, [null, null, s.real[2], null], titulo));
    fontes.push(fonte('ml_ficha', local, s.real, null));
  }
  for (const [conta] of s.tiny) {
    fontes.push(fonte('tiny_ficha', ROTULO_TINY[conta], s.real, null));
    fontes.push(fonte('tiny_descricao', ROTULO_TINY[conta], [s.real[0], s.real[1], s.real[2], null], `Medidas: ${textoMedidas(s.real)}`));
  }
  if (s.desvio) {
    const alvo = fontes.find((f) => f.fonte === s.desvio!.fonte);
    if (alvo) {
      alvo.dims = medidas(s.desvio.dims);
      if (s.desvio.texto !== undefined) alvo.texto = s.desvio.texto;
    }
  }
  const concordantes = fontes
    .filter((f) => f.dims.comprimento === s.real[2] && (f.dims.largura == null || f.dims.largura === s.real[1]))
    .map((f) => `${f.fonte}|${f.local}`);
  const coletado = iso(5 * HORA);
  const produto: ProdutoDimensoes = {
    sku: s.sku,
    descricao: s.descricao,
    fontes,
    sugestao: medidas(s.real),
    confiabilidade: s.confiabilidade,
    confiabilidade_tamanho: s.confiabilidade,
    confiabilidade_peso: s.real[3] == null ? 'baixa' : s.confiabilidade,
    fontes_concordantes: concordantes,
    anuncios: s.anuncios.map(([filial, mlb, titulo]) => ({ filial, mlb, titulo, permalink: null })),
    tiny: s.tiny.map(([conta, id]) => ({ conta, id })),
    status: s.status,
    motivos: [],
    coletado_em: coletado,
  };
  if (s.status !== 'pendente') {
    produto.padrao = {
      ...medidas(s.real),
      embalagem_comprimento: embalagemPara(s.real[2]),
      confiabilidade: s.confiabilidade,
      validado_por: 'Marina E-commerce',
      validado_em: iso(3 * 24 * HORA),
    };
  }
  if (s.status === 'divergente' && s.desvio) {
    const alvo = fontes.find((f) => f.fonte === s.desvio!.fonte)!;
    produto.motivos = [`${alvo.rotulo} (${alvo.local}) diferente do padrão`];
  }
  if (s.envio) produto.envio = montarEnvio(produto, s.envio === 'erro' ? 'ml' : null, iso(3 * 24 * HORA));
  return produto;
}

function embalagemPara(comprimento: number | null): number | null {
  if (comprimento == null) return null;
  return comprimento <= 100 ? 100 : comprimento <= 200 ? 200 : comprimento <= 300 ? 300 : null;
}

function montarEnvio(p: ProdutoDimensoes, falhaEm: 'ml' | null, em: string): NonNullable<ProdutoDimensoes['envio']> {
  const destinos: NonNullable<ProdutoDimensoes['envio']>['destinos'] = {};
  for (const t of p.tiny) destinos[`tiny:${t.conta}`] = { status: 'ok', local: ROTULO_TINY[t.conta], em };
  for (const a of p.anuncios) {
    const local = `ML ${ROTULO_FILIAL[a.filial]} · ${a.mlb}`;
    destinos[`ml:${a.filial}:${a.mlb}`] =
      falhaEm === 'ml'
        ? { status: 'erro', local, em, mensagem: 'HTTP 400: item.attributes.invalid — SELLER_PACKAGE_WEIGHT fora do intervalo aceito.' }
        : { status: 'ok', local, em };
  }
  return { status: falhaEm ? 'erro' : 'ok', em, destinos };
}

// ---------------------------------------------------------------------------------------------
// Estado em memória
// ---------------------------------------------------------------------------------------------

interface EstadoDemo {
  produtos: Map<string, ProdutoDimensoes>;
  execucoesColeta: ExecucaoColeta[];
  coletaIniciadaEm: number | null;
  envios: Map<string, number>; // sku -> quando o envio "termina"
  anuncios: AnuncioBase[];
  trocas: TrocaFrete[];
  execucoesFretes: ExecucaoFretes[];
  verificacaoIniciadaEm: number | null;
}

interface AnuncioBase {
  filial: Filial;
  mlb: string;
  titulo: string;
  sku: string | null;
  status: string;
  modo_envio: string;
  falha_envio: { mensagem: string; em: string } | null;
  sincronizado_em: string;
}

// Anúncios do Tipo de frete: os produtos padronizados/pendentes acima + alguns só com ME1/ME2.
const SEED_ANUNCIOS: Array<[Filial, string, string, string | null, string, 'falha'?]> = [
  ['norvia', 'MLB3456789012', 'Perfil Alumínio Fita Led 3m Branco Embutir Com Difusor', 'PF-ALU-3M-BR', 'not_specified'],
  ['revesta', 'MLB4012345678', 'Rodapé Mdf Branco 10cm Ultra Resistente Barra 2,40m', 'RDP-MDF-10CM', 'not_specified'],
  ['norvia', 'MLB3498761234', 'Cantoneira Alumínio 25x25mm Barra 3 Metros Acabamento', 'CANT-ALU-25', 'not_specified'],
  ['norvia', 'MLB3522233344', 'Trilho Suíço Cortina 2 Metros Completo Com Deslizantes', 'TRILHO-CORT-2M', 'not_specified'],
  ['norvia', 'MLB3566677788', 'Perfil Alumínio Led 1m Preto Embutir Com Difusor', 'PF-ALU-1M-PT', 'not_specified'],
  ['revesta', 'MLB4067890123', 'Rodapé Mdf Branco 15cm Barra 2,40m Frisado', 'RDP-MDF-15CM', 'not_specified'],
  ['norvia', 'MLB3577788899', 'Soleira Mármore Branco Piguês 80x14cm', 'SOL-MARM-80', 'not_specified'],
  ['revesta', 'MLB4078901234', 'Fita Vedação Esquadria Espuma 10 Metros', 'FITA-VED-10M', 'not_specified'],
  ['norvia', 'MLB3599900011', 'Kit 5 Perfis Led 1m Alumínio Com Tampa', null, 'not_specified'],
  ['norvia', 'MLB3588899900', 'Perfil Led Canto 45 Graus 2 Metros Alumínio', 'PF-CANT-LED-2M', 'me1', 'falha'],
  ['revesta', 'MLB4056789012', 'Rodapé Poliestireno 7cm Branco Resistente Água 2,40m', 'RDP-POL-7CM', 'me1', 'falha'],
  ['norvia', 'MLB3611122233', 'Perfil Led Embutir Gesso 1m Com Aletas', 'PF-GESSO-1M', 'me2'],
  ['norvia', 'MLB3622233344', 'Tampa Difusora Leitosa Perfil Led 1m', 'TAMPA-DIF-1M', 'me2'],
  ['revesta', 'MLB4090123456', 'Cantoneira Alumínio Piso 1m Dourada', 'CANT-ALU-DOUR', 'me2'],
  ['revesta', 'MLB4101234567', 'Kit Presilhas Rodapé 50 Unidades', 'PRES-RDP-50', 'me2'],
  ['norvia', 'MLB3633344455', 'Perfil Led Pendente 3m Alumínio Preto', 'PF-PEND-3M', 'me1'],
  ['norvia', 'MLB3644455566', 'Perfil Led Rodapé 2m Luz Indireta', 'PF-RDP-LED-2M', 'me1'],
  ['revesta', 'MLB4112345678', 'Soleira Granito Preto São Gabriel 1,20m', 'SOL-GRAN-PT-120', 'me1'],
  ['norvia', 'MLB3655566677', 'Perfil Led Slim 1m Anodizado Fosco', 'PF-SLIM-1M', 'me2'],
  ['revesta', 'MLB4123456789', 'Rodapé Vinílico Flexível Cinza 5cm Rolo', 'RDP-VIN-5CM', 'me2'],
];

function estadoInicial(): EstadoDemo {
  const produtos = new Map(SEED_PRODUTOS.map((s) => [s.sku, montarProduto(s)]));
  const anuncios: AnuncioBase[] = SEED_ANUNCIOS.map(([filial, mlb, titulo, sku, modo, falha]) => ({
    filial,
    mlb,
    titulo,
    sku,
    status: 'active',
    modo_envio: modo,
    falha_envio: falha
      ? { mensagem: 'O ML desfez a troca para ME1: o anúncio voltou para "a combinar".', em: iso(20 * HORA) }
      : null,
    sincronizado_em: iso(4 * HORA),
  }));
  const trocas: TrocaFrete[] = [
    troca('norvia', 'MLB3611122233', 'Perfil Led Embutir Gesso 1m Com Aletas', 'not_specified', 'me2', [1.4, 1.9, 100, 150], 'ok', 26 * HORA),
    troca('revesta', 'MLB4090123456', 'Cantoneira Alumínio Piso 1m Dourada', 'not_specified', 'me2', [2, 2, 100, 120], 'ok', 26 * HORA),
    troca('norvia', 'MLB3633344455', 'Perfil Led Pendente 3m Alumínio Preto', 'not_specified', 'me1', [3.5, 7, 300, 900], 'ok', 26 * HORA),
    troca('norvia', 'MLB3588899900', 'Perfil Led Canto 45 Graus 2 Metros Alumínio', 'not_specified', 'me1', [1.6, 1.6, 200, 260], 'revertido', 21 * HORA,
      'O ML desfez a troca: o anúncio voltou para "a combinar".'),
    troca('revesta', 'MLB4056789012', 'Rodapé Poliestireno 7cm Branco Resistente Água 2,40m', 'not_specified', 'me1', [1.3, 7, 240, 600], 'revertido', 21 * HORA,
      'O ML desfez a troca: o anúncio voltou para "a combinar".'),
  ];
  const execucaoFretes: ExecucaoFretes = {
    iniciada_em: iso(26 * HORA),
    concluida_em: iso(26 * HORA - 3 * MIN),
    origem: 'agendada',
    status: 'ok',
    resumo: {
      novos: 3, pendencias_novas: 2, trocas: 5, erros: [],
      contas: { norvia: { status: 'ok', anuncios: 12 }, revesta: { status: 'ok', anuncios: 8 } },
    },
  };
  return {
    produtos,
    execucoesColeta: [
      {
        iniciada_em: iso(29 * HORA), concluida_em: iso(29 * HORA - 7 * MIN), origem: 'agendada', status: 'ok',
        resumo: { produtos: 17, pendentes: 12, pendencias_novas: 3, anuncios_sem_sku: 2, erros: [] },
      },
      {
        iniciada_em: iso(5 * HORA), concluida_em: iso(5 * HORA - 6 * MIN), origem: 'agendada', status: 'ok',
        resumo: { produtos: 17, pendentes: 12, pendencias_novas: 1, anuncios_sem_sku: 2, erros: [] },
      },
    ],
    coletaIniciadaEm: null,
    envios: new Map(),
    anuncios,
    trocas,
    execucoesFretes: [execucaoFretes],
    verificacaoIniciadaEm: null,
  };
}

function troca(
  filial: Filial, mlb: string, titulo: string, de: string, para: string, dims: Dims,
  status: TrocaFrete['status'], msAtras: number, mensagem: string | null = null,
): TrocaFrete {
  const feita = Date.now() - msAtras;
  return {
    id: `${filial}:${mlb}:${feita}`,
    filial, mlb, titulo, de, para,
    dims: medidas(dims),
    origem: 'rotina',
    usuario: null,
    feita_em: new Date(feita).toISOString(),
    verificar_em: new Date(feita + MINUTOS_CONFERENCIA * MIN).toISOString(),
    verificado_em: status === 'aguardando' ? undefined : new Date(feita + MINUTOS_CONFERENCIA * MIN).toISOString(),
    status,
    mensagem,
  };
}

let estado: EstadoDemo | null = null;
function st(): EstadoDemo {
  if (!estado) estado = estadoInicial();
  avancarTempo(estado);
  return estado;
}

/** Conclui o que "rodava em segundo plano": coleta, envios às plataformas, verificação e conferências. */
function avancarTempo(e: EstadoDemo) {
  const agora = Date.now();
  if (e.coletaIniciadaEm && agora - e.coletaIniciadaEm >= DURACAO_COLETA_MS) {
    const pendentes = [...e.produtos.values()].filter((p) => p.status !== 'padronizado').length;
    e.execucoesColeta = [
      ...e.execucoesColeta,
      {
        iniciada_em: new Date(e.coletaIniciadaEm).toISOString(), concluida_em: new Date().toISOString(), origem: 'manual', status: 'ok',
        resumo: { produtos: e.produtos.size, pendentes, pendencias_novas: 0, anuncios_sem_sku: SEM_SKU.length, erros: [] },
      },
    ];
    e.coletaIniciadaEm = null;
  }
  for (const [sku, fim] of e.envios) {
    if (agora < fim) continue;
    const p = e.produtos.get(sku);
    if (p) p.envio = montarEnvio(p, null, new Date(fim).toISOString());
    e.envios.delete(sku);
  }
  if (e.verificacaoIniciadaEm && agora - e.verificacaoIniciadaEm >= DURACAO_VERIFICACAO_MS) {
    concluirVerificacao(e, e.verificacaoIniciadaEm);
    e.verificacaoIniciadaEm = null;
  }
  for (const t of e.trocas) {
    if (t.status !== 'aguardando' || !t.verificar_em || Date.parse(t.verificar_em) > agora) continue;
    t.status = 'ok';
    t.verificado_em = t.verificar_em;
    t.mensagem = null;
    const a = e.anuncios.find((x) => x.filial === t.filial && x.mlb === t.mlb);
    if (a && t.para) a.modo_envio = t.para;
  }
}

// ---------------------------------------------------------------------------------------------
// Padronização de dimensões
// ---------------------------------------------------------------------------------------------

function progressoColeta(e: EstadoDemo): DimensoesStatus['progresso'] {
  if (!e.coletaIniciadaEm) return null;
  const frac = Math.min(1, (Date.now() - e.coletaIniciadaEm) / DURACAO_COLETA_MS);
  const em = new Date().toISOString();
  if (frac < 0.08) return { etapa: 'ML Norvia Campinas: listando anúncios', feitos: 0, total: 0, em };
  if (frac < 0.35) return { etapa: 'ML Norvia Campinas: anúncios e descrições', feitos: Math.round(((frac - 0.08) / 0.27) * 1240), total: 1240, em };
  if (frac < 0.55) return { etapa: 'ML Revesta: anúncios e descrições', feitos: Math.round(((frac - 0.35) / 0.2) * 860), total: 860, em };
  if (frac < 0.75) return { etapa: 'Tiny Norvia Campinas: cadastros dos produtos anunciados', feitos: Math.round(((frac - 0.55) / 0.2) * 1020), total: 1020, em };
  if (frac < 0.95) return { etapa: 'Tiny Revesta: cadastros dos produtos anunciados', feitos: Math.round(((frac - 0.75) / 0.2) * 740), total: 740, em };
  return { etapa: 'Comparando as medidas', feitos: 0, total: 0, em };
}

function proximaAs(hora: number): string {
  const d = new Date();
  d.setHours(hora, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export const demoDimensoes = {
  status(): DimensoesStatus {
    const e = st();
    const produtos = [...e.produtos.values()];
    const porStatus: DimensoesStatus['por_status'] = {};
    const porConf: DimensoesStatus['pendentes_por_confiabilidade'] = {};
    for (const p of produtos) {
      porStatus[p.status] = (porStatus[p.status] ?? 0) + 1;
      if (p.status !== 'padronizado') porConf[p.confiabilidade] = (porConf[p.confiabilidade] ?? 0) + 1;
    }
    return {
      banco_configurado: true,
      contas_tiny: Object.entries(ROTULO_TINY).map(([id, rotulo]) => ({ id, rotulo })),
      em_execucao: e.coletaIniciadaEm ? new Date(e.coletaIniciadaEm).toISOString() : null,
      progresso: progressoColeta(e),
      ultima_execucao: e.execucoesColeta.at(-1) ?? null,
      proxima_execucao: proximaAs(6),
      total_produtos: produtos.length,
      por_status: porStatus,
      pendentes_por_confiabilidade: porConf,
      com_erro_de_envio: produtos.filter((p) => p.envio?.status === 'erro').length,
      enviando: produtos.filter((p) => p.envio?.status === 'enviando').length,
      anuncios_sem_sku: SEM_SKU.length,
    };
  },

  produtos(f: { status?: string; confiabilidade?: string; envio?: string; q?: string; page?: number; pageSize?: number }): ProdutosPage {
    const statusOk = new Set((f.status ?? '').split(',').filter(Boolean));
    const termo = normalizar((f.q ?? '').trim());
    const ordem: Record<Confiabilidade, number> = { baixa: 0, media: 1, alta: 2 };
    const itens = [...st().produtos.values()]
      .filter((p) => !statusOk.size || statusOk.has(p.status))
      .filter((p) => !f.confiabilidade || p.confiabilidade === f.confiabilidade)
      .filter((p) => !f.envio || p.envio?.status === f.envio)
      .filter((p) => !termo || normalizar(`${p.sku} ${p.descricao}`).includes(termo))
      .sort((a, b) => ordem[a.confiabilidade] - ordem[b.confiabilidade] || normalizar(a.descricao).localeCompare(normalizar(b.descricao)));
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 30;
    return { itens: itens.slice((page - 1) * pageSize, page * pageSize), total: itens.length, page, page_size: pageSize };
  },

  semSku(): { itens: AnuncioSemSku[]; total: number } {
    return { itens: SEM_SKU, total: SEM_SKU.length };
  },

  validar(lista: Array<{ sku: string } & Medidas>): { gravados: string[]; recusados: string[] } {
    const e = st();
    const gravados: string[] = [];
    const recusados: string[] = [];
    for (const item of lista) {
      const p = e.produtos.get(item.sku);
      if (!p) continue;
      if (!item.altura || !item.largura || !item.comprimento) {
        recusados.push(`${item.sku}: informe altura, largura e comprimento`);
        continue;
      }
      const peso = item.peso ?? p.sugestao.peso ?? null;
      p.padrao = {
        altura: item.altura, largura: item.largura, comprimento: item.comprimento, peso,
        embalagem_comprimento: embalagemPara(item.comprimento),
        confiabilidade: p.confiabilidade,
        validado_por: 'João',
        validado_em: new Date().toISOString(),
      };
      p.status = 'padronizado';
      p.motivos = [];
      p.envio = { status: 'enviando', em: null, destinos: {} };
      e.envios.set(p.sku, Date.now() + DURACAO_ENVIO_MS);
      gravados.push(p.sku);
    }
    return { gravados, recusados };
  },

  reenviar(skus: string[]): { status: string; total: number } {
    const e = st();
    for (const sku of skus) {
      const p = e.produtos.get(sku);
      if (!p?.padrao) continue;
      p.envio = { ...(p.envio ?? { destinos: {}, em: null }), status: 'enviando' };
      e.envios.set(sku, Date.now() + DURACAO_ENVIO_MS);
    }
    return { status: 'iniciado', total: skus.length };
  },

  executar(): { status: string } {
    const e = st();
    if (e.coletaIniciadaEm) return { status: 'em_execucao' };
    e.coletaIniciadaEm = Date.now();
    return { status: 'iniciada' };
  },
};

// ---------------------------------------------------------------------------------------------
// Tipo de frete
// ---------------------------------------------------------------------------------------------

const BLOQUEIO_TEXTO: Record<BloqueioFrete, string> = {
  sem_padrao: 'Produto sem dimensões padronizadas: padronize em Padronização de dimensões.',
  sem_sku: 'Anúncio sem SKU no Mercado Livre: não dá para achar as dimensões padronizadas.',
  sem_embalagem: 'O produto não cabe na embalagem padrão (5 x 7 x até 300 cm): defina o envio manualmente.',
  sem_peso: 'Dimensões padronizadas sem peso: o ML exige o peso junto com as medidas.',
  sem_me1: 'Pelo tamanho só cabe no ME1, que não está ativo nesta conta.',
};

function padraoDoSku(e: EstadoDemo, sku: string | null): (Medidas & { sku: string }) | null {
  if (!sku) return null;
  const p = e.produtos.get(sku);
  if (p) return p.padrao ? { sku, altura: p.padrao.altura, largura: p.padrao.largura, comprimento: p.padrao.comprimento, peso: p.padrao.peso } : null;
  // Produtos que já nasceram padronizados (fora da lista de revisão): medida pelo título.
  const m = /(\d+(?:,\d+)?)\s*m(?:etros?)?\b/i.exec(sku.replace(/-/g, ' '));
  const comprimento = m ? Math.round(parseFloat(m[1].replace(',', '.')) * 100) : 100;
  return { sku, altura: 1.5, largura: 2, comprimento, peso: Math.round(comprimento * 1.4) };
}

function aguardando(e: EstadoDemo): Set<string> {
  return new Set(e.trocas.filter((t) => t.status === 'aguardando').map((t) => `${t.filial}:${t.mlb}`));
}

function situacao(a: AnuncioBase, ag: Set<string>, bloqueio: BloqueioFrete | null): SituacaoAnuncio {
  if (ag.has(`${a.filial}:${a.mlb}`)) return 'conferindo';
  if (a.falha_envio) return 'falha';
  if (a.modo_envio === 'not_specified') return bloqueio ? 'bloqueado' : 'a_combinar';
  return 'ok';
}

function publico(e: EstadoDemo, a: AnuncioBase, ag: Set<string>): AnuncioFrete {
  const padrao = padraoDoSku(e, a.sku);
  const comp = padrao?.comprimento ?? null;
  const embComp = embalagemPara(comp);
  const indicado: 'me1' | 'me2' | null = embComp == null ? null : embComp <= 100 ? 'me2' : 'me1';
  let bloqueio: BloqueioFrete | null = null;
  if (a.modo_envio === 'not_specified') {
    if (!a.sku) bloqueio = 'sem_sku';
    else if (!padrao) bloqueio = 'sem_padrao';
    else if (embComp == null) bloqueio = 'sem_embalagem';
    else if (indicado === 'me1' && a.filial === 'revesta') bloqueio = 'sem_me1';
  }
  return {
    filial: a.filial,
    mlb: a.mlb,
    titulo: a.titulo,
    sku: a.sku,
    skus: a.sku ? [a.sku] : [],
    status: a.status,
    permalink: null,
    thumbnail: null,
    modo_envio: a.modo_envio,
    tags_envio: a.modo_envio === 'me2' ? ['me2_available'] : [],
    padrao,
    embalagem: embComp ? { altura: 5, largura: 7, comprimento: embComp, peso: padrao?.peso ?? null } : null,
    embalagem_ml: a.modo_envio === 'not_specified'
      ? { altura: null, largura: null, comprimento: null, peso: padrao?.peso ?? null }
      : { altura: 5, largura: 7, comprimento: embComp, peso: padrao?.peso ?? null },
    envio_indicado: indicado,
    bloqueio,
    bloqueio_texto: bloqueio ? BLOQUEIO_TEXTO[bloqueio] : null,
    falha_envio: a.falha_envio,
    situacao: situacao(a, ag, bloqueio),
    sincronizado_em: a.sincronizado_em,
  };
}

function iniciarTroca(e: EstadoDemo, anuncio: AnuncioFrete, origem: TrocaFrete['origem'], usuario: string | null) {
  const base = e.anuncios.find((x) => x.filial === anuncio.filial && x.mlb === anuncio.mlb);
  if (!base || !anuncio.envio_indicado) return;
  base.falha_envio = null;
  const feita = Date.now();
  e.trocas.push({
    id: `${anuncio.filial}:${anuncio.mlb}:${feita}`,
    filial: anuncio.filial,
    mlb: anuncio.mlb,
    titulo: anuncio.titulo,
    de: base.modo_envio,
    para: anuncio.envio_indicado,
    dims: anuncio.embalagem,
    origem,
    usuario,
    feita_em: new Date(feita).toISOString(),
    verificar_em: new Date(feita + MINUTOS_CONFERENCIA * MIN).toISOString(),
    status: 'aguardando',
    mensagem: null,
  });
}

function concluirVerificacao(e: EstadoDemo, inicio: number) {
  const ag = aguardando(e);
  const prontos = e.anuncios.map((a) => publico(e, a, ag)).filter((a) => a.situacao === 'a_combinar');
  for (const a of prontos) iniciarTroca(e, a, 'rotina', null);
  const porFilial = (f: Filial) => e.anuncios.filter((a) => a.filial === f).length;
  e.execucoesFretes = [
    ...e.execucoesFretes,
    {
      iniciada_em: new Date(inicio).toISOString(),
      concluida_em: new Date().toISOString(),
      origem: 'manual',
      status: 'ok',
      resumo: {
        novos: 0, pendencias_novas: 0, trocas: prontos.length, erros: [],
        contas: { norvia: { status: 'ok', anuncios: porFilial('norvia') }, revesta: { status: 'ok', anuncios: porFilial('revesta') } },
      },
    },
  ];
}

export const demoFretes = {
  status(): FretesStatus {
    const e = st();
    const ag = aguardando(e);
    const catalogo = e.anuncios.map((a) => publico(e, a, ag));
    const contagem: FretesStatus['contagem'] = {};
    const envios: Record<string, number> = {};
    for (const a of catalogo) {
      contagem[a.situacao] = (contagem[a.situacao] ?? 0) + 1;
      if (a.modo_envio) envios[a.modo_envio] = (envios[a.modo_envio] ?? 0) + 1;
    }
    return {
      configurado: true,
      contas: {
        norvia: { rotulo: ROTULO_FILIAL.norvia, conectada: true, renovado_em: iso(2 * HORA), me1: true },
        revesta: { rotulo: ROTULO_FILIAL.revesta, conectada: true, renovado_em: iso(2 * HORA), me1: false },
      },
      em_execucao: e.verificacaoIniciadaEm ? new Date(e.verificacaoIniciadaEm).toISOString() : null,
      ultima_execucao: e.execucoesFretes.at(-1) ?? null,
      proxima_execucao: proximaAs(7),
      total_anuncios: catalogo.length,
      contagem,
      envios,
      desfeitos: catalogo.filter((a) => a.falha_envio).length,
      aguardando_conferencia: catalogo.filter((a) => ag.has(`${a.filial}:${a.mlb}`)).length,
      sem_padrao: catalogo.filter((a) => a.bloqueio === 'sem_padrao' || a.bloqueio === 'sem_sku').length,
      minutos_conferencia: MINUTOS_CONFERENCIA,
    };
  },

  anuncios(p: { q?: string; filial?: string; situacao?: string; modo?: string; bloqueio?: string; page?: number; pageSize?: number }): AnunciosPage {
    const e = st();
    const ag = aguardando(e);
    const bloqueios = new Set((p.bloqueio ?? '').split(',').filter(Boolean));
    const termo = normalizar((p.q ?? '').trim());
    const itens = e.anuncios
      .map((a) => publico(e, a, ag))
      .filter((a) => !p.filial || a.filial === p.filial)
      .filter((a) => !p.modo || (a.modo_envio ?? '') === p.modo)
      .filter((a) => !bloqueios.size || (a.bloqueio != null && bloqueios.has(a.bloqueio)))
      .filter((a) => !p.situacao || a.situacao === p.situacao)
      .filter((a) => !termo || normalizar(`${a.mlb} ${a.sku ?? ''} ${a.titulo}`).includes(termo))
      .sort((a, b) => {
        const pa = a.situacao === 'a_combinar' || a.situacao === 'bloqueado' ? 0 : 1;
        const pb = b.situacao === 'a_combinar' || b.situacao === 'bloqueado' ? 0 : 1;
        return pa - pb || normalizar(a.titulo).localeCompare(normalizar(b.titulo));
      });
    const page = p.page ?? 1;
    const pageSize = p.pageSize ?? 50;
    return { itens: itens.slice((page - 1) * pageSize, page * pageSize), total: itens.length, page, page_size: pageSize };
  },

  desfeitos(): { itens: AnuncioFrete[]; total: number } {
    const e = st();
    const ag = aguardando(e);
    const itens = e.anuncios.filter((a) => a.falha_envio).map((a) => publico(e, a, ag));
    return { itens, total: itens.length };
  },

  retentar(lista: Array<{ filial: Filial; mlb: string }>): { status: string; total: number } {
    const e = st();
    const ag = aguardando(e);
    let total = 0;
    for (const alvo of lista) {
      const base = e.anuncios.find((a) => a.filial === alvo.filial && a.mlb === alvo.mlb);
      if (!base) continue;
      iniciarTroca(e, publico(e, base, ag), 'manual', 'João');
      total += 1;
    }
    return { status: 'iniciada', total };
  },

  historico(status = ''): HistoricoFretes {
    const e = st();
    const itens = e.trocas.filter((t) => !status || t.status === status).sort((a, b) => b.feita_em.localeCompare(a.feita_em));
    return { itens, total: itens.length, execucoes: [...e.execucoesFretes].reverse() };
  },

  executar(): { status: string } {
    const e = st();
    if (e.verificacaoIniciadaEm) return { status: 'em_execucao' };
    e.verificacaoIniciadaEm = Date.now();
    return { status: 'iniciada' };
  },
};
