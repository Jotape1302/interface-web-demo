import type { AreaComVisaoGeral } from './areas';
import type { VisaoGeralArea } from './area-overview-contracts';

// Fixtures determinísticas da Visão geral por área (modo demo). Só `geradoEm` varia.
function dia(geradoEm: string, horasAtras: number): string {
  return new Date(new Date(geradoEm).getTime() - horasAtras * 3_600_000).toISOString();
}

export function makeDemoVisaoGeral(area: AreaComVisaoGeral, geradoEm: string): VisaoGeralArea {
  const base = { area, geradoEm, indisponiveis: [] };
  switch (area) {
    case 'financeiro':
      return {
        ...base,
        acoesPendentes: [
          { id: 'danfe-falhas', automacao: 'NF-e & DANFE', titulo: 'Notas com falha no lançamento', descricao: 'O Tiny recusou o lançamento; revise e reenvie.', quantidade: 2, severidade: 'critica', href: '/danfe-tiny', acao: 'Revisar falhas', desde: dia(geradoEm, 30) },
          { id: 'danfe-categorizar', automacao: 'NF-e & DANFE', titulo: 'NF-e aguardando categorização', descricao: 'Notas lidas que precisam de categoria antes de ir ao Tiny.', quantidade: 7, severidade: 'atencao', href: '/danfe-tiny', acao: 'Categorizar notas', desde: dia(geradoEm, 52) },
          { id: 'ml-baixas', automacao: 'Conciliação Mercado Livre', titulo: 'Baixas aguardando confirmação', descricao: 'Vendas conciliadas prontas para baixar no Tiny.', quantidade: 14, severidade: 'atencao', href: '/conciliacao-mercado-livre', acao: 'Conferir baixas', desde: dia(geradoEm, 8) },
          { id: 'cp-vencendo', automacao: 'Contas a Pagar', titulo: 'Boletos vencendo hoje', descricao: 'Títulos com vencimento na data de hoje.', quantidade: 3, severidade: 'info', href: '/contas-a-pagar', acao: 'Abrir contas', desde: null },
        ],
        automacoes: [
          { id: 'accounts-payable', titulo: 'Contas a Pagar', href: '/contas-a-pagar', status: 'ok', ultimaExecucao: dia(geradoEm, 2), indicadores: [{ rotulo: 'Pagos no mês', valor: '128' }, { rotulo: 'A vencer', valor: '9' }] },
          { id: 'ml-reconciliation', titulo: 'Conciliação Mercado Livre', href: '/conciliacao-mercado-livre', status: 'atencao', ultimaExecucao: dia(geradoEm, 5), indicadores: [{ rotulo: 'Pendentes', valor: '14' }] },
          { id: 'danfe-tiny', titulo: 'NF-e & DANFE (Tiny ERP)', href: '/danfe-tiny', status: 'erro', ultimaExecucao: dia(geradoEm, 1), indicadores: [{ rotulo: 'Para revisar', valor: '7' }, { rotulo: 'Com falha', valor: '2' }] },
          { id: 'financial-dashboard', titulo: 'Dashboard Financeiro', href: '/dashboard-financeiro', status: 'ok', ultimaExecucao: dia(geradoEm, 3), indicadores: [] },
        ],
        servicos: [
          { id: 'mariadb', nome: 'MariaDB', conectado: true, mensagem: 'Conectado' },
          { id: 'n8n', nome: 'n8n', conectado: true, mensagem: 'Conectado' },
          { id: 'tiny', nome: 'Tiny ERP', conectado: true, mensagem: 'Conectado' },
          { id: 'inter', nome: 'Banco Inter', conectado: false, mensagem: 'Certificado expira em breve' },
        ],
      };
    case 'logistica':
      return {
        ...base,
        acoesPendentes: [
          { id: 'estoque-divergencias', automacao: 'Contagem de Estoque', titulo: 'Contagens com divergência', descricao: 'Itens contados que diferem do saldo do Tiny.', quantidade: 4, severidade: 'atencao', href: '/contagem-estoque', acao: 'Ver divergências', desde: dia(geradoEm, 20) },
        ],
        automacoes: [
          { id: 'stock-count', titulo: 'Contagem de Estoque', href: '/contagem-estoque', status: 'atencao', ultimaExecucao: dia(geradoEm, 6), indicadores: [{ rotulo: 'Contagens na semana', valor: '23' }, { rotulo: 'Divergências', valor: '4' }] },
        ],
        servicos: [
          { id: 'mariadb', nome: 'MariaDB', conectado: true, mensagem: 'Conectado' },
          { id: 'tiny', nome: 'Tiny ERP', conectado: true, mensagem: 'Conectado' },
          { id: 'telegram', nome: 'Bot do Telegram', conectado: true, mensagem: 'Conectado' },
        ],
      };
    case 'marketplace':
      return {
        ...base,
        acoesPendentes: [
          { id: 'dim-confirmar', automacao: 'Padronização de Dimensões', titulo: 'Anúncios aguardando confirmação', descricao: 'Medidas do Tiny prontas para conferir e enviar ao Mercado Livre.', quantidade: 18, severidade: 'atencao', href: '/padronizacao-dimensoes', acao: 'Confirmar medidas', desde: dia(geradoEm, 14) },
          { id: 'frete-errado', automacao: 'Frete a Combinar', titulo: 'Anúncios com tipo de envio errado', descricao: 'A conferência encontrou envio diferente do esperado pela embalagem.', quantidade: 3, severidade: 'critica', href: '/fretes-a-combinar', acao: 'Corrigir envio', desde: dia(geradoEm, 3) },
        ],
        automacoes: [
          { id: 'dimension-standardization', titulo: 'Padronização de Dimensões', href: '/padronizacao-dimensoes', status: 'atencao', ultimaExecucao: dia(geradoEm, 10), indicadores: [{ rotulo: 'Pendentes', valor: '18' }] },
          { id: 'shipping-review', titulo: 'Frete a Combinar', href: '/fretes-a-combinar', status: 'erro', ultimaExecucao: dia(geradoEm, 4), indicadores: [{ rotulo: 'Tipo errado', valor: '3' }] },
        ],
        servicos: [
          { id: 'mariadb', nome: 'MariaDB', conectado: true, mensagem: 'Conectado' },
          { id: 'tiny', nome: 'Tiny ERP', conectado: true, mensagem: 'Conectado' },
          { id: 'mercado-livre', nome: 'Mercado Livre', conectado: true, mensagem: 'Conectado' },
        ],
      };
    case 'producao':
      return {
        ...base,
        acoesPendentes: [],
        automacoes: [
          { id: 'etiquetas', titulo: 'Impressão de etiquetas', href: '/producao', status: 'sem_dados', ultimaExecucao: null, indicadores: [] },
        ],
        servicos: [{ id: 'mariadb', nome: 'MariaDB', conectado: true, mensagem: 'Conectado' }],
      };
  }
}
