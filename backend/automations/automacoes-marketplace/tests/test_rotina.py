from datetime import datetime, timedelta

from app.rotina import Rotina
from tests.conftest import MLFalso, gravar_padrao, item


def _rotina(estado, repo, contas):
    """contas: {filial: MLFalso}; filial sem conta = sem anúncios."""
    return Rotina(estado, repo, fabrica_cliente=lambda f: contas.setdefault(f, MLFalso([])), pausa=0)


def _vencer_conferencias(estado):
    with estado.alterar() as dados:
        for t in dados["trocas"]:
            if t["status"] == "aguardando":
                t["verificar_em"] = (datetime.now() - timedelta(seconds=1)).isoformat(timespec="seconds")


def test_a_combinar_com_padrao_recebe_a_embalagem_e_o_envio_e_confere_depois(estado, repo):
    gravar_padrao(repo, "PV83", 1.6, 1.6, 98, peso=400)  # perfil de ~1 m → embalagem 5x7x100
    ml = MLFalso([item("MLB1", "Perfil 16x16mm 1m", modo="not_specified", sku="PV83")])
    rotina = _rotina(estado, repo, {"norvia": ml})
    rotina.executar()

    assert ml.medidas_enviadas == [("MLB1", (5, 7, 100), 400)]
    assert ml.trocas[-1][:2] == ("MLB1", "me2")
    troca = estado.ler()["trocas"][-1]
    assert troca["status"] == "aguardando"

    _vencer_conferencias(estado)
    assert rotina.conferir_vencidas() == 1
    assert estado.ler()["trocas"][-1]["status"] == "ok"


def test_embalagem_de_200_ou_300_vai_para_me1_a_nao_ser_que_o_ml_aceite_me2(estado, repo):
    gravar_padrao(repo, "A", 1.6, 1.6, 200)
    gravar_padrao(repo, "B", 1.6, 1.6, 300)
    ml = MLFalso([
        item("MLB1", "Perfil 2m", modo="not_specified", sku="A"),
        item("MLB2", "Perfil 3m", modo="not_specified", sku="B", tags=["me2_available", "self_service_available"]),
    ])
    _rotina(estado, repo, {"norvia": ml}).executar()
    assert sorted(t[:2] for t in ml.trocas) == [("MLB1", "me1"), ("MLB2", "me2")]


def test_sem_padrao_nao_mexe_no_anuncio(estado, repo):
    ml = MLFalso([item("MLB1", "Perfil 1m", modo="not_specified", sku="SEM"), item("MLB2", "Sem sku", modo="not_specified")])
    _rotina(estado, repo, {"norvia": ml}).executar()
    anuncios = estado.ler()["anuncios"]
    assert ml.trocas == [] and ml.medidas_enviadas == []
    assert anuncios["norvia:MLB1"]["bloqueio"] == "sem_padrao"
    assert anuncios["norvia:MLB2"]["bloqueio"] == "sem_sku"


def test_produto_que_nao_cabe_na_embalagem_padrao_nao_e_trocado(estado, repo):
    gravar_padrao(repo, "RODAPE", 8, 1.1, 200)  # 8 cm de largura não cabe na seção 5 x 7
    ml = MLFalso([item("MLB1", "Rodapé 8cm", modo="not_specified", sku="RODAPE")])
    _rotina(estado, repo, {"norvia": ml}).executar()
    assert ml.trocas == []
    assert estado.ler()["anuncios"]["norvia:MLB1"]["bloqueio"] == "sem_embalagem"


def test_so_me1_em_conta_sem_me1_fica_bloqueado(estado, repo):
    gravar_padrao(repo, "A", 1.6, 1.6, 200)
    ml = MLFalso([item("MLB1", "Perfil 2m", modo="not_specified", sku="A")])
    _rotina(estado, repo, {"revesta": ml}).executar()
    assert ml.trocas == []
    assert estado.ler()["anuncios"]["revesta:MLB1"]["bloqueio"] == "sem_me1"


def test_ml_volta_para_a_combinar_vira_falha_e_nova_tentativa_limpa(estado, repo):
    gravar_padrao(repo, "PV83", 1.6, 1.6, 98)
    ml = MLFalso([item("MLB1", "Perfil 1m", modo="not_specified", sku="PV83")])
    ml.reverter_troca = True
    rotina = _rotina(estado, repo, {"norvia": ml})
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


def test_carrinhos_ficam_fora_e_campos_antigos_saem(estado, repo):
    with estado.alterar() as dados:
        dados["anuncios"]["norvia:MLB9"] = {"filial": "norvia", "mlb": "MLB9", "titulo": "Carrinho de Bolserie"}
        dados["anuncios"]["norvia:MLB2"] = {"filial": "norvia", "mlb": "MLB2", "titulo": "x", "dims": {}, "pendencia": {"motivos": []}}
    ml = MLFalso([item("MLB1", "Carrinho De Rodameio"), item("MLB2", "Painel", sku="P")])
    _rotina(estado, repo, {"norvia": ml}).executar()
    anuncios = estado.ler()["anuncios"]
    assert list(anuncios) == ["norvia:MLB2"]
    assert "dims" not in anuncios["norvia:MLB2"] and "pendencia" not in anuncios["norvia:MLB2"]


def test_conta_nao_conectada_nao_impede_a_outra(estado, repo):
    from app.ml_client import ContaNaoConectada

    ml = MLFalso([item("MLB1", "Painel", sku="P")])

    def fabrica(filial):
        if filial == "revesta":
            raise ContaNaoConectada("sem access token")
        return ml

    res = Rotina(estado, repo, fabrica_cliente=fabrica, pausa=0).executar()
    assert res["resumo"]["contas"]["revesta"]["status"] == "nao_conectada"
    assert res["resumo"]["contas"]["norvia"]["status"] == "ok"
