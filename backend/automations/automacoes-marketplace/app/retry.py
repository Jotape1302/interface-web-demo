"""Espera entre tentativas das chamadas HTTP (ML e Tiny): backoff exponencial com jitter."""
import random
import time
from typing import Any, Optional

TENTATIVAS = 4
TETO_ESPERA_S = 60.0
BASE_S = 2.0
METODOS_DE_LEITURA = ("GET", "HEAD")


def deve_repetir(metodo: str, status: Optional[int]) -> bool:
    """429 vale para qualquer método (o pedido não foi processado); 5xx e falha de rede só em leitura."""
    if status == 429:
        return True
    return metodo.upper() in METODOS_DE_LEITURA and (status is None or status >= 500)


def espera(tentativa: int, resp: Any = None) -> float:
    """Segundos até a próxima tentativa: Retry-After (em segundos), senão 2^n com jitter; teto de 60 s."""
    try:
        valor = float((getattr(resp, "headers", None) or {}).get("Retry-After", ""))
        if valor >= 0:
            return min(TETO_ESPERA_S, valor)
    except (TypeError, ValueError):
        pass
    return min(TETO_ESPERA_S, BASE_S * (2 ** (tentativa - 1)) + random.uniform(0, 1))


def dormir(segundos: float) -> None:
    time.sleep(segundos)
