import type { DanfeReviewItem } from "@/lib/contracts";
import { formatCnpjMask } from "@/lib/formatters";

export function formatCurrency(val: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val);
}

/** Chave de acesso sem espaços, no mesmo formato do XML e da SEFAZ (fácil de copiar e colar). */
export function formatChave(chave: string): string {
  return chave.replace(/\s+/g, "");
}

// Formas de pagamento selecionáveis na revisão humana. Espelha app/tiny_client.py::PAYMENT_METHOD_MARCADOR
// (fonte da verdade no backend) — Pix e Boleto não usam marcador no Tiny, só mudam a regra de vencimento.
export const PAYMENT_METHOD_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "pix", label: "Pix" },
  { id: "boleto", label: "Boleto" },
  { id: "clara", label: "Cartão Clara" },
  { id: "caixa_visa", label: "Caixa Visa" },
  { id: "caixa_visa_norvia", label: "Caixa Visa Norvia" },
  { id: "caixa_elo", label: "Caixa Elo" },
  { id: "sem_marcador", label: "Sem marcador" },
];

// Nomes canônicos oficiais e empresas monitoradas
export const MONITORED_COMPANIES: Array<{ cnpj: string; nome: string }> = [
  { cnpj: "27184930000107", nome: "NORVIA ACABAMENTOS LTDA (CAMPINAS)" },
  { cnpj: "27184930000280", nome: "NORVIA ACABAMENTOS LTDA (CURITIBA)" },
  { cnpj: "43820617000166", nome: "FABRILUX ACABAMENTOS LTDA" },
  { cnpj: "36592814000100", nome: "REVESTA DECORACOES LTDA" },
];

export const COMPANY_DISPLAY_NAME_BY_CNPJ: Record<string, string> = {
  "36592814000100": "REVESTA DECORACOES LTDA",
  "43820617000166": "FABRILUX ACABAMENTOS LTDA",
  "27184930000107": "NORVIA ACABAMENTOS LTDA (CAMPINAS)",
  "27184930000280": "NORVIA ACABAMENTOS LTDA (CURITIBA)",
};

export function resolveCompanyDisplayName(cnpj: string | null | undefined, fallbackName?: string | null): string {
  if (cnpj && COMPANY_DISPLAY_NAME_BY_CNPJ[cnpj]) {
    return COMPANY_DISPLAY_NAME_BY_CNPJ[cnpj];
  }
  return fallbackName || (cnpj ? formatCnpjMask(cnpj) : "Não identificada");
}

// Pré-seleção por empresa (destinatário), só como ponto de partida — a decisão final de
// qual forma de pagamento usar é sempre do funcionário na revisão.
const DEFAULT_PAYMENT_METHOD_BY_CNPJ: Record<string, string> = {
  "36592814000100": "caixa_visa", // Revesta
  "27184930000107": "caixa_visa_norvia", // Norvia Campinas
  "27184930000280": "caixa_visa_norvia", // Norvia Curitiba
};

// Marcador gravado na nota (nome do arquivo) -> forma de pagamento da revisão. "Clara" é o nome
// antigo do marcador "Cartão Clara" (notas na revisão antes de 2026-10-07).
const PAYMENT_METHOD_BY_MARCADOR: Record<string, string> = {
  "cartão clara": "clara",
  "cartao clara": "clara",
  clara: "clara",
  "caixa visa": "caixa_visa",
  "caixa visa norvia": "caixa_visa_norvia",
  "caixa elo": "caixa_elo",
};

/**
 * Forma de pagamento inicial da nota: a do nome do arquivo (marcador_caixa) quando houver;
 * senão o padrão da empresa. Antes só o padrão da empresa valia, e "NFC-e Norvia - Cartão
 * Clara - ..." aparecia (e era lançada) como "Caixa Visa".
 */
export function suggestPaymentMethodForNote(marcadorCaixa: string | null | undefined, destinatarioCnpj: string | null): string {
  const id = marcadorCaixa ? PAYMENT_METHOD_BY_MARCADOR[marcadorCaixa.trim().toLowerCase()] : undefined;
  return id ?? suggestPaymentMethod(destinatarioCnpj);
}

export function suggestPaymentMethod(destinatarioCnpj: string | null): string {
  if (destinatarioCnpj && DEFAULT_PAYMENT_METHOD_BY_CNPJ[destinatarioCnpj]) {
    return DEFAULT_PAYMENT_METHOD_BY_CNPJ[destinatarioCnpj];
  }
  return "pix";
}

// "Meio de Pagamento da NFe" — campo nativo do Tiny (Contas a Pagar > Pagamento), segue o
// código padrão da NF-e (tag <tPag>). Espelha PAYMENT_METHOD_NFE_LABELS em tiny_client.py.
// Pré-selecionado a partir do que o fornecedor declarou na própria nota quando disponível
// (entry.nfe_data.meio_pagamento_nfe); o funcionário sempre pode ajustar antes de confirmar.
export const PAYMENT_METHOD_NFE_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "01", label: "Dinheiro" },
  { code: "02", label: "Cheque" },
  { code: "03", label: "Cartão de Crédito" },
  { code: "04", label: "Cartão de Débito" },
  { code: "05", label: "Crédito Loja" },
  { code: "10", label: "Vale Alimentação" },
  { code: "11", label: "Vale Refeição" },
  { code: "12", label: "Vale Presente" },
  { code: "13", label: "Vale Combustível" },
  { code: "15", label: "Boleto Bancário" },
  { code: "16", label: "Depósito Bancário" },
  { code: "17", label: "Pagamento Instantâneo (PIX)" },
  { code: "18", label: "Transferência bancária, Carteira Digital" },
  { code: "19", label: "Programa de fidelidade, Cashback, Crédito Virtual" },
  { code: "90", label: "Sem pagamento" },
  { code: "99", label: "Outros" },
];

export interface GroupPreview {
  categoriaId: string;
  categoriaNome: string;
  valorTotal: number;
  itemIds: string[];
}

/** Máximo de parcelas no lançamento (mesmo limite do backend). */
export const MAX_PARCELAS = 12;

/**
 * Valor em N parcelas iguais, em centavos; a diferença do arredondamento vai na última.
 * Mesma regra de `dividir_em_parcelas` no backend, para a prévia bater com o Tiny.
 */
export function dividirEmParcelas(valor: number, parcelas: number): number[] {
  const n = Math.max(1, Math.floor(parcelas));
  const totalCentavos = Math.round(valor * 100);
  const base = Math.floor(totalCentavos / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? totalCentavos - base * (n - 1) : base) / 100);
}

/**
 * Réplica em TS, só para pré-visualização na UI, do agrupamento autoritativo
 * feito no backend (app/categorization.py::group_items_by_category): soma por
 * categoria e rateia proporcionalmente a diferença entre a soma dos itens e o
 * valor total da nota (frete/desconto), fechando exatamente com a nota.
 */
export function computeGroupPreview(
  itens: DanfeReviewItem[],
  selections: Record<string, string>,
  categoryName: (id: string) => string,
  valorTotalNota: number,
): GroupPreview[] {
  if (itens.length === 0) return [];

  const order: string[] = [];
  const itemsByCategory = new Map<string, DanfeReviewItem[]>();
  for (const item of itens) {
    const cid = selections[item.item_id] || item.categoria_sugerida_id;
    if (!itemsByCategory.has(cid)) {
      itemsByCategory.set(cid, []);
      order.push(cid);
    }
    itemsByCategory.get(cid)!.push(item);
  }

  const subtotals = new Map<string, number>();
  for (const [cid, its] of itemsByCategory) {
    subtotals.set(cid, its.reduce((sum, i) => sum + i.valor_total, 0));
  }
  const somaItens = [...subtotals.values()].reduce((a, b) => a + b, 0);
  const diferenca = (valorTotalNota || somaItens) - somaItens;

  const finais = new Map<string, number>();
  if (somaItens === 0) {
    order.forEach((cid, idx) => finais.set(cid, idx === 0 ? valorTotalNota : 0));
  } else {
    const ordemRateio = [...order].sort((a, b) => (subtotals.get(a) ?? 0) - (subtotals.get(b) ?? 0));
    let acumulado = 0;
    ordemRateio.forEach((cid, idx) => {
      const isLast = idx === ordemRateio.length - 1;
      const valor = isLast
        ? Math.round((valorTotalNota - acumulado) * 100) / 100
        : Math.round(((subtotals.get(cid) ?? 0) + diferenca * ((subtotals.get(cid) ?? 0) / somaItens)) * 100) / 100;
      finais.set(cid, valor);
      acumulado += valor;
    });
  }

  return order.map((cid) => ({
    categoriaId: cid,
    categoriaNome: categoryName(cid),
    valorTotal: finais.get(cid) ?? 0,
    itemIds: (itemsByCategory.get(cid) ?? []).map((i) => i.item_id),
  }));
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * Busca livre nas listas de NF-e (chave, número, CNPJ, razão social). Ignora acentos e,
 * para termos numéricos, a pontuação — "43.820.617" encontra o CNPJ "43820617000166" e
 * trechos da chave de acesso funcionam com ou sem espaços.
 */
export function matchesNotaSearch(term: string, values: Array<string | null | undefined>): boolean {
  const normalized = normalizeSearchText(term);
  if (!normalized) return true;
  const digits = normalized.replace(/\D/g, "");
  const isNumericTerm = digits.length >= 3 && /^[\d\s./-]+$/.test(normalized);
  return values.some((value) => {
    if (!value) return false;
    if (isNumericTerm) return value.replace(/\D/g, "").includes(digits);
    return normalizeSearchText(value).includes(normalized);
  });
}
