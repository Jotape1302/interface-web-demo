"""
Limite de uso em memória (AUT-06): requisições por minuto e etiquetas (cópias) por minuto, por
cliente. Protege a impressora e o rolo de etiquetas de um script em loop ou de uma chave vazada:
cada requisição continua aceitando de 1 a 1000 cópias (regra da Produção), mas o total por minuto
tem teto.

Cliente = IP de origem. Pelo Cloudflare Tunnel toda conexão chega do próprio PC (cloudflared em
localhost); aí vale o IP real do header `CF-Connecting-IP`, que só é aceito quando a conexão vem
do loopback (de fora, pela rede local, o header poderia ser forjado).
"""
import threading
import time
from collections import deque
from typing import Deque, Dict, Optional, Tuple

from fastapi import HTTPException, Request

from app.config import settings

JANELA_SEGUNDOS = 60.0
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


class LimiteExcedido(HTTPException):
    def __init__(self, mensagem: str, espera: int) -> None:
        super().__init__(status_code=429, detail=mensagem, headers={"Retry-After": str(max(1, espera))})


class LimitadorJanela:
    """Janela deslizante de 60 s por cliente: (instante, peso) de cada uso aceito."""

    def __init__(self) -> None:
        self._usos: Dict[Tuple[str, str], Deque[Tuple[float, int]]] = {}
        self._lock = threading.Lock()

    def consumir(self, cliente: str, tipo: str, peso: int, teto: int, agora: Optional[float] = None) -> Optional[int]:
        """Registra o uso se couber no teto; senão devolve quantos segundos esperar (nada é registrado)."""
        if teto <= 0:
            return None
        agora = time.monotonic() if agora is None else agora
        with self._lock:
            fila = self._usos.setdefault((cliente, tipo), deque())
            while fila and agora - fila[0][0] >= JANELA_SEGUNDOS:
                fila.popleft()
            usado = sum(p for _, p in fila)
            if usado + peso > teto:
                espera = int(JANELA_SEGUNDOS - (agora - fila[0][0])) + 1 if fila else int(JANELA_SEGUNDOS)
                return espera
            fila.append((agora, peso))
            if len(self._usos) > 10000:  # muitos IPs diferentes: descarta janelas vazias
                for chave in [k for k, f in self._usos.items() if not f]:
                    del self._usos[chave]
            return None

    def limpar(self) -> None:
        with self._lock:
            self._usos.clear()


limitador = LimitadorJanela()


def cliente_da_requisicao(request: Request) -> str:
    origem = request.client.host if request.client else "desconhecido"
    if origem in _LOOPBACK:
        real = (request.headers.get("cf-connecting-ip") or "").strip()
        if real:
            return real[:64]
    return origem


def limitar_requisicoes(request: Request) -> None:
    """Dependência das rotas de etiqueta: teto de requisições por minuto por cliente."""
    espera = limitador.consumir(cliente_da_requisicao(request), "req", 1, settings.LIMITE_REQUISICOES_MINUTO)
    if espera is not None:
        raise LimiteExcedido(
            f"Muitas requisições: o limite é {settings.LIMITE_REQUISICOES_MINUTO} por minuto. Tente em {espera}s.", espera
        )


def limitar_copias(request: Request, copias: int) -> None:
    """Teto de etiquetas impressas por minuto por cliente (cada pedido segue podendo ter até 1000)."""
    teto = settings.LIMITE_COPIAS_MINUTO
    espera = limitador.consumir(cliente_da_requisicao(request), "copias", copias, teto)
    if espera is not None:
        raise LimiteExcedido(
            f"Limite de {teto} etiquetas por minuto atingido (pedido de {copias}). Tente em {espera}s.", espera
        )
