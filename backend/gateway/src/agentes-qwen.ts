/**
 * Aba "Agentes Qwen" (Sistema): histórico das correções dos agentes Qwen (repo agentes-qwen, no
 * PC do TI). O coletor da VPS lê GET /painel do orquestrador pelo túnel SSH e repassa aqui a cada
 * minuto (POST /api/agentes-qwen/estado, `Authorization: Bearer <AGENTES_QWEN_TOKEN>`, o mesmo
 * INCIDENTES_TOKEN do coletor). O gateway guarda o último estado (PC desligado: a aba mostra o
 * último recebido e há quanto tempo) e avisa quem tem `agentes_qwen:ver` (+ admins):
 *   PR aguardando aprovação · loop não resolveu (precisa do TI) · PR aprovado (rodar o deploy) ·
 *   correção confirmada nas 5 execuções seguintes.
 * Cada aviso sai uma vez por incidente × volta × situação (tabela agentes_qwen_avisos), e só para
 * incidente mexido nas últimas AVISO_JANELA_MS: o primeiro repasse não reavisa o histórico.
 *
 * "Marcar como resolvido" (`agentes_qwen:resolver`): o painel não alcança o PC, então o pedido fica
 * em agentes_qwen_comandos e volta na resposta de cada repasse; o coletor entrega ao orquestrador
 * (POST /comandos). O pedido sai da fila quando um estado seguinte mostra o incidente resolvido.
 *
 * "Reportar erro" (botão das abas, incidents.ts): o reporte vai pelo mesmo caminho, como comando
 * `reportar`; o PC junta ao incidente do mesmo erro (sem duplicar) e devolve o id do reporte em
 * `reportes` do incidente, o que liga o reporte ao incidente e o tira da fila.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";
import { logWarn } from "./errors.js";
import type { DbRow } from "./database.js";

export const AGENTES_QWEN_PERMISSAO = "agentes_qwen:ver";
export const AGENTES_QWEN_LINK = "/admin/agentes-qwen";
const AVISO_JANELA_MS = 48 * 3600_000;
const INCIDENTES_MAX = 500;

export type AgentesQwenGrupo = "em_andamento" | "pr_pendente" | "aguardando_deploy" | "monitorando" | "precisa_ti" | "resolvido";
const GRUPOS: readonly AgentesQwenGrupo[] = ["em_andamento", "pr_pendente", "aguardando_deploy", "monitorando", "precisa_ti", "resolvido"];

export interface AgentesQwenIncidente {
  id: number;
  servico: string | null;
  evento: string | null;
  rota: string | null;
  mensagem: string | null;
  estado: string;
  grupo: AgentesQwenGrupo;
  volta: number;
  ocorrencias: number;
  primeiroEm: string | null;
  ultimoEm: string | null;
  atualizadoEm: string | null;
  diagnostico: string | null;
  nota: string | null;
  pr: {
    url: string;
    numero: number | null;
    aprovadoPor: string | null;
    aprovadoEm: string | null;
    mergeadoEm: string | null;
    mergeSha: string | null;
  } | null;
  deployEm: string | null;
  deploy: string[];
  acompanhamento:
    | { modo: "rota"; rota: string; alvo: number; acompanhadas: number; sucessos: number }
    | { modo: "janela"; ate: string | null }
    | null;
  historico: { evento: string; volta: number; detalhe: string | null; em: string }[];
  /** Reportes do painel ligados ao incidente (id = incidentes.id do MariaDB). */
  reportes: { id: number; automacao: string | null; referencia: string | null; por: string | null; em: string | null }[];
}

export interface AgentesQwenEstado {
  geradoEm: string;
  commitProducao: string | null;
  incidentes: AgentesQwenIncidente[];
}

export interface AgentesQwenResposta {
  /** null: o coletor ainda não repassou nenhum estado. */
  estado: AgentesQwenEstado | null;
  recebidoEm: string | null;
  /** Incidentes com "marcar como resolvido" pedido no painel e ainda não confirmado pelo PC. */
  resolucoesPendentes: number[];
}

/** Reporte do botão "Reportar erro" como o PC recebe (agentes/banco.py receber_reporte). */
export interface AgentesQwenReporte {
  id: number;
  automacao: string;
  titulo: string;
  servico: string;
  referencia: string;
  etapa: string | null;
  mensagem: string;
  nota: string | null;
  por: string;
  em: string;
}

export type AgentesQwenComando =
  | { acao: "resolver"; incidente: number; nota: string; por: string }
  | { acao: "reportar"; reporte: AgentesQwenReporte };

/** Fila dos reportes (incidents.ts): o que falta entregar e a ligação com o que o PC devolveu. */
export interface AgentesQwenReportes {
  pendentes(): Promise<AgentesQwenReporte[]>;
  sincronizar(incidentes: AgentesQwenIncidente[]): Promise<void>;
}

export interface AgentesQwenService {
  bootstrap(): Promise<void>;
  /** Confere o token do repasse (tempo constante). Sem AGENTES_QWEN_TOKEN configurado: sempre falso. */
  tokenValido(authorization: string | undefined): boolean;
  receber(estado: AgentesQwenEstado, agora?: Date): Promise<{ avisos: number; comandos: AgentesQwenComando[] }>;
  ler(): Promise<AgentesQwenResposta>;
  /** Pede ao PC para marcar o incidente como resolvido (entregue no próximo repasse). */
  pedirResolucao(incidente: number, nota: string, por: string): Promise<"ok" | "nao_encontrado" | "ja_resolvido">;
}

type Aviso = { tipo: string; titulo: string; mensagem?: string; link?: string };

const erro = (campo: string): never => {
  throw new Error(`Estado dos agentes inválido: ${campo}`);
};
const obj = (v: unknown, campo: string): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : erro(campo);
const texto = (v: unknown, campo: string): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : erro(campo));
const inteiro = (v: unknown, campo: string): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : erro(campo));

/** Valida o corpo do repasse e devolve só os campos conhecidos. */
export function parseAgentesQwenEstado(corpo: unknown): AgentesQwenEstado {
  const raiz = obj(corpo, "corpo");
  if (!Array.isArray(raiz.incidentes) || raiz.incidentes.length > INCIDENTES_MAX) erro("incidentes");
  return {
    geradoEm: texto(raiz.geradoEm, "geradoEm") ?? erro("geradoEm"),
    commitProducao: texto(raiz.commitProducao, "commitProducao"),
    incidentes: (raiz.incidentes as unknown[]).map((v, i) => {
      const c = `incidentes[${i}]`;
      const inc = obj(v, c);
      const grupo = inc.grupo as AgentesQwenGrupo;
      if (!GRUPOS.includes(grupo)) erro(`${c}.grupo`);
      const pr = inc.pr === null || inc.pr === undefined ? null : obj(inc.pr, `${c}.pr`);
      const ac = inc.acompanhamento === null || inc.acompanhamento === undefined ? null : obj(inc.acompanhamento, `${c}.acompanhamento`);
      return {
        id: inteiro(inc.id, `${c}.id`),
        servico: texto(inc.servico, `${c}.servico`),
        evento: texto(inc.evento, `${c}.evento`),
        rota: texto(inc.rota, `${c}.rota`),
        mensagem: texto(inc.mensagem, `${c}.mensagem`),
        estado: texto(inc.estado, `${c}.estado`) ?? erro(`${c}.estado`),
        grupo,
        volta: inteiro(inc.volta, `${c}.volta`),
        ocorrencias: inteiro(inc.ocorrencias, `${c}.ocorrencias`),
        primeiroEm: texto(inc.primeiroEm, `${c}.primeiroEm`),
        ultimoEm: texto(inc.ultimoEm, `${c}.ultimoEm`),
        atualizadoEm: texto(inc.atualizadoEm, `${c}.atualizadoEm`),
        diagnostico: texto(inc.diagnostico, `${c}.diagnostico`),
        nota: texto(inc.nota, `${c}.nota`),
        pr: pr && {
          url: texto(pr.url, `${c}.pr.url`) ?? erro(`${c}.pr.url`),
          numero: pr.numero === null || pr.numero === undefined ? null : inteiro(pr.numero, `${c}.pr.numero`),
          aprovadoPor: texto(pr.aprovadoPor, `${c}.pr.aprovadoPor`),
          aprovadoEm: texto(pr.aprovadoEm, `${c}.pr.aprovadoEm`),
          mergeadoEm: texto(pr.mergeadoEm, `${c}.pr.mergeadoEm`),
          mergeSha: texto(pr.mergeSha, `${c}.pr.mergeSha`),
        },
        deployEm: texto(inc.deployEm, `${c}.deployEm`),
        deploy: Array.isArray(inc.deploy) ? inc.deploy.map((l, j) => texto(l, `${c}.deploy[${j}]`) ?? "") : [],
        acompanhamento: !ac
          ? null
          : ac.modo === "rota"
            ? {
                modo: "rota" as const,
                rota: texto(ac.rota, `${c}.acompanhamento.rota`) ?? "",
                alvo: inteiro(ac.alvo, `${c}.acompanhamento.alvo`),
                acompanhadas: inteiro(ac.acompanhadas, `${c}.acompanhamento.acompanhadas`),
                sucessos: inteiro(ac.sucessos, `${c}.acompanhamento.sucessos`),
              }
            : { modo: "janela" as const, ate: texto(ac.ate, `${c}.acompanhamento.ate`) },
        historico: (Array.isArray(inc.historico) ? inc.historico : []).map((h, j) => {
          const e = obj(h, `${c}.historico[${j}]`);
          return {
            evento: texto(e.evento, `${c}.historico[${j}].evento`) ?? "",
            volta: inteiro(e.volta, `${c}.historico[${j}].volta`),
            detalhe: texto(e.detalhe, `${c}.historico[${j}].detalhe`),
            em: texto(e.em, `${c}.historico[${j}].em`) ?? "",
          };
        }),
        reportes: (Array.isArray(inc.reportes) ? inc.reportes : []).map((r, j) => {
          const e = obj(r, `${c}.reportes[${j}]`);
          return {
            id: inteiro(e.id, `${c}.reportes[${j}].id`),
            automacao: texto(e.automacao, `${c}.reportes[${j}].automacao`),
            referencia: texto(e.referencia, `${c}.reportes[${j}].referencia`),
            por: texto(e.por, `${c}.reportes[${j}].por`),
            em: texto(e.em, `${c}.reportes[${j}].em`),
          };
        }),
      };
    }),
  };
}

const quem = (inc: AgentesQwenIncidente) => `${inc.servico ?? "serviço"}${inc.rota ? ` · ${inc.rota}` : ""}`;
const prRotulo = (inc: AgentesQwenIncidente) => (inc.pr?.numero ? `PR #${inc.pr.numero}` : "PR");

/** Aviso que o estado atual do incidente merece (chave de deduplicação + conteúdo), ou null. */
export function avisoDoIncidente(inc: AgentesQwenIncidente): { chave: string; aviso: Aviso } | null {
  const base = `${inc.id}:${inc.volta}`;
  const resumo = inc.diagnostico ?? inc.mensagem ?? undefined;
  const link = AGENTES_QWEN_LINK;
  switch (inc.grupo) {
    case "pr_pendente":
      if (!inc.pr) return null;
      return {
        chave: `${base}:pr`,
        aviso: { tipo: "agentes_qwen", titulo: `Qwen: ${prRotulo(inc)} aguardando sua aprovação (incidente #${inc.id})`, mensagem: `${quem(inc)}. ${resumo ?? ""}`.trim(), link },
      };
    case "precisa_ti":
      return {
        chave: `${base}:ti:${inc.estado}`,
        aviso: { tipo: "agentes_qwen", titulo: `Qwen não resolveu o incidente #${inc.id}: precisa de você`, mensagem: `${quem(inc)}. ${inc.nota ?? resumo ?? ""}`.trim(), link },
      };
    case "aguardando_deploy":
      return {
        chave: `${base}:deploy`,
        aviso: { tipo: "agentes_qwen", titulo: `Qwen: ${prRotulo(inc)} aprovado, rode o deploy na VPS`, mensagem: `Incidente #${inc.id} (${quem(inc)}). Comandos na aba Agentes Qwen.`, link },
      };
    case "resolvido": {
      const ac = inc.acompanhamento;
      const detalhe = ac?.modo === "rota" ? `${ac.acompanhadas}/${ac.alvo} execuções acompanhadas com ${ac.sucessos}/${ac.alvo} sucessos.` : (inc.nota ?? "");
      return {
        chave: `${base}:resolvido`,
        aviso: { tipo: "agentes_qwen", titulo: `Qwen: correção do incidente #${inc.id} confirmada`, mensagem: `${quem(inc)}. ${detalhe}`.trim(), link },
      };
    }
    default:
      return null;
  }
}

function sha256(v: string): Buffer {
  return createHash("sha256").update(v, "utf8").digest();
}

export function createAgentesQwenService(
  config: Config,
  pool: Pool | undefined,
  deps: { notify(key: string, data: Aviso): Promise<void>; reportes?: AgentesQwenReportes },
): AgentesQwenService {
  const tokenDigest = config.agentesQwenToken ? sha256(config.agentesQwenToken) : null;
  let tabelasOk = false;
  let memoria: Omit<AgentesQwenResposta, "resolucoesPendentes"> = { estado: null, recebidoEm: null };
  const avisadosMemoria = new Set<string>();
  // incidente → comando pendente (cópia em memória da tabela agentes_qwen_comandos)
  const pendentes = new Map<number, Extract<AgentesQwenComando, { acao: "resolver" }>>();
  let pendentesCarregados = false;

  async function query<T = DbRow>(sql: string, valores: unknown[] = []): Promise<T> {
    if (!pool) throw new Error("Pool de banco não configurado");
    const conn = await pool.getConnection();
    try {
      return (await conn.query({ sql, timeout: config.timeoutMs }, valores)) as T;
    } finally {
      conn.release();
    }
  }

  /** true se a chave ainda não tinha sido avisada (e marca como avisada). */
  async function marcar(chave: string): Promise<boolean> {
    if (tabelasOk) {
      try {
        const r = await query<{ affectedRows?: number }>("INSERT IGNORE INTO agentes_qwen_avisos (chave) VALUES (?)", [chave]);
        return Number(r.affectedRows ?? 0) > 0;
      } catch (err) {
        logWarn("agentes_qwen_aviso_db_failed", err);
      }
    }
    if (avisadosMemoria.has(chave)) return false;
    avisadosMemoria.add(chave);
    return true;
  }

  async function carregarPendentes(): Promise<void> {
    if (pendentesCarregados || !tabelasOk) return;
    try {
      const linhas = await query<DbRow[]>("SELECT incidente_id, nota, usuario FROM agentes_qwen_comandos WHERE concluido_em IS NULL ORDER BY id");
      for (const l of linhas) {
        const incidente = Number(l.incidente_id);
        pendentes.set(incidente, { acao: "resolver", incidente, nota: String(l.nota ?? ""), por: String(l.usuario ?? "") });
      }
      pendentesCarregados = true;
    } catch (err) {
      logWarn("agentes_qwen_comandos_db_failed", err);
    }
  }

  async function concluir(incidente: number): Promise<void> {
    pendentes.delete(incidente);
    if (!tabelasOk) return;
    try {
      await query("UPDATE agentes_qwen_comandos SET concluido_em = NOW() WHERE incidente_id = ? AND concluido_em IS NULL", [incidente]);
    } catch (err) {
      logWarn("agentes_qwen_comandos_db_failed", err);
    }
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS agentes_qwen_estado (
            id TINYINT PRIMARY KEY,
            dados LONGTEXT NOT NULL,
            recebido_em DATETIME(3) NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await query(`
          CREATE TABLE IF NOT EXISTS agentes_qwen_avisos (
            chave VARCHAR(96) PRIMARY KEY,
            criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await query(`
          CREATE TABLE IF NOT EXISTS agentes_qwen_comandos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            incidente_id INT NOT NULL,
            acao VARCHAR(16) NOT NULL,
            nota TEXT NULL,
            usuario VARCHAR(100) NULL,
            criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            concluido_em DATETIME NULL,
            INDEX idx_agentes_qwen_comandos_pendentes (concluido_em, incidente_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        tabelasOk = true;
      } catch (err) {
        console.warn("[AgentesQwen] Falha ao criar as tabelas agentes_qwen_*; estado só em memória:", err);
      }
    },

    tokenValido(authorization) {
      if (!tokenDigest || !authorization?.startsWith("Bearer ")) return false;
      return timingSafeEqual(sha256(authorization.slice(7).trim()), tokenDigest);
    },

    async receber(estado, agora = new Date()) {
      memoria = { estado, recebidoEm: agora.toISOString() };
      if (tabelasOk) {
        try {
          await query(
            `INSERT INTO agentes_qwen_estado (id, dados, recebido_em) VALUES (1, ?, ?)
             ON DUPLICATE KEY UPDATE dados = VALUES(dados), recebido_em = VALUES(recebido_em)`,
            [JSON.stringify(estado), agora],
          );
        } catch (err) {
          logWarn("agentes_qwen_estado_db_failed", err);
        }
      }
      await carregarPendentes();
      for (const inc of estado.incidentes) if (inc.grupo === "resolvido" && pendentes.has(inc.id)) await concluir(inc.id);
      let reportes: AgentesQwenReporte[] = [];
      try {
        await deps.reportes?.sincronizar(estado.incidentes);
        reportes = (await deps.reportes?.pendentes()) ?? [];
      } catch (err) {
        logWarn("agentes_qwen_reportes_failed", err);
      }
      let avisos = 0;
      for (const inc of estado.incidentes) {
        const mexido = Date.parse(inc.atualizadoEm ?? "");
        if (!Number.isFinite(mexido) || agora.getTime() - mexido > AVISO_JANELA_MS) continue;
        const a = avisoDoIncidente(inc);
        if (!a || !(await marcar(a.chave))) continue;
        await deps.notify(AGENTES_QWEN_PERMISSAO, a.aviso);
        avisos++;
      }
      return {
        avisos,
        comandos: [...pendentes.values(), ...reportes.map((reporte) => ({ acao: "reportar" as const, reporte }))],
      };
    },

    async pedirResolucao(incidente, nota, por) {
      const atual = (await this.ler()).estado?.incidentes.find((i) => i.id === incidente);
      if (!atual) return "nao_encontrado";
      if (atual.grupo === "resolvido") return "ja_resolvido";
      const comando = { acao: "resolver" as const, incidente, nota: nota.trim().slice(0, 2000), por: por.slice(0, 100) };
      if (tabelasOk && !pendentes.has(incidente)) {
        try {
          await query("INSERT INTO agentes_qwen_comandos (incidente_id, acao, nota, usuario) VALUES (?, 'resolver', ?, ?)", [incidente, comando.nota, comando.por]);
        } catch (err) {
          logWarn("agentes_qwen_comandos_db_failed", err);
        }
      }
      pendentes.set(incidente, comando);
      return "ok";
    },

    async ler() {
      await carregarPendentes();
      const resposta = () => ({ ...memoria, resolucoesPendentes: [...pendentes.keys()] });
      if (memoria.estado || !tabelasOk) return resposta();
      try {
        const [linha] = await query<DbRow[]>("SELECT dados, recebido_em FROM agentes_qwen_estado WHERE id = 1");
        if (linha) {
          memoria = {
            estado: parseAgentesQwenEstado(JSON.parse(String(linha.dados))),
            recebidoEm: new Date(linha.recebido_em as string | Date).toISOString(),
          };
        }
      } catch (err) {
        logWarn("agentes_qwen_ler_failed", err);
      }
      return resposta();
    },
  };
}
