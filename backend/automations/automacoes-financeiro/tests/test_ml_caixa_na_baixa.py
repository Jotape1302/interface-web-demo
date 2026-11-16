"""
Tarifas, envios e extras lançados no caixa do Tiny junto com a baixa (decisão do financeiro, 06/11/2026):
mesmos valores/categorias da planilha, na data da venda, histórico = o da conta baixada e contato =
Mercado Livre (EBAZAR), nunca repetindo o que já saiu numa planilha. A planilha fica como reserva.
"""
import dataclasses
from datetime import date
from decimal import Decimal

from app import ml_reconciliation as ml
from app.tiny_client import LancamentoCaixaIncerto

from tests.test_ml_reconciliation import _rotina, _Tiny

CATEGORIAS = [
    {"id": 882461346, "descricao": "Vendas Mercado Livre"},
    {"id": 31, "descricao": "Intermediação de Negócios"},
    {"id": 32, "descricao": "Fretes sobre Vendas"},
    {"id": 33, "descricao": "Devolução de mercadorias"},
]


class _TinyCaixa(_Tiny):
    def __init__(self, cpf="111.111.111-11", incerto=False, no_caixa=None):
        super().__init__()
        self.cpf = cpf
        self.incerto = incerto
        self.no_caixa = no_caixa or []
        self.caixa = []

    def obter_conta_receber_v3(self, token, cid):
        hist = next(c["historico"] for cs in self.contas.values() for c in cs if c["id"] == cid)
        return {**super().obter_conta_receber_v3(token, cid), "historico": hist, "cliente": {"id": 77, "cpfCnpj": self.cpf}}

    def buscar_contatos_v3(self, token, nome="", cpf_cnpj=""):
        return [{"id": 88, "nome": "EBAZAR.COM.BR. LTDA", "cpfCnpj": "75.373.412/0001-76"},
                {"id": 99, "nome": "Ebazar.com.br LTDA", "cpfCnpj": "03.007.331/0122-39"},
                {"id": 98, "nome": "EBAZAR.COM.BR LTDA - FILIAL", "cpfCnpj": ""}]

    def list_categorias_receita_despesa_v3(self, token):
        return CATEGORIAS

    def criar_lancamento_caixa_v3(self, token, **kw):
        self.caixa.append(kw)
        if self.incerto:
            raise LancamentoCaixaIncerto("HTTP 502")
        return 1000 + len(self.caixa)

    def list_caixa_v3(self, token, **kw):
        return self.no_caixa


def _baixar_ana(tmp_path, tiny, antes=None):
    r = _rotina(tmp_path, tiny=tiny)
    ex = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    analise_id = ex["empresas"]["norvia_campinas"]["analise_id"]
    analise = r.estado.analise(analise_id)
    ana = next(g for g in analise.grupos if g.id_venda == "3000000000000001")
    if antes:
        antes(r, analise)
    res = r.baixar(analise_id, [ana.id], usuario="Fulano")
    return r, res, analise


def test_baixa_lanca_tarifa_e_envio_da_venda_na_data_da_venda(tmp_path):
    tiny = _TinyCaixa()
    r, res, analise = _baixar_ana(tmp_path, tiny)
    assert res["total_sucessos"] == 1
    assert [(c["valor"], c["tipo"], c["categoria_id"], c["data"], c["contato_id"], c["conta_id"]) for c in tiny.caixa] == [
        (Decimal("12.50"), "D", 31, "2025-08-30", 99, 702641458),
        (Decimal("7.50"), "D", 32, "2025-08-30", 99, 702641458),
    ]
    assert {c["historico"] for c in tiny.caixa} == {"OC 3000000000000001"}, "histórico da conta baixada"
    assert "2 lançamento(s) de caixa criado(s)" in res["resultados"][0]["mensagem"]
    lancados = r.estado.lancamentos_tiny()
    assert sorted(v["id"] for v in lancados.values()) == [1001, 1002]
    assert set(lancados) <= set(r.estado.lancamentos_exportados()), "não vai para a planilha"
    # Só as linhas da venda baixada: a diferença da venda 2000...3 e a publicidade não entram.
    assert len(tiny.caixa) == 2


def test_linha_que_ja_saiu_na_planilha_nao_e_lancada_de_novo(tmp_path):
    def exportar_tarifa(r, analise):
        tarifa = next(l for l in analise.lancamentos.lancamentos if l.tipo_operacao == "Tarifa de venda"
                      and "3000000000000001" in l.historico)
        r.estado.registrar_exportados([ml.chave_lancamento(tarifa)])

    tiny = _TinyCaixa()
    _baixar_ana(tmp_path, tiny, antes=exportar_tarifa)
    assert [c["valor"] for c in tiny.caixa] == [Decimal("7.50")]


def test_sem_o_contato_do_mercado_livre_no_tiny_fica_para_a_planilha(tmp_path):
    class _SemEbazar(_TinyCaixa):
        def buscar_contatos_v3(self, token, nome="", cpf_cnpj=""):
            return [{"id": 88, "nome": "EBAZAR.COM.BR. LTDA", "cpfCnpj": "75.373.412/0001-76"}]

    tiny = _SemEbazar()
    r, res, _ = _baixar_ana(tmp_path, tiny)
    assert res["total_sucessos"] == 1 and tiny.caixa == []
    assert "Nenhum contato 'EBAZAR.COM.BR LTDA'" in res["resultados"][0]["mensagem"]
    assert r.estado.lancamentos_tiny() == {}


def _tarifa_vira_devolucao(r, analise):
    """A linha da tarifa da Ana passa a ser uma devolução (mesma venda, mesma chave)."""
    lancs = analise.lancamentos.lancamentos
    i = next(i for i, l in enumerate(lancs) if l.tipo_operacao == "Tarifa de venda" and "3000000000000001" in l.historico)
    lancs[i] = dataclasses.replace(lancs[i], categoria="Devolução de mercadorias")
    r.estado.salvar_analise(analise)


def test_devolucao_vai_com_o_contato_do_cliente_e_o_resto_com_o_mercado_livre(tmp_path):
    # 16/11/2026 (venda 2000063691868271): o reembolso é para a cliente, não para o Mercado Livre.
    tiny = _TinyCaixa()
    _baixar_ana(tmp_path, tiny, antes=_tarifa_vira_devolucao)
    assert [(c["valor"], c["categoria_id"], c["contato_id"]) for c in tiny.caixa] == [
        (Decimal("12.50"), 33, 77),
        (Decimal("7.50"), 32, 99),
    ]


def test_devolucao_sem_o_cliente_na_conta_fica_para_a_planilha(tmp_path):
    class _SemCliente(_TinyCaixa):
        def obter_conta_receber_v3(self, token, cid):
            return {**super().obter_conta_receber_v3(token, cid), "cliente": {"cpfCnpj": self.cpf}}

    tiny = _SemCliente()
    _, res, _ = _baixar_ana(tmp_path, tiny, antes=_tarifa_vira_devolucao)
    assert [c["valor"] for c in tiny.caixa] == [Decimal("7.50")]
    assert "não trouxe o cliente da devolução" in res["resultados"][0]["mensagem"]


def test_dois_contatos_com_o_mesmo_nome_desempata_pelo_cnpj(tmp_path):
    class _Dois(_TinyCaixa):
        def buscar_contatos_v3(self, token, nome="", cpf_cnpj=""):
            return [{"id": 97, "nome": "EBAZAR.COM.BR LTDA", "cpfCnpj": "75.373.412/0001-76"},
                    {"id": 99, "nome": "EBAZAR.COM.BR LTDA", "cpfCnpj": "03.007.331/0122-39"}]

    tiny = _Dois()
    _baixar_ana(tmp_path, tiny)
    assert {c["contato_id"] for c in tiny.caixa} == {99}


def test_resposta_ambigua_confere_no_caixa(tmp_path):
    # O lançamento entrou apesar do 502: acha no caixa e registra com o id de lá.
    def com_caixa(historico):
        return [{"id": 555, "historico": historico, "valor": 12.5}]

    tiny = _TinyCaixa(incerto=True)
    tiny.no_caixa = []
    r, res, analise = _baixar_ana(tmp_path, tiny)
    incertos = r.estado.ler().get("lancamentos_tiny_incertos") or {}
    assert len(incertos) == 2 and r.estado.lancamentos_tiny() == {}
    assert "confira no caixa" in res["resultados"][0]["mensagem"]

    tiny2 = _TinyCaixa(incerto=True)
    tiny2.no_caixa = com_caixa("OC 3000000000000001")
    r2, _, _ = _baixar_ana(tmp_path / "b", tiny2)
    assert [v.get("id") for v in r2.estado.lancamentos_tiny().values()] == [555]


def test_desligado_so_baixa(tmp_path, monkeypatch):
    tiny = _TinyCaixa()
    r = _rotina(tmp_path, tiny=tiny)
    monkeypatch.setattr(r.cfg, "ML_LANCAR_CAIXA_NA_BAIXA", False)
    ex = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    analise_id = ex["empresas"]["norvia_campinas"]["analise_id"]
    ana = next(g for g in r.estado.analise(analise_id).grupos if g.id_venda == "3000000000000001")
    assert r.baixar(analise_id, [ana.id])["total_sucessos"] == 1
    assert tiny.caixa == []


def test_planilha_nunca_traz_o_que_a_baixa_lancou(tmp_path):
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.api import app

    tiny = _TinyCaixa()
    r, _, analise = _baixar_ana(tmp_path, tiny)
    total = len(analise.lancamentos.lancamentos)
    with patch("app.routers.conciliacao_ml.ml_rotina", r):
        client = TestClient(app)
        url = f"/api/v1/conciliacao-ml/analises/{analise.id}/arquivos/lancamentos/exportar"
        resp = client.post(url, json={"incluir_exportados": True})
    assert resp.status_code == 200
    assert int(resp.headers["X-Lancamentos-Na-Planilha"]) == total - 2


def _como_herdado(r, analise):
    """A venda da Ana saiu da janela: a análise (consolidada) não tem mais as linhas dela."""
    ana = next(g for g in analise.grupos if g.id_venda == "3000000000000001")
    fora = {m.chave for m in analise.movimentos if m.id_pagamento == "5001"}
    assert set(ana.chaves) <= fora
    analise.movimentos = [m for m in analise.movimentos if m.chave not in fora]
    analise.lancamentos.lancamentos = [l for l in analise.lancamentos.lancamentos if l.chave not in fora]
    r.estado.salvar_analise(analise)


def _herdado(tmp_path, tiny):
    r = _rotina(tmp_path, tiny=tiny)
    ex = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    analise_id = ex["empresas"]["norvia_campinas"]["analise_id"]
    analise = r.estado.analise(analise_id)
    _como_herdado(r, analise)
    ana = next(g for g in analise.grupos if g.id_venda == "3000000000000001")
    return r, analise_id, ana


def test_baixa_de_herdado_nunca_pede_relatorio_ao_mercado_pago(tmp_path):
    class _MPProibido:
        def liberacoes(self, *a, **k):
            raise AssertionError("a baixa não espera o Mercado Pago")

    tiny = _TinyCaixa()
    r, analise_id, ana = _herdado(tmp_path, tiny)
    r.fabrica_mp = lambda e: _MPProibido()
    res = r.baixar(analise_id, [ana.id])
    assert res["total_sucessos"] == 1 and tiny.caixa == []
    assert "ainda não foram lidas do relatório do dia" in res["resultados"][0]["mensagem"]


def test_herdado_lanca_a_copia_guardada_no_grupo(tmp_path):
    tiny = _TinyCaixa()
    r, analise_id, ana = _herdado(tmp_path, tiny)
    from tests.test_ml_reconciliation import LIBERACOES

    lancs, pend = r._lancamentos_no_relatorio(
        ml.EMPRESAS_ML["norvia_campinas"], ana, ml.expandir_liberacoes(LIBERACOES), "111.111.111-11"
    )
    assert pend == []
    analise = r.estado.analise(analise_id)
    g = next(x for x in analise.grupos if x.id == ana.id)
    g.lancamentos_caixa = [ml._para_json(__import__("dataclasses").asdict(l)) for l in lancs]
    g.caixa_lido = True
    r.estado.salvar_analise(analise)
    res = r.baixar(analise_id, [ana.id])
    assert res["total_sucessos"] == 1
    assert [(c["valor"], c["categoria_id"], c["data"], c["contato_id"]) for c in tiny.caixa] == [
        (Decimal("12.50"), 31, "2025-08-30", 99),
        (Decimal("7.50"), 32, "2025-08-30", 99),
    ]
    assert {c["historico"] for c in tiny.caixa} == {"OC 3000000000000001"}, "histórico da conta baixada"


def test_relatorio_sem_o_recebimento_nao_copia_nada(tmp_path):
    tiny = _TinyCaixa()
    r, _, ana = _herdado(tmp_path, tiny)
    assert r._lancamentos_no_relatorio(ml.EMPRESAS_ML["norvia_campinas"], ana, [], "1") is None


def test_execucao_copia_as_tarifas_dos_herdados_antigos(tmp_path):
    from tests.test_ml_reconciliation import LIBERACOES

    pedidos = []

    class _MPDoDia:
        def liberacoes(self, de, ate, progresso=None):
            pedidos.append((de, ate))
            return LIBERACOES

    tiny = _TinyCaixa()
    r, _, ana = _herdado(tmp_path, tiny)
    ana.caixa_lido, ana.lancamentos_caixa = False, []
    ana.conta_id = 10
    n = r._copiar_caixa_dos_herdados(ml.EMPRESAS_ML["norvia_campinas"], [ana], {10: "111.111.111-11"}, _MPDoDia())
    assert n == 1 and ana.caixa_lido
    assert [l["valor"] for l in ana.lancamentos_caixa] == ["12.50", "7.50"]


def test_grupo_da_janela_guarda_a_copia_na_consolidada(tmp_path):
    tiny = _TinyCaixa()
    r = _rotina(tmp_path, tiny=tiny)
    r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    cons = r.estado.analise("consolidado_norvia_campinas")
    g = next(x for x in cons.grupos if x.id_venda == "3000000000000001")
    assert g.caixa_lido and [l["valor"] for l in g.lancamentos_caixa] == ["12.50", "7.50"]


def test_resposta_ambigua_com_dois_iguais_no_caixa_nao_decide(tmp_path):
    # O histórico é o da conta (comum às linhas da venda): dois iguais no caixa não dão para saber qual é.
    tiny = _TinyCaixa(incerto=True)
    tiny.no_caixa = [{"id": 555, "historico": "OC 3000000000000001", "valor": 12.5},
                     {"id": 556, "historico": "OC 3000000000000001", "valor": 12.5}]
    r, res, _ = _baixar_ana(tmp_path, tiny)
    assert r.estado.lancamentos_tiny() == {}
    assert "confira no caixa" in res["resultados"][0]["mensagem"]
