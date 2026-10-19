import json

import pytest

from app.dimensoes import Dimensoes
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


def test_gravar_dimensoes_manda_sku_e_descricao_e_peso_em_kg():
    http = HTTPFalso([Resp(204)])
    produto = {
        "id": 7, "sku": "PV83", "descricao": "Cantoneira",
        "dimensoes": {"altura": 1, "diametro": 2, "quantidadeVolumes": 1, "embalagem": {"id": 3, "tipo": 2, "descricao": "Caixa"}},
    }
    _cliente(http).gravar_dimensoes(produto, Dimensoes(1.6, 1.6, 300, 800))
    metodo, url, kw = http.chamadas[0]
    assert (metodo, url) == ("PUT", "http://tiny/produtos/7")
    assert kw["json"] == {
        "sku": "PV83",
        "descricao": "Cantoneira",
        "dimensoes": {
            "diametro": 2, "altura": 1.6, "largura": 1.6, "comprimento": 300,
            "pesoLiquido": 0.8, "pesoBruto": 0.8, "embalagem": {"id": 3, "tipo": 2},
        },
    }


def test_sem_token_e_erro_http_viram_tinyapierror():
    with pytest.raises(TinyAPIError, match="api_tokens"):
        _cliente(HTTPFalso([]), token=None).produto(1)
    with pytest.raises(TinyAPIError, match="HTTP 400"):
        _cliente(HTTPFalso([Resp(400, {"mensagem": "sku obrigatório"})])).produto(1)
