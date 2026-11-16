import type { AuditService } from "./audit.js";
import type { Dashboard, RoiAutomacao, RoiPeriodo, RoiResponse } from "./contracts.js";
import type { DanfeService } from "./danfe.js";
import { PERIODO_TOTAL, periodoAtivo } from "./periodo.js";
import type { ReconciliationHistoryService } from "./reconciliation-history.js";
import type { StockSkuService } from "./stock-sku.js";
import { automationFetch, callAutomation } from "./automation-http.js";
import { saoPauloParts } from "./overview.js";

/**
 * ROI das automações: uma conta só, usada pela tela "ROI das automações" (GET /api/roi).
 * Economia por item = tempo manual antes da automação − tempo que o usuário ainda gasta hoje
 * (revisar/confirmar na interface). Ajuste os números AQUI, em um lugar só.
 */
export const VALOR_HORA_REAIS = 11;

export interface RoiTarefa {
  id: string;
  titulo: string;
  unidade: string;
  /** Minutos por item na tarefa 100% manual (antes da automação). */
  minutosManual: number;
  /** Minutos por item que o usuário ainda gasta hoje na interface. */
  minutosAtual: number;
  tarefaManual: string;
  tarefaAtual: string;
}

export const ROI_TAREFAS = [
  {
    id: "accounts-payable",
    titulo: "Contas a Pagar (Inter × Tiny)",
    unidade: "baixa com sucesso",
    minutosManual: 5,
    minutosAtual: 0.5,
    tarefaManual: "Conferir o pagamento no Inter, localizar a conta no Tiny e dar a baixa à mão.",
    tarefaAtual: "Revisar a prévia e confirmar o lote.",
  },
  {
    id: "danfe-tiny",
    titulo: "NF-e / DANFE",
    unidade: "nota lançada com sucesso",
    minutosManual: 3,
    minutosAtual: 1,
    tarefaManual: "Abrir a nota, digitar os dados e lançar a conta a pagar no Tiny.",
    tarefaAtual: "Revisar a nota e confirmar o lançamento.",
  },
  {
    id: "conciliacao-ml",
    titulo: "Conciliação Mercado Livre",
    unidade: "recebimento baixado com sucesso",
    minutosManual: 3,
    minutosAtual: 0.5,
    tarefaManual: "Cruzar a venda do ML com a liberação do Mercado Pago e baixar o recebimento no Tiny.",
    tarefaAtual: "Conferir a análise e confirmar a baixa.",
  },
  {
    id: "dimensoes",
    titulo: "Padronização de dimensões",
    unidade: "produto com medidas enviadas ao ML",
    minutosManual: 1,
    minutosAtual: 1 / 60, // ~1 s por produto para confirmar no painel
    tarefaManual: "Buscar no Tiny as medidas e o peso bruto do produto e corrigir a ficha e a embalagem do anúncio no Mercado Livre.",
    tarefaAtual: "Confirmar no painel o envio das medidas do Tiny.",
  },
  {
    id: "fretes",
    titulo: "Tipo de frete",
    unidade: "anúncio trocado com sucesso",
    minutosManual: 1,
    minutosAtual: 0, // a rotina troca sozinha
    tarefaManual: "Achar o anúncio com frete a combinar ou com o tipo errado e trocar o tipo de envio no Mercado Livre.",
    tarefaAtual: "Acompanhar e retentar falhas.",
  },
  {
    id: "contagem-estoque",
    titulo: "Contagem de estoque",
    unidade: "contagem lançada no Tiny",
    minutosManual: 4,
    minutosAtual: 1,
    tarefaManual: "Contar, anotar e lançar a entrada de estoque no Tiny.",
    tarefaAtual: "Fotografar e conferir no painel.",
  },
  {
    id: "etiquetas",
    titulo: "Etiquetas de produção",
    unidade: "OP (estimativa)",
    minutosManual: 5,
    minutosAtual: 0,
    tarefaManual: "O encarregado montava e imprimia à mão as etiquetas de cada OP.",
    tarefaAtual: "As etiquetas saem direto do tablet da Produção.",
  },
] as const satisfies readonly RoiTarefa[];

export type RoiId = (typeof ROI_TAREFAS)[number]["id"];

/** Automações fora da conta (hoje nenhuma: as etiquetas entram por estimativa, ver abaixo). */
export const ROI_NAO_MEDIDAS: readonly { id: string; titulo: string; motivo: string }[] = [];

/**
 * Etiquetas de produção rodam no PC do encarregado e o servidor não vê as impressões, então o
 * ROI é estimado: ETIQUETAS_OPS_POR_DIA OPs por dia útil (segunda a sexta, sem descontar
 * feriados) desde ETIQUETAS_INICIO, contando o dia de hoje (horário de São Paulo).
 */
export const ETIQUETAS_INICIO = "2026-10-09";
export const ETIQUETAS_OPS_POR_DIA = 5;

/** Dias de segunda a sexta entre `inicio` e `fim` (AAAA-MM-DD), inclusive. */
export function diasUteisEntre(inicio: string, fim: string): number {
  const ultimo = Date.parse(`${fim}T00:00:00Z`);
  let dia = Date.parse(`${inicio}T00:00:00Z`);
  let total = 0;
  for (; dia <= ultimo; dia += 86_400_000) {
    const semana = new Date(dia).getUTCDay();
    if (semana !== 0 && semana !== 6) total += 1;
  }
  return total;
}

/** Dias de segunda a sexta entre `inicio` (AAAA-MM-DD) e hoje em São Paulo, inclusive. */
export function diasUteisDesde(inicio: string, now: Date): number {
  return diasUteisEntre(inicio, saoPauloParts(now).day);
}

const br = (iso: string) => iso.split("-").reverse().join("/");

/** Estimativa de OPs com etiqueta gerada pela automação até `now` (ou dentro do `periodo`). */
export function estimativaEtiquetas(now: Date, periodo: RoiPeriodo = PERIODO_TOTAL): RoiContagem {
  if (periodoAtivo(periodo)) {
    const de = periodo.de > ETIQUETAS_INICIO ? periodo.de : ETIQUETAS_INICIO;
    const hoje = saoPauloParts(now).day;
    const ate = periodo.ate < hoje ? periodo.ate : hoje;
    const dias = de <= ate ? diasUteisEntre(de, ate) : 0;
    return {
      itens: dias * ETIQUETAS_OPS_POR_DIA,
      observacao: `Estimativa: ${ETIQUETAS_OPS_POR_DIA} OPs por dia útil (segunda a sexta), ${dias} dia(s) útil(eis) no período de ${br(periodo.de)} a ${br(periodo.ate)} (contando só de ${br(ETIQUETAS_INICIO)} até hoje). O servidor não vê as impressões.`,
    };
  }
  const dias = diasUteisDesde(ETIQUETAS_INICIO, now);
  const inicio = br(ETIQUETAS_INICIO);
  return {
    itens: dias * ETIQUETAS_OPS_POR_DIA,
    observacao: `Estimativa: ${ETIQUETAS_OPS_POR_DIA} OPs por dia útil (segunda a sexta) desde ${inicio}, ${dias} dia(s) útil(eis) até hoje. O servidor não vê as impressões.`,
  };
}

/** Teto do histórico de trocas do serviço de marketplace (`MAX_TROCAS` em estado.py). */
export const MAX_TROCAS_FRETES = 2000;

const tarefa = (id: RoiId): RoiTarefa => ROI_TAREFAS.find((t) => t.id === id)!;

/** Minutos economizados por item (manual − atual). */
export function minutosEconomizadosPorItem(id: RoiId): number {
  const t = tarefa(id);
  return t.minutosManual - t.minutosAtual;
}

/** GW-12: a conta roda em inteiros (segundos e centavos) e só converte para horas/R$ no fim. */
export const VALOR_HORA_CENTAVOS = Math.round(VALOR_HORA_REAIS * 100);

/** Segundos e centavos economizados por `itens` itens da automação `id` (conta em inteiros). */
export function economiaInteira(id: RoiId, itens: number): { segundos: number; centavos: number } {
  const t = tarefa(id);
  const segundosPorItem = Math.round(t.minutosManual * 60) - Math.round(t.minutosAtual * 60);
  const segundos = Math.round(itens) * segundosPorItem;
  return { segundos, centavos: Math.round((segundos * VALOR_HORA_CENTAVOS) / 3600) };
}

/** Horas e R$ economizados por `itens` itens da automação `id` (a conta única do ROI). */
export function economia(id: RoiId, itens: number): { horas: number; reais: number } {
  const { segundos, centavos } = economiaInteira(id, itens);
  return { horas: segundos / 3600, reais: centavos / 100 };
}

/** Remove horas/R$ economizados das métricas (quem não tem `roi:ver` não os recebe). */
export function semRoiNasMetricas<T extends Dashboard>(d: T): T {
  if (!d.metrics) return d;
  const { hoursSaved: _h, estimatedSavings: _e, ...metrics } = d.metrics;
  return { ...d, metrics };
}

export interface RoiContagem {
  itens: number;
  observacao?: string | null;
}
export type RoiSources = Record<RoiId, (periodo: RoiPeriodo) => Promise<RoiContagem>>;

export function montarRoi(
  mode: Dashboard["mode"],
  resultados: Record<RoiId, PromiseSettledResult<RoiContagem>>,
  now: Date,
  periodo: RoiPeriodo = PERIODO_TOTAL,
): RoiResponse {
  const somas = { segundos: 0, centavos: 0 };
  const automacoes: RoiAutomacao[] = ROI_TAREFAS.map((t) => {
    const r = resultados[t.id];
    const base = {
      id: t.id,
      titulo: t.titulo,
      unidade: t.unidade,
      minutosManual: t.minutosManual,
      minutosAtual: t.minutosAtual,
      tarefaManual: t.tarefaManual,
      tarefaAtual: t.tarefaAtual,
    };
    if (r.status === "rejected") {
      return {
        ...base,
        itens: null,
        horasEconomizadas: null,
        reais: null,
        fonte: { status: "erro", mensagem: "Fonte indisponível no momento." },
        observacao: null,
      };
    }
    const itens = r.value.itens;
    const { segundos, centavos } = economiaInteira(t.id, itens);
    somas.segundos += segundos;
    somas.centavos += centavos;
    const horas = segundos / 3600;
    const reais = centavos / 100;
    return {
      ...base,
      itens,
      horasEconomizadas: horas,
      reais,
      fonte: { status: "ok" },
      observacao: r.value.observacao ?? null,
    };
  });
  const medidas = automacoes.filter((a) => a.fonte.status === "ok");
  return {
    mode,
    generatedAt: now.toISOString(),
    periodo: { de: periodo.de, ate: periodo.ate },
    valorHora: VALOR_HORA_REAIS,
    automacoes,
    totais: {
      horasEconomizadas: somas.segundos / 3600,
      reais: somas.centavos / 100,
      parcial: medidas.length < automacoes.length,
    },
    naoMedidas: ROI_NAO_MEDIDAS.map((n) => ({ ...n })),
  };
}

/** Tempo em que a leitura do ROI fica em cache (as fontes consultam MariaDB e automações). */
export const ROI_CACHE_MS = 60_000;

/** Quantos períodos diferentes o cache guarda ao mesmo tempo. */
export const ROI_CACHE_MAX = 20;

export function createRoiService(mode: Dashboard["mode"], sources: RoiSources, clock = () => new Date()) {
  // GW-06: cache de 60 s + dedupe de leituras simultâneas (mesmo padrão do overview.ts), por período.
  const cache = new Map<string, { at: number; value: RoiResponse }>();
  const emAndamento = new Map<string, Promise<RoiResponse>>();
  return {
    async read(periodo: RoiPeriodo = PERIODO_TOTAL): Promise<RoiResponse> {
      const chave = `${periodo.de ?? ""}|${periodo.ate ?? ""}`;
      const now = clock().getTime();
      const cached = cache.get(chave);
      if (cached && now - cached.at < ROI_CACHE_MS) return cached.value;
      const inflight = emAndamento.get(chave);
      if (inflight) return inflight;
      const leitura = (async () => {
        const ids = ROI_TAREFAS.map((t) => t.id);
        const settled = await Promise.allSettled(ids.map((id) => sources[id](periodo)));
        const resultados = Object.fromEntries(ids.map((id, i) => [id, settled[i]!])) as Record<
          RoiId,
          PromiseSettledResult<RoiContagem>
        >;
        const value = montarRoi(mode, resultados, clock(), periodo);
        cache.delete(chave);
        cache.set(chave, { at: clock().getTime(), value });
        while (cache.size > ROI_CACHE_MAX) cache.delete(cache.keys().next().value as string);
        return value;
      })().finally(() => {
        emAndamento.delete(chave);
      });
      emAndamento.set(chave, leitura);
      return leitura;
    },
  };
}

/** Contagens de demonstração (modo demo: nada externo é consultado). */
export function demoRoiSources(clock: () => Date = () => new Date()): RoiSources {
  const fixo = (itens: number, observacao?: string) => async () => ({ itens, observacao });
  return {
    "accounts-payable": fixo(1092),
    "danfe-tiny": fixo(318),
    "conciliacao-ml": fixo(740),
    dimensoes: fixo(215),
    fretes: fixo(96),
    "contagem-estoque": fixo(130),
    etiquetas: async (periodo) => estimativaEtiquetas(clock(), periodo),
  };
}

export interface LiveRoiDeps {
  history: Pick<ReconciliationHistoryService, "resumo">;
  danfe: Pick<DanfeService, "contarLancadas">;
  audit: Pick<AuditService, "somarDetalhe">;
  stockSku: Pick<StockSkuService, "contarLancadas">;
  marketplaceUrl: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clock?: () => Date;
}

export function createLiveRoiSources(deps: LiveRoiDeps): RoiSources {
  const doFetch = deps.fetchImpl ?? automationFetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const clock = deps.clock ?? (() => new Date());
  /** `?de=&ate=` (ou `&`) para as rotas do marketplace que aceitam período. */
  const comPeriodo = (path: string, p: RoiPeriodo) =>
    periodoAtivo(p) ? `${path}${path.includes("?") ? "&" : "?"}de=${p.de}&ate=${p.ate}` : path;
  async function marketplace<T>(path: string): Promise<T> {
    const res = await callAutomation("marketplace", () =>
      doFetch(`${deps.marketplaceUrl()}/api/v1/${path}`, { signal: AbortSignal.timeout(timeoutMs) }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    "accounts-payable": async (periodo) => {
      const resumo = await deps.history.resumo(periodo);
      if (!resumo) throw new Error("Histórico de baixas indisponível");
      return { itens: resumo.contasBaixadas };
    },
    "danfe-tiny": async (periodo) => ({ itens: await deps.danfe.contarLancadas(periodo) }),
    // Fonte: trilha de auditoria (gateway), pois toda baixa ML sai por ml-reconciliation.ts e é
    // gravada com `sucessos`; não depende da poda de 400 dias do registro do serviço Python.
    "conciliacao-ml": async (periodo) => ({
      itens: await deps.audit.somarDetalhe("baixa_conciliacao_ml_executada", "sucessos", periodo),
    }),
    dimensoes: async (periodo) => {
      // Só o que a automação enviou: produto que já estava igual ao Tiny não poupou tempo.
      const s = await marketplace<{ produtos_enviados?: number }>(comPeriodo("dimensoes/status", periodo));
      return { itens: Number(s.produtos_enviados ?? 0) };
    },
    fretes: async (periodo) => {
      const [ok, todas] = await Promise.all([
        marketplace<{ total?: number; ok_arquivadas?: number }>(comPeriodo("fretes/historico?status=ok&limit=1", periodo)),
        marketplace<{ total?: number }>("fretes/historico?limit=1"),
      ]);
      // ok_arquivadas: trocas ok que já saíram do histórico (marketplace guarda as últimas 2.000).
      // Sem o campo (marketplace antigo), o total pode estar abaixo do real quando o histórico gira.
      const truncado = ok.ok_arquivadas === undefined && Number(todas.total ?? 0) >= MAX_TROCAS_FRETES;
      return {
        itens: Number(ok.total ?? 0) + Number(ok.ok_arquivadas ?? 0),
        observacao: truncado
          ? `O histórico de trocas guarda só as últimas ${MAX_TROCAS_FRETES}; o número pode estar abaixo do real.`
          : null,
      };
    },
    "contagem-estoque": async (periodo) => ({ itens: await deps.stockSku.contarLancadas(periodo) }),
    // Estimativa (o servidor não vê as impressões): recalculada a cada leitura, então sobe
    // sozinha a cada dia útil.
    etiquetas: async (periodo) => estimativaEtiquetas(clock(), periodo),
  };
}
