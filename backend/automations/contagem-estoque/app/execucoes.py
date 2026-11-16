"""Contagem de execuções para o monitor dos agentes Qwen (norvia-ti/agentes-qwen).

Mesmo contrato de backend/gateway/src/execucoes.ts. A cada JANELA_S sai UMA linha no stdout com as
rotas HTTP e as rotinas agendadas que rodaram:
  {"event":"execucoes","janela_s":60,"rotas":{"POST /api/v1/x/:id":{"ok":3,"erro":0},"rotina SEFAZ_SCAN":{"ok":1,"erro":0}},"at":"..."}
ok = terminou sem exceção, sem log ERROR no meio e (HTTP) com status < 500; senão, erro.

Log ERROR emitido durante uma execução ganha " [execucao=<chave>]" no fim da 1ª linha: o coletor
(scripts/coletor-incidentes) usa a chave como rota do incidente e o monitor espera 5 execuções ok dela.

Cópia idêntica em automacoes-marketplace, automacoes-marketing e contagem-estoque (cada serviço é uma imagem própria).
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import re
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Iterator, Optional

JANELA_S = 60
MAX_ROTAS = 500

class _Execucao:
    __slots__ = ("chave", "falhou")

    def __init__(self, chave: str) -> None:
        self.chave, self.falhou = chave, False


# O asyncio.to_thread e o threadpool do FastAPI copiam o contexto: o mesmo objeto chega à thread.
_atual: contextvars.ContextVar[Optional[_Execucao]] = contextvars.ContextVar("execucao", default=None)
_trava = threading.Lock()
_rotas: dict[str, dict[str, int]] = {}
_instalado = False


def normalizar_rota(path: str) -> str:
    """Ids numéricos, UUIDs, hashes e códigos como MLB123 viram :id (mesma regra do gateway)."""
    return "/".join(
        ":id" if re.fullmatch(r"\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,}|[A-Za-z]{2,5}\d{4,}", seg, flags=re.I) else seg
        for seg in path.split("/")
    )


def registrar(chave: str, ok: bool) -> None:
    with _trava:
        item = _rotas.get(chave)
        if item is None:
            if len(_rotas) >= MAX_ROTAS:
                return
            item = _rotas[chave] = {"ok": 0, "erro": 0}
        item["ok" if ok else "erro"] += 1


def fechar(janela_s: int = JANELA_S) -> Optional[str]:
    """Linha da janela atual (ou None sem execuções) e zera os contadores."""
    global _rotas
    with _trava:
        if not _rotas:
            return None
        rotas, _rotas = _rotas, {}
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return json.dumps({"event": "execucoes", "janela_s": janela_s, "rotas": rotas, "at": at}, ensure_ascii=False, separators=(",", ":"))


def _chave(texto: str) -> str:
    # Sem % (a mensagem do log é formatada com %) e sem ] (fecha a marca).
    return re.sub(r"[%\]\r\n]", "", texto)[:200]


@contextlib.contextmanager
def execucao(chave: str) -> Iterator[None]:
    """Conta uma execução de rotina. O log de erro da rotina fica dentro do `with` para levar a marca."""
    atual = _Execucao(_chave(chave))
    token = _atual.set(atual)
    try:
        yield
    except BaseException:
        atual.falhou = True
        raise
    finally:
        _atual.reset(token)
        registrar(atual.chave, not atual.falhou)


def _marcar_erros() -> None:
    fabrica = logging.getLogRecordFactory()

    def criar(*args, **kwargs) -> logging.LogRecord:
        registro = fabrica(*args, **kwargs)
        atual = _atual.get()
        if atual and registro.levelno >= logging.ERROR:
            atual.falhou = True
            registro.msg = f"{registro.msg} [execucao={atual.chave}]"
        return registro

    logging.setLogRecordFactory(criar)


def _emitir() -> None:
    while True:
        time.sleep(JANELA_S)
        linha = fechar()
        if linha:
            sys.stdout.write(linha + "\n")
            sys.stdout.flush()


def instalar(app=None) -> None:
    """Liga a marca nos logs de erro, a linha por minuto e, com `app`, a contagem das rotas HTTP."""
    global _instalado
    if not _instalado:
        _instalado = True
        _marcar_erros()
        threading.Thread(target=_emitir, name="execucoes", daemon=True).start()
    if app is None:
        return

    @app.middleware("http")
    async def _contar(request, call_next):
        if request.method == "OPTIONS" or request.url.path.endswith("/health"):
            return await call_next(request)
        atual = _Execucao(_chave(f"{request.method} {normalizar_rota(request.url.path)}"))
        token = _atual.set(atual)
        status = 500
        try:
            resposta = await call_next(request)
            status = resposta.status_code
            return resposta
        finally:
            _atual.reset(token)
            registrar(atual.chave, status < 500 and not atual.falhou)
