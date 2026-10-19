// Log de auditoria das ações dos usuários — espelho de AUDIT_ACTIONS do gateway
// (backend/gateway/src/audit.ts). Uma ação nova lá precisa do rótulo aqui.

export interface AuditEntry {
  id: string;
  usuarioId: number | null;
  usuarioNome: string;
  acao: string;
  alvo?: string;
  detalhes?: Record<string, unknown>;
  sucesso: boolean;
  ip?: string;
  criadoEm: string;
}

export type AuditGroup = 'Acesso' | 'Usuários' | 'NF-e' | 'Automações' | 'Incidentes';

export const AUDIT_ACTION_LABELS: Readonly<Record<string, { label: string; group: AuditGroup }>> = {
  login: { label: 'Entrou na plataforma', group: 'Acesso' },
  login_falhou: { label: 'Tentativa de login recusada', group: 'Acesso' },
  logout: { label: 'Saiu da plataforma', group: 'Acesso' },
  senha_alterada: { label: 'Trocou a própria senha', group: 'Acesso' },
  alteracao_cadastro_solicitada: { label: 'Pediu alteração de cadastro', group: 'Acesso' },
  usuario_criado: { label: 'Criou usuário', group: 'Usuários' },
  usuario_aprovado: { label: 'Aprovou cadastro', group: 'Usuários' },
  usuario_rejeitado: { label: 'Recusou cadastro', group: 'Usuários' },
  usuario_excluido: { label: 'Excluiu usuário', group: 'Usuários' },
  permissoes_alteradas: { label: 'Alterou permissões', group: 'Usuários' },
  perfil_alterado: { label: 'Alterou perfil (Admin/Gestor/User)', group: 'Usuários' },
  setor_alterado: { label: 'Alterou setor', group: 'Usuários' },
  sessao_encerrada: { label: 'Encerrou uma sessão', group: 'Usuários' },
  sessoes_usuario_encerradas: { label: 'Encerrou todas as sessões do usuário', group: 'Usuários' },
  alteracao_cadastro_aprovada: { label: 'Aprovou alteração de cadastro', group: 'Usuários' },
  alteracao_cadastro_rejeitada: { label: 'Recusou alteração de cadastro', group: 'Usuários' },
  workflow_token_disparado: { label: 'Disparou renovação de tokens (n8n)', group: 'Automações' },
  dashboard_financeiro_sincronizado: { label: 'Sincronizou o Dashboard Financeiro', group: 'Automações' },
  incidente_reportado: { label: 'Reportou incidente', group: 'Incidentes' },
  incidente_resolvido: { label: 'Resolveu incidente', group: 'Incidentes' },
  nfe_varredura_sefaz: { label: 'Disparou varredura na SEFAZ', group: 'NF-e' },
  nfe_lote_enviado: { label: 'Enviou lote de DANFEs', group: 'NF-e' },
  nfe_lancada: { label: 'Lançou NF-e no Tiny', group: 'NF-e' },
  nfe_arquivada: { label: 'Arquivou NF-e', group: 'NF-e' },
  nfe_restaurada: { label: 'Restaurou NF-e', group: 'NF-e' },
  nfe_falha_resolvida: { label: 'Marcou falha de NF-e como resolvida', group: 'NF-e' },
  nfe_importada_chave: { label: 'Importou NF-e por chave de acesso (SEFAZ)', group: 'NF-e' },
  baixa_conciliacao_executada: { label: 'Baixou contas a pagar conciliadas (Inter × Tiny)', group: 'Automações' },
  conciliacao_ml_executada: { label: 'Executou a conciliação Mercado Livre manualmente', group: 'Automações' },
  baixa_conciliacao_ml_executada: { label: 'Baixou contas a receber conciliadas (Mercado Livre × Tiny)', group: 'Automações' },
  sincronizacao_tokens_ml_solicitada: { label: 'Sincronizou tokens das contas do Mercado Livre', group: 'Automações' },
  fretes_medidas_enviadas: { label: 'Enviou medidas de anúncio ao Mercado Livre', group: 'Automações' },
  fretes_medidas_salvas: { label: 'Salvou medidas de anúncio (Fretes a combinar)', group: 'Automações' },
  fretes_verificacao_manual: { label: 'Rodou a verificação de fretes', group: 'Automações' },
  fretes_nova_tentativa: { label: 'Tentou de novo fretes que o Mercado Livre desfez', group: 'Automações' },
  dimensoes_validadas: { label: 'Validou dimensões de produtos (padronização)', group: 'Automações' },
  dimensoes_reenviadas: { label: 'Reenviou dimensões padronizadas às plataformas', group: 'Automações' },
  dimensoes_coleta_manual: { label: 'Rodou a coleta de dimensões', group: 'Automações' },
  etiquetas_geradas: { label: 'Gerou etiquetas de produto para a Zebra', group: 'Automações' },
  contagem_estoque_sku_informado: { label: 'Informou o SKU de uma contagem de estoque', group: 'Automações' },
  contagem_estoque_excluida: { label: 'Excluiu uma contagem de estoque da tela', group: 'Automações' },
  contagem_estoque_conferida: { label: 'Conferiu uma contagem de estoque', group: 'Automações' },
  contagem_estoque_tiny: { label: 'Enviou uma contagem de estoque ao Tiny', group: 'Automações' },
};

export function auditActionLabel(acao: string): string {
  return AUDIT_ACTION_LABELS[acao]?.label ?? acao;
}

const DETAIL_LABELS: Readonly<Record<string, string>> = {
  setor: 'Setor',
  role: 'Perfil',
  campo: 'Campo',
  valorNovo: 'Novo valor',
  permissoes: 'Permissões',
  de: 'De',
  para: 'Para',
  antes: 'Antes',
  depois: 'Depois',
  concedidas: 'Concedidas',
  revogadas: 'Revogadas',
  versao: 'Versão',
  permissoesZeradas: 'Permissões zeradas',
  permissoesRemovidas: 'Permissões removidas',
  permissoesNaoGravadas: 'Permissões não gravadas',
  setorSugerido: 'Setor indicado',
  forcado: 'Forçado',
  workflowId: 'Workflow',
  etapa: 'Etapa',
  formaPagamento: 'Forma de pagamento',
  itens: 'Itens',
  status: 'Status',
  erro: 'Erro',
  arquivos: 'Arquivos',
  sucesso: 'Com sucesso',
  falhas: 'Com falha',
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  success: 'lançada',
  partial_error: 'lançada com erro parcial',
};

/** Detalhes em texto corrido ("Setor: Financeiro · Itens: 3") para a tabela e o CSV. */
export function formatAuditDetails(detalhes: Record<string, unknown> | undefined): string {
  if (!detalhes) return '';
  return Object.entries(detalhes)
    .map(([key, value]) => {
      const label = DETAIL_LABELS[key] ?? key;
      // Listas de chaves de permissão (RBAC por usuário): "contas_pagar:ver, erros:ver".
      if (Array.isArray(value)) {
        const items = value.filter((v): v is string => typeof v === 'string');
        return `${label}: ${items.length > 0 ? items.join(', ') : 'nenhuma'}`;
      }
      if (typeof value === 'boolean') return `${label}: ${value ? 'sim' : 'não'}`;
      if (value && typeof value === 'object') {
        const enabled = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v === true)
          .map(([k]) => k);
        return `${label}: ${enabled.length > 0 ? enabled.join(', ') : 'nenhuma'}`;
      }
      if (key === 'status' && typeof value === 'string') return `${label}: ${STATUS_LABELS[value] ?? value}`;
      return `${label}: ${String(value)}`;
    })
    .join(' · ');
}

export function makeDemoAuditEntries(now = Date.now()): AuditEntry[] {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  return [
    { id: '10', usuarioId: 1, usuarioNome: 'Administrador', acao: 'permissoes_alteradas', alvo: 'Fernanda Financeiro (#3)', detalhes: { concedidas: ['contas_pagar:baixar'], revogadas: [], versao: 2 }, sucesso: true, ip: '192.168.0.12', criadoEm: at(2) },
    { id: '9', usuarioId: 1, usuarioNome: 'Administrador', acao: 'usuario_aprovado', alvo: 'Carla Souza (#7)', sucesso: true, ip: '192.168.0.12', criadoEm: at(4) },
    { id: '8', usuarioId: 3, usuarioNome: 'Marina Financeiro', acao: 'nfe_lancada', alvo: 'NF-e 3526…0187', detalhes: { formaPagamento: 'boleto', itens: 3, status: 'success' }, sucesso: true, ip: '192.168.0.31', criadoEm: at(18) },
    { id: '7', usuarioId: 3, usuarioNome: 'Marina Financeiro', acao: 'nfe_arquivada', alvo: 'NF-e 3526…0442', sucesso: true, ip: '192.168.0.31', criadoEm: at(25) },
    { id: '6', usuarioId: null, usuarioNome: 'marina', acao: 'login_falhou', alvo: 'marina', sucesso: false, ip: '192.168.0.31', criadoEm: at(41) },
    { id: '5', usuarioId: 1, usuarioNome: 'Administrador', acao: 'setor_alterado', alvo: 'Bruno Lima (#5)', detalhes: { de: 'SAC', setor: 'Logística' }, sucesso: true, ip: '192.168.0.12', criadoEm: at(95) },
    { id: '4', usuarioId: 1, usuarioNome: 'Administrador', acao: 'incidente_resolvido', alvo: 'Incidente #12', sucesso: true, ip: '192.168.0.12', criadoEm: at(130) },
    { id: '3', usuarioId: 3, usuarioNome: 'Marina Financeiro', acao: 'dashboard_financeiro_sincronizado', sucesso: true, ip: '192.168.0.31', criadoEm: at(220) },
    { id: '2', usuarioId: 1, usuarioNome: 'Administrador', acao: 'usuario_excluido', alvo: 'Conta Teste (#4)', sucesso: true, ip: '192.168.0.12', criadoEm: at(600) },
    { id: '1', usuarioId: 1, usuarioNome: 'Administrador', acao: 'login', sucesso: true, ip: '192.168.0.12', criadoEm: at(610) },
  ];
}
