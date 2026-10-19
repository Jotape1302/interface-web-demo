import { createSaoPauloDate, getPresetRange, isDateWithinFilter } from "./date-range-utils";
import type { DatePresetKey, DateRangeFilter } from "./contracts";

export type ColumnFilterType = "texto" | "lista" | "data" | "numero";

export type NumberOperator = "=" | ">=" | "<=" | "entre";

export interface NumberFilterValue {
  op: NumberOperator;
  val?: number | null;
  valFim?: number | null;
}

export interface DateFilterValue {
  de?: string | null;
  ate?: string | null;
  preset?: DatePresetKey | "custom" | "all";
}

export type ColumnFilterValue =
  | string // texto
  | string[] // lista (valores selecionados)
  | DateFilterValue // data
  | NumberFilterValue; // numero

export type ColumnFiltersState = Record<string, ColumnFilterValue | undefined>;

export interface ColumnFilterDef<T> {
  id: string;
  label: string;
  tipo: ColumnFilterType;
  accessor: (item: T) => string | number | boolean | Date | null | undefined;
  /** Opções manuais opcionais para tipo lista (se omitido, extrai dos dados). */
  opcoes?: string[];
}

/**
 * Remove acentos e converte para minúsculas para comparação textual insensível.
 */
export function normalizarTexto(valor: string | null | undefined): string {
  if (!valor) return "";
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Busca textual da coluna. Termo numérico (CNPJ, documento, código de barras, IDs) compara só
 * os dígitos, então "12.345.678/0001-90" e "12345678000190" acham a mesma linha.
 */
export function textoCombina(termo: string | null | undefined, valor: string | null | undefined): boolean {
  const normalizado = normalizarTexto(termo);
  if (!normalizado) return true;
  const digitos = normalizado.replace(/\D/g, "");
  if (digitos.length >= 3 && /^[\d\s./-]+$/.test(normalizado)) {
    return (valor ?? "").replace(/\D/g, "").includes(digitos);
  }
  return normalizarTexto(valor).includes(normalizado);
}

/**
 * Converte valor numérico ou string em formato brasileiro (ex.: "1.234,56" ou "1234,56") para number.
 */
export function parseNumeroBR(valor: string | number | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;

  const texto = String(valor).replace(/R\$|\s/g, "");
  if (!texto) return null;

  // Formato brasileiro com vírgula decimal ("1.234,56") ou só com milhar ("1.500" = mil e quinhentos).
  if (texto.includes(",") || /^-?\d{1,3}(\.\d{3})+$/.test(texto)) {
    const limpo = texto.replace(/\./g, "").replace(",", ".");
    const num = Number(limpo);
    return Number.isFinite(num) ? num : null;
  }

  const num = Number(texto);
  return Number.isFinite(num) ? num : null;
}

/**
 * Converte data de linha (em DD/MM/AAAA ou AAAA-MM-DD) para meio-dia em Brasília (UTC-3),
 * evitando problemas de borda de fuso horário.
 */
export function normalizarDataLinha(valor: string | number | Date | null | undefined): string | null {
  if (!valor) return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return valor.toISOString();
  }
  const v = String(valor).trim();
  if (!v) return null;

  // Formato brasileiro DD/MM/AAAA
  const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) {
    return `${br[3]}-${br[2]}-${br[1]}T12:00:00-03:00`;
  }

  // Formato ISO simples AAAA-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return `${v}T12:00:00-03:00`;
  }

  return v;
}

/**
 * Converte um DateFilterValue em um DateRangeFilter compatível com isDateWithinFilter.
 */
export function converterParaDateRange(val: DateFilterValue): DateRangeFilter {
  if (val.preset && val.preset !== "custom" && val.preset !== "all") {
    return getPresetRange(val.preset);
  }

  const deStr = val.de?.trim();
  const ateStr = val.ate?.trim();

  if (!deStr && !ateStr) {
    return { key: "all", from: null, to: null, label: "Todo o Período" };
  }

  let from: Date | null = null;
  let to: Date | null = null;

  if (deStr) {
    const p = deStr.split("-").map(Number);
    if (p.length === 3 && !p.some(Number.isNaN)) {
      from = createSaoPauloDate(p[0], p[1], p[2], 0, 0, 0, 0);
    }
  }

  if (ateStr) {
    const p = ateStr.split("-").map(Number);
    if (p.length === 3 && !p.some(Number.isNaN)) {
      to = createSaoPauloDate(p[0], p[1], p[2], 23, 59, 59, 999);
    }
  }

  return {
    key: "custom",
    from,
    to,
  };
}

/**
 * Verifica se um filtro específico está ativo (tem restrição aplicada).
 */
export function isFiltroAtivo(valor: ColumnFilterValue | undefined, tipo: ColumnFilterType): boolean {
  if (valor === undefined || valor === null) return false;

  switch (tipo) {
    case "texto": {
      return typeof valor === "string" && valor.trim().length > 0;
    }
    case "lista": {
      return Array.isArray(valor) && valor.length > 0;
    }
    case "data": {
      if (typeof valor !== "object" || Array.isArray(valor)) return false;
      const df = valor as DateFilterValue;
      if (df.preset && df.preset !== "all") return true;
      return Boolean(df.de?.trim() || df.ate?.trim());
    }
    case "numero": {
      if (typeof valor !== "object" || Array.isArray(valor)) return false;
      const nf = valor as NumberFilterValue;
      if (nf.op === "entre") {
        return (nf.val !== null && nf.val !== undefined) || (nf.valFim !== null && nf.valFim !== undefined);
      }
      return nf.val !== null && nf.val !== undefined;
    }
    default:
      return false;
  }
}

/**
 * Conta quantos filtros estão atualmente ativos no mapa de filtros.
 */
export function filtrosAtivosCount<T = unknown>(
  filtros: ColumnFiltersState,
  definicoes?: Record<string, ColumnFilterDef<T>>,
): number {
  let count = 0;
  for (const [colId, val] of Object.entries(filtros)) {
    const tipo = definicoes?.[colId]?.tipo ?? inferirTipoDeFiltro(val);
    if (tipo && isFiltroAtivo(val, tipo)) {
      count++;
    }
  }
  return count;
}

function inferirTipoDeFiltro(val: ColumnFilterValue | undefined): ColumnFilterType | null {
  if (val === undefined || val === null) return null;
  if (typeof val === "string") return "texto";
  if (Array.isArray(val)) return "lista";
  if (typeof val === "object") {
    if ("op" in val) return "numero";
    if ("de" in val || "ate" in val || "preset" in val) return "data";
  }
  return null;
}

/**
 * Avalia se um item atende ao critério de um filtro individual.
 */
export function atendeFiltro<T>(
  item: T,
  filtroValor: ColumnFilterValue | undefined,
  def: ColumnFilterDef<T>,
): boolean {
  if (!isFiltroAtivo(filtroValor, def.tipo)) return true;

  const rawValue = def.accessor(item);

  switch (def.tipo) {
    case "texto": {
      return textoCombina(filtroValor as string, rawValue !== null && rawValue !== undefined ? String(rawValue) : "");
    }

    case "lista": {
      const selecionados = (filtroValor as string[]) || [];
      if (selecionados.length === 0) return true;
      const itemValor = rawValue !== null && rawValue !== undefined ? String(rawValue).trim() : "";
      return selecionados.includes(itemValor);
    }

    case "data": {
      const dateFilterVal = filtroValor as DateFilterValue;
      const range = converterParaDateRange(dateFilterVal);
      if (range.key === "all" || (!range.from && !range.to)) return true;
      const normalizada = normalizarDataLinha(rawValue instanceof Date ? rawValue : String(rawValue ?? ""));
      return isDateWithinFilter(normalizada, range);
    }

    case "numero": {
      const nf = filtroValor as NumberFilterValue;
      const itemNum = parseNumeroBR(typeof rawValue === "number" || typeof rawValue === "string" ? rawValue : null);
      if (itemNum === null) return false;

      const v1 = nf.val ?? null;
      const v2 = nf.valFim ?? null;

      switch (nf.op) {
        case "=":
          return v1 !== null ? Math.abs(itemNum - v1) < 0.0001 : true;
        case ">=":
          return v1 !== null ? itemNum >= v1 : true;
        case "<=":
          return v1 !== null ? itemNum <= v1 : true;
        case "entre": {
          if (v1 !== null && v2 !== null) return itemNum >= v1 && itemNum <= v2;
          if (v1 !== null) return itemNum >= v1;
          if (v2 !== null) return itemNum <= v2;
          return true;
        }
        default:
          return true;
      }
    }

    default:
      return true;
  }
}

/**
 * Aplica todos os filtros ativos a uma coleção de dados.
 */
export function aplicaFiltros<T>(
  dados: T[],
  filtros: ColumnFiltersState,
  definicoes: Record<string, ColumnFilterDef<T>>,
): T[] {
  const colunasAtivas = Object.keys(definicoes).filter((colId) =>
    isFiltroAtivo(filtros[colId], definicoes[colId].tipo),
  );

  if (colunasAtivas.length === 0) {
    return dados;
  }

  return dados.filter((item) => {
    for (const colId of colunasAtivas) {
      if (!atendeFiltro(item, filtros[colId], definicoes[colId])) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Extrai valores únicos de uma coluna nos dados atuais (para o filtro do tipo lista).
 */
export function obterValoresUnicos<T>(
  dados: T[],
  accessor: (item: T) => string | number | boolean | Date | null | undefined,
): string[] {
  const valores = new Set<string>();
  for (const item of dados) {
    const v = accessor(item);
    if (v !== null && v !== undefined) {
      const s = String(v).trim();
      if (s) valores.add(s);
    }
  }
  return [...valores].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/**
 * Quantas linhas têm cada valor da coluna (mostrado ao lado das opções do filtro de lista).
 */
export function contarValores<T>(
  dados: T[],
  accessor: (item: T) => string | number | boolean | Date | null | undefined,
): Record<string, number> {
  const contagem: Record<string, number> = {};
  for (const item of dados) {
    const v = accessor(item);
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) contagem[s] = (contagem[s] ?? 0) + 1;
  }
  return contagem;
}

/**
 * Salva os filtros ativos da tela/aba no sessionStorage com tratamento silencioso de erros.
 */
export function salvarFiltrosSession(tela: string, aba: string, filtros: ColumnFiltersState): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    const chave = `col_filters_${tela}_${aba}`;
    // Salva apenas filtros que estão efetivamente ativos para economizar espaço
    const ativos: ColumnFiltersState = {};
    for (const [k, v] of Object.entries(filtros)) {
      if (v !== undefined && v !== null) {
        ativos[k] = v;
      }
    }
    if (Object.keys(ativos).length === 0) {
      window.sessionStorage.removeItem(chave);
    } else {
      window.sessionStorage.setItem(chave, JSON.stringify(ativos));
    }
  } catch {
    // Falhas de sessionStorage (modo anônimo estrito, cota excedida) são ignoradas silenciosamente
  }
}

/**
 * Carrega os filtros ativos da tela/aba do sessionStorage com tratamento silencioso de erros.
 */
export function carregarFiltrosSession(
  tela: string,
  aba: string,
  defaults: ColumnFiltersState = {},
): ColumnFiltersState {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return { ...defaults };
    const chave = `col_filters_${tela}_${aba}`;
    const bruto = window.sessionStorage.getItem(chave);
    if (!bruto) return { ...defaults };
    const parsed = JSON.parse(bruto) as ColumnFiltersState;
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}
