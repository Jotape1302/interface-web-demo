/**
 * Registro das ações dos usuários para treinar modelos que automatizem o trabalho humano no
 * painel (fine-tuning). Diferente da auditoria (audit.ts: quem fez o quê), aqui fica o exemplo
 * inteiro: o que a pessoa enviou, o que voltou e, nas ações instrumentadas, o que estava na tela
 * e o que a automação tinha sugerido antes da decisão humana.
 *
 * Captura genérica: toda requisição autenticada que altera algo (POST/PUT/PATCH/DELETE), menos
 * EXCLUIDAS (credenciais, contagem de estoque, conversa entre pessoas, leitura de notificação).
 * Contexto rico: a automação devolve `treino: { contexto, sugestao }` na resposta da ação e o
 * `send` do server.ts tira o campo (`separarTreino`) antes de responder ao painel; ou a rota chama
 * `anotarAtividade(request, { contexto, sugestao })`. Instrumentadas em 30/10: categorização e
 * arquivamento de NF-e, baixa da conciliação Inter e da ML, validação/reenvio de dimensões.
 *
 * Dados: os de negócio ficam completos (fornecedor, CNPJ, valores, categorias); senha, token e
 * chave de API viram "<oculto>"; CPF, e-mail e telefone de pessoa física viram "<pf>". Sem prazo de
 * retenção. Tabela `atividades_treino` (database/init/09-atividades-treino.sql); exportação em
 * scripts/exportar-atividades.sh. Gravação best-effort: nunca derruba nem atrasa a ação.
 */
import type { IncomingMessage } from "node:http";
import type { Pool } from "mariadb";
import type { Config } from "./config.js";
import { normalizarRota } from "./execucoes.js";

export interface AtividadeExtra {
  /** O que estava na tela / os dados de origem que a pessoa usou para decidir. */
  contexto?: unknown;
  /** O que a automação sugeriu antes da decisão humana. */
  sugestao?: unknown;
}

export interface AtividadeInput {
  usuarioId: number;
  perfil: string;
  setor: string;
  metodo: string;
  path: string;
  permissao: string | null;
  query: Record<string, string>;
  entrada: unknown;
  resposta: unknown;
  status: number;
  duracaoMs: number;
  requestId?: string;
  extra?: AtividadeExtra;
}

export interface AtividadesService {
  bootstrap(): Promise<void>;
  /** Nunca lança nem espera o banco. */
  registrar(input: AtividadeInput): void;
}

export const EXCLUIDAS: RegExp[] = [
  /^\/api\/auth\//, // login, senha, perfil
  /^\/api\/stock-count\//, // contagem de estoque fica fora por decisão do TI (30/10)
  /^\/api\/chat\//, // conversa entre pessoas
  /^\/api\/notifications\/(read-all|\d+\/read)$/,
  /^\/api\/events/,
];

const METODOS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Limite por campo gravado (o corpo de entrada já é limitado a 1 MB pelo http.ts). */
const CAMPO_MAX = 512 * 1024;
const TEXTO_MAX = 20_000;
const LISTA_MAX = 2000;

export function deveRegistrar(metodo: string, path: string): boolean {
  return METODOS.has(metodo) && path.startsWith("/api/") && !EXCLUIDAS.some((r) => r.test(path));
}

const extras = new WeakMap<IncomingMessage, AtividadeExtra>();

/** Contexto rico de uma ação instrumentada; vai junto com a captura genérica da mesma requisição. */
export function anotarAtividade(request: IncomingMessage, extra: AtividadeExtra): void {
  extras.set(request, { ...extras.get(request), ...extra });
}

/** Tira `treino` de uma resposta de automação (o painel não recebe) e guarda no registro da ação. */
export function separarTreino(request: IncomingMessage, corpo: unknown): unknown {
  if (corpo === null || typeof corpo !== "object" || Array.isArray(corpo) || !("treino" in corpo)) return corpo;
  const { treino, ...resto } = corpo as Record<string, unknown>;
  if (treino && typeof treino === "object" && !Array.isArray(treino)) {
    const { contexto, sugestao } = treino as AtividadeExtra;
    anotarAtividade(request, { contexto, sugestao });
  }
  return resto;
}

export function extraDaAtividade(request: IncomingMessage): AtividadeExtra | undefined {
  return extras.get(request);
}

const SEGREDO = /senha|password|passwd|token|secret|segredo|api[_-]?key|authorization|cookie|pfx|certificado_base64/i;
// nome_cliente: comprador do Mercado Livre (pessoa física); fornecedor e favorecido ficam (negócio).
// usuario/por: nome de quem fez (o registro já tem o usuario_id).
const PESSOAL =
  /^(cpf|email|e_mail|telefone|celular|phone|fone|whatsapp|rg|nome_cliente|comprador|buyer_nickname|usuario|usuario_nome|usuarioNome|nome_usuario|por)$/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const CPF_FORMATADO = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
// 11 dígitos soltos (CPF sem máscara ou celular): CNPJ (14) e chave de NF-e (44) não casam.
const ONZE_DIGITOS = /(?<!\d)\d{11}(?!\d)/g;
const TELEFONE = /\(\d{2}\)\s?\d{4,5}-?\d{4}/g;

function mascararTexto(texto: string): string {
  const limpo = texto
    .replace(EMAIL, "<pf>")
    .replace(CPF_FORMATADO, "<pf>")
    .replace(TELEFONE, "<pf>")
    .replace(ONZE_DIGITOS, "<pf>");
  return limpo.length > TEXTO_MAX ? `${limpo.slice(0, TEXTO_MAX)}…(+${limpo.length - TEXTO_MAX})` : limpo;
}

/** Cópia com segredos ocultos e dados de pessoa física mascarados. */
export function mascarar(valor: unknown, chave = "", profundidade = 0): unknown {
  if (chave && SEGREDO.test(chave)) return valor === null || valor === undefined || valor === "" ? valor : "<oculto>";
  if (chave && PESSOAL.test(chave)) return valor === null || valor === undefined || valor === "" ? valor : "<pf>";
  if (typeof valor === "string") return mascararTexto(valor);
  if (valor === null || typeof valor !== "object") return valor;
  if (profundidade > 12) return "<profundo demais>";
  if (Array.isArray(valor)) {
    const itens = valor.slice(0, LISTA_MAX).map((v) => mascarar(v, "", profundidade + 1));
    if (valor.length > LISTA_MAX) itens.push(`<+${valor.length - LISTA_MAX} itens>`);
    return itens;
  }
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) saida[k] = mascarar(v, k, profundidade + 1);
  return saida;
}

function json(valor: unknown): { texto: string | null; truncado: boolean } {
  if (valor === undefined) return { texto: null, truncado: false };
  const texto = JSON.stringify(mascarar(valor));
  if (texto === undefined) return { texto: null, truncado: false };
  return texto.length > CAMPO_MAX ? { texto: texto.slice(0, CAMPO_MAX), truncado: true } : { texto, truncado: false };
}

export function createAtividadesService(config: Config, pool: Pool | undefined): AtividadesService {
  let tabelaOk = false;
  let avisou = false;

  async function executar(sql: string, valores: unknown[] = []): Promise<void> {
    if (!pool) return;
    const conn = await pool.getConnection();
    try {
      await conn.query({ sql, timeout: config.timeoutMs }, valores);
    } finally {
      conn.release();
    }
  }

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await executar(`
          CREATE TABLE IF NOT EXISTS atividades_treino (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NULL,
            perfil VARCHAR(32) NULL,
            setor VARCHAR(64) NULL,
            metodo VARCHAR(8) NOT NULL,
            rota VARCHAR(255) NOT NULL,
            permissao VARCHAR(96) NULL,
            consulta TEXT NULL,
            entrada LONGTEXT NULL,
            contexto LONGTEXT NULL,
            sugestao LONGTEXT NULL,
            resposta LONGTEXT NULL,
            truncado TINYINT(1) NOT NULL DEFAULT 0,
            status SMALLINT NOT NULL,
            duracao_ms INT NULL,
            request_id VARCHAR(64) NULL,
            criado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            INDEX idx_atividades_criado (criado_em),
            INDEX idx_atividades_permissao (permissao, criado_em),
            INDEX idx_atividades_rota (rota, criado_em)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        tabelaOk = true;
      } catch (err) {
        console.warn("[AtividadesService] Falha ao criar a tabela atividades_treino; atividades não serão gravadas:", err);
      }
    },

    registrar(input) {
      if (!pool || !tabelaOk) return;
      const campos = [
        json(Object.keys(input.query).length ? input.query : undefined),
        json(input.entrada),
        json(input.extra?.contexto),
        json(input.extra?.sugestao),
        json(input.resposta),
      ];
      const valores = [
        input.usuarioId,
        input.perfil.slice(0, 32),
        input.setor.slice(0, 64),
        input.metodo.slice(0, 8),
        normalizarRota(input.path).slice(0, 255),
        input.permissao?.slice(0, 96) ?? null,
        ...campos.map((c) => c.texto),
        campos.some((c) => c.truncado) ? 1 : 0,
        input.status,
        Math.round(input.duracaoMs),
        input.requestId?.slice(0, 64) ?? null,
      ];
      executar(
        `INSERT INTO atividades_treino (usuario_id, perfil, setor, metodo, rota, permissao, consulta, entrada, contexto,
           sugestao, resposta, truncado, status, duracao_ms, request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        valores,
      ).catch((err) => {
        if (!avisou) {
          avisou = true;
          console.warn("[AtividadesService] Falha ao gravar atividade no MariaDB (próximas falhas sem log):", err);
        }
      });
    },
  };
}
