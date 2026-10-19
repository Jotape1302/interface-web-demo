from datetime import date
from decimal import Decimal
import pytest

from app.boleto import (
    BoletoInfo,
    parse_boleto,
    vencimento_do_fator,
    _linha_bancaria_para_barras,
    _linha_convenio_para_barras,
)


def test_parse_boleto_bancario_linha_digitavel():
    # Itaú com linha de 47 dígitos, fator 9789 (2024-07-26), valor 150.00
    linha = "34191.09008 00000.000102 00000.000102 1 97890000015000"
    info = parse_boleto(linha, referencia=date(2024, 7, 26))

    assert info is not None
    assert info.convenio is False
    assert len(info.codigo_barras) == 44
    assert info.codigo_barras.startswith("3419")
    assert info.valor == Decimal("150.00")
    assert info.vencimento == date(2024, 7, 26)


def test_parse_boleto_bancario_codigo_barras():
    # Código de barras de 44 dígitos direto
    cod_barras = "34191978900000150001090000000000100000000010"
    info = parse_boleto(cod_barras, referencia=date(2024, 7, 26))

    assert info is not None
    assert info.codigo_barras == cod_barras
    assert info.convenio is False
    assert info.valor == Decimal("150.00")
    assert info.vencimento == date(2024, 7, 26)


def test_parse_boleto_novo_ciclo_2025():
    # Fator após 22/02/2025: fator 1000 = 22/02/2025
    venc = vencimento_do_fator(1000, referencia=date(2025, 2, 22))
    assert venc == date(2025, 2, 22)

    # Fator 1001 = 23/02/2025
    venc = vencimento_do_fator(1001, referencia=date(2025, 2, 23))
    assert venc == date(2025, 2, 23)


def test_parse_boleto_convenio_arrecadacao():
    # Linha de 48 dígitos começando com 8, 3º dígito '6' (valor em R$)
    # Exemplo: 83680000001 2 25000043000 0 10202409200 4 00000000000 8
    linha = "836800000012250000430000102024092004000000000008"
    info = parse_boleto(linha)

    assert info is not None
    assert info.convenio is True
    assert len(info.codigo_barras) == 44
    assert info.vencimento is None
    # Valor 00000012500 -> 125.00
    assert info.valor == Decimal("125.00")


def test_parse_boleto_invalido():
    assert parse_boleto("") is None
    assert parse_boleto("123") is None
    assert parse_boleto("abc") is None
    assert parse_boleto("3419109008000000001020000000010219789") is None  # tamanho incorreto
