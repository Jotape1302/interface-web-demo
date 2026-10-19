from decimal import Decimal

from app.nfe_items import (
    build_fallback_single_item,
    extract_items_from_ocr_text,
    extract_items_from_xml,
    resolve_itens,
)

SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe>
      <det nItem="1">
        <prod>
          <cProd>001</cProd>
          <xProd>PARAFUSO SEXTAVADO 10MM</xProd>
          <NCM>73181500</NCM>
          <qCom>100.0000</qCom>
          <vUnCom>0.50</vUnCom>
          <vProd>50.00</vProd>
        </prod>
      </det>
      <det nItem="2">
        <prod>
          <cProd>002</cProd>
          <xProd>DETERGENTE NEUTRO 500ML</xProd>
          <NCM>34022000</NCM>
          <qCom>10.0000</qCom>
          <vUnCom>5.00</vUnCom>
          <vProd>50.00</vProd>
        </prod>
      </det>
    </infNFe>
  </NFe>
</nfeProc>"""


def test_extract_items_from_xml():
    itens = extract_items_from_xml(SAMPLE_XML)
    assert len(itens) == 2
    assert itens[0].descricao == "PARAFUSO SEXTAVADO 10MM"
    assert itens[0].ncm == "73181500"
    assert itens[0].valor_total == Decimal("50.00")
    assert itens[1].descricao == "DETERGENTE NEUTRO 500ML"
    assert itens[1].item_id == "2"


def test_extract_items_from_xml_malformed_returns_empty():
    assert extract_items_from_xml("not xml at all") == []


def test_extract_items_from_ocr_text_recognizes_lines_within_tolerance():
    raw = (
        "DANFE NFC-e\n"
        "DETERGENTE NEUTRO 500ML   UN   2   5,00   10,00\n"
        "PAPEL A4 SULFITE          UN   1   15,00   15,00\n"
        "TOTAL R$ 25,00\n"
    )
    itens = extract_items_from_ocr_text(raw, Decimal("25.00"))
    assert len(itens) == 2
    assert itens[0].descricao.startswith("DETERGENTE")
    assert itens[0].valor_total == Decimal("10.00")


def test_extract_items_from_ocr_text_discards_on_large_divergence():
    raw = "ALGUM ITEM QUALQUER   UN   1   5,00   5,00\n"
    # Soma dos itens (5.00) diverge >30% do total real da nota (500.00)
    itens = extract_items_from_ocr_text(raw, Decimal("500.00"))
    assert itens == []


def test_extract_items_from_ocr_text_recognizes_coded_cupom_lines():
    """
    Formato real de cupom de PDV: '<código> <descrição> <qtd> <UN> <vl.unit> <vl.total>'
    (código no início da linha, unidade DEPOIS da quantidade) — layout mais comum
    que o genérico usado em test_extract_items_from_ocr_text_recognizes_lines_within_tolerance.
    """
    raw = (
        "CNPJ:58.203.741/0001-50 Supermercado 88 Ltda\n"
        "Codigo Descricao Qtde UN Vl.Unit Vl.Total\n"
        "0000000003025 Alcatra C maminha Kg 5,384 Kg 49,90 268,66\n"
        "7891143001206 Polenghi Sandw 144g 1 Un 18,90 18,90\n"
        "7891143001206 Polenghi Sandw 144g 1 Un 18,90 18,90\n"
        "0000000002394 Salsinha 1 Un 11,90 11,90\n"
        "SUBTOTAL R$ 318,36\n"
    )
    itens = extract_items_from_ocr_text(raw, Decimal("318.36"))
    assert len(itens) == 4
    assert itens[0].descricao == "Alcatra C maminha Kg"
    assert itens[0].valor_total == Decimal("268.66")
    assert itens[0].quantidade == Decimal("5.384")
    assert itens[1].descricao == "Polenghi Sandw 144g"
    assert itens[3].descricao == "Salsinha"
    assert itens[3].valor_total == Decimal("11.90")


def test_extract_items_from_ocr_text_keeps_partial_matches_within_relaxed_tolerance():
    """OCR de foto é ruidoso: algumas linhas não batem o regex, mas o que bateu
    ainda deve ser aproveitado (não descartar tudo por uma divergência moderada)."""
    raw = (
        "0000000003179 Fraldinha Kg linha ilegível sem valores\n"
        "0000000003025 Alcatra C maminha Kg 5,384 Kg 49,90 268,66\n"
        "7891143001206 Polenghi Sandw 144g 1 Un 18,90 18,90\n"
    )
    # Total real da nota inclui a linha "Fraldinha" que não foi reconhecida —
    # soma reconhecida (287,56) diverge ~20% de 360,00, dentro da tolerância de 30%.
    itens = extract_items_from_ocr_text(raw, Decimal("360.00"))
    assert len(itens) == 2


def test_extract_items_from_ocr_text_empty_input():
    assert extract_items_from_ocr_text("", Decimal("100.00")) == []


def test_build_fallback_single_item():
    itens = build_fallback_single_item("123", "FORNECEDOR X", Decimal("999.90"))
    assert len(itens) == 1
    assert itens[0].valor_total == Decimal("999.90")
    assert "123" in itens[0].descricao
    assert "FORNECEDOR X" in itens[0].descricao


def test_resolve_itens_prefers_xml_then_ocr_then_fallback():
    xml_itens = extract_items_from_xml(SAMPLE_XML)
    assert resolve_itens(xml_itens, None, "1", "X", Decimal("100.00")) == xml_itens

    ocr_text = "DETERGENTE NEUTRO 500ML   UN   2   5,00   10,00\n"
    resolved = resolve_itens([], ocr_text, "1", "X", Decimal("10.00"))
    assert len(resolved) == 1
    assert resolved[0].descricao.startswith("DETERGENTE")

    fallback = resolve_itens([], None, "1", "FORNECEDOR Y", Decimal("50.00"))
    assert len(fallback) == 1
    assert fallback[0].valor_total == Decimal("50.00")
