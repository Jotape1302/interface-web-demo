import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditService } from "../audit.js";
import { parseJsonBody, sendError, type RequestContext } from "../http.js";
import { PublicError } from "../errors.js";
import {
  createStockSkuService,
  normalizarSku,
  UNIDADES_POR_FARDO_PADRAO,
  type Conferencia,
  type EnvioTiny,
  type SkuManual,
  type StockSkuService,
} from "../stock-sku.js";
import { createStockTinyClient, type StockTinyClient, type TinyConsulta } from "../stock-tiny.js";

/** Consulta ao Tiny guardada por SKU: a tela abre vários cartões e o Tiny limita as chamadas. */
const CONSULTA_CACHE_MS = 60_000;

export interface StockCountItem {
  id: string;
  /** Número sequencial da contagem (dado pelo bot; 000001 no painel e na observação do Tiny). */
  numero?: number;
  criado_em: string;
  codigo: string | null;
  origem_codigo: string | null;
  sku_legenda?: string | null;
  codigos_barras?: string[];
  quantidade_detectada: number;
  /** Cor do prendedor (verde = 5 un., rosa = 10 un.); ausente nas contagens antigas. */
  cor?: "verde" | "rosa";
  /** Unidades por fardo pela cor do prendedor: a conferência não pede mais esse número. */
  unidades_por_fardo?: number;
  quantidade_final: number | null;
  status: "aguardando_confirmacao" | "confirmada" | "corrigida";
  alertas: string[];
  telegram_user_id: number | null;
  telegram_user: string;
  telegram_chat_id: number | null;
  foto_sha256?: string;
  imagem: string;
  imagem_original?: string;
  concluido_em: string | null;
  /** SKU informado pelo painel (contagens com origem "sem_produto"). */
  sku_manual?: SkuManual | null;
  /** Conferência feita no painel (status/quantidade_final já refletem ela). */
  conferencia?: Conferencia | null;
  /** Último envio ao estoque do Tiny. */
  tiny?: EnvioTiny | null;
}

export interface StockCountListResponse {
  configurado: boolean;
  itens: StockCountItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Inteiro em [min, max] ou o padrão quando ausente; null quando inválido. */
function inteiroOuPadrao(valor: unknown, padrao: number, min: number, max: number): number | null {
  if (valor === undefined || valor === null || valor === "") return padrao;
  const n = Number(valor);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Unidades por fardo gravadas pelo bot conforme a cor do prendedor; null em contagem antiga. */
export function porFardoDoRegistro(registro: StockCountItem): number | null {
  const n = registro.unidades_por_fardo;
  return registro.cor && Number.isInteger(n) && n! >= 1 && n! <= 1000 ? n! : null;
}

export function createStockCountRoutes(
  deps: { registroDir?: string; skus?: StockSkuService; audit?: AuditService; tiny?: StockTinyClient } = {},
) {
  const getDir = () => (deps.registroDir || process.env.CONTAGEM_REGISTRO_DIR || "").trim();
  const skus = deps.skus ?? createStockSkuService({ timeoutMs: 10000 } as any, undefined);
  const tiny = deps.tiny ?? createStockTinyClient();
  // Um envio por contagem de cada vez (cliques repetidos não viram duas entradas no Tiny).
  const enviando = new Set<string>();
  const consultas = new Map<string, { em: number; dados: TinyConsulta }>();

  async function lerRegistro(registroDir: string, id: string): Promise<StockCountItem | undefined> {
    try {
      return (JSON.parse(await readFile(join(registroDir, "contagens.json"), "utf-8")) as Record<string, StockCountItem>)[id];
    } catch (err) {
      console.error("[stock-count] falha ao ler contagens.json:", err);
      throw new PublicError(500, "Falha ao ler o arquivo de contagens");
    }
  }

  /**
   * Manda a contagem conferida ao estoque do Tiny (a automação lança só a entrada que falta).
   * Sem SKU devolve null: o envio acontece quando o SKU for informado. Falha vira envio "erro"
   * gravado, para a tela mostrar e permitir reenviar.
   */
  async function enviarAoTiny(
    ctx: RequestContext,
    registro: StockCountItem,
    conferencia: Conferencia,
    skuManual?: string | null,
  ): Promise<EnvioTiny | null> {
    const sku = registro.codigo || skuManual || null;
    if (!sku) return null;
    if (!registro.numero) {
      throw new PublicError(409, "Contagem sem número de auditoria: reinicie o bot da contagem para numerá-la.");
    }
    if (enviando.has(registro.id)) throw new PublicError(409, "Esta contagem já está sendo enviada ao Tiny.");
    enviando.add(registro.id);
    const unidades = conferencia.unidades_total;
    let envio: EnvioTiny;
    try {
      const r = await tiny.ajustar(
        { registro_id: registro.id, sku, quantidade: unidades, numero: registro.numero, criado_em: registro.criado_em },
        ctx,
      );
      envio = {
        registro_id: registro.id,
        status: r.status,
        sku,
        produto: r.produto || null,
        unidades,
        saldo_anterior: r.saldo_anterior,
        entrada: r.entrada,
        id_lancamento: r.id_lancamento,
        deposito: r.deposito || null,
        mensagem: null,
        usuario_nome: ctx.session?.user?.nome ?? null,
        enviado_em: new Date().toISOString(),
      };
    } catch (err) {
      const mensagem =
        err instanceof PublicError
          ? err.message
          : err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
            ? "A contagem de estoque não respondeu a tempo: confira o saldo no Tiny antes de reenviar."
            : "Serviço da contagem de estoque indisponível.";
      if (!(err instanceof PublicError)) console.error("[stock-count] falha ao enviar ao Tiny:", err);
      envio = {
        registro_id: registro.id,
        status: "erro",
        sku,
        produto: null,
        unidades,
        saldo_anterior: null,
        entrada: null,
        id_lancamento: null,
        deposito: null,
        mensagem,
        usuario_nome: ctx.session?.user?.nome ?? null,
        enviado_em: new Date().toISOString(),
      };
    } finally {
      enviando.delete(registro.id);
      consultas.delete(sku); // o saldo pode ter mudado
    }
    try {
      await skus.salvarEnvioTiny(envio, ctx.session?.user?.id ?? null);
    } catch (err) {
      console.error("[stock-count] falha ao gravar o envio ao Tiny:", err);
    }
    void deps.audit?.record({
      actor: ctx.session?.user ?? null,
      actorLabel: ctx.session?.user?.nome || "Usuário Logística",
      acao: "contagem_estoque_tiny",
      detalhes: {
        registroId: registro.id,
        numero: registro.numero,
        sku,
        unidades,
        status: envio.status,
        saldoAnterior: envio.saldo_anterior,
        entrada: envio.entrada,
        ...(envio.mensagem ? { erro: envio.mensagem } : {}),
      },
      ip: ctx.ip,
    });
    return envio;
  }

  return async function handleStockCount(ctx: RequestContext): Promise<boolean> {
    const { path, method, send } = ctx;

    // 1. Listagem paginada com filtros
    if (path === "/api/stock-count/contagens" && method === "GET") {
      const registroDir = getDir();
      if (!registroDir) {
        return send(200, {
          configurado: false,
          itens: [],
          total: 0,
          page: 1,
          pageSize: 20,
        } satisfies StockCountListResponse);
      }

      const arquivo = join(registroDir, "contagens.json");
      if (!existsSync(arquivo)) {
        return send(200, {
          configurado: true,
          itens: [],
          total: 0,
          page: 1,
          pageSize: 20,
        } satisfies StockCountListResponse);
      }

      let dados: Record<string, StockCountItem> = {};
      try {
        const conteudo = await readFile(arquivo, "utf-8");
        dados = JSON.parse(conteudo);
      } catch (err) {
        console.error("[stock-count] falha ao ler contagens.json:", err);
        return send(500, { error: "Falha ao ler o arquivo de contagens" });
      }

      let manuais = new Map<string, SkuManual>();
      let excluidas = new Set<string>();
      let conferencias = new Map<string, Conferencia>();
      let envios = new Map<string, EnvioTiny>();
      try {
        [manuais, excluidas, conferencias, envios] = await Promise.all([
          skus.listar(),
          skus.excluidas(),
          skus.conferencias(),
          skus.enviosTiny(),
        ]);
      } catch (err) {
        console.error("[stock-count] falha ao ler SKUs/exclusões do painel:", err);
      }
      let lista = Object.values(dados)
        .filter((item) => !excluidas.has(item.id))
        .map((item) => {
          const conf = conferencias.get(item.id) ?? null;
          return {
            ...item,
            sku_manual: manuais.get(item.id) ?? null,
            conferencia: conf,
            tiny: envios.get(item.id) ?? null,
            // A conferência do painel prevalece sobre a do bot (contagens antigas confirmadas no Telegram).
            ...(conf ? { status: conf.status, quantidade_final: conf.quantidade_final, concluido_em: conf.conferida_em } : {}),
          };
        });
      // Ordenação decrescente por criado_em
      lista.sort((a, b) => (b.criado_em || "").localeCompare(a.criado_em || ""));

      // Filtros
      const params = ctx.url.searchParams;
      const dataInicio = params.get("data_inicio");
      const dataFim = params.get("data_fim");
      const status = params.get("status");
      const sku = params.get("sku")?.trim().toUpperCase();

      if (dataInicio) {
        lista = lista.filter((item) => (item.criado_em || "") >= dataInicio);
      }
      if (dataFim) {
        const dataFimLimite = dataFim.includes("T") ? dataFim : `${dataFim}T23:59:59`;
        lista = lista.filter((item) => (item.criado_em || "") <= dataFimLimite);
      }
      if (status) {
        lista = lista.filter((item) => item.status === status);
      }
      if (sku) {
        lista = lista.filter((item) => {
          const matchCod = (item.codigo || "").toUpperCase().includes(sku);
          const matchLeg = (item.sku_legenda || "").toUpperCase().includes(sku);
          const matchBarras = (item.codigos_barras || []).some((c) => (c || "").toUpperCase().includes(sku));
          const matchManual = (item.sku_manual?.sku || "").includes(sku);
          return matchCod || matchLeg || matchBarras || matchManual;
        });
      }

      const total = lista.length;
      const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") || "20", 10) || 20));
      const offset = (page - 1) * pageSize;
      const itens = lista.slice(offset, offset + pageSize);

      return send(200, {
        configurado: true,
        itens,
        total,
        page,
        pageSize,
      } satisfies StockCountListResponse);
    }

    // 2. SKU informado pelo painel para contagem registrada sem produto
    const skuMatch = path.match(/^\/api\/stock-count\/contagens\/([A-Za-z0-9-]{1,64})\/sku$/);
    if (skuMatch && method === "POST") {
      try {
        const id = skuMatch[1] ?? "";
        if (!/^[a-f0-9]{12}$/.test(id)) return send(400, { error: "ID inválido" });
        const registroDir = getDir();
        if (!registroDir) return send(404, { error: "Diretório de contagens não configurado" });

        const body = await parseJsonBody<{ sku?: unknown }>(ctx.request);
        const sku = normalizarSku(body?.sku);
        if (!sku) {
          return send(400, { error: "SKU inválido: use letras, números, espaço, ponto, hífen ou barra (até 60)." });
        }

        const registro = await lerRegistro(registroDir, id);
        if (!registro) return send(404, { error: "Contagem não encontrada" });
        // Só para contagem sem produto: se o bot identificou o SKU, ele é o que vale.
        if (registro.codigo) {
          return send(409, { error: "Esta contagem já tem SKU identificado pelo bot." });
        }

        const item = await skus.informar(id, sku, ctx.session?.user ?? null);
        void deps.audit?.record({
          actor: ctx.session?.user ?? null,
          actorLabel: ctx.session?.user?.nome || "Usuário Logística",
          acao: "contagem_estoque_sku_informado",
          detalhes: { registroId: id, sku, quantidade: registro.quantidade_final ?? registro.quantidade_detectada },
          ip: ctx.ip,
        });
        // Contagem já conferida que esperava o SKU: vai ao Tiny agora (a não ser que já tenha ido).
        const conferencia = (await skus.conferencias()).get(id);
        const anterior = (await skus.enviosTiny()).get(id);
        const tinyEnvio =
          conferencia && (!anterior || anterior.status === "erro")
            ? await enviarAoTiny(ctx, registro, conferencia, sku)
            : (anterior ?? null);
        return send(200, { ok: true, sku_manual: item, tiny: tinyEnvio });
      } catch (e) {
        return sendError(ctx, e, "Falha ao informar o SKU.");
      }
    }

    // 3. Conferência da quantidade (confirmar ou corrigir) — só no painel
    const conferirMatch = path.match(/^\/api\/stock-count\/contagens\/([A-Za-z0-9-]{1,64})\/conferir$/);
    if (conferirMatch && method === "POST") {
      try {
        const id = conferirMatch[1] ?? "";
        if (!/^[a-f0-9]{12}$/.test(id)) return send(400, { error: "ID inválido" });
        const registroDir = getDir();
        if (!registroDir) return send(404, { error: "Diretório de contagens não configurado" });

        const body = await parseJsonBody<{ quantidade?: unknown; unidades_por_fardo?: unknown; unidades_soltas?: unknown }>(
          ctx.request,
        );
        const quantidade = Number(body?.quantidade);
        if (!Number.isInteger(quantidade) || quantidade < 0 || quantidade > 100000) {
          return send(400, { error: "Quantidade inválida: informe um número inteiro de 0 a 100000." });
        }
        const soltas = inteiroOuPadrao(body?.unidades_soltas, 0, 0, 100000);
        if (soltas === null) return send(400, { error: "Unidades soltas inválidas: informe um número inteiro de 0 a 100000." });

        const registro = await lerRegistro(registroDir, id);
        if (!registro) return send(404, { error: "Contagem não encontrada" });
        // Desde 2026-10-15 o fardo vem da cor do prendedor (verde 5, rosa 10) e o painel não pede
        // mais esse número; só contagens antigas (sem cor no registro) ainda usam o informado.
        const porFardo = porFardoDoRegistro(registro) ?? inteiroOuPadrao(body?.unidades_por_fardo, UNIDADES_POR_FARDO_PADRAO, 1, 1000);
        if (porFardo === null) return send(400, { error: "Unidades por fardo inválidas: informe um número inteiro de 1 a 1000." });
        if ((await skus.excluidas()).has(id)) return send(409, { error: "Esta contagem foi excluída da tela." });
        if (enviando.has(id)) return send(409, { error: "Esta contagem já está sendo enviada ao Tiny." });

        const conferencia = await skus.conferir(id, registro.quantidade_detectada, quantidade, ctx.session?.user ?? null, {
          porFardo,
          soltas,
        });
        void deps.audit?.record({
          actor: ctx.session?.user ?? null,
          actorLabel: ctx.session?.user?.nome || "Usuário Logística",
          acao: "contagem_estoque_conferida",
          detalhes: {
            registroId: id,
            detectada: registro.quantidade_detectada,
            final: quantidade,
            unidadesPorFardo: porFardo,
            unidadesSoltas: soltas,
            unidades: conferencia.unidades_total,
            status: conferencia.status,
          },
          ip: ctx.ip,
        });
        // Conferiu → o Tiny recebe a entrada que falta (sem SKU, espera o SKU ser informado).
        const skuManual = registro.codigo ? null : ((await skus.listar()).get(id)?.sku ?? null);
        const tinyEnvio = await enviarAoTiny(ctx, registro, conferencia, skuManual);
        return send(200, { ok: true, conferencia, tiny: tinyEnvio });
      } catch (e) {
        return sendError(ctx, e, "Falha ao conferir a contagem.");
      }
    }

    // 3a. Produto e saldo atual no Tiny (só leitura), para conferir SKU e comparar com a foto
    const consultaMatch = path.match(/^\/api\/stock-count\/contagens\/([A-Za-z0-9-]{1,64})\/tiny$/);
    if (consultaMatch && method === "GET") {
      try {
        const id = consultaMatch[1] ?? "";
        if (!/^[a-f0-9]{12}$/.test(id)) return send(400, { error: "ID inválido" });
        const registroDir = getDir();
        if (!registroDir) return send(404, { error: "Diretório de contagens não configurado" });
        const registro = await lerRegistro(registroDir, id);
        if (!registro) return send(404, { error: "Contagem não encontrada" });
        const sku = registro.codigo || (await skus.listar()).get(id)?.sku || null;
        if (!sku) return send(409, { error: "Contagem sem SKU." });
        const guardada = consultas.get(sku);
        if (guardada && Date.now() - guardada.em < CONSULTA_CACHE_MS && ctx.url.searchParams.get("atualizar") !== "1") {
          return send(200, { ...guardada.dados, consultado_em: new Date(guardada.em).toISOString() });
        }
        const dados = await tiny.consultar(sku, ctx);
        const em = Date.now();
        consultas.set(sku, { em, dados });
        return send(200, { ...dados, consultado_em: new Date(em).toISOString() });
      } catch (e) {
        return sendError(ctx, e, "Falha ao consultar o produto no Tiny.");
      }
    }

    // 3b. Reenviar ao Tiny (falha anterior ou contagem conferida antes da integração)
    const tinyMatch = path.match(/^\/api\/stock-count\/contagens\/([A-Za-z0-9-]{1,64})\/tiny$/);
    if (tinyMatch && method === "POST") {
      try {
        const id = tinyMatch[1] ?? "";
        if (!/^[a-f0-9]{12}$/.test(id)) return send(400, { error: "ID inválido" });
        const registroDir = getDir();
        if (!registroDir) return send(404, { error: "Diretório de contagens não configurado" });
        const registro = await lerRegistro(registroDir, id);
        if (!registro) return send(404, { error: "Contagem não encontrada" });
        if ((await skus.excluidas()).has(id)) return send(409, { error: "Esta contagem foi excluída da tela." });
        const conferencia = (await skus.conferencias()).get(id);
        if (!conferencia) return send(409, { error: "Confira a contagem antes de enviar ao Tiny." });
        const skuManual = registro.codigo ? null : ((await skus.listar()).get(id)?.sku ?? null);
        const tinyEnvio = await enviarAoTiny(ctx, registro, conferencia, skuManual);
        if (!tinyEnvio) return send(409, { error: "Informe o SKU da contagem antes de enviar ao Tiny." });
        return send(200, { ok: true, tiny: tinyEnvio });
      } catch (e) {
        return sendError(ctx, e, "Falha ao enviar a contagem ao Tiny.");
      }
    }

    // 4. Excluir contagem da tela (exclusão lógica: o registro e as fotos do bot ficam até a retenção)
    const excluirMatch = path.match(/^\/api\/stock-count\/contagens\/([A-Za-z0-9-]{1,64})$/);
    if (excluirMatch && method === "DELETE") {
      try {
        const id = excluirMatch[1] ?? "";
        if (!/^[a-f0-9]{12}$/.test(id)) return send(400, { error: "ID inválido" });
        const registroDir = getDir();
        if (!registroDir) return send(404, { error: "Diretório de contagens não configurado" });
        let existe = false;
        try {
          existe = id in (JSON.parse(await readFile(join(registroDir, "contagens.json"), "utf-8")) as Record<string, unknown>);
        } catch (err) {
          console.error("[stock-count] falha ao ler contagens.json:", err);
          return send(500, { error: "Falha ao ler o arquivo de contagens" });
        }
        // Só contagem que existe no registro do bot (antes, qualquer id válido virava linha no banco).
        if (!existe) return send(404, { error: "Contagem não encontrada" });
        await skus.excluir(id, ctx.session?.user ?? null);
        void deps.audit?.record({
          actor: ctx.session?.user ?? null,
          actorLabel: ctx.session?.user?.nome || "Usuário Logística",
          acao: "contagem_estoque_excluida",
          detalhes: { registroId: id },
          ip: ctx.ip,
        });
        return send(200, { ok: true });
      } catch (e) {
        return sendError(ctx, e, "Falha ao excluir a contagem.");
      }
    }

    // 5. Imagens anotada e original
    const imageMatch = path.match(/^\/api\/stock-count\/imagens\/([A-Za-z0-9-]{1,64})\/(anotada|original)$/);
    if (imageMatch && method === "GET") {
      const registroDir = getDir();
      if (!registroDir) {
        return send(404, { error: "Diretório de contagens não configurado" });
      }

      const [, id, tipo] = imageMatch;
      if (!id || !/^[a-f0-9]{12}$/.test(id)) {
        return send(400, { error: "ID inválido" });
      }
      const fileName = tipo === "anotada" ? `${id}.jpg` : `${id}_original.jpg`;
      const baseImagesDir = resolve(join(registroDir, "imagens"));
      const filePath = resolve(join(baseImagesDir, fileName));

      // Barreira anti path-traversal
      if (!filePath.startsWith(baseImagesDir)) {
        return send(400, { error: "Caminho inválido" });
      }

      if (!existsSync(filePath)) {
        return send(404, { error: "Imagem não encontrada" });
      }

      try {
        const buf = await readFile(filePath);
        ctx.response.setHeader("Content-Type", "image/jpeg");
        ctx.response.setHeader("Cache-Control", "private, max-age=86400");
        ctx.response.writeHead(200);
        ctx.response.end(buf);
        return true;
      } catch (err) {
        console.error("[stock-count] falha ao ler imagem:", err);
        return send(500, { error: "Erro ao ler a imagem" });
      }
    }

    return false;
  };
}
