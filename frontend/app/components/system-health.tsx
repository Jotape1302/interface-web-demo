'use client';

import { useCallback, useState } from 'react';
import { Activity, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDataPolling } from '@/lib/use-data-polling';
import { Badge } from '@/components/ui/badge';
import { formatDateTimeBR, formatTimeBR } from '@/lib/formatters';
import {
  HEALTH_GROUPS,
  HEALTH_STATE_LABEL,
  OVERALL_MESSAGE,
  bucketHistory,
  makeDemoSystemHealth,
  type HealthCheckResult,
  type HealthState,
  type SystemHealthReport,
} from '@/lib/system-health';

const AUTO_REFRESH_MS = 60_000;
const HISTORY_BUCKETS = 48;

const BADGE_VARIANT: Record<HealthState, 'success' | 'warning' | 'danger' | 'secondary'> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
  unknown: 'secondary',
};

const DOT_CLASS: Record<HealthState, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
};

const BANNER_CLASS: Record<HealthState, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  unknown: 'border-border bg-muted/40 text-muted-foreground',
};

function HistoryStrip({ check, hours, now }: { check: HealthCheckResult; hours: number; now: number }) {
  const buckets = bucketHistory(check.history, hours, HISTORY_BUCKETS, now);
  const bucketMinutes = (hours * 60) / HISTORY_BUCKETS;
  return (
    <div>
      <div className="flex h-5 items-stretch gap-px" role="img" aria-label={`Histórico das últimas ${hours} horas`}>
        {buckets.map((state, i) => {
          const from = new Date(now - (HISTORY_BUCKETS - i) * bucketMinutes * 60_000);
          return (
            <span
              key={i}
              className={`flex-1 rounded-[2px] ${state ? DOT_CLASS[state] : 'bg-muted'} ${state === 'ok' ? 'opacity-70' : ''}`}
              title={`${formatTimeBR(from)} · ${state ? HEALTH_STATE_LABEL[state] : 'Sem amostra'}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{hours}h atrás</span>
        <span>
          {check.uptimePct === null ? 'Sem amostras conclusivas' : `${String(check.uptimePct).replace('.', ',')}% sem falha`}
        </span>
        <span>agora</span>
      </div>
    </div>
  );
}

function CheckCard({ check, hours, now }: { check: HealthCheckResult; hours: number; now: number }) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[check.state]}`} aria-hidden="true" />
          {check.title}
        </h3>
        <Badge variant={BADGE_VARIANT[check.state]} className="shrink-0 text-[10px]">
          {HEALTH_STATE_LABEL[check.state]}
        </Badge>
      </header>
      <p className="text-xs leading-relaxed text-muted-foreground">{check.message}</p>
      {check.details && check.details.length > 0 && (
        <dl className="space-y-1 text-xs">
          {check.details.map((d) => (
            <div key={d.label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd
                className={`text-right font-medium ${
                  d.state === 'error'
                    ? 'text-rose-600 dark:text-rose-400'
                    : d.state === 'warning'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-foreground'
                }`}
              >
                {d.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-auto space-y-2 border-t border-border/60 pt-3">
        <HistoryStrip check={check} hours={hours} now={now} />
        <p className="text-[10px] text-muted-foreground">
          Verificado às {formatTimeBR(check.checkedAt)} · resposta em {check.latencyMs} ms
        </p>
      </div>
    </article>
  );
}

// Saúde do sistema: estado atual e últimas 24h de cada serviço da plataforma. Exclusivo
// do admin (o gateway também bloqueia /api/admin/system-health para os demais).
export default function SystemHealth() {
  const { token, apiBaseUrl, can } = useAuth();
  const canView = can('saude:ver');
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  const [report, setReport] = useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (force = false, signal?: AbortSignal) => {
      if (isDemo) {
        setReport(makeDemoSystemHealth());
        return;
      }
      if (!token) return;
      setLoading(true);
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/admin/system-health${force ? '?refresh=1' : ''}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setReport((await res.json()) as SystemHealthReport);
        setError('');
      } catch {
        if (signal?.aborted) return;
        setError('Não foi possível consultar a saúde do sistema. O gateway pode estar fora do ar.');
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [apiBaseUrl, isDemo, token],
  );

  useDataPolling(
    (signal) => load(false, signal),
    {
      intervalMs: AUTO_REFRESH_MS,
      enabled: canView,
      pauseOnHidden: true,
      refetchOnVisible: true,
    },
  );

  if (!canView) {
    return (
      <section role="alert" className="mx-auto max-w-xl py-16 text-center">
        <ShieldAlert size={28} className="mx-auto mb-3 text-muted-foreground" />
        <h1 className="text-lg font-bold text-foreground">Você não tem acesso a esta aba</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Peça ao administrador para liberar <strong className="text-foreground">Saúde do Sistema</strong> em Gestão de Usuários.
        </p>
      </section>
    );
  }

  const now = report ? Date.parse(report.generatedAt) : Date.now();

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Administração</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <Activity size={22} className="text-primary" />
            Saúde do Sistema
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Estado de cada serviço da plataforma, das integrações e das rotinas diárias.
            {report && ` Amostras a cada ${report.sampleIntervalMinutes} min; o histórico recomeça quando o gateway reinicia.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="flex cursor-pointer items-center gap-1.5 self-start rounded-xl border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-60 sm:self-auto"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Verificar agora
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {report && (
        <>
          <div className={`flex items-center justify-between gap-3 rounded-lg border p-4 text-sm font-medium ${BANNER_CLASS[report.overall]}`}>
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${DOT_CLASS[report.overall]}`} aria-hidden="true" />
              {OVERALL_MESSAGE[report.overall]}
            </span>
            <span className="text-xs font-normal opacity-80">Atualizado em {formatDateTimeBR(report.generatedAt)}</span>
          </div>

          {HEALTH_GROUPS.map((group) => {
            const checks = report.checks.filter((c) => c.group === group);
            if (checks.length === 0) return null;
            return (
              <section key={group} className="space-y-3">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{group}</h2>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {checks.map((check) => (
                    <CheckCard key={check.id} check={check} hours={report.historyHours} now={now} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}

      {!report && !error && <p className="py-10 text-center text-sm text-muted-foreground">Verificando serviços…</p>}
    </div>
  );
}
