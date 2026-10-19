"""Correções de segurança de 2026-10-06: chave interna (AUT-01), autor pelo X-Usuario (AUT-12), tokens 0600 (AUT-05)."""
import os
import stat
import time

import pytest
from fastapi.testclient import TestClient

from app import api as api_module
from app.config import settings
from app.estado import Estado

CHAVE = "m" * 40


@pytest.fixture
def http():
    return TestClient(api_module.app)


@pytest.fixture
def com_chave(monkeypatch):
    monkeypatch.delenv("INTERNAL_AUTH_DISABLED", raising=False)
    monkeypatch.setattr(settings, "INTERNAL_AUTH_DISABLED", False)
    monkeypatch.setenv("AUTOMATIONS_INTERNAL_KEY", CHAVE)


def test_rotas_exigem_chave(http, com_chave):
    assert http.get("/api/v1/fretes/avisos").status_code == 401
    assert http.get("/api/v1/fretes/avisos", headers={"X-Internal-Key": "outra"}).status_code == 401
    assert http.post("/api/v1/fretes/executar").status_code == 401
    assert http.post("/api/v1/dimensoes/validar", json={"produtos": [{"sku": "X"}]}).status_code == 401


def test_rota_com_chave_passa(http, com_chave, estado, monkeypatch):
    monkeypatch.setattr(api_module, "estado", estado)
    assert http.get("/api/v1/fretes/avisos", headers={"X-Internal-Key": CHAVE}).status_code == 200


def test_sem_chave_configurada_503(http, monkeypatch):
    monkeypatch.delenv("INTERNAL_AUTH_DISABLED", raising=False)
    monkeypatch.setattr(settings, "INTERNAL_AUTH_DISABLED", False)
    monkeypatch.delenv("AUTOMATIONS_INTERNAL_KEY", raising=False)
    monkeypatch.setattr(settings, "AUTOMATIONS_INTERNAL_KEY", None)
    assert http.get("/api/v1/fretes/avisos", headers={"X-Internal-Key": CHAVE}).status_code == 503


def test_health_publico_e_minimo(http, com_chave):
    for rota in ("/health", "/api/v1/health"):
        res = http.get(rota)
        assert res.status_code == 200
        assert res.json() == {"status": "ok", "service": "automacoes-marketplace"}


def test_retentar_usa_x_usuario_e_ignora_corpo(http, monkeypatch):
    chamadas = []
    monkeypatch.setattr(api_module.rotina, "retentar", lambda alvos, usuario=None: chamadas.append(usuario))
    http.post(
        "/api/v1/fretes/retentar",
        json={"anuncios": [{"filial": "norvia", "mlb": "MLB1"}], "usuario": "forjado"},
        headers={"X-Usuario": "Jos%C3%A9"},
    )
    for _ in range(100):
        if chamadas:
            break
        time.sleep(0.01)
    assert chamadas == ["José"]


def test_validar_usa_x_usuario(http, monkeypatch):
    recebido = {}

    def validar(itens, usuario):
        recebido["usuario"] = usuario
        return {"gravados": []}

    monkeypatch.setattr(api_module.padronizacao, "validar", validar)
    http.post("/api/v1/dimensoes/validar", json={"produtos": [{"sku": "P1"}], "usuario": "forjado"}, headers={"X-Usuario": "ana"})
    assert recebido["usuario"] == "ana"
    http.post("/api/v1/dimensoes/validar", json={"produtos": [{"sku": "P1"}], "usuario": "bruno"})
    assert recebido["usuario"] == "bruno"


def test_erro_interno_nao_vaza_detalhe(monkeypatch):
    def quebra():
        raise RuntimeError("senha=segredo no DSN")

    monkeypatch.setattr(api_module.estado, "ler", quebra)
    res = TestClient(api_module.app, raise_server_exceptions=False).get("/api/v1/fretes/avisos")
    assert res.status_code == 500
    assert "segredo" not in res.text and res.json()["erro_id"]


def test_tokens_do_ml_gravados_0600(tmp_path):
    est = Estado(tmp_path)
    est.salvar_token("norvia", {"access_token": "x"})
    arquivos = [p for p in tmp_path.iterdir() if "token" in p.name]
    assert arquivos and all(stat.S_IMODE(os.stat(p).st_mode) == 0o600 for p in arquivos)


def test_sec05_documentacao_da_api_desligada(http, com_chave):
    # A dependência global da chave interna não cobria /docs, /redoc e /openapi.json (2026-10-07).
    for rota in ("/docs", "/redoc", "/openapi.json"):
        assert http.get(rota).status_code in (401, 404), rota
        assert http.get(rota, headers={"X-Internal-Key": CHAVE}).status_code == 404, rota
