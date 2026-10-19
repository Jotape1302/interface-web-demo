const integer = new Intl.NumberFormat("pt-BR");
export const decimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const real = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const timestamp = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export const count = (value: number) => integer.format(value);
export const hours = (value: number) => `${decimal.format(value)} h`;

export function formatTimeSaved(hoursValue: number | null | undefined): string {
  if (!hoursValue || hoursValue <= 0) return "0 min";
  const totalMinutes = Math.round(hoursValue * 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mins === 0) {
    return `${hrs}h`;
  }
  return `${hrs}h ${mins}min`;
}
export function money(value: number | string): string {
  if (typeof value === "number") return real.format(value);
  // Preserve decimal strings exactly, including amounts above Number.MAX_SAFE_INTEGER.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new RangeError("Valor monetário inválido");
  const fraction = (match[3] ?? "").padEnd(3, "0");
  let cents = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1n;
  return `${match[1]}R$\u00a0${integer.format(cents / 100n)},${String(cents % 100n).padStart(2, "0")}`;
}
export const percentage = (value: number | null) =>
  value === null ? "Sem base" : `${decimal.format(value)}%`;
export function parseUtcDate(value: string | number | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T12:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const isoStr = str.includes(" ") ? str.replace(" ", "T") : str;
  const normalized =
    isoStr.endsWith("Z") || /[+-]\d{2}(:\d{2})?$/.test(isoStr)
      ? isoStr
      : `${isoStr}Z`;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

export function formatTimeBR(value: string | number | Date | null | undefined): string {
  const d = parseUtcDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

export function formatDateBR(value: string | number | Date | null | undefined): string {
  const d = parseUtcDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function formatDateTimeBR(value: string | number | Date | null | undefined): string {
  const d = parseUtcDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

export function formatCnpjMask(cnpj: string): string {
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

export function dateOnly(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}
export const dateTime = (value: string | null) => {
  const d = parseUtcDate(value);
  return d ? timestamp.format(d) : "Não informado";
};
export function duration(value: number | null) {
  if (value === null) return "—";
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
