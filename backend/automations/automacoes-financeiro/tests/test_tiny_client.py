import json
import time
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

from app import tiny_client as tiny_client_module
from app.categorization import GroupedLancamento
from app.config import settings
from app.nfe_client import NFeData, NFeDuplicate
from app.tiny_client import (
    TinyClient,
    TinyOAuthManager,
    TinyAPIError,
    format_cpf_cnpj,
    format_date_br,
    is_v3_token,
)


@pytest.fixture(autouse=True)
def _no_tiny_api_throttle(request, monkeypatch):
    """
    Neutraliza o intervalo mínimo entre chamadas à API do Tiny (_throttle_tiny_api_call,
    ver tiny_client.py) nos testes — sem isso, o estado do throttle é global ao módulo e
    se acumula entre testes que rodam em sequência na mesma sessão do pytest, deixando a
    suíte lenta sem nenhum ganho de cobertura (o comportamento do throttle em si não
    depende de rodar de verdade aqui). Testes que precisam do throttle real (o próprio
    teste do throttle) usam @pytest.mark.real_tiny_throttle pra pular essa neutralização.
    """
    if "real_tiny_throttle" in request.keywords:
        return
    monkeypatch.setattr(tiny_client_module, "_throttle_tiny_api_call", lambda: None)
    monkeypatch.setattr(tiny_client_module, "_throttle_tiny_dashboard_call", lambda *a: None)



def test_format_cpf_cnpj():
    assert format_cpf_cnpj("12345678000195") == "12.345.678/0001-95"
    assert format_cpf_cnpj("12345678901") == "123.456.789-01"
    assert format_cpf_cnpj("12.345.678/0001-95") == "12.345.678/0001-95"
    assert format_cpf_cnpj("") == ""


def test_format_date_br():
    d = date(2024, 10, 25)
    assert format_date_br(d) == "25/10/2024"


def test_build_payload_structure():
    client = TinyClient(token="mock_token", default_category="Suprimentos")
    nfe_data = NFeData(
        chave="35230912345678000123550010000001231000000123",
        numero_nota="4567",
        data_emissao=date(2024, 3, 1),
        emitente_nome="FORNECEDOR BETA LTDA",
        emitente_cnpj="12345678000190",
        valor_total=Decimal("500.00"),
        duplicatas=[]
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2024, 4, 1), valor=Decimal("500.00"))

    payload = client._build_payload(
        nfe_data=nfe_data,
        duplicata=dup,
        nro_documento="4567",
        historico="NF-e 4567 - FORNECEDOR BETA LTDA"
    )

    assert "conta" in payload
    conta = payload["conta"]
    assert conta["data_emissao"] == "01/03/2024"
    assert conta["vencimento"] == "01/04/2024"
    assert conta["valor"] == 500.00
    assert conta["nro_documento"] == "4567"
    assert conta["categoria"] == "Suprimentos"
    assert conta["cliente"]["nome"] == "FORNECEDOR BETA LTDA"
    assert conta["cliente"]["cpf_cnpj"] == "12.345.678/0001-90"


def test_parse_tiny_response_success():
    client = TinyClient(token="real_token")
    mock_response = {
        "retorno": {
            "status_processamento": "3",
            "status": "OK",
            "registros": {
                "registro": {
                    "id": 123456,
                    "situacao": "aberto"
                }
            }
        }
    }
    dup = NFeDuplicate(numero="001", vencimento=date(2024, 4, 1), valor=Decimal("150.00"))
    result = client._parse_tiny_response(mock_response, nro_documento="1001", duplicata=dup)

    assert result.conta_id == 123456
    assert result.situacao == "aberto"
    assert result.is_duplicate is False


def test_parse_tiny_response_duplicate():
    client = TinyClient(token="real_token")
    mock_response = {
        "retorno": {
            "status_processamento": "1",
            "status": "Erro",
            "erros": [
                {"erro": "Já existe uma conta a pagar cadastrada com este número de documento."}
            ]
        }
    }
    dup = NFeDuplicate(numero="001", vencimento=date(2024, 4, 1), valor=Decimal("150.00"))
    result = client._parse_tiny_response(mock_response, nro_documento="1001", duplicata=dup)

    assert result.is_duplicate is True
    assert result.situacao == "duplicada"


def test_parse_tiny_response_validation_error():
    client = TinyClient(token="real_token")
    mock_response = {
        "retorno": {
            "status_processamento": "1",
            "status": "Erro",
            "erros": [
                {"erro": "Categoria de despesa não encontrada."}
            ]
        }
    }
    dup = NFeDuplicate(numero="001", vencimento=date(2024, 4, 1), valor=Decimal("150.00"))

    with pytest.raises(TinyAPIError) as exc_info:
        client._parse_tiny_response(mock_response, nro_documento="1001", duplicata=dup)

    assert "Categoria de despesa não encontrada" in str(exc_info.value)
    assert exc_info.value.is_duplicate is False


def test_oauth_manager_caching_and_validity(tmp_path: Path):
    cache_file = tmp_path / "tiny_token_cache.json"
    oauth = TinyOAuthManager(
        client_id="test_client_id",
        client_secret="test_client_secret",
        cache_file=cache_file
    )

    # Simula gravação de token com validade de 4 horas (14400s)
    oauth._save_cache({
        "access_token": "token_valido_123",
        "refresh_token": "refresh_valido_456",
        "expires_in": 14400
    })

    assert cache_file.exists()
    assert oauth.get_access_token() == "token_valido_123"


def test_oauth_manager_auto_refresh_when_expired(tmp_path: Path):
    cache_file = tmp_path / "tiny_token_cache.json"
    oauth = TinyOAuthManager(
        client_id="test_client_id",
        client_secret="test_client_secret",
        cache_file=cache_file
    )

    # Simula token prestes a expirar (< 300s)
    oauth.access_token = "token_antigo"
    oauth.current_refresh_token = "refresh_antigo"
    oauth.expires_at = time.time() + 100  # Menos de 300s restantes

    with patch("requests.post") as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {
            "access_token": "novo_token_renovado_789",
            "refresh_token": "novo_refresh_999",
            "expires_in": 14400
        }

        token = oauth.get_access_token()
        assert token == "novo_token_renovado_789"
        assert oauth.access_token == "novo_token_renovado_789"
        mock_post.assert_called_once()


def test_oauth_manager_refresh_token_rotation(tmp_path: Path):
    cache_file = tmp_path / "tiny_token_cache.json"
    oauth = TinyOAuthManager(
        client_id="test_client_id",
        client_secret="test_client_secret",
        cache_file=cache_file
    )
    oauth.current_refresh_token = "primeiro_refresh_token"

    with patch("requests.post") as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {
            "access_token": "access_token_1",
            "refresh_token": "segundo_refresh_token_rotacionado",
            "expires_in": 14400
        }

        token = oauth.refresh_access_token()
        assert token == "access_token_1"
        assert oauth.current_refresh_token == "segundo_refresh_token_rotacionado"

        # Verifica se o cache no disco salvou o novo refresh token rotacionado
        with open(cache_file, "r", encoding="utf-8") as f:
            saved_data = json.load(f)
        assert saved_data["refresh_token"] == "segundo_refresh_token_rotacionado"
        assert saved_data["access_token"] == "access_token_1"


def test_is_v3_token():
    assert is_v3_token("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c") is True
    assert is_v3_token("a" * 120) is True
    assert is_v3_token("1cb006ca699c738960a7b06a56d8f9ab39d6d7d41037dd86") is False
    assert is_v3_token("") is False
    assert is_v3_token(None) is False


def test_resolve_contato_id_v3():
    client = TinyClient(token="eyJh_jwt_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="RAFAEL AUGUSTO TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("284.00")
    )

    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {
            "itens": [{"id": 814839555, "nome": "RAFAEL AUGUSTO TESTE PINTO"}]
        }

        contato_id = client.resolve_contato_id_v3("mock_token", nfe_data)
        assert contato_id == 814839555
        mock_get.assert_called_once()
        # Segunda chamada deve vir do cache em memória
        contato_id_cached = client.resolve_contato_id_v3("mock_token", nfe_data)
        assert contato_id_cached == 814839555
        assert mock_get.call_count == 1


def test_send_conta_pagar_v3_success():
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="RAFAEL AUGUSTO TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("284.00")
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("284.00"))

    with patch.object(client, "resolve_contato_id_v3", return_value=814839555):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post") as mock_post:
                mock_post.return_value.status_code = 201
                mock_post.return_value.content = b'{"id": 824534623}'
                mock_post.return_value.json.return_value = {"id": 824534623}

                res = client._send_conta_pagar_v3(
                    nfe_data=nfe_data,
                    duplicata=dup,
                    nro_documento="45762",
                    historico="NFC-e 45762",
                    token="eyJh_jwt"
                )

                assert res.conta_id == 824534623
                assert res.situacao == "aberto"
                assert res.is_duplicate is False


def test_send_conta_pagar_v3_duplicate():
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="RAFAEL AUGUSTO TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("284.00")
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("284.00"))

    with patch.object(client, "resolve_contato_id_v3", return_value=814839555):
        with patch.object(client, "check_duplicate_conta_v3", return_value=824534623):
            res = client._send_conta_pagar_v3(
                nfe_data=nfe_data,
                duplicata=dup,
                nro_documento="45762",
                historico="NFC-e 45762",
                token="eyJh_jwt"
            )

            assert res.conta_id == 824534623
            assert res.situacao == "duplicada"
            assert res.is_duplicate is True


def test_send_conta_pagar_v3_retries_empty_403_and_succeeds():
    """
    Incidente real 2026-09-18: HTTP 403 SEM corpo de erro do Tiny (typicamente bloqueio
    por volume de requisições, não validação de payload — essas sempre vêm com JSON) em
    notas completamente diferentes na mesma sessão de lançamento em lote (uma duplicata
    de verdade e duas que não eram). Garante que um 403 vazio é re-tentado com backoff.
    """
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="RAFAEL AUGUSTO TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("284.00")
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("284.00"))

    empty_403 = MagicMock(status_code=403, text="", content=b"")
    success = MagicMock(status_code=201, content=b'{"id": 824534623}')
    success.json.return_value = {"id": 824534623}

    with patch.object(client, "resolve_contato_id_v3", return_value=814839555):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post", side_effect=[empty_403, success]) as mock_post:
                with patch("time.sleep") as mock_sleep:
                    res = client._send_conta_pagar_v3(
                        nfe_data=nfe_data,
                        duplicata=dup,
                        nro_documento="45762",
                        historico="NFC-e 45762",
                        token="eyJh_jwt"
                    )

    assert res.conta_id == 824534623
    assert res.is_duplicate is False
    assert mock_post.call_count == 2
    mock_sleep.assert_called_once_with(3)


def test_send_conta_pagar_v3_does_not_retry_403_with_json_body():
    """Um 403 COM corpo JSON é um erro de permissão de verdade — não deve ser re-tentado
    como se fosse rate-limit, e deve propagar a mensagem real do Tiny."""
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="RAFAEL AUGUSTO TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("284.00")
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("284.00"))

    forbidden = MagicMock(status_code=403, content=b'{"mensagem": "Sem permissao para este recurso"}')
    forbidden.json.return_value = {"mensagem": "Sem permissao para este recurso"}
    forbidden.text = '{"mensagem": "Sem permissao para este recurso"}'

    with patch.object(client, "resolve_contato_id_v3", return_value=814839555):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post", return_value=forbidden) as mock_post:
                with pytest.raises(TinyAPIError, match="Sem permissao"):
                    client._send_conta_pagar_v3(
                        nfe_data=nfe_data,
                        duplicata=dup,
                        nro_documento="45762",
                        historico="NFC-e 45762",
                        token="eyJh_jwt"
                    )

    assert mock_post.call_count == 1


@pytest.mark.real_tiny_throttle
def test_throttle_tiny_api_call_enforces_minimum_interval(monkeypatch):
    """O throttle global (protege contra bloqueio por volume, ver comentário no módulo)
    deve esperar o intervalo mínimo entre chamadas, mas não esperar nada se já passou
    tempo suficiente desde a última."""
    sleeps = []
    monkeypatch.setattr(tiny_client_module.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(tiny_client_module, "_tiny_api_last_call_at", 0.0)

    t0 = 100.0
    monkeypatch.setattr(tiny_client_module.time, "monotonic", lambda: t0)
    tiny_client_module._throttle_tiny_api_call()
    assert sleeps == []  # 1ª chamada: nada esperando ainda (last_call_at era 0)

    monkeypatch.setattr(tiny_client_module.time, "monotonic", lambda: t0 + 0.1)
    tiny_client_module._throttle_tiny_api_call()
    assert sleeps == [pytest.approx(0.4)]  # esperou o restante até completar 0.5s


def test_lancar_contas_nfe_with_custom_document_number_and_marcador():
    client = TinyClient(token="eyJh_jwt_v3_token")
    nfe_data = NFeData(
        chave="41260717360924000100650010011896631292803398",
        numero_nota="1189663",
        data_emissao=date(2026, 7, 16),
        emitente_nome="AUTO POSTO EXEMPLO LTDA",
        emitente_cnpj="17360924000100",
        valor_total=Decimal("43.15"),
        numero_documento_custom="NFC-e Revesta",
        marcador_empresa="Revesta"
    )

    with patch.object(client, "resolve_contato_id_v3", return_value=12345):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post") as mock_post:
                mock_post.return_value.status_code = 201
                mock_post.return_value.content = b'{"id": 824539999}'
                mock_post.return_value.json.return_value = {"id": 824539999}

                with patch.object(client, "attach_marcador_v3", return_value=True) as mock_attach:
                    results = client.lancar_contas_nfe(nfe_data)

                    assert len(results) == 1
                    res = results[0]
                    assert res.nro_documento == "NFC-e Revesta"
                    assert res.valor == Decimal("43.15")
                    assert res.marcador == "Revesta"
                    mock_attach.assert_called_once_with(824539999, "Revesta", "eyJh_jwt_v3_token")


def test_attach_marcador_v3_whitelist_protection():
    client = TinyClient()
    token = "eyJh_jwt_token"

    # 1. Marcador pré-existente válido (Revesta)
    with patch("requests.put") as mock_put:
        mock_put.return_value.status_code = 204
        success = client.attach_marcador_v3(8888, "revesta", token)
        assert success is True
        mock_put.assert_called_once()
        args, kwargs = mock_put.call_args
        assert kwargs["json"] == [{"descricao": "Revesta"}]

    # 2. Marcador inventado/não cadastrado (deve levantar TinyAPIError e NUNCA chamar a API)
    with patch("requests.put") as mock_put_blocked:
        with pytest.raises(TinyAPIError, match="não cadastrado"):
            client.attach_marcador_v3(8888, "MarcadorInventadoNaoCadastrado", token)
        mock_put_blocked.assert_not_called()


def test_check_duplicate_conta_v3_shared_prefix_logic():
    client = TinyClient()
    token = "eyJh_jwt_token"

    mock_itens = [
        {
            "id": 1001,
            "numeroDocumento": "NFC-e Revesta",
            "valor": 43.15,
            "dataVencimento": "2026-07-16",
            "historico": "NF-e 1189663 - AUTO POSTO EXEMPLO (Chave: 41260717360924000100650010011896631292803398)"
        }
    ]

    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"itens": mock_itens}

        # Caso A: Mesma chave de acesso -> DUPLICADO (retorna 1001)
        dup_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="NFC-e Revesta",
            chave="41260717360924000100650010011896631292803398",
            valor=Decimal("43.15"),
            vencimento=date(2026, 7, 16)
        )
        assert dup_id == 1001

        # Caso B: Outra nota da Revesta (outra chave e outro valor) com mesmo prefixo 'NFC-e Revesta' -> NÃO É DUPLICADO (retorna None)
        not_dup = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="NFC-e Revesta",
            chave="35260800000000000000550010000000011000000011",
            valor=Decimal("95.00"),
            vencimento=date(2026, 7, 20)
        )
        assert not_dup is None


def test_check_duplicate_conta_v3_detects_sum_of_installments():
    """
    Incidente real 2026-09-18: notas (BOXEN EMBALAGENS NF 3214/3280, ITA EMBALAGENS NF 6938)
    já lançadas manualmente no Tiny PARCELADAS (ex.: "parcela 1/2", "parcela 2/2") continuaram
    aparecendo como pendentes de revisão, porque a checagem antiga só comparava o valor da
    nota inteira contra UM item por vez — nunca bate com uma parcela isolada, só com a soma.
    """
    client = TinyClient()
    token = "eyJh_jwt_token"

    # NF 3214: duas parcelas já lançadas manualmente, somando o valor total da nota.
    mock_itens = [
        {
            "id": 5001,
            "numeroDocumento": "3214",
            "valor": 1900.25,
            "dataVencimento": "2026-05-27",
            "historico": "Ref. a NF nº 3214, BOXEN EMBALAGENS LTDA (parcela 1/2) - BOXEN EMBALAGENS LTDA",
        },
        {
            "id": 5002,
            "numeroDocumento": "3214",
            "valor": 1829.53,
            "dataVencimento": "2026-06-16",
            "historico": "Ref. a NF nº 3214, BOXEN EMBALAGENS LTDA (parcela 2/2) - BOXEN EMBALAGENS LTDA",
        },
    ]

    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"itens": mock_itens}

        # Sem chave no histórico (lançamento manual, não pela automação) e sem nenhum item
        # isolado batendo com o valor total -> só a soma das parcelas identifica a duplicidade.
        dup_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="3214",
            chave="41260617844999000016550010000123456789012345",  # não aparece no histórico manual (44 dígitos)
            valor=Decimal("3729.78"),  # 1900.25 + 1829.53
        )
        assert dup_id in (5001, 5002)

        # Valor que não corresponde a nenhuma parcela nem à soma -> não é duplicado.
        not_dup = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="3214",
            valor=Decimal("999.99"),
        )
        assert not_dup is None


def test_check_duplicate_conta_v3_paginates_past_first_page():
    """
    A API v3 do Tiny pagina de verdade (limit/offset/total, confirmado no swagger
    oficial). Sem paginar a busca, um documento com mais de 100 contas associadas
    (comum no caso de prefixo compartilhado, ex.: "NFC-e Revesta") teria itens mais
    antigos silenciosamente fora da checagem — a duplicata usada neste teste só
    aparece na 2ª página.
    """
    client = TinyClient()
    token = "eyJh_jwt_token"

    page0_itens = [
        {"id": 100 + i, "numeroDocumento": "3214", "valor": 1.0, "dataVencimento": "2026-01-01", "historico": ""}
        for i in range(100)
    ]
    page1_itens = [
        {"id": 9999, "numeroDocumento": "3214", "valor": 29.10, "dataVencimento": "2026-07-15", "historico": ""}
    ]

    def fake_get(url, headers=None, params=None, timeout=None):
        resp = MagicMock()
        resp.status_code = 200
        offset = (params or {}).get("offset", 0)
        if offset == 0:
            resp.json.return_value = {"itens": page0_itens, "total": 101}
        elif offset == 100:
            resp.json.return_value = {"itens": page1_itens, "total": 101}
        else:
            resp.json.return_value = {"itens": []}
        return resp

    with patch("requests.get", side_effect=fake_get):
        dup_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="3214",
            valor=Decimal("29.10"),
        )

    assert dup_id == 9999


def test_check_duplicate_conta_v3_falls_back_without_contato_filter():
    """
    Incidente real 2026-09-18: NF-e 61817 (HELLEN TAVOLONI), parcela única, valor batendo
    exato, não era detectada como duplicata. Causa: o idContato resolvido pela automação
    (por CNPJ) divergia do contato usado no lançamento manual — o filtro por idContato
    sozinho fazia a busca no Tiny voltar vazia. Garante que uma segunda busca, sem esse
    filtro, encontra a duplicata.
    """
    client = TinyClient()
    token = "eyJh_jwt_token"

    mock_item = {
        "id": 7001,
        "numeroDocumento": "61817",
        "valor": 29.10,
        "dataVencimento": "2026-07-15",
        "historico": "Ref. a NF nº 61817, HELLEN TAVOLONI THEZOLIN COMERCIO NUTRICAO E BELEZA (parcela 1/1) - HELLEN TAVOL...",
    }

    call_params = []

    def fake_get(url, headers=None, params=None, timeout=None):
        call_params.append(dict(params or {}))
        resp = MagicMock()
        resp.status_code = 200
        # idContato errado (cadastro divergente do usado no lançamento manual) -> vazio.
        # Sem idContato -> encontra o item.
        resp.json.return_value = {"itens": [] if "idContato" in (params or {}) else [mock_item]}
        return resp

    with patch("requests.get", side_effect=fake_get):
        dup_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="61817",
            contato_id=999888,  # id resolvido pela automação, diferente do cadastro real
            valor=Decimal("29.10"),
        )

    assert dup_id == 7001
    assert len(call_params) == 2
    assert call_params[0].get("idContato") == 999888
    assert "idContato" not in call_params[1]


def test_attach_marcadores_v3_multiple_authorized_payment_markers():
    client = TinyClient()
    token = "eyJh_jwt_token"

    # Teste 1: Marcadores válidos (Clara + Norvia)
    with patch("requests.put") as mock_put:
        mock_put.return_value.status_code = 204
        applied = client.attach_marcadores_v3(5555, ["clara", "norvia"], token)
        assert applied == ["Cartão Clara", "Norvia"]
        mock_put.assert_called_once()
        args, kwargs = mock_put.call_args
        assert kwargs["json"] == [{"descricao": "Cartão Clara"}, {"descricao": "Norvia"}]

    # Teste 2: Marcadores válidos Revesta (Caixa Visa + Caixa Elo)
    with patch("requests.put") as mock_put_piso:
        mock_put_piso.return_value.status_code = 200
        applied_piso = client.attach_marcadores_v3(6666, ["caixa visa", "caixa elo"], token)
        assert applied_piso == ["Caixa Visa", "Caixa Elo"]
        args, kwargs = mock_put_piso.call_args
        assert kwargs["json"] == [{"descricao": "Caixa Visa"}, {"descricao": "Caixa Elo"}]

    # Teste 3: Bloqueio estrito contra marcadores não autorizados (levanta TinyAPIError)
    with patch("requests.put") as mock_put_filter:
        with pytest.raises(TinyAPIError, match="não cadastrado"):
            client.attach_marcadores_v3(7777, ["Caixa Visa Norvia", "MarcadorInvalido"], token)
        mock_put_filter.assert_not_called()


def test_resolve_contato_divergent_cnpj_raises_error():
    client = TinyClient(token="eyJh_jwt_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="FORNECEDOR TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("100.00")
    )

    # Contato localizado no Tiny com CNPJ diferente (ex: filial ou fornecedor homônimo)
    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {
            "itens": [{"id": 999, "nome": "FORNECEDOR TESTE", "cpfCnpj": "99.888.777/0001-66"}]
        }
        with pytest.raises(TinyAPIError, match="Divergência"):
            client.resolve_contato_id_v3("token", nfe_data)


def test_lancar_grupo_categorizado_sends_categoria_and_single_doc_number():
    client = TinyClient(token="eyJh_jwt_v3_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="FORNECEDOR CATEGORIA LTDA",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("100.00")
    )
    grupo = GroupedLancamento(
        categoria_id="701885961",
        categoria_nome="Materiais de Limpeza",
        valor_total=Decimal("100.00"),
        item_ids=["1", "2"],
        historico_detalhe="Detergente (R$ 50.00); Sabao (R$ 50.00)"
    )

    with patch.object(client, "resolve_contato_id_v3", return_value=12345):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post") as mock_post:
                mock_post.return_value.status_code = 201
                mock_post.return_value.content = b'{"id": 555}'
                mock_post.return_value.json.return_value = {"id": 555}

                result = client.lancar_grupo_categorizado(nfe_data, grupo, group_index=1, total_grupos=1)

                assert result.conta_id == 555
                assert result.valor == Decimal("100.00")

                _, kwargs = mock_post.call_args
                payload = kwargs["json"]
                assert payload["categoria"] == {"id": 701885961}
                assert payload["numeroDocumento"] == "45762"
                assert "Materiais de Limpeza" in payload["historico"]


def test_lancar_grupo_categorizado_uses_nota_fiscal_empresa_as_doc_number():
    """
    Pedido do usuário em 2026-09-22: notas escaneadas da SEFAZ (sem numero_documento_custom
    do Drive) devem usar "NF-e {Empresa}" como N° documento no Tiny, mesmo padrão
    já usado em lançamentos manuais (ex.: "Recibo - Norvia"), em vez do número cru da nota.
    A checagem de duplicidade passa a depender principalmente da Chave de Acesso no início
    do histórico.
    """
    client = TinyClient(token="eyJh_jwt_v3_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="FORNECEDOR CATEGORIA LTDA",
        emitente_cnpj="19473528000106",
        destinatario_cnpj="27184930000107",  # Norvia Campinas
        valor_total=Decimal("100.00")
    )
    grupo = GroupedLancamento(
        categoria_id="701885961",
        categoria_nome="Materiais de Limpeza",
        valor_total=Decimal("100.00"),
        item_ids=["1", "2"],
        historico_detalhe="Detergente (R$ 50.00); Sabao (R$ 50.00)"
    )

    with patch.object(client, "resolve_token_for_nfe", return_value=("eyJh_jwt_v3_token", "norvia_campinas")):
        with patch.object(client, "resolve_contato_id_v3", return_value=12345):
            with patch.object(client, "check_duplicate_conta_v3", return_value=None):
                with patch.object(client, "attach_marcadores_v3", return_value=["Norvia"]):
                    with patch("requests.post") as mock_post:
                        mock_post.return_value.status_code = 201
                        mock_post.return_value.content = b'{"id": 555}'
                        mock_post.return_value.json.return_value = {"id": 555}

                        result = client.lancar_grupo_categorizado(nfe_data, grupo, group_index=1, total_grupos=1)

                        assert result.nro_documento == "NF-e Norvia"
                        _, kwargs = mock_post.call_args
                        payload = kwargs["json"]
                        assert payload["numeroDocumento"] == "NF-e Norvia"
                        # A chave continua no histórico, logo no início, pra checagem de duplicidade.
                        assert payload["historico"].startswith("NF-e 45762 (Chave: 35260719473528000106650010000457621009638077)")


def test_numero_documento_cabe_no_limite_do_tiny_para_todas_as_empresas():
    # Tiny v3: "numeroDocumento: Este valor é muito longo. Deve ter 20 caracteres ou menos".
    from app.tiny_client import EXISTING_COMPANY_MARCADORES, NUMERO_DOCUMENTO_MAX

    client = TinyClient()
    for account_id in EXISTING_COMPANY_MARCADORES:
        nfe = NFeData(chave="1" * 44, numero_nota="82228", data_emissao=date(2026, 6, 20),
                      emitente_nome="X", emitente_cnpj="1", destinatario_cnpj="2", valor_total=Decimal("1"))
        doc = client._resolve_doc_base(nfe, account_id)
        assert doc.startswith("NF-e ")
        assert len(f"{doc}-9") <= NUMERO_DOCUMENTO_MAX, doc


def test_numero_documento_custom_longo_e_cortado_mantendo_sufixo_do_grupo():
    client = TinyClient(token="eyJh_jwt_v3_token")
    nfe = NFeData(chave="1" * 44, numero_nota="1", data_emissao=date(2026, 6, 20),
                  emitente_nome="X", emitente_cnpj="1", destinatario_cnpj="2", valor_total=Decimal("2"),
                  numero_documento_custom="Recibo - Fornecedor com nome enorme")
    grupo = GroupedLancamento(categoria_id="1", categoria_nome="C", valor_total=Decimal("1"),
                              item_ids=["1"], historico_detalhe="")
    with patch.object(client, "resolve_token_for_nfe", return_value=("eyJh_jwt_v3_token", "revesta")), \
         patch.object(client, "_send_conta_pagar_v3", side_effect=lambda **kw: kw["nro_documento"]):
        doc = client.lancar_grupo_categorizado(nfe, grupo, group_index=2, total_grupos=2)
    assert doc == "Recibo - Fornecedo-2" and len(doc) == 20


def test_lancar_grupo_categorizado_suffixes_document_number_when_multiple_groups():
    client = TinyClient(token="eyJh_jwt_v3_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="FORNECEDOR CATEGORIA LTDA",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("50.00")
    )
    grupo = GroupedLancamento(
        categoria_id="484437483",
        categoria_nome="Material de Escritório",
        valor_total=Decimal("50.00"),
        item_ids=["3"],
        historico_detalhe="Papel A4 (R$ 50.00)"
    )

    with patch.object(client, "resolve_contato_id_v3", return_value=12345):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post") as mock_post:
                mock_post.return_value.status_code = 201
                mock_post.return_value.content = b'{"id": 556}'
                mock_post.return_value.json.return_value = {"id": 556}

                result = client.lancar_grupo_categorizado(nfe_data, grupo, group_index=2, total_grupos=2)

                assert result.nro_documento == "45762-2"
                _, kwargs = mock_post.call_args
                assert kwargs["json"]["numeroDocumento"] == "45762-2"



def test_parcelas_documento_vencimento_e_valor_de_cada_conta():
    from app.tiny_client import dividir_em_parcelas

    client = TinyClient(token="eyJh_jwt_v3_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 1, 31),
        emitente_nome="FORNECEDOR PARCELADO LTDA",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("100.00"),
    )
    grupo = GroupedLancamento(
        categoria_id="484437483", categoria_nome="Compras", valor_total=Decimal("100.00"),
        item_ids=["1"], historico_detalhe="Item (R$ 100.00)",
    )
    valores = dividir_em_parcelas(Decimal("100.00"), 3)
    assert valores == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]

    enviados = []
    with patch.object(client, "resolve_contato_id_v3", return_value=12345), \
         patch.object(client, "check_duplicate_conta_v3", return_value=None) as dup, \
         patch("requests.post") as mock_post:
        mock_post.return_value.status_code = 201
        mock_post.return_value.content = b'{"id": 1}'
        mock_post.return_value.json.return_value = {"id": 1}
        for p, v in enumerate(valores, start=1):
            client.lancar_grupo_categorizado(nfe_data, grupo, 1, 1, parcela=p, total_parcelas=3, valor_parcela=v)
            enviados.append(mock_post.call_args.kwargs["json"])

    assert [e["numeroDocumento"] for e in enviados] == ["45762/1", "45762/2", "45762/3"]
    # Sem marcador nem duplicatas: emissão + 1 mês por parcela (31/01 -> 28/02 -> 31/03).
    assert [e["dataVencimento"] for e in enviados] == ["2026-01-31", "2026-02-28", "2026-03-31"]
    assert [e["valor"] for e in enviados] == [33.33, 33.33, 33.34]
    assert "(Parc 2/3)" in enviados[1]["historico"]
    assert all(c.kwargs["estrita"] for c in dup.call_args_list), "parcelas irmãs não podem virar 'duplicada'"


def test_parcelas_no_cartao_seguem_o_ciclo_do_marcador():
    from app.tiny_client import vencimento_da_parcela

    nfe = NFeData(chave="1" * 44, numero_nota="1", data_emissao=date(2026, 11, 20), emitente_nome="X",
                  emitente_cnpj="19473528000106", valor_total=Decimal("10"))
    nfe.marcador_caixa = "Caixa Visa"
    assert [vencimento_da_parcela(nfe, p, 3) for p in (1, 2, 3)] == [date(2026, 12, 15), date(2027, 1, 15), date(2027, 2, 15)]


def test_parcelas_usam_as_duplicatas_do_xml_quando_a_quantidade_bate():
    from app.nfe_client import NFeDuplicate
    from app.tiny_client import vencimento_da_parcela

    nfe = NFeData(chave="1" * 44, numero_nota="1", data_emissao=date(2026, 9, 1), emitente_nome="X",
                  emitente_cnpj="19473528000106", valor_total=Decimal("10"))
    nfe.duplicatas = [NFeDuplicate("002", date(2026, 10, 31), Decimal("5")), NFeDuplicate("001", date(2026, 10, 1), Decimal("5"))]
    assert [vencimento_da_parcela(nfe, p, 2) for p in (1, 2)] == [date(2026, 10, 1), date(2026, 10, 31)]
    assert vencimento_da_parcela(nfe, 1, 1) == date(2026, 10, 1)


def test_duplicidade_estrita_so_reconhece_a_propria_conta():
    client = TinyClient(token="eyJh_jwt_v3_token")
    chave = "35260719473528000106650010000457621009638077"
    irmas = [
        {"id": 1, "numeroDocumento": "45762/1", "historico": f"NF-e 45762 (Chave: {chave})", "valor": 50},
        {"id": 2, "numeroDocumento": "45762-2", "historico": f"NF-e 45762 (Chave: {chave})", "valor": 50},
    ]
    with patch.object(client, "_fetch_contas_pagar_itens", return_value=irmas):
        assert client.check_duplicate_conta_v3("t", "45762/2", chave=chave, valor=Decimal("50"), estrita=True) is None
        assert client.check_duplicate_conta_v3("t", "45762/1", chave=chave, valor=Decimal("50"), estrita=True) == 1


def test_resolve_contato_not_found_raises_error():
    client = TinyClient(token="eyJh_jwt_token")
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="FORNECEDOR NAO CADASTRADO",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("100.00")
    )

    # Contato não encontrado no Tiny
    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"itens": []}
        with pytest.raises(TinyAPIError, match="não encontrado nos contatos"):
            client.resolve_contato_id_v3("token", nfe_data)


def test_check_duplicate_conta_v3_detects_installments_with_slash_and_standard_history():
    """
    Testa o caso real de notas como BOXEN EMBALAGENS NF 3280 e 3214:
    No Tiny ERP, as parcelas foram lançadas com numeroDocumento '3280/1', '3280/2', '3280/3'
    e histórico 'Ref. a NF nº 3280, BOXEN EMBALAGENS LTDA (parcela 1/3) - BOXEN EMBALAGENS LTDA'.
    A busca deve identificar a duplicidade tanto pelo histórico quanto pela soma das parcelas.
    """
    client = TinyClient()
    token = "eyJh_jwt_token"

    mock_itens = [
        {
            "id": 8001,
            "numeroDocumento": "3280/1",
            "valor": 723.52,
            "dataVencimento": "2026-08-01",
            "historico": "Ref. a NF nº 3280, BOXEN EMBALAGENS LTDA (parcela 1/3) - BOXEN EMBALAGENS LTDA",
        },
        {
            "id": 8002,
            "numeroDocumento": "3280/2",
            "valor": 723.52,
            "dataVencimento": "2026-09-01",
            "historico": "Ref. a NF nº 3280, BOXEN EMBALAGENS LTDA (parcela 2/3) - BOXEN EMBALAGENS LTDA",
        },
        {
            "id": 8003,
            "numeroDocumento": "3280/3",
            "valor": 723.52,
            "dataVencimento": "2026-10-01",
            "historico": "Ref. a NF nº 3280, BOXEN EMBALAGENS LTDA (parcela 3/3) - BOXEN EMBALAGENS LTDA",
        },
    ]

    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"itens": mock_itens}

        # Soma das 3 parcelas = 2170.56
        dup_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="3280",
            contato_id=12345,
            valor=Decimal("2170.56"),
        )
        assert dup_id == 8001


def test_check_duplicate_conta_v3_detects_single_installment_with_slash():
    """
    Testa o caso real de notas como ITA EMBALAGENS NF 6938:
    No Tiny ERP, foi lançada como parcela 1/1 com numeroDocumento '6938/1' e valor R$ 1080.00.
    A busca por nro_documento='6938' deve reconhecer o prefixo e o valor exato.
    """
    client = TinyClient()
    token = "eyJh_jwt_token"

    mock_itens = [
        {
            "id": 9001,
            "numeroDocumento": "6938/1",
            "valor": 1080.00,
            "dataVencimento": "2026-08-08",
            "historico": "Ref. a NF nº 6938, ITA EMBALAGENS INDUSTRIA E COMERCIO LTDA (parcela 1/1) - ITA EMBALAGENS...",
        }
    ]

    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"itens": mock_itens}

        dup_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento="6938",
            contato_id=876514037,
            valor=Decimal("1080.00"),
        )
        assert dup_id == 9001


def test_send_conta_pagar_v3_empty_403_raises_informative_permission_error():
    """
    Testa se um erro 403 persistente retorna uma mensagem informativa
    apontando permissão de escrita e escopos no Tiny ERP.
    """
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="RAFAEL AUGUSTO TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("284.00"),
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("284.00"))

    mock_resp = MagicMock(status_code=403, text="", content=b"", headers={"server": "cloudflare"})

    with patch.object(client, "resolve_contato_id_v3", return_value=814839555):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch("requests.post", return_value=mock_resp):
                with patch("time.sleep"):
                    with pytest.raises(TinyAPIError) as exc_info:
                        client._send_conta_pagar_v3(
                            nfe_data=nfe_data,
                            duplicata=dup,
                            nro_documento="45762",
                            historico="NFC-e 45762",
                            token="eyJh_jwt",
                        )
                    assert "permissão de escrita para Contas a Pagar" in str(exc_info.value)
                    assert "olist_contas_pagar_create" in str(exc_info.value)


def test_list_categorias_receita_despesa_v3_success_and_caching():
    client = TinyClient()
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {
        "itens": [
            {"id": 101, "descricao": "Materiais de Limpeza", "grupo": "Despesas"},
            {"id": 102, "descricao": "Compras", "grupo": "Custos"},
        ]
    }

    with patch("requests.get", return_value=mock_resp) as mock_get:
        # 1. Primeira chamada faz requisição à API
        cats = client.list_categorias_receita_despesa_v3("eyJh_test_token")
        assert len(cats) == 2
        assert cats[0]["id"] == 101
        assert mock_get.call_count == 1

        # 2. Segunda chamada aproveita cache em memória (TTL 30min)
        cats_cached = client.list_categorias_receita_despesa_v3("eyJh_test_token")
        assert len(cats_cached) == 2
        assert mock_get.call_count == 1  # Não deve chamar novamente


def test_resolve_categoria_id_v3_matches_exact_id():
    client = TinyClient()
    with patch.object(
        client,
        "list_categorias_receita_despesa_v3",
        return_value=[{"id": 101, "descricao": "Materiais de Limpeza"}],
    ):
        resolved = client.resolve_categoria_id_v3("token", categoria_id="101")
        assert resolved == 101


def test_resolve_categoria_id_v3_matches_name_when_id_is_from_other_account():
    client = TinyClient()
    # No cadastro real do Tiny da empresa Campinas, o ID de 'Materiais de Limpeza' é 999
    # mas o payload sugerido veio com o ID estático de Curitiba ('701885961')
    with patch.object(
        client,
        "list_categorias_receita_despesa_v3",
        return_value=[{"id": 999, "descricao": "Materiais de Limpeza"}],
    ):
        resolved = client.resolve_categoria_id_v3(
            "token",
            categoria_id="701885961",
            categoria_nome="Materiais de Limpeza",
        )
        assert resolved == 999


def test_resolve_categoria_id_v3_matches_normalized_and_partial_name():
    client = TinyClient()
    # Cadastro no Tiny tem 'Material de Limpeza' (singular) e sem acento
    with patch.object(
        client,
        "list_categorias_receita_despesa_v3",
        return_value=[{"id": 888, "descricao": "Material de Limpeza"}],
    ):
        resolved = client.resolve_categoria_id_v3(
            "token",
            categoria_id="701885961",
            categoria_nome="Materiais de Limpeza",
        )
        assert resolved == 888


def test_resolve_categoria_id_v3_returns_none_when_category_not_in_account():
    client = TinyClient()
    # A conta do Tiny possui apenas outras categorias
    with patch.object(
        client,
        "list_categorias_receita_despesa_v3",
        return_value=[{"id": 501, "descricao": "Aluguel"}, {"id": 502, "descricao": "Energia"}],
    ):
        resolved = client.resolve_categoria_id_v3(
            "token",
            categoria_id="701885961",
            categoria_nome="Materiais de Limpeza",
        )
        assert resolved is None


def test_send_conta_pagar_v3_omits_categoria_when_unresolved():
    """Quando a categoria não é encontrada no Tiny, o payload NÃO envia 'categoria' para não dar 400."""
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="45762",
        data_emissao=date(2026, 7, 1),
        emitente_nome="FORNECEDOR TESTE",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("150.00"),
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("150.00"))

    with patch.object(client, "resolve_contato_id_v3", return_value=123):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            with patch.object(client, "resolve_categoria_id_v3", return_value=None):
                with patch("requests.post") as mock_post:
                    mock_post.return_value.status_code = 201
                    mock_post.return_value.content = b'{"id": 112233}'
                    mock_post.return_value.json.return_value = {"id": 112233}

                    res = client._send_conta_pagar_v3(
                        nfe_data=nfe_data,
                        duplicata=dup,
                        nro_documento="45762",
                        historico="NF-e 45762 [Materiais de Limpeza]",
                        token="eyJh_jwt",
                        categoria_id="701885961",
                        categoria_nome="Materiais de Limpeza",
                    )

                    assert res.conta_id == 112233
                    sent_payload = mock_post.call_args[1]["json"]
                    assert "categoria" not in sent_payload
                    assert "[Materiais de Limpeza]" in sent_payload["historico"]


def test_send_conta_pagar_v3_auto_recovers_from_400_categoria_nao_encontrada():
    """
    Incidente real: Tiny v3 rejeita conta com HTTP 400:
    'Ocorreram erros de validação (categoria.id: Categoria não encontrada)'.
    O cliente remove 'categoria' do payload e reenvia imediatamente com sucesso.
    """
    client = TinyClient()
    nfe_data = NFeData(
        chave="35260719473528000106650010000457621009638077",
        numero_nota="46798",
        data_emissao=date(2026, 7, 1),
        emitente_nome="DIAS EXEMPLO S/A COM IND",
        emitente_cnpj="19473528000106",
        valor_total=Decimal("200.00"),
    )
    dup = NFeDuplicate(numero="001", vencimento=date(2026, 7, 1), valor=Decimal("200.00"))

    err_400 = MagicMock(status_code=400)
    err_400.json.return_value = {
        "mensagem": "Ocorreram erros de validação",
        "detalhes": [{"campo": "categoria.id", "mensagem": "Categoria não encontrada"}],
    }
    err_400.text = '{"mensagem": "Ocorreram erros de validação"}'
    err_400.content = '{"mensagem": "Ocorreram erros de validação"}'.encode("utf-8")

    success_201 = MagicMock(status_code=201)
    success_201.json.return_value = {"id": 899123}
    success_201.content = b'{"id": 899123}'

    with patch.object(client, "resolve_contato_id_v3", return_value=554433):
        with patch.object(client, "check_duplicate_conta_v3", return_value=None):
            # Simula que resolve_categoria_id_v3 passou o ID
            with patch.object(client, "resolve_categoria_id_v3", return_value=701885961):
                with patch("requests.post", side_effect=[err_400, success_201]) as mock_post:
                    res = client._send_conta_pagar_v3(
                        nfe_data=nfe_data,
                        duplicata=dup,
                        nro_documento="46798-1",
                        historico="NF-e 46798 [Materiais de Limpeza]",
                        token="eyJh_jwt",
                        categoria_id="701885961",
                        categoria_nome="Materiais de Limpeza",
                    )

                    assert res.conta_id == 899123
                    assert mock_post.call_count == 2

                    # Primeira chamada tinha categoria
                    first_payload = mock_post.call_args_list[0][1]["json"]
                    assert first_payload.get("categoria") == {"id": 701885961}

                    # Segunda chamada reenviou SEM categoria
                    second_payload = mock_post.call_args_list[1][1]["json"]
                    assert "categoria" not in second_payload
                    assert second_payload["numeroDocumento"] == "46798-1"


@pytest.mark.real_tiny_throttle
def test_throttle_tiny_dashboard_call_enforces_longer_minimum_interval(monkeypatch):
    """
    Throttle próprio do dashboard financeiro (mais folgado que o de lançamento de NF-e) —
    ver incidente real de 2026-09-21 no comentário do módulo: ~260 chamadas em sequência
    do sync do dashboard, mesmo respeitando o throttle de 0,5s padrão, bastaram para o
    Tiny bloquear com HTTP 403 vazio.
    """
    sleeps = []
    monkeypatch.setattr(tiny_client_module.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(tiny_client_module, "_tiny_dashboard_last_call", {})

    t0 = 200.0
    monkeypatch.setattr(tiny_client_module.time, "monotonic", lambda: t0)
    tiny_client_module._throttle_tiny_dashboard_call()
    assert sleeps == []

    monkeypatch.setattr(tiny_client_module.time, "monotonic", lambda: t0 + 0.2)
    tiny_client_module._throttle_tiny_dashboard_call()
    assert sleeps == [pytest.approx(1.8)]  # esperou o restante até completar 2,0s

    # Outra conta do Tiny (outra filial) tem limite próprio: não espera a primeira.
    tiny_client_module._throttle_tiny_dashboard_call("Bearer outra-filial")
    assert sleeps == [pytest.approx(1.8)]


def test_fetch_paginated_v3_itens_aborts_after_repeated_empty_403_as_permission_error():
    """
    Reproduz o incidente real de 2026-09-21: TODA chamada a /caixa numa sincronização real
    voltou HTTP 403 sem corpo, persistente (não só um blip isolado) em duas tentativas
    separadas por ~20 minutos — mesmo critério já usado em _send_conta_pagar_v3 pra um 403
    vazio que não se resolve após várias tentativas: é falta de permissão/escopo OAuth, não
    bloqueio de infraestrutura. O circuito deve abortar cedo com um erro que aponte pra
    verificar o escopo, em vez de insistir nas ~260 chamadas fadadas ao fracasso.
    """
    client = TinyClient()
    mock_resp = MagicMock(status_code=403, text="", content=b"")

    with patch("requests.get", return_value=mock_resp) as mock_get:
        with patch("time.sleep"):
            with pytest.raises(TinyAPIError) as exc_info:
                for _ in range(20):
                    client._fetch_paginated_v3_itens(
                        "https://api.tiny.com.br/public-api/v3/caixa",
                        {"Authorization": "Bearer x"},
                        {"idCategoria": "1"},
                    )
            assert "permiss" in str(exc_info.value).lower()
            assert "escopo" in str(exc_info.value).lower()
            # Abortou bem antes de esgotar as 20 tentativas simuladas.
            assert mock_get.call_count == tiny_client_module._TINY_DASHBOARD_MAX_CONSECUTIVE_BLOCK_FAILURES


def test_fetch_paginated_v3_itens_retries_429_with_backoff_before_giving_up():
    """
    HTTP 429 é rate-limit de verdade (diferente do 403 vazio, que é permissão) — deve
    esperar com backoff crescente e tentar de novo a MESMA página antes de desistir,
    já que costuma se resolver sozinho com tempo (ao contrário de falta de permissão).
    """
    client = TinyClient()
    mock_resp = MagicMock(status_code=429, text="Too Many Requests", content=b"Too Many Requests", headers={})

    with patch("requests.get", return_value=mock_resp) as mock_get:
        with patch("time.sleep") as mock_sleep:
            with pytest.raises(TinyAPIError) as exc_info:
                client._fetch_paginated_v3_itens(
                    "https://api.tiny.com.br/public-api/v3/contas-pagar",
                    {"Authorization": "Bearer x"},
                    {"situacao": "pago"},
                )
            assert "429" in str(exc_info.value)
            # 1 chamada inicial + N retentativas antes de desistir.
            assert mock_get.call_count == tiny_client_module._TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES + 1
            # Esperou entre as tentativas (backoff), não desistiu na primeira falha.
            assert mock_sleep.call_count == tiny_client_module._TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES
            assert list(mock_sleep.call_args_list[i][0][0] for i in range(len(mock_sleep.call_args_list))) == [
                tiny_client_module._TINY_DASHBOARD_RATE_LIMIT_BASE_WAIT_SECONDS * (i + 1)
                for i in range(tiny_client_module._TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES)
            ]


def test_fetch_paginated_v3_itens_recovers_after_transient_429():
    """Um 429 isolado (não persistente) não deve derrubar a chamada — só espera e segue."""
    client = TinyClient()
    responses = [
        MagicMock(status_code=429, text="", content=b"", headers={}),
        MagicMock(status_code=200, content=b"{}", json=lambda: {"itens": [{"id": 1}], "total": 1}),
    ]

    with patch("requests.get", side_effect=responses) as mock_get:
        with patch("time.sleep"):
            itens = client._fetch_paginated_v3_itens(
                "https://api.tiny.com.br/public-api/v3/contas-pagar",
                {"Authorization": "Bearer x"},
                {"situacao": "pago"},
            )
            assert itens == [{"id": 1}]
            assert mock_get.call_count == 2


def test_fetch_paginated_v3_itens_retries_transient_network_failure():
    """
    Reproduz o incidente real de 2026-09-21: a VPS ficou alguns segundos sem resolver DNS
    (api.tiny.com.br) no meio de uma sincronização real — não é resposta HTTP nenhuma,
    `requests.get` levanta exceção de conexão. Um blip curto (que se resolve dentro do
    orçamento de retentativas) não deve derrubar a chamada.
    """
    client = TinyClient()
    dns_error = requests.exceptions.ConnectionError("Failed to resolve 'api.tiny.com.br'")
    ok_resp = MagicMock(status_code=200, content=b"{}", json=lambda: {"itens": [{"id": 42}], "total": 1})

    with patch("requests.get", side_effect=[dns_error, dns_error, ok_resp]) as mock_get:
        with patch("time.sleep") as mock_sleep:
            itens = client._fetch_paginated_v3_itens(
                "https://api.tiny.com.br/public-api/v3/caixa",
                {"Authorization": "Bearer x"},
                {"idCategoria": "1"},
            )
            assert itens == [{"id": 42}]
            assert mock_get.call_count == 3
            assert mock_sleep.call_count == 2


def test_fetch_paginated_v3_itens_gives_up_after_persistent_network_failure():
    """Falha de rede que não se resolve dentro do orçamento de retentativas deve abortar
    com um erro informativo, em vez de travar indefinidamente."""
    client = TinyClient()
    dns_error = requests.exceptions.ConnectionError("Failed to resolve 'api.tiny.com.br'")

    with patch("requests.get", side_effect=dns_error) as mock_get:
        with patch("time.sleep"):
            with pytest.raises(TinyAPIError) as exc_info:
                client._fetch_paginated_v3_itens(
                    "https://api.tiny.com.br/public-api/v3/caixa",
                    {"Authorization": "Bearer x"},
                    {"idCategoria": "1"},
                )
            assert "rede" in str(exc_info.value).lower()
            assert mock_get.call_count == tiny_client_module._TINY_DASHBOARD_MAX_NETWORK_RETRIES + 1


def test_fetch_paginated_v3_itens_circuit_is_independent_per_endpoint():
    """Falhas em /caixa não devem contaminar o circuito de /contas-pagar (endpoint diferente)."""
    client = TinyClient()
    mock_resp = MagicMock(status_code=403, text="", content=b"")

    with patch("requests.get", return_value=mock_resp):
        with patch("time.sleep"):
            with pytest.raises(TinyAPIError):
                for _ in range(20):
                    client._fetch_paginated_v3_itens(
                        "https://api.tiny.com.br/public-api/v3/caixa",
                        {"Authorization": "Bearer x"},
                        {"idCategoria": "1"},
                    )
            # /contas-pagar ainda não foi chamado nenhuma vez — circuito próprio, zerado.
            assert client._consecutive_block_failures.get("https://api.tiny.com.br/public-api/v3/contas-pagar", 0) == 0


def test_fetch_paginated_v3_itens_resets_consecutive_failures_on_success():
    """Uma resposta 200 no meio do caminho reseta o contador — não é bloqueio persistente."""
    client = TinyClient()
    responses = [
        MagicMock(status_code=403, text="", content=b""),
        MagicMock(status_code=403, text="", content=b""),
        MagicMock(status_code=200, content=b"{}", json=lambda: {"itens": [], "total": 0}),
        MagicMock(status_code=403, text="", content=b""),
        MagicMock(status_code=403, text="", content=b""),
    ]

    with patch("requests.get", side_effect=responses):
        with patch("time.sleep"):
            for _ in range(2):
                client._fetch_paginated_v3_itens(
                    "https://api.tiny.com.br/public-api/v3/caixa",
                    {"Authorization": "Bearer x"},
                    {"idCategoria": "1"},
                )
            client._fetch_paginated_v3_itens(
                "https://api.tiny.com.br/public-api/v3/caixa",
                {"Authorization": "Bearer x"},
                {"idCategoria": "2"},
            )
            assert client._consecutive_block_failures.get("https://api.tiny.com.br/public-api/v3/caixa", 0) == 0
            for _ in range(2):
                client._fetch_paginated_v3_itens(
                    "https://api.tiny.com.br/public-api/v3/caixa",
                    {"Authorization": "Bearer x"},
                    {"idCategoria": "3"},
                )
            assert client._consecutive_block_failures.get("https://api.tiny.com.br/public-api/v3/caixa", 0) == 2


def test_baixar_conta_pagar_v3_sucesso():
    client = TinyClient()
    mock_resp = MagicMock(status_code=204)
    conta = MagicMock(status_code=200, json=lambda: {"id": 12345, "historico": ""})

    with patch("requests.post", return_value=mock_resp) as mock_post, \
         patch("requests.get", return_value=conta):
        success = client.baixar_conta_pagar_v3(
            token="test-token",
            conta_id=12345,
            valor_pago=150.50,
            data_pagamento="2026-09-25",
            juros=2.50,
            historico="Baixa teste",
        )
        assert success is True
        assert mock_post.call_count == 1
        call_args = mock_post.call_args
        assert "12345/baixar" in call_args[0][0]
        payload = call_args[1]["json"]
        assert payload["valorPago"] == 150.50
        assert payload["data"] == "25/09/2026"
        assert payload["juros"] == 2.50
        assert payload["historico"] == "Baixa teste"


def test_baixar_conta_pagar_v3_mantem_historico_da_conta():
    client = TinyClient()
    conta = MagicMock(
        status_code=200,
        json=lambda: {"id": 12345, "historico": "Ref. as Notas Fiscais - 635; 646; 647"},
    )
    with patch("requests.post", return_value=MagicMock(status_code=204)) as mock_post, \
         patch("requests.get", return_value=conta) as mock_get:
        client.baixar_conta_pagar_v3(
            token="test-token",
            conta_id=12345,
            valor_pago=10.0,
            historico="Baixa conciliada Banco Inter - Pagamento de Título 3194",
        )
    assert mock_get.call_args[0][0].endswith("/contas-pagar/12345")
    assert mock_post.call_args[1]["json"]["historico"] == (
        "Ref. as Notas Fiscais - 635; 646; 647 | Baixa conciliada Banco Inter - Pagamento de Título 3194"
    )


def test_baixar_conta_pagar_v3_nao_baixa_sem_conseguir_ler_historico():
    client = TinyClient()
    with patch("requests.post") as mock_post, \
         patch("requests.get", return_value=MagicMock(status_code=404, text="não encontrada")), \
         pytest.raises(RuntimeError, match="histórico atual"):
        client.baixar_conta_pagar_v3(token="t", conta_id=1, valor_pago=1.0, historico="Baixa")
    mock_post.assert_not_called()


def test_juntar_historico_baixa():
    from app.tiny_client import juntar_historico_baixa

    assert juntar_historico_baixa("", "Baixa X") == "Baixa X"
    assert juntar_historico_baixa("Ref. NF 1", "Baixa X") == "Ref. NF 1 | Baixa X"
    # reenviar não repete
    assert juntar_historico_baixa("Ref. NF 1 | Baixa X", "Baixa X") == "Ref. NF 1 | Baixa X"
    # estourou o limite: corta o texto da baixa, nunca a referência original
    original = "R" * 290
    junto = juntar_historico_baixa(original, "Baixa conciliada Banco Inter")
    assert len(junto) == 300 and junto.startswith(original)


def test_baixar_conta_pagar_v3_erro_validacao():
    client = TinyClient()
    mock_resp = MagicMock(
        status_code=400,
        json=lambda: {"mensagem": "Conta já baixada", "detalhes": []},
    )

    with patch("requests.post", return_value=mock_resp):
        with pytest.raises(RuntimeError) as exc_info:
            client.baixar_conta_pagar_v3(
                token="test-token",
                conta_id=12345,
                valor_pago=100.00,
            )
        assert "Conta já baixada" in str(exc_info.value)


def test_list_contas_pagar_abertas_chama_list_v3_com_situacao_aberto():
    client = TinyClient()
    with patch.object(client, "list_contas_pagar_v3", return_value=[{"id": 1}]) as mock_list:
        res = client.list_contas_pagar_abertas(
            token="token123",
            data_inicial_vencimento="2026-09-01",
            data_final_vencimento="2026-09-30",
        )
        assert len(res) == 1
        mock_list.assert_called_once_with(
            token="token123",
            situacao="aberto",
            data_inicial_vencimento="2026-09-01",
            data_final_vencimento="2026-09-30",
            max_pages=300,
        )








def test_notas_diferentes_com_mesmo_valor_e_documento_generico_nao_sao_duplicadas():
    """Incidente 2026-09-29: VELTRIX3D NF 276 lançada; 280 e 282 (mesmo valor e vencimento) viraram 'Já existia'."""
    client = TinyClient(token="eyJh_jwt_v3_token")
    chave_276 = "35260761937402000101551010000002761368274137"
    chave_280 = "35260761937402000101551010000002801368274130"
    ja_lancada = [{
        "id": 900, "numeroDocumento": "NF-e Norvia", "valor": 114.50, "dataVencimento": "2026-10-15",
        "historico": f"NF-e 276 (Chave: {chave_276}) - VELTRIX3D COMERCIO [Compras]: item",
    }]
    with patch.object(client, "_fetch_contas_pagar_itens", return_value=ja_lancada):
        assert client.check_duplicate_conta_v3(
            "t", "NF-e Norvia", contato_id=1, chave=chave_280, valor=Decimal("114.50"),
            vencimento=date(2026, 10, 15), numero_nota="280",
        ) is None
        # A própria nota continua sendo reconhecida pela chave.
        assert client.check_duplicate_conta_v3(
            "t", "NF-e Norvia", contato_id=1, chave=chave_276, valor=Decimal("114.50"), numero_nota="276",
        ) == 900


def test_documento_generico_ainda_acha_lancamento_manual_pelo_numero_da_nota():
    client = TinyClient(token="eyJh_jwt_v3_token")
    manual = [
        {"id": 901, "numeroDocumento": "280", "valor": 114.50, "dataVencimento": "2026-10-15", "historico": "Compra Veltrix"},
        {"id": 902, "numeroDocumento": "NF-e Norvia", "valor": 114.50, "dataVencimento": "2026-10-15", "historico": "Outra"},
    ]
    with patch.object(client, "_fetch_contas_pagar_itens", return_value=manual):
        assert client.check_duplicate_conta_v3(
            "t", "NF-e Norvia", contato_id=1, chave="3" * 44, valor=Decimal("114.50"),
            vencimento=date(2026, 10, 15), numero_nota="280",
        ) == 901
    with patch.object(client, "_fetch_contas_pagar_itens", return_value=manual[1:]):
        assert client.check_duplicate_conta_v3(
            "t", "NF-e Norvia", contato_id=1, chave="3" * 44, valor=Decimal("114.50"),
            vencimento=date(2026, 10, 15), numero_nota="280",
        ) is None, "mesmo documento genérico e valor, sem o número da nota: não é a mesma nota"


def test_obter_contas_financeiras_v3_sucesso():
    client = TinyClient()
    mock_resp = MagicMock(
        status_code=200,
        json=lambda: {
            "itens": [
                {"id": 101, "descricao": "Caixa", "situacao": "A"},
                {"id": 102, "descricao": "Inter Norvia Curitiba", "situacao": "A"},
            ]
        },
    )
    with patch("requests.get", return_value=mock_resp):
        contas = client.obter_contas_financeiras_v3("test_token")
        assert len(contas) == 2
        assert contas[1]["id"] == 102


def test_resolve_conta_origem_inter_curitiba():
    client = TinyClient()
    contas_mock = [
        {"id": 10, "descricao": "Caixa", "situacao": "A"},
        {"id": 54, "descricao": "Inter Resgate 24h Fic Firf RI", "situacao": "A"},
        {"id": 55, "descricao": "Inter Norvia Curitiba", "situacao": "A"},
        {"id": 88, "descricao": "Banco do Brasil", "situacao": "A"},
    ]
    with patch.object(client, "obter_contas_financeiras_v3", return_value=contas_mock):
        cid = client.resolve_conta_origem_inter("token_ldn", "norvia_curitiba")
        assert cid == 55
        # Segundo acesso deve vir do cache
        assert client.resolve_conta_origem_inter("token_ldn", "norvia_curitiba") == 55


@pytest.mark.parametrize("empresa,nome", [
    ("norvia_curitiba", "Inter Norvia Curitiba"),
    ("norvia_campinas", "Banco Inter - Norvia"),
    ("revesta", "Banco Inter Revesta"),
    ("fabrilux", "Banco Inter - Fabrilux"),
])
def test_resolve_conta_origem_inter_so_a_conta_cadastrada_da_empresa(empresa, nome):
    """Aplicação/resgate do Inter ou conta parecida nunca servem de origem da baixa."""
    contas_mock = [
        {"id": 54, "descricao": "Inter Resgate 24h Fic Firf RI", "situacao": "A"},
        {"id": 56, "descricao": "Banco Inter", "situacao": "A"},
        {"id": 57, "descricao": nome.upper() + " ", "situacao": "A"},
    ]
    client = TinyClient()
    with patch.object(client, "obter_contas_financeiras_v3", return_value=contas_mock):
        assert client.resolve_conta_origem_inter("tok", empresa) == 57
    client = TinyClient()
    with patch.object(client, "obter_contas_financeiras_v3", return_value=contas_mock[:2]):
        assert client.resolve_conta_origem_inter("tok", empresa) is None


def test_resolve_conta_origem_inter_ambigua_nao_escolhe():
    client = TinyClient()
    contas_mock = [
        {"id": 55, "descricao": "Banco Inter - Norvia", "situacao": "A"},
        {"id": 56, "descricao": "Banco Inter - Norvia", "situacao": "I"},
    ]
    with patch.object(client, "obter_contas_financeiras_v3", return_value=contas_mock):
        assert client.resolve_conta_origem_inter("tok", "norvia_campinas") is None


def test_resolve_conta_origem_inter_com_override_config():
    client = TinyClient()
    with patch.object(settings, "TINY_CONTA_ORIGEM_MAP", "norvia_curitiba:999"):
        cid = client.resolve_conta_origem_inter("token_ldn", "norvia_curitiba")
        assert cid == 999



def test_resolve_conta_origem_inter_nao_casa_substring_nem_troca_conta_configurada():
    client = TinyClient()
    contas_mock = [
        {"id": 10, "descricao": "Caixa Interno", "situacao": "A"},
        {"id": 11, "descricao": "Banco Internacional", "situacao": "A"},
        {"id": 55, "descricao": "Banco Inter Revesta", "situacao": "A"},
    ]
    with patch.object(client, "obter_contas_financeiras_v3", return_value=contas_mock):
        assert client.resolve_conta_origem_inter("tok", "revesta") == 55
    client = TinyClient()
    with patch.object(settings, "TINY_CONTA_ORIGEM_MAP", "revesta:Inter Revesta"), \
            patch.object(client, "obter_contas_financeiras_v3", return_value=contas_mock):
        assert client.resolve_conta_origem_inter("tok", "revesta") is None, "nome configurado inexistente: não chuta outra"


def test_resolve_conta_origem_inter_falha_fica_em_cache_no_lote():
    client = TinyClient()
    with patch.object(client, "obter_contas_financeiras_v3", return_value=[]) as listar:
        assert client.resolve_conta_origem_inter("tok", "fabrilux") is None
        assert client.resolve_conta_origem_inter("tok", "fabrilux") is None
    assert listar.call_count == 1


def test_obter_contas_financeiras_v3_percorre_as_paginas():
    client = TinyClient()
    pagina1 = [{"id": i, "descricao": f"Conta {i}", "situacao": "A"} for i in range(100)]
    pagina2 = [{"id": 500, "descricao": "Inter Norvia Curitiba", "situacao": "A"}]
    respostas = [
        MagicMock(status_code=200, json=lambda: {"itens": pagina1, "paginacao": {"limit": 100, "offset": 0, "total": 101}}),
        MagicMock(status_code=200, json=lambda: {"itens": pagina2, "paginacao": {"limit": 100, "offset": 100, "total": 101}}),
    ]
    with patch("requests.get", side_effect=respostas) as get:
        contas = client.obter_contas_financeiras_v3("tok")
    assert len(contas) == 101 and contas[-1]["id"] == 500
    assert [c.kwargs["params"]["offset"] for c in get.call_args_list] == [0, 100]


def test_obter_contas_financeiras_v3_401_nao_repete_nem_quebra():
    client = TinyClient()
    with patch("requests.get", return_value=MagicMock(status_code=401, text="")) as get:
        assert client.obter_contas_financeiras_v3("tok") == []
    assert get.call_count == 1
