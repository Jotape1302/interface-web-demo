"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, CheckCheck, FilePlus2, Link2, Loader2, Play, RefreshCw, RotateCcw, ShieldAlert, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConferirCard, SemContaCard } from "./dda-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModalShell } from "./modal-shell";
import { SourceError } from "./panel-state";
import { useAuth } from "@/lib/auth-context";
import { money, formatDateTimeBR } from "@/lib/formatters";
import { companyLabel, RECONCILIATION_COMPANIES } from "@/lib/reconciliation-helpers";
import type { DdaBoleto, DdaCategoria, DdaStatus } from "@/lib/dda-contracts";
import {
  acoesDoBoleto,
  aguardandoValidacao,
  aprovacoesTexto,
  boletoNoFiltro,
  categoriaSugerida,
  historicoPadrao,
  situacaoMeta,
  contarPorFiltro,
  dataBR,
  documentoFormatado,
  type DdaFiltro,
} from "@/lib/dda-helpers";
import { DdaService } from "@/lib/dda-service";
import { resolveApiBaseUrl } from "@/lib/contracts";
import { cn } from "@/lib/utils";

const FILTROS: Array<{ id: DdaFiltro; label: string }> = [
  { id: "acao", label: "Pedem ação" },
  { id: "andamento", label: "Em andamento" },
  { id: "finalizados", label: "Finalizados" },
  { id: "todos", label: "Todos" },
];

type Modal =
  | { tipo: "criar"; boleto: DdaBoleto }
  | { tipo: "escolher"; boleto: DdaBoleto }
  | { tipo: "descartar"; boleto: DdaBoleto }
  | null;

export default function DdaView({ apiBaseUrl }: { apiBaseUrl?: string }) {
  // Mesmo resolvedor dos outros serviços: em produção a API fica sob /automacoes/api (NGINX).
  const service = useMemo(() => new DdaService(resolveApiBaseUrl(apiBaseUrl)), [apiBaseUrl]);
  const { can } = useAuth();
  const podeAgir = can("contas_pagar:baixar");

  const [status, setStatus] = useState<DdaStatus | null>(null);
  const [boletos, setBoletos] = useState<DdaBoleto[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<DdaFiltro>("acao");
  const [empresa, setEmpresa] = useState("todas");
  const [executando, setExecutando] = useState(false);
  const [aviso, setAviso] = useState<{ tom: "ok" | "erro"; texto: string } | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  // Carga inicial e `recarregar` (Atualizar, depois de uma rodada): setState só no retorno da API.
  const [recarga, setRecarga] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([service.status(ctrl.signal), service.boletos(ctrl.signal)])
      .then(([s, b]) => {
        setStatus(s);
        setBoletos(b);
        setErro(null);
        setCarregando(false);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setErro(e instanceof Error ? e.message : String(e));
        setCarregando(false);
      });
    return () => ctrl.abort();
  }, [service, recarga]);

  const recarregar = () => {
    setCarregando(true);
    setRecarga((n) => n + 1);
  };

  const daEmpresa = useMemo(() => boletos.filter((b) => empresa === "todas" || b.empresa === empresa), [boletos, empresa]);
  const contagem = useMemo(() => contarPorFiltro(daEmpresa), [daEmpresa]);
  const visiveis = useMemo(() => daEmpresa.filter((b) => boletoNoFiltro(b, filtro)), [daEmpresa, filtro]);

  // Pedem ação: sem conta (cards com categoria, criação em lote), casados a conferir (validação em
  // lote antes do Inter) e o resto (ambíguo, vencido, recusado, erro) na tabela.
  const emCards = filtro === "acao";
  const semConta = useMemo(() => (emCards ? visiveis.filter((b) => b.situacao === "SEM_CONTA") : []), [emCards, visiveis]);
  const conferir = useMemo(() => (emCards ? visiveis.filter(aguardandoValidacao) : []), [emCards, visiveis]);
  const naTabela = useMemo(
    () => (emCards ? visiveis.filter((b) => b.situacao !== "SEM_CONTA" && !aguardandoValidacao(b)) : visiveis),
    [emCards, visiveis],
  );

  const [selSem, setSelSem] = useState<Set<string>>(() => new Set());
  const [selConf, setSelConf] = useState<Set<string>>(() => new Set());
  const [categoriaPor, setCategoriaPor] = useState<Record<string, string>>({});
  const [historicoPor, setHistoricoPor] = useState<Record<string, string>>({});
  const [erroPor, setErroPor] = useState<Record<string, string>>({});
  const [lote, setLote] = useState<null | "criar" | "validar">(null);
  const [progressoLote, setProgressoLote] = useState("");

  // Categorias do Tiny de cada empresa com boleto sem conta (uma consulta por empresa).
  const [categoriasPor, setCategoriasPor] = useState<Record<string, DdaCategoria[]>>({});
  const [erroCategoriasPor, setErroCategoriasPor] = useState<Record<string, string>>({});
  const pedidas = useRef(new Set<string>());
  const empresasSemConta = useMemo(() => [...new Set(semConta.map((b) => b.empresa))].sort().join(","), [semConta]);
  useEffect(() => {
    if (!podeAgir || !empresasSemConta) return;
    for (const emp of empresasSemConta.split(",")) {
      if (pedidas.current.has(emp)) continue;
      pedidas.current.add(emp);
      service
        .categorias(emp)
        .then((cats) => setCategoriasPor((m) => ({ ...m, [emp]: cats })))
        .catch((e: unknown) => {
          pedidas.current.delete(emp);
          setErroCategoriasPor((m) => ({ ...m, [emp]: e instanceof Error ? e.message : String(e) }));
        });
    }
  }, [service, podeAgir, empresasSemConta]);

  const marcarSem = useCallback((id: string, m: boolean) => setSelSem((atual) => alternar(atual, id, m)), []);
  const marcarConf = useCallback((id: string, m: boolean) => setSelConf((atual) => alternar(atual, id, m)), []);
  const mudarCategoria = useCallback((id: string, cat: string) => {
    setCategoriaPor((m) => ({ ...m, [id]: cat }));
    if (cat) setSelSem((atual) => new Set(atual).add(id));
  }, []);
  const mudarHistorico = useCallback((id: string, texto: string) => setHistoricoPor((m) => ({ ...m, [id]: texto })), []);
  const abrirLigar = useCallback((b: DdaBoleto) => setModal({ tipo: "escolher", boleto: b }), []);
  const abrirDescartar = useCallback((b: DdaBoleto) => setModal({ tipo: "descartar", boleto: b }), []);

  // Escolha da pessoa, senão a sugestão (histórico do fornecedor ou Qwen) quando existe no catálogo.
  const categoriaDe = (b: DdaBoleto) => categoriaPor[b.id] ?? categoriaSugerida(b, categoriasPor[b.empresa]);
  const selecionadosSem = semConta.filter((b) => selSem.has(b.id));
  const semCategoria = selecionadosSem.filter((b) => !categoriaDe(b));
  const selecionadosConf = conferir.filter((b) => selConf.has(b.id));

  async function criarLote() {
    if (selecionadosSem.length === 0 || semCategoria.length > 0) return;
    setLote("criar");
    setAviso(null);
    setProgressoLote("Enviando ao Tiny…");
    try {
      const r = await service.criarContas(
        selecionadosSem.map((b) => ({ boleto_id: b.id, categoria_id: Number(categoriaDe(b)), historico: historicoPor[b.id] ?? historicoPadrao(b) })),
        (job) => setProgressoLote(job.total ? `Criando no Tiny: ${job.atual ?? 0} de ${job.total}` : "Criando no Tiny…"),
      );
      const falhas = Object.fromEntries(r.resultados.filter((x) => !x.ok).map((x) => [x.boleto_id, x.erro || "Falhou."]));
      setErroPor(falhas);
      setSelSem(new Set(Object.keys(falhas)));
      setAviso(
        r.total_falhas
          ? { tom: "erro", texto: `${r.total_sucessos} conta(s) criada(s); ${r.total_falhas} falharam (o motivo está em cada card).` }
          : { tom: "ok", texto: `${r.total_sucessos} conta(s) criada(s) no Tiny e ligada(s) aos boletos. A próxima rodada agenda no Inter.` },
      );
      recarregar();
    } catch (e) {
      setAviso({ tom: "erro", texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setLote(null);
      setProgressoLote("");
    }
  }

  async function validarLote() {
    if (selecionadosConf.length === 0) return;
    setLote("validar");
    setAviso(null);
    try {
      const r = await service.validar(selecionadosConf.map((b) => b.id));
      setSelConf(new Set());
      setAviso(
        r.recusados.length
          ? { tom: "erro", texto: `${r.validados.length} validado(s); ${r.recusados.length} não: ${r.recusados.map((x) => x.motivo).join("; ")}` }
          : { tom: "ok", texto: `${r.validados.length} boleto(s) validado(s): a próxima rodada agenda o pagamento no Inter.` },
      );
      recarregar();
    } catch (e) {
      setAviso({ tom: "erro", texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setLote(null);
    }
  }

  const substituir = (novo: DdaBoleto) => setBoletos((lista) => lista.map((b) => (b.id === novo.id ? novo : b)));

  async function executar() {
    setExecutando(true);
    setAviso(null);
    try {
      const job = await service.executar();
      const erros = job.resultado?.erros ?? [];
      if (job.status === "erro") setAviso({ tom: "erro", texto: job.erro || "A rodada falhou." });
      else if (erros.length) setAviso({ tom: "erro", texto: `Rodada concluída com erro: ${erros.join("; ")}` });
      else setAviso({ tom: "ok", texto: "Rodada concluída." });
      recarregar();
    } catch (e) {
      setAviso({ tom: "erro", texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setExecutando(false);
    }
  }

  async function agir(boleto: DdaBoleto, fn: () => Promise<DdaBoleto>, sucesso: string) {
    setOcupado(boleto.id);
    setAviso(null);
    try {
      substituir(await fn());
      setAviso({ tom: "ok", texto: sucesso });
      setModal(null);
      return true;
    } catch (e) {
      setAviso({ tom: "erro", texto: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setOcupado(null);
    }
  }

  const inativos = (status?.cadastros ?? []).filter((c) => !c.ativo);

  return (
    <div className="space-y-6">
      <section className="panel" aria-labelledby="dda-titulo">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="section-title">
            <div>
              <h3 id="dda-titulo">Boletos DDA</h3>
              <p>
                Boletos emitidos contra os CNPJs (Polp) → conta a pagar do Tiny → pagamento agendado no Inter → baixa depois de pago.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Button size="sm" variant="outline" onClick={recarregar} disabled={carregando} className="gap-1.5">
              <RefreshCw size={13} className={carregando ? "animate-spin" : ""} />
              Atualizar
            </Button>
            {podeAgir && (
              <Button size="sm" onClick={() => void executar()} disabled={executando || status?.em_execucao || !status?.configurado} className="gap-1.5">
                <Play size={13} className={executando ? "animate-pulse" : ""} />
                {executando ? "Executando…" : "Executar agora"}
              </Button>
            )}
          </div>
        </div>
        {status && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <span>
              Rotina:{" "}
              <strong className="text-foreground">{status.ativo ? `a cada ${status.intervalo_minutos} min` : "desligada"}</strong>
            </span>
            <span>
              Agendar no Inter: <strong className="text-foreground">{status.agendar_no_inter ? "sim" : "não (só casa com o Tiny)"}</strong>
            </span>
            {status.ultima_execucao && (
              <span>
                Última rodada: <strong className="text-foreground">{formatDateTimeBR(status.ultima_execucao.fim || status.ultima_execucao.inicio)}</strong>
                {status.ultima_execucao.erros.length > 0 && <span className="text-destructive"> (com erro)</span>}
              </span>
            )}
          </div>
        )}
        {status && !status.configurado && (
          <p role="alert" className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-5">
            <AlertTriangle size={13} className="shrink-0 text-amber-700 dark:text-amber-400" />
            Credenciais da Polp não configuradas no servidor (POLP_CLIENT_ID / POLP_CLIENT_SECRET).
          </p>
        )}
        {inativos.length > 0 && (
          <p role="alert" className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground sm:px-5">
            <AlertTriangle size={13} className="shrink-0 text-amber-700 dark:text-amber-400" />
            Cadastro DDA ainda não ativo na CIP:{" "}
            {inativos.map((c) => `${c.nome || companyLabel(c.empresa)} (${c.status_label || "pendente"})`).join(", ")}.
          </p>
        )}
      </section>

      {aviso && (
        <div
          role={aviso.tom === "erro" ? "alert" : "status"}
          className={cn(
            "flex items-start justify-between gap-3 border px-4 py-2.5 text-sm",
            aviso.tom === "erro" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300",
          )}
        >
          <span>{aviso.texto}</span>
          <button type="button" onClick={() => setAviso(null)} aria-label="Fechar aviso" className="shrink-0 cursor-pointer opacity-70 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      )}

      {erro ? (
        <SourceError message={erro} />
      ) : (
        <section className="panel" aria-busy={carregando} aria-label="Boletos">
          <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div role="tablist" aria-label="Filtro dos boletos" className="inline-flex flex-wrap border border-border bg-card p-1 text-sm">
              {FILTROS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filtro === f.id}
                  onClick={() => setFiltro(f.id)}
                  className={cn(
                    "cursor-pointer px-3 py-1 font-medium transition",
                    filtro === f.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {f.label} <span className="tabular-nums text-xs text-muted-foreground">({contagem[f.id]})</span>
                </button>
              ))}
            </div>
            <NativeSelect aria-label="Empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)} className="sm:w-56">
              <NativeSelectOption value="todas">Todas as empresas</NativeSelectOption>
              {RECONCILIATION_COMPANIES.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.nome}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {!carregando && visiveis.length === 0 && (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Nenhum boleto neste filtro.</p>
          )}

          {semConta.length > 0 && (
            <SecaoLote
              titulo="Sem conta no Tiny"
              descricao="Escolha a categoria de cada boleto e crie as contas a pagar no Tiny em lote (fornecedor pelo CNPJ, forma boleto). Já criadas pelo painel, vão direto para o agendamento."
              total={semConta.length}
              selecionados={selecionadosSem.length}
              podeAgir={podeAgir}
              bloqueado={lote !== null}
              onTodos={(m) => setSelSem(m ? new Set(semConta.filter((b) => !b.conta_criada_incerta).map((b) => b.id)) : new Set())}
            >
              {semConta.map((b) => (
                <SemContaCard
                  key={b.id}
                  boleto={b}
                  selecionado={selSem.has(b.id)}
                  categoria={categoriaDe(b)}
                  historico={historicoPor[b.id] ?? historicoPadrao(b)}
                  categorias={categoriasPor[b.empresa] ?? null}
                  erroCategorias={erroCategoriasPor[b.empresa] ?? null}
                  bloqueado={!podeAgir || lote !== null}
                  erro={erroPor[b.id]}
                  onSelecionar={marcarSem}
                  onCategoria={mudarCategoria}
                  onHistorico={mudarHistorico}
                  onLigar={abrirLigar}
                  onDescartar={abrirDescartar}
                />
              ))}
              {podeAgir && (
                <BotaoLote
                  ativo={lote === "criar"}
                  desabilitado={lote !== null || selecionadosSem.length === 0 || semCategoria.length > 0}
                  progresso={progressoLote}
                  aviso={semCategoria.length > 0 ? `${semCategoria.length} selecionado(s) sem categoria.` : ""}
                  onClick={() => void criarLote()}
                  icone={<FilePlus2 size={14} />}
                  texto={selecionadosSem.length === 0 ? "Nenhum boleto selecionado" : `Criar ${selecionadosSem.length} conta(s) no Tiny`}
                />
              )}
            </SecaoLote>
          )}

          {conferir.length > 0 && (
            <SecaoLote
              titulo="Conferir antes de agendar"
              descricao="A automação achou a conta do Tiny com o mesmo fornecedor, vencimento e valor. Confira e valide: só os validados vão para o agendamento no Inter."
              total={conferir.length}
              selecionados={selecionadosConf.length}
              podeAgir={podeAgir}
              bloqueado={lote !== null}
              onTodos={(m) => setSelConf(m ? new Set(conferir.map((b) => b.id)) : new Set())}
            >
              {conferir.map((b) => (
                <ConferirCard
                  key={b.id}
                  boleto={b}
                  selecionado={selConf.has(b.id)}
                  bloqueado={!podeAgir || lote !== null}
                  onSelecionar={marcarConf}
                  onDescartar={abrirDescartar}
                />
              ))}
              {podeAgir && (
                <BotaoLote
                  ativo={lote === "validar"}
                  desabilitado={lote !== null || selecionadosConf.length === 0}
                  progresso="Validando…"
                  aviso=""
                  onClick={() => void validarLote()}
                  icone={<CheckCheck size={14} />}
                  texto={selecionadosConf.length === 0 ? "Nenhum boleto selecionado" : `Validar ${selecionadosConf.length} para agendamento no Inter`}
                />
              )}
            </SecaoLote>
          )}

          {naTabela.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Beneficiário</TableHead>
                    <TableHead>Empresa</TableHead>
                    <TableHead>Vencimento</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Conta no Tiny</TableHead>
                    {podeAgir && <TableHead className="text-right">Ações</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {naTabela.map((b) => (
                    <LinhaBoleto
                      key={b.id}
                      boleto={b}
                      podeAgir={podeAgir}
                      ocupado={ocupado === b.id}
                      onCriar={() => setModal({ tipo: "criar", boleto: b })}
                      onEscolher={() => setModal({ tipo: "escolher", boleto: b })}
                      onDescartar={() => setModal({ tipo: "descartar", boleto: b })}
                      onReabrir={() => void agir(b, () => service.reabrir(b.id), "Boleto reaberto: a próxima rodada segue com ele.")}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      {modal?.tipo === "criar" && (
        <CriarContaModal
          boleto={modal.boleto}
          service={service}
          ocupado={ocupado === modal.boleto.id}
          onClose={() => setModal(null)}
          onConfirmar={(cat, hist) => agir(modal.boleto, () => service.criarConta(modal.boleto.id, cat, hist), "Conta criada no Tiny e ligada ao boleto.")}
        />
      )}
      {modal?.tipo === "escolher" && (
        <EscolherContaModal
          boleto={modal.boleto}
          ocupado={ocupado === modal.boleto.id}
          onClose={() => setModal(null)}
          onConfirmar={(id) => agir(modal.boleto, () => service.vincular(modal.boleto.id, id), `Boleto ligado à conta #${id}.`)}
        />
      )}
      {modal?.tipo === "descartar" && (
        <DescartarModal
          boleto={modal.boleto}
          ocupado={ocupado === modal.boleto.id}
          onClose={() => setModal(null)}
          onConfirmar={(motivo) => agir(modal.boleto, () => service.descartar(modal.boleto.id, motivo), "Boleto descartado.")}
        />
      )}
    </div>
  );
}

function alternar(atual: Set<string>, id: string, marcado: boolean): Set<string> {
  const novo = new Set(atual);
  if (marcado) novo.add(id);
  else novo.delete(id);
  return novo;
}

function SecaoLote({
  titulo,
  descricao,
  total,
  selecionados,
  podeAgir,
  bloqueado,
  onTodos,
  children,
}: {
  titulo: string;
  descricao: string;
  total: number;
  selecionados: number;
  podeAgir: boolean;
  bloqueado: boolean;
  onTodos: (marcado: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 border-b border-border p-4 sm:px-5">
      <div className="flex items-start gap-3">
        {podeAgir && (
          <Checkbox
            checked={selecionados > 0 && selecionados === total}
            indeterminate={selecionados > 0 && selecionados < total}
            onCheckedChange={onTodos}
            disabled={bloqueado}
            aria-label={`Selecionar todos: ${titulo}`}
            className="mt-1 shrink-0"
          />
        )}
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {titulo} <span className="font-normal tabular-nums text-muted-foreground">({total})</span>
          </h4>
          <p className="text-xs text-muted-foreground">{descricao}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function BotaoLote({
  ativo,
  desabilitado,
  progresso,
  aviso,
  onClick,
  icone,
  texto,
}: {
  ativo: boolean;
  desabilitado: boolean;
  progresso: string;
  aviso: string;
  onClick: () => void;
  icone: React.ReactNode;
  texto: string;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="cta" onClick={onClick} disabled={desabilitado} className="gap-2 disabled:opacity-60">
        {ativo ? <Loader2 className="animate-spin" size={14} /> : icone}
        {ativo ? progresso || "Enviando…" : texto}
      </Button>
      {aviso && <p className="text-xs text-amber-700 dark:text-amber-400">{aviso}</p>}
    </div>
  );
}

function LinhaBoleto({
  boleto: b,
  podeAgir,
  ocupado,
  onCriar,
  onEscolher,
  onDescartar,
  onReabrir,
}: {
  boleto: DdaBoleto;
  podeAgir: boolean;
  ocupado: boolean;
  onCriar: () => void;
  onEscolher: () => void;
  onDescartar: () => void;
  onReabrir: () => void;
}) {
  const meta = situacaoMeta(b);
  const acoes = acoesDoBoleto(b);
  const aprov = aprovacoesTexto(b);
  return (
    <TableRow>
      <TableCell className="max-w-72">
        <div className="truncate font-medium" title={b.beneficiario_nome}>
          {b.beneficiario_nome || "—"}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {documentoFormatado(b.beneficiario_cnpj)}
          {b.documento ? ` · doc. ${b.documento}` : ""}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">{companyLabel(b.empresa)}</TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{dataBR(b.vencimento)}</TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">{money(Number(b.valor))}</TableCell>
      <TableCell className="max-w-80">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={meta.tom} title={meta.ajuda}>
            {meta.label}
          </Badge>
          {b.fraude && (
            <Badge variant="danger" title="A Polp marcou este boleto como possível fraude: ele não é casado nem agendado.">
              <ShieldAlert /> Possível fraude
            </Badge>
          )}
          {aprov && <span className="text-xs text-muted-foreground">{aprov}</span>}
        </div>
        {b.mensagem && <p className="mt-1 text-xs text-muted-foreground">{b.mensagem}</p>}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {b.conta_id ? `#${b.conta_id}` : b.candidatos?.length ? `${b.candidatos.length} candidatas` : "—"}
      </TableCell>
      {podeAgir && (
        <TableCell className="text-right">
          <div className="flex justify-end gap-1.5">
            {acoes.escolher && b.situacao === "AMBIGUO" && (
              <Button size="sm" variant="outline" disabled={ocupado} onClick={onEscolher} className="gap-1">
                <Link2 size={13} /> Escolher
              </Button>
            )}
            {acoes.criar && (
              <Button size="sm" variant="outline" disabled={ocupado} onClick={onCriar} className="gap-1">
                <FilePlus2 size={13} /> Criar conta
              </Button>
            )}
            {acoes.escolher && b.situacao === "SEM_CONTA" && (
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={onEscolher} className="gap-1" title="Ligar a uma conta do Tiny pelo número">
                <Link2 size={13} /> Ligar
              </Button>
            )}
            {acoes.reabrir && (
              <Button size="sm" variant="outline" disabled={ocupado} onClick={onReabrir} className="gap-1">
                <RotateCcw size={13} /> Reabrir
              </Button>
            )}
            {acoes.descartar && (
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={onDescartar} className="gap-1" aria-label="Descartar boleto">
                <Ban size={13} />
              </Button>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

function ResumoBoleto({ boleto: b }: { boleto: DdaBoleto }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border border-border bg-muted/30 p-3 text-sm">
      <dt className="text-muted-foreground">Beneficiário</dt>
      <dd>{b.beneficiario_nome} ({documentoFormatado(b.beneficiario_cnpj)})</dd>
      <dt className="text-muted-foreground">Empresa</dt>
      <dd>{companyLabel(b.empresa)}</dd>
      <dt className="text-muted-foreground">Vencimento</dt>
      <dd className="tabular-nums">{dataBR(b.vencimento)}</dd>
      <dt className="text-muted-foreground">Valor</dt>
      <dd className="tabular-nums">{money(Number(b.valor))}</dd>
    </dl>
  );
}

function Modal({ titulo, id, onClose, children }: { titulo: string; id: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <ModalShell onClose={onClose} labelledBy={id} className="relative w-full max-w-lg rounded-none border border-border bg-card text-card-foreground shadow-lg">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-6 py-4">
        <h2 id={id} className="text-base font-semibold">
          {titulo}
        </h2>
        <button type="button" onClick={onClose} aria-label="Fechar" className="cursor-pointer text-muted-foreground hover:text-foreground">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-4 px-6 py-5">{children}</div>
    </ModalShell>
  );
}

function CriarContaModal({
  boleto,
  service,
  ocupado,
  onClose,
  onConfirmar,
}: {
  boleto: DdaBoleto;
  service: DdaService;
  ocupado: boolean;
  onClose: () => void;
  onConfirmar: (categoriaId: number, historico: string) => Promise<boolean>;
}) {
  const [categorias, setCategorias] = useState<DdaCategoria[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [categoria, setCategoria] = useState("");
  const [tocou, setTocou] = useState(false);
  const [historico, setHistorico] = useState(`Boleto DDA - ${boleto.beneficiario_nome}${boleto.documento ? ` - doc. ${boleto.documento}` : ""}`.slice(0, 500));

  useEffect(() => {
    let vivo = true;
    service
      .categorias(boleto.empresa)
      .then((c) => vivo && setCategorias(c))
      .catch((e: unknown) => vivo && setErro(e instanceof Error ? e.message : String(e)));
    return () => {
      vivo = false;
    };
  }, [service, boleto.empresa]);

  const categoriaEscolhida = tocou ? categoria : categoriaSugerida(boleto, categorias);
  return (
    <Modal titulo="Criar conta a pagar no Tiny" id="dda-criar-titulo" onClose={onClose}>
      <ResumoBoleto boleto={boleto} />
      <p className="text-xs text-muted-foreground">
        O fornecedor é o contato do Tiny com este CNPJ (a automação não cria contatos). Forma de pagamento: boleto. Depois de criada, a próxima rodada agenda o pagamento no Inter.
      </p>
      <div className="space-y-1.5">
        <label htmlFor="dda-categoria" className="text-xs font-medium text-muted-foreground">
          Categoria
        </label>
        {erro ? (
          <p role="alert" className="text-xs text-destructive">{erro}</p>
        ) : (
          <NativeSelect
            id="dda-categoria"
            value={tocou ? categoria : categoriaSugerida(boleto, categorias)}
            onChange={(e) => {
              setTocou(true);
              setCategoria(e.target.value);
            }}
            disabled={!categorias}
            className="w-full"
          >
            <NativeSelectOption value="">{categorias ? "Escolha a categoria" : "Carregando categorias…"}</NativeSelectOption>
            {(categorias ?? []).map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.grupo ? `${c.grupo} → ${c.nome}` : c.nome}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      <div className="space-y-1.5">
        <label htmlFor="dda-historico" className="text-xs font-medium text-muted-foreground">
          Histórico
        </label>
        <Input id="dda-historico" value={historico} maxLength={500} onChange={(e) => setHistorico(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={ocupado}>
          Cancelar
        </Button>
        <Button onClick={() => void onConfirmar(Number(categoriaEscolhida), historico)} disabled={ocupado || !categoriaEscolhida}>
          {ocupado ? "Criando…" : "Criar conta"}
        </Button>
      </div>
    </Modal>
  );
}

function EscolherContaModal({
  boleto,
  ocupado,
  onClose,
  onConfirmar,
}: {
  boleto: DdaBoleto;
  ocupado: boolean;
  onClose: () => void;
  onConfirmar: (contaId: number) => Promise<boolean>;
}) {
  const candidatos = boleto.candidatos ?? [];
  const [escolhida, setEscolhida] = useState(candidatos[0] ? String(candidatos[0].id) : "");
  const id = Number(escolhida);
  return (
    <Modal titulo="Ligar o boleto a uma conta do Tiny" id="dda-escolher-titulo" onClose={onClose}>
      <ResumoBoleto boleto={boleto} />
      {candidatos.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Contas com o mesmo fornecedor, vencimento e valor</legend>
          {candidatos.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 border border-border p-2.5 text-sm has-[:checked]:border-[var(--marca-ambar)]">
              <input type="radio" name="dda-conta" value={c.id} checked={escolhida === String(c.id)} onChange={() => setEscolhida(String(c.id))} className="mt-1" />
              <span>
                <strong className="tabular-nums">#{c.id}</strong> {c.numero_documento && `· doc. ${c.numero_documento}`}
                <span className="block text-xs text-muted-foreground">{c.historico || "sem histórico"}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="space-y-1.5">
          <label htmlFor="dda-conta-id" className="text-xs font-medium text-muted-foreground">
            Número (id) da conta a pagar no Tiny
          </label>
          <Input id="dda-conta-id" inputMode="numeric" value={escolhida} onChange={(e) => setEscolhida(e.target.value.replace(/\D/g, ""))} />
          <p className="text-xs text-muted-foreground">A conta precisa estar em aberto e ter o mesmo valor do boleto.</p>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={ocupado}>
          Cancelar
        </Button>
        <Button onClick={() => void onConfirmar(id)} disabled={ocupado || !id}>
          {ocupado ? "Ligando…" : "Ligar conta"}
        </Button>
      </div>
    </Modal>
  );
}

function DescartarModal({
  boleto,
  ocupado,
  onClose,
  onConfirmar,
}: {
  boleto: DdaBoleto;
  ocupado: boolean;
  onClose: () => void;
  onConfirmar: (motivo: string) => Promise<boolean>;
}) {
  const [motivo, setMotivo] = useState("");
  return (
    <Modal titulo="Descartar boleto" id="dda-descartar-titulo" onClose={onClose}>
      <ResumoBoleto boleto={boleto} />
      <p className="text-xs text-muted-foreground">O boleto sai das pendências e não é agendado. Dá para reabrir depois.</p>
      <div className="space-y-1.5">
        <label htmlFor="dda-motivo" className="text-xs font-medium text-muted-foreground">
          Motivo
        </label>
        <Input id="dda-motivo" value={motivo} maxLength={300} placeholder="Ex.: pago por outro meio, boleto duplicado" onChange={(e) => setMotivo(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={ocupado}>
          Cancelar
        </Button>
        <Button variant="destructive" onClick={() => void onConfirmar(motivo)} disabled={ocupado}>
          {ocupado ? "Descartando…" : "Descartar"}
        </Button>
      </div>
    </Modal>
  );
}
