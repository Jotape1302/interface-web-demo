import { parseUtcDate } from "./formatters";
import type { DatePresetKey, DateRangeFilter } from "./contracts";

export const SAO_PAULO_TZ = "America/Sao_Paulo";

/**
 * Retorna as partes numéricas da data atual no fuso America/Sao_Paulo (UTC-3).
 * Garante independência do timezone configurado no sistema operacional do cliente.
 */
export function getSaoPauloParts(date: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  return {
    year: get("year"),
    month: get("month"), // 1 - 12
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Constrói um Date correspondente ao momento exato no fuso de Brasília (UTC-3).
 */
export function createSaoPauloDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0
): Date {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(ms, 3)}-03:00`;
  return new Date(iso);
}

/**
 * Formata um Date como "YYYY-MM-DD" no fuso America/Sao_Paulo — NUNCA usar
 * `d.toISOString().slice(0, 10)` pra isso, porque `toISOString()` converte pra UTC:
 * um Date representando "31/08 23:59:59.999 -03:00" (fim do dia em São Paulo, como
 * `createSaoPauloDate` produz) vira "01/09 02:59:59.999Z" em UTC, deslocando a data
 * pro dia/mês seguinte. Confirmado em 2026-09-22: isso fazia o filtro "até 31/08"
 * mandar `date_to=2026-09-01` pro backend, somando setembro junto no período.
 */
export function toSaoPauloISODate(d: Date): string {
  const { year, month, day } = getSaoPauloParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Calcula os limites de início e fim para os presets rápidos no fuso de Brasília.
 */
export function getPresetRange(key: DatePresetKey): DateRangeFilter {
  if (key === "all") {
    return { key: "all", from: null, to: null, label: "Todo o Período" };
  }

  const sp = getSaoPauloParts();

  switch (key) {
    case "today": {
      const from = createSaoPauloDate(sp.year, sp.month, sp.day, 0, 0, 0, 0);
      const to = createSaoPauloDate(sp.year, sp.month, sp.day, 23, 59, 59, 999);
      return { key: "today", from, to, label: "Hoje" };
    }
    case "yesterday": {
      const d = new Date(Date.UTC(sp.year, sp.month - 1, sp.day) - 86400000);
      const yY = d.getUTCFullYear();
      const yM = d.getUTCMonth() + 1;
      const yD = d.getUTCDate();
      const from = createSaoPauloDate(yY, yM, yD, 0, 0, 0, 0);
      const to = createSaoPauloDate(yY, yM, yD, 23, 59, 59, 999);
      return { key: "yesterday", from, to, label: "Ontem" };
    }
    case "last7days": {
      const d = new Date(Date.UTC(sp.year, sp.month - 1, sp.day) - 6 * 86400000);
      const from = createSaoPauloDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0, 0);
      const to = createSaoPauloDate(sp.year, sp.month, sp.day, 23, 59, 59, 999);
      return { key: "last7days", from, to, label: "Últimos 7 dias" };
    }
    case "last14days": {
      const d = new Date(Date.UTC(sp.year, sp.month - 1, sp.day) - 13 * 86400000);
      const from = createSaoPauloDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0, 0);
      const to = createSaoPauloDate(sp.year, sp.month, sp.day, 23, 59, 59, 999);
      return { key: "last14days", from, to, label: "Últimos 14 dias" };
    }
    case "thisMonth": {
      const from = createSaoPauloDate(sp.year, sp.month, 1, 0, 0, 0, 0);
      const lastDay = new Date(Date.UTC(sp.year, sp.month, 0)).getUTCDate();
      const to = createSaoPauloDate(sp.year, sp.month, lastDay, 23, 59, 59, 999);
      return { key: "thisMonth", from, to, label: "Este Mês" };
    }
    case "lastMonth": {
      const prevM = sp.month === 1 ? 12 : sp.month - 1;
      const prevY = sp.month === 1 ? sp.year - 1 : sp.year;
      const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
      const from = createSaoPauloDate(prevY, prevM, 1, 0, 0, 0, 0);
      const to = createSaoPauloDate(prevY, prevM, lastDay, 23, 59, 59, 999);
      return { key: "lastMonth", from, to, label: "Mês Anterior" };
    }
    case "thisYear": {
      const from = createSaoPauloDate(sp.year, 1, 1, 0, 0, 0, 0);
      const to = createSaoPauloDate(sp.year, 12, 31, 23, 59, 59, 999);
      return { key: "thisYear", from, to, label: "Este Ano" };
    }
    default:
      return { key: "all", from: null, to: null, label: "Todo o Período" };
  }
}

/**
 * Verifica se um timestamp qualquer está contido no intervalo do filtro.
 */
export function isDateWithinFilter(
  dateInput: string | number | Date | null | undefined,
  filter: DateRangeFilter
): boolean {
  if (filter.key === "all" || (!filter.from && !filter.to)) return true;
  const d = parseUtcDate(dateInput);
  if (!d) return false;

  const t = d.getTime();
  if (filter.from && t < filter.from.getTime()) return false;
  if (filter.to && t > filter.to.getTime()) return false;
  return true;
}

/**
 * Formata o label do filtro para exibição em pt-BR.
 */
export function formatDateRangeLabel(filter: DateRangeFilter): string {
  if (filter.key === "all" || (!filter.from && !filter.to)) {
    return "Todo o Período";
  }
  if (filter.label && filter.key !== "custom") {
    return filter.label;
  }

  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: SAO_PAULO_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  if (filter.from && filter.to) {
    const fromStr = fmt.format(filter.from);
    const toStr = fmt.format(filter.to);
    return fromStr === toStr ? fromStr : `${fromStr} a ${toStr}`;
  }
  if (filter.from) return `A partir de ${fmt.format(filter.from)}`;
  if (filter.to) return `Até ${fmt.format(filter.to)}`;
  return "Período Personalizado";
}
