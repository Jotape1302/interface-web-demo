"""Contagem de execuções para o monitor dos agentes Qwen (app/execucoes.py)."""
import asyncio
import json
import logging
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import execucoes


@pytest.fixture(autouse=True)
def _zerar():
    execucoes.fechar()
    yield
    execucoes.fechar()


def _rotas():
    linha = execucoes.fechar()
    return json.loads(linha)["rotas"] if linha else {}


def test_linha_tem_o_mesmo_formato_do_gateway_e_zera():
    execucoes.registrar("rotina X", True)
    linha = execucoes.fechar()
    assert linha.startswith('{"event":"execucoes","janela_s":60,"rotas":{"rotina X":{"ok":1,"erro":0}}')
    assert execucoes.fechar() is None


def test_normaliza_ids_como_o_gateway():
    assert execucoes.normalizar_rota("/api/v1/danfe/123/MLB4567890/0f8fad5b-d9cb-469f-a165-70867728950e") == "/api/v1/danfe/:id/:id/:id"


def test_rotina_conta_erro_por_excecao_ou_log_error_e_marca_o_log(caplog):
    execucoes.instalar()
    log = logging.getLogger("teste.execucoes")
    with execucoes.execucao("rotina A"):
        log.info("tudo certo")
    with execucoes.execucao("rotina A"):
        try:
            raise RuntimeError("falhou")
        except RuntimeError as e:
            log.error("[A] Erro na rotina: %s", e)
    with pytest.raises(ValueError), execucoes.execucao("rotina B"):
        raise ValueError("x")
    log.error("fora de execução")

    assert _rotas() == {"rotina A": {"ok": 1, "erro": 1}, "rotina B": {"ok": 0, "erro": 1}}
    mensagens = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert mensagens == ["[A] Erro na rotina: falhou [execucao=rotina A]", "fora de execução"]


def test_marca_chega_na_thread_do_to_thread(caplog):
    execucoes.instalar()

    async def rodar():
        with execucoes.execucao("rotina T"):
            await asyncio.to_thread(logging.getLogger("teste").error, "na thread")

    asyncio.run(rodar())
    assert _rotas() == {"rotina T": {"ok": 0, "erro": 1}}
    assert caplog.records[-1].getMessage() == "na thread [execucao=rotina T]"


def test_http_conta_por_rota_normalizada_e_5xx_e_erro():
    app = FastAPI()
    execucoes.instalar(app)

    @app.get("/api/v1/x/{item}")
    def x(item: int):
        if item == 500:
            raise HTTPException(status_code=500)
        if item == 404:
            raise HTTPException(status_code=404)
        return {"ok": True}

    @app.get("/api/v1/health")
    def health():
        return {}

    cliente = TestClient(app)
    for item in (1, 2, 404, 500):
        cliente.get(f"/api/v1/x/{item}")
    cliente.get("/api/v1/health")
    assert _rotas() == {"GET /api/v1/x/:id": {"ok": 3, "erro": 1}}


def test_copias_dos_outros_servicos_sao_identicas():
    raiz = Path(__file__).resolve().parents[2]
    if not (raiz / "automacoes-marketplace").is_dir():
        pytest.skip("fora do monorepo (imagem do serviço)")
    original = (raiz / "automacoes-financeiro/app/execucoes.py").read_text(encoding="utf-8")
    for servico in ("automacoes-marketplace", "automacoes-marketing", "contagem-estoque"):
        assert (raiz / servico / "app/execucoes.py").read_text(encoding="utf-8") == original, servico
