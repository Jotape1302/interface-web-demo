'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AREAS, AREA_SUMMARY, type AreaComVisaoGeral } from '@/lib/areas';
import type { AcaoPendente, AutomacaoResumo, VisaoGeralArea } from '@/lib/area-overview-contracts';
import { DESCRICAO_POR_HREF, ROTULO_SEVERIDADE, ROTULO_STATUS, resumirVisaoGeral } from '@/lib/area-overview-helpers';
import { fetchVisaoGeral } from '@/lib/area-overview-service';
import { isDemoSession } from '@/lib/demo-session';
import { formatDateTimeBR, formatTimeBR } from '@/lib/formatters';
import { useDataPolling } from '@/lib/use-data-polling';

const SEVERIDADE_CLASSE: Record<AcaoPendente['severidade'], string> = {
  critica: 'border-l-rose-600',
  atencao: 'border-l-amber-500',
  info: 'border-l-border',
};
const SEVERIDADE_BADGE: Record<AcaoPendente['severidade'], 'danger' | 'warning' | 'secondary'> = {
  critica: 'danger',
  atencao: 'warning',
  info: 'secondary',
};
const STATUS_BADGE: Record<AutomacaoResumo['status'], 'success' | 'warning' | 'danger' | 'secondary'> = {
  ok: 'success',
  atencao: 'warning',
  erro: 'danger',
  sem_dados: 'secondary',
};

const SECTION_TITLE = 'text-xs font-bold uppercase tracking-wider text-muted-foreground';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function Indicador({ rotulo, valor, destaque }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div className="rounded-none border border-border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{rotulo}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${destaque ? 'text-rose-600' : 'text-foreground'}`}>{valor}</p>
    </div>
  );
}

function LinkAcao({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  // Arquivos servidos pelo NGINX (ex.: instalador) não são rotas do app.
  if (href.startsWith('/downloads/')) {
    return (
      <a href={`${BASE_PATH}${href}`} download className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

const BOTAO_ACAO =
  'inline-flex h-9 shrink-0 items-center justify-center rounded-none border border-[var(--marca-marinho)] bg-[var(--marca-marinho)] px-3.5 text-xs font-semibold text-white transition hover:border-[var(--marca-ambar)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--marca-ambar)]';

function AcaoItem({ acao }: { acao: AcaoPendente }) {
  return (
    <li className={`flex flex-col gap-3 border border-l-4 border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between ${SEVERIDADE_CLASSE[acao.severidade]}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERIDADE_BADGE[acao.severidade]} className="rounded-none text-[10px]">
            {ROTULO_SEVERIDADE[acao.severidade]}
          </Badge>
          <span className="text-[11px] text-muted-foreground">{acao.automacao}</span>
        </div>
        <p className="text-sm font-semibold text-foreground">
          {acao.titulo}
          {acao.quantidade !== null && <span className="ml-2 tabular-nums">({acao.quantidade})</span>}
        </p>
        <p className="text-xs text-muted-foreground">{acao.descricao}</p>
        {acao.desde && <p className="text-[11px] text-muted-foreground">Desde {formatDateTimeBR(acao.desde)}</p>}
      </div>
      <LinkAcao href={acao.href} className={BOTAO_ACAO}>
        {acao.acao}
      </LinkAcao>
    </li>
  );
}

function AutomacaoCard({ a }: { a: AutomacaoResumo }) {
  const descricao = a.indicadores.length === 0 ? DESCRICAO_POR_HREF[a.href] : undefined;
  return (
    <li className="flex flex-col justify-between gap-3 rounded-none border border-border bg-card p-4">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{a.titulo}</h3>
          <Badge variant={STATUS_BADGE[a.status]} className="rounded-none text-[10px]">
            {ROTULO_STATUS[a.status]}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {a.ultimaExecucao ? `Última execução ${formatDateTimeBR(a.ultimaExecucao)}` : 'Sem execução registrada'}
        </p>
        {a.indicadores.length > 0 && (
          <dl className="grid grid-cols-2 gap-2 pt-1">
            {a.indicadores.map((i) => (
              <div key={i.rotulo}>
                <dt className="text-[11px] text-muted-foreground">{i.rotulo}</dt>
                <dd className="text-sm font-semibold tabular-nums text-foreground">{i.valor}</dd>
              </div>
            ))}
          </dl>
        )}
        {descricao && <p className="text-xs text-muted-foreground">{descricao}</p>}
      </div>
      <LinkAcao href={a.href} className="text-xs font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--marca-ambar)]">
        Abrir {a.titulo}
      </LinkAcao>
    </li>
  );
}

function Esqueleto() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando a visão geral">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[84px] animate-pulse rounded-none border border-border bg-card" />
        ))}
      </div>
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-none border border-border bg-card" />
        ))}
      </div>
    </div>
  );
}

export default function AreaOverview({ area, children }: { area: AreaComVisaoGeral; children?: React.ReactNode }) {
  const [data, setData] = useState<VisaoGeralArea | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const titulo = AREAS.find((a) => a.id === area)?.title ?? area;

  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await fetchVisaoGeral(area, signal);
        if (signal.aborted) return;
        setData(result);
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Não foi possível carregar a visão geral.');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [area],
  );

  const { refresh } = useDataPolling(fetcher, { intervalMs: 60_000, pauseOnHidden: true, enabled: !isDemoSession() || data === null });
  const resumo = data ? resumirVisaoGeral(data) : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</p>
          <h1 className="text-xl font-bold text-foreground">Visão geral de {titulo}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{AREA_SUMMARY[area]}</p>
        </div>
        <div className="flex items-center gap-3">
          {data && <span className="text-[11px] text-muted-foreground">Atualizado às {formatTimeBR(data.geradoEm)}</span>}
          <Button
            type="button"
            onClick={() => void refresh()}
            className="h-8 gap-1.5 rounded-none border border-border bg-secondary px-3 text-xs font-semibold text-foreground hover:bg-accent"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Atualizar
          </Button>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-none border border-rose-300 bg-card p-4 text-sm">
          <p className="text-foreground">{error}</p>
          <Button type="button" onClick={() => void refresh()} className="h-8 rounded-none px-3 text-xs">
            Tentar novamente
          </Button>
        </div>
      )}

      {loading && !data && <Esqueleto />}

      {data && resumo && (
        <>
          <section aria-label="Indicadores da área" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador rotulo="Ações pendentes" valor={String(resumo.totalAcoes)} />
            <Indicador rotulo="Críticas" valor={String(resumo.criticas)} destaque={resumo.criticas > 0} />
            <Indicador rotulo="Automações com atenção ou erro" valor={String(resumo.automacoesComProblema)} />
            <Indicador rotulo="Serviços conectados" valor={`${resumo.servicosConectados}/${resumo.servicosTotal}`} />
          </section>

          {data.indisponiveis.length > 0 && (
            <p className="border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
              Alguns dados não puderam ser consultados: {data.indisponiveis.map((i) => `${i.fonte} (${i.mensagem})`).join('; ')}.
            </p>
          )}

          <section aria-label="Ações pendentes" className="space-y-3">
            <h2 className={SECTION_TITLE}>
              Ações pendentes <span className="ml-1 tabular-nums">({resumo.totalAcoes})</span>
            </h2>
            {data.acoesPendentes.length === 0 ? (
              <p className="border border-border bg-card p-4 text-sm text-muted-foreground">Nenhuma ação pendente</p>
            ) : (
              <ul className="space-y-2">
                {data.acoesPendentes.map((a) => (
                  <AcaoItem key={a.id} acao={a} />
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Automações da área" className="space-y-3">
            <h2 className={SECTION_TITLE}>Automações da área</h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.automacoes.map((a) => (
                <AutomacaoCard key={a.id} a={a} />
              ))}
            </ul>
          </section>

          {children}

          <section aria-label="Status dos serviços" className="space-y-3">
            <h2 className={SECTION_TITLE}>Status dos serviços</h2>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {data.servicos.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-none border border-border bg-card px-3 py-2.5">
                  <span className="text-sm font-medium text-foreground">{s.nome}</span>
                  <Badge variant={s.conectado ? 'success' : 'danger'} className="rounded-none text-[10px]" title={s.mensagem}>
                    {s.conectado ? 'Conectado' : 'Sem conexão'}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
