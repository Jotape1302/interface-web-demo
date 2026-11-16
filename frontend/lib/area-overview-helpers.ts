import type { AcaoPendente, VisaoGeralArea } from './area-overview-contracts';

export interface ResumoVisaoGeral {
  totalAcoes: number;
  criticas: number;
  automacoesComProblema: number;
  servicosConectados: number;
  servicosTotal: number;
}

export function resumirVisaoGeral(v: VisaoGeralArea): ResumoVisaoGeral {
  return {
    totalAcoes: v.acoesPendentes.length,
    criticas: v.acoesPendentes.filter((a) => a.severidade === 'critica').length,
    automacoesComProblema: v.automacoes.filter((a) => a.status === 'atencao' || a.status === 'erro').length,
    servicosConectados: v.servicos.filter((s) => s.conectado).length,
    servicosTotal: v.servicos.length,
  };
}

export const ROTULO_SEVERIDADE: Readonly<Record<AcaoPendente['severidade'], string>> = {
  critica: 'Crítica',
  atencao: 'Atenção',
  info: 'Informativa',
};

export const ROTULO_STATUS: Readonly<Record<string, string>> = {
  ok: 'Em dia',
  atencao: 'Atenção',
  erro: 'Com erro',
  sem_dados: 'Sem dados',
};

// Descrição do card quando o gateway não manda indicadores; chave = href da automação.
export const DESCRICAO_POR_HREF: Readonly<Record<string, string>> = {
  '/contagem-estoque': 'Conta os pacotes de uma prateleira pela foto, pelo bot do Telegram (em calibração).',
  '/padronizacao-dimensoes':
    'Pega no Tiny as medidas e o peso bruto do SKU de cada anúncio; você confirma e elas vão para o Mercado Livre.',
  '/fretes-a-combinar':
    'Define o tipo de envio pela embalagem (1 m/2 m ME2, 3 m ME1), tira do frete a combinar e confere 10 minutos depois.',
  '/producao':
    'Instalador para o PC do encarregado com a Elgin L42-DT na USB; o tablet manda a etiqueta direto para ele.',
};
