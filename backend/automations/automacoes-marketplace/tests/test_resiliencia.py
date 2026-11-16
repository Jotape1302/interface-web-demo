"""AUT-05/06/07 e SEC-08: retry com Retry-After, job órfão após reinício, limite de itens, fuso."""
import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import api as api_module
from app import retry
from app.config import FUSO_SP
from app.estado import Estado, ler_data
from app.ml_client import ClienteML, MLAPIError
from app.padronizacao import vazio_dimensoes
from app.tiny_client import ClienteTiny, TinyAPIError


class Resp:
    def __init__(self, status, corpo=None, headers=None):
        self.status_code = status
        self.text = json.dumps(corpo if corpo is not None else {})
        self.content = self.text.encode()
        self.headers = headers or {}

    def json(self):
        return json.loads(self.text)


class HTTPSequencia:
    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.chamadas = []

    def request(self, metodo, url, **kw):
        self.chamadas.append((metodo, url))
        return self.respostas.pop(0)


@pytest.fixture
def sono(monkeypatch):
    esperas = []
    monkeypatch.setattr(retry, "dormir", esperas.append)
    return esperas


def test_429_respeita_retry_after_e_teto_de_60s(sono, estado, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "ML_NORVIA_ACCESS_TOKEN", "t")
    http = HTTPSequencia([Resp(429, headers={"Retry-After": "7"}), Resp(429, headers={"Retry-After": "900"}), Resp(200, {"id": "MLB1"})])
    assert ClienteML("norvia", estado, http=http, base_url="http://ml").anuncio("MLB1") == {"id": "MLB1"}
    assert sono == [7.0, 60.0]


def test_backoff_exponencial_com_jitter_e_ate_4_tentativas(sono):
    http = HTTPSequencia([Resp(429)] * 4)
    with pytest.raises(TinyAPIError):
        ClienteTiny("revesta", lambda: "t", http=http, base_url="http://tiny", pausa=0)._chamar("GET", "/x", "ler")
    assert len(http.chamadas) == 4 and len(sono) == 3
    assert 2 <= sono[0] < 3 and 4 <= sono[1] < 5 and 8 <= sono[2] < 9


def test_5xx_repete_leitura_mas_nao_escrita(sono, estado, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "ML_NORVIA_ACCESS_TOKEN", "t")
    leitura = HTTPSequencia([Resp(503), Resp(200, {"ok": 1})])
    assert ClienteML("norvia", estado, http=leitura, base_url="http://ml")._chamar("GET", "/x", "ler") == {"ok": 1}
    escrita = HTTPSequencia([Resp(503), Resp(200, {})])
    with pytest.raises(MLAPIError):
        ClienteML("norvia", estado, http=escrita, base_url="http://ml")._chamar("PUT", "/x", "gravar", json={})
    assert len(escrita.chamadas) == 1, "PUT em 5xx não é repetido"
    # 429 em escrita é repetido: o pedido não foi processado.
    http429 = HTTPSequencia([Resp(429, headers={"Retry-After": "1"}), Resp(200, {})])
    ClienteML("norvia", estado, http=http429, base_url="http://ml")._chamar("PUT", "/x", "gravar", json={})
    assert len(http429.chamadas) == 2


def test_datas_de_negocio_em_sao_paulo():
    assert api_module.proxima(8, datetime(2026, 10, 27, 7, 0, tzinfo=FUSO_SP)).hour == 8
    assert ler_data("2026-10-27T10:00:00").utcoffset().total_seconds() == -3 * 3600


@pytest.fixture
def api(estado, tmp_path, monkeypatch):
    est_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    monkeypatch.setattr(api_module, "estado", estado)
    monkeypatch.setattr(api_module, "estado_dimensoes", est_dim)
    return TestClient(api_module.app), estado, est_dim


def test_job_orfao_apos_reinicio_e_zerado_e_registrado(api):
    _, estado_f, est_dim = api
    with est_dim.alterar() as d:
        d["em_execucao"] = "2026-10-27T01:00:00-03:00"
        d["progresso"] = {"etapa": "x"}
        d["produtos"]["P1"] = {"sku": "P1", "envio": {"status": "enviando", "destinos": {}}}
    with estado_f.alterar() as d:
        d["execucao_em_andamento"] = "2026-10-27T02:00:00-03:00"
    api_module.recuperar_orfaos()
    d = est_dim.ler()
    assert d["em_execucao"] is None and d["progresso"] is None
    assert d["execucoes"][-1]["status"] == "interrompida"
    assert d["produtos"]["P1"]["envio"]["status"] == "erro"
    assert "reinício" in d["produtos"]["P1"]["envio"]["destinos"]["interrompido"]["mensagem"]
    f = estado_f.ler()
    assert f["execucao_em_andamento"] is None
    assert f["execucoes"][-1]["status"] == "interrompida" and f["avisos"]


def test_excecao_do_job_em_segundo_plano_e_logada(caplog):
    import asyncio

    def quebra():
        raise ValueError("boom")

    async def rodar():
        fut = api_module.disparar("TESTE", quebra)
        with pytest.raises(ValueError):
            await fut
        await asyncio.sleep(0)

    with caplog.at_level("ERROR"):
        asyncio.run(rodar())
    assert any("Job em segundo plano falhou" in r.message and "boom" in r.message for r in caplog.records)
    assert not api_module._jobs


def test_limite_de_200_itens_nos_corpos(api):
    http, _, _ = api
    assert http.post("/api/v1/dimensoes/validar", json={"skus": [f"S{i}" for i in range(201)]}).status_code == 422
    anuncios = [{"filial": "norvia", "mlb": f"MLB{i}"} for i in range(201)]
    assert http.post("/api/v1/fretes/retentar", json={"anuncios": anuncios}).status_code == 422
    assert http.post("/api/v1/dimensoes/validar", json={"skus": ["X"]}).status_code == 200
