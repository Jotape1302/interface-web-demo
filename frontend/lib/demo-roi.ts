// Fixture do modo demo da aba "ROI das automações". Espelha ROI_TAREFAS do gateway
// (backend/gateway/src/roi.ts); a conta é a mesma: (manual − atual) × itens ÷ 60 × R$ 11/h.
import { getSaoPauloParts } from './date-range-utils';
import type { RoiAutomacao, RoiPeriodoAplicado, RoiResponse } from './roi-contracts';

export const VALOR_HORA_REAIS = 11;

type Tarefa = Omit<RoiAutomacao, 'itens' | 'horasEconomizadas' | 'reais' | 'fonte' | 'observacao'>;

const TAREFAS: readonly (Tarefa & { itens: number; observacao: string | null })[] = [
  { id: 'accounts-payable', titulo: 'Contas a Pagar (Inter × Tiny)', unidade: 'baixa com sucesso', minutosManual: 5, minutosAtual: 0.5, tarefaManual: 'Conferir o pagamento no Inter, localizar a conta no Tiny e dar a baixa à mão.', tarefaAtual: 'Revisar a prévia e confirmar o lote.', itens: 1092, observacao: null },
  { id: 'danfe-tiny', titulo: 'NF-e / DANFE', unidade: 'nota lançada com sucesso', minutosManual: 3, minutosAtual: 1, tarefaManual: 'Abrir a nota, digitar os dados e lançar a conta a pagar no Tiny.', tarefaAtual: 'Revisar a nota e confirmar o lançamento.', itens: 318, observacao: null },
  { id: 'conciliacao-ml', titulo: 'Conciliação Mercado Livre', unidade: 'recebimento baixado com sucesso', minutosManual: 3, minutosAtual: 0.5, tarefaManual: 'Cruzar a venda do ML com a liberação do Mercado Pago e baixar o recebimento no Tiny.', tarefaAtual: 'Conferir a análise e confirmar a baixa.', itens: 640, observacao: null },
  { id: 'dimensoes', titulo: 'Padronização de dimensões', unidade: 'produto com medidas enviadas ao ML', minutosManual: 1, minutosAtual: 1 / 60, tarefaManual: 'Buscar no Tiny as medidas e o peso bruto do produto e corrigir a ficha e a embalagem do anúncio no Mercado Livre.', tarefaAtual: 'Confirmar no painel o envio das medidas do Tiny.', itens: 210, observacao: null },
  { id: 'fretes', titulo: 'Tipo de frete', unidade: 'anúncio trocado com sucesso', minutosManual: 1, minutosAtual: 0, tarefaManual: 'Achar o anúncio com frete a combinar ou com o tipo errado e trocar o tipo de envio no Mercado Livre.', tarefaAtual: 'Acompanhar e retentar falhas.', itens: 480, observacao: 'Histórico limitado às últimas 2.000 trocas.' },
  { id: 'contagem-estoque', titulo: 'Contagem de estoque', unidade: 'contagem lançada no Tiny', minutosManual: 4, minutosAtual: 1, tarefaManual: 'Contar, anotar e lançar a entrada de estoque no Tiny.', tarefaAtual: 'Fotografar e conferir no painel.', itens: 95, observacao: null },
  { id: 'etiquetas', titulo: 'Etiquetas de produção', unidade: 'OP (estimativa)', minutosManual: 5, minutosAtual: 0, tarefaManual: 'O encarregado montava e imprimia à mão as etiquetas de cada OP.', tarefaAtual: 'As etiquetas saem direto do tablet da Produção.', itens: 65, observacao: 'Estimativa: 5 OPs por dia útil (segunda a sexta) desde 09/10/2026. O servidor não vê as impressões.' },
];

const INICIO_DEMO = '2026-01-01';
const dia = (v: string) => Date.parse(`${v}T00:00:00Z`) / 86400000;

/** Proporção (0..1) do histórico demo (INICIO_DEMO até hoje) que cai dentro do período. */
export function proporcaoDemo(periodo: Partial<RoiPeriodoAplicado> | undefined, now = new Date()): number {
  const sp = getSaoPauloParts(now);
  const hoje = dia(`${sp.year}-${String(sp.month).padStart(2, '0')}-${String(sp.day).padStart(2, '0')}`);
  const inicio = dia(INICIO_DEMO);
  const de = Math.max(inicio, periodo?.de ? dia(periodo.de) : inicio);
  const ate = Math.min(hoje, periodo?.ate ? dia(periodo.ate) : hoje);
  return ate < de ? 0 : (ate - de + 1) / (hoje - inicio + 1);
}

export function makeDemoRoi(now = new Date(), periodo?: Partial<RoiPeriodoAplicado>): RoiResponse {
  const proporcao = proporcaoDemo(periodo, now);
  const automacoes: RoiAutomacao[] = TAREFAS.map(({ itens: itensTotais, observacao, ...t }) => {
    const itens = Math.round(itensTotais * proporcao);
    const horas = (itens * (t.minutosManual - t.minutosAtual)) / 60;
    return { ...t, itens, horasEconomizadas: horas, reais: Math.round(horas * VALOR_HORA_REAIS * 100) / 100, fonte: { status: 'ok' }, observacao };
  });
  return {
    mode: 'demo',
    generatedAt: now.toISOString(),
    periodo: { de: periodo?.de ?? null, ate: periodo?.ate ?? null },
    valorHora: VALOR_HORA_REAIS,
    automacoes,
    totais: {
      horasEconomizadas: automacoes.reduce((s, a) => s + (a.horasEconomizadas ?? 0), 0),
      reais: Math.round(automacoes.reduce((s, a) => s + (a.reais ?? 0), 0) * 100) / 100,
      parcial: false,
    },
    naoMedidas: [],
  };
}
