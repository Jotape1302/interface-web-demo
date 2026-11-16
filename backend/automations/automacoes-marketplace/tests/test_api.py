from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import api as api_module
from app.estado import Estado
from app.padronizacao import Padronizacao, vazio_dimensoes
from app.rotina import Rotina
from tests.conftest import MLFalso, TinyFalso, item, medidas, produto_tiny


@pytest.fixture
def cliente(estado, repo, tmp_path, monkeypatch):
    ml = MLFalso([
        item("MLB1", "Perfil 16x16mm 1m", sku="P1"),
        item("MLB2", "Adesivo Decorativo", modo="not_specified", sku="SEM-MEDIDA"),
        item("MLB3", "Perfil 2m", modo="me1", sku="P2"),
    ])
    tiny = TinyFalso([
        produto_tiny(10, "P1", "Perfil 16x16mm 1m", medidas(1.6, 1.6, 98, 0.4)),
        produto_tiny(11, "SEM-MEDIDA", "Adesivo"),
        produto_tiny(12, "P2", "Perfil 2m", medidas(1.6, 1.6, 200, 0.5)),
    ])
    estado_dim = Estado(tmp_path, arquivo="dimensoes.json", vazio=vazio_dimensoes)
    padronizacao = Padronizacao(
        estado_dim, repo, fabrica_ml=lambda f: ml if f == "norvia" else MLFalso([]),
        fabrica_tiny=lambda c: tiny if c == "norvia_campinas" else TinyFalso([]), pausa=0, estado_fretes=estado, espera_conferencia=0,
    )
    rotina = Rotina(estado, padronizacao.padroes_por_filial, fabrica_cliente=lambda f: ml if f == "norvia" else MLFalso([]), pausa=0)
    monkeypatch.setattr(api_module, "estado", estado)
    monkeypatch.setattr(api_module, "estado_dimensoes", estado_dim)
    monkeypatch.setattr(api_module, "rotina", rotina)
    monkeypatch.setattr(api_module, "padronizacao", padronizacao)
    padronizacao.coletar()
    rotina.executar()
    # Sem o "with": não sobe os agendadores de fundo durante o teste.
    return TestClient(api_module.app), ml, tiny


def test_fretes_status_cards_e_lista(cliente):
    http, _, _ = cliente
    st = http.get("/api/v1/fretes/status").json()
    assert st["total_anuncios"] == 3
    assert st["envios"] == {"me2": 1, "not_specified": 1, "me1": 1}
    assert st["sem_padrao"] == 1 and st["desfeitos"] == 0 and st["aguardando_conferencia"] == 0
    assert st["contagem"].get("tipo_inconsistente") == 1, "2 m em ME1"
    assert datetime.fromisoformat(st["proxima_execucao"]).tzinfo is not None

    bloqueados = http.get("/api/v1/fretes/anuncios", params={"bloqueio": "sem_padrao,sem_sku"}).json()
    assert [a["mlb"] for a in bloqueados["itens"]] == ["MLB2"]
    assert "Tiny" in bloqueados["itens"][0]["bloqueio_texto"]
    assert bloqueados["itens"][0]["situacao"] == "bloqueado"


def test_corrigir_tipo_roda_a_varredura(cliente, monkeypatch):
    http, _, _ = cliente
    chamadas = []
    monkeypatch.setattr(api_module.rotina, "executar", lambda origem="agendada", varredura=False: chamadas.append((origem, varredura)))
    assert http.post("/api/v1/fretes/corrigir-tipo").json() == {"status": "iniciada"}
    assert chamadas == [("varredura", True)]


def test_fretes_desfeitos_e_retentar(cliente, monkeypatch):
    http, _, _ = cliente
    with api_module.estado.alterar() as dados:
        dados["anuncios"]["norvia:MLB1"]["falha_envio"] = {"mensagem": "ML voltou", "em": "2026-09-29T10:40:00-03:00"}
    assert [a["mlb"] for a in http.get("/api/v1/fretes/desfeitos").json()["itens"]] == ["MLB1"]
    chamadas = []
    monkeypatch.setattr(api_module.rotina, "retentar", lambda alvos, usuario=None: chamadas.append((alvos, usuario)))
    assert http.post("/api/v1/fretes/retentar", json={"anuncios": []}).status_code == 422
    assert http.post("/api/v1/fretes/retentar", json={"anuncios": [{"filial": "norvia", "mlb": "MLB1"}]}).json()["total"] == 1


def test_dimensoes_status_lista_e_confirmacao(cliente, monkeypatch):
    http, _, _ = cliente
    st = http.get("/api/v1/dimensoes/status").json()
    assert st["total_produtos"] == 3
    assert st["por_status"] == {"pendente": 2, "sem_medida": 1}
    assert st["anuncios_a_enviar"] == 2
    assert st["produtos_enviados"] == 0, "igual ao Tiny sem envio não conta no ROI"
    assert [(c["filial"], c["id"]) for c in st["contas_tiny"]] == [("norvia", "norvia_campinas"), ("revesta", "revesta")]

    lista = http.get("/api/v1/dimensoes/produtos", params={"status": "sem_medida"}).json()
    assert [p["sku"] for p in lista["itens"]] == ["SEM-MEDIDA"]

    enviados = []
    monkeypatch.setattr(api_module.padronizacao, "enviar", lambda skus: enviados.append(skus))
    r = http.post("/api/v1/dimensoes/validar", json={"skus": ["P1", "SEM-MEDIDA"], "usuario": "Ana"})
    assert r.status_code == 200 and r.json()["aceitos"] == ["P1"] and "SEM-MEDIDA" in r.json()["recusados"][0]
    assert http.post("/api/v1/dimensoes/validar", json={"skus": []}).status_code == 422
    p1 = http.get("/api/v1/dimensoes/produtos", params={"q": "P1"}).json()["itens"][0]
    assert (p1["status"], p1["envio"]["status"]) == ("pendente", "enviando")
    assert enviados == [["P1"]]
    type(api_module.padronizacao).enviar(api_module.padronizacao, ["P1"])  # o real, sem o mock
    assert http.get("/api/v1/dimensoes/status").json()["produtos_enviados"] == 1


def test_avisos_incrementais_para_o_gateway(cliente):
    http, _, _ = cliente
    todos = http.get("/api/v1/fretes/avisos").json()
    assert todos["itens"] and todos["ultimo_id"] == todos["itens"][-1]["id"]
    assert any(a["tipo"] == "dimensoes_pendencias" for a in todos["itens"])
    assert http.get("/api/v1/fretes/avisos", params={"depois_de": todos["ultimo_id"]}).json()["itens"] == []


def test_periodo_em_dimensoes_status_e_fretes_historico(cliente):
    http, _, _ = cliente
    hoje = api_module.agora()[:10]
    # Sem envio nenhum: o período não quebra e conta zero.
    assert http.get("/api/v1/dimensoes/status", params={"de": hoje, "ate": hoje}).json()["produtos_enviados"] == 0
    for params in ({"de": hoje}, {"de": "2026-13-01", "ate": hoje}, {"de": hoje, "ate": "2020-01-01"}):
        assert http.get("/api/v1/dimensoes/status", params=params).status_code == 422
        assert http.get("/api/v1/fretes/historico", params=params).status_code == 422
    assert http.get("/api/v1/fretes/historico", params={"de": "2000-01-01", "ate": "2000-01-02"}).json()["total"] == 0
    # Com um envio ok feito agora: conta no período de hoje e não conta num período antigo.
    type(api_module.padronizacao).enviar(api_module.padronizacao, ["P1"])
    assert http.get("/api/v1/dimensoes/status", params={"de": hoje, "ate": hoje}).json()["produtos_enviados"] == 1
    assert http.get("/api/v1/dimensoes/status", params={"de": "2000-01-01", "ate": "2000-01-02"}).json()["produtos_enviados"] == 0


def test_roi_de_dimensoes_nao_cai_com_nova_coleta_nem_reenvio(cliente):
    http, _, _ = cliente
    est = api_module.estado_dimensoes
    type(api_module.padronizacao).enviar(api_module.padronizacao, ["P1"])
    assert http.get("/api/v1/dimensoes/status").json()["produtos_enviados"] == 1
    primeiro = est.ler()["enviados_ml"]["P1"]["em"]
    # Nova coleta sem o P1 (SKU mudou ou sumiu) e um "reenvio" que muda o envio atual: segue contando,
    # pela data do 1º envio.
    with est.alterar() as dados:
        dados["produtos"].pop("P1")
    with est.alterar() as dados:
        dados["produtos"]["SEM-MEDIDA"]["envio"] = {"status": "enviando", "em": "2026-01-01T00:00:00-03:00"}
    assert http.get("/api/v1/dimensoes/status").json()["produtos_enviados"] == 1
    assert est.ler()["enviados_ml"]["P1"]["em"] == primeiro


def test_envio_antigo_sem_registro_entra_na_proxima_coleta():
    from app.padronizacao import _registrar_enviado, enviados_ml

    dados = {"produtos": {
        "A": {"envio": {"status": "ok", "em": "2026-10-26T10:00:00-03:00"}},
        "B": {"envio": {"status": "erro", "em": "2026-10-26T11:00:00-03:00", "destinos": {"x": {"status": "ok"}, "y": {"status": "erro"}}}},
        "C": {"envio": {"status": "erro", "em": "2026-10-26T12:00:00-03:00", "destinos": {"y": {"status": "erro"}}}},
    }}
    assert enviados_ml(dados) == {"A": "2026-10-26T10:00:00-03:00", "B": "2026-10-26T11:00:00-03:00"}
    _registrar_enviado(dados, "A", "2026-10-27T10:00:00-03:00")
    assert enviados_ml(dados)["A"] == "2026-10-27T10:00:00-03:00"  # o registro vale sobre o envio atual


def test_validar_devolve_o_treino_com_os_candidatos_antes_do_envio(cliente):
    http, _, _ = cliente
    candidatos = [sku for sku, reg in api_module.estado_dimensoes.ler()["produtos"].items()
                  if any(a.get("situacao") == "diferente" for a in reg.get("anuncios", []))]
    res = http.post("/api/v1/dimensoes/validar", json={"skus": ["P1"]}).json()
    treino = res["treino"]
    assert treino["sugestao"]["enviar_medidas_do_tiny"] == candidatos
    assert treino["contexto"]["total_candidatos"] == len(candidatos)
    assert "P1" in treino["contexto"]["produtos"]
