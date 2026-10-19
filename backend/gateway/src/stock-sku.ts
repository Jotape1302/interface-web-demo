import type { Pool } from "mariadb";
import type { Config } from "./config.js";

/**
 * SKU informado pelo painel para contagens que o bot registrou sem produto (origem "sem_produto").
 * Fica no MariaDB do gateway, e não no contagens.json do bot: o registro do bot é montado somente
 * leitura no gateway e é o bot quem o grava (com trava própria). A futura integração com o ERP
 * deve juntar as duas fontes. Espelha StockCountSkuManual em frontend/lib/stock-count-contracts.ts.
 */
export interface SkuManual {
  registro_id: string;
  sku: string;
  usuario_nome: string | null;
  informado_em: string;
}

/** Unidades por fardo quando a conferência não informa (cada marcador é um fardo). */
export const UNIDADES_POR_FARDO_PADRAO = 5;

/** Conferência feita no painel (desde 2026-10-13 o bot não pergunta nada no Telegram). */
export interface Conferencia {
  registro_id: string;
  status: "confirmada" | "corrigida";
  /** Fardos (marcadores) conferidos. */
  quantidade_final: number;
  unidades_por_fardo: number;
  /** Unidades fora de fardo, somadas ao total. */
  unidades_soltas: number;
  /** quantidade_final × unidades_por_fardo + unidades_soltas: o que vai para o Tiny. */
  unidades_total: number;
  usuario_nome: string | null;
  conferida_em: string;
}

/** Último envio da contagem ao estoque do Tiny (um por contagem; reenvio sobrescreve). */
export interface EnvioTiny {
  registro_id: string;
  status: "lancado" | "sem_entrada" | "erro";
  sku: string;
  /** Nome do produto no Tiny (confere se o SKU é o certo). */
  produto: string | null;
  unidades: number;
  saldo_anterior: number | null;
  entrada: number | null;
  id_lancamento: number | null;
  deposito: string | null;
  mensagem: string | null;
  usuario_nome: string | null;
  enviado_em: string;
}

export function unidadesTotal(fardos: number, porFardo: number, soltas: number): number {
  return fardos * porFardo + soltas;
}

export interface StockSkuService {
  /** Conferências do painel, por id do registro; prevalecem sobre o status gravado pelo bot. */
  conferencias(): Promise<Map<string, Conferencia>>;
  conferir(
    registroId: string,
    quantidadeDetectada: number,
    quantidadeFinal: number,
    usuario: { id?: number | null; nome?: string | null } | null,
    unidades?: { porFardo: number; soltas: number },
  ): Promise<Conferencia>;
  /** Envios ao Tiny, por id do registro. */
  enviosTiny(): Promise<Map<string, EnvioTiny>>;
  salvarEnvioTiny(envio: EnvioTiny, usuarioId: number | null): Promise<void>;
  bootstrap(): Promise<void>;
  /** Ids das contagens excluídas pelo painel (somem da tela; o registro do bot não é apagado). */
  excluidas(): Promise<Set<string>>;
  excluir(registroId: string, usuario: { id?: number | null; nome?: string | null } | null): Promise<void>;
  /** Todos os SKUs informados, por id do registro (a tabela é pequena: uma linha por contagem sem SKU). */
  listar(): Promise<Map<string, SkuManual>>;
  informar(registroId: string, sku: string, usuario: { id?: number | null; nome?: string | null } | null): Promise<SkuManual>;
}

/** SKU do painel: mesma normalização da legenda do bot (maiúsculas, sem espaços nas pontas, até 60). */
export function normalizarSku(valor: unknown): string | null {
  const sku = String(valor ?? "").trim().toUpperCase();
  if (!sku || sku.length > 60 || !/^[A-Z0-9][A-Z0-9 ._\/-]*$/.test(sku)) return null;
  return sku;
}

export function createStockSkuService(config: Config, pool: Pool | undefined): StockSkuService {
  // Modo demo e testes (sem banco): guarda em memória.
  const memoria = new Map<string, SkuManual>();
  const excluidasMemoria = new Set<string>();
  const conferenciasMemoria = new Map<string, Conferencia>();
  const enviosMemoria = new Map<string, EnvioTiny>();

  async function query<T = any>(sql: string, values: unknown[] = []): Promise<T[]> {
    const conn = await pool!.getConnection();
    try {
      return (await conn.query({ sql, timeout: config.timeoutMs }, values)) as T[];
    } finally {
      conn.release();
    }
  }

  const mapRow = (r: any): SkuManual => ({
    registro_id: String(r.registro_id),
    sku: String(r.sku),
    usuario_nome: r.usuario_nome ?? null,
    informado_em: r.informado_em instanceof Date ? r.informado_em.toISOString() : String(r.informado_em),
  });

  return {
    async bootstrap() {
      if (!pool) return;
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS contagem_estoque_sku_manual (
            registro_id CHAR(12) NOT NULL PRIMARY KEY,
            sku VARCHAR(60) NOT NULL,
            usuario_id INT NULL,
            usuario_nome VARCHAR(255) NULL,
            informado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_sku_manual_sku (sku)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        await query(`
          CREATE TABLE IF NOT EXISTS contagem_estoque_excluidas (
            registro_id CHAR(12) NOT NULL PRIMARY KEY,
            usuario_id INT NULL,
            usuario_nome VARCHAR(255) NULL,
            excluida_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        await query(`
          CREATE TABLE IF NOT EXISTS contagem_estoque_conferencia (
            registro_id CHAR(12) NOT NULL PRIMARY KEY,
            status VARCHAR(12) NOT NULL,
            quantidade_final INT NOT NULL,
            usuario_id INT NULL,
            usuario_nome VARCHAR(255) NULL,
            conferida_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        // Fardo configurável e unidades soltas (2026-10-14); conferências antigas ficam 5 e 0.
        await query(`
          ALTER TABLE contagem_estoque_conferencia
            ADD COLUMN IF NOT EXISTS unidades_por_fardo INT NOT NULL DEFAULT ${UNIDADES_POR_FARDO_PADRAO},
            ADD COLUMN IF NOT EXISTS unidades_soltas INT NOT NULL DEFAULT 0
        `);
        await query(`
          CREATE TABLE IF NOT EXISTS contagem_estoque_tiny (
            registro_id CHAR(12) NOT NULL PRIMARY KEY,
            status VARCHAR(12) NOT NULL,
            sku VARCHAR(60) NOT NULL,
            unidades INT NOT NULL,
            saldo_anterior DECIMAL(14,4) NULL,
            entrada DECIMAL(14,4) NULL,
            id_lancamento BIGINT NULL,
            deposito VARCHAR(120) NULL,
            mensagem VARCHAR(500) NULL,
            usuario_id INT NULL,
            usuario_nome VARCHAR(255) NULL,
            enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        await query(`ALTER TABLE contagem_estoque_tiny ADD COLUMN IF NOT EXISTS produto VARCHAR(255) NULL AFTER sku`);
      } catch (err) {
        console.error("[stock-sku] falha ao criar as tabelas da contagem de estoque:", err);
      }
    },

    async listar() {
      if (!pool) return new Map(memoria);
      const rows = await query(`SELECT registro_id, sku, usuario_nome, informado_em FROM contagem_estoque_sku_manual`);
      return new Map(rows.map((r) => [String(r.registro_id), mapRow(r)]));
    },

    async conferencias() {
      if (!pool) return new Map(conferenciasMemoria);
      const rows = await query(
        `SELECT registro_id, status, quantidade_final, unidades_por_fardo, unidades_soltas, usuario_nome, conferida_em
         FROM contagem_estoque_conferencia`,
      );
      return new Map(
        rows.map((r) => [
          String(r.registro_id),
          {
            registro_id: String(r.registro_id),
            status: r.status === "corrigida" ? "corrigida" : "confirmada",
            quantidade_final: Number(r.quantidade_final),
            unidades_por_fardo: Number(r.unidades_por_fardo ?? UNIDADES_POR_FARDO_PADRAO),
            unidades_soltas: Number(r.unidades_soltas ?? 0),
            unidades_total: unidadesTotal(
              Number(r.quantidade_final),
              Number(r.unidades_por_fardo ?? UNIDADES_POR_FARDO_PADRAO),
              Number(r.unidades_soltas ?? 0),
            ),
            usuario_nome: r.usuario_nome ?? null,
            conferida_em: r.conferida_em instanceof Date ? r.conferida_em.toISOString() : String(r.conferida_em),
          } satisfies Conferencia,
        ]),
      );
    },

    async conferir(registroId, quantidadeDetectada, quantidadeFinal, usuario, unidades) {
      const porFardo = unidades?.porFardo ?? UNIDADES_POR_FARDO_PADRAO;
      const soltas = unidades?.soltas ?? 0;
      const item: Conferencia = {
        registro_id: registroId,
        // Confirmada/corrigida fala dos fardos (o que o bot conta); as unidades são do painel.
        status: quantidadeFinal === quantidadeDetectada ? "confirmada" : "corrigida",
        quantidade_final: quantidadeFinal,
        unidades_por_fardo: porFardo,
        unidades_soltas: soltas,
        unidades_total: unidadesTotal(quantidadeFinal, porFardo, soltas),
        usuario_nome: usuario?.nome ?? null,
        conferida_em: new Date().toISOString(),
      };
      if (!pool) {
        conferenciasMemoria.set(registroId, item);
        return item;
      }
      await query(
        `INSERT INTO contagem_estoque_conferencia
           (registro_id, status, quantidade_final, unidades_por_fardo, unidades_soltas, usuario_id, usuario_nome, conferida_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE status = VALUES(status), quantidade_final = VALUES(quantidade_final),
           unidades_por_fardo = VALUES(unidades_por_fardo), unidades_soltas = VALUES(unidades_soltas),
           usuario_id = VALUES(usuario_id), usuario_nome = VALUES(usuario_nome), conferida_em = VALUES(conferida_em)`,
        [registroId, item.status, quantidadeFinal, porFardo, soltas, usuario?.id ?? null, item.usuario_nome],
      );
      return item;
    },

    async enviosTiny() {
      if (!pool) return new Map(enviosMemoria);
      const rows = await query(
        `SELECT registro_id, status, sku, produto, unidades, saldo_anterior, entrada, id_lancamento, deposito, mensagem,
                usuario_nome, enviado_em
         FROM contagem_estoque_tiny`,
      );
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return new Map(
        rows.map((r) => [
          String(r.registro_id),
          {
            registro_id: String(r.registro_id),
            status: r.status === "lancado" || r.status === "sem_entrada" ? r.status : "erro",
            sku: String(r.sku),
            produto: r.produto ?? null,
            unidades: Number(r.unidades),
            saldo_anterior: num(r.saldo_anterior),
            entrada: num(r.entrada),
            id_lancamento: num(r.id_lancamento),
            deposito: r.deposito ?? null,
            mensagem: r.mensagem ?? null,
            usuario_nome: r.usuario_nome ?? null,
            enviado_em: r.enviado_em instanceof Date ? r.enviado_em.toISOString() : String(r.enviado_em),
          } satisfies EnvioTiny,
        ]),
      );
    },

    async salvarEnvioTiny(envio, usuarioId) {
      if (!pool) {
        enviosMemoria.set(envio.registro_id, envio);
        return;
      }
      await query(
        `INSERT INTO contagem_estoque_tiny
           (registro_id, status, sku, produto, unidades, saldo_anterior, entrada, id_lancamento, deposito, mensagem,
            usuario_id, usuario_nome, enviado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE status = VALUES(status), sku = VALUES(sku), produto = VALUES(produto),
           unidades = VALUES(unidades),
           saldo_anterior = VALUES(saldo_anterior), entrada = VALUES(entrada), id_lancamento = VALUES(id_lancamento),
           deposito = VALUES(deposito), mensagem = VALUES(mensagem), usuario_id = VALUES(usuario_id),
           usuario_nome = VALUES(usuario_nome), enviado_em = VALUES(enviado_em)`,
        [
          envio.registro_id,
          envio.status,
          envio.sku,
          envio.produto?.slice(0, 255) ?? null,
          envio.unidades,
          envio.saldo_anterior,
          envio.entrada,
          envio.id_lancamento,
          envio.deposito?.slice(0, 120) ?? null,
          envio.mensagem?.slice(0, 500) ?? null,
          usuarioId,
          envio.usuario_nome,
        ],
      );
    },

    async excluidas() {
      if (!pool) return new Set(excluidasMemoria);
      const rows = await query(`SELECT registro_id FROM contagem_estoque_excluidas`);
      return new Set(rows.map((r) => String(r.registro_id)));
    },

    async excluir(registroId, usuario) {
      if (!pool) {
        excluidasMemoria.add(registroId);
        return;
      }
      await query(
        `INSERT IGNORE INTO contagem_estoque_excluidas (registro_id, usuario_id, usuario_nome, excluida_em)
         VALUES (?, ?, ?, UTC_TIMESTAMP())`,
        [registroId, usuario?.id ?? null, usuario?.nome ?? null],
      );
    },

    async informar(registroId, sku, usuario) {
      const item: SkuManual = {
        registro_id: registroId,
        sku,
        usuario_nome: usuario?.nome ?? null,
        informado_em: new Date().toISOString(),
      };
      if (!pool) {
        memoria.set(registroId, item);
        return item;
      }
      await query(
        `INSERT INTO contagem_estoque_sku_manual (registro_id, sku, usuario_id, usuario_nome, informado_em)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE sku = VALUES(sku), usuario_id = VALUES(usuario_id),
           usuario_nome = VALUES(usuario_nome), informado_em = VALUES(informado_em)`,
        [registroId, sku, usuario?.id ?? null, item.usuario_nome],
      );
      return item;
    },
  };
}
