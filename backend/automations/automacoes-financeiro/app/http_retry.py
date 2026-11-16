"""Política única de retentativa HTTP: backoff exponencial com jitter e respeito ao `Retry-After`.

- 429 (rate limit): repete qualquer método, pois o servidor recusou antes de processar.
- 5xx: repete só leituras (GET/HEAD/OPTIONS). POST/PUT de escrita (ex.: baixa) NÃO repete em 5xx,
  porque a escrita pode ter sido gravada; quem decide é a releitura de conferência do chamador.
"""

from __future__ import annotations

import random
from email.utils import parsedate_to_datetime
from typing import Any, Optional

MAX_TENTATIVAS = 4
TETO_ESPERA_SEGUNDOS = 60.0
BASE_ESPERA_SEGUNDOS = 1.0
METODOS_IDEMPOTENTES = frozenset({"GET", "HEAD", "OPTIONS"})


def retry_after_segundos(resposta: Any) -> Optional[float]:
    """`Retry-After` (segundos ou data HTTP) da resposta; None se ausente ou inválido."""
    try:
        bruto = (resposta.headers or {}).get("Retry-After")
    except Exception:
        return None
    if bruto is None:
        return None
    texto = str(bruto).strip()
    try:
        return max(0.0, float(texto))
    except ValueError:
        pass
    try:
        from datetime import datetime, timezone

        alvo = parsedate_to_datetime(texto)
        if alvo.tzinfo is None:
            alvo = alvo.replace(tzinfo=timezone.utc)
        return max(0.0, (alvo - datetime.now(timezone.utc)).total_seconds())
    except Exception:
        return None


def deve_repetir(metodo: str, status_code: int) -> bool:
    if status_code == 429:
        return True
    return status_code >= 500 and metodo.upper() in METODOS_IDEMPOTENTES


def espera_segundos(tentativa: int, retry_after: Optional[float] = None) -> float:
    """Espera antes da próxima tentativa (`tentativa` = a que acabou de falhar, a partir de 1)."""
    if retry_after is not None:
        return min(TETO_ESPERA_SEGUNDOS, retry_after)
    exponencial = BASE_ESPERA_SEGUNDOS * (2 ** (tentativa - 1))
    return min(TETO_ESPERA_SEGUNDOS, exponencial + random.uniform(0, exponencial / 2))
