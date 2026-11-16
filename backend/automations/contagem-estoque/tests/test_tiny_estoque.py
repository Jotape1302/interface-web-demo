from typing import Any, Dict, List, Optional

import pytest
import requests
from fastapi.testclient import TestClient

from app import api as api_mod
from app.config import TinySettings
from app.tiny_estoque import (
    CONTA_TINY, ClienteTinyEstoque, EstoqueTinyErro, TinyAPIError, ajustar_contagem, consultar_produto, escolher_deposito,
    token_da_revesta,
)


CRIADO = "2026-10-14T11:25:53-03:00"


class Resp:
    def __init__(self, status: int, corpo: Any = None) -> None:
        self.status_code = status
        self._corpo = corpo
        self.content = b"x" if corpo is not None else b""
        self.text = str(corpo)

    def json(self) -> Any:
        return self._corpo


class TinyFalso:
    """Tiny em memória: um produto, depósitos com saldo, POST de entrada soma no saldo."""

    def __init__(self, saldo: float, depositos: Optional[List[Dict[str, Any]]] = None, falhar_post: bool = False) -> None:
        self.depositos = depositos or [{"id": 7, "nome": "Geral", "desconsiderar": False, "saldo": saldo}]
        self.posts: List[Dict[str, Any]] = []
        self.falhar_post = falhar_post

    def request(self, metodo: str, url: str, headers=None, timeout=None, params=None, json=None):
        if metodo == "GET" and url.endswith("/produtos"):
            return Resp(200, {"itens": [
                {"id": 99, "sku": "ABC-10", "descricao": "Produto"},
                {"id": 98, "sku": "ABC-100", "descricao": "Outro"},
            ]})
        if metodo == "GET" and url.endswith("/produtos/99"):
            return Resp(200, {"id": 99, "sku": "ABC-10", "precos": {"preco": 50, "precoCusto": 12.5, "precoCustoMedio": 11.75}})
        if metodo == "GET" and url.endswith("/estoque/99"):
            return Resp(200, {"id": 99, "saldo": sum(d["saldo"] for d in self.depositos), "depositos": self.depositos})
        if metodo == "POST" and url.endswith("/estoque/99"):
            self.posts.append(json)
            for d in self.depositos:
                if d["id"] == json["deposito"]["id"]:
                    d["saldo"] += json["quantidade"]
            if self.falhar_post:
                raise requests.Timeout("sem resposta")
            return Resp(200, {"idLancamento": 555})
        return Resp(404, {"mensagem": "não achou"})


def cliente(tiny: TinyFalso, deposito: Optional[int] = None) -> ClienteTinyEstoque:
    cfg = TinySettings(TINY_PAUSA_S=0, CONTAGEM_TINY_DEPOSITO_ID=deposito, _env_file=None)
    return ClienteTinyEstoque(lambda: "tok", cfg, http=tiny)


def test_entra_so_a_diferenca_quando_tiny_tem_menos():
    tiny = TinyFalso(saldo=10)
    res = ajustar_contagem(cliente(tiny), "ABC-10", 50, "abcdef123456", 1, CRIADO, "joao")
    assert res["status"] == "lancado"
    assert res["entrada"] == 40 and res["saldo_anterior"] == 10 and res["id_lancamento"] == 555
    assert len(tiny.posts) == 1
    post = tiny.posts[0]
    assert post["tipo"] == "E" and post["quantidade"] == 40 and post["deposito"] == {"id": 7}
    # O Tiny exige precoUnitario: vai o custo médio (a entrada não mexe no custo).
    assert post["precoUnitario"] == 11.75
    # Número e data da contagem no painel abrem a observação (para achar o lançamento no Tiny).
    assert post["observacoes"].startswith("Auditoria 14/10/2026 lançamento 000001 - Divergência na contagem do SKU ABC-10:")
    assert "contado 50, saldo no Tiny 10, entrada de 40 (registro abcdef123456, joao)" in post["observacoes"]
    assert res["auditoria"] == "000001"


def test_nunca_tira_estoque_quando_tiny_tem_mais_ou_igual():
    for saldo in (50, 80):
        tiny = TinyFalso(saldo=saldo)
        res = ajustar_contagem(cliente(tiny), "ABC-10", 50, "abcdef123456", 1, CRIADO)
        assert res["status"] == "sem_entrada" and res["entrada"] == 0
        assert tiny.posts == []


def test_reenviar_a_mesma_contagem_nao_duplica():
    tiny = TinyFalso(saldo=10)
    c = cliente(tiny)
    ajustar_contagem(c, "ABC-10", 50, "abcdef123456", 1, CRIADO)
    res = ajustar_contagem(c, "ABC-10", 50, "abcdef123456", 1, CRIADO)
    assert res["status"] == "sem_entrada"
    assert len(tiny.posts) == 1


def test_sku_exato_e_sku_inexistente():
    # "ABC-10" não pode casar com "ABC-100" (a busca do Tiny é por trecho).
    with pytest.raises(EstoqueTinyErro, match="não encontrado"):
        ajustar_contagem(cliente(TinyFalso(saldo=0)), "ABC-1", 5, "abcdef123456", 1, CRIADO)


def test_deposito_ambiguo_nao_lanca_e_configurado_escolhe():
    deps = [
        {"id": 7, "nome": "Geral", "desconsiderar": False, "saldo": 0},
        {"id": 8, "nome": "Loja", "desconsiderar": False, "saldo": 3},
        {"id": 9, "nome": "Avariados", "desconsiderar": True, "saldo": 1},
    ]
    with pytest.raises(EstoqueTinyErro, match="CONTAGEM_TINY_DEPOSITO_ID"):
        escolher_deposito({"depositos": deps}, None)
    tiny = TinyFalso(saldo=0, depositos=[dict(d) for d in deps])
    res = ajustar_contagem(cliente(tiny, deposito=8), "ABC-10", 10, "abcdef123456", 1, CRIADO)
    assert res["saldo_anterior"] == 3 and res["entrada"] == 7
    assert tiny.posts[0]["deposito"] == {"id": 8}
    assert escolher_deposito({"depositos": deps[:1] + deps[2:]}, None)["id"] == 7


def test_timeout_no_post_rele_o_saldo_em_vez_de_repetir():
    tiny = TinyFalso(saldo=10, falhar_post=True)
    res = ajustar_contagem(cliente(tiny), "ABC-10", 50, "abcdef123456", 1, CRIADO)
    assert res["status"] == "lancado" and res["entrada"] == 40
    assert len(tiny.posts) == 1


def test_sem_token_da_erro_claro():
    cfg = TinySettings(TINY_PAUSA_S=0, _env_file=None)
    with pytest.raises(TinyAPIError, match="api_tokens"):
        ajustar_contagem(ClienteTinyEstoque(lambda: None, cfg, http=TinyFalso(0)), "ABC-10", 1, "abcdef123456", 1, CRIADO)


def test_api_exige_chave_e_ajusta(monkeypatch):
    monkeypatch.setenv("AUTOMATIONS_INTERNAL_KEY", "k" * 40)
    monkeypatch.delenv("INTERNAL_AUTH_DISABLED", raising=False)
    tiny = TinyFalso(saldo=10)
    monkeypatch.setattr(api_mod, "_cliente", cliente(tiny))
    http = TestClient(api_mod.app)
    corpo = {"registro_id": "abcdef123456", "sku": "abc-10", "quantidade": 50, "numero": 42, "criado_em": CRIADO}

    assert http.get("/api/v1/health").status_code == 200
    assert http.post("/api/v1/estoque/ajustar", json=corpo).status_code == 401

    res = http.post("/api/v1/estoque/ajustar", json=corpo, headers={"X-Internal-Key": "k" * 40, "X-Usuario": "Jo%C3%A3o"})
    assert res.status_code == 200, res.text
    assert res.json()["entrada"] == 40
    assert tiny.posts[0]["observacoes"].startswith("Auditoria 14/10/2026 lançamento 000042 - ")
    assert tiny.posts[0]["observacoes"].endswith(", João)")
    sem_numero = {k: v for k, v in corpo.items() if k != "numero"}
    assert http.post("/api/v1/estoque/ajustar", json=sem_numero, headers={"X-Internal-Key": "k" * 40}).status_code == 422

    res = http.post(
        "/api/v1/estoque/ajustar", json={**corpo, "sku": "XYZ"}, headers={"X-Internal-Key": "k" * 40}
    )
    assert res.status_code == 409 and "não encontrado" in res.json()["detail"]


def test_conta_fixa_na_revesta_e_cnpj_de_outra_filial_bloqueia():
    assert CONTA_TINY == "revesta"
    assert "CONTAGEM_TINY_CONTA" not in TinySettings.model_fields
    linha = {"access_token": "tok", "conta_identificador": "revesta", "empresa_cnpj": "36.592.814/0001-00"}
    assert token_da_revesta(linha) == "tok"
    assert token_da_revesta({**linha, "empresa_cnpj": None}) == "tok"
    assert token_da_revesta(None) is None
    # CNPJ da Norvia Campinas na linha: nunca usa.
    with pytest.raises(TinyAPIError, match="bloqueado"):
        token_da_revesta({**linha, "empresa_cnpj": "27184930000107"})
    with pytest.raises(TinyAPIError, match="bloqueado"):
        token_da_revesta({**linha, "conta_identificador": "norvia_campinas"})


def test_consulta_mostra_nome_e_saldo_sem_lancar(monkeypatch):
    tiny = TinyFalso(saldo=12)
    res = consultar_produto(cliente(tiny), "ABC-10")
    assert res["produto"] == "Produto" and res["saldo"] == 12 and res["deposito"] == "Geral" and res["aviso"] is None
    assert tiny.posts == []

    deps = [{"id": 7, "nome": "A", "saldo": 1}, {"id": 8, "nome": "B", "saldo": 2}]
    ambiguo = consultar_produto(cliente(TinyFalso(saldo=0, depositos=deps)), "ABC-10")
    assert ambiguo["produto"] == "Produto" and ambiguo["saldo"] is None and "CONTAGEM_TINY_DEPOSITO_ID" in ambiguo["aviso"]

    monkeypatch.setenv("AUTOMATIONS_INTERNAL_KEY", "k" * 40)
    monkeypatch.setattr(api_mod, "_cliente", cliente(TinyFalso(saldo=3)))
    http = TestClient(api_mod.app)
    assert http.get("/api/v1/estoque/consultar", params={"sku": "abc-10"}).status_code == 401
    r = http.get("/api/v1/estoque/consultar", params={"sku": "abc-10"}, headers={"X-Internal-Key": "k" * 40})
    assert r.status_code == 200 and r.json()["saldo"] == 3


def test_erro_de_validacao_do_tiny_fica_legivel():
    class Tiny400(TinyFalso):
        def request(self, metodo, url, **kw):
            if metodo == "POST":
                return Resp(400, {"mensagem": "Ocorreram erros de validação", "detalhes": [{"campo": "precoUnitario", "mensagem": "Este valor não deve ser vazio"}]})
            return super().request(metodo, url, **kw)

    with pytest.raises(TinyAPIError) as e:
        ajustar_contagem(cliente(Tiny400(saldo=0)), "ABC-10", 5, "abcdef123456", 1, CRIADO)
    assert "HTTP 400" in str(e.value)
    assert "Ocorreram erros de validação (precoUnitario: Este valor não deve ser vazio)" in str(e.value)


# --- EST-01..05 ---------------------------------------------------------------------------------

from decimal import Decimal  # noqa: E402
import threading  # noqa: E402

from app import tiny_estoque as te  # noqa: E402
from app.tiny_estoque import HistoricoLancamentos, exigir_processo_unico  # noqa: E402


@pytest.fixture(autouse=True)
def _sem_espera_e_sem_historico_em_disco(monkeypatch, tmp_path):
    monkeypatch.setattr(te, "_dormir", lambda s: None)
    monkeypatch.setattr(api_mod, "_historico", HistoricoLancamentos(tmp_path))


class Tiny5xxNoPost(TinyFalso):
    """POST devolve 503; `entrou` diz se o Tiny processou a entrada antes de falhar."""

    def __init__(self, saldo: float, entrou: bool) -> None:
        super().__init__(saldo)
        self.entrou = entrou

    def request(self, metodo, url, **kw):
        if metodo == "POST":
            self.posts.append(kw["json"])
            if self.entrou:
                self.depositos[0]["saldo"] += kw["json"]["quantidade"]
            return Resp(503, {"mensagem": "indisponível"})
        return super().request(metodo, url, **kw)


def test_5xx_na_entrada_rele_saldo_e_considera_lancada_se_entrou():
    tiny = Tiny5xxNoPost(saldo=10, entrou=True)
    res = ajustar_contagem(cliente(tiny), "ABC-10", 50, "abcdef123456", 1, CRIADO)
    assert res["status"] == "lancado" and res["entrada"] == 40
    assert len(tiny.posts) == 1, "POST não repetido"


def test_5xx_na_entrada_e_falha_se_o_saldo_nao_mudou():
    tiny = Tiny5xxNoPost(saldo=10, entrou=False)
    with pytest.raises(TinyAPIError, match="envie de novo"):
        ajustar_contagem(cliente(tiny), "ABC-10", 50, "abcdef123456", 1, CRIADO)
    assert len(tiny.posts) == 1


def test_4xx_na_entrada_nao_rele_saldo():
    class Tiny400(TinyFalso):
        def request(self, metodo, url, **kw):
            if metodo == "POST":
                return Resp(400, {"mensagem": "inválido"})
            return super().request(metodo, url, **kw)

    with pytest.raises(TinyAPIError, match="HTTP 400"):
        ajustar_contagem(cliente(Tiny400(saldo=0)), "ABC-10", 5, "abcdef123456", 1, CRIADO)


def test_get_repete_em_429_e_5xx_com_retry_after_e_post_nao(monkeypatch):
    esperas = []

    class TinyInstavel(TinyFalso):
        def __init__(self):
            super().__init__(saldo=3)
            self.respostas = [Resp(429), Resp(503)]
            self.respostas[0].headers = {"Retry-After": "900"}

        def request(self, metodo, url, **kw):
            if metodo == "GET" and url.endswith("/produtos") and self.respostas:
                return self.respostas.pop(0)
            return super().request(metodo, url, **kw)

    monkeypatch.setattr(te, "_dormir", esperas.append)
    res = consultar_produto(cliente(TinyInstavel()), "ABC-10")
    assert res["saldo"] == 3
    assert esperas[0] == 60.0 and 4 <= esperas[1] < 5


def test_quantidade_e_preco_sem_perda():
    assert te._numero_json(Decimal("40"), 4) == 40 and isinstance(te._numero_json(Decimal("40.000"), 4), int)
    assert te._numero_json(Decimal("2.5"), 4) == 2.5
    assert te._numero_json(Decimal("11.75"), 4) == 11.75
    assert te._numero_json(Decimal("0.1"), 4) == 0.1
    assert te._numero_json(Decimal("12.34567"), 4) == 12.3457
    with pytest.raises(EstoqueTinyErro, match="precisão"):
        te._numero_json(Decimal("12345678901234.5678"), 4)


def test_mesmo_registro_nao_lanca_duas_vezes(tmp_path):
    hist = HistoricoLancamentos(tmp_path)
    tiny = TinyFalso(saldo=10)
    c = cliente(tiny)
    a = ajustar_contagem(c, "ABC-10", 50, "abcdef123456", 1, CRIADO, historico=hist)
    # O saldo no Tiny voltou a cair depois: o mesmo registro ainda assim não lança de novo.
    tiny.depositos[0]["saldo"] = 10
    b = ajustar_contagem(c, "ABC-10", 50, "abcdef123456", 1, CRIADO, historico=hist)
    assert a["status"] == "lancado" and b["repetido"] is True and b["entrada"] == 40
    assert len(tiny.posts) == 1
    # Outro registro lança normalmente.
    ajustar_contagem(c, "ABC-10", 50, "fedcba654321", 2, CRIADO, historico=hist)
    assert len(tiny.posts) == 2


def test_duas_contagens_concorrentes_do_mesmo_sku_lancam_uma_vez(tmp_path):
    hist = HistoricoLancamentos(tmp_path)

    class TinyLento(TinyFalso):
        def request(self, metodo, url, **kw):
            if metodo == "GET" and url.endswith("/estoque/99"):
                threading.Event().wait(0.05)  # abre a janela entre ler o saldo e lançar
            return super().request(metodo, url, **kw)

    tiny = TinyLento(saldo=10)
    c = cliente(tiny)
    resultados = []

    def rodar(rid, numero):
        resultados.append(ajustar_contagem(c, "ABC-10", 50, rid, numero, CRIADO, historico=hist))

    ts = [threading.Thread(target=rodar, args=(rid, n)) for n, rid in enumerate(["aaaaaaaaaaaa", "bbbbbbbbbbbb"], 1)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(tiny.posts) == 1, "a segunda leu o saldo já com a entrada da primeira"
    assert sorted(r["status"] for r in resultados) == ["lancado", "sem_entrada"]
    assert tiny.depositos[0]["saldo"] == 50


def test_recusa_subir_com_mais_de_um_worker():
    exigir_processo_unico({})
    exigir_processo_unico({"WEB_CONCURRENCY": "1"})
    with pytest.raises(RuntimeError, match="1 processo"):
        exigir_processo_unico({"WEB_CONCURRENCY": "4"})
    with pytest.raises(RuntimeError):
        exigir_processo_unico({"UVICORN_WORKERS": "2"})


def test_data_da_auditoria_em_sao_paulo():
    from app.auditoria import cabecalho

    assert "27/10/2026" in cabecalho(1, "2026-10-28T01:30:00+00:00")  # 22:30 de 27/10 em SP
