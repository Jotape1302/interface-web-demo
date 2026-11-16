// Dados fictícios das automações de Marketplace (Padronização de dimensões e Tipo de frete) para o
// modo demonstração. Imita as regras da API Python (backend/automations/automacoes-marketplace):
// medidas do Tiny da mesma empresa × ficha/embalagem do anúncio, confirmação → envio em segundo
// plano, coleta com progresso, verificação de fretes (e varredura do tipo) com conferência. O
// estado vive em memória e volta ao início ao recarregar.

import type {
  AnuncioDimensoes,
  AnuncioSemSku,
  DimensoesStatus,
  ExecucaoColeta,
  ProdutoDimensoes,
  ProdutosPage,
  SituacaoAnuncioDimensoes,
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

const ROTULO_FILIAL: Record<Filial, string> = { norvia: 'Norvia Campinas', revesta: 'Revesta' };
/** Cada conta do ML lê o Tiny da própria empresa (TINY_CONTA_POR_FILIAL). */
const TINY_DA_FILIAL: Record<Filial, { conta: string; rotulo: string }> = {
  norvia: { conta: 'norvia_campinas', rotulo: 'Tiny Norvia Campinas' },
  revesta: { conta: 'revesta', rotulo: 'Tiny Revesta' },
};
const MINUTOS_CONFERENCIA = 10;
const DURACAO_COLETA_MS = 45_000;
const DURACAO_VERIFICACAO_MS = 12_000;
const DURACAO_ENVIO_MS = 6_000;
const ME2_MAX_EMBALAGEM_CM = 200;

type Dims = [number | null, number | null, number | null, number | null]; // altura, largura, comprimento (cm), peso (g)
const medidas = ([altura, largura, comprimento, peso]: Dims): Medidas => ({ altura, largura, comprimento, peso });
const completas = (m: Medidas) => [m.altura, m.largura, m.comprimento].every((v) => v != null && v > 0);

/** Ficha atual do anúncio: atributo do ML → valor (cm; WEIGHT em g), null se vazio. */
type Ficha = Record<string, number | null>;
type SeedAnuncio = [Filial, string, string, Ficha, Dims | null]; // filial, MLB, título, ficha, embalagem no ML

interface SeedProduto {
  sku: string;
  descricao: string;
  /** Cadastro no Tiny (peso = peso BRUTO); null = SKU não encontrado no Tiny. */
  tiny: Dims | null;
  anuncios: SeedAnuncio[];
  envio?: 'ok' | 'erro';
}

const SEED_PRODUTOS: SeedProduto[] = [
  {
    sku: 'PF-ALU-3M-BR', descricao: 'Perfil de Alumínio para Fita LED 3 metros Branco', tiny: [1.2, 1.7, 300, 420],
    anuncios: [['norvia', 'MLB3456789012', 'Perfil Alumínio Fita Led 3m Branco Embutir Com Difusor', { LENGTH: 200, WEIGHT: 380 }, null]],
  },
  {
    sku: 'RDP-MDF-10CM', descricao: 'Rodapé MDF Branco 10cm x 2,40m', tiny: [1.5, 10, 240, 1700],
    anuncios: [['revesta', 'MLB4012345678', 'Rodapé Mdf Branco 10cm Ultra Resistente Barra 2,40m', { HEIGHT: 10, LENGTH: 240, WEIGHT: 1650 }, null]],
  },
  {
    sku: 'CANT-ALU-25', descricao: 'Cantoneira de Alumínio 25x25mm 3m Natural', tiny: [2.5, 2.5, 300, 460],
    anuncios: [['norvia', 'MLB3498761234', 'Cantoneira Alumínio 25x25mm Barra 3 Metros Acabamento', { WIDTH: 2.5, LENGTH: 300 }, [5, 7, 200, 420]]],
  },
  {
    sku: 'PF-LED-SOB-2M', descricao: 'Perfil de Sobrepor para LED 2 metros Preto', tiny: [0.9, 1.6, 200, 260],
    anuncios: [
      ['norvia', 'MLB3511122233', 'Perfil Led Sobrepor Preto 2m Com Tampa Leitosa', { LENGTH: 200, WEIGHT: 240 }, [10, 10, 200, 240]],
      ['norvia', 'MLB3511122299', 'Kit 2 Perfis Led Sobrepor Preto 2m', { LENGTH: 200 }, [5, 7, 200, 260]],
    ],
  },
  {
    sku: 'TRILHO-CORT-2M', descricao: 'Trilho Suíço para Cortina 2 metros', tiny: [1.8, 3, 200, 560],
    anuncios: [['norvia', 'MLB3522233344', 'Trilho Suíço Cortina 2 Metros Completo Com Deslizantes', { LENGTH: 200, WEIGHT: null }, [5, 7, 200, 520]]],
  },
  {
    sku: 'MOLD-GESSO-2M', descricao: 'Moldura de Poliestireno para Teto 2m', tiny: [4, 6, 200, 340],
    anuncios: [['revesta', 'MLB4045678901', 'Moldura Teto Sanca Poliestireno 6cm Barra 2m Branca', { HEIGHT: 10, WIDTH: 10, LENGTH: 100 }, [10, 10, 100, 500]]],
  },
  {
    sku: 'PISO-VIN-CX', descricao: 'Piso Vinílico Click Carvalho Caixa 2,2m²', tiny: [6, 18, 122, 14600],
    anuncios: [['revesta', 'MLB4034567890', 'Piso Vinílico Click Carvalho Natural 5mm Caixa 2,2m²', { WEIGHT: 14000 }, null]],
  },
  {
    sku: 'PERF-U-ACM', descricao: 'Perfil U para ACM 4mm 3m', tiny: [1, 1.2, 300, null],
    anuncios: [['norvia', 'MLB3544455566', 'Perfil U Acabamento Acm 4mm Barra 3 Metros', { LENGTH: 300 }, null]],
  },
  {
    sku: 'ESP-ACAB-JUNTA', descricao: 'Perfil de Transição Piso/Piso Inox 90cm', tiny: null,
    anuncios: [['norvia', 'MLB3533344455', 'Perfil Transição Piso Inox Escovado 90cm Junta Dilatação', { LENGTH: 90 }, null]],
  },
  {
    sku: 'PF-ALU-1M-PT', descricao: 'Perfil de Alumínio para Fita LED 1 metro Preto', tiny: [1.2, 1.7, 100, 150], envio: 'ok',
    anuncios: [['norvia', 'MLB3566677788', 'Perfil Alumínio Led 1m Preto Embutir Com Difusor', { LENGTH: 100, WEIGHT: 150 }, [5, 7, 100, 150]]],
  },
  {
    sku: 'RDP-MDF-15CM', descricao: 'Rodapé MDF Branco 15cm x 2,40m', tiny: [1.5, 15, 240, 2450], envio: 'ok',
    anuncios: [['revesta', 'MLB4067890123', 'Rodapé Mdf Branco 15cm Barra 2,40m Frisado', { HEIGHT: 15, LENGTH: 240, WEIGHT: 2450 }, null]],
  },
  {
    sku: 'SOL-MARM-80', descricao: 'Soleira de Mármore Branco 80cm', tiny: [2, 14, 80, 4950],
    anuncios: [['norvia', 'MLB3577788899', 'Soleira Mármore Branco Piguês 80x14cm', { WIDTH: 14, LENGTH: 80 }, null]],
  },
  {
    sku: 'PF-CANT-LED-2M', descricao: 'Perfil de Canto para LED 2 metros', tiny: [1.6, 1.6, 200, 280], envio: 'erro',
    anuncios: [['norvia', 'MLB3588899900', 'Perfil Led Canto 45 Graus 2 Metros Alumínio', { LENGTH: 200 }, [5, 7, 300, 260]]],
  },
  {
    sku: 'FITA-VED-10M', descricao: 'Fita de Vedação para Esquadrias 10m', tiny: [3, 10, 10, 210], envio: 'ok',
    anuncios: [['revesta', 'MLB4078901234', 'Fita Vedação Esquadria Espuma 10 Metros', { LENGTH: 10 }, null]],
  },
];

const SEM_SKU: AnuncioSemSku[] = [
  { filial: 'norvia', mlb: 'MLB3599900011', titulo: 'Kit 5 Perfis Led 1m Alumínio Com Tampa', permalink: null },
  { filial: 'revesta', mlb: 'MLB4089012345', titulo: 'Rodapé Poliestireno Ecológico 10cm Barra', permalink: null },
];

// ---------------------------------------------------------------------------------------------
// Comparação Tiny × ML (mesmas regras de padronizacao.comparar_anuncio)
// ---------------------------------------------------------------------------------------------

const CAMPO_DO_ATRIBUTO: Record<string, keyof Medidas> = {
  HEIGHT: 'altura', THICKNESS: 'altura', WIDTH: 'largura', LENGTH: 'comprimento', WEIGHT: 'peso',
};

// Embalagem = medidas do cadastro do Tiny, com o peso bruto (como no backend).
function embalagemDe(m: Medidas): Medidas | null {
  return completas(m) ? { altura: m.altura, largura: m.largura, comprimento: m.comprimento, peso: m.peso ?? null } : null;
}

const mesmoPeso = (a?: number | null, b?: number | null) => Boolean(a && b && Math.abs(a - b) <= Math.max(10, 0.05 * Math.max(a, b)));

function mesmoTamanho(a: Medidas | null, b: Medidas): boolean {
  if (!a || !completas(a) || !completas(b)) return false;
  const la = [a.altura!, a.largura!, a.comprimento!].sort((x, y) => x - y);
  const lb = [b.altura!, b.largura!, b.comprimento!].sort((x, y) => x - y);
  return la.every((x, i) => Math.abs(x - lb[i]) <= Math.max(0.5, 0.03 * Math.max(x, lb[i])));
}

const num = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }));
const textoEmb = (m: Medidas) => `${num(m.altura)} x ${num(m.largura)} x ${num(m.comprimento)} cm, ${num(m.peso)} g`;

function comparar(filial: Filial, ficha: Ficha, embalagemMl: Medidas, tiny: Dims | null): Omit<AnuncioDimensoes, 'filial' | 'mlb' | 'titulo' | 'permalink' | 'atributos' | 'ficha_atual' | 'ficha_ml' | 'embalagem_ml'> {
  const rotulo = TINY_DA_FILIAL[filial].rotulo;
  const vazio = { ficha_alvo: {}, embalagem_alvo: null, ficha_diferente: [], embalagem_diferente: false, diferencas: [] };
  if (!tiny) return { situacao: 'sem_tiny', conta_tiny: rotulo, alvo: null, ...vazio, mensagem: `SKU não encontrado no ${rotulo}.` };
  const alvo = medidas(tiny);
  const falta = (['altura', 'largura', 'comprimento'] as const).filter((c) => !alvo[c]) as string[];
  if (!alvo.peso) falta.push('peso bruto');
  if (falta.length) return { situacao: 'sem_medida', conta_tiny: rotulo, alvo, ...vazio, mensagem: `Cadastro no ${rotulo} sem ${falta.join(', ')}.` };

  const ficha_alvo: Record<string, number> = {};
  for (const attr of Object.keys(ficha)) {
    const v = alvo[CAMPO_DO_ATRIBUTO[attr]];
    if (v != null) ficha_alvo[attr] = v;
  }
  const ficha_diferente: string[] = [];
  const diferencas: string[] = [];
  for (const [attr, valor] of Object.entries(ficha_alvo)) {
    const tem = ficha[attr];
    const peso = attr.includes('WEIGHT');
    const igual = peso ? mesmoPeso(tem, valor) : tem != null && Math.abs(tem - valor) <= 0.5;
    if (!igual) {
      ficha_diferente.push(attr);
      const un = peso ? 'g' : 'cm';
      diferencas.push(`Ficha ${attr}: ${tem != null ? `${num(tem)} ${un}` : 'vazio'} → ${num(valor)} ${un}`);
    }
  }
  const emb = embalagemDe(alvo);
  let embalagem_diferente = false;
  if (emb && !(mesmoTamanho(embalagemMl, emb) && mesmoPeso(embalagemMl.peso, emb.peso))) {
    embalagem_diferente = true;
    diferencas.push(`Embalagem: ${completas(embalagemMl) ? textoEmb(embalagemMl) : 'vazia'} → ${textoEmb(emb)}`);
  }
  return {
    situacao: diferencas.length ? 'diferente' : 'igual',
    conta_tiny: rotulo, alvo, ficha_alvo, embalagem_alvo: emb, ficha_diferente, embalagem_diferente, diferencas, mensagem: null,
  };
}

function statusDoProduto(anuncios: AnuncioDimensoes[]): StatusPadronizacao {
  const s = new Set<SituacaoAnuncioDimensoes>(anuncios.map((a) => a.situacao));
  if (s.has('diferente')) return 'pendente';
  if (s.has('bloqueado_ml')) return 'bloqueado';
  if (s.has('sem_tiny') || s.has('sem_medida')) return 'sem_medida';
  return 'padronizado';
}

const localMl = (filial: Filial, mlb: string) => `ML ${ROTULO_FILIAL[filial]} · ${mlb}`;

function montarProduto(s: SeedProduto): ProdutoDimensoes {
  const anuncios: AnuncioDimensoes[] = s.anuncios.map(([filial, mlb, titulo, ficha, emb]) => {
    const embalagem_ml = medidas(emb ?? [null, null, null, null]);
    return {
      filial, mlb, titulo, permalink: null,
      atributos: Object.keys(ficha),
      ficha_atual: { ...ficha },
      ficha_ml: {
        altura: ficha.HEIGHT ?? ficha.THICKNESS ?? null, largura: ficha.WIDTH ?? null,
        comprimento: ficha.LENGTH ?? null, peso: ficha.WEIGHT ?? null,
      },
      embalagem_ml,
      ...comparar(filial, ficha, embalagem_ml, s.tiny),
    };
  });
  const filiais = [...new Set(s.anuncios.map(([f]) => f))];
  const produto: ProdutoDimensoes = {
    sku: s.sku,
    descricao: s.descricao,
    tiny: s.tiny
      ? filiais.map((f, i) => ({
          conta: TINY_DA_FILIAL[f].conta, rotulo: TINY_DA_FILIAL[f].rotulo, id: 812300 + i * 1000 + s.sku.length * 17,
          medidas: medidas(s.tiny!), peso_liquido: s.tiny![3] ? Math.round(s.tiny![3] * 0.95) : null,
        }))
      : [],
    anuncios,
    status: statusDoProduto(anuncios),
    motivos: anuncios.filter((a) => a.mensagem && (a.situacao === 'sem_tiny' || a.situacao === 'sem_medida')).map((a) => a.mensagem!),
    coletado_em: iso(5 * HORA),
  };
  if (s.envio) {
    const em = iso(3 * 24 * HORA);
    const destinos: NonNullable<ProdutoDimensoes['envio']>['destinos'] = {};
    for (const a of anuncios) {
      destinos[`ml:${a.filial}:${a.mlb}`] =
        s.envio === 'erro'
          ? { status: 'erro', local: localMl(a.filial, a.mlb), em, mensagem: 'HTTP 400: item.attributes.invalid — SELLER_PACKAGE_WEIGHT fora do intervalo aceito.' }
          : { status: 'ok', local: localMl(a.filial, a.mlb), em };
    }
    produto.envio = { status: s.envio, em, por: 'Marina E-commerce', destinos };
  }
  return produto;
}

/** Fim do envio: o que estava diferente passa a valer no anúncio (como em padronizacao.enviar). */
function concluirEnvio(p: ProdutoDimensoes, em: string) {
  const destinos: NonNullable<ProdutoDimensoes['envio']>['destinos'] = {};
  for (const a of p.anuncios) {
    if (a.situacao !== 'diferente') continue;
    destinos[`ml:${a.filial}:${a.mlb}`] = { status: 'ok', local: localMl(a.filial, a.mlb), em };
    a.ficha_atual = { ...a.ficha_atual, ...a.ficha_alvo };
    if (a.embalagem_diferente && a.embalagem_alvo) a.embalagem_ml = { ...a.embalagem_alvo };
    a.situacao = 'igual';
    a.diferencas = [];
    a.ficha_diferente = [];
    a.embalagem_diferente = false;
  }
  p.status = statusDoProduto(p.anuncios);
  p.envio = { ...(p.envio ?? { destinos: {} }), status: 'ok', em, destinos };
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
  /** A verificação em andamento é a varredura do tipo (botão "Corrigir tipo de frete"). */
  varredura: boolean;
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

// Anúncios do Tipo de frete: os produtos acima + alguns só com ME1/ME2 (uns com o tipo errado).
const SEED_ANUNCIOS: Array<[Filial, string, string, string | null, string, 'falha'?]> = [
  ['norvia', 'MLB3456789012', 'Perfil Alumínio Fita Led 3m Branco Embutir Com Difusor', 'PF-ALU-3M-BR', 'not_specified'],
  ['revesta', 'MLB4012345678', 'Rodapé Mdf Branco 10cm Ultra Resistente Barra 2,40m', 'RDP-MDF-10CM', 'not_specified'],
  ['norvia', 'MLB3498761234', 'Cantoneira Alumínio 25x25mm Barra 3 Metros Acabamento', 'CANT-ALU-25', 'not_specified'],
  ['norvia', 'MLB3522233344', 'Trilho Suíço Cortina 2 Metros Completo Com Deslizantes', 'TRILHO-CORT-2M', 'not_specified'],
  ['norvia', 'MLB3544455566', 'Perfil U Acabamento Acm 4mm Barra 3 Metros', 'PERF-U-ACM', 'not_specified'],
  ['norvia', 'MLB3566677788', 'Perfil Alumínio Led 1m Preto Embutir Com Difusor', 'PF-ALU-1M-PT', 'me2'],
  ['revesta', 'MLB4067890123', 'Rodapé Mdf Branco 15cm Barra 2,40m Frisado', 'RDP-MDF-15CM', 'not_specified'],
  ['norvia', 'MLB3577788899', 'Soleira Mármore Branco Piguês 80x14cm', 'SOL-MARM-80', 'not_specified'],
  ['revesta', 'MLB4078901234', 'Fita Vedação Esquadria Espuma 10 Metros', 'FITA-VED-10M', 'not_specified'],
  ['norvia', 'MLB3599900011', 'Kit 5 Perfis Led 1m Alumínio Com Tampa', null, 'not_specified'],
  ['norvia', 'MLB3588899900', 'Perfil Led Canto 45 Graus 2 Metros Alumínio', 'PF-CANT-LED-2M', 'not_specified', 'falha'],
  ['norvia', 'MLB3611122233', 'Perfil Led Embutir Gesso 1m Com Aletas', 'PF-GESSO-1M', 'me2'],
  ['norvia', 'MLB3622233344', 'Tampa Difusora Leitosa Perfil Led 1m', 'TAMPA-DIF-1M', 'me2'],
  ['revesta', 'MLB4090123456', 'Cantoneira Alumínio Piso 1m Dourada', 'CANT-ALU-DOUR', 'me2'],
  ['revesta', 'MLB4101234567', 'Kit Presilhas Rodapé 50 Unidades', 'PRES-RDP-50', 'me2'],
  ['norvia', 'MLB3633344455', 'Perfil Led Pendente 3m Alumínio Preto', 'PF-PEND-3M', 'me1'],
  ['norvia', 'MLB3644455566', 'Perfil Led Rodapé 2m Luz Indireta', 'PF-RDP-LED-2M', 'me1'],
  ['norvia', 'MLB3511122233', 'Perfil Led Sobrepor Preto 2m Com Tampa Leitosa', 'PF-LED-SOB-2M', 'me1'],
  ['norvia', 'MLB3666677788', 'Perfil Led Sobrepor 3m Branco', 'PF-SOB-3M', 'me2'],
  ['norvia', 'MLB3655566677', 'Perfil Led Slim 1m Anodizado Fosco', 'PF-SLIM-1M', 'me2'],
  ['revesta', 'MLB4123456789', 'Rodapé Vinílico Flexível Cinza 5cm Rolo', 'RDP-VIN-5CM', 'me2'],
  ['revesta', 'MLB4134567890', 'Perfil Led Alumínio Embutir 3m Branco', 'PF-EMB-3M', 'not_specified'],
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
      ? { mensagem: 'O ML desfez a troca para ME2: o anúncio voltou para "a combinar".', em: iso(20 * HORA) }
      : null,
    sincronizado_em: iso(4 * HORA),
  }));
  const trocas: TrocaFrete[] = [
    troca('norvia', 'MLB3611122233', 'Perfil Led Embutir Gesso 1m Com Aletas', 'not_specified', 'me2', [5, 7, 100, 150], 'ok', 26 * HORA),
    troca('revesta', 'MLB4090123456', 'Cantoneira Alumínio Piso 1m Dourada', 'not_specified', 'me2', [5, 7, 100, 120], 'ok', 26 * HORA),
    troca('norvia', 'MLB3633344455', 'Perfil Led Pendente 3m Alumínio Preto', 'not_specified', 'me1', [5, 7, 300, 900], 'ok', 26 * HORA),
    troca('norvia', 'MLB3588899900', 'Perfil Led Canto 45 Graus 2 Metros Alumínio', 'not_specified', 'me2', [5, 7, 200, 280], 'revertido', 21 * HORA,
      'O ML desfez a troca: o anúncio voltou para "a combinar".'),
  ];
  const execucaoFretes: ExecucaoFretes = {
    iniciada_em: iso(26 * HORA),
    concluida_em: iso(26 * HORA - 3 * MIN),
    origem: 'agendada',
    status: 'ok',
    resumo: {
      novos: 3, trocas: 4, corrigidos: 0, erros: [],
      contas: { norvia: { status: 'ok', anuncios: 15 }, revesta: { status: 'ok', anuncios: 6 } },
    },
  };
  return {
    produtos,
    execucoesColeta: [
      {
        iniciada_em: iso(29 * HORA), concluida_em: iso(29 * HORA - 7 * MIN), origem: 'agendada', status: 'ok',
        resumo: { produtos: 14, pendentes: 8, sem_medida: 2, pendencias_novas: 3, anuncios_sem_sku: 2, erros: [] },
      },
      {
        iniciada_em: iso(5 * HORA), concluida_em: iso(5 * HORA - 6 * MIN), origem: 'agendada', status: 'ok',
        resumo: { produtos: 14, pendentes: 8, sem_medida: 2, pendencias_novas: 0, anuncios_sem_sku: 2, erros: [] },
      },
    ],
    coletaIniciadaEm: null,
    envios: new Map(),
    anuncios,
    trocas,
    execucoesFretes: [execucaoFretes],
    verificacaoIniciadaEm: null,
    varredura: false,
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

/** Conclui o que "rodava em segundo plano": coleta, envios ao ML, verificação e conferências. */
function avancarTempo(e: EstadoDemo) {
  const agora = Date.now();
  if (e.coletaIniciadaEm && agora - e.coletaIniciadaEm >= DURACAO_COLETA_MS) {
    const produtos = [...e.produtos.values()];
    e.execucoesColeta = [
      ...e.execucoesColeta,
      {
        iniciada_em: new Date(e.coletaIniciadaEm).toISOString(), concluida_em: new Date().toISOString(), origem: 'manual', status: 'ok',
        resumo: {
          produtos: produtos.length,
          pendentes: produtos.filter((p) => p.status === 'pendente').length,
          sem_medida: produtos.filter((p) => p.status === 'sem_medida').length,
          pendencias_novas: 0, anuncios_sem_sku: SEM_SKU.length, erros: [],
        },
      },
    ];
    e.coletaIniciadaEm = null;
  }
  for (const [sku, fim] of e.envios) {
    if (agora < fim) continue;
    const p = e.produtos.get(sku);
    if (p) concluirEnvio(p, new Date(fim).toISOString());
    e.envios.delete(sku);
  }
  if (e.verificacaoIniciadaEm && agora - e.verificacaoIniciadaEm >= DURACAO_VERIFICACAO_MS) {
    concluirVerificacao(e, e.verificacaoIniciadaEm, e.varredura);
    e.verificacaoIniciadaEm = null;
    e.varredura = false;
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
  if (frac < 0.35) return { etapa: 'ML Norvia Campinas: anúncios', feitos: Math.round(((frac - 0.08) / 0.27) * 1240), total: 1240, em };
  if (frac < 0.55) return { etapa: 'ML Revesta: anúncios', feitos: Math.round(((frac - 0.35) / 0.2) * 860), total: 860, em };
  if (frac < 0.75) return { etapa: 'Tiny Norvia Campinas: cadastros dos produtos anunciados', feitos: Math.round(((frac - 0.55) / 0.2) * 1020), total: 1020, em };
  if (frac < 0.95) return { etapa: 'Tiny Revesta: cadastros dos produtos anunciados', feitos: Math.round(((frac - 0.75) / 0.2) * 740), total: 740, em };
  return { etapa: 'Comparando com os anúncios', feitos: 0, total: 0, em };
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
    for (const p of produtos) porStatus[p.status] = (porStatus[p.status] ?? 0) + 1;
    return {
      banco_configurado: true,
      contas_tiny: (Object.keys(TINY_DA_FILIAL) as Filial[]).map((f) => ({ id: TINY_DA_FILIAL[f].conta, rotulo: TINY_DA_FILIAL[f].rotulo, filial: f })),
      em_execucao: e.coletaIniciadaEm ? new Date(e.coletaIniciadaEm).toISOString() : null,
      progresso: progressoColeta(e),
      ultima_execucao: e.execucoesColeta.at(-1) ?? null,
      proxima_execucao: proximaAs(6),
      total_produtos: produtos.length,
      por_status: porStatus,
      anuncios_a_enviar: produtos.reduce((n, p) => n + p.anuncios.filter((a) => a.situacao === 'diferente').length, 0),
      produtos_enviados: produtos.filter((p) => p.envio?.status === 'ok').length,
      com_erro_de_envio: produtos.filter((p) => p.envio?.status === 'erro').length,
      enviando: produtos.filter((p) => p.envio?.status === 'enviando').length,
      anuncios_sem_sku: SEM_SKU.length,
    };
  },

  produtos(f: { status?: string; envio?: string; q?: string; page?: number; pageSize?: number }): ProdutosPage {
    const statusOk = new Set((f.status ?? '').split(',').filter(Boolean));
    const termo = normalizar((f.q ?? '').trim());
    const ordem: Record<StatusPadronizacao, number> = { pendente: 0, bloqueado: 1, sem_medida: 2, padronizado: 3 };
    const itens = [...st().produtos.values()]
      .filter((p) => !statusOk.size || statusOk.has(p.status))
      .filter((p) => !f.envio || p.envio?.status === f.envio)
      .filter((p) => !termo || normalizar(`${p.sku} ${p.descricao}`).includes(termo))
      .sort((a, b) => ordem[a.status] - ordem[b.status] || normalizar(a.descricao).localeCompare(normalizar(b.descricao)));
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 30;
    return { itens: itens.slice((page - 1) * pageSize, page * pageSize), total: itens.length, page, page_size: pageSize };
  },

  semSku(): { itens: AnuncioSemSku[]; total: number } {
    return { itens: SEM_SKU, total: SEM_SKU.length };
  },

  /** Confirma o envio ao ML das medidas do Tiny (padronizacao.confirmar). */
  validar(skus: string[]): { aceitos: string[]; recusados: string[] } {
    const e = st();
    const aceitos: string[] = [];
    const recusados: string[] = [];
    for (const sku of skus) {
      const p = e.produtos.get(sku);
      if (!p) recusados.push(`${sku}: produto não encontrado na última coleta`);
      else if (p.envio?.status === 'enviando') recusados.push(`${sku}: envio já em andamento`);
      else if (!p.anuncios.some((a) => a.situacao === 'diferente')) recusados.push(`${sku}: nenhum anúncio diferente do Tiny`);
      else {
        p.envio = { status: 'enviando', em: new Date().toISOString(), por: 'João', destinos: {} };
        e.envios.set(sku, Date.now() + DURACAO_ENVIO_MS);
        aceitos.push(sku);
      }
    }
    return { aceitos, recusados };
  },

  reenviar(skus: string[]): { aceitos: string[]; recusados: string[] } {
    return demoDimensoes.validar(skus);
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
  sem_padrao: 'SKU sem altura, largura, comprimento ou peso bruto no Tiny desta empresa: complete o cadastro no Tiny.',
  sem_sku: 'Anúncio sem SKU no Mercado Livre: não dá para achar o produto no Tiny.',
  sem_embalagem: 'Produto sem as três medidas no Tiny da empresa: corrija o cadastro no Tiny.',
  sem_peso: 'Cadastro do Tiny sem peso bruto: o ML exige o peso junto com as medidas.',
  sem_me1: 'A embalagem de 3 m vai no ME1, que não está ativo nesta conta.',
};

/** Medidas do Tiny da empresa do anúncio (como padronizacao.padroes_por_filial). */
function padraoDoSku(e: EstadoDemo, filial: Filial, sku: string | null): (Medidas & { sku: string }) | null {
  if (!sku) return null;
  const p = e.produtos.get(sku);
  if (p) {
    const t = p.tiny.find((x) => x.conta === TINY_DA_FILIAL[filial].conta);
    return t && completas(t.medidas) && t.medidas.peso ? { sku, ...t.medidas } : null;
  }
  // Produtos fora da lista da Padronização: medida pelo SKU (PF-PEND-3M → 300 cm).
  const m = /(\d+(?:,\d+)?)\s*m(?:etros?)?\b/i.exec(sku.replace(/-/g, ' '));
  const comprimento = m ? Math.round(parseFloat(m[1].replace(',', '.')) * 100) : 100;
  return { sku, altura: 1.5, largura: 2, comprimento, peso: Math.round(comprimento * 1.4) };
}

function aguardando(e: EstadoDemo): Set<string> {
  return new Set(e.trocas.filter((t) => t.status === 'aguardando').map((t) => `${t.filial}:${t.mlb}`));
}

function precisaCorrigir(modo: string, indicado: string | null): boolean {
  return (modo === 'me1' || modo === 'me2') && Boolean(indicado) && modo !== indicado;
}

function situacao(a: AnuncioBase, ag: Set<string>, bloqueio: BloqueioFrete | null, indicado: string | null): SituacaoAnuncio {
  if (ag.has(`${a.filial}:${a.mlb}`)) return 'conferindo';
  if (a.falha_envio) return 'falha';
  if (a.modo_envio === 'not_specified') return bloqueio ? 'bloqueado' : 'a_combinar';
  if (precisaCorrigir(a.modo_envio, indicado) && !bloqueio) return 'tipo_inconsistente';
  return 'ok';
}

function publico(e: EstadoDemo, a: AnuncioBase, ag: Set<string>): AnuncioFrete {
  const padrao = padraoDoSku(e, a.filial, a.sku);
  const emb = padrao ? embalagemDe(padrao) : null;
  const indicado: 'me1' | 'me2' | null = emb ? (Math.max(emb.altura!, emb.largura!, emb.comprimento!) <= ME2_MAX_EMBALAGEM_CM ? 'me2' : 'me1') : null;
  let bloqueio: BloqueioFrete | null = null;
  if (!a.sku) bloqueio = 'sem_sku';
  else if (!padrao) bloqueio = 'sem_padrao';
  else if (!emb) bloqueio = 'sem_embalagem';
  else if (indicado === 'me1' && a.filial === 'revesta') bloqueio = 'sem_me1';
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
    logistic_type: 'drop_off',
    tags_envio: a.modo_envio === 'me2' ? ['me2_available'] : [],
    padrao,
    embalagem: emb,
    embalagem_ml: a.modo_envio === 'not_specified' || !emb
      ? { altura: null, largura: null, comprimento: null, peso: padrao?.peso ?? null }
      : emb,
    envio_indicado: indicado,
    bloqueio,
    bloqueio_texto: bloqueio ? BLOQUEIO_TEXTO[bloqueio] : null,
    falha_envio: a.falha_envio,
    situacao: situacao(a, ag, bloqueio, indicado),
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

/** A rotina troca os "a combinar"; a varredura também corrige ME1/ME2 com o tipo errado. */
function concluirVerificacao(e: EstadoDemo, inicio: number, varredura: boolean) {
  const ag = aguardando(e);
  const catalogo = e.anuncios.map((a) => publico(e, a, ag));
  const prontos = catalogo.filter((a) => a.situacao === 'a_combinar');
  const corrigir = varredura ? catalogo.filter((a) => a.situacao === 'tipo_inconsistente') : [];
  for (const a of prontos) iniciarTroca(e, a, varredura ? 'varredura' : 'rotina', null);
  for (const a of corrigir) iniciarTroca(e, a, 'varredura', null);
  const porFilial = (f: Filial) => ({
    status: 'ok',
    anuncios: e.anuncios.filter((a) => a.filial === f).length,
    tipo_corrigido: corrigir.filter((a) => a.filial === f).length,
  });
  e.execucoesFretes = [
    ...e.execucoesFretes,
    {
      iniciada_em: new Date(inicio).toISOString(),
      concluida_em: new Date().toISOString(),
      origem: varredura ? 'varredura' : 'manual',
      status: 'ok',
      resumo: {
        novos: 0, trocas: prontos.length, corrigidos: corrigir.length, erros: [],
        contas: { norvia: porFilial('norvia'), revesta: porFilial('revesta') },
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
    const prioridade = (s: SituacaoAnuncio) => (s === 'a_combinar' || s === 'bloqueado' || s === 'tipo_inconsistente' ? 0 : 1);
    const itens = e.anuncios
      .map((a) => publico(e, a, ag))
      .filter((a) => !p.filial || a.filial === p.filial)
      .filter((a) => !p.modo || (a.modo_envio ?? '') === p.modo)
      .filter((a) => !bloqueios.size || (a.bloqueio != null && bloqueios.has(a.bloqueio)))
      .filter((a) => !p.situacao || a.situacao === p.situacao)
      .filter((a) => !termo || normalizar(`${a.mlb} ${a.sku ?? ''} ${a.titulo}`).includes(termo))
      .sort((a, b) => prioridade(a.situacao) - prioridade(b.situacao) || normalizar(a.titulo).localeCompare(normalizar(b.titulo)));
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
    e.varredura = false;
    return { status: 'iniciada' };
  },

  corrigirTipo(): { status: string } {
    const e = st();
    if (e.verificacaoIniciadaEm) return { status: 'em_execucao' };
    e.verificacaoIniciadaEm = Date.now();
    e.varredura = true;
    return { status: 'iniciada' };
  },
};

/** Só para os testes: conclui na hora o que roda em segundo plano. */
export function demoMarketplaceAdiantar(ms: number) {
  const e = st();
  if (e.coletaIniciadaEm) e.coletaIniciadaEm -= ms;
  if (e.verificacaoIniciadaEm) e.verificacaoIniciadaEm -= ms;
  for (const [sku, fim] of e.envios) e.envios.set(sku, fim - ms);
  for (const t of e.trocas) if (t.verificar_em) t.verificar_em = new Date(Date.parse(t.verificar_em) - ms).toISOString();
  avancarTempo(e);
}
