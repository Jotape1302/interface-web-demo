'use client';

import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  areaSummary,
  canUncheckView,
  defaultOpenAreas,
  isLocked,
  toggleAction,
  toggleArea,
  toggleView,
  viewKey,
  visibleActions,
  visibleAreas,
  visibleTabs,
  type Ceiling,
  type PermissionArea,
  type PermissionCatalog,
  type PermissionTab,
  type Role,
} from '@/lib/permissions';
import { cn } from '@/lib/utils';

export const CEILING_LOCK_REASON = 'Você não tem esta permissão, por isso não pode concedê-la nem revogá-la.';
const VIEW_LOCK_REASON = 'Há ação marcada fora das suas permissões nesta aba; por isso o Ver não pode ser desmarcado.';

/**
 * Matriz abas × ações (controlada). As regras ficam em lib/permissions.ts (toggleView,
 * toggleAction, toggleArea); aqui só se renderiza. Ações de Gestão de Usuários só aparecem
 * quando o alvo é Gestor. Itens fora do teto do Gestor aparecem travados.
 */
export function PermissionMatrix({
  catalog,
  value,
  onChange,
  targetRole,
  ceiling = null,
  readOnly = false,
  busy = false,
  invalid = false,
}: {
  catalog: PermissionCatalog;
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  targetRole: Role;
  ceiling?: Ceiling;
  readOnly?: boolean;
  busy?: boolean;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState<PermissionArea[]>(() => defaultOpenAreas(catalog, value, targetRole));
  const lockId = useId();
  const disabled = readOnly || busy;

  return (
    <div
      className={cn('grid gap-3', busy && 'pointer-events-none opacity-70')}
      aria-busy={busy || undefined}
      aria-invalid={invalid || undefined}
      inert={busy || undefined}
    >
      <span id={`${lockId}-ceiling`} className="sr-only">
        {CEILING_LOCK_REASON}
      </span>
      <span id={`${lockId}-view`} className="sr-only">
        {VIEW_LOCK_REASON}
      </span>
      {visibleAreas(catalog, targetRole).map((area) => {
        const summary = areaSummary(catalog, value, area.id, targetRole, ceiling);
        const isOpen = open.includes(area.id);
        const panelId = `${lockId}-${area.id}`;
        return (
          <section
            key={area.id}
            className={'rounded-[4px] border border-border bg-card'}
            aria-labelledby={`${panelId}-title`}
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <button
                type="button"
                className="flex min-h-11 items-center gap-2 text-left sm:min-h-0"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen((prev) => (prev.includes(area.id) ? prev.filter((a) => a !== area.id) : [...prev, area.id]))}
              >
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  className={cn('text-muted-foreground transition-transform', !isOpen && '-rotate-90')}
                />
                <span id={`${panelId}-title`} className="text-xs font-bold uppercase tracking-wider text-foreground">
                  {area.label}
                </span>
                <span className="font-mono text-xs text-muted-foreground" aria-live="polite">
                  {summary.checked} de {summary.total}
                </span>
              </button>
              {!readOnly && summary.bulkEnabled && (
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
                  <Checkbox
                    checked={summary.bulk === 'all'}
                    indeterminate={summary.bulk === 'some'}
                    disabled={disabled}
                    onCheckedChange={() => onChange(toggleArea(catalog, value, area.id, targetRole, ceiling))}
                  />
                  {ceiling ? 'Marcar tudo o que posso conceder' : 'Marcar tudo'}
                </label>
              )}
            </header>
            {isOpen && (
              <div id={panelId} className="divide-y divide-border/60">
                {visibleTabs(catalog, targetRole, area.id).map((tab) => (
                  <TabRow
                    key={tab.id}
                    tab={tab}
                    value={value}
                    onChange={onChange}
                    targetRole={targetRole}
                    ceiling={ceiling}
                    disabled={disabled}
                    lockId={lockId}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TabRow({
  tab,
  value,
  onChange,
  targetRole,
  ceiling,
  disabled,
  lockId,
}: {
  tab: PermissionTab;
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  targetRole: Role;
  ceiling: Ceiling;
  disabled: boolean;
  lockId: string;
}) {
  const vk = viewKey(tab.id);
  const hasView = value.has(vk);
  const actions = visibleActions(tab, targetRole).filter((a) => a.id !== 'ver');
  const viewLocked = isLocked(vk, ceiling);
  const viewStuck = hasView && !canUncheckView(value, tab, ceiling);

  return (
    <fieldset className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(9rem,13rem)_4.5rem_1fr] sm:items-start">
      <legend className="sr-only">{tab.label}</legend>
      <span aria-hidden="true" className="pt-0.5 text-sm font-medium text-foreground">
        {tab.label}
      </span>
      <CheckItem
        label="Ver"
        checked={hasView}
        disabled={disabled || viewLocked || viewStuck}
        locked={viewLocked || viewStuck}
        describedBy={viewLocked ? `${lockId}-ceiling` : viewStuck ? `${lockId}-view` : undefined}
        onChange={(checked) => onChange(toggleView(value, tab, checked, ceiling))}
      />
      {actions.length > 0 ? (
        <div className={cn('flex flex-wrap gap-x-4 gap-y-1', !hasView && 'opacity-60')}>
          {actions.map((a) => {
            const locked = isLocked(a.key, ceiling) || (!hasView && viewLocked);
            return (
              <div key={a.key} className="min-w-0">
                <CheckItem
                  label={a.label}
                  checked={value.has(a.key)}
                  disabled={disabled || locked}
                  locked={locked}
                  describedBy={locked ? `${lockId}-ceiling` : a.risk ? `${lockId}-${a.key}-risk` : undefined}
                  onChange={(checked) => onChange(toggleAction(value, tab, a.key, checked, ceiling))}
                  extra={
                    a.risk === 'force' ? (
                      <Badge variant="warning" className="text-[10px]">
                        <AlertTriangle aria-hidden="true" />
                        Risco
                      </Badge>
                    ) : null
                  }
                />
                {a.risk === 'force' && a.help && (
                  <p id={`${lockId}-${a.key}-risk`} className="ml-6 max-w-md text-[11px] leading-snug text-muted-foreground">
                    {a.help}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <span className="hidden text-xs text-muted-foreground sm:block">Sem ações nesta aba</span>
      )}
    </fieldset>
  );
}

function CheckItem({
  label,
  checked,
  disabled,
  locked,
  describedBy,
  onChange,
  extra,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  locked: boolean;
  describedBy?: string;
  onChange: (checked: boolean) => void;
  extra?: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 items-center gap-2 text-sm text-foreground sm:min-h-7',
        locked ? 'cursor-not-allowed' : disabled ? '' : 'cursor-pointer',
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onCheckedChange={(v) => onChange(Boolean(v))}
      />
      <span className={cn(locked && 'text-muted-foreground')}>{label}</span>
      {locked && <Lock size={12} aria-hidden="true" className="text-muted-foreground" />}
      {extra}
    </label>
  );
}
