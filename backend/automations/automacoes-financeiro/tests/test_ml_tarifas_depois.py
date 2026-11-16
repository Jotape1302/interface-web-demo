"""
Tarifas, envios e extras lançados no caixa do Tiny DEPOIS da baixa (06/11/2026): corrige as vendas
baixadas antes do lançamento automático ou em que o lançamento falhou (ex.: HTTP 403 do Tiny).
"""
from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient

from tests.test_ml_caixa_na_baixa import _TinyCaixa
from tests.test_ml_reconciliation import _rotina


def _baixada_sem_tarifas(tmp_path, monkeypatch, tiny):
    r = _rotina(tmp_path, tiny=tiny)
    r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    cons = r.estado.analise("consolidado_norvia_campinas")
    ana = next(g for g in cons.grupos if g.id_venda == "3000000000000001")
    monkeypatch.setattr(r.cfg, "ML_LANCAR_CAIXA_NA_BAIXA", False)
    assert r.baixar(cons.id, [ana.id])["total_sucessos"] == 1
    monkeypatch.setattr(r.cfg, "ML_LANCAR_CAIXA_NA_BAIXA", True)
    assert tiny.caixa == []
    return r, ana


def test_lista_e_lanca_as_tarifas_da_venda_ja_baixada(tmp_path, monkeypatch):
    tiny = _TinyCaixa()
    r, ana = _baixada_sem_tarifas(tmp_path, monkeypatch, tiny)
    pend = r.tarifas_pendentes("norvia_campinas")
    venda = next(v for v in pend["vendas"] if v["id_venda"] == "3000000000000001")
    assert [(l["tipo_operacao"], l["valor"]) for l in venda["linhas"]] == [("Tarifa de venda", 12.5), ("Tarifa de envio", 7.5)]
    assert venda["data_venda"] == "30/08/2025"

    res = r.lancar_tarifas("norvia_campinas", [ana.id], usuario="Fulano")
    assert res["total_lancamentos"] == 2 and res["total_falhas"] == 0
    assert [(c["valor"], c["data"], c["contato_id"]) for c in tiny.caixa] == [
        (Decimal("12.50"), "2025-08-30", 99), (Decimal("7.50"), "2025-08-30", 99)]
    assert not any(v["id_venda"] == "3000000000000001" for v in r.tarifas_pendentes("norvia_campinas")["vendas"])
    # De novo: nada duplica.
    assert r.lancar_tarifas("norvia_campinas", [ana.id])["total_lancamentos"] == 0
    assert len(tiny.caixa) == 2
    assert r.estado.ler()["execucoes"][-1]["tipo"] == "tarifas"


def test_planilha_exportada_so_entra_quando_pedido(tmp_path, monkeypatch):
    tiny = _TinyCaixa()
    r, ana = _baixada_sem_tarifas(tmp_path, monkeypatch, tiny)
    chaves = [l["chave"] for v in r.tarifas_pendentes("norvia_campinas")["vendas"] for l in v["linhas"]]
    r.estado.registrar_exportados(chaves)
    assert r.tarifas_pendentes("norvia_campinas")["vendas"] == []
    com = r.tarifas_pendentes("norvia_campinas", incluir_exportados=True)["vendas"]
    assert com and all(l["na_planilha"] for v in com for l in v["linhas"])
    assert r.lancar_tarifas("norvia_campinas", [ana.id])["total_lancamentos"] == 0
    assert r.lancar_tarifas("norvia_campinas", [ana.id], incluir_exportados=True)["total_lancamentos"] == 2


def test_incerto_nunca_e_relancado(tmp_path, monkeypatch):
    tiny = _TinyCaixa(incerto=True)
    r, ana = _baixada_sem_tarifas(tmp_path, monkeypatch, tiny)
    r.lancar_tarifas("norvia_campinas", [ana.id])
    assert len(tiny.caixa) == 2
    assert r.tarifas_pendentes("norvia_campinas", incluir_exportados=True)["vendas"] == []


def test_venda_nao_baixada_nao_lanca(tmp_path):
    tiny = _TinyCaixa()
    r = _rotina(tmp_path, tiny=tiny)
    r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    cons = r.estado.analise("consolidado_norvia_campinas")
    ana = next(g for g in cons.grupos if g.id_venda == "3000000000000001")
    res = r.lancar_tarifas("norvia_campinas", [ana.id])
    assert res["total_falhas"] == 1 and tiny.caixa == []


def test_endpoints(tmp_path, monkeypatch):
    from unittest.mock import patch

    from app.api import app

    tiny = _TinyCaixa()
    r, ana = _baixada_sem_tarifas(tmp_path, monkeypatch, tiny)
    with patch("app.routers.conciliacao_ml.ml_rotina", r):
        client = TestClient(app)
        resp = client.get("/api/v1/conciliacao-ml/tarifas", params={"empresa": "norvia_campinas"})
        assert resp.status_code == 200 and resp.json()["total_linhas"] == 2
        assert client.get("/api/v1/conciliacao-ml/tarifas", params={"empresa": "x"}).status_code == 404
        assert client.post("/api/v1/conciliacao-ml/jobs/lancar-tarifas",
                           json={"empresa": "norvia_campinas", "grupos": []}).status_code == 400


def _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny):
    """Lançadas antes de 06/11 (histórico próprio, contato = cliente): o registro não tem a empresa."""
    r, ana = _baixada_sem_tarifas(tmp_path, monkeypatch, tiny)
    r.lancar_tarifas("norvia_campinas", [ana.id])
    with r.estado.alterar() as dados:
        for info in dados["lancamentos_tiny"].values():
            info.pop("empresa")
    return r, ana


def test_padrao_antigo_apagado_no_tiny_volta_para_as_pendentes(tmp_path, monkeypatch):
    tiny = _TinyCaixa()
    r, ana = _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny)
    pend = r.tarifas_pendentes("norvia_campinas")
    assert sorted(a["id"] for a in pend["padrao_antigo"]) == [1001, 1002]
    assert not any(v["id_venda"] == "3000000000000001" for v in pend["vendas"])

    tiny.no_caixa = [{"id": 1001, "historico": "x", "valor": 12.5}]  # 1002 apagado no Tiny
    res = r.conferir_apagados("norvia_campinas")
    assert res == {"empresa": "norvia_campinas", "conferidos": 2, "liberados": 1, "ainda_no_tiny": 1, "nao_conferidos": 0}
    pend = r.tarifas_pendentes("norvia_campinas")
    assert [a["id"] for a in pend["padrao_antigo"]] == [1001]
    venda = next(v for v in pend["vendas"] if v["id_venda"] == "3000000000000001")
    assert [(l["tipo_operacao"], l["na_planilha"]) for l in venda["linhas"]] == [("Tarifa de envio", False)]

    tiny.caixa.clear()
    assert r.lancar_tarifas("norvia_campinas", [ana.id])["total_lancamentos"] == 1
    assert [(c["valor"], c["historico"], c["contato_id"]) for c in tiny.caixa] == [
        (Decimal("7.50"), "OC 3000000000000001", 99)]
    # O relançado já é do padrão novo: não aparece mais como antigo.
    assert [a["id"] for a in r.tarifas_pendentes("norvia_campinas")["padrao_antigo"]] == [1001]


def test_caixa_que_nao_deu_para_ler_nao_libera_nada(tmp_path, monkeypatch):
    class _CaixaFora(_TinyCaixa):
        def list_caixa_v3(self, token, **kw):
            raise RuntimeError("HTTP 500")

    tiny = _CaixaFora()
    r, _ = _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny)
    res = r.conferir_apagados("norvia_campinas")
    assert res["liberados"] == 0 and res["nao_conferidos"] == 2
    assert len(r.estado.lancamentos_tiny()) == 2


def test_endpoint_conferir_apagados(tmp_path, monkeypatch):
    from unittest.mock import patch

    from app.api import app

    tiny = _TinyCaixa()
    r, _ = _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny)
    with patch("app.routers.conciliacao_ml.ml_rotina", r):
        client = TestClient(app)
        resp = client.post("/api/v1/conciliacao-ml/tarifas/conferir-apagados", json={"empresa": "norvia_campinas"})
        assert resp.status_code == 200 and resp.json()["liberados"] == 2
        assert client.post("/api/v1/conciliacao-ml/tarifas/conferir-apagados", json={"empresa": "x"}).status_code == 404


def test_refeito_a_mao_sai_da_lista_e_a_conferencia_nao_devolve(tmp_path, monkeypatch):
    """09/11/2026: o financeiro apagou os 10 antigos da Campinas e relançou À MÃO. Marcados, eles não
    podem voltar para as pendentes pela conferência (lançar pela tela duplicaria o caixa)."""
    tiny = _TinyCaixa()
    r, ana = _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny)
    antigos = r.tarifas_pendentes("norvia_campinas")["padrao_antigo"]
    alvo = next(a for a in antigos if a["id"] == 1002)["chave"]

    res = r.marcar_refeitos("norvia_campinas", [alvo, alvo, "chave-que-nao-existe"], usuario="Fulano")
    assert res == {"empresa": "norvia_campinas", "marcados": 1, "ignorados": 1}
    assert r.estado.lancamentos_tiny()[alvo]["refeito_manual"]["por"] == "Fulano"
    assert [a["id"] for a in r.tarifas_pendentes("norvia_campinas")["padrao_antigo"]] == [1001]

    tiny.no_caixa = []  # nenhum dos dois está mais no caixa com o id antigo
    assert r.conferir_apagados("norvia_campinas")["liberados"] == 1  # só o 1001, que não foi marcado
    venda = next(v for v in r.tarifas_pendentes("norvia_campinas")["vendas"] if v["id_venda"] == "3000000000000001")
    assert alvo not in {l["chave"] for l in venda["linhas"]}
    assert alvo in r.estado.lancamentos_tiny()


def test_marcar_refeito_de_outra_empresa_ou_ja_marcado_e_ignorado(tmp_path, monkeypatch):
    tiny = _TinyCaixa()
    r, _ = _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny)
    chaves = [a["chave"] for a in r.tarifas_pendentes("norvia_campinas")["padrao_antigo"]]
    assert r.marcar_refeitos("revesta", chaves)["marcados"] == 0
    assert r.marcar_refeitos("norvia_campinas", chaves)["marcados"] == 2
    assert r.marcar_refeitos("norvia_campinas", chaves) == {"empresa": "norvia_campinas", "marcados": 0, "ignorados": 2}


def test_endpoint_marcar_refeitos(tmp_path, monkeypatch):
    from unittest.mock import patch

    from app.api import app

    tiny = _TinyCaixa()
    r, _ = _lancadas_no_padrao_antigo(tmp_path, monkeypatch, tiny)
    chaves = [a["chave"] for a in r.tarifas_pendentes("norvia_campinas")["padrao_antigo"]]
    with patch("app.routers.conciliacao_ml.ml_rotina", r):
        client = TestClient(app)
        url = "/api/v1/conciliacao-ml/tarifas/marcar-refeitos"
        assert client.post(url, json={"empresa": "norvia_campinas", "chaves": []}).status_code == 400
        assert client.post(url, json={"empresa": "x", "chaves": chaves}).status_code == 404
        resp = client.post(url, json={"empresa": "norvia_campinas", "chaves": chaves, "usuario": "Fulano"})
        assert resp.status_code == 200 and resp.json()["marcados"] == 2
