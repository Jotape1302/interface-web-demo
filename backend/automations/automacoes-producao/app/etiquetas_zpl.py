"""
Etiqueta de produto em ZPL (linguagem das impressoras Zebra) — o mesmo layout da prévia da
interface (frontend/app/components/etiqueta-produto.tsx), para imprimir direto na impressora de
etiquetas com LINGUAGEM=zpl (Zebra, ou a Elgin em modo PPLZ; de fábrica ela é EPL, ver etiquetas_epl.py):

    ┌──────────────────────────────────────────┐
    │ Nome do produto (até 4 linhas)           │
    │ Localização          ║║║ EAN-13 ║║║      │
    │ SKU                  7 908737 101294     │
    │ ║║║║║║║║║ Code 128 do SKU ║║║║║║║║║║║║║  │
    └──────────────────────────────────────────┘

Os códigos de barras são desenhados pela própria impressora (^BE e ^BC), na resolução dela.
Medidas em mm, convertidas para pontos conforme o dpi da impressora (203 ou 300).
"""

import re
from typing import Any, Dict

from app.etiqueta_comum import dots as _dots
from app.etiqueta_comum import gtin_valido, sem_acentos  # noqa: F401 (reexportados: usados por api/testes)
from app.etiqueta_comum import modulos_code128 as _modulos_code128


def _campo(texto: str) -> str:
    """Texto seguro para ^FD com ^FH_: `_`, `^` e `~` viram hexadecimal (senão viram comando)."""
    return texto.replace("_", "_5F").replace("^", "_5E").replace("~", "_7E")


def gerar_zpl(
    produto: Dict[str, Any],
    copias: int = 1,
    dpi: int = 203,
    largura_mm: float = 60,
    altura_mm: float = 40,
    remover_acentos: bool = False,
) -> str:
    if dpi not in (203, 300):
        raise ValueError("dpi deve ser 203 ou 300.")
    copias = max(1, min(1000, int(copias)))
    dpmm = dpi / 25.4
    W, H = _dots(largura_mm, dpmm), _dots(altura_mm, dpmm)
    k = min(largura_mm / 60, altura_mm / 40)  # layout desenhado para 60 x 40 mm
    mx, my = _dots(2.0 * k, dpmm), _dots(1.6 * k, dpmm)
    util = W - 2 * mx

    descricao = (produto.get("descricao") or "").strip()
    sku = (produto.get("sku") or "").strip()
    localizacao = (produto.get("localizacao") or "").strip() or "-"
    if remover_acentos:
        descricao, localizacao = sem_acentos(descricao), sem_acentos(localizacao)
    gtin = (produto.get("gtin") or "").strip()
    if len(gtin) == 12:
        gtin = f"0{gtin}"
    tem_ean = len(gtin) == 13 and gtin_valido(gtin)
    tem_code128 = bool(sku) and bool(re.fullmatch(r"[\x20-\x7e]+", sku))

    z = ["^XA", "^CI28", f"^PW{W}", f"^LL{H}", "^LH0,0", "^MMT"]

    # Nome: até 4 linhas, quebra automática (^FB), ajustando tamanho para não cortar descrições longas.
    if len(descricao) > 85:
        fonte_nome_w = _dots(2.2 * k, dpmm)
        fonte_nome_h = _dots(2.5 * k, dpmm)
    else:
        fonte_nome_w = _dots(2.6 * k, dpmm)
        fonte_nome_h = _dots(2.8 * k, dpmm)
    z.append(f"^FO{mx},{my}^A0N,{fonte_nome_h},{fonte_nome_w}^FB{util},4,0,L,0^FH_^FD{_campo(descricao)}^FS")

    # Code 128 do SKU na base, largura toda (módulo inteiro em pontos, o maior que couber).
    altura_c128 = _dots(max(4.5, 7 * k), dpmm)
    y_c128 = H - my - altura_c128
    if tem_code128:
        modulos = _modulos_code128(sku) + 20  # + zona de silêncio (10 de cada lado)
        modulo = max(1, min(4, util // modulos))
        x_c128 = mx + max(0, (util - modulos * modulo) // 2) + 10 * modulo
        z.append(f"^BY{modulo},3,{altura_c128}")
        z.append(f"^FO{x_c128},{y_c128}^BCN,{altura_c128},N,N,N,A^FH_^FD{_campo(sku)}^FS")

    # Faixa do meio: EAN-13 à direita (com barras altas de ~10mm e dígitos embaixo) e localização + SKU à esquerda.
    fonte_meio = _dots(2.1 * k, dpmm)
    altura_ean = _dots(10.0 * k, dpmm)
    alt_digitos_ean = _dots(2.8 * k, dpmm)
    respiro_c128 = _dots(1.5 * k, dpmm)
    y_meio = y_c128 - respiro_c128 - altura_ean - alt_digitos_ean
    largura_ean = 0
    if tem_ean:
        modulo_ean = max(1, min(3, _dots(27 * k, dpmm) // 102))
        largura_ean = 102 * modulo_ean  # 95 módulos + o 1º dígito à esquerda
        recuo_seguranca = _dots(1.0 * k, dpmm)  # margem extra à direita para evitar corte mecânico
        x_ean = W - mx - largura_ean + 7 * modulo_ean - recuo_seguranca
        z.append(f"^BY{modulo_ean},3,{altura_ean}")
        z.append(f"^FO{x_ean},{y_meio}^BEN,{altura_ean},Y,N^FD{gtin[:12]}^FS")
    largura_texto = util - (largura_ean + _dots(1.2 * k, dpmm) if tem_ean else 0)
    texto_meio = f"{_campo(localizacao)}\\&{_campo(sku or 'SEM SKU')}"
    z.append(f"^FO{mx},{y_meio}^A0N,{fonte_meio},{fonte_meio}^FB{largura_texto},3,0,L,0^FH_^FD{texto_meio}^FS")

    z.append(f"^PQ{copias},0,1,N")
    z.append("^XZ")
    return "\n".join(z) + "\n"


def avisos_etiqueta(produto: Dict[str, Any]) -> list:
    """Mesmos avisos da prévia: o que sai faltando na etiqueta."""
    out = []
    sku = (produto.get("sku") or "").strip()
    if not sku:
        out.append("Produto sem SKU: a etiqueta sai sem o código de barras do SKU.")
    elif not re.fullmatch(r"[\x20-\x7e]+", sku):
        out.append("SKU com acento ou caractere especial: não cabe no Code 128.")
    gtin = (produto.get("gtin") or "").strip()
    if not gtin:
        out.append("Produto sem GTIN: a etiqueta sai sem o EAN.")
    elif not (gtin_valido(gtin) and len(gtin) in (12, 13)):
        out.append(f"GTIN {gtin} inválido para EAN-13: a etiqueta sai sem o EAN.")
    if not (produto.get("localizacao") or "").strip():
        out.append("Sem localização.")
    return out
