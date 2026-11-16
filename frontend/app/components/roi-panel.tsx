'use client';

import { CircleDollarSign, Clock3, Download, RefreshCw, ShieldAlert, TrendingUp, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { downloadCsv } from '@/lib/csv-export';
import { count, dateTime, decimal, formatTimeSaved, money } from '@/lib/formatters';
import {
  ROI_ESCOLHA_PADRAO,
  ROI_PRESETS,
  lerEscolhaSalva,
  roiPeriodoDaEscolha,
  roiPeriodoRotulo,
  roiPeriodoSufixoArquivo,
  salvarEscolha,
  type RoiPeriodoEscolha,
  type RoiPeriodoPreset,
} from '@/lib/roi-period';
import { ROI_CSV_HEADERS, minutosEconomizados, roiCsvPeriodoLinha, roiCsvRows } from '@/lib/roi-service';
import { useRoi } from '@/lib/use-roi';
import { SourceError } from './panel-state';

// Abaixo de 1 min mostra em segundos (5 s por produto não vira "0,08 min").
const minutos = (value: number) =>
  value > 0 && value < 1 ? `${Math.round(value * 60)} s` : `${decimal.format(value)} min`;

// ROI de todas as automações: itens concluídos × (tempo manual − tempo atual) × R$ 11/h.
// Exclusivo de quem tem `roi:ver` (o gateway também devolve 403 aos demais).
export default function RoiPanel() {
  const { can } = useAuth();
  const canView = can('roi:ver');
  const [escolha, setEscolha] = useState<RoiPeriodoEscolha>(ROI_ESCOLHA_PADRAO);
  const [restaurado, setRestaurado] = useState(false);
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- restaura a escolha do sessionStorage uma vez, após montar (evita divergência com o HTML estático)
    setEscolha(lerEscolhaSalva());
    setRestaurado(true);
  }, []);
  const periodo = useMemo(() => roiPeriodoDaEscolha(escolha), [escolha]);
  const { data, loading, error, refresh } = useRoi(canView && restaurado, periodo);
  const mudar = (proxima: RoiPeriodoEscolha) => {
    setEscolha(proxima);
    salvarEscolha(proxima);
  };
  const rotulo = roiPeriodoRotulo(data?.periodo ?? periodo);

  if (!canView) {
    return (
      <section role="alert" className="mx-auto max-w-xl py-16 text-center">
        <ShieldAlert size={28} className="mx-auto mb-3 text-muted-foreground" />
        <h1 className="text-lg font-bold text-foreground">Você não tem acesso a esta aba</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Peça ao administrador para liberar <strong className="text-foreground">ROI das automações</strong> em Gestão de Usuários.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Administração</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <TrendingUp size={22} className="text-primary" />
            ROI das automações
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Itens concluídos × (tempo manual − tempo atual) por item, valorizados a {data ? money(data.valorHora) : 'R$ 11,00'} por hora.
            {data && ` Atualizado em ${dateTime(data.generatedAt)}.`}
          </p>
        </div>
        <div className="flex gap-2 self-start sm:self-auto">
          <button
            type="button"
            disabled={!data}
            onClick={() => data && downloadCsv(`roi-automacoes${roiPeriodoSufixoArquivo(data.periodo)}`, ROI_CSV_HEADERS, [...roiCsvRows(data), [], roiCsvPeriodoLinha(data)])}
            className="flex cursor-pointer items-center gap-1.5 border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
          >
            <Download size={14} />
            Exportar CSV
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex cursor-pointer items-center gap-1.5 border border-border bg-muted/60 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
        </div>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-wrap items-end gap-3 border-0 p-0" aria-label="Período do ROI">
        <label className="text-xs font-medium text-muted-foreground">
          Período
          <select
            value={escolha.preset}
            onChange={(e) => mudar({ ...escolha, preset: e.target.value as RoiPeriodoPreset })}
            className="mt-1 block h-9 rounded-none border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          >
            {ROI_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>
        {escolha.preset === 'personalizado' && (
          <>
            <label className="text-xs font-medium text-muted-foreground">
              De
              <input
                type="date"
                value={escolha.de}
                max={escolha.ate || undefined}
                onChange={(e) => mudar({ ...escolha, de: e.target.value })}
                className="mt-1 block h-9 rounded-none border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Até
              <input
                type="date"
                value={escolha.ate}
                min={escolha.de || undefined}
                onChange={(e) => mudar({ ...escolha, ate: e.target.value })}
                className="mt-1 block h-9 rounded-none border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
              />
            </label>
          </>
        )}
        <p className="pb-2 text-xs text-muted-foreground">Mostrando {rotulo}</p>
      </fieldset>

      {error && (
        <div role="alert" className="space-y-2">
          <SourceError message={error} />
          <button type="button" onClick={() => void refresh()} className="cursor-pointer text-xs font-medium text-primary underline">
            Tentar novamente
          </button>
        </div>
      )}

      {!data && loading && (
        <div className="space-y-3" aria-label="Carregando ROI">
          <div className="metric-grid">
            <div className="metric-card skeleton" />
            <div className="metric-card skeleton" />
          </div>
          <div className="panel skeleton h-64" />
        </div>
      )}

      {data && (
        <>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Totais {rotulo}</h2>
          <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <article className="metric-card">
              <div className="metric-top">
                <span>R$ economizados</span>
                <span className="metric-icon text-primary"><CircleDollarSign size={16} /></span>
              </div>
              <div className="metric-value">{money(data.totais.reais)}</div>
              <div className="metric-detail">Capacidade liberada a {money(data.valorHora)}/h</div>
              <span className="estimate-label">Ganho estimado</span>
            </article>
            <article className="metric-card">
              <div className="metric-top">
                <span>Horas economizadas</span>
                <span className="metric-icon text-primary"><Clock3 size={16} /></span>
              </div>
              <div className="metric-value">{formatTimeSaved(data.totais.horasEconomizadas)}</div>
              <div className="metric-detail">{decimal.format(data.totais.horasEconomizadas)} h decimais</div>
              <span className="estimate-label">Produtividade da equipe</span>
            </article>
          </div>

          {data.totais.parcial && (
            <output className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              Total parcial: alguma fonte não respondeu e ficou fora da soma. Veja a situação de cada automação abaixo.
            </output>
          )}

          <section className="panel" aria-label="ROI por automação">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-[var(--marca-marinho)] text-[11px] uppercase tracking-wider text-white">
                    <th className="p-3 font-semibold">Automação</th>
                    <th className="p-3 text-right font-semibold">Itens</th>
                    <th className="p-3 font-semibold">Feito à mão (por item)</th>
                    <th className="p-3 font-semibold">Hoje na interface (por item)</th>
                    <th className="p-3 text-right font-semibold">Economia/item</th>
                    <th className="p-3 text-right font-semibold">Horas</th>
                    <th className="p-3 text-right font-semibold">R$</th>
                  </tr>
                </thead>
                <tbody>
                  {data.automacoes.map((a) => (
                    <tr key={a.id} className="border-b border-border/60 align-top">
                      <td className="p-3">
                        <div className="font-semibold text-foreground">{a.titulo}</div>
                        <div className="text-muted-foreground">{a.unidade}</div>
                        {a.fonte.status === 'erro' && (
                          <div role="alert" className="mt-1 flex items-start gap-1 text-rose-600 dark:text-rose-400">
                            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                            {a.fonte.mensagem ?? 'A fonte de dados não respondeu; fora do total.'}
                          </div>
                        )}
                        {a.observacao && <div className="mt-1 text-muted-foreground">{a.observacao}</div>}
                      </td>
                      <td className="p-3 text-right tabular-nums">{a.itens === null ? '—' : count(a.itens)}</td>
                      <td className="p-3">
                        <div className="font-medium tabular-nums">{minutos(a.minutosManual)}</div>
                        <div className="text-muted-foreground">{a.tarefaManual}</div>
                      </td>
                      <td className="p-3">
                        <div className="font-medium tabular-nums">{minutos(a.minutosAtual)}</div>
                        <div className="text-muted-foreground">{a.tarefaAtual}</div>
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">{minutos(minutosEconomizados(a))}</td>
                      <td className="p-3 text-right tabular-nums">{a.horasEconomizadas === null ? '—' : `${decimal.format(a.horasEconomizadas)} h`}</td>
                      <td className="p-3 text-right font-semibold tabular-nums">{a.reais === null ? '—' : money(a.reais)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/40 font-bold">
                    <td className="p-3" colSpan={5}>Total{data.totais.parcial ? ' (parcial)' : ''}</td>
                    <td className="p-3 text-right tabular-nums">{decimal.format(data.totais.horasEconomizadas)} h</td>
                    <td className="p-3 text-right tabular-nums">{money(data.totais.reais)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {data.naoMedidas.length > 0 && (
            <section className="panel p-4" aria-label="Automações fora da conta">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Fora da conta</h2>
              <ul className="mt-2 space-y-2 text-xs">
                {data.naoMedidas.map((n) => (
                  <li key={n.id}>
                    <strong className="text-foreground">{n.titulo}</strong>
                    <span className="text-muted-foreground"> — {n.motivo}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
