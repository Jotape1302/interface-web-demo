"""
Histórico de categoria dos boletos DDA (app/dda_categoria.py): saídas do Tiny + escolhas do painel,
precedência da sugestão, ponte do classificador Qwen (pendentes, sugestões, confirmadas-recentes).
"""
import pytest
from fastapi.testclient import TestClient

from app import dda_categoria as dc
from app.dda_categoria import HistoricoCategorias, sugestao_boleto, versao_boleto
from tests.test_dda_pagamentos import FORNECEDOR, _boleto_polp, _Polp, _rotina, _Tiny

OUTRO = "99888777000166"


def _lanc(lid, cat, cnpj=FORNECEDOR, nome="Fornecedor Ltda", valor=100.0, data="2026-10-01"):
    return {"id": lid, "data": data, "valor": valor, "categoria_id": cat, "categoria_nome": f"Cat {cat}",
            "categoria_grupo": "Despesas", "fornecedor_cnpj": cnpj, "fornecedor_nome": nome}


def _boleto(**kw):
    return {"id": "b1", "empresa": "norvia_campinas", "beneficiario_nome": "Fornecedor Ltda", "beneficiario_cnpj": FORNECEDOR,
            "sacador_cnpj": "", "valor": "1500.00", "vencimento": "2026-11-20", **kw}


@pytest.fixture
def hist(tmp_path):
    return HistoricoCategorias(pasta=tmp_path / "dda")


def test_tiny_dominante_vence_e_fraco_fica_abaixo_do_qwen(hist):
    hist.registrar_lancamentos_tiny("norvia_campinas", [_lanc(i, "1") for i in range(9)] + [_lanc(9, "2")])
    s = sugestao_boleto(_boleto(qwen={"versao": versao_boleto(_boleto()), "categoria_id": "2", "confianca": "alta"}), hist)
    assert (s["categoria_id"], s["origem"], s["nivel"]) == ("1", "historico", "tiny")
    assert s["distribuicao"][0] == {"categoria_id": "1", "vezes": 9, "valor_medio": 100.0, "ultima": "2026-10-01"}
    assert s["alternativas"]["qwen"] == {"categoria_id": "2", "confianca": "alta"}

    hist.registrar_lancamentos_tiny("norvia_campinas", [_lanc(i, "2") for i in range(10, 16)])  # 9 × 7: sem dominante
    b = _boleto(qwen={"versao": versao_boleto(_boleto()), "categoria_id": "3", "confianca": "media", "motivo": "m"})
    s = sugestao_boleto(b, hist)
    assert (s["categoria_id"], s["origem"]) == ("3", "qwen")
    b["qwen"]["confianca"] = "baixa"
    s = sugestao_boleto(b, hist)
    assert (s["categoria_id"], s["origem"], s["nivel"]) == ("1", "historico", "tiny_fraco")


def test_outra_empresa_nao_conta_e_nome_casa_sem_cnpj(hist):
    hist.registrar_lancamentos_tiny("revesta", [_lanc(1, "1"), _lanc(2, "1")])
    assert sugestao_boleto(_boleto(), hist) is None
    hist.registrar_lancamentos_tiny("norvia_campinas", [_lanc(3, "5", cnpj="", nome="FORNECEDOR LTDA."), _lanc(4, "5", cnpj="", nome="Fornecedor")])
    s = sugestao_boleto(_boleto(beneficiario_cnpj=OUTRO), hist)
    assert (s["categoria_id"], s["nivel"]) == ("5", "tiny")


def test_qwen_de_versao_antiga_nao_vale(hist):
    b = _boleto(qwen={"versao": "outra", "categoria_id": "2", "confianca": "alta"})
    assert sugestao_boleto(b, hist) is None


def test_escolha_do_painel_vence_o_tiny_e_entra_no_cursor(hist):
    hist.registrar_lancamentos_tiny("norvia_campinas", [_lanc(i, "1") for i in range(5)])
    b = _boleto(documento="NF 1")
    hist.registrar_escolha(b, {"id": "7", "nome": "Aluguel", "grupo": "Fixas"}, "criou", "Fulano", sugestao_boleto(b, hist))
    s = sugestao_boleto(_boleto(id="b2"), hist)
    assert (s["categoria_id"], s["nivel"]) == ("7", "painel")
    registros, cursor, fim = hist.confirmadas(0, 3)
    assert [r["seq"] for r in registros] == [1, 2, 3] and cursor == 3 and not fim
    resto, cursor2, fim2 = hist.confirmadas(cursor, 100)
    painel = resto[-1]
    assert fim2 and cursor2 == 6 and painel["fonte"] == "painel" and painel["categoria_id"] == "7"
    assert painel["sugestao"] == {"categoria_id": "1", "origem": "historico", "nivel": "tiny", "distribuicao": painel["sugestao"]["distribuicao"],
                                  "vezes_tiny": 5}
    # Mesma saída lida de novo não ganha seq; categoria mudada no Tiny ganha.
    assert hist.registrar_lancamentos_tiny("norvia_campinas", [_lanc(0, "1")]) == 0
    assert hist.registrar_lancamentos_tiny("norvia_campinas", [_lanc(0, "4")]) == 1
    assert hist.confirmadas(6, 10)[0][0]["chave"] == "tiny:norvia_campinas:0"


def test_persiste_em_disco(tmp_path, hist):
    hist.registrar_lancamentos_tiny("fabrilux", [_lanc(1, "1")])
    novo = HistoricoCategorias(pasta=tmp_path / "dda")
    assert novo.resumo()["registros"] == {"tiny": 1}


def test_coletar_lancamento_so_saida_com_contato():
    item = {"id": 5, "tipo": "D", "data": "2026-10-03", "valor": 10, "contato": {"nome": "X", "cpfCnpj": "11.222.333/0001-81"}}
    assert dc.coletar_lancamento(item, "1", "Energia", "Fixas")["fornecedor_cnpj"] == FORNECEDOR
    assert dc.coletar_lancamento({**item, "tipo": "C"}, "1", "", "") is None
    assert dc.coletar_lancamento({**item, "contato": {}}, "1", "", "") is None


def _rotina_hist(tmp_path, tiny=None):
    r = _rotina(tmp_path, polp=_Polp([_boleto_polp()]), tiny=tiny or _Tiny(contas=[]))
    r.historico = HistoricoCategorias(pasta=tmp_path / "dda")
    r.executar("teste")
    return r


def test_criar_conta_grava_a_escolha_com_a_sugestao(tmp_path):
    r = _rotina_hist(tmp_path)
    r.historico.registrar_lancamentos_tiny("norvia_campinas", [_lanc(i, "1") for i in range(3)])
    assert [b for b in r.boletos() if b["id"] == "b1"][0]["sugestao_categoria"]["categoria_id"] == "1"
    r.criar_conta("b1", 2, "", "Fulano")
    reg = r.historico.ler()["registros"]["painel:b1"]
    assert (reg["categoria_id"], reg["categoria_nome"], reg["acao"], reg["usuario"]) == ("2", "Aluguel", "criou", "Fulano")
    assert reg["sugestao"]["categoria_id"] == "1"  # sugestão "1", escolha "2": corrigido pelo humano
    assert r.estado.ler()["boletos"]["b1"]["categoria"]["id"] == "2"


def test_ligar_conta_grava_a_categoria_da_conta(tmp_path):
    from tests.test_dda_pagamentos import _conta

    conta = {**_conta(10), "categoria": {"id": 8, "descricao": "Fretes"}}
    tiny = _Tiny(contas=[])
    r = _rotina_hist(tmp_path, tiny=tiny)
    tiny.contas = [conta]
    r.vincular_conta("b1", 10, "Fulano")
    reg = r.historico.ler()["registros"]["painel:b1"]
    assert (reg["categoria_id"], reg["acao"]) == ("8", "ligou")


def test_ponte_qwen_pendentes_e_sugestoes(tmp_path):
    r = _rotina_hist(tmp_path)
    p = r.qwen_pendentes(10)
    assert p["total"] == 1 and p["boletos"][0]["id"] == "b1" and p["boletos"][0]["historico"] is None
    assert [c["id"] for c in p["categorias"]["norvia_campinas"]] == ["2", "1"]
    versao = p["boletos"][0]["versao"]
    assert r.gravar_qwen("b1", "velha", "qwen", "1", "alta", "") == "desatualizada"
    assert r.gravar_qwen("b1", versao, "qwen", "999", "alta", "") == "fora_do_catalogo"
    assert r.gravar_qwen("b1", versao, "qwen2.5:14b", "1", "media", "Conta de energia.") == "gravado"
    assert r.qwen_pendentes(10)["total"] == 0
    s = [b for b in r.boletos() if b["id"] == "b1"][0]["sugestao_categoria"]
    assert (s["origem"], s["categoria_id"], s["motivo"]) == ("qwen", "1", "Conta de energia.")
    r.criar_conta("b1", 1, "", "Fulano")
    assert r.historico.ler()["registros"]["painel:b1"]["qwen"] == {"categoria_id": "1", "confianca": "media", "modelo": "qwen2.5:14b"}
    assert r.gravar_qwen("b1", versao, "qwen", "1", "alta", "") == "nao_pendente"


def test_rotas_da_ponte(tmp_path, monkeypatch):
    from app.api import app
    from app.routers import dda as rotas

    r = _rotina_hist(tmp_path)
    monkeypatch.setattr(rotas, "rotina", r)
    cli = TestClient(app)
    cab: dict = {}
    pend = cli.get("/api/v1/dda/qwen/pendentes", headers=cab).json()
    assert pend["total"] == 1
    corpo = {"boleto_id": "b1", "versao": "x", "modelo": "m", "categoria_id": "1", "confianca": "alta"}
    assert cli.post("/api/v1/dda/qwen/sugestoes", json=corpo, headers=cab).status_code == 409
    assert cli.post("/api/v1/dda/qwen/sugestoes", json={**corpo, "boleto_id": "zz"}, headers=cab).status_code == 404
    corpo["versao"] = pend["boletos"][0]["versao"]
    assert cli.post("/api/v1/dda/qwen/sugestoes", json={**corpo, "categoria_id": "9"}, headers=cab).status_code == 422
    assert cli.post("/api/v1/dda/qwen/sugestoes", json=corpo, headers=cab).json()["status"] == "gravado"
    r.historico.registrar_lancamentos_tiny("fabrilux", [_lanc(1, "1"), _lanc(2, "1")])
    pag = cli.get("/api/v1/dda/qwen/confirmadas-recentes?limit=1", headers=cab).json()
    assert pag["cursor"] == "1" and not pag["fim"]
    pag = cli.get(f"/api/v1/dda/qwen/confirmadas-recentes?cursor={pag['cursor']}", headers=cab).json()
    assert pag["fim"] and [c["chave"] for c in pag["confirmadas"]] == ["tiny:fabrilux:2"]
    assert cli.get("/api/v1/dda/qwen/confirmadas-recentes?cursor=abc", headers=cab).status_code == 422
