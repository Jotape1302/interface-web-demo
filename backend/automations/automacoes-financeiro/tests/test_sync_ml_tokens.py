"""
Testes unitários para scripts/sync_ml_tokens.py e integração TMS em app/ml_apis.py.
"""
from __future__ import annotations

import json
import stat
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Adiciona a raiz do projeto ao path para importar o script
RAIZ = Path(__file__).resolve().parent.parent.parent.parent.parent
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

from scripts.sync_ml_tokens import (
    extrair_token_auth,
    extrair_token_ml,
    gravar_json_atomico,
    login_tms,
    buscar_token_ml_tms,
    obter_todos_tokens_ml,
    resolver_caminhos_destino,
)
from app.config import Settings
from app.ml_apis import obter_token_ml_tms, token_ml, _TMS_ML_TOKEN_CACHE


class TestExtracaoTokens:
    def test_extrair_token_auth_formatos(self):
        # Direto string
        assert extrair_token_auth("token_abc") == "token_abc"
        # Dict com 'token'
        assert extrair_token_auth({"token": "jwt_123"}) == "jwt_123"
        # Dict com 'access_token'
        assert extrair_token_auth({"access_token": "bearer_456"}) == "bearer_456"
        # Dict aninhado em 'data'
        assert extrair_token_auth({"data": {"token": "sub_jwt"}}) == "sub_jwt"

    def test_extrair_token_ml_formatos(self):
        # Direto string
        assert extrair_token_ml("APP_USR-999") == "APP_USR-999"
        # Dict com 'access_token' e 'refresh_token'
        assert extrair_token_ml({"access_token": "APP_USR-111", "refresh_token": "TG-aaa"}) == "APP_USR-111"
        # Dict com 'token'
        assert extrair_token_ml({"token": "APP_USR-222"}) == "APP_USR-222"
        # Lista com dict
        assert extrair_token_ml([{"token": "APP_USR-333"}]) == "APP_USR-333"


class TestFluxoHttpTms:
    @patch("scripts.sync_ml_tokens.http_request_json")
    def test_login_tms_sucesso(self, mock_http):
        mock_http.return_value = {"token": "jwt_tms_valido"}

        token = login_tms("https://tms.test", "usuario123", "senhaForte")

        assert token == "jwt_tms_valido"
        mock_http.assert_called_once_with(
            "https://tms.test/auth/login",
            method="POST",
            data={"name": "usuario123", "password": "senhaForte"},
            timeout=30,
            insecure=False,
        )

    @patch("scripts.sync_ml_tokens.http_request_json")
    def test_buscar_token_ml_tms(self, mock_http):
        mock_http.return_value = {
            "access_token": "APP_USR-revesta-3",
            "refresh_token": "TG-revesta-ref3",
            "user_id": 123456,
        }

        dados = buscar_token_ml_tms("https://tms.test", "jwt_auth", token_id=3)

        assert dados["access_token"] == "APP_USR-revesta-3"
        assert dados["refresh_token"] == "TG-revesta-ref3"
        assert dados["user_id"] == 123456
        mock_http.assert_called_once_with(
            "https://tms.test/tokens?id=3",
            method="GET",
            headers={"Authorization": "Bearer jwt_auth"},
            timeout=30,
            insecure=False,
        )

    @patch("scripts.sync_ml_tokens.buscar_token_ml_tms")
    @patch("scripts.sync_ml_tokens.login_tms")
    def test_obter_todos_tokens_ml(self, mock_login, mock_buscar):
        mock_login.return_value = "jwt_tms"

        def _side_buscar(base_url, token_auth, token_id, timeout=30, insecure=False):
            if token_id == 3:
                return {"access_token": "APP_USR-revesta-123", "refresh_token": "TG-revesta-ref"}
            if token_id == 4:
                return {"access_token": "APP_USR-campinas-456", "refresh_token": "TG-campinas-ref"}
            return {}

        mock_buscar.side_effect = _side_buscar

        resultado = obter_todos_tokens_ml("https://tms.test", "user", "pass")

        assert resultado["revesta"]["access_token"] == "APP_USR-revesta-123"
        assert resultado["revesta"]["refresh_token"] == "TG-revesta-ref"
        assert resultado["norvia"]["access_token"] == "APP_USR-campinas-456"
        assert resultado["norvia"]["refresh_token"] == "TG-campinas-ref"
        assert "renovado_em" in resultado["revesta"]
        assert "renovado_em" in resultado["norvia"]


class TestGravacaoAtomica:
    def test_gravar_json_atomico_e_permissoes(self, tmp_path):
        destino = tmp_path / "subpasta" / "ml_tokens.json"
        dados = {
            "norvia": {"access_token": "APP_USR-campinas"},
            "revesta": {"access_token": "APP_USR-revesta"},
        }

        gravar_json_atomico(destino, dados)

        assert destino.exists()
        conteudo = json.loads(destino.read_text(encoding="utf-8"))
        assert conteudo == dados

        modo = stat.S_IMODE(destino.stat().st_mode)
        assert modo == 0o640  # sem "outros"; grupo = máscara da ACL do rootless


class TestDestinos:
    def test_padrao_grava_no_marketplace_e_no_financeiro(self, monkeypatch):
        """O cron do host é a única fonte dos tokens das duas automações."""
        monkeypatch.delenv("ML_TOKENS_FILE", raising=False)
        monkeypatch.setattr(Path, "is_dir", lambda self: True)  # data/ não versionado
        destinos = [str(d) for d in resolver_caminhos_destino(None)]
        assert any("automacoes-marketplace/data/ml_tokens.json" in d for d in destinos)
        assert any("automacoes-financeiro/data/ml_tokens.json" in d for d in destinos)

    def test_output_repetido_e_ml_tokens_file(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ML_TOKENS_FILE", str(tmp_path / "env.json"))
        assert resolver_caminhos_destino([str(tmp_path / "a.json"), str(tmp_path / "b.json")]) == [
            tmp_path / "a.json", tmp_path / "b.json"]
        assert resolver_caminhos_destino(None) == [tmp_path / "env.json"]


class TestIntegracaoMlApis:
    def test_obter_token_ml_tms_com_cache(self):
        _TMS_ML_TOKEN_CACHE.clear()

        cfg = Settings(
            TMS_BASE_URL="https://tms.test",
            TMS_USER="user_test",
            TMS_PASSWORD="password_test",
        )

        mock_session = MagicMock()
        # 1. Resposta de login
        resp_login = MagicMock()
        resp_login.status_code = 200
        resp_login.json.return_value = {"token": "jwt_sessao"}

        # 2. Resposta de tokens (id=3 para Revesta)
        resp_token = MagicMock()
        resp_token.status_code = 200
        resp_token.json.return_value = {"access_token": "APP_USR-revesta-online"}

        mock_session.post.return_value = resp_login
        mock_session.get.return_value = resp_token

        # 1ª chamada: busca no TMS
        tok = obter_token_ml_tms("revesta", cfg, http=mock_session)
        assert tok == "APP_USR-revesta-online"
        assert mock_session.post.call_count == 1
        assert mock_session.get.call_count == 1

        # 2ª chamada: deve vir do cache sem novas requisições
        tok_cached = obter_token_ml_tms("revesta", cfg, http=mock_session)
        assert tok_cached == "APP_USR-revesta-online"
        assert mock_session.post.call_count == 1
        assert mock_session.get.call_count == 1

    def test_token_ml_fallback_tms_quando_sem_arquivo(self):
        _TMS_ML_TOKEN_CACHE.clear()

        cfg = Settings(
            ML_TOKENS_FILE=Path("/caminho/inexistente/ml_tokens.json"),
            TMS_BASE_URL="https://tms.test",
            TMS_USER="user_tms",
            TMS_PASSWORD="password_tms",
            ML_NORVIA_ACCESS_TOKEN=None,
            ML_REVESTA_ACCESS_TOKEN=None,
        )

        with patch("app.ml_apis.obter_token_ml_tms") as mock_obter:
            mock_obter.return_value = "APP_USR-campinas-dinamico"

            tok = token_ml("norvia", cfg)
            assert tok == "APP_USR-campinas-dinamico"
            mock_obter.assert_called_once_with("norvia", cfg)

    def test_token_esta_valido(self):
        from datetime import datetime, timedelta, timezone
        from app.ml_apis import token_esta_valido

        agora = datetime.now(timezone.utc)
        # 1. Token recente (1 hora atrás)
        dados_recente = {
            "access_token": "APP_USR-valido",
            "renovado_em": (agora - timedelta(hours=1)).isoformat(),
            "expires_in": 21600,
        }
        assert token_esta_valido(dados_recente) is True

        # 2. Token expirado (7 horas atrás com duração de 6 horas)
        dados_expirado = {
            "access_token": "APP_USR-expirado",
            "renovado_em": (agora - timedelta(hours=7)).isoformat(),
            "expires_in": 21600,
        }
        assert token_esta_valido(dados_expirado) is False

        # 3. Token perto de expirar (dentro da margem de 15 min, ex.: 5h55m atrás)
        dados_quase_expirado = {
            "access_token": "APP_USR-quase",
            "renovado_em": (agora - timedelta(hours=5, minutes=55)).isoformat(),
            "expires_in": 21600,
        }
        assert token_esta_valido(dados_quase_expirado) is False

    def test_token_ml_renova_automaticamente_se_expirado(self, tmp_path):
        from datetime import datetime, timedelta, timezone
        from app.ml_apis import token_ml

        arq = tmp_path / "ml_tokens.json"
        agora = datetime.now(timezone.utc)
        arq.write_text(
            json.dumps({
                "norvia": {
                    "access_token": "APP_USR-velho",
                    "renovado_em": (agora - timedelta(hours=8)).isoformat(),
                    "expires_in": 21600,
                }
            }),
            encoding="utf-8",
        )

        cfg = Settings(ML_TOKENS_FILE=arq)

        with patch("app.ml_apis.renovar_token_ml") as mock_renovar:
            mock_renovar.return_value = "APP_USR-renovado-novo"

            tok = token_ml("norvia", cfg)
            assert tok == "APP_USR-renovado-novo"
            mock_renovar.assert_called_once_with("norvia", cfg, forcar=True)

    def test_token_ml_usa_valido_do_data_dir_mesmo_com_ml_tokens_file_vencido(self, tmp_path):
        """ML_TOKENS_FILE (ex.: arquivo do marketplace) vencido não força renovação se o DATA_DIR tem token válido."""
        from datetime import datetime, timedelta, timezone

        agora = datetime.now(timezone.utc)
        externo = tmp_path / "marketplace" / "ml_tokens.json"
        externo.parent.mkdir()
        externo.write_text(json.dumps({"norvia": {
            "access_token": "APP_USR-vencido", "renovado_em": (agora - timedelta(hours=8)).isoformat(), "expires_in": 21600,
        }}), encoding="utf-8")
        proprio = tmp_path / "dados"
        proprio.mkdir()
        (proprio / "ml_tokens.json").write_text(json.dumps({"norvia": {
            "access_token": "APP_USR-renovado", "renovado_em": agora.isoformat(), "expires_in": 21600,
        }}), encoding="utf-8")

        cfg = Settings(ML_TOKENS_FILE=externo, DATA_DIR=proprio)
        with patch("app.ml_apis.renovar_token_ml") as mock_renovar:
            assert token_ml("norvia", cfg) == "APP_USR-renovado"
            mock_renovar.assert_not_called()

    @pytest.mark.parametrize("url,aceita", [
        ("http://127.0.0.1:8081", True),
        ("http://localhost:8081/tms_api", True),
        ("http://host.docker.internal:8081", True),
        ("http://10.0.0.5:8081", True),
        ("http://192.168.1.20", True),
        ("http://api10.exemplo.com", False),
        ("http://servidor.192.168.exemplo.com", False),
        ("http://8.8.8.8", False),
        ("https://servidor.norvia.example/tms_api", True),
    ])
    def test_urls_tms_http_so_em_host_local(self, url, aceita):
        from app.ml_apis import _urls_candidatas_tms

        assert bool(_urls_candidatas_tms(url)) is aceita

    def test_cliente_ml_auto_recovery_401(self):
        from unittest.mock import MagicMock
        from app.ml_apis import ClienteMercadoLivre

        mock_http = MagicMock()

        # 1ª resposta: 401 Unauthorized
        resp_401 = MagicMock()
        resp_401.status_code = 401
        resp_401.text = '{"message": "invalid_token"}'

        # 2ª resposta: 200 OK após novo token
        resp_200 = MagicMock()
        resp_200.status_code = 200
        resp_200.json.return_value = {"id": 998877}

        mock_http.request.side_effect = [resp_401, resp_200]

        token_atual = "APP_USR-expirado"

        def _obter_token():
            return token_atual

        def _renovar_token():
            nonlocal token_atual
            token_atual = "APP_USR-renovado"
            return token_atual

        cliente = ClienteMercadoLivre(
            conta_ml="norvia",
            obter_token=_obter_token,
            http=mock_http,
            renovar_token=_renovar_token,
        )

        uid = cliente.user_id()
        assert uid == 998877
        assert mock_http.request.call_count == 2
        # Verifica se na 2ª chamada usou o token renovado
        segunda_chamada_headers = mock_http.request.call_args_list[1][1]["headers"]
        assert segunda_chamada_headers["Authorization"] == "Bearer APP_USR-renovado"

    def test_cliente_ml_401_sem_renovacao_lanca_sem_credencial(self):
        from unittest.mock import MagicMock
        from app.ml_apis import ClienteMercadoLivre, SemCredencial

        mock_http = MagicMock()
        resp_401 = MagicMock()
        resp_401.status_code = 401
        resp_401.text = '{"message": "invalid_token"}'
        mock_http.request.return_value = resp_401

        cliente = ClienteMercadoLivre(
            conta_ml="norvia",
            obter_token=lambda: "APP_USR-invalido",
            http=mock_http,
            renovar_token=lambda: None,  # renovação falhou
        )

        with pytest.raises(SemCredencial) as exc_info:
            cliente.user_id()

        assert "token expirado ou inválido (HTTP 401)" in str(exc_info.value)


class TestValidacaoToken:
    def test_validar_token_ml_aceito_recusado_e_sem_rede(self):
        from scripts.sync_ml_tokens import validar_token_ml

        with patch("scripts.sync_ml_tokens.http_request_json", return_value={"id": 1}):
            assert validar_token_ml("APP_USR-ok") is True
        with patch("scripts.sync_ml_tokens.http_request_json", side_effect=RuntimeError("HTTP 401 ao acessar x")):
            assert validar_token_ml("APP_USR-velho") is False
        with patch("scripts.sync_ml_tokens.http_request_json", side_effect=RuntimeError("Erro de conexão ao acessar x")):
            assert validar_token_ml("APP_USR-x") is None

    def test_sincronizar_marca_token_recusado_e_avisa(self, tmp_path, caplog):
        from scripts.sync_ml_tokens import sincronizar_tokens

        tokens = {"revesta": {"access_token": "APP_USR-velho"}, "norvia": {"access_token": "APP_USR-ok"}}
        respostas = {"APP_USR-velho": False, "APP_USR-ok": True}
        destino = tmp_path / "ml_tokens.json"
        with patch("scripts.sync_ml_tokens.obter_todos_tokens_ml", return_value=tokens), patch(
            "scripts.sync_ml_tokens.validar_token_ml", side_effect=lambda t, timeout=15: respostas[t]
        ), caplog.at_level("ERROR"):
            res = sincronizar_tokens("http://127.0.0.1:8081", "u", "s", [destino])

        assert res["revesta"]["valido"] is False and res["norvia"]["valido"] is True
        assert any("TOKEN INVÁLIDO" in r.message and "revesta" in r.message for r in caplog.records)
        assert json.loads(destino.read_text(encoding="utf-8"))["revesta"]["valido"] is False

    def test_sem_validar_nao_chama_o_mercado_livre(self, tmp_path):
        from scripts.sync_ml_tokens import sincronizar_tokens

        with patch("scripts.sync_ml_tokens.obter_todos_tokens_ml", return_value={"norvia": {"access_token": "A"}}), patch(
            "scripts.sync_ml_tokens.validar_token_ml"
        ) as validar:
            sincronizar_tokens("http://127.0.0.1:8081", "u", "s", [tmp_path / "t.json"], validar=False)
        validar.assert_not_called()
