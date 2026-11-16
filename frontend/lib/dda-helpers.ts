import type { DdaBoleto, DdaCategoria, DdaSituacao, DdaSugestaoCategoria } from './dda-contracts';

type Tom = 'success' | 'warning' | 'danger' | 'info' | 'secondary';

/** Rótulo, cor e descrição de cada situação do boleto na automação. */
export const DDA_SITUACAO_META: Record<DdaSituacao, { label: string; tom: Tom; ajuda: string }> = {
  NOVO: { label: 'Novo', tom: 'info', ajuda: 'Chegou da Polp; a próxima rodada procura a conta no Tiny.' },
  SEM_CONTA: { label: 'Sem conta no Tiny', tom: 'warning', ajuda: 'Nenhuma conta em aberto com o mesmo fornecedor, vencimento e valor: crie a conta ou descarte.' },
  AMBIGUO: { label: 'Escolher conta', tom: 'warning', ajuda: 'Mais de uma conta igual no Tiny: escolha qual é a deste boleto.' },
  CASADO: { label: 'Validado', tom: 'info', ajuda: 'Conta conferida; a próxima rodada agenda o pagamento no Inter.' },
  VENCIDO_SEM_AGENDAR: { label: 'Vencido', tom: 'danger', ajuda: 'Venceu antes de ser agendado: pague à mão (com juros/multa) ou descarte.' },
  AGENDADO: { label: 'Aguardando aprovação', tom: 'info', ajuda: 'Agendado no Inter: o gerente aprova ou recusa no Internet Banking.' },
  PAGO: { label: 'Pago, baixa pendente', tom: 'warning', ajuda: 'O Inter pagou; a baixa no Tiny falhou e será tentada de novo.' },
  BAIXADO: { label: 'Baixado', tom: 'success', ajuda: 'Pago no Inter e baixado no Tiny.' },
  RECUSADO: { label: 'Recusado', tom: 'danger', ajuda: 'Pagamento recusado ou cancelado no Inter: reabra para agendar de novo ou descarte.' },
  ENCERRADO: { label: 'Resolvido fora', tom: 'secondary', ajuda: 'Pago, cancelado ou baixado fora da automação.' },
  DESCARTADO: { label: 'Descartado', tom: 'secondary', ajuda: 'Descartado no painel.' },
  ERRO: { label: 'Erro', tom: 'danger', ajuda: 'A automação não conseguiu seguir: veja a mensagem e reabra.' },
};

/** Situações que pedem alguém no painel. */
export const DDA_PEDE_ACAO: ReadonlySet<DdaSituacao> = new Set(['SEM_CONTA', 'AMBIGUO', 'VENCIDO_SEM_AGENDAR', 'RECUSADO', 'ERRO']);
const FINAIS: ReadonlySet<DdaSituacao> = new Set(['BAIXADO', 'ENCERRADO', 'DESCARTADO']);

/** Casado pela automação e ainda sem a conferência humana: não vai para o Inter até validar. */
export function aguardandoValidacao(b: DdaBoleto): boolean {
  return b.situacao === 'CASADO' && !b.validacao;
}

/** Rótulo/cor da situação, separando o casado à espera de conferência do já validado. */
export function situacaoMeta(b: DdaBoleto): { label: string; tom: Tom; ajuda: string } {
  if (aguardandoValidacao(b)) {
    return { label: 'Conferir conta', tom: 'warning', ajuda: 'Casado com a conta do Tiny: confira e valide para liberar o agendamento no Inter.' };
  }
  return DDA_SITUACAO_META[b.situacao] ?? { label: b.situacao, tom: 'secondary', ajuda: '' };
}

/** Histórico sugerido para a conta criada a partir do boleto. */
export function historicoPadrao(b: DdaBoleto): string {
  return `Boleto DDA - ${b.beneficiario_nome}${b.documento ? ` - doc. ${b.documento}` : ''}`.slice(0, 500);
}

export type DdaFiltro = 'acao' | 'andamento' | 'finalizados' | 'todos';

export function boletoNoFiltro(b: DdaBoleto, filtro: DdaFiltro): boolean {
  if (filtro === 'todos') return true;
  if (filtro === 'acao') return DDA_PEDE_ACAO.has(b.situacao) || Boolean(b.fraude) || aguardandoValidacao(b);
  if (filtro === 'finalizados') return FINAIS.has(b.situacao);
  return !FINAIS.has(b.situacao) && !boletoNoFiltro(b, 'acao');
}

export function contarPorFiltro(boletos: DdaBoleto[]): Record<DdaFiltro, number> {
  const out: Record<DdaFiltro, number> = { acao: 0, andamento: 0, finalizados: 0, todos: boletos.length };
  for (const b of boletos) {
    if (boletoNoFiltro(b, 'acao')) out.acao += 1;
    else if (boletoNoFiltro(b, 'finalizados')) out.finalizados += 1;
    else out.andamento += 1;
  }
  return out;
}

/** "2026-11-20" → "20/11/2026" (data pura, sem fuso: o vencimento não pode mudar de dia). */
export function dataBR(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

/** CNPJ (14 dígitos) ou CPF (11) com máscara; outro formato volta como veio. */
export function documentoFormatado(doc: string | null | undefined): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc ?? '';
}

/** O que o painel deixa fazer em cada situação (o motor recusa o resto com 409). */
export function acoesDoBoleto(b: DdaBoleto): { escolher: boolean; criar: boolean; descartar: boolean; reabrir: boolean } {
  return {
    escolher: b.situacao === 'AMBIGUO' || b.situacao === 'SEM_CONTA',
    criar: b.situacao === 'SEM_CONTA' && !b.conta_criada_incerta,
    descartar: !FINAIS.has(b.situacao) && b.situacao !== 'AGENDADO' && b.situacao !== 'PAGO',
    reabrir: ['RECUSADO', 'ERRO', 'DESCARTADO', 'VENCIDO_SEM_AGENDAR'].includes(b.situacao),
  };
}

/** Texto curto das aprovações do Inter ("1 de 2 aprovações"), quando o Inter informou. */
export function aprovacoesTexto(b: DdaBoleto): string | null {
  const nec = b.inter?.aprovacoes_necessarias;
  if (!nec) return null;
  const feitas = b.inter?.aprovacoes_realizadas ?? 0;
  return `${feitas} de ${nec} ${nec === 1 ? 'aprovação' : 'aprovações'}`;
}

/** Categoria sugerida do boleto, se ela existe no catálogo da empresa (senão o select fica vazio). */
export function categoriaSugerida(b: DdaBoleto, categorias: DdaCategoria[] | null | undefined): string {
  const id = b.sugestao_categoria?.categoria_id;
  if (!id || !categorias) return '';
  return categorias.some((c) => c.id === id) ? id : '';
}

/** De onde veio a categoria pré-selecionada (linha abaixo do select). */
export function textoSugestaoCategoria(s: DdaSugestaoCategoria): { icone: 'historico' | 'qwen'; texto: string } {
  if (s.origem === 'qwen') {
    const conf = s.confianca === 'alta' ? 'alta' : s.confianca === 'media' ? 'média' : 'baixa';
    return { icone: 'qwen', texto: `Sugerida pelo Qwen (confiança ${conf})${s.motivo ? `: ${s.motivo}` : ''}` };
  }
  if (s.nivel === 'painel') return { icone: 'historico', texto: 'Última categoria escolhida no painel para este fornecedor.' };
  const vezes = s.distribuicao?.find((d) => d.categoria_id === s.categoria_id)?.vezes ?? 0;
  const total = s.vezes_tiny ?? vezes;
  if (s.nivel === 'tiny') return { icone: 'historico', texto: `Histórico do Tiny: ${vezes} de ${total} lançamento(s) deste fornecedor nesta categoria.` };
  return { icone: 'historico', texto: `Histórico dividido no Tiny (${vezes} de ${total} lançamentos nesta categoria): confira.` };
}
