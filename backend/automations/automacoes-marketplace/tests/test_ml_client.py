import json

import pytest

from app.config import settings
from app.dimensoes import Dimensoes
from app.ml_client import ClienteML, ContaNaoConectada, MLAPIError


class Resp:
    def __init__(self, status, corpo):
        self.status_code = status
        self._corpo = corpo
        self.text = corpo if isinstance(corpo, str) else json.dumps(corpo)
        self.content = self.text.encode()

    def json(self):
        return json.loads(self.text)


class HTTPFalso:
    def __init__(self, respostas):
        self.respostas = list(respostas)  # [(metodo, trecho_da_url, Resp)]
        self.chamadas = []

    def request(self, metodo, url, **kw):
        self.chamadas.append((metodo, url, kw))
        for i, (m, trecho, resp) in enumerate(self.respostas):
            if m == metodo and trecho in url:
                del self.respostas[i]
                return resp
        raise AssertionError(f"chamada inesperada: {metodo} {url}")


@pytest.fixture(autouse=True)
def _sem_token_no_env(monkeypatch):
    monkeypatch.setattr(settings, "ML_NORVIA_ACCESS_TOKEN", None)
    monkeypatch.setattr(settings, "ML_REVESTA_ACCESS_TOKEN", None)


def test_usa_o_token_gravado_pelo_fluxo_externo_sem_renovar(estado, monkeypatch):
    monkeypatch.setattr(settings, "ML_NORVIA_ACCESS_TOKEN", "APP-env")
    estado.salvar_token("norvia", {"access_token": "APP-arquivo"})
    http = HTTPFalso([("GET", "/items/MLB1", Resp(200, {"id": "MLB1"}))])
    cliente = ClienteML("norvia", estado, http=http, base_url="http://ml")
    cliente.anuncio("MLB1")
    assert http.chamadas[0][2]["headers"]["Authorization"] == "Bearer APP-arquivo", "o arquivo tem prioridade"

    # O fluxo externo troca o token no arquivo: a próxima chamada já usa o novo.
    estado.salvar_token("norvia", {"access_token": "APP-novo"})
    http.respostas.append(("GET", "/items/MLB1", Resp(200, {"id": "MLB1"})))
    cliente.anuncio("MLB1")
    assert http.chamadas[1][2]["headers"]["Authorization"] == "Bearer APP-novo"
    assert not any("/oauth/token" in c[1] for c in http.chamadas)


def test_token_do_env_quando_nao_ha_arquivo(estado, monkeypatch):
    monkeypatch.setattr(settings, "ML_NORVIA_ACCESS_TOKEN", "APP-env")
    http = HTTPFalso([("GET", "/items/MLB1", Resp(200, {}))])
    ClienteML("norvia", estado, http=http, base_url="http://ml").anuncio("MLB1")
    assert http.chamadas[0][2]["headers"]["Authorization"] == "Bearer APP-env"


def test_conta_sem_token_nao_conectada(estado):
    with pytest.raises(ContaNaoConectada, match="ML_REVESTA_ACCESS_TOKEN"):
        ClienteML("revesta", estado, http=HTTPFalso([]), base_url="http://ml").anuncio("MLB1")


def test_401_desconecta_a_conta_sem_tentar_renovar(estado):
    estado.salvar_token("norvia", {"access_token": "velho", "user_id": 1})
    http = HTTPFalso([("GET", "/items/MLB1", Resp(401, {"message": "invalid token"}))])
    with pytest.raises(ContaNaoConectada, match="401"):
        ClienteML("norvia", estado, http=http, base_url="http://ml").anuncio("MLB1")
    assert len(http.chamadas) == 1


def test_lista_todos_os_anuncios_pelo_scroll(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 77})
    http = HTTPFalso([
        ("GET", "/users/77/items/search", Resp(200, {"results": ["MLB1", "MLB2"], "scroll_id": "s1"})),
        ("GET", "/users/77/items/search", Resp(200, {"results": ["MLB3"], "scroll_id": "s2"})),
        ("GET", "/users/77/items/search", Resp(200, {"results": [], "scroll_id": "s3"})),
    ])
    assert ClienteML("norvia", estado, http=http, base_url="http://ml").ids_dos_anuncios() == ["MLB1", "MLB2", "MLB3"]
    assert http.chamadas[1][2]["params"]["scroll_id"] == "s1"


def test_troca_de_envio_repete_sem_dimensions_quando_o_campo_esta_travado(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    http = HTTPFalso([
        ("PUT", "/items/MLB1", Resp(400, {"message": "x", "cause": [{"code": "field_not_updatable"}]})),
        ("PUT", "/items/MLB1", Resp(200, {"id": "MLB1"})),
    ])
    ClienteML("norvia", estado, http=http, base_url="http://ml").trocar_envio(
        "MLB1", Dimensoes(60, 40, 15, 1000), "me1", {"free_shipping": True, "local_pick_up": False}
    )
    primeiro, segundo = (c[2]["json"]["shipping"] for c in http.chamadas)
    assert primeiro["dimensions"] == "60x40x15,1000" and "dimensions" not in segundo
    assert segundo["logistic_type"] == "default"
    assert segundo["free_shipping"] is True and segundo["local_pick_up"] is False


def test_erro_do_ml_vira_mlapierror_com_a_mensagem(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    http = HTTPFalso([("PUT", "/items/MLB1", Resp(400, {"message": "invalid attribute"}))])
    with pytest.raises(MLAPIError, match="HTTP 400"):
        ClienteML("norvia", estado, http=http, base_url="http://ml").enviar_medidas("MLB1", Dimensoes(1, 2, 3, 4))


def test_medidas_vao_com_o_peso_e_sem_peso_nem_chama_o_ml(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    http = HTTPFalso([("PUT", "/items/MLB1", Resp(200, {"id": "MLB1"}))])
    cliente = ClienteML("norvia", estado, http=http, base_url="http://ml")
    cliente.enviar_medidas("MLB1", Dimensoes(10, 20, 30, 450))
    attrs = {a["id"]: a["value_name"] for a in http.chamadas[0][2]["json"]["attributes"]}
    assert attrs["SELLER_PACKAGE_WEIGHT"] == "450 g"
    with pytest.raises(MLAPIError, match="peso"):
        cliente.enviar_medidas("MLB1", Dimensoes(10, 20, 30))
    assert len(http.chamadas) == 1


def test_anuncio_sem_embalagem_no_lote_e_relido_sozinho(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    pacote = [{"id": "SELLER_PACKAGE_HEIGHT", "value_name": "5 cm"}]
    http = HTTPFalso([
        ("GET", "/items/bulk", Resp(200, [
            {"code": 200, "body": {"id": "MLB1", "attributes": pacote}},
            {"code": 200, "body": {"id": "MLB2", "attributes": [], "shipping": {"dimensions": "84x9x5,1000"}}},
        ])),
        ("GET", "/items/MLB2", Resp(200, {"id": "MLB2", "attributes": pacote, "shipping": {"dimensions": "84x9x5,1000"}})),
    ])
    itens = list(ClienteML("norvia", estado, http=http, base_url="http://ml").anuncios(["MLB1", "MLB2"]))
    assert [i["attributes"] for i in itens] == [pacote, pacote]
    assert [c[1] for c in http.chamadas] == ["http://ml/items/bulk", "http://ml/items/MLB2"], "MLB1 já veio com a embalagem"
    assert http.chamadas[0][2]["params"]["attributes"].startswith("body.id,body.title")
    assert http.chamadas[1][2]["params"] == {"include_attributes": "all"}


def test_medidas_de_envio_do_me1_mantem_o_resto_do_envio_e_campo_travado_nao_e_erro(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    http = HTTPFalso([
        ("PUT", "/items/MLB1", Resp(200, {"id": "MLB1"})),
        ("PUT", "/items/MLB2", Resp(400, {"message": "x", "cause": [{"code": "field_not_updatable"}]})),
    ])
    cliente = ClienteML("norvia", estado, http=http, base_url="http://ml")
    envio = {"mode": "me1", "local_pick_up": True, "free_shipping": False}
    assert cliente.enviar_dimensoes_envio("MLB1", Dimensoes(5, 5, 300, 250), envio) is True
    assert http.chamadas[0][2]["json"] == {"shipping": {"mode": "me1", "dimensions": "5x5x300,250", "local_pick_up": True, "free_shipping": False}}
    assert cliente.enviar_dimensoes_envio("MLB2", Dimensoes(5, 5, 300, 250), envio) is False



def test_lote_recusado_pelo_ml_le_um_a_um_sem_reler_de_novo(estado):
    """06/11: Campinas recebeu 403 ResourceDeprecated na leitura em lote."""
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    deprecado = {"message": "Resource deprecated - client no longer allowed to consume this resource",
                 "error": "ResourceDeprecated", "status": 403}
    http = HTTPFalso([
        ("GET", "/items/bulk", Resp(403, deprecado)),
        ("GET", "/items/MLB1", Resp(200, {"id": "MLB1", "attributes": []})),
        ("GET", "/items/MLB2", Resp(404, {"message": "not found"})),
        ("GET", "/items/MLB3", Resp(200, {"id": "MLB3", "attributes": []})),
    ])
    cliente = ClienteML("norvia", estado, http=http, base_url="http://ml")
    itens = list(cliente.anuncios(["MLB1", "MLB2", "MLB3"]))
    assert [i["id"] for i in itens] == ["MLB1", "MLB3"], "o 404 é pulado, o resto segue"
    assert [c[1] for c in http.chamadas] == [
        "http://ml/items/bulk", "http://ml/items/MLB1", "http://ml/items/MLB2", "http://ml/items/MLB3",
    ], "sem embalagem, mas já lido sozinho: não relê"


def test_lote_que_volta_sem_um_anuncio_le_o_que_faltou(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    pacote = [{"id": "SELLER_PACKAGE_HEIGHT", "value_name": "5 cm"}]
    http = HTTPFalso([
        ("GET", "/items/bulk", Resp(200, [{"code": 200, "body": {"id": "MLB1", "attributes": pacote}},
                                          {"code": 404, "body": {"message": "x"}}])),
        ("GET", "/items/MLB2", Resp(200, {"id": "MLB2", "attributes": pacote})),
    ])
    itens = list(ClienteML("norvia", estado, http=http, base_url="http://ml").anuncios(["MLB1", "MLB2"]))
    assert [i["id"] for i in itens] == ["MLB1", "MLB2"]


def test_lote_com_erro_do_servidor_nao_cai_no_um_a_um(estado, monkeypatch):
    from app import retry
    monkeypatch.setattr(retry, "dormir", lambda s: None)
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    http = HTTPFalso([("GET", "/items/bulk", Resp(503, "fora"))] * 10)
    with pytest.raises(MLAPIError, match="HTTP 503"):
        list(ClienteML("norvia", estado, http=http, base_url="http://ml").anuncios(["MLB1"]))


def test_um_a_um_recusado_derruba_a_verificacao_em_vez_de_dar_ok_com_zero(estado):
    estado.salvar_token("norvia", {"access_token": "t", "user_id": 1})
    http = HTTPFalso([
        ("GET", "/items/bulk", Resp(403, {"error": "ResourceDeprecated"})),
        ("GET", "/items/MLB1", Resp(403, {"error": "forbidden"})),
    ])
    with pytest.raises(MLAPIError, match="HTTP 403"):
        list(ClienteML("norvia", estado, http=http, base_url="http://ml").anuncios(["MLB1", "MLB2"]))
