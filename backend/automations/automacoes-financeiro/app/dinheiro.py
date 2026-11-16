"""Dinheiro: soma e comparação em Decimal; serialização JSON a 2 casas (number, contrato inalterado)."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any

_CENTAVO = Decimal("0.01")


def para_decimal(valor: Any) -> Decimal:
    if valor is None or valor == "":
        return Decimal("0")
    if isinstance(valor, Decimal):
        return valor
    try:
        return Decimal(str(valor))
    except Exception:
        return Decimal("0")


def dinheiro_json(valor: Any) -> float:
    """Decimal -> número JSON arredondado a 2 casas (ROUND_HALF_UP), sem resíduo de float."""
    return float(para_decimal(valor).quantize(_CENTAVO, rounding=ROUND_HALF_UP))
