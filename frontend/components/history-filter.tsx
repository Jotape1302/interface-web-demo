"use client";

import * as React from "react";
import { ptBR } from "date-fns/locale";
import {
  Calendar as CalendarIcon,
  RotateCcw,
  Check,
  ChevronDown,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import type { DatePresetKey, DateRangeFilter } from "@/lib/contracts";
import {
  getPresetRange,
  formatDateRangeLabel,
  createSaoPauloDate,
  getSaoPauloParts,
} from "@/lib/date-range-utils";

interface HistoryFilterProps {
  value: DateRangeFilter;
  onChange: (value: DateRangeFilter) => void;
  className?: string;
  totalFilteredCount?: number;
}

const PRESETS: Array<{ key: DatePresetKey; label: string }> = [
  { key: "today", label: "Hoje" },
  { key: "yesterday", label: "Ontem" },
  { key: "last7days", label: "Últimos 7 dias" },
  { key: "last14days", label: "Últimos 14 dias" },
  { key: "thisMonth", label: "Este Mês" },
  { key: "lastMonth", label: "Mês Anterior" },
  { key: "thisYear", label: "Este Ano" },
  { key: "all", label: "Todo o Período" },
];

export function HistoryFilter({
  value,
  onChange,
  className,
  totalFilteredCount,
}: HistoryFilterProps) {
  const [open, setOpen] = React.useState(false);

  // Range selecionado no react-day-picker
  const selectedRange = React.useMemo(() => {
    return {
      from: value.from ?? undefined,
      to: value.to ?? undefined,
    };
  }, [value.from, value.to]);

  const handlePresetSelect = (presetKey: DatePresetKey) => {
    const newRange = getPresetRange(presetKey);
    onChange(newRange);
    setOpen(false);
  };

  const handleCalendarSelect = (range: { from?: Date; to?: Date } | undefined) => {
    if (!range?.from) {
      onChange({ key: "all", from: null, to: null, label: "Todo o Período" });
      return;
    }

    // Seleção de um único dia
    if (range.from && !range.to) {
      const from = createSaoPauloDate(
        range.from.getFullYear(),
        range.from.getMonth() + 1,
        range.from.getDate(),
        0,
        0,
        0,
        0
      );
      const to = createSaoPauloDate(
        range.from.getFullYear(),
        range.from.getMonth() + 1,
        range.from.getDate(),
        23,
        59,
        59,
        999
      );
      onChange({
        key: "custom",
        from,
        to,
        label: `${String(range.from.getDate()).padStart(2, "0")}/${String(
          range.from.getMonth() + 1
        ).padStart(2, "0")}/${range.from.getFullYear()}`,
      });
      return;
    }

    // Intervalo de dois dias (range)
    if (range.from && range.to) {
      const from = createSaoPauloDate(
        range.from.getFullYear(),
        range.from.getMonth() + 1,
        range.from.getDate(),
        0,
        0,
        0,
        0
      );
      const to = createSaoPauloDate(
        range.to.getFullYear(),
        range.to.getMonth() + 1,
        range.to.getDate(),
        23,
        59,
        59,
        999
      );
      onChange({ key: "custom", from, to });
    }
  };

  // Atalhos rápidos para mês completo e ano completo
  const handleSelectFullMonth = (monthOffset = 0) => {
    const sp = getSaoPauloParts();
    let targetMonth = sp.month + monthOffset;
    let targetYear = sp.year;
    if (targetMonth < 1) {
      targetMonth = 12;
      targetYear -= 1;
    } else if (targetMonth > 12) {
      targetMonth = 1;
      targetYear += 1;
    }

    const from = createSaoPauloDate(targetYear, targetMonth, 1, 0, 0, 0, 0);
    const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const to = createSaoPauloDate(targetYear, targetMonth, lastDay, 23, 59, 59, 999);
    onChange({
      key: "custom",
      from,
      to,
      label: `Mês Completo (${String(targetMonth).padStart(2, "0")}/${targetYear})`,
    });
    setOpen(false);
  };

  const handleSelectFullYear = () => {
    const sp = getSaoPauloParts();
    const from = createSaoPauloDate(sp.year, 1, 1, 0, 0, 0, 0);
    const to = createSaoPauloDate(sp.year, 12, 31, 23, 59, 59, 999);
    onChange({ key: "thisYear", from, to, label: `Ano ${sp.year} Completo` });
    setOpen(false);
  };

  const isFiltered = value.key !== "all" && (value.from !== null || value.to !== null);

  const handleClear = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onChange({ key: "all", from: null, to: null, label: "Todo o Período" });
    setOpen(false);
  };

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={`gap-2 h-8 px-2.5 text-xs font-medium border-border/80 transition-all ${
                isFiltered
                  ? "border-primary/60 bg-primary/10 text-primary hover:bg-primary/15"
                  : "bg-background hover:bg-accent/60 text-foreground"
              }`}
              aria-label={`Filtrar por período. Filtro atual: ${formatDateRangeLabel(value)}`}
              aria-haspopup="dialog"
              aria-expanded={open}
            >
              <CalendarIcon
                size={13}
                className={isFiltered ? "text-primary shrink-0" : "text-muted-foreground shrink-0"}
              />
              <span className="font-mono text-[11px] truncate max-w-[210px]">
                {formatDateRangeLabel(value)}
              </span>
              {isFiltered && typeof totalFilteredCount === "number" && (
                <span className="px-1.5 py-0.2 rounded-[4px] bg-primary/25 text-primary text-[10px] font-mono font-semibold">
                  {totalFilteredCount}
                </span>
              )}
              <ChevronDown size={12} className="text-muted-foreground ml-auto opacity-70" />
            </Button>
          }
        />

        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-auto p-0 shadow-lg border-border bg-popover z-50 flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-border/60 rounded-xl overflow-hidden"
        >
          {/* Painel lateral esquerdo: Presets rápidos */}
          <div className="flex flex-col p-3 w-44 bg-muted/20 gap-1 shrink-0">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Período Rápido
            </div>
            {PRESETS.map((preset) => {
              const active = value.key === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => handlePresetSelect(preset.key)}
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors text-left cursor-pointer ${
                    active
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "text-foreground hover:bg-muted font-normal"
                  }`}
                >
                  <span>{preset.label}</span>
                  {active && <Check size={13} className="shrink-0" />}
                </button>
              );
            })}

            {/* Ações de atalho rápido direto */}
            <div className="pt-2 mt-auto border-t border-border/50 flex flex-col gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSelectFullMonth(0)}
                className="justify-start text-xs h-7 px-2 text-muted-foreground hover:text-foreground font-normal"
              >
                Mês atual completo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSelectFullYear}
                className="justify-start text-xs h-7 px-2 text-muted-foreground hover:text-foreground font-normal"
              >
                Ano atual completo
              </Button>
            </div>
          </div>

          {/* Painel direito: Calendário interativo */}
          <div className="p-3 flex flex-col">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Seleção por Calendário
            </div>
            <Calendar
              mode="range"
              selected={selectedRange}
              onSelect={handleCalendarSelect}
              locale={ptBR}
              numberOfMonths={1}
              captionLayout="dropdown"
              fromYear={2024}
              toYear={2027}
              className="p-0 select-none"
            />

            {/* Rodapé do Popover com Timezone e Reset */}
            <div className="mt-2 pt-2 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-mono text-[10px] text-muted-foreground">
                Fuso: America/Sao_Paulo (UTC-3)
              </span>
              <div className="flex items-center gap-1.5">
                {isFiltered && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClear}
                    className="h-6 px-2 text-[11px] gap-1 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                  >
                    <RotateCcw size={11} />
                    Limpar
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => setOpen(false)}
                  className="h-6 px-2.5 text-[11px] font-semibold"
                >
                  Concluído
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {isFiltered && (
        <button
          type="button"
          onClick={handleClear}
          className="h-8 px-2 flex items-center gap-1 rounded-md text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 border border-border/50 text-xs transition cursor-pointer"
          title="Remover filtro de período"
        >
          <X size={12} />
          <span className="text-[10px] font-medium hidden sm:inline">Limpar</span>
        </button>
      )}
    </div>
  );
}
