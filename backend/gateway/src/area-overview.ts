import type {
  AcaoPendente,
  AreaVisaoGeralId,
  AutomacaoResumo,
  ServicoStatus,
  Severidade,
  VisaoGeralArea,
} from "./contracts.js";
import type { ServiceHealthResult } from "./overview.js";
import type { ReconciliationHistoryService } from "./reconciliation-history.js";
import type { StockSkuService } from "./stock-sku.js";
import { callAutomation } from "./automation-http.js";
import { CircuitBreakerOpenError } from "./circuit-breaker.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Visão geral por área (GET /api/areas/{area}/visao-geral): ações pendentes, resumo das automações
 * e serviços de cada área. Os dados BRUTOS de cada fonte são lidos em paralelo (allSettled, cada
 * fonte isolada) e guardados 30 s por área, com dedupe de leituras em andamento. O filtro por
 * permissão de aba é aplicado por usuário DEPOIS do cache (o cache nunca é por usuário).
 */

export const AREA_OVERVIEW_CACHE_MS = 30_000;
export const AREA_IDS: readonly AreaVisaoGeralId[] = ["financeiro", "logistica", "marketplace", "producao"];

type Resultado = { ok: true; data: unknown } | { ok: false; mensagem: string };

interface FonteDef {
  id: string;
  nome: string;
  /** Chave "<aba>:ver" que libera a fonte (vazio = sem filtro). */
  perm: string;
  /** Serviço (não vira "indisponível": aparece como desconectado). */
  servico?: boolean;
  load(): Promise<unknown>;
}

interface Raw {
  get(id: string): Resultado;
}

interface Pendencia extends AcaoPendente {
  perm: string;
}
interface AutomacaoComPerm extends AutomacaoResumo {
  perm: string;
}
interface Montado {
  acoes: Pendencia[];
  automacoes: AutomacaoComPerm[];
  servicos: ServicoStatus[];
}

export interface ContagemResumo {
  total: number;
  aguardando: number;
  semSku: number;
  semEnvio: number;
  envioErro: number;
  lancadas: number;
  ultimaEm: string | null;
  maisAntigaAguardando: string | null;
}

export interface AreaOverviewDeps {
  mode: "demo" | "live";
  /** GET JSON ao motor financeiro (porta 8000) — já com breaker e chave interna. */
  fetchFinanceiro?: (path: string, timeoutMs?: number) => Promise<unknown>;
  /** GET JSON ao motor de marketplace (porta 8001). */
  fetchMarketplace?: (path: string, timeoutMs?: number) => Promise<unknown>;
  history?: Pick<ReconciliationHistoryService, "list">;
  readContagens?: () => Promise<ContagemResumo>;
  checkTiny?: () => Promise<ServiceHealthResult> | ServiceHealthResult;
  checkDatabase?: () => Promise<ServiceHealthResult> | ServiceHealthResult;
  clock?: () => Date;
  cacheMs?: number;
}

export interface AreaOverviewService {
  read(area: AreaVisaoGeralId, can: (perm: string) => boolean): Promise<VisaoGeralArea>;
}

// ------------------------------------------------------------------ utilitários

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const pl = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

function isoMin(values: Array<string | null>): string | null {
  const v = values.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  return v.length ? v.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}
function isoMax(values: Array<string | null>): string | null {
  const v = values.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  return v.length ? v.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}
/** "há 3 h" / "há 12 min" / "há 5 dias". */
export function haQuanto(iso: string | null, now: Date): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}
const horasDesde = (iso: string | null, now: Date): number | null =>
  iso && Number.isFinite(Date.parse(iso)) ? (now.getTime() - Date.parse(iso)) / 3_600_000 : null;

const SEV_RANK: Record<Severidade, number> = { critica: 0, atencao: 1, info: 2 };

function novo(): Montado {
  return { acoes: [], automacoes: [], servicos: [] };
}
function pendencia(
  m: Montado,
  perm: string,
  p: Omit<AcaoPendente, "desde"> & { desde?: string | null },
): void {
  if (p.quantidade === 0) return; // nunca envia item zerado
  m.acoes.push({ ...p, desde: p.desde ?? null, perm });
}
const statusDe = (erro: boolean, atencao: boolean): AutomacaoResumo["status"] => (erro ? "erro" : atencao ? "atencao" : "ok");

// ------------------------------------------------------------------ construtores por área

const ML_CONEXOES: Record<string, string> = { mercado_pago: "Mercado Pago", mercado_livre: "Mercado Livre", tiny: "Tiny" };

function conexoesAusentes(ml: Obj): { total: number; texto: string } {
  const partes: string[] = [];
  let total = 0;
  for (const e of arr(ml.empresas)) {
    const emp = obj(e);
    const faltando = Object.entries(obj(emp.conexoes))
      .filter(([, ok]) => !ok)
      .map(([k]) => ML_CONEXOES[k] ?? k);
    total += faltando.length;
    if (faltando.length) partes.push(`${str(emp.nome) ?? "Empresa"}: ${faltando.join(", ")}`);
  }
  return { total, texto: partes.join("; ") };
}

function certificados(sef: Obj) {
  const criticos: string[] = [];
  const atencao: string[] = [];
  for (const c of arr(sef.certificados)) {
    const cert = obj(c);
    const quem = str(cert.titular) ?? str(cert.arquivo) ?? "certificado";
    const dias = typeof cert.dias_restantes === "number" ? cert.dias_restantes : null;
    if (str(cert.erro)) criticos.push(`${quem} (não foi possível ler)`);
    else if (dias !== null && dias < 0) criticos.push(`${quem} (vencido)`);
    else if (dias !== null && dias <= 7) criticos.push(`${quem} (vence em ${dias} dia${dias === 1 ? "" : "s"})`);
    else if (dias !== null && dias <= 30) atencao.push(`${quem} (vence em ${dias} dias)`);
  }
  return { criticos, atencao };
}

function buildFinanceiro(r: Raw, now: Date, deps: AreaOverviewDeps): Montado {
  const m = novo();
  const get = (id: string) => r.get(id);
  const pend = get("nfe_pendentes");
  const hist = get("nfe_historico");
  const sef = get("sefaz");
  const baixas = get("baixas");
  const estado = get("estado_pagar");
  const inter = get("inter");
  const ml = get("ml_status");
  const mlPend = get("ml_pendencias");
  const sync = get("fin_sync");

  // ---- NF-e
  const nfeInd: AutomacaoResumo["indicadores"] = [];
  let nfeErro = false;
  let nfeAtencao = false;
  let pendTotal = 0;
  if (pend.ok) {
    const d = obj(pend.data);
    const lista = arr(d.pending);
    pendTotal = typeof d.total === "number" ? d.total : lista.length;
    nfeInd.push({ rotulo: "Aguardando categorização", valor: String(pendTotal) });
    pendencia(m, "revisao_nfe:ver", {
      id: "nfe-categorizar",
      automacao: "danfe-tiny",
      titulo: "NF-e aguardando categorização",
      descricao: `${pl(pendTotal, "nota espera", "notas esperam")} a escolha da categoria para ser lançada no Tiny.`,
      quantidade: pendTotal,
      severidade: "atencao",
      href: "/danfe-tiny",
      acao: "Categorizar notas",
      desde: isoMin(lista.map((p) => str(obj(p).staged_at))),
    });
    nfeAtencao ||= pendTotal > 0;
  }
  if (hist.ok) {
    const itens = arr(obj(hist.data).history).map(obj);
    const falhas = itens.filter((i) => i.audit_status === "error" && !i.resolved_at);
    const corte = now.getTime() - 14 * 86_400_000;
    const ok14 = itens.filter(
      (i) => i.audit_status === "success" && Date.parse(str(i.processed_at) ?? "") >= corte,
    ).length;
    nfeInd.push({ rotulo: "Notas processadas (14 dias)", valor: String(ok14) });
    nfeInd.push({ rotulo: "Falhas sem resolver", valor: String(falhas.length) });
    pendencia(m, "revisao_nfe:ver", {
      id: "nfe-falhas",
      automacao: "danfe-tiny",
      titulo: "NF-e com falha no lançamento",
      descricao: `${pl(falhas.length, "nota não pôde", "notas não puderam")} ser lançada e precisa de conferência.`,
      quantidade: falhas.length,
      severidade: "critica",
      href: "/danfe-tiny",
      acao: "Resolver falhas",
      desde: isoMin(falhas.map((f) => str(f.processed_at))),
    });
    nfeErro ||= falhas.length > 0;
  }
  let ultimaVarredura: string | null = null;
  if (sef.ok) {
    const s = obj(sef.data);
    ultimaVarredura = str(s.last_scan_finished_at);
    nfeInd.push({ rotulo: "Última varredura SEFAZ", valor: haQuanto(ultimaVarredura, now) });
    const c = certificados(s);
    pendencia(m, "revisao_nfe:ver", {
      id: "cert-a1-critico",
      automacao: "danfe-tiny",
      titulo: "Certificado digital vencido ou quase vencendo",
      descricao: `${c.criticos.join("; ")}. Sem o certificado a varredura da SEFAZ desse CNPJ para.`,
      quantidade: c.criticos.length,
      severidade: "critica",
      href: "/danfe-tiny",
      acao: "Ver certificados",
    });
    pendencia(m, "revisao_nfe:ver", {
      id: "cert-a1-atencao",
      automacao: "danfe-tiny",
      titulo: "Certificado digital vence em breve",
      descricao: `${c.atencao.join("; ")}. Renove com antecedência.`,
      quantidade: c.atencao.length,
      severidade: "atencao",
      href: "/danfe-tiny",
      acao: "Ver certificados",
    });
    const cnpjsErro = arr(s.cnpjs).map(obj).filter((x) => x.status === "erro").length;
    pendencia(m, "revisao_nfe:ver", {
      id: "sefaz-cnpj-erro",
      automacao: "danfe-tiny",
      titulo: "CNPJ com erro na última varredura da SEFAZ",
      descricao: `${pl(cnpjsErro, "CNPJ falhou", "CNPJs falharam")} na última consulta de notas.`,
      quantidade: cnpjsErro,
      severidade: "atencao",
      href: "/danfe-tiny",
      acao: "Ver varredura",
    });
    if (str(s.erro_gravacao))
      pendencia(m, "revisao_nfe:ver", {
        id: "sefaz-gravacao",
        automacao: "danfe-tiny",
        titulo: "Varredura da SEFAZ não consegue salvar o resultado",
        descricao: "A varredura roda, mas o servidor não grava o andamento. Peça ajuda à TI.",
        quantidade: null,
        severidade: "critica",
        href: "/admin/saude",
        acao: "Ver saúde do sistema",
      });
    nfeErro ||= c.criticos.length > 0;
    nfeAtencao ||= c.atencao.length > 0 || cnpjsErro > 0;
  }
  m.automacoes.push({
    id: "danfe-tiny",
    titulo: "Revisão de NF-e",
    href: "/danfe-tiny",
    status: nfeInd.length ? statusDe(nfeErro, nfeAtencao) : "sem_dados",
    ultimaExecucao: ultimaVarredura,
    indicadores: nfeInd.length ? nfeInd.slice(0, 4) : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "revisao_nfe:ver",
  });

  // ---- Contas a Pagar
  const cpInd: AutomacaoResumo["indicadores"] = [];
  let cpErro = false;
  let cpAtencao = false;
  let cpUltima: string | null = null;
  if (baixas.ok) {
    const b = obj(baixas.data);
    cpInd.push({ rotulo: "Baixas com sucesso (14 dias)", valor: String(num(b.sucesso)) });
    cpInd.push({ rotulo: "Baixas com erro (14 dias)", valor: String(num(b.erro)) });
    cpUltima = str(b.ultimaEm);
    pendencia(m, "contas_pagar:ver", {
      id: "baixas-erro",
      automacao: "accounts-payable",
      titulo: "Baixas de contas a pagar com erro",
      descricao: `${pl(num(b.erro), "baixa falhou", "baixas falharam")} nos últimos 14 dias e ${num(b.erro) === 1 ? "precisa" : "precisam"} ser conferida${num(b.erro) === 1 ? "" : "s"}.`,
      quantidade: num(b.erro),
      severidade: "critica",
      href: "/contas-a-pagar",
      acao: "Conferir baixas",
      desde: str(b.erroDesde),
    });
    pendencia(m, "contas_pagar:ver", {
      id: "baixas-pendentes",
      automacao: "accounts-payable",
      titulo: "Baixas sem resultado confirmado",
      descricao: `${pl(num(b.pendente), "baixa foi enviada", "baixas foram enviadas")} ao Tiny há mais de 30 minutos e ainda não ${num(b.pendente) === 1 ? "tem" : "têm"} resposta.`,
      quantidade: num(b.pendente),
      severidade: "critica",
      href: "/contas-a-pagar",
      acao: "Conferir baixas",
      desde: str(b.pendenteDesde),
    });
    cpErro ||= num(b.erro) > 0 || num(b.pendente) > 0;
  }
  if (estado.ok) {
    const e = obj(estado.data);
    // A lista de aptos é persistente: a conferência diária acrescenta as novas, a baixa pelo painel
    // e a conferência de baixas feitas fora (no Tiny) tiram as já baixadas.
    const summary = obj(e.summary);
    const casados = num(summary.total_casados) + num(summary.total_transferencias_aptas);
    const atualizado = str(e.atualizado_em);
    cpInd.push({ rotulo: "Aptos a baixar", valor: String(casados) });
    pendencia(m, "contas_pagar:ver", {
      id: "pagar-aptos",
      automacao: "accounts-payable",
      titulo: "Contas a pagar prontas para baixar",
      descricao: `${pl(casados, "conta casa", "contas casam")} com o extrato do Inter e ${casados === 1 ? "espera" : "esperam"} a baixa. Lista conferida ${haQuanto(atualizado, now)}.`,
      quantidade: casados,
      severidade: "atencao",
      href: "/contas-a-pagar",
      acao: "Dar baixa",
      desde: str(e.atualizado_em),
    });
    cpAtencao ||= casados > 0;
  }
  if (inter.ok) {
    const fora = arr(obj(inter.data).empresas)
      .map(obj)
      .filter((x) => x.inter_status !== "conectado");
    pendencia(m, "contas_pagar:ver", {
      id: "inter-sem-conexao",
      automacao: "accounts-payable",
      titulo: "Banco Inter sem conexão",
      descricao: `Sem acesso ao Inter em: ${fora.map((x) => str(x.nome) ?? "empresa").join(", ")}. Confira o certificado e as credenciais.`,
      quantidade: fora.length,
      severidade: "critica",
      href: "/contas-a-pagar",
      acao: "Ver conexões",
    });
    cpErro ||= fora.length > 0;
  }
  m.automacoes.push({
    id: "accounts-payable",
    titulo: "Contas a Pagar",
    href: "/contas-a-pagar",
    status: cpInd.length ? statusDe(cpErro, cpAtencao) : "sem_dados",
    ultimaExecucao: cpUltima,
    indicadores: cpInd.length ? cpInd.slice(0, 4) : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "contas_pagar:ver",
  });

  // ---- Conciliação ML
  const mlInd: AutomacaoResumo["indicadores"] = [];
  let mlErro = false;
  let mlAtencao = false;
  let mlUltima: string | null = null;
  if (ml.ok) {
    const s = obj(ml.data);
    const faltando = conexoesAusentes(s);
    pendencia(m, "conciliacao_ml:ver", {
      id: "ml-tokens",
      automacao: "conciliacao-ml",
      titulo: "Conta do Mercado Livre ou Mercado Pago desconectada",
      descricao: `${faltando.texto}. Sem a conexão a conciliação dessa empresa não roda.`,
      quantidade: faltando.total,
      severidade: "critica",
      href: "/conciliacao-mercado-livre",
      acao: "Reconectar contas",
    });
    const empresas = arr(s.empresas).map(obj);
    // Preferência: pendências recalculadas agora (descontam baixas feitas depois da análise). Sem
    // essa fonte, cai no resumo congelado da última análise.
    const pendEmpresas = mlPend.ok ? arr(obj(mlPend.data).empresas).map(obj) : null;
    const aptos = pendEmpresas
      ? pendEmpresas.reduce((t, e) => t + num(e.aptos_baixa), 0)
      : empresas.reduce((t, e) => t + num(obj(obj(obj(e.ultima_analise).resumo)).aptos_baixa), 0);
    pendencia(m, "conciliacao_ml:ver", {
      id: "ml-aptos",
      automacao: "conciliacao-ml",
      titulo: "Recebimentos aguardando baixa",
      descricao: `${pl(aptos, "recebimento conciliado espera", "recebimentos conciliados esperam")} a baixa no Tiny.`,
      quantidade: aptos,
      severidade: "atencao",
      href: "/conciliacao-mercado-livre",
      acao: "Dar baixa",
      desde: pendEmpresas
        ? isoMin(pendEmpresas.filter((e) => num(e.aptos_baixa) > 0).map((e) => str(e.analise_criada_em)))
        : isoMin(empresas.map((e) => str(obj(e.ultima_analise).criada_em))),
    });
    if (pendEmpresas) {
      const comLanc = pendEmpresas.filter((e) => num(e.lancamentos_nao_exportados) > 0);
      const naoExportados = comLanc.reduce((t, e) => t + num(e.lancamentos_nao_exportados), 0);
      pendencia(m, "conciliacao_ml:ver", {
        id: "ml-nao-exportados",
        automacao: "conciliacao-ml",
        titulo: "Lançamentos ainda não exportados",
        descricao: `${pl(naoExportados, "lançamento de caixa ainda não saiu", "lançamentos de caixa ainda não saíram")} na planilha para importar no Tiny (${comLanc.map((e) => str(e.nome) ?? "empresa").join(", ")}).`,
        quantidade: naoExportados,
        severidade: "atencao",
        href: "/conciliacao-mercado-livre",
        acao: "Exportar planilha",
        desde: isoMin(comLanc.map((e) => str(e.analise_criada_em))),
      });
      mlAtencao ||= naoExportados > 0;
    }
    const ultima = obj(s.ultima_execucao);
    mlUltima = str(ultima.concluida_em);
    const resultados = Object.values(obj(ultima.empresas)).map(obj);
    const falhasBaixa = resultados.reduce((t, e) => t + num(obj(e.baixa).falhas), 0);
    pendencia(m, "conciliacao_ml:ver", {
      id: "ml-baixas-erro",
      automacao: "conciliacao-ml",
      titulo: "Baixas do Mercado Livre com erro",
      descricao: `${pl(falhasBaixa, "baixa falhou", "baixas falharam")} na última execução.`,
      quantidade: falhasBaixa,
      severidade: "critica",
      href: "/conciliacao-mercado-livre",
      acao: "Ver erros",
      desde: mlUltima,
    });
    const empresasFalha = resultados.filter((e) => e.status === "erro" || e.status === "parcial").length;
    pendencia(m, "conciliacao_ml:ver", {
      id: "ml-execucao-falha",
      automacao: "conciliacao-ml",
      titulo: "Última conciliação do Mercado Livre falhou",
      descricao: `${pl(empresasFalha, "empresa teve", "empresas tiveram")} falha na última execução.`,
      quantidade: empresasFalha,
      severidade: "critica",
      href: "/conciliacao-mercado-livre",
      acao: "Ver execução",
      desde: mlUltima,
    });
    if (str(s.erro_gravacao))
      pendencia(m, "conciliacao_ml:ver", {
        id: "ml-gravacao",
        automacao: "conciliacao-ml",
        titulo: "Conciliação do Mercado Livre não consegue salvar o resultado",
        descricao: "A rotina roda, mas o servidor não grava o resultado. Peça ajuda à TI.",
        quantidade: null,
        severidade: "critica",
        href: "/admin/saude",
        acao: "Ver saúde do sistema",
      });
    mlInd.push({ rotulo: "Empresas conectadas", valor: `${empresas.filter((e) => Object.values(obj(e.conexoes)).every(Boolean)).length} de ${empresas.length}` });
    mlInd.push({ rotulo: "Aguardando baixa", valor: String(aptos) });
    mlInd.push({ rotulo: "Última execução", valor: haQuanto(mlUltima, now) });
    mlErro = faltando.total > 0 || falhasBaixa > 0 || empresasFalha > 0;
    mlAtencao ||= aptos > 0;
  }
  m.automacoes.push({
    id: "conciliacao-ml",
    titulo: "Conciliação Mercado Livre",
    href: "/conciliacao-mercado-livre",
    status: mlInd.length ? statusDe(mlErro, mlAtencao) : "sem_dados",
    ultimaExecucao: mlUltima,
    indicadores: mlInd.length ? mlInd : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "conciliacao_ml:ver",
  });

  // ---- Dashboard Financeiro
  const dInd: AutomacaoResumo["indicadores"] = [];
  let dErro = false;
  let dAtencao = false;
  let dUltima: string | null = null;
  if (sync.ok) {
    const s = obj(sync.data);
    const empresas = arr(s.companies).map(obj);
    const falhas = empresas.filter((c) => c.ok === false).length;
    dUltima = str(s.last_sync_finished_at);
    const idade = horasDesde(dUltima, now);
    pendencia(m, "dashboard_financeiro:ver", {
      id: "dash-sync-falha",
      automacao: "dashboard-financeiro",
      titulo: "Sincronização do Dashboard Financeiro com falha",
      descricao: `${pl(falhas, "empresa não sincronizou", "empresas não sincronizaram")} na última rodada; os números dela podem estar desatualizados.`,
      quantidade: falhas,
      severidade: "critica",
      href: "/dashboard-financeiro",
      acao: "Ver sincronização",
      desde: dUltima,
    });
    const parada = idade === null || idade > 24;
    if (parada)
      pendencia(m, "dashboard_financeiro:ver", {
        id: "dash-sync-parada",
        automacao: "dashboard-financeiro",
        titulo: "Dashboard Financeiro sem sincronizar há mais de 1 dia",
        descricao: dUltima ? `A última sincronização foi ${haQuanto(dUltima, now)}.` : "Nenhuma sincronização foi concluída ainda.",
        quantidade: null,
        severidade: "atencao",
        href: "/dashboard-financeiro",
        acao: "Sincronizar agora",
        desde: dUltima,
      });
    if (str(s.erro_gravacao))
      pendencia(m, "dashboard_financeiro:ver", {
        id: "dash-gravacao",
        automacao: "dashboard-financeiro",
        titulo: "Dashboard Financeiro não consegue salvar a sincronização",
        descricao: "A sincronização roda, mas o servidor não grava o resultado. Peça ajuda à TI.",
        quantidade: null,
        severidade: "critica",
        href: "/admin/saude",
        acao: "Ver saúde do sistema",
      });
    dInd.push({ rotulo: "Empresas sincronizadas", valor: `${empresas.length - falhas} de ${empresas.length}` });
    dInd.push({ rotulo: "Última sincronização", valor: haQuanto(dUltima, now) });
    dErro = falhas > 0;
    dAtencao = parada;
  }
  m.automacoes.push({
    id: "dashboard-financeiro",
    titulo: "Dashboard Financeiro",
    href: "/dashboard-financeiro",
    status: dInd.length ? statusDe(dErro, dAtencao) : "sem_dados",
    ultimaExecucao: dUltima,
    indicadores: dInd.length ? dInd : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "dashboard_financeiro:ver",
  });

  // ---- Serviços
  m.servicos.push(servicoDe("mariadb", "MariaDB", r.get("mariadb")));
  m.servicos.push(servicoDe("tiny", "Tiny ERP", r.get("tiny")));
  m.servicos.push(
    inter.ok
      ? (() => {
          const emp = arr(obj(inter.data).empresas).map(obj);
          const ok = emp.filter((e) => e.inter_status === "conectado").length;
          return {
            id: "inter",
            nome: "Banco Inter",
            conectado: emp.length > 0 && ok === emp.length,
            mensagem: emp.length === 0 ? "Nenhuma filial configurada." : `${ok} de ${emp.length} filiais conectadas.`,
          };
        })()
      : { id: "inter", nome: "Banco Inter", conectado: false, mensagem: "Não foi possível verificar agora." },
  );
  m.servicos.push(
    sef.ok
      ? (() => {
          const c = certificados(obj(sef.data));
          const ruim = c.criticos.length > 0;
          return {
            id: "sefaz",
            nome: "SEFAZ",
            conectado: !ruim,
            mensagem: ruim ? "Há certificado vencido ou com problema." : "Varredura e certificados em dia.",
          };
        })()
      : { id: "sefaz", nome: "SEFAZ", conectado: false, mensagem: "Não foi possível verificar agora." },
  );
  m.servicos.push(
    ml.ok
      ? (() => {
          const f = conexoesAusentes(obj(ml.data));
          return {
            id: "mercado-livre",
            nome: "Mercado Livre / Mercado Pago",
            conectado: f.total === 0,
            mensagem: f.total === 0 ? "Contas conectadas." : `Sem conexão — ${f.texto}.`,
          };
        })()
      : { id: "mercado-livre", nome: "Mercado Livre / Mercado Pago", conectado: false, mensagem: "Não foi possível verificar agora." },
  );
  return m;
}

function servicoDe(id: string, nome: string, r: Resultado): ServicoStatus {
  if (!r.ok) return { id, nome, conectado: false, mensagem: "Não foi possível verificar agora." };
  const d = obj(r.data);
  return { id, nome, conectado: d.connected === true, mensagem: str(d.message) ?? (d.connected === true ? "Conectado." : "Sem conexão.") };
}

function buildLogistica(r: Raw, now: Date): Montado {
  const m = novo();
  const c = r.get("contagens");
  const ind: AutomacaoResumo["indicadores"] = [];
  let erro = false;
  let atencao = false;
  let ultima: string | null = null;
  if (c.ok) {
    const d = c.data as ContagemResumo;
    ultima = d.ultimaEm;
    pendencia(m, "contagem_estoque:ver", {
      id: "contagem-aguardando",
      automacao: "contagem-estoque",
      titulo: "Contagens aguardando conferência",
      descricao: `${pl(d.aguardando, "contagem espera", "contagens esperam")} a conferência da quantidade antes de ir para o Tiny.`,
      quantidade: d.aguardando,
      severidade: "atencao",
      href: "/contagem-estoque",
      acao: "Conferir contagens",
      desde: d.maisAntigaAguardando,
    });
    pendencia(m, "contagem_estoque:ver", {
      id: "contagem-sem-sku",
      automacao: "contagem-estoque",
      titulo: "Contagens sem produto identificado",
      descricao: `${pl(d.semSku, "contagem chegou", "contagens chegaram")} sem o código do produto e ${d.semSku === 1 ? "precisa" : "precisam"} do SKU.`,
      quantidade: d.semSku,
      severidade: "atencao",
      href: "/contagem-estoque",
      acao: "Informar SKU",
    });
    pendencia(m, "contagem_estoque:ver", {
      id: "contagem-sem-envio",
      automacao: "contagem-estoque",
      titulo: "Contagens conferidas ainda não lançadas no Tiny",
      descricao: `${pl(d.semEnvio, "contagem conferida ainda não foi", "contagens conferidas ainda não foram")} enviada${d.semEnvio === 1 ? "" : "s"} ao estoque do Tiny.`,
      quantidade: d.semEnvio,
      severidade: "atencao",
      href: "/contagem-estoque",
      acao: "Enviar ao Tiny",
    });
    pendencia(m, "contagem_estoque:ver", {
      id: "contagem-envio-erro",
      automacao: "contagem-estoque",
      titulo: "Lançamentos no Tiny com erro",
      descricao: `${pl(d.envioErro, "lançamento de estoque falhou", "lançamentos de estoque falharam")}. Confira o saldo no Tiny antes de reenviar.`,
      quantidade: d.envioErro,
      severidade: "critica",
      href: "/contagem-estoque",
      acao: "Reenviar ao Tiny",
    });
    ind.push({ rotulo: "Contagens registradas", valor: String(d.total) });
    ind.push({ rotulo: "Lançadas no Tiny", valor: String(d.lancadas) });
    ind.push({ rotulo: "Aguardando conferência", valor: String(d.aguardando) });
    ind.push({ rotulo: "Última contagem", valor: haQuanto(d.ultimaEm, now) });
    erro = d.envioErro > 0;
    atencao = d.aguardando + d.semSku + d.semEnvio > 0;
  }
  m.automacoes.push({
    id: "contagem-estoque",
    titulo: "Contagem de Estoque",
    href: "/contagem-estoque",
    status: ind.length ? statusDe(erro, atencao) : "sem_dados",
    ultimaExecucao: ultima,
    indicadores: ind.length ? ind : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "contagem_estoque:ver",
  });
  m.servicos.push(servicoDe("tiny", "Tiny ERP", r.get("tiny")));
  m.servicos.push(
    c.ok
      ? {
          id: "bot-contagem",
          nome: "Bot de contagem",
          conectado: true,
          mensagem: `Registro das contagens lido; última contagem ${haQuanto((c.data as ContagemResumo).ultimaEm, now)}.`,
        }
      : { id: "bot-contagem", nome: "Bot de contagem", conectado: false, mensagem: "Registro das contagens indisponível." },
  );
  return m;
}

const ultimaDe = (x: unknown): string | null => {
  const e = obj(x);
  return str(e.concluida_em) ?? str(e.finalizada_em) ?? str(e.iniciada_em);
};
const execucaoRuim = (x: unknown): "erro" | "parcial" | null => {
  const s = obj(x).status;
  return s === "erro" || s === "falha" ? "erro" : s === "parcial" ? "parcial" : null;
};

function buildMarketplace(r: Raw, now: Date): Montado {
  const m = novo();
  const dim = r.get("dimensoes");
  const fre = r.get("fretes");

  // ---- Padronização de dimensões
  const dInd: AutomacaoResumo["indicadores"] = [];
  let dErro = false;
  let dAtencao = false;
  let dUltima: string | null = null;
  if (dim.ok) {
    const d = obj(dim.data);
    const porStatus = obj(d.por_status);
    const aguardando = num(porStatus.pendente);
    const comErro = num(d.com_erro_de_envio);
    dUltima = ultimaDe(d.ultima_execucao);
    pendencia(m, "dimensoes:ver", {
      id: "dimensoes-confirmar",
      automacao: "dimensoes",
      titulo: "Produtos a enviar ao Mercado Livre aguardando confirmação",
      descricao: `${pl(aguardando, "produto tem", "produtos têm")} medidas do Tiny diferentes das do anúncio; confirme para enviar ao Mercado Livre.`,
      quantidade: aguardando,
      severidade: "atencao",
      href: "/padronizacao-dimensoes",
      acao: "Confirmar envios",
    });
    pendencia(m, "dimensoes:ver", {
      id: "dimensoes-erro",
      automacao: "dimensoes",
      titulo: "Envios de medidas ao Mercado Livre com erro",
      descricao: `${pl(comErro, "produto não foi enviado", "produtos não foram enviados")} por erro; reenvie depois de conferir.`,
      quantidade: comErro,
      severidade: "critica",
      href: "/padronizacao-dimensoes",
      acao: "Reenviar",
    });
    const bloqueados = num(porStatus.bloqueado);
    pendencia(m, "dimensoes:ver", {
      id: "dimensoes-bloqueado",
      automacao: "dimensoes",
      titulo: "Produtos bloqueados no Mercado Livre",
      descricao: `${pl(bloqueados, "produto tem", "produtos têm")} anúncio em que o ML não aceita as medidas do Tiny (ex.: peso bruto leve demais, medidas do próprio ML); corrija no Tiny ou no ML.`,
      quantidade: bloqueados,
      severidade: "atencao",
      href: "/padronizacao-dimensoes",
      acao: "Ver bloqueados",
    });
    const semSku = num(d.anuncios_sem_sku);
    pendencia(m, "dimensoes:ver", {
      id: "dimensoes-sem-sku",
      automacao: "dimensoes",
      titulo: "Anúncios sem SKU",
      descricao: `${pl(semSku, "anúncio não tem", "anúncios não têm")} SKU e ficam fora da padronização.`,
      quantidade: semSku,
      severidade: "info",
      href: "/padronizacao-dimensoes",
      acao: "Ver anúncios",
    });
    const semMedida = num(porStatus.sem_medida);
    pendencia(m, "dimensoes:ver", {
      id: "dimensoes-sem-medida",
      automacao: "dimensoes",
      titulo: "Produtos sem medidas no Tiny",
      descricao: `${pl(semMedida, "produto não tem", "produtos não têm")} peso e dimensões cadastrados no Tiny.`,
      quantidade: semMedida,
      severidade: "info",
      href: "/padronizacao-dimensoes",
      acao: "Ver produtos",
    });
    if (execucaoRuim(d.ultima_execucao))
      pendencia(m, "dimensoes:ver", {
        id: "dimensoes-execucao-falha",
        automacao: "dimensoes",
        titulo: "Última coleta de dimensões falhou",
        descricao: "A rotina de coleta das medidas terminou com falha.",
        quantidade: null,
        severidade: "critica",
        href: "/padronizacao-dimensoes",
        acao: "Ver coleta",
        desde: dUltima,
      });
    dInd.push({ rotulo: "Produtos monitorados", valor: String(num(d.total_produtos)) });
    dInd.push({ rotulo: "Aguardando confirmação", valor: String(aguardando) });
    dInd.push({ rotulo: "Enviados ao ML", valor: String(num(d.produtos_enviados)) });
    dInd.push({ rotulo: "Última coleta", valor: haQuanto(dUltima, now) });
    dErro = comErro > 0 || !!execucaoRuim(d.ultima_execucao);
    dAtencao = aguardando > 0;
  }
  m.automacoes.push({
    id: "dimensoes",
    titulo: "Padronização de dimensões",
    href: "/padronizacao-dimensoes",
    status: dInd.length ? statusDe(dErro, dAtencao) : "sem_dados",
    ultimaExecucao: dUltima,
    indicadores: dInd.length ? dInd : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "dimensoes:ver",
  });

  // ---- Fretes a combinar
  const fInd: AutomacaoResumo["indicadores"] = [];
  let fErro = false;
  let fAtencao = false;
  let fUltima: string | null = null;
  let mlConectado: boolean | null = null;
  let mlMsg = "Não foi possível verificar agora.";
  if (fre.ok) {
    const f = obj(fre.data);
    const cont = obj(f.contagem);
    fUltima = ultimaDe(f.ultima_execucao);
    const aCombinar = num(cont.a_combinar);
    const inconsistentes = num(cont.tipo_inconsistente);
    const bloqueados = num(cont.bloqueado);
    const falhas = num(cont.falha);
    const conferindo = num(f.aguardando_conferencia);
    pendencia(m, "fretes:ver", {
      id: "fretes-a-combinar",
      automacao: "fretes",
      titulo: "Anúncios em frete a combinar",
      descricao: `${pl(aCombinar, "anúncio está", "anúncios estão")} com frete a combinar e ${aCombinar === 1 ? "precisa" : "precisam"} ser corrigido${aCombinar === 1 ? "" : "s"}.`,
      quantidade: aCombinar,
      severidade: "atencao",
      href: "/fretes-a-combinar",
      acao: "Corrigir fretes",
    });
    pendencia(m, "fretes:ver", {
      id: "fretes-tipo",
      automacao: "fretes",
      titulo: "Anúncios com tipo de frete incoerente com a embalagem",
      descricao: `${pl(inconsistentes, "anúncio está", "anúncios estão")} com ME1/ME2 diferente do indicado pela embalagem.`,
      quantidade: inconsistentes,
      severidade: "atencao",
      href: "/fretes-a-combinar",
      acao: "Corrigir tipo de frete",
    });
    pendencia(m, "fretes:ver", {
      id: "fretes-bloqueados",
      automacao: "fretes",
      titulo: "Anúncios que a automação não consegue corrigir",
      descricao: `${pl(bloqueados, "anúncio está", "anúncios estão")} sem padrão de embalagem ou SKU e ${bloqueados === 1 ? "precisa" : "precisam"} de ajuste manual.`,
      quantidade: bloqueados,
      severidade: "info",
      href: "/fretes-a-combinar",
      acao: "Ver anúncios",
    });
    pendencia(m, "fretes:ver", {
      id: "fretes-conferencia",
      automacao: "fretes",
      titulo: "Anúncios aguardando conferência",
      descricao: `${pl(conferindo, "anúncio foi alterado e está", "anúncios foram alterados e estão")} sendo conferido${conferindo === 1 ? "" : "s"} para ver se o Mercado Livre manteve a correção.`,
      quantidade: conferindo,
      severidade: "info",
      href: "/fretes-a-combinar",
      acao: "Acompanhar",
    });
    pendencia(m, "fretes:ver", {
      id: "fretes-falha",
      automacao: "fretes",
      titulo: "Anúncios com falha no envio da correção",
      descricao: `${pl(falhas, "anúncio voltou", "anúncios voltaram")} ao frete a combinar ou ${falhas === 1 ? "falhou" : "falharam"} ao corrigir; tente de novo.`,
      quantidade: falhas,
      severidade: "critica",
      href: "/fretes-a-combinar",
      acao: "Tentar novamente",
    });
    const contas = Object.values(obj(f.contas)).map(obj);
    const desconectadas = contas.filter((c) => c.conectada === false);
    pendencia(m, "fretes:ver", {
      id: "ml-token-desconectado",
      automacao: "fretes",
      titulo: "Conta do Mercado Livre desconectada",
      descricao: `${desconectadas.map((c) => str(c.rotulo) ?? "conta").join(", ")} sem acesso ao Mercado Livre; as rotinas dessa conta não rodam.`,
      quantidade: desconectadas.length,
      severidade: "critica",
      href: "/fretes-a-combinar",
      acao: "Ver contas",
    });
    if (execucaoRuim(f.ultima_execucao))
      pendencia(m, "fretes:ver", {
        id: "fretes-execucao-falha",
        automacao: "fretes",
        titulo: "Última verificação de fretes falhou",
        descricao: "A rotina diária de fretes terminou com falha.",
        quantidade: null,
        severidade: "critica",
        href: "/fretes-a-combinar",
        acao: "Ver verificação",
        desde: fUltima,
      });
    mlConectado = contas.length > 0 && desconectadas.length === 0;
    mlMsg = contas.length === 0 ? "Nenhuma conta configurada." : mlConectado ? "Contas conectadas." : `${desconectadas.length} conta(s) sem conexão.`;
    fInd.push({ rotulo: "Anúncios no catálogo", valor: String(num(f.total_anuncios)) });
    fInd.push({ rotulo: "Em frete a combinar", valor: String(aCombinar) });
    fInd.push({ rotulo: "Com falha", valor: String(falhas) });
    fInd.push({ rotulo: "Última verificação", valor: haQuanto(fUltima, now) });
    fErro = falhas > 0 || desconectadas.length > 0 || !!execucaoRuim(f.ultima_execucao);
    fAtencao = aCombinar + inconsistentes + bloqueados > 0;
  }
  m.automacoes.push({
    id: "fretes",
    titulo: "Fretes a combinar",
    href: "/fretes-a-combinar",
    status: fInd.length ? statusDe(fErro, fAtencao) : "sem_dados",
    ultimaExecucao: fUltima,
    indicadores: fInd.length ? fInd : [{ rotulo: "Situação", valor: "Fonte indisponível" }],
    perm: "fretes:ver",
  });

  m.servicos.push({ id: "mercado-livre", nome: "Mercado Livre", conectado: mlConectado === true, mensagem: mlMsg });
  m.servicos.push(servicoDe("tiny", "Tiny ERP", r.get("tiny")));
  return m;
}

function buildProducao(): Montado {
  const m = novo();
  m.automacoes.push({
    id: "etiquetas",
    titulo: "Etiquetas de produto",
    href: "/producao",
    status: "sem_dados",
    ultimaExecucao: null,
    indicadores: [{ rotulo: "Situação", valor: "Servidor no PC da produção" }],
    perm: "prod_visao_geral:ver",
  });
  m.servicos.push({
    id: "etiquetas",
    nome: "Servidor de etiquetas",
    conectado: false,
    mensagem: "Roda no PC do encarregado da produção; o painel não consegue verificá-lo daqui.",
  });
  return m;
}

// ------------------------------------------------------------------ fontes por área

function fontesDaArea(area: AreaVisaoGeralId, deps: AreaOverviewDeps, now: () => Date): FonteDef[] {
  const fin = (path: string, ms = 8000) => {
    if (!deps.fetchFinanceiro) throw new Error("Motor financeiro não configurado");
    return deps.fetchFinanceiro(path, ms);
  };
  const mkt = (path: string) => {
    if (!deps.fetchMarketplace) throw new Error("Motor de marketplace não configurado");
    return deps.fetchMarketplace(path, 10_000);
  };
  const tiny: FonteDef = {
    id: "tiny",
    nome: "Tiny ERP",
    perm: "",
    servico: true,
    load: async () => (await deps.checkTiny?.()) ?? { connected: false, message: "Verificação não configurada." },
  };
  if (area === "financeiro") {
    return [
      { id: "nfe_pendentes", nome: "Notas aguardando categorização", perm: "revisao_nfe:ver", load: () => fin("/api/v1/danfe/pending-review") },
      { id: "nfe_historico", nome: "Histórico de NF-e", perm: "revisao_nfe:ver", load: () => fin("/api/v1/danfe/history?limit=1000", 12_000) },
      { id: "sefaz", nome: "Varredura da SEFAZ e certificados", perm: "revisao_nfe:ver", load: () => fin("/api/v1/danfe/sefaz-status") },
      { id: "baixas", nome: "Histórico de baixas", perm: "contas_pagar:ver", load: () => lerBaixas(deps, now()) },
      { id: "estado_pagar", nome: "Prévia de contas a pagar", perm: "contas_pagar:ver", load: () => fin("/api/v1/reconciliacao/estado", 10_000) },
      { id: "inter", nome: "Conexão com o Banco Inter", perm: "contas_pagar:ver", load: () => fin("/api/v1/reconciliacao/status", 15_000) },
      { id: "ml_status", nome: "Conciliação Mercado Livre", perm: "conciliacao_ml:ver", load: () => fin("/api/v1/conciliacao-ml/status", 10_000) },
      { id: "ml_pendencias", nome: "Pendências da Conciliação Mercado Livre", perm: "conciliacao_ml:ver", load: () => fin("/api/v1/conciliacao-ml/pendencias", 15_000) },
      { id: "fin_sync", nome: "Sincronização do Dashboard Financeiro", perm: "dashboard_financeiro:ver", load: () => fin("/api/v1/financial-dashboard/status") },
      tiny,
      {
        id: "mariadb",
        nome: "MariaDB",
        perm: "",
        servico: true,
        load: async () => (await deps.checkDatabase?.()) ?? { connected: false, message: "Verificação não configurada." },
      },
    ];
  }
  if (area === "logistica") {
    return [
      {
        id: "contagens",
        nome: "Contagens de estoque",
        perm: "contagem_estoque:ver",
        load: async () => {
          if (!deps.readContagens) throw new Error("Registro das contagens não configurado");
          return deps.readContagens();
        },
      },
      tiny,
    ];
  }
  if (area === "marketplace") {
    return [
      { id: "dimensoes", nome: "Padronização de dimensões", perm: "dimensoes:ver", load: () => mkt("/api/v1/dimensoes/status") },
      { id: "fretes", nome: "Fretes a combinar", perm: "fretes:ver", load: () => mkt("/api/v1/fretes/status") },
      tiny,
    ];
  }
  return [];
}

async function lerBaixas(deps: AreaOverviewDeps, now: Date) {
  if (!deps.history) throw new Error("Histórico de baixas não configurado");
  const de = new Date(now.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
  const q = (status: Array<"sucesso" | "erro" | "pendente">, pageSize: number) =>
    deps.history!.list({ status, de, page: 1, pageSize });
  const [sucesso, erro, pendente] = await Promise.all([q(["sucesso"], 1), q(["erro"], 1), q(["pendente"], 100)]);
  if (!sucesso.disponivel) throw new Error("Histórico de baixas indisponível");
  const corte = now.getTime() - 30 * 60_000;
  const antigas = pendente.itens.filter((i) => Date.parse(i.executado_em) <= corte);
  // Mais de uma página de pendentes: o total é o melhor número disponível.
  const pendentes = pendente.total > pendente.itens.length ? pendente.total : antigas.length;
  return {
    sucesso: sucesso.total,
    erro: erro.total,
    pendente: pendentes,
    ultimaEm: isoMax([sucesso.itens[0]?.executado_em ?? null, erro.itens[0]?.executado_em ?? null, pendente.itens[0]?.executado_em ?? null]),
    erroDesde: erro.itens.at(-1)?.executado_em ?? null,
    pendenteDesde: isoMin(antigas.map((i) => i.executado_em)),
  };
}

/** Lê contagens.json do bot + conferências/envios do painel e resume o que está pendente. */
export function createContagemReader(opts: { dir: () => string; skus: StockSkuService }): () => Promise<ContagemResumo> {
  return async () => {
    const dir = opts.dir().trim();
    if (!dir) throw new Error("Registro das contagens não configurado");
    const arquivo = join(dir, "contagens.json");
    const vazio: ContagemResumo = { total: 0, aguardando: 0, semSku: 0, semEnvio: 0, envioErro: 0, lancadas: 0, ultimaEm: null, maisAntigaAguardando: null };
    if (!existsSync(arquivo)) return vazio;
    const dados = JSON.parse(await readFile(arquivo, "utf-8")) as Record<string, Obj>;
    const [manuais, excluidas, conferencias, envios] = await Promise.all([
      opts.skus.listar(),
      opts.skus.excluidas(),
      opts.skus.conferencias(),
      opts.skus.enviosTiny(),
    ]);
    const r = { ...vazio };
    const aguardandoDatas: Array<string | null> = [];
    const todas: Array<string | null> = [];
    for (const item of Object.values(dados)) {
      const id = str(item.id) ?? "";
      if (excluidas.has(id)) continue;
      r.total++;
      todas.push(str(item.criado_em));
      const sku = str(item.codigo) ?? manuais.get(id)?.sku ?? null;
      const status = conferencias.get(id)?.status ?? str(item.status);
      if (!sku) {
        r.semSku++;
        continue;
      }
      if (status === "aguardando_confirmacao") {
        r.aguardando++;
        aguardandoDatas.push(str(item.criado_em));
        continue;
      }
      const envio = envios.get(id);
      if (!envio) r.semEnvio++;
      else if (envio.status === "erro") r.envioErro++;
      else if (envio.status === "lancado") r.lancadas++;
    }
    r.ultimaEm = isoMax(todas);
    r.maisAntigaAguardando = isoMin(aguardandoDatas);
    return r;
  };
}

/** GET JSON a uma automação, sob circuit breaker; falha de rede/HTTP vira exceção. */
export function createAutomationJsonFetcher(opts: {
  breaker: string;
  baseUrl: () => Promise<string> | string;
  fetchImpl: typeof fetch;
  invalidate?: () => void;
}): (path: string, timeoutMs?: number) => Promise<unknown> {
  return async (path, timeoutMs = 8000) => {
    const res = await callAutomation(
      opts.breaker,
      async () => opts.fetchImpl(`${await opts.baseUrl()}${path}`, { signal: AbortSignal.timeout(timeoutMs) }),
      { invalidate: opts.invalidate },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

// ------------------------------------------------------------------ dados de demonstração

function demoDados(area: AreaVisaoGeralId, now: Date): FonteDef[] {
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const fonte = (id: string, nome: string, perm: string, data: unknown, servico = false): FonteDef => ({
    id,
    nome,
    perm,
    servico,
    load: async () => data,
  });
  const tiny = fonte("tiny", "Tiny ERP", "", { connected: true, message: "Demonstração com dados fictícios; conexão real não verificada." }, true);
  if (area === "financeiro") {
    return [
      fonte("nfe_pendentes", "Notas aguardando categorização", "revisao_nfe:ver", { total: 7, pending: [{ staged_at: ago(52) }, { staged_at: ago(5) }] }),
      fonte("nfe_historico", "Histórico de NF-e", "revisao_nfe:ver", {
        total: 5,
        history: [
          { audit_status: "success", processed_at: ago(3) },
          { audit_status: "success", processed_at: ago(30) },
          { audit_status: "success", processed_at: ago(80) },
          { audit_status: "error", processed_at: ago(26), resolved_at: null },
          { audit_status: "error", processed_at: ago(70), resolved_at: null },
        ],
      }),
      fonte("sefaz", "Varredura da SEFAZ e certificados", "revisao_nfe:ver", {
        last_scan_finished_at: ago(6),
        cnpjs: [{ cnpj: "00000000000000", status: "ok" }],
        certificados: [{ arquivo: "fabrilux.pfx", titular: "Fabrilux", dias_restantes: 22, alerta: true, erro: null }],
      }),
      fonte("baixas", "Histórico de baixas", "contas_pagar:ver", { sucesso: 42, erro: 1, pendente: 0, ultimaEm: ago(2), erroDesde: ago(30), pendenteDesde: null }),
      fonte("estado_pagar", "Prévia de contas a pagar", "contas_pagar:ver", { atualizado_em: ago(4), summary: { total_casados: 5 } }),
      fonte("inter", "Conexão com o Banco Inter", "contas_pagar:ver", { empresas: [{ nome: "Fabrilux", inter_status: "conectado" }, { nome: "Revesta", inter_status: "conectado" }] }),
      fonte("ml_status", "Conciliação Mercado Livre", "conciliacao_ml:ver", {
        empresas: [
          { id: "fabrilux", nome: "Fabrilux", conexoes: { mercado_pago: true, mercado_livre: true, tiny: true }, ultima_analise: { criada_em: ago(10), resumo: { aptos_baixa: 12 } } },
        ],
        ultima_execucao: { concluida_em: ago(10), status: "ok", empresas: { fabrilux: { status: "ok" } } },
      }),
      fonte("ml_pendencias", "Pendências da Conciliação Mercado Livre", "conciliacao_ml:ver", {
        empresas: [{ id: "fabrilux", nome: "Fabrilux", analise_criada_em: ago(10), aptos_baixa: 12, lancamentos_nao_exportados: 30 }],
      }),
      fonte("fin_sync", "Sincronização do Dashboard Financeiro", "dashboard_financeiro:ver", {
        last_sync_finished_at: ago(3),
        companies: [{ account_id: "fabrilux", ok: true }, { account_id: "revesta", ok: true }],
      }),
      tiny,
      fonte("mariadb", "MariaDB", "", { connected: true, message: "Demonstração com dados fictícios; conexão real não verificada." }, true),
    ];
  }
  if (area === "logistica") {
    const resumo: ContagemResumo = { total: 64, aguardando: 3, semSku: 1, semEnvio: 0, envioErro: 1, lancadas: 58, ultimaEm: ago(5), maisAntigaAguardando: ago(20) };
    return [fonte("contagens", "Contagens de estoque", "contagem_estoque:ver", resumo), tiny];
  }
  if (area === "marketplace") {
    return [
      fonte("dimensoes", "Padronização de dimensões", "dimensoes:ver", {
        total_produtos: 320,
        por_status: { pendente: 14, sem_medida: 6, padronizado: 300 },
        com_erro_de_envio: 2,
        produtos_enviados: 118,
        anuncios_sem_sku: 4,
        ultima_execucao: { concluida_em: ago(9), status: "ok" },
      }),
      fonte("fretes", "Fretes a combinar", "fretes:ver", {
        total_anuncios: 1450,
        contagem: { a_combinar: 9, tipo_inconsistente: 3, falha: 1, bloqueado: 2 },
        aguardando_conferencia: 5,
        contas: { campinas: { rotulo: "Campinas", conectada: true } },
        ultima_execucao: { concluida_em: ago(8), status: "ok" },
      }),
      tiny,
    ];
  }
  return [];
}

// ------------------------------------------------------------------ serviço

const PERM_VISAO: Record<AreaVisaoGeralId, string> = {
  financeiro: "fin_visao_geral:ver",
  logistica: "log_visao_geral:ver",
  marketplace: "mkt_visao_geral:ver",
  producao: "prod_visao_geral:ver",
};
export const areaViewKey = (area: AreaVisaoGeralId): string => PERM_VISAO[area];

export function createAreaOverviewService(deps: AreaOverviewDeps): AreaOverviewService {
  const clock = deps.clock ?? (() => new Date());
  const cacheMs = deps.cacheMs ?? AREA_OVERVIEW_CACHE_MS;
  type Coletado = { geradoEm: Date; fontes: Array<{ def: FonteDef; res: Resultado }> };
  const cache = new Map<AreaVisaoGeralId, { em: number; promise: Promise<Coletado> }>();

  function coletar(area: AreaVisaoGeralId): Promise<Coletado> {
    const agora = clock().getTime();
    const hit = cache.get(area);
    if (hit && agora - hit.em < cacheMs) return hit.promise; // inclui leitura em andamento (dedupe)
    const promise = (async (): Promise<Coletado> => {
      const defs = deps.mode === "demo" ? demoDados(area, clock()) : fontesDaArea(area, deps, clock);
      const settled = await Promise.allSettled(defs.map((d) => Promise.resolve().then(() => d.load())));
      return {
        geradoEm: clock(),
        fontes: defs.map((def, i) => {
          const s = settled[i]!;
          if (s.status === "fulfilled") return { def, res: { ok: true as const, data: s.value } };
          const aberto = s.reason instanceof CircuitBreakerOpenError;
          return {
            def,
            res: {
              ok: false as const,
              mensagem: aberto
                ? "Serviço temporariamente indisponível; tentaremos de novo em instantes."
                : "Não foi possível consultar agora.",
            },
          };
        }),
      };
    })();
    cache.set(area, { em: agora, promise });
    return promise;
  }

  return {
    async read(area, can) {
      const coletado = await coletar(area);
      const mapa = new Map(coletado.fontes.map((f) => [f.def.id, f.res]));
      const raw: Raw = { get: (id) => mapa.get(id) ?? { ok: false, mensagem: "Fonte não consultada." } };
      const montado =
        area === "financeiro"
          ? buildFinanceiro(raw, coletado.geradoEm, deps)
          : area === "logistica"
            ? buildLogistica(raw, coletado.geradoEm)
            : area === "marketplace"
              ? buildMarketplace(raw, coletado.geradoEm)
              : buildProducao();
      // Filtro por permissão da aba de origem — por usuário, depois do cache.
      const acoesPendentes = montado.acoes
        .filter((a) => can(a.perm))
        .map(({ perm: _perm, ...a }): AcaoPendente => a)
        .sort(
          (a, b) =>
            SEV_RANK[a.severidade] - SEV_RANK[b.severidade] ||
            (b.quantidade ?? 0) - (a.quantidade ?? 0) ||
            a.titulo.localeCompare(b.titulo, "pt-BR"),
        );
      return {
        area,
        geradoEm: coletado.geradoEm.toISOString(),
        acoesPendentes,
        automacoes: montado.automacoes.filter((a) => can(a.perm)).map(({ perm: _perm, ...a }): AutomacaoResumo => a),
        servicos: montado.servicos,
        indisponiveis: coletado.fontes
          .filter((f) => !f.res.ok && !f.def.servico && (!f.def.perm || can(f.def.perm)))
          .map((f) => ({ fonte: f.def.nome, mensagem: (f.res as { mensagem: string }).mensagem })),
      };
    },
  };
}
