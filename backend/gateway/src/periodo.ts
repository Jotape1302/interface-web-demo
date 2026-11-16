import type { RoiPeriodo } from "./contracts.js";
import { saoPauloParts } from "./overview.js";

/** Sem filtro: total desde o início. */
export const PERIODO_TOTAL: RoiPeriodo = { de: null, ate: null };

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function dataValida(texto: string): boolean {
  if (!DATA_RE.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

/** Lê `de`/`ate` (AAAA-MM-DD, São Paulo, inclusivos). Ambos ou nenhum; de > ate é erro. */
export function lerPeriodo(params: URLSearchParams): { periodo: RoiPeriodo } | { erro: string } {
  const de = params.get("de")?.trim() || null;
  const ate = params.get("ate")?.trim() || null;
  if (!de && !ate) return { periodo: PERIODO_TOTAL };
  if (!de || !ate) return { erro: "Informe as duas datas do período (de e ate) ou nenhuma." };
  if (!dataValida(de) || !dataValida(ate)) return { erro: "Datas inválidas: use o formato AAAA-MM-DD." };
  if (de > ate) return { erro: "A data inicial não pode ser depois da data final." };
  return { periodo: { de, ate } };
}

export function periodoAtivo(p?: RoiPeriodo | null): p is { de: string; ate: string } {
  return !!p && !!p.de && !!p.ate;
}

/**
 * Filtro SQL de uma coluna DATETIME gravada em UTC (UTC_TIMESTAMP) para um período em dias de
 * São Paulo (UTC-3), ambos inclusivos. Sem período: nada a filtrar.
 */
export function periodoSql(coluna: string, p?: RoiPeriodo | null): { where: string[]; values: string[] } {
  if (!periodoAtivo(p)) return { where: [], values: [] };
  return {
    where: [`${coluna} >= DATE_ADD(?, INTERVAL 3 HOUR)`, `${coluna} < DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL 3 HOUR)`],
    values: [p.de, p.ate],
  };
}

/** O instante (ISO; sem fuso = São Paulo) cai no período? Sem período, sempre. */
export function noPeriodo(iso: string | null | undefined, p?: RoiPeriodo | null): boolean {
  if (!periodoAtivo(p)) return true;
  if (!iso) return false;
  const s = String(iso).trim().replace(" ", "T");
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}-03:00`);
  if (!Number.isFinite(t)) return false;
  const dia = saoPauloParts(new Date(t)).day;
  return dia >= p.de && dia <= p.ate;
}
