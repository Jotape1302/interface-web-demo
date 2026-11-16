"""Chamada ao Ollama local com saída presa a um JSON Schema (campo `format` do /api/chat).

Toda resposta do modelo (válida ou não) vai para quem estiver em `registrando(...)`: é o registro
de treino (tabela chamadas, ver treino.py).

TRAVA_GPU: a RTX 3060 comporta um modelo 14B por vez. Cada chamada ao Ollama a segura, e o
classificador de NF-e a segura durante um lote inteiro no llama-server (llama_server.py), com o
adaptador LoRA: enquanto isso, os agentes de incidentes esperam em vez de disputar a VRAM.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, Iterator, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from . import config

M = TypeVar("M", bound=BaseModel)
TRAVA_GPU = threading.RLock()
_registro: contextvars.ContextVar[Optional[Callable[..., None]]] = contextvars.ContextVar("registro", default=None)


@contextlib.contextmanager
def registrando(funcao: Callable[..., None]) -> Iterator[None]:
    """Enquanto ativo, cada resposta do modelo chama funcao(modelo=, mensagens=, resposta=, valida=, erro=, segundos=)."""
    token = _registro.set(funcao)
    try:
        yield
    finally:
        _registro.reset(token)


class OllamaFora(Exception):
    """Ollama não respondeu (serviço parado, GPU ocupada). O incidente espera e tenta de novo."""


class SaidaInvalida(Exception):
    """O modelo não devolveu o JSON pedido nem depois das novas tentativas."""


def _post(caminho: str, corpo: dict) -> dict:
    req = urllib.request.Request(
        config.OLLAMA_URL + caminho, data=json.dumps(corpo).encode(), method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, OSError, TimeoutError) as erro:
        raise OllamaFora(str(erro)) from erro


def gerar(modelo: str, sistema: str, usuario: str, esquema: Type[M], num_ctx: int = 0) -> M:
    def enviar(mensagens: list[dict], schema: dict) -> str:
        with TRAVA_GPU:
            resp = _post(
                "/api/chat",
                {
                    "model": modelo,
                    "messages": mensagens,
                    "format": schema,
                    "stream": False,
                    "options": {"num_ctx": num_ctx or config.NUM_CTX, "temperature": 0.2},
                    "keep_alive": "30m",
                },
            )
        return resp.get("message", {}).get("content", "")

    return gerar_com(enviar, modelo, sistema, usuario, esquema)


def gerar_com(enviar: Callable[[list, dict], str], modelo: str, sistema: str, usuario: str, esquema: Type[M]) -> M:
    """Laço comum aos motores (Ollama, llama-server): JSON fora do esquema volta ao modelo com o erro."""
    mensagens = [{"role": "system", "content": sistema}, {"role": "user", "content": usuario}]
    ultimo_erro = ""
    for _ in range(config.TENTATIVAS_JSON):
        inicio = time.monotonic()
        texto = enviar(mensagens, esquema.model_json_schema())
        registro = _registro.get()
        try:
            saida = esquema.model_validate_json(texto)
        except ValidationError as erro:
            ultimo_erro = str(erro)[:500]
            if registro:
                registro(modelo=modelo, mensagens=list(mensagens), resposta=texto, valida=False, erro=ultimo_erro, segundos=time.monotonic() - inicio)
            mensagens += [
                {"role": "assistant", "content": texto},
                {"role": "user", "content": f"A resposta não seguiu o esquema JSON: {ultimo_erro}\nResponda de novo só com o JSON válido."},
            ]
            continue
        if registro:
            registro(modelo=modelo, mensagens=list(mensagens), resposta=texto, valida=True, erro="", segundos=time.monotonic() - inicio)
        return saida
    raise SaidaInvalida(ultimo_erro)


def descarregar_ollama() -> list[str]:
    """Tira da VRAM todo modelo que o Ollama tiver carregado (keep_alive 0). Ollama fora: nada a liberar."""
    try:
        req = urllib.request.Request(config.OLLAMA_URL + "/api/ps")
        with urllib.request.urlopen(req, timeout=30) as resp:
            carregados = [m["name"] for m in json.loads(resp.read()).get("models", [])]
    except (urllib.error.URLError, OSError, ValueError):
        return []
    for nome in carregados:
        _post("/api/generate", {"model": nome, "keep_alive": 0})
    return carregados
