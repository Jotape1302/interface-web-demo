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
