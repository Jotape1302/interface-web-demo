"""
Inicia o bot de contagem de estoque em long polling e, ao lado, a API interna que o gateway
chama ao conferir uma contagem (lançamento no Tiny): `python -m app.main`.
"""
import logging
import sys
import threading
from typing import List

from telegram import Update

from app.bot import build_application
from app.config import BotSettings, DetectorSettings, TinySettings


def setup_logging(settings: BotSettings) -> None:
    handlers: List[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if settings.LOG_TO_FILE:
        try:
            settings.LOG_DIR.mkdir(parents=True, exist_ok=True)
            handlers.append(logging.FileHandler(str(settings.LOG_DIR / "contagem_estoque.log"), encoding="utf-8"))
        except OSError as e:
            print(f"Aviso: não foi possível gravar log em {settings.LOG_DIR}: {e}", file=sys.stderr)

    logging.basicConfig(
        level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
    )
    # O httpx registra cada chamada com a URL completa da API do Telegram, que
    # contém o token do bot. Em WARNING essas linhas não são gravadas.
    logging.getLogger("httpx").setLevel(logging.WARNING)


def iniciar_api(logger: logging.Logger) -> None:
    """API interna numa thread: o bot (run_polling) ocupa a thread principal."""
    import uvicorn

    porta = TinySettings().API_PORT
    servidor = uvicorn.Server(uvicorn.Config("app.api:app", host="0.0.0.0", port=porta, log_level="warning"))
    # O uvicorn só instala tratadores de sinal na thread principal; aqui quem para o processo é o bot.
    servidor.install_signal_handlers = lambda: None  # type: ignore[method-assign]
    threading.Thread(target=servidor.run, name="api-interna", daemon=True).start()
    logger.info("API interna da contagem na porta %d", porta)


def main() -> None:
    bot_settings = BotSettings()
    setup_logging(bot_settings)
    logger = logging.getLogger("contagem_estoque")
    application = build_application(bot_settings, DetectorSettings())
    iniciar_api(logger)
    logger.info("bot de contagem iniciado (long polling, debug=%s)", bot_settings.STOCK_COUNTER_DEBUG)
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
