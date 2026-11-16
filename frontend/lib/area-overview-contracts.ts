// Espelha o contrato de GET /api/areas/{area}/visao-geral do gateway.
import type { AreaComVisaoGeral } from './areas';

export type Severidade = 'critica' | 'atencao' | 'info';
export type StatusAutomacao = 'ok' | 'atencao' | 'erro' | 'sem_dados';

export interface AcaoPendente {
  id: string;
  automacao: string;
  titulo: string;
  descricao: string;
  quantidade: number | null;
  severidade: Severidade;
  href: string;
  acao: string;
  desde: string | null;
}

export interface AutomacaoResumo {
  id: string;
  titulo: string;
  href: string;
  status: StatusAutomacao;
  ultimaExecucao: string | null;
  indicadores: { rotulo: string; valor: string }[];
}

export interface ServicoStatus {
  id: string;
  nome: string;
  conectado: boolean;
  mensagem: string;
}

export interface VisaoGeralArea {
  area: AreaComVisaoGeral;
  geradoEm: string;
  acoesPendentes: AcaoPendente[];
  automacoes: AutomacaoResumo[];
  servicos: ServicoStatus[];
  indisponiveis: { fonte: string; mensagem: string }[];
}
