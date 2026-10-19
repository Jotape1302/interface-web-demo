import type {
  BaixaHistoricoQuery,
  BaixaItemInput,
  InterConnectionStatus,
  MatchMethod,
  ReconciliationCompanyStatus,
  ReconciliationJob,
  ReconciliationMatch,
  ReconciliationPreviewResponse,
  ReconciliationSummary,
} from "@/lib/reconciliation-contracts";
import { parseUtcDate } from "@/lib/formatters";

// Filiais conciliadas. Espelha EMPRESA_LABELS/INTER_DEFAULT_CREDENTIALS do backend
// (app/api.py) — o nome precisa bater com o prefixo que o backend usa nos avisos.
export const RECONCILIATION_COMPANIES: Array<{ id: string; nome: string; cnpj: string }> = [
  { id: "fabrilux", nome: "Fabrilux", cnpj: "43820617000166" },
  { id: "revesta", nome: "Revesta", cnpj: "36592814000100" },
  { id: "norvia_campinas", nome: "Norvia Campinas", cnpj: "27184930000107" },
  { id: "norvia_curitiba", nome: "Norvia Curitiba", cnpj: "27184930000280" },
];

export type StatusTone = "success" | "warning" | "danger" | "secondary";

// Estado exibido por filial: os status do backend mais dois derivados na tela —
// `falha_extrato` (credencial ok, mas a consulta do extrato falhou na prévia) e
// `desconhecido` (status não pôde ser verificado, ex.: API Python fora do ar).
export type InterHealth = InterConnectionStatus | "falha_extrato" | "desconhecido";

export const INTER_HEALTH_META: Record<InterHealth, { label: string; tone: StatusTone; hint: string }> = {
  conectado: {
    label: "Conectado",
    tone: "success",
    hint: "Certificado mTLS e token OAuth2 operacionais.",
  },
  certificados_ausentes: {
    label: "Certificados ausentes",
    tone: "danger",
    hint: "Os arquivos .crt e .key desta filial não foram encontrados no servidor.",
  },
  certificados_sem_permissao: {
    label: "Certificado sem permissão de leitura",
    tone: "danger",
    hint: "Os certificados existem, mas o container não consegue lê-los. Ajuste dono e permissões dos arquivos no volume.",
  },
  certificado_expirado: {
    label: "Certificado expirado",
    tone: "warning",
    hint: "Renove o certificado da integração no Internet Banking do Inter.",
  },
  erro_autenticacao: {
    label: "Erro de autenticação",
    tone: "danger",
    hint: "O Banco Inter recusou a autenticação. Confira client_id, client_secret e o certificado.",
  },
  nao_configurado: {
    label: "Não configurado",
    tone: "secondary",
    hint: "Filial sem credenciais do Banco Inter cadastradas.",
  },
  falha_extrato: {
    label: "Falha ao consultar extrato",
    tone: "danger",
    hint: "A conexão foi aceita, mas a consulta do extrato no Banco Inter falhou.",
  },
  desconhecido: {
    label: "Não verificado",
    tone: "secondary",
    hint: "Não foi possível verificar a conexão desta filial agora.",
  },
};

function isInterHealth(value: string | undefined): value is InterHealth {
  return value !== undefined && Object.prototype.hasOwnProperty.call(INTER_HEALTH_META, value);
}

/** Classifica uma mensagem de erro crua do Inter (ex.: `PermissionError(13, ...)`) num estado legível. */
export function classifyInterMessage(message: string): InterHealth {
  if (/sem permiss|permission ?denied|permissionerror/i.test(message)) return "certificados_sem_permissao";
  if (/ausente/i.test(message)) return "certificados_ausentes";
  if (/expirad/i.test(message)) return "certificado_expirado";
  if (/autentica/i.test(message)) return "erro_autenticacao";
  return "falha_extrato";
}

export interface ParsedAvisos {
  /** Mensagens de falha do Banco Inter, por id de filial. */
  inter: Map<string, string[]>;
  /** Demais avisos (Tiny ou sem filial identificada), já sem o prefixo da filial. */
  outros: Array<{ empresa: string | null; fonte: "tiny" | "outro"; mensagem: string }>;
}

/**
 * Separa os avisos da prévia por filial e origem. O backend escreve
 * "<Filial> (Inter): <msg>", "<Filial>: Falha ao consultar extrato no Banco Inter: <erro>"
 * ou "<Filial>: Falha ao consultar contas no Tiny: <erro>".
 */
export function parseAvisos(avisos: string[] | undefined): ParsedAvisos {
  const result: ParsedAvisos = { inter: new Map(), outros: [] };
  const byLongestName = [...RECONCILIATION_COMPANIES].sort((a, b) => b.nome.length - a.nome.length);
  for (const aviso of avisos ?? []) {
    const company = byLongestName.find((c) => aviso.startsWith(c.nome));
    if (!company) {
      result.outros.push({ empresa: null, fonte: "outro", mensagem: aviso });
      continue;
    }
    const rest = aviso.slice(company.nome.length);
    const isInterPrefix = rest.startsWith(" (Inter):");
    const mensagem = rest.slice(isInterPrefix ? " (Inter):".length : rest.indexOf(":") + 1).trim();
    if (isInterPrefix || /banco inter/i.test(mensagem)) {
      result.inter.set(company.id, [...(result.inter.get(company.id) ?? []), mensagem]);
    } else {
      result.outros.push({ empresa: company.nome, fonte: /tiny/i.test(mensagem) ? "tiny" : "outro", mensagem });
    }
  }
  return result;
}

/**
 * Estado efetivo do Inter numa filial, combinando o endpoint de status com os avisos da
 * última prévia. `detalhe` guarda o texto técnico cru para exibir recolhido.
 */
export function resolveInterHealth(
  status: ReconciliationCompanyStatus | undefined,
  previewMessages: string[] | undefined,
): { health: InterHealth; detalhe: string | null } {
  const messages = [status?.inter_mensagem, ...(previewMessages ?? [])].filter(
    (m, i, all): m is string => typeof m === "string" && m.trim().length > 0 && all.indexOf(m) === i,
  );
  const reported = status?.inter_status;
  let health: InterHealth;
  if (reported === "conectado") {
    health = previewMessages && previewMessages.length > 0 ? classifyInterMessage(previewMessages[0]) : "conectado";
  } else if (reported === "erro_autenticacao" && status?.inter_mensagem) {
    // Backends antigos reportam falta de permissão no certificado como erro de autenticação.
    const refined = classifyInterMessage(status.inter_mensagem);
    health = refined === "certificados_sem_permissao" ? refined : reported;
  } else if (isInterHealth(reported)) {
    health = reported;
  } else if (previewMessages && previewMessages.length > 0) {
    health = classifyInterMessage(previewMessages[0]);
  } else {
    health = "desconhecido";
  }
  const detalhe = health === "conectado" || messages.length === 0 ? null : messages.join("\n");
  return { health, detalhe };
}

/** Inter indisponível = a prévia desta filial saiu sem extrato bancário. */
export function isInterUnavailable(health: InterHealth): boolean {
  return health !== "conectado" && health !== "desconhecido";
}

export const MATCH_METHOD_META: Record<MatchMethod, { label: string; tone: "success" | "info" | "warning" }> = {
  CODIGO_BARRAS: { label: "Código de barras", tone: "success" },
  CNPJ_VALOR_DATA: { label: "CNPJ + valor + data", tone: "success" },
  DOCUMENTO_VALOR: { label: "Nº documento + valor", tone: "info" },
  CNPJ_VALOR: { label: "CNPJ + valor ajustado", tone: "info" },
  NOME_VALOR: { label: "Nome + valor", tone: "warning" },
  VALOR_DATA_UNICO: { label: "Valor único no período", tone: "warning" },
};

/** Confiança do casamento (0–1 no backend) como "95%". */
export function formatConfidence(confianca: number): string {
  const pct = confianca <= 1 ? confianca * 100 : confianca;
  return `${Math.round(pct)}%`;
}

/** Nome legível da filial a partir do id usado no backend (ex.: `fabrilux` → "Fabrilux"). */
export function companyLabel(id: string): string {
  return RECONCILIATION_COMPANIES.find((c) => c.id === id)?.nome ?? id;
}

/** Monta o item de baixa enviado ao gateway, com os metadados que alimentam o histórico. */
export function buildBaixaItem(m: ReconciliationMatch): BaixaItemInput {
  return {
    empresa: m.empresa,
    conta_pagar_id: m.conta_pagar_id,
    valor_pago: m.valor_pago,
    data_pagamento: m.data_pagamento,
    juros: m.juros,
    multa: m.multa,
    desconto: m.desconto,
    historico: m.historico_sugerido || `Baixa conciliada Banco Inter ${m.inter_transacao_id}`,
    conta_origem_id: m.conta_origem_id ?? null,
    numero_documento: m.numero_documento,
    fornecedor_nome: m.fornecedor_nome,
    data_vencimento: m.data_vencimento,
    valor_tiny: m.valor_tiny,
    inter_transacao_id: m.inter_transacao_id,
    metodo_match: m.metodo_match,
  };
}

export interface SeparatedTotals {
  jaBaixadas: { total: number; valor: number };
  transferencias: { total: number; valor: number };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Débitos que o backend tirou de "sem par" (já baixados no Tiny e transferências entre
 * empresas do grupo). Backends antigos não mandam esses campos: vira 0 / lista vazia.
 */
export function separatedTotals(data: ReconciliationPreviewResponse): SeparatedTotals {
  const pagos = data.ja_baixadas ?? [];
  const transf = data.transferencias_internas ?? [];
  const s: Partial<ReconciliationSummary> = data.summary ?? {};
  return {
    jaBaixadas: {
      total: finiteOr(s.total_ja_baixadas, pagos.length),
      valor: finiteOr(s.valor_ja_baixadas, pagos.reduce((acc, i) => acc + i.valor_pago, 0)),
    },
    transferencias: {
      total: finiteOr(s.total_transferencias_internas, transf.length),
      valor: finiteOr(s.valor_transferencias_internas, transf.reduce((acc, i) => acc + i.valor_pago, 0)),
    },
  };
}

/** Frase que explica por que "Débitos sem par" diminuiu; `null` quando nada foi separado. */
export function describeSeparated(totals: SeparatedTotals): string | null {
  const parts: string[] = [];
  const t = totals.transferencias.total;
  const p = totals.jaBaixadas.total;
  if (t > 0) parts.push(t === 1 ? "1 transferência entre empresas" : `${t} transferências entre empresas`);
  if (p > 0) parts.push(p === 1 ? "1 débito já baixado no Tiny" : `${p} débitos já baixados no Tiny`);
  if (parts.length === 0) return null;
  // Concordância: só transferências → feminino; havendo débitos → masculino.
  const participio = p > 0 ? "separado" : "separada";
  return `${parts.join(" e ")} ${t + p === 1 ? `foi ${participio}` : `foram ${participio}s`}.`;
}

/** Query string de GET /api/reconciliation/historico, sem parâmetros vazios. */
export function buildHistoricoSearchParams(query: BaixaHistoricoQuery): URLSearchParams {
  const params = new URLSearchParams();
  const lista = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean).join(",");
  const empresa = lista(query.empresa);
  const status = lista(query.status);
  if (empresa) params.set("empresa", empresa);
  if (status) params.set("status", status);
  if (query.de) params.set("de", query.de);
  if (query.ate) params.set("ate", query.ate);
  for (const campo of ["q", "fornecedor", "documento", "usuario"] as const) {
    const valor = query[campo]?.trim();
    if (valor) params.set(campo, valor);
  }
  if (query.page && query.page > 0) params.set("page", String(Math.floor(query.page)));
  if (query.pageSize && query.pageSize > 0) params.set("pageSize", String(Math.floor(query.pageSize)));
  return params;
}

/** Quantidade de páginas (mínimo 1) para o total informado pelo backend. */
export function historicoPageCount(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 1;
  return Math.ceil(total / pageSize);
}

const executadoEmFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Data/hora da execução como "DD/MM/AAAA HH:mm" (fuso de São Paulo). */
export function formatExecutadoEm(value: string | null | undefined): string {
  const d = parseUtcDate(value);
  return d ? executadoEmFormat.format(d).replace(",", "") : "—";
}

// ---------------------------------------------------------------------------
// Tarefas em segundo plano (prévia e baixa rodam como job no backend).

export const JOB_LOST_MESSAGE = "Tarefa perdida (a API foi reiniciada). Tente novamente.";

/** GET do job respondeu 404: a API reiniciou ou o job expirou. Não adianta insistir. */
export class JobLostError extends Error {
  constructor() {
    super(JOB_LOST_MESSAGE);
    this.name = "JobLostError";
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("A consulta foi cancelada.", "AbortError");
}

/** `setTimeout` que rejeita assim que o sinal é abortado. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
    const onAbort = () => {
      clearTimeout(timer.id);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

function isSameKind<T extends ReconciliationJob>(job: ReconciliationJob, ref: T): job is T {
  return job.tipo === ref.tipo;
}

export interface WaitForJobOptions<T extends ReconciliationJob> {
  signal?: AbortSignal;
  /** Intervalo entre consultas (padrão 2 s). */
  intervalMs?: number;
  /** Falhas seguidas de rede/HTTP toleradas antes de desistir (padrão 3). 404 nunca é tolerado. */
  maxConsecutiveErrors?: number;
  onProgress?: (job: T) => void;
  /** Injetável nos testes. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Consulta o job até sair de `executando`. Devolve o job concluído; lança o `erro`
 * do job, `JobLostError` no 404, ou o motivo do abort quando o sinal é cancelado.
 */
export async function waitForJob<T extends ReconciliationJob>(
  fetchJob: (jobId: string, signal?: AbortSignal) => Promise<ReconciliationJob>,
  initial: T,
  options: WaitForJobOptions<T> = {},
): Promise<T> {
  const { signal, intervalMs = 2000, maxConsecutiveErrors = 3, onProgress, sleep = abortableSleep } = options;
  let job = initial;
  let failures = 0;
  onProgress?.(job);
  while (job.status === "executando") {
    await sleep(intervalMs, signal);
    if (signal?.aborted) throw abortReason(signal);
    try {
      const next = await fetchJob(job.job_id, signal);
      if (!isSameKind(next, initial)) throw new Error("O servidor devolveu uma tarefa de outro tipo.");
      job = next;
      failures = 0;
      onProgress?.(job);
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal);
      if (e instanceof JobLostError) throw e;
      failures += 1;
      if (failures >= maxConsecutiveErrors) throw e;
    }
  }
  if (job.status === "erro") throw new Error(job.erro || "A tarefa terminou com erro no servidor.");
  if (job.resultado === null) throw new Error("A tarefa terminou sem devolver resultado.");
  return job;
}

export interface JobProgress {
  /** 0–100, ou `null` enquanto o backend ainda não sabe o total. */
  percent: number | null;
  label: string;
}

/** Linha de andamento: "Revesta: contas a pagar no Tiny · 2 de 4 filiais". */
export function describeJobProgress(
  job: Pick<ReconciliationJob, "etapa" | "atual" | "total">,
  unidade = "",
): JobProgress {
  const etapa = job.etapa?.trim() || "Processando…";
  if (!(job.total > 0)) return { percent: null, label: etapa };
  const atual = Math.min(Math.max(job.atual, 0), job.total);
  const sufixo = unidade ? ` ${unidade}` : "";
  return {
    percent: Math.round((atual / job.total) * 100),
    label: `${etapa} · ${atual} de ${job.total}${sufixo}`,
  };
}

/** Tempo decorrido como "45 s" ou "2 min 05 s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min === 0 ? `${sec} s` : `${min} min ${String(sec).padStart(2, "0")} s`;
}

const HORA_SP = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const DIA_SP = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

/**
 * Linha "de quando são os dados" da prévia (o backend guarda Inter/Tiny por 15 min):
 * "Dados consultados às 10:42 (em cache) · Comparar consulta de novo". Null sem `dados_de`.
 */
export function describeDadosDe(dadosDe: string | undefined, doCache: boolean | undefined, now = new Date()): string | null {
  if (!dadosDe) return null;
  const t = new Date(dadosDe);
  if (!Number.isFinite(t.getTime())) return null;
  const mesmoDia = DIA_SP.format(t) === DIA_SP.format(now);
  const quando = mesmoDia ? `às ${HORA_SP.format(t)}` : `em ${DIA_SP.format(t)} às ${HORA_SP.format(t)}`;
  return doCache
    ? `Dados do Inter e do Tiny consultados ${quando} (reaproveitados). Clique em Comparar para consultar de novo.`
    : `Dados do Inter e do Tiny consultados ${quando}.`;
}

/**
 * Linha de data/hora do estado persistente de Contas a Pagar:
 * "Última conferência realizada às 07:05. Clique em Comparar para atualizar sob demanda."
 */
export function describeEstadoAtualizadoEm(atualizadoEm: string | undefined | null, now = new Date()): string | null {
  if (!atualizadoEm) return null;
  const t = new Date(atualizadoEm);
  if (!Number.isFinite(t.getTime())) return null;
  const mesmoDia = DIA_SP.format(t) === DIA_SP.format(now);
  const quando = mesmoDia ? `às ${HORA_SP.format(t)}` : `em ${DIA_SP.format(t)} às ${HORA_SP.format(t)}`;
  return `Última conferência realizada ${quando}. Clique em Comparar para atualizar sob demanda.`;
}
