"""Ponto de entrada do servidor de impressão da Produção (python -m app.main)."""
import logging
import sys

import uvicorn

from app.api import app
from app.config import TAMANHO_MINIMO_CHAVE, settings


def conferir_chave_configurada() -> None:
    """Exposto na internet: sem CHAVE_API definida no .env (e forte o bastante), o servidor não sobe."""
    if not settings.CHAVE_API:
        sys.exit("[ERRO] Defina CHAVE_API no arquivo .env antes de iniciar.")
    if len(settings.CHAVE_API) < TAMANHO_MINIMO_CHAVE:
        sys.exit(f"[ERRO] CHAVE_API no .env muito curta: use pelo menos {TAMANHO_MINIMO_CHAVE} caracteres.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    conferir_chave_configurada()
    uvicorn.run(app, host=settings.HOST, port=settings.PORT, log_level="info")
