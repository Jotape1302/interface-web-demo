"""Regras comuns às duas linguagens de impressora (ZPL e EPL): GTIN, acentos e o que entra na etiqueta."""
import re
import unicodedata
from typing import Any, Dict, Optional

MAX_COPIAS = 1000


def gtin_valido(gtin: Optional[str]) -> bool:
    """GTIN-8/12/13/14 com dígito verificador correto (módulo 10, pesos 3 e 1 da direita)."""
    if not gtin or not re.fullmatch(r"\d{8}|\d{12,14}", gtin):
        return False
    corpo, dv = gtin[:-1], int(gtin[-1])
    soma = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(corpo)))
    return (10 - soma % 10) % 10 == dv


def sem_acentos(texto: str) -> str:
    return unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")


def sku_cabe_no_code128(sku: str) -> bool:
    """Só ASCII imprimível vai no Code 128."""
    return bool(sku) and bool(re.fullmatch(r"[\x20-\x7e]+", sku))


def ean13(produto: Dict[str, Any]) -> Optional[str]:
    """GTIN do produto como EAN-13 (12 dígitos ganham o 0 na frente), ou None se não for um EAN-13 válido."""
    gtin = (produto.get("gtin") or "").strip()
    if len(gtin) == 12:
        gtin = f"0{gtin}"
    return gtin if len(gtin) == 13 and gtin_valido(gtin) else None


def limitar_copias(copias: int) -> int:
    return max(1, min(MAX_COPIAS, int(copias)))


def dots(mm: float, dpmm: float) -> int:
    return int(round(mm * dpmm))


def modulos_code128(texto: str) -> int:
    """Módulos do Code 128 (conjunto B, o caso de um SKU com letras), sem a zona de silêncio."""
    return 11 * (len(texto) + 3) + 2
