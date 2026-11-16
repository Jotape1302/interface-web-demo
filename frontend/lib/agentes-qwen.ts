// Aba "Agentes Qwen": contrato de GET /api/agentes-qwen (backend/gateway/src/agentes-qwen.ts),
// textos da tela e dados do modo demo. O estado vem do orquestrador no PC do TI, repassado pelo
// coletor da VPS a cada minuto; PC desligado = a tela mostra o último estado e há quanto tempo.

export type AgentesQwenGrupo = 'em_andamento' | 'pr_pendente' | 'aguardando_deploy' | 'monitorando' | 'precisa_ti' | 'resolvido';

export interface AgentesQwenAcompanhamentoRota {
  modo: 'rota';
  rota: string;
  alvo: number;
  acompanhadas: number;
  sucessos: number;
}

export interface AgentesQwenIncidente {
  id: number;
  servico: string | null;
  evento: string | null;
  rota: string | null;
  mensagem: string | null;
  estado: string;
  grupo: AgentesQwenGrupo;
  volta: number;
  ocorrencias: number;
  primeiroEm: string | null;
  ultimoEm: string | null;
  atualizadoEm: string | null;
  diagnostico: string | null;
  nota: string | null;
  pr: {
    url: string;
    numero: number | null;
    aprovadoPor: string | null;
    aprovadoEm: string | null;
    mergeadoEm: string | null;
    mergeSha: string | null;
  } | null;
  deployEm: string | null;
  deploy: string[];
  acompanhamento: AgentesQwenAcompanhamentoRota | { modo: 'janela'; ate: string | null } | null;
  historico: { evento: string; volta: number; detalhe: string | null; em: string }[];
}

export interface AgentesQwenResposta {
  estado: { geradoEm: string; commitProducao: string | null; incidentes: AgentesQwenIncidente[] } | null;
  recebidoEm: string | null;
  /** Incidentes marcados como resolvidos no painel e ainda não confirmados pelo PC. */
  resolucoesPendentes: number[];
}

/** Ordem dos blocos na tela: o que pede ação do TI primeiro. */
export const GRUPOS: readonly { id: AgentesQwenGrupo; titulo: string; vazio: string }[] = [
  { id: 'precisa_ti', titulo: 'Precisa de você', vazio: 'Nenhum loop parado esperando correção manual.' },
  { id: 'pr_pendente', titulo: 'PRs aguardando aprovação', vazio: 'Nenhum PR pendente.' },
  { id: 'aguardando_deploy', titulo: 'Aprovados, aguardando deploy', vazio: 'Nada para subir na VPS.' },
  { id: 'monitorando', titulo: 'Acompanhando as próximas execuções', vazio: 'Nenhuma correção em acompanhamento.' },
  { id: 'em_andamento', titulo: 'Em análise pelos agentes', vazio: 'Nenhum incidente na fila.' },
  { id: 'resolvido', titulo: 'Resolvidos', vazio: 'Nenhuma correção confirmada ainda.' },
];

export const ESTADO_ROTULO: Readonly<Record<string, string>> = {
  novo: 'na fila',
  em_andamento: 'em análise',
  pr_aberto: 'PR aberto',
  pronto_para_pr: 'pronto para PR',
  aguardando_deploy: 'aguardando deploy',
  monitorando: 'monitorando',
  aguardando_ti: 'aguardando o TI',
  escalado: 'escalado',
  pr_fechado: 'PR fechado',
  resolvido: 'resolvido',
  relatorio_pronto: 'relatório pronto',
};

export const EVENTO_ROTULO: Readonly<Record<string, string>> = {
  edicao_nao_aplicou: 'edição não aplicou',
  testes_passaram: 'testes passaram',
  testes_falharam: 'testes falharam',
  qualidade_aprovou: 'qualidade aprovou',
  qualidade_reprovou: 'qualidade reprovou',
  volta_reprovada: 'volta reprovada',
  pr_aberto: 'PR aberto',
  ti_aprovou: 'TI aprovou (rótulo)',
  pr_mergeado: 'PR mergeado',
  pr_fechado: 'PR fechado',
  confirmado_em_producao: 'confirmado em produção',
  falhou_no_acompanhamento: 'falhou no acompanhamento',
  reapareceu: 'erro reapareceu',
  escalado: 'escalado',
  ti_resolveu: 'TI resolveu',
  ti_reprocessou: 'TI reprocessou',
  sem_arquivo_editavel: 'sem arquivo de código para corrigir',
  falha_de_infra: 'falha de infraestrutura',
};

/** "3/5 execuções acompanhadas com 3/5 sucessos" (ou a janela, para erro sem rota). */
export function textoAcompanhamento(inc: Pick<AgentesQwenIncidente, 'acompanhamento'>, formatarData: (v: string) => string): string | null {
  const ac = inc.acompanhamento;
  if (!ac) return null;
  if (ac.modo === 'rota') return `${ac.acompanhadas}/${ac.alvo} execuções acompanhadas com ${ac.sucessos}/${ac.alvo} sucessos`;
  return ac.ate ? `sem a rota contada: confirma se o erro não voltar até ${formatarData(ac.ate)}` : 'sem a rota contada: aguardando a janela sem o erro';
}

/** Incidentes por bloco da tela, na ordem de GRUPOS, do mais recente para o mais antigo. */
export function agruparIncidentes(incidentes: readonly AgentesQwenIncidente[]): Record<AgentesQwenGrupo, AgentesQwenIncidente[]> {
  const saida = Object.fromEntries(GRUPOS.map((g) => [g.id, [] as AgentesQwenIncidente[]])) as Record<AgentesQwenGrupo, AgentesQwenIncidente[]>;
  for (const inc of incidentes) (saida[inc.grupo] ?? saida.em_andamento).push(inc);
  for (const lista of Object.values(saida)) lista.sort((a, b) => (b.atualizadoEm ?? '').localeCompare(a.atualizadoEm ?? ''));
  return saida;
}

/** O coletor repassa a cada minuto: mais de 10 min sem estado novo = PC, túnel ou coletor fora. */
export const DESATUALIZADO_MS = 10 * 60_000;
export const desatualizado = (recebidoEm: string | null, agora: number): boolean =>
  !recebidoEm || agora - Date.parse(recebidoEm) > DESATUALIZADO_MS;

export function makeDemoAgentesQwen(agora = new Date()): AgentesQwenResposta {
  const h = (horas: number) => new Date(agora.getTime() - horas * 3600_000).toISOString();
  const base = {
    servico: 'gateway',
    evento: 'request_error',
    volta: 1,
    ocorrencias: 3,
    primeiroEm: h(30),
    ultimoEm: h(26),
    nota: null,
    pr: null,
    deployEm: null,
    deploy: [],
    acompanhamento: null,
    historico: [],
  };
  return {
    resolucoesPendentes: [],
    recebidoEm: h(0.01),
    estado: {
      geradoEm: h(0.01),
      commitProducao: 'a307923',
      incidentes: [
        {
          ...base,
          id: 12,
          rota: 'POST /api/danfe/confirm-lancamento',
          mensagem: 'TypeError: Cannot read properties of undefined (reading "categoria_id")',
          estado: 'pr_aberto',
          grupo: 'pr_pendente',
          atualizadoEm: h(1),
          diagnostico: 'Item sem categoria chega sem o campo e a validação lê direto.',
          pr: { url: 'https://github.com/exemplo/interface-web/pull/58', numero: 58, aprovadoPor: null, aprovadoEm: null, mergeadoEm: null, mergeSha: null },
          historico: [
            { evento: 'testes_passaram', volta: 1, detalhe: 'test:gateway, tsc', em: h(1.2) },
            { evento: 'qualidade_aprovou', volta: 1, detalhe: null, em: h(1.1) },
            { evento: 'pr_aberto', volta: 1, detalhe: 'https://github.com/exemplo/interface-web/pull/58', em: h(1) },
          ],
        },
        {
          ...base,
          id: 11,
          servico: 'automacoes-marketplace',
          evento: 'ERROR',
          rota: 'rotina FRETES',
          mensagem: 'KeyError: shipping',
          estado: 'monitorando',
          grupo: 'monitorando',
          volta: 2,
          atualizadoEm: h(5),
          diagnostico: 'Anúncio sem shipping no multiget.',
          pr: { url: 'https://github.com/exemplo/interface-web/pull/57', numero: 57, aprovadoPor: 'TI', aprovadoEm: h(8), mergeadoEm: h(8), mergeSha: 'c0ffee1' },
          deployEm: h(5),
          acompanhamento: { modo: 'rota', rota: 'rotina FRETES', alvo: 5, acompanhadas: 3, sucessos: 3 },
        },
        {
          ...base,
          id: 9,
          rota: null,
          mensagem: '[ReconciliationHistory] Falha ao gravar baixa',
          estado: 'escalado',
          grupo: 'precisa_ti',
          volta: 3,
          atualizadoEm: h(20),
          diagnostico: 'Conexão com o MariaDB recusada durante a gravação.',
          nota: 'passou de 3 voltas sem a qualidade aprovar',
        },
        {
          ...base,
          id: 7,
          rota: 'GET /api/financial-dashboard',
          mensagem: 'RangeError: Invalid time value',
          estado: 'resolvido',
          grupo: 'resolvido',
          atualizadoEm: h(40),
          diagnostico: 'Data vazia do Tiny convertida sem checar.',
          nota: 'Confirmado pelo monitor: 5 execuções ok de GET /api/financial-dashboard depois do deploy, sem o erro voltar.',
          pr: { url: 'https://github.com/exemplo/interface-web/pull/55', numero: 55, aprovadoPor: 'TI', aprovadoEm: h(50), mergeadoEm: h(50), mergeSha: 'beef123' },
          deployEm: h(48),
          acompanhamento: { modo: 'rota', rota: 'GET /api/financial-dashboard', alvo: 5, acompanhadas: 5, sucessos: 5 },
        },
      ],
    },
  };
}
