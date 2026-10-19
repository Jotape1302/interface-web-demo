"""
Bot do Telegram (long polling): recebe a foto da prateleira, chama o detector e
devolve a contagem com a imagem anotada. Toda a visão computacional fica em
app/detector.py — aqui só há Telegram, arquivos temporários e log.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

from app.codigo import ler_codigos
from app.config import BotSettings, DetectorSettings
from app.detector import NOME_COR, UNIDADES_POR_COR, detect_in_image, load_image
from app.registro import RegistroContagens

logger = logging.getLogger("contagem_estoque.bot")

MSG_START = (
    "Olá! 👋\n\n"
    "Envie uma foto da prateleira do estoque, com o código de barras da prateleira visível, "
    "e escreva o SKU do produto na legenda da foto.\n\n"
    "Vou contar os prendedores e enviar a contagem para o painel, onde ela é conferida.\n"
    "🟢 Prendedor verde = fardo de 5 unidades\n"
    "🩷 Prendedor rosa choque = fardo de 10 unidades\n"
    "Use uma cor só por prateleira.\n"
    "Dica: envie a foto como arquivo (📎 → Arquivo) para manter a qualidade."
)
MSG_ANALYZING = "🔍 Analisando a imagem..."
MSG_NOT_FOUND = (
    "⚠️ Nenhum prendedor verde ou rosa choque foi identificado.\n\n"
    "Tente tirar outra foto verificando:\n"
    "• iluminação;\n"
    "• distância;\n"
    "• foco;\n"
    "• visibilidade dos marcadores."
)
MSG_ERROR = "❌ Não foi possível processar esta imagem.\n\nTente enviar novamente."


MSG_SEM_CODIGO = (
    "⚠️ Não encontrei o código de barras da prateleira na foto e a legenda não tem o SKU.\n"
    "A contagem foi enviada ao painel SEM SKU: informe o SKU e confira a quantidade na tela "
    "Contagem de Estoque (ou envie de novo com o SKU na legenda da foto)."
)
# Desde 2026-10-13 a conferência (confirmar/corrigir) é só no painel; o bot não pergunta nada.
MSG_ENVIADO_PAINEL = (
    "📤 Contagem enviada ao painel. A conferência (confirmar ou corrigir a quantidade) é feita "
    "na tela Contagem de Estoque."
)
MSG_CORRIGIR = "✏️ Digite a quantidade correta de pacotes (só o número):"


def msg_varios_codigos(codigos: list[str]) -> str:
    return (
        f"⚠️ Encontrei {len(codigos)} códigos na foto ({', '.join(codigos)}): esta contagem NÃO foi registrada.\n"
        "Enquadre uma prateleira só, ou escreva na legenda o SKU certo, e envie de novo."
    )


def msg_divergente(codigo: str, sku: str) -> str:
    return (
        f"⚠️ O código de barras da foto ({codigo}) é diferente do SKU da legenda ({sku}): "
        "esta contagem NÃO foi registrada.\nConfira o produto e envie de novo."
    )


ORIGEM_AMBOS = "codigo_e_legenda"
ORIGEM_CODIGO = "codigo_de_barras"
ORIGEM_LEGENDA = "legenda"
# Nem código de barras nem SKU na legenda: a contagem fica registrada e o SKU é informado pelo painel.
ORIGEM_SEM_PRODUTO = "sem_produto"


def normalizar_sku(texto: str | None) -> str:
    """SKU digitado na legenda: primeira linha, sem espaços nas pontas e em maiúsculas."""
    linha = (texto or "").strip().splitlines()[0] if (texto or "").strip() else ""
    return linha.strip().upper()[:60]


def resolver_produto(codigos: list[str], legenda: str | None) -> tuple[str | None, str | None, str | None]:
    """
    Identifica o produto pelo código de barras lido e/ou pelo SKU da legenda.
    Devolve (sku, origem, problema): `problema` (mensagem ao operador) impede o registro.
    """
    sku = normalizar_sku(legenda)
    lidos = [c.strip().upper() for c in codigos]
    if sku:
        if not lidos:
            return sku, ORIGEM_LEGENDA, None
        if sku in lidos:
            return sku, ORIGEM_AMBOS, None
        if len(lidos) == 1:
            return None, None, msg_divergente(codigos[0], sku)
        return None, None, msg_varios_codigos(codigos)
    if len(lidos) == 1:
        return lidos[0], ORIGEM_CODIGO, None
    if not lidos:
        return None, None, MSG_SEM_CODIGO
    return None, None, msg_varios_codigos(codigos)


def legenda(
    count: int, codigo: str | None, alertas: tuple[str, ...] | list[str], confirmar: bool = False, cor: str | None = None
) -> str:
    linhas = [f"📦 Pacotes encontrados: {count}"]
    if cor in UNIDADES_POR_COR:
        por_fardo = UNIDADES_POR_COR[cor]
        icone = "🩷" if cor == "rosa" else "🟢"
        linhas.append(f"{icone} Prendedor {NOME_COR[cor]}: {por_fardo} un. por fardo = {count * por_fardo} un.")
    if codigo:
        linhas.insert(0, f"🏷️ Produto (SKU): {codigo}")
    if alertas:
        linhas.append("")
        linhas.append("🟡 Confira na imagem (círculos amarelos):")
        linhas += [f"• {a}" for a in alertas]
    if confirmar:
        linhas.append("")
        linhas.append("A quantidade está certa?")
    return "\n".join(linhas)


def teclado_confirmacao(registro_id: str, count: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(f"✅ Confirmar {count}", callback_data=f"ok:{registro_id}"),
        InlineKeyboardButton("✏️ Corrigir", callback_data=f"fix:{registro_id}"),
    ]])


class StockCounterBot:
    def __init__(self, bot_settings: BotSettings, detector_settings: DetectorSettings) -> None:
        self.settings = bot_settings
        self.detector_settings = detector_settings
        self.registro = RegistroContagens(bot_settings.registro_dir, bot_settings.REGISTRO_RETENCAO_DIAS)
        try:
            self.registro.numerar_existentes()
        except Exception:
            logger.exception("falha ao numerar as contagens antigas (o envio ao Tiny delas fica bloqueado)")

    def autorizado(self, update: Update) -> bool:
        """
        Só responde a quem está em TELEGRAM_ALLOWED_USERS ou TELEGRAM_ALLOWED_CHATS. Com as duas
        listas vazias, responde a todos (o aviso sai no startup, em build_application).
        """
        users, chats = self.settings.allowed_users, self.settings.allowed_chats
        if not users and not chats:
            return True
        user_id = update.effective_user.id if update.effective_user else None
        chat_id = update.effective_chat.id if update.effective_chat else None
        if user_id in users or chat_id in chats:
            return True
        logger.warning("mensagem ignorada: fora da lista permitida telegram_user_id=%s telegram_chat_id=%s", user_id, chat_id)
        return False

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.autorizado(update):
            return
        await update.effective_message.reply_text(MSG_START)

    async def handle_image(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.autorizado(update):
            return  # nem baixa a foto: quem não está na lista não gasta CPU nem disco
        message = update.effective_message
        # Identificador único por foto: fotos simultâneas nunca compartilham arquivo.
        image_id = uuid.uuid4().hex
        user = update.effective_user
        user_id = user.id if user else None
        chat_id = update.effective_chat.id if update.effective_chat else None
        received_path = self.settings.received_dir / f"{image_id}{_suffix_for(message)}"
        annotated_path: Path | None = None
        started = time.perf_counter()

        origem = message.photo[-1] if message.photo else message.document
        tamanho = getattr(origem, "file_size", None) or 0
        if tamanho > self.settings.MAX_ARQUIVO_MB * 1024 * 1024:
            await message.reply_text(
                f"⚠️ Arquivo grande demais ({tamanho / 1024 / 1024:.0f} MB; máximo {self.settings.MAX_ARQUIVO_MB:.0f} MB)."
            )
            return

        await message.reply_text(MSG_ANALYZING)
        try:
            tg_file = await origem.get_file()
            received_path.parent.mkdir(parents=True, exist_ok=True)
            await tg_file.download_to_drive(received_path)

            # OpenCV é CPU-bound: roda fora do loop para não travar os outros usuários.
            imagem = await asyncio.to_thread(load_image, received_path)
            altura, largura = imagem.shape[:2]
            if largura * altura > self.settings.MAX_MEGAPIXELS * 1_000_000:
                await message.reply_text(f"⚠️ Imagem grande demais ({largura}×{altura}). Envie uma foto comum do celular.")
                return
            if max(largura, altura) < self.settings.MIN_LADO_FOTO:
                await message.reply_text(
                    f"⚠️ Foto pequena demais ({largura}×{altura}): os prendedores ficam miúdos e a contagem erra.\n"
                    "Envie a foto como arquivo (📎 → Arquivo) ou com a câmera mais perto."
                )
                return

            result = await asyncio.to_thread(
                detect_in_image, imagem, self.settings.processed_dir, image_id, self.detector_settings
            )
            codigos = await asyncio.to_thread(ler_codigos, imagem)
            annotated_path = result.annotated_image_path
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            logger.info(
                "contagem concluida image_id=%s telegram_user_id=%s telegram_chat_id=%s "
                "quantidade_detectada=%d cor=%s codigos=%s legenda=%r alertas=%d tempo_processamento_ms=%d",
                image_id, user_id, chat_id, result.count, result.cor, codigos, normalizar_sku(message.caption),
                len(result.alertas), elapsed_ms,
            )

            if result.count == 0:
                await message.reply_text(MSG_NOT_FOUND)
                return

            sku, origem, problema = resolver_produto(codigos, message.caption)
            sem_produto = problema == MSG_SEM_CODIGO
            if sem_produto:
                # Registra mesmo sem SKU (decisão de 2026-10-13); o SKU é informado pelo painel.
                origem = ORIGEM_SEM_PRODUTO
            if problema is None or sem_produto:
                sku_digitado = normalizar_sku(message.caption) or None
                codigos_lidos = [c.strip().upper() for c in codigos]
                registro = await asyncio.to_thread(
                    lambda: self.registro.criar(
                        codigo=sku,
                        origem_codigo=origem,
                        quantidade=result.count,
                        alertas=list(result.alertas),
                        imagem_anotada=annotated_path,
                        foto_original=received_path,
                        telegram_user_id=user_id,
                        telegram_user=_nome_usuario(user),
                        telegram_chat_id=chat_id,
                        sku_legenda=sku_digitado,
                        codigos_barras=codigos_lidos,
                        cor=result.cor,
                        unidades_por_fardo=result.unidades_por_fardo,
                    )
                )
                with annotated_path.open("rb") as photo:
                    await message.reply_photo(photo=photo, caption=legenda(result.count, sku, result.alertas, cor=result.cor))
                await message.reply_text(MSG_SEM_CODIGO if sem_produto else MSG_ENVIADO_PAINEL)
                logger.info("contagem registrada registro_id=%s image_id=%s", registro["id"], image_id)
                return

            # Código × legenda divergentes ou vários códigos: mostra a contagem, não registra (o
            # produto pode estar errado; sem produto nenhum, a contagem é registrada acima).
            with annotated_path.open("rb") as photo:
                await message.reply_photo(photo=photo, caption=legenda(result.count, None, result.alertas, confirmar=False, cor=result.cor))
            await message.reply_text(problema)
        except Exception:
            logger.exception(
                "falha ao processar image_id=%s telegram_user_id=%s telegram_chat_id=%s",
                image_id, user_id, chat_id,
            )
            await message.reply_text(MSG_ERROR)
        finally:
            if not self.settings.STOCK_COUNTER_DEBUG:
                _remove_quietly(received_path, annotated_path)

    async def handle_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Botões "Confirmar N" / "Corrigir" da contagem registrada."""
        query = update.callback_query
        if not self.autorizado(update):
            await query.answer()
            return
        acao, _, registro_id = (query.data or "").partition(":")
        user_id = update.effective_user.id if update.effective_user else None
        registro = await asyncio.to_thread(self.registro.obter, registro_id)
        if registro is None:
            await query.answer("Contagem não encontrada (expirada?).", show_alert=True)
            return
        if registro["telegram_user_id"] not in (None, user_id):
            await query.answer("Só quem enviou a foto pode confirmar esta contagem.", show_alert=True)
            return
        if acao == "ok":
            try:
                feito = await asyncio.to_thread(self.registro.concluir, registro_id, registro["quantidade_detectada"], user_id)
            except ValueError as e:
                await query.answer(str(e), show_alert=True)
                return
            await query.answer("Contagem confirmada.")
            await query.edit_message_caption(
                caption=legenda(feito["quantidade_detectada"], feito["codigo"], feito["alertas"], confirmar=True).replace(
                    "A quantidade está certa?", f"✅ Confirmada: {feito['quantidade_final']}"
                ),
                reply_markup=None,
            )
            logger.info("contagem confirmada registro=%s codigo=%s quantidade=%s", registro_id, feito["codigo"], feito["quantidade_final"])
        elif acao == "fix":
            if registro["status"] != "aguardando_confirmacao":
                await query.answer(f"Contagem já {registro['status']}.", show_alert=True)
                return
            context.user_data["corrigindo"] = registro_id
            await query.answer()
            await query.message.reply_text(MSG_CORRIGIR)
        else:
            await query.answer()

    async def handle_other(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.autorizado(update):
            return
        message = update.effective_message
        registro_id = context.user_data.get("corrigindo") if context and context.user_data is not None else None
        if registro_id:
            texto = (message.text or "").strip()
            if not texto.isdigit():
                await message.reply_text(MSG_CORRIGIR)
                return
            user_id = update.effective_user.id if update.effective_user else None
            try:
                feito = await asyncio.to_thread(self.registro.concluir, registro_id, int(texto), user_id)
            except (KeyError, ValueError, PermissionError) as e:
                context.user_data.pop("corrigindo", None)
                await message.reply_text(f"⚠️ Não foi possível corrigir: {e}")
                return
            context.user_data.pop("corrigindo", None)
            await message.reply_text(
                f"✏️ Corrigido: {feito['quantidade_final']} pacote(s) do SKU {feito['codigo']} "
                f"(o bot tinha contado {feito['quantidade_detectada']})."
            )
            logger.info(
                "contagem corrigida registro=%s codigo=%s detectada=%s final=%s",
                registro_id, feito["codigo"], feito["quantidade_detectada"], feito["quantidade_final"],
            )
            return
        await message.reply_text(MSG_START)


def _nome_usuario(user) -> str:
    if user is None:
        return ""
    return (getattr(user, "full_name", None) or getattr(user, "username", None) or str(getattr(user, "id", "")))[:80]


def _suffix_for(message) -> str:
    if message.document and message.document.file_name:
        suffix = Path(message.document.file_name).suffix.lower()
        if suffix:
            return suffix
    return ".jpg"


def _remove_quietly(*paths: Path | None) -> None:
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("não foi possível remover o temporário %s", path)


async def _log_unhandled(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("erro não tratado no bot", exc_info=context.error)


def build_application(bot_settings: BotSettings, detector_settings: DetectorSettings) -> Application:
    if bot_settings.TELEGRAM_STOCK_BOT_TOKEN is None or not bot_settings.TELEGRAM_STOCK_BOT_TOKEN.get_secret_value():
        raise RuntimeError("TELEGRAM_STOCK_BOT_TOKEN não configurado (defina no ambiente ou no .env).")

    if not bot_settings.allowed_users and not bot_settings.allowed_chats:
        logger.warning(
            "TELEGRAM_ALLOWED_USERS e TELEGRAM_ALLOWED_CHATS vazios: o bot responde a QUALQUER usuário do Telegram. "
            "Preencha com os IDs da equipe para restringir."
        )
    else:
        logger.info(
            "bot restrito a %d usuário(s) e %d chat(s) permitidos",
            len(bot_settings.allowed_users), len(bot_settings.allowed_chats),
        )
    handlers = StockCounterBot(bot_settings, detector_settings)
    application = (
        Application.builder()
        .token(bot_settings.TELEGRAM_STOCK_BOT_TOKEN.get_secret_value())
        # Atende vários operadores ao mesmo tempo, em vez de uma foto por vez.
        .concurrent_updates(True)
        .build()
    )
    application.add_handler(CommandHandler("start", handlers.start))
    application.add_handler(CallbackQueryHandler(handlers.handle_callback, pattern=r"^(ok|fix):[0-9a-f]{12}$"))
    # Foto comum (comprimida pelo Telegram) ou imagem enviada como arquivo (qualidade original).
    application.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, handlers.handle_image))
    application.add_handler(MessageHandler(~filters.COMMAND, handlers.handle_other))
    application.add_error_handler(_log_unhandled)
    return application
