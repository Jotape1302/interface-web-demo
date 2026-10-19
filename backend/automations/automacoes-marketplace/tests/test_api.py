from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import api as api_module
from app.estado import Estado
from app.padronizacao import Padronizacao, vazio_dimensoes
from app.rotina import Rotina
from tests.conftest import MLFalso, TinyFalso, gravar_padrao, item, produto_tiny


@pytest.fixture
def cliente(estado, repo, tmp_path, monkeypatch):
    gravar_padrao(repo, "P1", 1.6, 1.6, 98, peso=400)
    ml = MLFalso([
        item("MLB1", "Perfil 16x16mm 1m", sku="P1"),
        item("MLB2", "Adesivo Decorativo", modo="not_specified", sku="SEM-PADRAO"),
    ])
    tiny = TinyFalso([produto_tiny(10, "P1", "Perfil 16x16mm 1m"), produto_tiny(11, "SEM-PADRAO", "Adesivo 60x40x1cm")])
    rotina = Rotina(estado, repo, fabrica_cliente=lambda f: ml if f == "norvia" else MLFalso([]), pausa=0)
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    padronizacao = Padronizacao(
        estado_dim, repo, fabrica_ml=lambda f: ml if f == "norvia" else MLFalso([]),
        fabrica_tiny=lambda c: tiny if c == "revesta" else TinyFalso([]), pausa=0, estado_fretes=estado,
    )
    monkeypatch.setattr(api_module, "estado", estado)
    monkeypatch.setattr(api_module, "estado_dimensoes", estado_dim)
    monkeypatch.setattr(api_module, "rotina", rotina)
    monkeypatch.setattr(api_module, "padronizacao", padronizacao)
    rotina.executar()
    padronizacao.coletar()
    # Sem o "with": não sobe os agendadores de fundo durante o teste.
    return TestClient(api_module.app), ml, tiny


def test_fretes_status_cards_e_lista(cliente):
    http, _, _ = cliente
    st = http.get("/api/v1/fretes/status").json()
    assert st["total_anuncios"] == 2
    assert st["envios"] == {"me2": 1, "not_specified": 1}
    assert st["sem_padrao"] == 1 and st["desfeitos"] == 0 and st["aguardando_conferencia"] == 0
    assert datetime.fromisoformat(st["proxima_execucao"]).tzinfo is not None

    bloqueados = http.get("/api/v1/fretes/anuncios", params={"bloqueio": "sem_padrao,sem_sku"}).json()
    assert [a["mlb"] for a in bloqueados["itens"]] == ["MLB2"]
    assert "Padronização de dimensões" in bloqueados["itens"][0]["bloqueio_texto"]
    assert bloqueados["itens"][0]["situacao"] == "bloqueado"


def test_fretes_desfeitos_e_retentar(cliente, monkeypatch):
    http, _, _ = cliente
    with api_module.estado.alterar() as dados:
        dados["anuncios"]["norvia:MLB1"]["falha_envio"] = {"mensagem": "ML voltou", "em": "2026-09-29T10:40:00-03:00"}
    assert [a["mlb"] for a in http.get("/api/v1/fretes/desfeitos").json()["itens"]] == ["MLB1"]
    chamadas = []
    monkeypatch.setattr(api_module.rotina, "retentar", lambda alvos, usuario=None: chamadas.append((alvos, usuario)))
    assert http.post("/api/v1/fretes/retentar", json={"anuncios": []}).status_code == 422
    assert http.post("/api/v1/fretes/retentar", json={"anuncios": [{"filial": "norvia", "mlb": "MLB1"}]}).json()["total"] == 1


def test_dimensoes_status_lista_e_validacao(cliente, repo, monkeypatch):
    http, _, tiny = cliente
    st = http.get("/api/v1/dimensoes/status").json()
    assert st["total_produtos"] == 2
    assert st["por_status"] == {"padronizado": 1, "pendente": 1}, "P1 já está em dimensoes_produtos"
    assert [c["id"] for c in st["contas_tiny"]] == ["norvia_campinas", "revesta"]

    lista = http.get("/api/v1/dimensoes/produtos", params={"status": "pendente,divergente"}).json()
    assert [p["sku"] for p in lista["itens"]] == ["SEM-PADRAO"]
    prod = next(p for p in lista["itens"] if p["sku"] == "SEM-PADRAO")
    assert any(f["fonte"] == "tiny_titulo" and f["dims"]["comprimento"] == 1 for f in prod["fontes"])

    enviados = []
    monkeypatch.setattr(api_module.padronizacao, "enviar", lambda skus: enviados.append(skus))
    r = http.post(
        "/api/v1/dimensoes/validar",
        json={"produtos": [{"sku": "SEM-PADRAO", "altura": 60, "largura": 40, "comprimento": 1, "peso": 900}], "usuario": "Ana"},
    )
    assert r.status_code == 200 and r.json()["gravados"] == ["SEM-PADRAO"]
    assert repo.obter("SEM-PADRAO")["comprimento_cm"] == 60
    assert http.post("/api/v1/dimensoes/validar", json={"produtos": []}).status_code == 422
    validado = http.get("/api/v1/dimensoes/produtos", params={"q": "SEM-PADRAO"}).json()["itens"][0]
    assert (validado["status"], validado["envio"]["status"]) == ("padronizado", "enviando")
    assert enviados == [["SEM-PADRAO"]]


def test_avisos_incrementais_para_o_gateway(cliente):
    http, _, _ = cliente
    todos = http.get("/api/v1/fretes/avisos").json()
    assert todos["itens"] and todos["ultimo_id"] == todos["itens"][-1]["id"]
    assert any(a["tipo"] == "dimensoes_pendencias" for a in todos["itens"])
    assert http.get("/api/v1/fretes/avisos", params={"depois_de": todos["ultimo_id"]}).json()["itens"] == []
