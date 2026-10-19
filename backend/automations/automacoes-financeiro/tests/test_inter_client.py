from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from app.inter_client import (
    InterClient,
    InterTransacao,
    _clean_digits,
    _to_decimal,
)


def test_clean_digits():
    assert _clean_digits("43.820.617/0001-66") == "43820617000166"
    assert _clean_digits("123-45") == "12345"
    assert _clean_digits(None) is None
    assert _clean_digits("") is None


def test_to_decimal():
    assert _to_decimal("150.50") == Decimal("150.50")
    assert _to_decimal("150,50") == Decimal("150.50")
    assert _to_decimal(150.5) == Decimal("150.5")
    assert _to_decimal(None) == Decimal("0.00")
    assert _to_decimal("") == Decimal("0.00")


def test_split_date_range():
    client = InterClient()
    # 30 dias -> 1 janela
    w1 = client._split_date_range(date(2026, 8, 1), date(2026, 8, 30))
    assert len(w1) == 1
    assert w1[0] == (date(2026, 8, 1), date(2026, 8, 30))

    # 180 dias -> 3 janelas de até 89 dias
    w2 = client._split_date_range(date(2026, 1, 1), date(2026, 6, 30))
    assert len(w2) >= 2
    for start, end in w2:
        assert (end - start).days <= 89
    assert w2[0][0] == date(2026, 1, 1)
    assert w2[-1][1] == date(2026, 6, 30)


def test_normalize_transacao_boleto():
    client = InterClient()
    raw = {
        "tipoOperacao": "D",
        "tipoTransacao": "PAGAMENTO",
        "dataEntrada": "2026-09-20",
        "valor": "4820.00",
        "titulo": "Pagamento de Boleto",
        "descricao": "FORNECEDOR ABC",
        "detalhes": {
            "codBarras": "34191.09008 00000.000102 00000.000102 1 97890000482000",
            "cpfCnpj": "12.345.678/0001-95",
            "nomeDestinatario": "FORNECEDOR ABC LTDA",
            "valorOriginal": "4820.00",
            "dataVencimento": "2026-09-20",
            "autenticacao": "AUTH-123456",
        },
    }
    tx = client._normalize_transacao("fabrilux", raw)
    assert tx is not None
    assert tx.empresa == "fabrilux"
    assert tx.transacao_id == "AUTH-123456"
    assert tx.data_pagamento == date(2026, 9, 20)
    assert tx.valor_pago == Decimal("4820.00")
    assert tx.codigo_barras is not None
    assert len(tx.codigo_barras) == 44
    assert tx.cpf_cnpj_favorecido == "12345678000195"
    assert tx.nome_favorecido == "FORNECEDOR ABC LTDA"


def test_normalize_transacao_pix():
    client = InterClient()
    raw = {
        "tipoOperacao": "D",
        "tipoTransacao": "PIX",
        "dataEntrada": "2026-09-21",
        "valor": "300.00",
        "titulo": "Pix Enviado",
        "descricao": "PAGAMENTO SERVICO",
        "detalhes": {
            "cpfCnpjRecebedor": "98.765.432/0001-88",
            "nomeRecebedor": "SERVICO EXPRESSO",
            "endToEndId": "E1234567890",
        },
    }
    tx = client._normalize_transacao("revesta", raw)
    assert tx is not None
    assert tx.empresa == "revesta"
    assert tx.transacao_id == "E1234567890"
    assert tx.cpf_cnpj_favorecido == "98765432000188"
    assert tx.codigo_barras is None


def test_normalize_transacao_ignora_credito():
    client = InterClient()
    raw = {
        "tipoOperacao": "C",  # Entrada
        "tipoTransacao": "PIX",
        "dataEntrada": "2026-09-21",
        "valor": "500.00",
    }
    assert client._normalize_transacao("fabrilux", raw) is None


def test_demo_extrato():
    client = InterClient()
    hoje = date.today()
    transacoes = client.get_demo_extrato("fabrilux", hoje - timedelta(days=30), hoje)
    assert len(transacoes) >= 1
    assert all(t.empresa == "fabrilux" for t in transacoes)
    assert all(t.valor_pago > 0 for t in transacoes)


def test_normalize_transacao_boleto_ignora_cnpj_pagador():
    client = InterClient()
    # Revesta CNPJ: 36592814000100
    raw = {
        "tipoOperacao": "D",
        "tipoTransacao": "PAGAMENTO",
        "dataEntrada": "2026-09-25",
        "valor": "2471.04",
        "titulo": "Pagamento de Título",
        "descricao": "PAPELARIA EXEMPLO LTDA",
        "detalhes": {
            "codBarras": "75692158000002471041234501000000000012345678",
            "cpfCnpj": "36592814000100",  # CNPJ do pagador (Revesta)
            "nomeDestinatario": "PAPELARIA EXEMPLO LTDA",
            "valorOriginal": "2471.04",
            "dataVencimento": "2026-09-25",
            "autenticacao": "AUTH-ABS-01",
        },
    }
    tx = client._normalize_transacao("revesta", raw)
    assert tx is not None
    # Deve ignorar o CNPJ do pagador e manter cpf_cnpj_favorecido como None
    assert tx.cpf_cnpj_favorecido is None
    assert tx.nome_favorecido == "PAPELARIA EXEMPLO LTDA"



def test_check_credentials_status_certificado_sem_permissao(tmp_path):
    crt = tmp_path / "fabrilux.crt"
    key = tmp_path / "fabrilux.key"
    crt.write_text("crt")
    key.write_text("key")
    client = InterClient(certs_dir=tmp_path)
    with patch("app.inter_client.get_inter_oauth_credentials", return_value=("id", "secret")), \
            patch("app.inter_client.os.access", return_value=False), \
            patch.object(client, "get_token") as get_token:
        diag = client.check_credentials_status("fabrilux")
    assert diag["status"] == "certificados_sem_permissao"
    assert str(key) in diag["mensagem"]
    get_token.assert_not_called()


def test_check_credentials_status_sem_credenciais_oauth(tmp_path):
    client = InterClient(certs_dir=tmp_path)
    with patch("app.inter_client.settings") as cfg:
        cfg.INTER_FABRILUX_CLIENT_ID = None
        cfg.INTER_FABRILUX_CLIENT_SECRET = None
        diag = client.check_credentials_status("fabrilux")
    assert diag["status"] == "nao_configurado"
    assert "INTER_FABRILUX_CLIENT_ID" in diag["mensagem"]


def _resp(status, body=None, text=""):
    return MagicMock(ok=status < 400, status_code=status, text=text, json=MagicMock(return_value=body or {}))


def _extrato_com(respostas):
    client = InterClient()
    with patch.object(client, "has_credentials", return_value=True), \
            patch.object(client, "get_cert_pair", return_value=("a.crt", "a.key")), \
            patch.object(client, "get_token", return_value="tok"), \
            patch("app.inter_client.time.sleep") as sleep, \
            patch("app.inter_client.requests.get", side_effect=respostas) as get:
        try:
            return client.get_extrato("fabrilux", date(2026, 9, 1), date(2026, 9, 28)), get, sleep
        except RuntimeError as e:
            return e, get, sleep


def test_extrato_tenta_de_novo_quando_inter_responde_503():
    """503 "no healthy upstream" do Inter (2026-09-28) é passageiro: recupera sem erro."""
    result, get, sleep = _extrato_com([
        _resp(503, text="no healthy upstream"),
        _resp(503, text="no healthy upstream"),
        _resp(200, {"transacoes": []}),
    ])
    assert result == []
    assert get.call_count == 3
    assert [c.args[0] for c in sleep.call_args_list] == [2, 5]


def test_extrato_503_persistente_vira_erro_visivel():
    result, get, _ = _extrato_com([_resp(503, text="no healthy upstream")] * 3)
    assert isinstance(result, RuntimeError)
    assert "HTTP 503" in str(result)
    # corpo cru (texto do proxy) só no log, não na mensagem que chega à tela (AUT-10)
    assert "no healthy upstream" not in str(result)
    assert get.call_count == 3


def test_extrato_erro_4xx_nao_repete():
    result, get, _ = _extrato_com([_resp(400, text="dataInicio inválida")])
    assert isinstance(result, RuntimeError)
    assert get.call_count == 1
