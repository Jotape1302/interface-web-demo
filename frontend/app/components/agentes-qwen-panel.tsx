'use client';

import { useCallback, useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDataPolling } from '@/lib/use-data-polling';
import { Badge } from '@/components/ui/badge';
import { formatDateTimeBR } from '@/lib/formatters';
import {
  ESTADO_ROTULO,
  EVENTO_ROTULO,
  GRUPOS,
  agruparIncidentes,
  desatualizado,
  makeDemoAgentesQwen,
  textoAcompanhamento,
  type AgentesQwenGrupo,
  type AgentesQwenIncidente,
  type AgentesQwenResposta,
} from '@/lib/agentes-qwen';

const AUTO_REFRESH_MS = 60_000;

const BADGE_VARIANT: Record<AgentesQwenGrupo, 'success' | 'warning' | 'danger' | 'info' | 'secondary'> = {
  precisa_ti: 'danger',
  pr_pendente: 'warning',
  aguardando_deploy: 'warning',
  monitorando: 'info',
  em_andamento: 'secondary',
  resolvido: 'success',
};

function Acompanhamento({ inc }: { inc: AgentesQwenIncidente }) {
  const texto = textoAcompanhamento(inc, formatDateTimeBR);
  if (!texto) return null;
  const ac = inc.acompanhamento;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{texto}</p>
      {ac?.modo === 'rota' && (
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: ac.alvo }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 ${
                i >= ac.acompanhadas ? 'bg-muted' : i < ac.acompanhadas - ac.sucessos ? 'bg-rose-500' : 'bg-emerald-500'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MarcarResolvido({ inc, pendente, onResolver }: { inc: AgentesQwenIncidente; pendente: boolean; onResolver: (id: number, nota: string) => Promise<string | null> }) {
  const [abrindo, setAbrindo] = useState(false);
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  if (pendente) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 size={13} />
        Marcado como resolvido: o PC dos agentes confirma em até 1 min.
      </p>
    );
  }
  if (!abrindo) {
    return (
      <button
        type="button"
        onClick={() => setAbrindo(true)}
        className="flex cursor-pointer items-center gap-1.5 self-start rounded-none border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
      >
        <CheckCircle2 size={14} />
        Marcar como resolvido
      </button>
    );
  }
  const enviar = async () => {
    setEnviando(true);
    const falha = await onResolver(inc.id, nota);
    setEnviando(false);
    if (falha) setErro(falha);
  };
  return (
    <div className="space-y-2 border border-border bg-muted/40 p-2">
      <label className="block text-[11px] text-muted-foreground" htmlFor={`nota-${inc.id}`}>
        O que foi feito (opcional; vai para o histórico e para a RAG da resolução)
      </label>
      <textarea
        id={`nota-${inc.id}`}
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        rows={2}
        maxLength={2000}
        className="w-full rounded-none border border-border bg-card p-2 text-xs text-foreground"
        placeholder="ex.: o Mercado Pago demorou; rodei a conciliação de novo"
      />
      {erro && <p className="text-[11px] text-rose-600 dark:text-rose-400">{erro}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={enviando}
          onClick={() => void enviar()}
          className="cursor-pointer rounded-none bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button
          type="button"
          onClick={() => setAbrindo(false)}
          className="cursor-pointer rounded-none border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

function IncidenteCard({
  inc,
  podeResolver,
  pendente,
  onResolver,
}: {
  inc: AgentesQwenIncidente;
  podeResolver: boolean;
  pendente: boolean;
  onResolver: (id: number, nota: string) => Promise<string | null>;
}) {
  const [aberto, setAberto] = useState(false);
  return (
    <article className="flex flex-col gap-3 rounded-none border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Incidente #{inc.id} · {inc.servico ?? 'serviço'}
          </h3>
          <p className="truncate text-[11px] text-muted-foreground" title={inc.rota ?? inc.evento ?? ''}>
            {inc.rota ?? inc.evento ?? '-'} · volta {inc.volta} · {inc.ocorrencias} ocorrência(s)
          </p>
        </div>
        <Badge variant={BADGE_VARIANT[inc.grupo]} className="shrink-0 text-[10px]">
          {ESTADO_ROTULO[inc.estado] ?? inc.estado}
        </Badge>
      </header>

      {inc.diagnostico && <p className="text-xs leading-relaxed text-foreground">{inc.diagnostico}</p>}
      {inc.mensagem && <p className="break-words font-mono text-[11px] text-muted-foreground">{inc.mensagem}</p>}
      {inc.nota && inc.grupo !== 'resolvido' && (
        <p className="border-l-2 border-amber-500 pl-2 text-xs text-amber-800 dark:text-amber-300">{inc.nota}</p>
      )}

      {inc.pr && (
        <dl className="space-y-1 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">PR</dt>
            <dd>
              <a href={inc.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                {inc.pr.numero ? `#${inc.pr.numero}` : 'abrir'}
                <ExternalLink size={11} />
              </a>
            </dd>
          </div>
          {inc.pr.aprovadoEm && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Aprovado</dt>
              <dd className="text-right text-foreground">
                {formatDateTimeBR(inc.pr.aprovadoEm)}
                {inc.pr.aprovadoPor && ` · ${inc.pr.aprovadoPor}`}
              </dd>
            </div>
          )}
          {inc.deployEm && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Em produção desde</dt>
              <dd className="text-right text-foreground">{formatDateTimeBR(inc.deployEm)}</dd>
            </div>
          )}
        </dl>
      )}
      {inc.grupo === 'pr_pendente' && inc.pr && (
        <p className="text-[11px] text-muted-foreground">
          Para aprovar, ponha o rótulo <strong className="text-foreground">aprovado</strong> no PR: o monitor faz o merge com o CI verde.
        </p>
      )}

      {inc.deploy.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">Rode na VPS:</p>
          <pre className="overflow-x-auto border border-border bg-muted/60 p-2 text-[11px] leading-relaxed text-foreground">
            {inc.deploy.join('\n')}
          </pre>
        </div>
      )}

      <Acompanhamento inc={inc} />

      {podeResolver && inc.grupo !== 'resolvido' && <MarcarResolvido inc={inc} pendente={pendente} onResolver={onResolver} />}

      {inc.historico.length > 0 && (
        <div className="border-t border-border/60 pt-2">
          <button type="button" onClick={() => setAberto((v) => !v)} className="cursor-pointer text-[11px] font-medium text-primary hover:underline">
            {aberto ? 'Esconder histórico' : `Histórico (${inc.historico.length})`}
          </button>
          {aberto && (
            <ol className="mt-2 space-y-1 text-[11px]">
              {inc.historico.map((h, i) => (
                <li key={`${h.em}-${i}`} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">{formatDateTimeBR(h.em)}</span>
                  <span className="text-foreground">
                    {EVENTO_ROTULO[h.evento] ?? h.evento}
                    {h.volta > 1 && ` (volta ${h.volta})`}
                    {h.detalhe && <span className="text-muted-foreground"> · {h.detalhe}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <p className="mt-auto text-[10px] text-muted-foreground">Atualizado em {formatDateTimeBR(inc.atualizadoEm)}</p>
    </article>
  );
}

// Agentes Qwen: histórico das correções automáticas dos erros de produção (PR pendente, loop que
// precisa do TI, deploy, acompanhamento das 5 execuções). Exclusivo de quem tem `agentes_qwen:ver`
// (o gateway também devolve 403 aos demais); os avisos vão só para essas pessoas.
export default function AgentesQwenPanel() {
  const { token, apiBaseUrl, can } = useAuth();
  const canView = can('agentes_qwen:ver');
  const podeResolver = can('agentes_qwen:resolver');
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  const [dados, setDados] = useState<AgentesQwenResposta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (isDemo) {
        setDados(makeDemoAgentesQwen());
        return;
      }
      if (!token) return;
      setLoading(true);
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/agentes-qwen`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDados((await res.json()) as AgentesQwenResposta);
        setError('');
      } catch {
        if (signal?.aborted) return;
        setError('Não foi possível consultar os agentes Qwen. O gateway pode estar fora do ar.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiBaseUrl, isDemo, token],
  );

  // Pedido guardado no gateway e entregue ao PC no próximo repasse do coletor (até 1 min).
  const resolver = useCallback(
    async (id: number, nota: string): Promise<string | null> => {
      if (isDemo) {
        setDados((d) => (d ? { ...d, resolucoesPendentes: [...d.resolucoesPendentes, id] } : d));
        return null;
      }
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/agentes-qwen/incidentes/${id}/resolver`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nota }),
        });
        if (!res.ok) {
          const corpo = (await res.json().catch(() => ({}))) as { error?: string };
          return corpo.error ?? `Não foi possível marcar como resolvido (HTTP ${res.status}).`;
        }
        const { resolucoesPendentes } = (await res.json()) as { resolucoesPendentes: number[] };
        setDados((d) => (d ? { ...d, resolucoesPendentes } : d));
        return null;
      } catch {
        return 'Não foi possível marcar como resolvido. O gateway pode estar fora do ar.';
      }
    },
    [apiBaseUrl, isDemo, token],
  );

  useDataPolling((signal) => load(signal), { intervalMs: AUTO_REFRESH_MS, enabled: canView, pauseOnHidden: true, refetchOnVisible: true });

  if (!canView) {
    return (
      <section role="alert" className="mx-auto max-w-xl py-16 text-center">
        <ShieldAlert size={28} className="mx-auto mb-3 text-muted-foreground" />
        <h1 className="text-lg font-bold text-foreground">Você não tem acesso a esta aba</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Peça ao administrador para liberar <strong className="text-foreground">Agentes Qwen</strong> em Gestão de Usuários.
        </p>
      </section>
    );
  }

  const estado = dados?.estado ?? null;
  const grupos = estado ? agruparIncidentes(estado.incidentes) : null;
  // oxlint-disable-next-line react/react-compiler -- horário de referência do aviso de estado antigo, recalculado a cada carga
  const parado = dados ? desatualizado(dados.recebidoEm, Date.now()) : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Administração</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <Bot size={22} className="text-primary" />
            Agentes Qwen
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Correções automáticas dos erros de produção: PRs para aprovar, loops que precisam de você, deploy e as 5 execuções acompanhadas depois dele.
            {dados?.recebidoEm && ` Estado recebido em ${formatDateTimeBR(dados.recebidoEm)}.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex cursor-pointer items-center gap-1.5 self-start rounded-none border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-60 sm:self-auto"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Atualizar
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-none border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {dados && parado && (
        <div className="rounded-none border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          {dados.recebidoEm
            ? `Sem estado novo desde ${formatDateTimeBR(dados.recebidoEm)}: o PC do TI, o túnel SSH ou o coletor de incidentes está fora. A tela mostra o último estado recebido.`
            : 'Nenhum estado recebido ainda: confira o túnel SSH, o coletor de incidentes (GATEWAY_ESTADO_URL) e o AGENTES_QWEN_TOKEN do gateway.'}
        </div>
      )}

      {grupos && (
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {GRUPOS.map((g) => (
            <a key={g.id} href={`#${g.id}`} className="rounded-none border border-border bg-card p-3 transition hover:bg-muted/60">
              <p className="text-[11px] text-muted-foreground">{g.titulo}</p>
              <p className={`text-2xl font-bold ${g.id === 'precisa_ti' && grupos[g.id].length > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
                {grupos[g.id].length}
              </p>
            </a>
          ))}
        </div>
      )}

      {grupos &&
        GRUPOS.map((g) => (
          <section key={g.id} id={g.id} className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {g.titulo} ({grupos[g.id].length})
            </h2>
            {grupos[g.id].length === 0 ? (
              <p className="text-xs text-muted-foreground">{g.vazio}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {grupos[g.id].map((inc) => (
                  <IncidenteCard
                    key={inc.id}
                    inc={inc}
                    podeResolver={podeResolver}
                    pendente={dados?.resolucoesPendentes.includes(inc.id) ?? false}
                    onResolver={resolver}
                  />
                ))}
              </div>
            )}
          </section>
        ))}

      {!dados && !error && <p className="py-10 text-center text-sm text-muted-foreground">Consultando os agentes…</p>}
    </div>
  );
}
