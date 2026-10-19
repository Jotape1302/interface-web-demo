'use client';

import * as React from 'react';
import { Download, Filter, RotateCcw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  isFiltroAtivo,
  parseNumeroBR,
  type ColumnFilterDef,
  type ColumnFilterValue,
  type DateFilterValue,
  type NumberFilterValue,
  type NumberOperator,
} from '@/lib/column-filters';
import type { DatePresetKey } from '@/lib/contracts';

interface ColumnFilterHeaderProps<T> {
  title?: React.ReactNode;
  columnId?: string;
  def: ColumnFilterDef<T>;
  value: ColumnFilterValue | undefined;
  onChange: (value: ColumnFilterValue | undefined) => void;
  /** Valores únicos disponíveis para o filtro de lista (calculados sobre os dados). */
  uniqueValues?: string[];
  options?: string[];
  /** Quantidade de linhas por valor, exibida ao lado de cada opção do filtro de lista. */
  counts?: Record<string, number>;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

const PRESETS_DATA: Array<{ key: DatePresetKey; label: string }> = [
  { key: 'today', label: 'Hoje' },
  { key: 'yesterday', label: 'Ontem' },
  { key: 'last7days', label: 'Últimos 7 dias' },
  { key: 'thisMonth', label: 'Este mês' },
  { key: 'lastMonth', label: 'Mês anterior' },
  { key: 'all', label: 'Todo o período' },
];

export function ColumnFilterHeader<T>({
  title,
  def,
  value,
  onChange,
  uniqueValues,
  options,
  counts,
  align = 'left',
  className,
}: ColumnFilterHeaderProps<T>) {
  const [open, setOpen] = React.useState(false);
  const ativo = isFiltroAtivo(value, def.tipo);
  const displayTitle = title ?? def.label;
  const listOptions = uniqueValues ?? options ?? [];

  const containerAlignClass =
    align === 'right' ? 'justify-end text-right' : align === 'center' ? 'justify-center text-center' : 'justify-start text-left';

  return (
    <div className={cn('inline-flex items-center gap-1.5', containerAlignClass, className)}>
      <span className="truncate">{displayTitle}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn(
                'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius)] border transition-colors',
                ativo
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold shadow-xs'
                  : 'border-transparent text-muted-foreground/60 hover:border-border hover:bg-muted/80 hover:text-foreground',
              )}
              aria-label={`Filtrar ${def.label}${ativo ? ' (filtrado)' : ''}`}
              aria-expanded={open}
            >
              <Filter size={12} className={ativo ? 'text-amber-600 dark:text-amber-400' : ''} />
            </button>
          }
        />
        <PopoverContent
          align={align === 'right' ? 'end' : 'start'}
          side="bottom"
          sideOffset={6}
          className="w-72 rounded-[var(--radius)] border-border bg-popover p-3 text-xs shadow-md"
        >
          <div className="flex items-center justify-between border-b border-border/70 pb-2">
            <span className="font-semibold text-foreground">Filtro: {def.label}</span>
            {ativo && (
              <span className="font-mono text-[10px] font-medium text-amber-600 dark:text-amber-400">Ativo</span>
            )}
          </div>

          <div className="py-2.5">
            {def.tipo === 'texto' && (
              <TextFilterBody
                key={open ? 'open' : 'closed'}
                value={(value as string) || ''}
                onChange={(val) => onChange(val || undefined)}
              />
            )}

            {def.tipo === 'lista' && (
              <ListFilterBody
                options={def.opcoes && def.opcoes.length > 0 ? def.opcoes : listOptions}
                selected={(value as string[]) || []}
                counts={counts}
                onChange={(selecionados) => onChange(selecionados.length > 0 ? selecionados : undefined)}
              />
            )}

            {def.tipo === 'data' && (
              <DateFilterBody
                value={(value as DateFilterValue) || {}}
                onChange={(d) => onChange(isFiltroAtivo(d, 'data') ? d : undefined)}
              />
            )}

            {def.tipo === 'numero' && (
              <NumberFilterBody
                key={open ? 'open' : 'closed'}
                value={(value as NumberFilterValue) || { op: '=' }}
                onChange={(n) => onChange(isFiltroAtivo(n, 'numero') ? n : undefined)}
              />
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border/70 pt-2 text-xs">
            {ativo ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  onChange(undefined);
                  setOpen(false);
                }}
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
              >
                <RotateCcw size={11} /> Limpar
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="default"
              size="xs"
              onClick={() => setOpen(false)}
              className="h-6 px-2.5 text-[11px] font-semibold"
            >
              Concluído
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Sub-corpos de filtro por tipo
// -------------------------------------------------------------------------------------------------

function TextFilterBody({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = React.useState(value);

  const handleApply = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onChange(local.trim());
  };

  return (
    <form onSubmit={handleApply} className="space-y-2">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          placeholder="Contém o texto…"
          className="h-8 rounded-[var(--radius)] pl-7 text-xs"
        />
        {local && (
          <button
            type="button"
            onClick={() => {
              setLocal('');
              onChange('');
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label="Limpar texto"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="xs" variant="secondary" className="h-6 px-2 text-[11px]">
          Aplicar
        </Button>
      </div>
    </form>
  );
}

function ListFilterBody({
  options: opcoesDados,
  selected,
  counts,
  onChange,
}: {
  options: string[];
  selected: string[];
  counts?: Record<string, number>;
  onChange: (s: string[]) => void;
}) {
  const [busca, setBusca] = React.useState('');
  // Valor marcado que não aparece mais nos dados (ex.: filtro salvo na sessão) continua visível
  // para poder ser desmarcado; senão o filtro ficaria ativo sem nada para clicar.
  const options = React.useMemo(
    () => [...opcoesDados, ...selected.filter((s) => !opcoesDados.includes(s))],
    [opcoesDados, selected],
  );

  const opcoesFiltradas = React.useMemo(() => {
    if (!busca.trim()) return options;
    const termo = busca.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(termo));
  }, [options, busca]);

  const todosMarcados = options.length > 0 && selected.length === options.length;

  const toggleOption = (opt: string) => {
    if (selected.includes(opt)) {
      onChange(selected.filter((s) => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };

  const selecionarTodos = () => {
    onChange([...options]);
  };

  const limparSelecao = () => {
    onChange([]);
  };

  return (
    <div className="space-y-2">
      {options.length > 10 && (
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Procurar valor…"
            className="h-7 rounded-[var(--radius)] pl-6 text-[11px]"
          />
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {selected.length} de {options.length} selecionado(s)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={selecionarTodos}
            disabled={todosMarcados}
            className="text-[11px] font-medium text-primary hover:underline disabled:opacity-40 cursor-pointer"
          >
            Todos
          </button>
          <span>·</span>
          <button
            type="button"
            onClick={limparSelecao}
            disabled={selected.length === 0}
            className="text-[11px] font-medium text-muted-foreground hover:underline disabled:opacity-40 cursor-pointer"
          >
            Limpar
          </button>
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto space-y-1 border border-border/50 rounded-[var(--radius)] p-1.5 bg-muted/20">
        {opcoesFiltradas.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">Nenhum valor encontrado.</p>
        ) : (
          opcoesFiltradas.map((opt) => {
            const checked = selected.includes(opt);
            return (
              <label
                key={opt}
                className={cn(
                  'flex items-center gap-2 px-1.5 py-1 rounded-[var(--radius)] text-xs cursor-pointer select-none transition-colors',
                  checked ? 'bg-accent/60 font-medium text-foreground' : 'hover:bg-muted/60 text-muted-foreground',
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleOption(opt)}
                  className="rounded-[2px]"
                />
                <span className="truncate" title={opt}>
                  {opt}
                </span>
                {counts && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {counts[opt] ?? 0}
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

function DateFilterBody({
  value,
  onChange,
}: {
  value: DateFilterValue;
  onChange: (val: DateFilterValue) => void;
}) {
  const handlePreset = (key: DatePresetKey) => {
    if (key === 'all') {
      onChange({ de: '', ate: '', preset: 'all' });
      return;
    }
    onChange({ de: '', ate: '', preset: key });
  };

  const handleDeChange = (de: string) => {
    onChange({ ...value, de: de || undefined, preset: 'custom' });
  };

  const handleAteChange = (ate: string) => {
    onChange({ ...value, ate: ate || undefined, preset: 'custom' });
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1 bg-muted/20 p-1 rounded-[var(--radius)] border border-border/40">
        {PRESETS_DATA.map((p) => {
          const ativo = value.preset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => handlePreset(p.key)}
              className={cn(
                'px-1.5 py-1 text-[11px] rounded-[var(--radius)] text-left transition-colors cursor-pointer',
                ativo
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5 border-t border-border/50 pt-2">
        <div className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-[11px] text-muted-foreground">De:</span>
          <Input
            type="date"
            value={value.de || ''}
            onChange={(e) => handleDeChange(e.target.value)}
            className="h-7 text-xs rounded-[var(--radius)]"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-[11px] text-muted-foreground">Até:</span>
          <Input
            type="date"
            value={value.ate || ''}
            onChange={(e) => handleAteChange(e.target.value)}
            className="h-7 text-xs rounded-[var(--radius)]"
          />
        </div>
      </div>
    </div>
  );
}

function NumberFilterBody({
  value,
  onChange,
}: {
  value: NumberFilterValue;
  onChange: (val: NumberFilterValue) => void;
}) {
  const [op, setOp] = React.useState<NumberOperator>(value.op || '=');
  const [v1, setV1] = React.useState<string>(value.val !== null && value.val !== undefined ? String(value.val) : '');
  const [v2, setV2] = React.useState<string>(value.valFim !== null && value.valFim !== undefined ? String(value.valFim) : '');

  const handleApply = (newOp = op, rawV1 = v1, rawV2 = v2) => {
    const num1 = parseNumeroBR(rawV1);
    const num2 = parseNumeroBR(rawV2);
    onChange({
      op: newOp,
      val: num1,
      valFim: newOp === 'entre' ? num2 : undefined,
    });
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor="filtro-num-condicao" className="text-[10px] uppercase font-semibold text-muted-foreground">
          Condição
        </label>
        <NativeSelect
          id="filtro-num-condicao"
          value={op}
          onChange={(e) => {
            const novoOp = e.target.value as NumberOperator;
            setOp(novoOp);
            handleApply(novoOp, v1, v2);
          }}
          className="h-7 text-xs rounded-[var(--radius)] w-full"
        >
          <NativeSelectOption value="=">Igual a (=)</NativeSelectOption>
          <NativeSelectOption value=">=">Maior ou igual a (&gt;=)</NativeSelectOption>
          <NativeSelectOption value="<=">Menor ou igual a (&lt;=)</NativeSelectOption>
          <NativeSelectOption value="entre">Entre dois valores</NativeSelectOption>
        </NativeSelect>
      </div>

      <div className="space-y-1.5">
        <Input
          type="text"
          value={v1}
          placeholder="Ex: 1500,00"
          onChange={(e) => {
            setV1(e.target.value);
            handleApply(op, e.target.value, v2);
          }}
          className="h-7 text-xs rounded-[var(--radius)]"
        />

        {op === 'entre' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">e</span>
            <Input
              type="text"
              value={v2}
              placeholder="Ex: 5000,00"
              onChange={(e) => {
                setV2(e.target.value);
                handleApply(op, v1, e.target.value);
              }}
              className="h-7 text-xs rounded-[var(--radius)]"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Barra Informativa Unificada com Contagem e Exportação CSV
// -------------------------------------------------------------------------------------------------

export interface ColumnFilterBarProps {
  totalCount: number;
  filteredCount: number;
  activeFiltersCount: number;
  onClearAll: () => void;
  onExportCsv?: () => void;
  itemLabel?: string;
  className?: string;
}

export function ColumnFilterBar({
  totalCount,
  filteredCount,
  activeFiltersCount,
  onClearAll,
  onExportCsv,
  itemLabel = 'itens',
  className,
}: ColumnFilterBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2 text-xs',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        {activeFiltersCount > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400 font-medium">
            <span>
              {activeFiltersCount} {activeFiltersCount === 1 ? 'filtro ativo' : 'filtros ativos'}
            </span>
            <button
              type="button"
              onClick={onClearAll}
              className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
              title="Limpar todos os filtros de coluna"
            >
              · <RotateCcw size={11} className="ml-0.5" /> Limpar
            </button>
          </div>
        )}
        <span className="text-muted-foreground">
          Mostrando <strong className="text-foreground tabular-nums">{filteredCount}</strong> de{' '}
          <strong className="text-foreground tabular-nums">{totalCount}</strong> {itemLabel}
        </span>
      </div>

      {onExportCsv && (
        <Button
          variant="outline"
          size="sm"
          disabled={filteredCount === 0}
          onClick={onExportCsv}
          className="h-7 gap-1.5 rounded-[var(--radius)] text-xs cursor-pointer ml-auto"
        >
          <Download size={13} />
          Exportar CSV
        </Button>
      )}
    </div>
  );
}
