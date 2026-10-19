from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.inter_client import InterTransacao
from app.reconciliation import (
    MatchMethod,
    ReconciliationMatch,
    _normalize_name,
    match_transactions,
    match_transactions_ja_baixadas,
)


def test_normalize_name():
    assert _normalize_name("FORNECEDOR ABC LTDA - ME") == "FORNECEDOR ABC"
    assert _normalize_name("Empresa de Comércio e Distribuição S/A") == "EMPRESA"
    assert _normalize_name(None) == ""


def test_match_transactions_codigo_barras():
    ref_date = date(2026, 9, 20)
    cod_barras = "34191978900000482000109000000000100000000010"

    inter_txs = [
        InterTransacao(
            empresa="fabrilux",
            transacao_id="TX-001",
            data_pagamento=ref_date,
            valor_pago=Decimal("4820.00"),
            tipo_transacao="BOLETO",
            titulo="Pagamento Boleto",
            descricao="ABC LTDA",
            codigo_barras=cod_barras,
            cpf_cnpj_favorecido="12345678000195",
            nome_favorecido="ABC LTDA",
        )
    ]

    tiny_contas = [
        {
            "id": 99881,
            "numeroDocumento": "NF-1234",
            "valor": 4820.00,
            "dataVencimento": "2026-09-20",
            "codigoBarras": cod_barras,
            "cliente": {"nome": "ABC LTDA", "cpfCnpj": "12.345.678/0001-95"},
        }
    ]

    res = match_transactions("fabrilux", inter_txs, tiny_contas)
    assert len(res.matches) == 1
    m = res.matches[0]
    assert m.metodo_match == MatchMethod.CODIGO_BARRAS
    assert m.confianca == 1.0
    assert m.conta_pagar_id == 99881
    assert m.valor_pago == Decimal("4820.00")
    assert len(res.unmatched_inter) == 0
    assert len(res.unmatched_tiny) == 0


def test_match_transactions_cnpj_valor_data():
    ref_date = date(2026, 9, 21)

    inter_txs = [
        InterTransacao(
            empresa="revesta",
            transacao_id="TX-PIX-001",
            data_pagamento=ref_date,
            valor_pago=Decimal("3200.00"),
            tipo_transacao="PIX",
            titulo="Pix Enviado",
            descricao="ALUGUEL",
            cpf_cnpj_favorecido="22334455000166",
            nome_favorecido="IMOBILIARIA CENTRAL",
        )
    ]

    tiny_contas = [
        {
            "id": 77112,
            "numeroDocumento": "REC-09",
            "valor": 3200.00,
            "dataVencimento": "2026-09-20",
            "cliente": {"nome": "IMOBILIARIA CENTRAL LTDA", "cpfCnpj": "22.334.455/0001-66"},
        }
    ]

    res = match_transactions("revesta", inter_txs, tiny_contas)
    assert len(res.matches) == 1
    m = res.matches[0]
    assert m.metodo_match == MatchMethod.CNPJ_VALOR_DATA
    assert m.confianca == 0.95
    assert m.conta_pagar_id == 77112


def test_match_transactions_cnpj_valor_com_juros():
    ref_date = date(2026, 9, 22)

    inter_txs = [
        InterTransacao(
            empresa="fabrilux",
            transacao_id="TX-BOLETO-JUROS",
            data_pagamento=ref_date,
            valor_pago=Decimal("758.30"),
            valor_original=Decimal("750.00"),
            juros=Decimal("8.30"),
            tipo_transacao="BOLETO",
            titulo="Pagamento Boleto",
            descricao="EMBALAGENS",
            cpf_cnpj_favorecido="45678912000133",
            nome_favorecido="DISTRIBUIDORA DE EMBALAGENS",
        )
    ]

    tiny_contas = [
        {
            "id": 55443,
            "numeroDocumento": "NF-501",
            "valor": 750.00,
            "dataVencimento": "2026-09-15",
            "cliente": {"nome": "DISTRIBUIDORA DE EMBALAGENS", "cpfCnpj": "45.678.912/0001-33"},
        }
    ]

    res = match_transactions("fabrilux", inter_txs, tiny_contas)
    assert len(res.matches) == 1
    m = res.matches[0]
    assert m.metodo_match in (MatchMethod.CNPJ_VALOR, MatchMethod.CNPJ_VALOR_DATA)
    assert m.juros == Decimal("8.30")
    assert m.valor_tiny == Decimal("750.00")
    assert m.valor_pago == Decimal("758.30")


def test_match_transactions_unmatched_items():
    ref_date = date(2026, 9, 20)

    inter_txs = [
        InterTransacao(
            empresa="fabrilux",
            transacao_id="TX-AVULSA",
            data_pagamento=ref_date,
            valor_pago=Decimal("999.00"),
            tipo_transacao="PIX",
            titulo="Pix Avulso",
            descricao="SERVICO AVULSO",
            cpf_cnpj_favorecido="99999999000199",
        )
    ]

    tiny_contas = [
        {
            "id": 11223,
            "numeroDocumento": "NF-999",
            "valor": 1500.00,
            "dataVencimento": "2026-09-20",
            "cliente": {"nome": "OUTRO FORNECEDOR", "cpfCnpj": "88888888000188"},
        }
    ]

    res = match_transactions("fabrilux", inter_txs, tiny_contas)
    assert len(res.matches) == 0
    assert len(res.unmatched_inter) == 1
    assert res.unmatched_inter[0].transacao_id == "TX-AVULSA"
    assert len(res.unmatched_tiny) == 1
    assert res.unmatched_tiny[0]["id"] == 11223
    assert res.summary.total_casados == 0
    assert res.summary.total_inter_sem_par == 1
    assert res.summary.total_tiny_sem_par == 1


def test_match_transactions_documento_valor():
    ref_date = date(2026, 9, 25)

    inter_txs = [
        InterTransacao(
            empresa="revesta",
            transacao_id="TX-DOC-01",
            data_pagamento=ref_date,
            valor_pago=Decimal("2471.04"),
            tipo_transacao="PAGAMENTO",
            titulo="Pagamento de Título",
            descricao="ABS PAPEL - Ref NF 61817",
            codigo_barras=None,
        )
    ]

    tiny_contas = [
        {
            "id": 88221,
            "numeroDocumento": "61817",
            "valor": 2471.04,
            "dataVencimento": "2026-09-25",
            "cliente": {"nome": "FORNECEDOR SEM CNPJ"},
        }
    ]

    res = match_transactions("revesta", inter_txs, tiny_contas)
    assert len(res.matches) == 1
    assert res.matches[0].metodo_match == MatchMethod.DOCUMENTO_VALOR
    assert res.matches[0].confianca == 0.90
    assert res.matches[0].conta_pagar_id == 88221


def test_match_transactions_nome_valor():
    ref_date = date(2026, 9, 25)

    inter_txs = [
        InterTransacao(
            empresa="revesta",
            transacao_id="TX-NOME-01",
            data_pagamento=ref_date,
            valor_pago=Decimal("68896.93"),
            tipo_transacao="PIX",
            titulo="Pix enviado",
            descricao="Alumix Aluminios Ltda",
            nome_favorecido="Alumix Aluminios Ltda",
        )
    ]

    tiny_contas = [
        {
            "id": 99331,
            "numeroDocumento": "NF-1002",
            "valor": 68896.93,
            "dataVencimento": "2026-09-25",
            "cliente": {"nome": "ALUMIX ALUMINIOS COMERCIO DE MATERIAIS"},
        }
    ]

    res = match_transactions("revesta", inter_txs, tiny_contas)
    assert len(res.matches) == 1
    assert res.matches[0].metodo_match == MatchMethod.NOME_VALOR
    assert res.matches[0].confianca == 0.80
    assert res.matches[0].conta_pagar_id == 99331


def test_match_transactions_valor_unico():
    ref_date = date(2026, 9, 25)

    inter_txs = [
        InterTransacao(
            empresa="revesta",
            transacao_id="TX-UNICO-01",
            data_pagamento=ref_date,
            valor_pago=Decimal("123.45"),
            tipo_transacao="PIX",
            titulo="Pix avulso",
            descricao="Transferência PIX",
            nome_favorecido="Maria Souza",
        )
    ]

    # Nomes sem nenhuma palavra em comum: só o valor único no período pode casar
    tiny_contas = [
        {
            "id": 44111,
            "numeroDocumento": "DOC-99",
            "valor": 123.45,
            "dataVencimento": "2026-09-25",
            "cliente": {"nome": "Grafica Horizonte"},
        }
    ]

    res = match_transactions("revesta", inter_txs, tiny_contas)
    assert len(res.matches) == 1
    assert res.matches[0].metodo_match == MatchMethod.VALOR_DATA_UNICO
    assert res.matches[0].confianca == 0.70



def _pix(tx_id, valor, nome, dia, doc=None):
    return InterTransacao(
        empresa="fabrilux", transacao_id=tx_id, data_pagamento=date(2026, 9, dia),
        valor_pago=Decimal(valor), tipo_transacao="PIX", titulo="Pix enviado",
        descricao=nome, nome_favorecido=nome, cpf_cnpj_favorecido=doc,
    )


def test_ja_baixadas_ignora_conta_paga_do_mes_anterior():
    """Aluguel recorrente: a conta de agosto já paga não pode absorver o pagamento de setembro."""
    agosto_pago = [{"id": 7, "numeroDocumento": "ALUGUEL-08", "valor": 3500.00, "dataVencimento": "2026-08-05",
                    "cliente": {"nome": "Imobiliaria Central", "cpfCnpj": "11.222.333/0001-81"}}]
    setembro = _pix("TX-ALUGUEL-09", "3500.00", "Imobiliaria Central", 5, doc="11222333000181")

    ja_baixadas, sem_par = match_transactions_ja_baixadas("fabrilux", [setembro], agosto_pago)

    assert ja_baixadas == []
    assert [t.transacao_id for t in sem_par] == ["TX-ALUGUEL-09"]


def test_ja_baixadas_nao_usa_valor_unico():
    pagas = [{"id": 8, "numeroDocumento": "X", "valor": 99.90, "dataVencimento": "2026-09-10",
              "cliente": {"nome": "Grafica Horizonte"}}]
    tx = _pix("TX-COINCIDENCIA", "99.90", "Maria Souza", 10)

    ja_baixadas, sem_par = match_transactions_ja_baixadas("fabrilux", [tx], pagas)

    assert ja_baixadas == []
    assert [t.transacao_id for t in sem_par] == ["TX-COINCIDENCIA"]
