import json

import pytest

from app.tiny_client import ClienteTiny, TinyAPIError


class Resp:
    def __init__(self, status, corpo=None):
        self.status_code = status
        self.text = "" if corpo is None else json.dumps(corpo)
        self.content = self.text.encode()

    def json(self):
        return json.loads(self.text)


class HTTPFalso:
    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.chamadas = []

    def request(self, metodo, url, **kw):
        self.chamadas.append((metodo, url, kw))
        return self.respostas.pop(0)


def _cliente(http, token="tok"):
    return ClienteTiny("revesta", lambda: token, http=http, base_url="http://tiny", pausa=0)


def test_lista_produtos_paginando_so_ativos():
    http = HTTPFalso([
        Resp(200, {"itens": [{"id": i, "sku": f"S{i}"} for i in range(100)], "paginacao": {"total": 101}}),
        Resp(200, {"itens": [{"id": 100, "sku": "S100"}], "paginacao": {"total": 101}}),
    ])
    assert len(list(_cliente(http).produtos())) == 101
    assert http.chamadas[1][2]["params"] == {"situacao": "A", "limit": 100, "offset": 100}
    assert http.chamadas[0][2]["headers"]["Authorization"] == "Bearer tok"


def test_sem_token_e_erro_http_viram_tinyapierror():
    with pytest.raises(TinyAPIError, match="api_tokens"):
        _cliente(HTTPFalso([]), token=None).produto(1)
    with pytest.raises(TinyAPIError, match="HTTP 400"):
        _cliente(HTTPFalso([Resp(400, {"mensagem": "sku obrigatório"})])).produto(1)
