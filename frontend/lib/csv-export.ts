/**
 * Exportação CSV no formato que o Excel em pt-BR abre direto (duplo clique): separador
 * ";" (a vírgula é o separador decimal), BOM UTF-8 para acentos e números com vírgula
 * decimal, sem separador de milhar.
 */
export type CsvValue = string | number | boolean | null | undefined;

function formatCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "number"
      ? Number.isFinite(value)
        ? String(value).replace(".", ",")
        : ""
      : typeof value === "boolean"
        ? value
          ? "Sim"
          : "Não"
        : value;
  // Protege contra injeção de fórmula ao abrir no Excel (=, +, -, @ no início de texto).
  const safe = typeof value === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((row) => row.map(formatCell).join(";")).join("\r\n");
}

export function downloadCsv(filename: string, headers: string[], rows: CsvValue[][]): void {
  const blob = new Blob(["﻿", toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
