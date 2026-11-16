"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ReceiptText, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { money } from "@/lib/formatters";
import type { MlTarifaVenda, MlTarifasJob, MlTarifasPendentes, MlTarifasResponse } from "@/lib/ml-reconciliation-contracts";
import { waitForMlJob } from "@/lib/ml-reconciliation-helpers";
import type { MlReconciliationService } from "@/lib/ml-reconciliation-service";
import { SourceError } from "./panel-state";
import { erroDe, JobProgress, MaisLinhas, PAGINA } from "./ml-reconciliation-view-parts";

const agora = () => Date.now();

function totalVenda(v: MlTarifaVenda): number {
  return v.linhas.reduce((s, l) => s + (l.tipo === "D" ? -l.valor : l.valor), 0);
}

/**
 * Tarifas, envios e extras de vendas JÁ baixadas que ainda não estão no caixa do Tiny: vendas
 * baixadas antes do lançamento automático (06/11/2026) ou em que ele falhou (ex.: HTTP 403).
 * Mesmas regras da baixa: valores do relatório, data da venda, histórico da conta baixada e contato
 * Mercado Livre (padrão do financeiro). Os lançados no padrão antigo, depois de apagados no Tiny,
 * voltam para a lista pela conferência.
 */
export function MlTarifasPendentes({
  service,
  empresaId,
  empresaNome,
  canLancar,
  onConcluido,
}: {
  service: MlReconciliationService;
  empresaId: string;
  empresaNome: string;
  canLancar: boolean;
  onConcluido?: () => void;
}) {
  const [incluirPlanilha, setIncluirPlanilha] = useState(false);
  const [dados, setDados] = useState<MlTarifasPendentes | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [limite, setLimite] = useState(PAGINA);

  const [dialogAberto, setDialogAberto] = useState(false);
  const [lancando, setLancando] = useState(false);
  const [job, setJob] = useState<MlTarifasJob | null>(null);
  const [inicio, setInicio] = useState(0);
  const [resultado, setResultado] = useState<MlTarifasResponse | null>(null);
  const [lancarErro, setLancarErro] = useState<string | null>(null);
  const [conferindo, setConferindo] = useState(false);
  const [conferido, setConferido] = useState<{ ok: boolean; texto: string } | null>(null);
  const [antigosMarcados, setAntigosMarcados] = useState<Set<string>>(new Set());
  const [refeitosAberto, setRefeitosAberto] = useState(false);
  const [marcando, setMarcando] = useState(false);

  // Busca sem setState síncrono: o efeito e "Atualizar" só disparam; o resultado chega no then.
  const buscar = useCallback(
    (signal?: AbortSignal) =>
      service
        .getTarifas(empresaId, incluirPlanilha, signal)
        .then((d) => {
          setDados(d);
          setErro(null);
          setSelecionadas((prev) => new Set([...prev].filter((id) => d.vendas.some((v) => v.grupo_id === id))));
        })
        .catch((e: unknown) => {
          if (!signal?.aborted) setErro(erroDe(e, "Falha ao consultar as tarifas pendentes."));
        })
        .finally(() => {
          if (!signal?.aborted) setCarregando(false);
        }),
    [service, empresaId, incluirPlanilha],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void buscar(ctrl.signal);
    return () => ctrl.abort();
  }, [buscar]);

  function carregar() {
    setCarregando(true);
    void buscar();
  }

  // Resposta de outra empresa/opção (troca em andamento) não vale: nem para mostrar, nem para lançar.
  const atual = dados && dados.empresa === empresaId && dados.incluir_exportados === incluirPlanilha ? dados : null;
  const vendas = useMemo(() => atual?.vendas ?? [], [atual]);
  const escolhidas = vendas.filter((v) => selecionadas.has(v.grupo_id));
  const linhasEscolhidas = escolhidas.reduce((n, v) => n + v.linhas.length, 0);
  const todasMarcadas = vendas.length > 0 && escolhidas.length === vendas.length;

  function conferir() {
    setConferindo(true);
    setConferido(null);
    service
      .conferirApagados(empresaId)
      .then((r) =>
        setConferido({
          ok: r.nao_conferidos === 0,
          texto:
            `${r.liberados} apagado(s) no Tiny voltaram para a lista; ${r.ainda_no_tiny} ainda estão no caixa.` +
            (r.nao_conferidos ? ` ${r.nao_conferidos} não puderam ser conferidos (caixa do dia não lido): tente de novo.` : ""),
        }),
      )
      .catch((e: unknown) => setConferido({ ok: false, texto: erroDe(e, "Falha ao conferir no Tiny.") }))
      .finally(() => {
        setConferindo(false);
        carregar();
      });
  }

  const antigos = useMemo(() => atual?.padrao_antigo ?? [], [atual]);
  const antigosEscolhidos = antigos.filter((a) => antigosMarcados.has(a.chave));
  const todosAntigosMarcados = antigos.length > 0 && antigosEscolhidos.length === antigos.length;

  function alternarAntigo(chave: string) {
    setAntigosMarcados((prev) => {
      const prox = new Set(prev);
      if (prox.has(chave)) prox.delete(chave);
      else prox.add(chave);
      return prox;
    });
  }

  // Refeitos à mão no Tiny: continuam contando como lançados e a conferência não os devolve mais.
  function marcarRefeitos() {
    const chaves = antigosEscolhidos.map((a) => a.chave);
    if (chaves.length === 0) return;
    setMarcando(true);
    setConferido(null);
    service
      .marcarRefeitos(empresaId, chaves)
      .then((r) => {
        setConferido({
          ok: true,
          texto:
            `${r.marcados} lançamento(s) marcado(s) como refeito(s) à mão: saíram da lista e não voltam para as pendentes.` +
            (r.ignorados ? ` ${r.ignorados} já não estavam na lista.` : ""),
        });
        setAntigosMarcados(new Set());
      })
      .catch((e: unknown) => setConferido({ ok: false, texto: erroDe(e, "Falha ao marcar como refeitos à mão.") }))
      .finally(() => {
        setMarcando(false);
        setRefeitosAberto(false);
        carregar();
      });
  }

  function alternar(id: string) {
    setSelecionadas((prev) => {
      const prox = new Set(prev);
      if (prox.has(id)) prox.delete(id);
      else prox.add(id);
      return prox;
    });
  }

  function abrir() {
    setJob(null);
    setResultado(null);
    setLancarErro(null);
    setDialogAberto(true);
  }

  async function confirmar() {
    if (escolhidas.length === 0) return;
    setLancando(true);
    setLancarErro(null);
    setInicio(agora());
    try {
      const inicial = await service.startLancarTarifas(empresaId, escolhidas.map((v) => v.grupo_id), incluirPlanilha);
      const final = await waitForMlJob((id, s) => service.getJob(id, s), inicial, { onProgress: setJob });
      setResultado(final.resultado);
      setSelecionadas(new Set());
    } catch (e) {
      setLancarErro(erroDe(e, "Falha no lançamento. Confira o caixa do Tiny antes de tentar de novo."));
    } finally {
      setLancando(false);
      carregar();
      onConcluido?.();
    }
  }

  return (
    <div className="panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 sm:px-4">
        <ReceiptText size={15} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Tarifas pendentes no caixa do Tiny</h2>
        <span className="text-[11px] text-muted-foreground">
          {empresaNome}: vendas já baixadas com tarifas, envios ou extras fora do caixa
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={carregar} disabled={carregando}>
            <RefreshCw size={13} className={carregando ? "animate-spin" : undefined} />
            Atualizar
          </Button>
          {canLancar && (
            <Button size="sm" className="gap-1.5" onClick={abrir} disabled={escolhidas.length === 0}>
              <CheckCircle2 size={13} />
              Lançar no caixa ({escolhidas.length})
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2 border-b border-border p-3 text-[11px] text-muted-foreground sm:px-4">
        <p className="flex gap-2">
          <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
          Cada linha entra no caixa com o valor e a categoria do relatório do Mercado Pago, na data da venda, com o histórico da
          conta baixada e o contato Mercado Livre (EBAZAR.COM.BR LTDA). O que já foi lançado por aqui nunca é lançado de novo.
        </p>
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox checked={incluirPlanilha} onCheckedChange={(v) => {
              setIncluirPlanilha(v === true);
              setLimite(PAGINA);
            }} className="mt-px" />
          <span>
            Incluir as linhas que já saíram numa planilha de lançamentos.{" "}
            <span className="text-amber-700 dark:text-amber-400">
              Só marque se essas planilhas NÃO foram importadas no Tiny: senão o lançamento fica duplicado.
            </span>
          </span>
        </label>
        {atual && atual.vendas_sem_leitura > 0 && (
          <p className="flex gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
            {atual.vendas_sem_leitura} venda(s) baixada(s) antiga(s) ainda sem as tarifas lidas: a próxima execução lê o relatório do
            dia da liberação delas e elas aparecem aqui.
          </p>
        )}
        {antigos.length > 0 && (
          <div className="space-y-1.5 border border-amber-300 bg-amber-50 p-2.5 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="flex flex-wrap items-start gap-2">
              <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {antigos.length} lançamento(s) no caixa foram feitos no padrão antigo (histórico &quot;Ref as tarifas…&quot; e contato =
                cliente). Para refazer no padrão novo: apague-os no caixa do Tiny e clique em &quot;Conferir no Tiny&quot; — os apagados
                voltam para esta lista. Se você já apagou e <strong>relançou à mão</strong> no Tiny, marque-os abaixo como
                &quot;refeitos à mão&quot; <strong>antes</strong> de conferir: senão eles voltam para a lista e lançar de novo duplica o caixa.
                Nada é apagado por aqui.
              </span>
              {canLancar && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={conferir} disabled={conferindo || marcando}>
                  <RefreshCw size={13} className={conferindo ? "animate-spin" : undefined} />
                  {conferindo ? "Conferindo…" : "Conferir no Tiny"}
                </Button>
              )}
            </div>
            <details>
              <summary className="cursor-pointer">Ver os lançamentos do padrão antigo</summary>
              {canLancar && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Checkbox
                    id={`antigos-todos-${empresaId}`}
                    checked={todosAntigosMarcados}
                    onCheckedChange={() => setAntigosMarcados(todosAntigosMarcados ? new Set() : new Set(antigos.map((a) => a.chave)))}
                  />
                  <label htmlFor={`antigos-todos-${empresaId}`} className="cursor-pointer">
                    Selecionar todos
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto gap-1.5"
                    onClick={() => setRefeitosAberto(true)}
                    disabled={antigosEscolhidos.length === 0 || marcando || conferindo}
                  >
                    <CheckCircle2 size={13} />
                    Marcar como refeitos à mão ({antigosEscolhidos.length})
                  </Button>
                </div>
              )}
              <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto tabular-nums">
                {antigos.map((a) => (
                  <li key={a.chave} className="flex items-start gap-1.5">
                    {canLancar && (
                      <Checkbox
                        checked={antigosMarcados.has(a.chave)}
                        onCheckedChange={() => alternarAntigo(a.chave)}
                        className="mt-px"
                        aria-label={`Selecionar o lançamento #${a.id} da venda ${a.venda}`}
                      />
                    )}
                    <span>
                      #{a.id} · {a.data.split("-").reverse().join("/")} · venda {a.venda} · {a.tipo === "D" ? "−" : "+"}
                      {money(a.valor)} · {a.historico}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {conferido && (
          <output className={`block ${conferido.ok ? "text-foreground" : "text-amber-700 dark:text-amber-400"}`}>
            {conferido.texto}
          </output>
        )}
      </div>

      {erro && (
        <div className="p-3">
          <SourceError message={erro} reportar={{ automationId: "ml-reconciliation", executionId: "tarifas-pendentes" }} />
        </div>
      )}
      {!erro && atual && vendas.length === 0 && (
        <div className="px-5 py-8 text-center text-xs text-muted-foreground">Nenhuma venda baixada com tarifa fora do caixa.</div>
      )}
      {!erro && !atual && <div className="px-5 py-8 text-center text-xs text-muted-foreground">Carregando…</div>}

      {vendas.length > 0 && (
        <>
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  {canLancar && (
                    <Checkbox
                      checked={todasMarcadas}
                      onCheckedChange={() => setSelecionadas(todasMarcadas ? new Set() : new Set(vendas.map((v) => v.grupo_id)))}
                      aria-label="Selecionar todas"
                    />
                  )}
                </TableHead>
                <TableHead>Venda</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Linhas para o caixa</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendas.slice(0, limite).map((v) => {
                const marcada = selecionadas.has(v.grupo_id);
                return (
                  <TableRow
                    key={v.grupo_id}
                    data-state={marcada ? "selected" : undefined}
                    onClick={canLancar ? () => alternar(v.grupo_id) : undefined}
                    className={canLancar ? "cursor-pointer align-top" : "align-top"}
                  >
                    <TableCell>
                      {canLancar && (
                        <Checkbox
                          checked={marcada}
                          onCheckedChange={() => alternar(v.grupo_id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Selecionar ${v.nome_cliente}, venda ${v.id_venda}`}
                        />
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {v.id_venda}
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        venda {v.data_venda || "sem data"} · conta #{v.conta_id}
                      </div>
                    </TableCell>
                    <TableCell>{v.nome_cliente}</TableCell>
                    <TableCell>
                      <ul className="space-y-0.5 text-[11px]">
                        {v.linhas.map((l) => (
                          <li key={l.chave} className="flex flex-wrap items-center gap-1.5">
                            <span className="text-foreground">{l.tipo_operacao}</span>
                            <span className="text-muted-foreground">· {l.categoria}</span>
                            <span className="tabular-nums">
                              {l.tipo === "D" ? "−" : "+"}
                              {money(l.valor)}
                            </span>
                            {l.na_planilha && <Badge variant="outline">já na planilha</Badge>}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{money(totalVenda(v))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <MaisLinhas mostrando={limite} total={vendas.length} onMais={() => setLimite((l) => l + PAGINA)} />
        </>
      )}

      <AlertDialog
        open={refeitosAberto}
        onOpenChange={(open) => {
          if (!open && !marcando) setRefeitosAberto(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-semibold">Marcar como refeitos à mão</AlertDialogTitle>
            <AlertDialogDescription>
              {antigosEscolhidos.length} lançamento(s) do padrão antigo de {empresaNome} saem desta lista e continuam contando como
              lançados: &quot;Conferir no Tiny&quot; não os devolve mais para as pendentes. Use só se eles já foram relançados à mão no
              caixa do Tiny. Nada é alterado no Tiny.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={marcando}>Cancelar</AlertDialogCancel>
            <Button onClick={marcarRefeitos} disabled={marcando || antigosEscolhidos.length === 0} className="gap-1.5">
              {marcando ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {marcando ? "Marcando…" : `Confirmar (${antigosEscolhidos.length})`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dialogAberto}
        onOpenChange={(open) => {
          if (!open && !lancando) setDialogAberto(false);
        }}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-semibold">
              {resultado ? "Resultado do lançamento no caixa" : lancando ? "Lançando no caixa do Tiny" : "Confirmar lançamento no caixa do Tiny"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resultado
                ? `${resultado.total_lancamentos} lançamento(s) criado(s) em ${resultado.total_solicitados} venda(s); ${resultado.total_falhas} com falha.`
                : lancando
                  ? "Cada conta é relida no Tiny para pegar o histórico antes de lançar."
                  : `${linhasEscolhidas} lançamento(s) de ${escolhidas.length} venda(s) de ${empresaNome}, na data de cada venda.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {lancando && (
            <div className="rounded-none border border-border bg-muted/40 p-3">
              <JobProgress job={job} startedAt={inicio} texto="Andamento do lançamento" />
            </div>
          )}

          {resultado && (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-none border border-border text-xs">
              {resultado.resultados.map((r) => (
                <li key={r.grupo_id} className="flex items-start justify-between gap-3 p-2.5">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">
                      {r.nome_cliente || r.grupo_id} {r.id_venda ? `· venda ${r.id_venda}` : ""}
                    </div>
                    <div className="break-words text-[11px] text-muted-foreground">{r.mensagem}</div>
                  </div>
                  <Badge variant={r.status === "sucesso" ? "success" : r.status === "parcial" ? "warning" : "danger"} className="shrink-0">
                    {r.status === "sucesso" ? "Lançado" : r.status === "parcial" ? "Parcial" : "Falhou"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {lancarErro && (
            <div role="alert" className="rounded-none border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {lancarErro}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={lancando}>{resultado || lancarErro ? "Fechar" : "Cancelar"}</AlertDialogCancel>
            {!resultado && !lancarErro && (
              <Button onClick={() => void confirmar()} disabled={lancando || escolhidas.length === 0} className="gap-1.5">
                {lancando ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {lancando ? "Lançando…" : `Confirmar (${linhasEscolhidas} lançamento(s))`}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
