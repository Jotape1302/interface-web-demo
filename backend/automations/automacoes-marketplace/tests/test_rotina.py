from datetime import datetime, timedelta

from app.config import FUSO_SP
from app.rotina import Rotina
from tests.conftest import MLFalso, item, padroes


def _rotina(estado, medidas_tiny, contas):
    """medidas_tiny: {filial: {sku: (a, l, c, peso_g)}}; contas: {filial: MLFalso}."""
    return Rotina(estado, padroes(medidas_tiny), fabrica_cliente=lambda f: contas.setdefault(f, MLFalso([])), pausa=0)


def _vencer_conferencias(estado):
    with estado.alterar() as dados:
        for t in dados["trocas"]:
            if t["status"] == "aguardando":
                # Com fuso: datetime.now() sem fuso é lido como horário de SP e no CI (UTC) ficaria 3 h no futuro.
                t["verificar_em"] = (datetime.now(FUSO_SP) - timedelta(seconds=1)).isoformat(timespec="seconds")


def test_a_combinar_recebe_a_embalagem_com_o_peso_bruto_e_o_envio_e_confere_depois(estado):
    ml = MLFalso([item("MLB1", "Perfil 16x16mm 1m", modo="not_specified", sku="PV83")])
    rotina = _rotina(estado, {"norvia": {"PV83": (1.6, 1.6, 98, 400)}}, {"norvia": ml})
    rotina.executar()

    assert ml.medidas_enviadas == [("MLB1", (1.6, 1.6, 98), 400)]
    assert ml.trocas[-1][:2] == ("MLB1", "me2")
    assert estado.ler()["trocas"][-1]["status"] == "aguardando"

    _vencer_conferencias(estado)
    assert rotina.conferir_vencidas() == 1
    assert estado.ler()["trocas"][-1]["status"] == "ok"


def test_embalagem_de_1m_e_2m_vai_para_me2_e_de_3m_para_me1(estado):
    ml = MLFalso([
        item("MLB1", "Perfil 1m", modo="not_specified", sku="A"),
        item("MLB2", "Perfil 2m", modo="not_specified", sku="B"),
        item("MLB3", "Perfil 3m", modo="not_specified", sku="C", tags=["me2_available"]),
    ])
    medidas = {"A": (1.6, 1.6, 100, 300), "B": (1.6, 1.6, 200, 500), "C": (1.6, 1.6, 300, 800)}
    _rotina(estado, {"norvia": medidas}, {"norvia": ml}).executar()
    assert sorted(t[:2] for t in ml.trocas) == [("MLB1", "me2"), ("MLB2", "me2"), ("MLB3", "me1")]


def test_rotina_diaria_nao_mexe_em_tipo_inconsistente_mas_a_varredura_corrige(estado):
    ml = MLFalso([
        item("MLB1", "Perfil 2m em ME1", modo="me1", sku="B"),
        item("MLB2", "Perfil 3m em ME2", modo="me2", sku="C"),
        item("MLB3", "Perfil 1m certo", modo="me2", sku="A"),
    ])
    medidas = {"A": (1.6, 1.6, 100, 300), "B": (1.6, 1.6, 200, 500), "C": (1.6, 1.6, 300, 800)}
    rotina = _rotina(estado, {"norvia": medidas}, {"norvia": ml})

    rotina.executar()
    assert ml.trocas == [], "a rotina diária só troca os a combinar"

    res = rotina.executar("varredura", varredura=True)
    assert sorted(t[:2] for t in ml.trocas) == [("MLB1", "me2"), ("MLB2", "me1")]
    assert res["resumo"]["corrigidos"] == 2 and res["resumo"]["trocas"] == 0
    assert {t["origem"] for t in estado.ler()["trocas"]} == {"varredura"}


def test_varredura_nao_mexe_no_full_nem_em_me1_de_conta_sem_me1(estado):
    full = item("MLB1", "Perfil 3m no Full", modo="me2", sku="C")
    full["shipping"]["logistic_type"] = "fulfillment"
    ml_h = MLFalso([full])
    ml_p = MLFalso([item("MLB2", "Perfil 3m", modo="me2", sku="C")])
    medidas = {"C": (1.6, 1.6, 300, 800)}
    _rotina(estado, {"norvia": medidas, "revesta": medidas}, {"norvia": ml_h, "revesta": ml_p}).executar(
        "varredura", varredura=True
    )
    assert ml_h.trocas == [] and ml_p.trocas == []
    assert estado.ler()["anuncios"]["revesta:MLB2"]["bloqueio"] == "sem_me1"


def test_medida_de_outra_empresa_nao_vale(estado):
    ml = MLFalso([item("MLB1", "Perfil 1m", modo="not_specified", sku="A")])
    _rotina(estado, {"revesta": {"A": (1.6, 1.6, 100, 300)}}, {"norvia": ml}).executar()
    assert ml.trocas == []
    assert estado.ler()["anuncios"]["norvia:MLB1"]["bloqueio"] == "sem_padrao"


def test_sem_medida_no_tiny_nao_mexe_no_anuncio(estado):
    ml = MLFalso([item("MLB1", "Perfil 1m", modo="not_specified", sku="SEM"), item("MLB2", "Sem sku", modo="not_specified")])
    _rotina(estado, {}, {"norvia": ml}).executar()
    anuncios = estado.ler()["anuncios"]
    assert ml.trocas == [] and ml.medidas_enviadas == []
    assert anuncios["norvia:MLB1"]["bloqueio"] == "sem_padrao"
    assert anuncios["norvia:MLB2"]["bloqueio"] == "sem_sku"


def test_produto_largo_vai_com_as_medidas_do_tiny(estado):
    ml = MLFalso([item("MLB1", "Rodapé 8cm", modo="not_specified", sku="RODAPE")])
    _rotina(estado, {"norvia": {"RODAPE": (8, 1.1, 200, 900)}}, {"norvia": ml}).executar()
    assert ml.medidas_enviadas == [("MLB1", (8, 1.1, 200), 900)], "sem a seção 5 x 7: a embalagem é a do Tiny"
    assert ml.trocas[-1][:2] == ("MLB1", "me2")


def test_so_me1_em_conta_sem_me1_fica_bloqueado(estado):
    ml = MLFalso([item("MLB1", "Perfil 3m", modo="not_specified", sku="A")])
    _rotina(estado, {"revesta": {"A": (1.6, 1.6, 300, 800)}}, {"revesta": ml}).executar()
    assert ml.trocas == []
    assert estado.ler()["anuncios"]["revesta:MLB1"]["bloqueio"] == "sem_me1"


def test_ml_volta_para_a_combinar_vira_falha_e_nova_tentativa_limpa(estado):
    ml = MLFalso([item("MLB1", "Perfil 1m", modo="not_specified", sku="PV83")])
    ml.reverter_troca = True
    rotina = _rotina(estado, {"norvia": {"PV83": (1.6, 1.6, 98, 400)}}, {"norvia": ml})
    rotina.executar()
    _vencer_conferencias(estado)
    rotina.conferir_vencidas()
    reg = estado.ler()["anuncios"]["norvia:MLB1"]
    assert "a combinar" in reg["falha_envio"]["mensagem"]
    assert estado.ler()["avisos"][-1]["tipo"] == "fretes_revertido"

    ml.reverter_troca = False
    res = rotina.retentar([{"filial": "norvia", "mlb": "MLB1"}, {"filial": "norvia", "mlb": "MLB9"}], usuario="Ana")
    assert res["enviados"] == 1 and "MLB9" in res["ignorados"][0]
    assert estado.ler()["anuncios"]["norvia:MLB1"]["falha_envio"] is None
    troca = estado.ler()["trocas"][-1]
    assert (troca["status"], troca["usuario"]) == ("aguardando", "Ana")
    assert rotina.retentar([{"filial": "norvia", "mlb": "MLB1"}])["enviados"] == 0, "já aguardando conferência"


def test_carrinhos_ficam_fora_e_campos_antigos_saem(estado):
    with estado.alterar() as dados:
        dados["anuncios"]["norvia:MLB9"] = {"filial": "norvia", "mlb": "MLB9", "titulo": "Carrinho de Bolserie"}
        dados["anuncios"]["norvia:MLB2"] = {"filial": "norvia", "mlb": "MLB2", "titulo": "x", "dims": {}, "pendencia": {"motivos": []}}
    ml = MLFalso([item("MLB1", "Carrinho De Rodameio"), item("MLB2", "Painel", sku="P")])
    _rotina(estado, {}, {"norvia": ml}).executar()
    anuncios = estado.ler()["anuncios"]
    assert list(anuncios) == ["norvia:MLB2"]
    assert "dims" not in anuncios["norvia:MLB2"] and "pendencia" not in anuncios["norvia:MLB2"]


def test_conta_nao_conectada_nao_impede_a_outra(estado):
    from app.ml_client import ContaNaoConectada

    ml = MLFalso([item("MLB1", "Painel", sku="P")])

    def fabrica(filial):
        if filial == "revesta":
            raise ContaNaoConectada("sem access token")
        return ml

    res = Rotina(estado, padroes({}), fabrica_cliente=fabrica, pausa=0).executar()
    assert res["resumo"]["contas"]["revesta"]["status"] == "nao_conectada"
    assert res["resumo"]["contas"]["norvia"]["status"] == "ok"


def test_skus_do_anuncio_prioriza_seller_sku_sobre_o_codigo_legado():
    from app.rotina import skus_do_anuncio

    anuncio = {
        "attributes": [{"id": "SELLER_SKU", "value_name": "PV308"}],
        "seller_custom_field": "4203",
        "variations": [
            {"attributes": [], "seller_custom_field": "PV309"},
            {"attributes": [{"id": "SELLER_SKU", "value_name": "PV310"}], "seller_custom_field": "4169"},
        ],
    }
    assert skus_do_anuncio(anuncio) == ["PV308", "PV310"]

    # SKUs só nas variações: o código legado do anúncio fica de fora.
    variacoes = {
        "seller_custom_field": "3907",
        "variations": [
            {"attributes": [{"id": "SELLER_SKU", "value_name": "NRVCME021M04MP"}]},
            {"attributes": [{"id": "SELLER_SKU", "value_name": "NRVCME021M05MP"}], "seller_custom_field": "3908"},
        ],
    }
    assert skus_do_anuncio(variacoes) == ["NRVCME021M04MP", "NRVCME021M05MP"]
    assert skus_do_anuncio({"seller_custom_field": "A1", "variations": [{"seller_custom_field": "A2"}]}) == ["A1", "A2"]
    assert skus_do_anuncio({"seller_custom_field": " PV83 "}) == ["PV83"]


def test_troca_ok_que_sai_do_historico_vira_contador_por_dia(tmp_path, monkeypatch):
    import app.estado as estado_mod
    from app.estado import Estado

    monkeypatch.setattr(estado_mod, "MAX_TROCAS", 2)
    est = Estado(tmp_path)
    with est.alterar() as dados:
        for i, status in enumerate(["ok", "erro", "ok", "ok"]):
            est.registrar_troca(dados, {"filial": "revesta", "mlb": f"MLB{i}", "status": status,
                                        "feita_em": f"2026-10-2{i}T10:00:00-03:00"})
    dados = est.ler()
    assert len(dados["trocas"]) == 2
    assert dados["trocas_ok_arquivadas"] == {"2026-10-20": {"revesta": 1}}
