"""
Extração de itens/produtos de uma NF-e para a tela de revisão e categorização.

Três fontes possíveis, em ordem de confiabilidade:
1. XML completo (modelo 55, distribuído pela SEFAZ/NuvemFiscal/PlugNotas): itens
   estruturados de verdade, extraídos de <det>/<prod> por `extract_items_from_xml`.
2. Texto OCR/pdftotext do próprio arquivo (comum em NFC-e modelo 65, cujo XML a
   SEFAZ Nacional não distribui — só o cupom impresso/escaneado existe): tentativa
   best-effort via `extract_items_from_ocr_text`, com heurística de linha.
3. Fallback de item único: quando nenhuma das anteriores produz itens confiáveis,
   um único item sintético representa o valor total da nota — garante que toda
   nota sempre tenha ao menos uma linha para o usuário categorizar na revisão.
"""
import logging
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import List, Optional

import defusedxml.ElementTree as ET
from xml.etree.ElementTree import Element

logger = logging.getLogger(__name__)


@dataclass
class NFeItem:
    item_id: str
    descricao: str
    valor_total: Decimal
    codigo: Optional[str] = None
    ncm: Optional[str] = None
    quantidade: Decimal = Decimal("1")
    valor_unitario: Optional[Decimal] = None


def _parse_decimal(text: Optional[str]) -> Optional[Decimal]:
    if not text:
        return None
    try:
        return Decimal(text.strip())
    except InvalidOperation:
        return None


def extract_items_from_xml(xml_content: str) -> List[NFeItem]:
    """Extrai itens estruturados de <det>/<prod> de um XML de NF-e (layout SEFAZ v4.00)."""
    try:
        root = ET.fromstring(xml_content)
    except Exception as e:
        logger.warning(f"Falha ao interpretar XML para extração de itens: {e}")
        return []

    def find_first(element: Element, tag_name: str) -> Optional[Element]:
        for el in element.iter():
            if el.tag.split("}")[-1] == tag_name:
                return el
        return None

    det_elements = [el for el in root.iter() if el.tag.split("}")[-1] == "det"]
    itens: List[NFeItem] = []

    for idx, det in enumerate(det_elements, start=1):
        prod_el = find_first(det, "prod")
        if prod_el is None:
            continue

        c_prod_el = find_first(prod_el, "cProd")
        x_prod_el = find_first(prod_el, "xProd")
        ncm_el = find_first(prod_el, "NCM")
        q_com_el = find_first(prod_el, "qCom")
        v_un_com_el = find_first(prod_el, "vUnCom")
        v_prod_el = find_first(prod_el, "vProd")

        descricao = (x_prod_el.text.strip() if x_prod_el is not None and x_prod_el.text else f"Item {idx}")
        valor_total = _parse_decimal(v_prod_el.text if v_prod_el is not None else None) or Decimal("0.00")
        quantidade = _parse_decimal(q_com_el.text if q_com_el is not None else None) or Decimal("1")
        valor_unitario = _parse_decimal(v_un_com_el.text if v_un_com_el is not None else None)

        itens.append(NFeItem(
            item_id=str(idx),
            descricao=descricao,
            valor_total=valor_total,
            codigo=(c_prod_el.text.strip() if c_prod_el is not None and c_prod_el.text else None),
            ncm=(ncm_el.text.strip() if ncm_el is not None and ncm_el.text else None),
            quantidade=quantidade,
            valor_unitario=valor_unitario,
        ))

    return itens


# Heurísticas de linha de cupom/DANFE — formatos de impressão variam muito por
# rede/PDV, então tentamos dois layouts comuns nessa ordem (o primeiro que bater
# vence). Best-effort: validado pela conferência de soma em `extract_items_from_ocr_text`.
_UNIT_TOKEN = r"UN|UND|UNID|CX|KG|LT|LATA|PC|PCT|PCTE"

# Layout 1 (o mais comum em cupom de PDV): "<código> <descrição> <qtd> <UN> <vl.unit> <vl.total>"
# ex.: "7891143001206 Polenghi Sandw 144g 1 Un 18,90 18,90"
# A descrição não-gulosa consome o mínimo possível, então itens cuja própria
# descrição contém a palavra da unidade (ex. "Alcatra Kg") continuam corretos:
# o regex expande a descrição até encontrar qtd+UN+valores logo em seguida.
_ITEM_LINE_RE_CODED = re.compile(
    rf"^\s*\d{{6,14}}\s+"
    rf"(?P<desc>.+?)\s+"
    rf"(?P<qtd>\d{{1,4}}(?:[.,]\d{{1,3}})?)\s+"
    rf"(?:{_UNIT_TOKEN})\s+"
    rf"(?P<vunit>\d{{1,4}}[.,]\d{{2}})\s+"
    rf"(?P<vtotal>\d{{1,6}}[.,]\d{{2}})\s*$",
    re.IGNORECASE,
)

# Layout 2 (fallback, sem código no início): "<descrição> [UN] <qtd> <vl.unit> <vl.total>"
_ITEM_LINE_RE_PLAIN = re.compile(
    r"(?P<desc>[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s\.\-/%]{3,60}?)\s+"
    rf"(?:(?:{_UNIT_TOKEN})\s*)?"
    r"(?P<qtd>\d{1,4}(?:[.,]\d{1,3})?)\s*(?:x|X)?\s*"
    r"R?\$?\s*(?P<vunit>\d{1,4}[.,]\d{2})\s+"
    r"R?\$?\s*(?P<vtotal>\d{1,6}[.,]\d{2})\b",
    re.IGNORECASE,
)

_IGNORE_LINE_TERMS = (
    "danfe", "nfc-e", "chave de acesso", "consulta via", "protocolo",
    "cnpj", "cpf", "total", "desconto", "troco", "forma de pagamento",
    "valor pago", "tributos", "qr code",
)


# Consulta pública da NFC-e na SEFAZ-SP (impressa em PDF): cada item vem quebrado em linhas —
#   CORDA 10,00MM - METRO (DIVEOS) (Código: 01950 )
#   Qtde.:3
#   UN: UN
#   Vl. Unit.: 2
_ITEM_NFCE_SP_RE = re.compile(
    r"^[ \t]*(?P<desc>\S[^\n]*?)[ \t]*\(C[óo]digo:[ \t]*(?P<codigo>[^)\n]*?)[ \t]*\)[ \t]*\n"
    r"\s*Qtde\.?:[ \t]*(?P<qtd>[\d.,]+)[ \t]*\n"
    r"\s*UN:[^\n]*\n"
    r"\s*Vl\.?[ \t]*Unit\.?:[ \t]*(?P<vunit>[\d.,]+)",
    re.IGNORECASE | re.MULTILINE,
)


def _decimal_br(texto: str) -> Decimal:
    """'1.234,56' -> 1234.56; '0,350' -> 0.350; '2' -> 2."""
    t = texto.strip()
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    return Decimal(t)


def extract_items_nfce_sp(raw_text: str) -> List[NFeItem]:
    """Itens do layout da consulta NFC-e da SEFAZ-SP; total do item = quantidade × unitário."""
    itens: List[NFeItem] = []
    for m in _ITEM_NFCE_SP_RE.finditer(raw_text or ""):
        try:
            qtd = _decimal_br(m.group("qtd"))
            v_unit = _decimal_br(m.group("vunit"))
        except InvalidOperation:
            continue
        descricao = re.sub(r"\s+", " ", m.group("desc")).strip()
        if len(descricao) < 3:
            continue
        itens.append(NFeItem(
            item_id=str(len(itens) + 1),
            descricao=descricao,
            codigo=m.group("codigo").strip() or None,
            valor_total=(qtd * v_unit).quantize(Decimal("0.01")),
            quantidade=qtd,
            valor_unitario=v_unit,
        ))
    return itens


def _soma_confere(itens: List[NFeItem], valor_total_nota: Decimal, tolerancia: Decimal) -> bool:
    if not valor_total_nota or valor_total_nota <= 0:
        return True
    soma = sum((i.valor_total for i in itens), Decimal("0.00"))
    return abs(soma - valor_total_nota) / valor_total_nota <= tolerancia


def extract_items_from_ocr_text(raw_text: str, valor_total_nota: Decimal) -> List[NFeItem]:
    """
    Tenta extrair linhas de item do texto bruto (OCR/pdftotext) de um cupom/DANFE.
    Best-effort: OCR de foto/scan é inerentemente ruidoso (ângulo, borrão, dígito
    trocado), então a extração parcial (nem toda linha reconhecida) é aceita — só
    descarta tudo se a soma dos itens reconhecidos divergir MUITO do valor total
    da nota (indicando que a heurística capturou lixo, não itens de verdade).
    """
    if not raw_text:
        return []

    # Layout estruturado da consulta SEFAZ-SP: texto digital (pdftotext), então a soma tem de
    # fechar com o total da nota (1%, arredondamento) — senão cai na heurística de linha.
    itens_sp = extract_items_nfce_sp(raw_text)
    if itens_sp and _soma_confere(itens_sp, valor_total_nota, Decimal("0.01")):
        return itens_sp

    itens: List[NFeItem] = []
    for line in raw_text.splitlines():
        line_clean = line.strip()
        if not line_clean or len(line_clean) < 8:
            continue
        if any(term in line_clean.lower() for term in _IGNORE_LINE_TERMS):
            continue

        match = _ITEM_LINE_RE_CODED.search(line_clean) or _ITEM_LINE_RE_PLAIN.search(line_clean)
        if not match:
            continue

        try:
            qtd = Decimal(match.group("qtd").replace(",", "."))
            v_unit = Decimal(match.group("vunit").replace(".", "").replace(",", "."))
            v_total = Decimal(match.group("vtotal").replace(".", "").replace(",", "."))
        except InvalidOperation:
            continue

        descricao = re.sub(r"\s+", " ", match.group("desc")).strip()
        if len(descricao) < 3:
            continue

        itens.append(NFeItem(
            item_id=str(len(itens) + 1),
            descricao=descricao,
            valor_total=v_total,
            quantidade=qtd,
            valor_unitario=v_unit,
        ))

    if not itens:
        return []

    soma = sum((i.valor_total for i in itens), Decimal("0.00"))
    if valor_total_nota and valor_total_nota > 0:
        divergencia = abs(soma - valor_total_nota) / valor_total_nota
        if divergencia > Decimal("0.30"):
            logger.info(
                f"Itens extraídos via OCR descartados: soma R$ {soma} diverge "
                f"{divergencia:.1%} do total da nota R$ {valor_total_nota}."
            )
            return []

    return itens


def build_fallback_single_item(numero_nota: str, emitente_nome: str, valor_total: Decimal) -> List[NFeItem]:
    """Item sintético único usado quando não há itens estruturados nem OCR confiável."""
    return [NFeItem(
        item_id="1",
        descricao=f"NF-e {numero_nota} - {emitente_nome}".strip(" -"),
        valor_total=valor_total,
        quantidade=Decimal("1"),
        valor_unitario=valor_total,
    )]


def resolve_itens(
    itens_xml: List[NFeItem],
    raw_ocr_text: Optional[str],
    numero_nota: str,
    emitente_nome: str,
    valor_total: Decimal,
) -> List[NFeItem]:
    """Resolve a lista final de itens para revisão, na ordem de confiabilidade documentada no módulo."""
    if itens_xml:
        return itens_xml

    if raw_ocr_text:
        ocr_itens = extract_items_from_ocr_text(raw_ocr_text, valor_total)
        if ocr_itens:
            return ocr_itens

    return build_fallback_single_item(numero_nota, emitente_nome, valor_total)
