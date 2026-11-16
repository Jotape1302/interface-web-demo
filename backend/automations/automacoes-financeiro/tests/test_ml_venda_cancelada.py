"""
Venda cancelada/devolvida (10/11/2026): pedido CANCELADO no Tiny (situação 2), sem nota e sem conta
a receber, mas com o recebimento no relatório do Mercado Pago (e o estorno). Fluxo do financeiro: a
baixa confirmada na tela cria a conta a receber do pedido, baixa como entrada e lança no caixa o
estorno e as tarifas da venda. Nunca cria duas contas para a mesma venda.
"""
from datetime import date
from decimal import Decimal

from app import ml_reconciliation as ml
from app.tiny_client import LancamentoCaixaIncerto

from tests.test_ml_caixa_na_baixa import _TinyCaixa
from tests.test_ml_reconciliation import _rotina

VENDA_ANA = "3000000000000001"


class _TinyCancelado(_TinyCaixa):
    """Ana sem conta no Tiny e com o pedido cancelado; a conta só passa a existir quando criada."""

    def __init__(self, situacao_pedido=2, incerto=False, valor_pedido=110, nota=None):
        super().__init__()
        self.nota = nota
        self.contas["Ana Souza"] = []
        self.situacao_pedido = situacao_pedido
        self.incerto_conta = incerto
        self.valor_pedido = valor_pedido
        self.criadas = []

    def list_pedidos_v3(self, token, data_inicial=None, data_final=None, numero_pedido_ecommerce=None, max_pages=300):
        if numero_pedido_ecommerce == VENDA_ANA:
            return [{"id": 501}]
        return super().list_pedidos_v3(token, data_inicial, data_final, numero_pedido_ecommerce, max_pages)

    def obter_pedido_v3(self, token, pedido_id):
        return {"id": pedido_id, "numeroPedido": 32851, "situacao": self.situacao_pedido,
                "valorTotalPedido": self.valor_pedido, "cliente": {"id": 77, "nome": "Ana Souza"}, "notaFiscal": self.nota}

    def list_contas_receber_v3(self, token, nome_cliente=None, id_nota=None, **kw):
        return [] if id_nota is not None else self.contas.get(nome_cliente, [])

    def criar_conta_receber_v3(self, token, **kw):
        self.criadas.append(kw)
        cid = 900 + len(self.criadas)
        self.contas["Ana Souza"].append({"id": cid, "historico": kw["historico"], "situacao": "aberto",
                                         "valor": float(kw["valor"]), "saldo": float(kw["valor"])})
        self.situacao_atual[cid] = "aberto"
        if self.incerto_conta:
            raise LancamentoCaixaIncerto("HTTP 502")
        return cid

    def obter_conta_receber_v3(self, token, cid):
        if cid < 900:
            return super().obter_conta_receber_v3(token, cid)
        conta = next(c for c in self.contas["Ana Souza"] if c["id"] == cid)
        sit = self.situacao_atual[cid]
        return {**conta, "situacao": sit, "saldo": 0 if sit == "pago" else conta["valor"]}


def _analise(tmp_path, tiny):
    r = _rotina(tmp_path, tiny=tiny)
    ex = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    analise_id = ex["empresas"]["norvia_campinas"]["analise_id"]
    analise = r.estado.analise(analise_id)
    return r, analise_id, next(g for g in analise.grupos if g.id_venda == VENDA_ANA)


def test_pedido_cancelado_sem_conta_vira_venda_cancelada(tmp_path):
    _, _, ana = _analise(tmp_path, _TinyCancelado())
    assert ana.situacao == ml.SIT_VENDA_CANCELADA
    assert (ana.pedido_tiny_numero, ana.pedido_tiny_valor, ana.cliente_tiny_id) == ("32851", Decimal("110"), 77)
    assert ana.pode_baixar and not ana.apto_baixa
    assert "cria a conta de R$ 110.00" in ana.mensagem
    assert ml.grupo_json(ana)["pode_baixar"] is True


def test_pedido_nao_cancelado_continua_nao_localizado(tmp_path):
    _, _, ana = _analise(tmp_path, _TinyCancelado(situacao_pedido=1))
    assert ana.situacao == ml.SIT_NAO_LOCALIZADO and not ana.pode_baixar


def test_baixa_cria_conta_baixa_e_lanca_tarifas(tmp_path):
    tiny = _TinyCancelado()
    r, analise_id, ana = _analise(tmp_path, tiny)
    res = r.baixar(analise_id, [ana.id], usuario="Fulano")
    assert res["total_sucessos"] == 1, res
    assert len(tiny.criadas) == 1
    criada = tiny.criadas[0]
    assert (criada["valor"], criada["contato_id"], criada["categoria_id"], criada["data"]) == (
        Decimal("110"), 77, 882461346, "2025-08-30")
    assert criada["historico"] == f"Ref. ao pedido de venda nº 32851, Ana Souza - OC nº {VENDA_ANA}"
    assert [b[0] for b in tiny.baixas] == [901]
    # Tarifas da venda no caixa, com o histórico da conta criada.
    assert {c["historico"] for c in tiny.caixa} == {criada["historico"]}
    assert len(tiny.caixa) == 2
    assert res["resultados"][0]["conta_id"] == 901
    # Sem linha de devolução no relatório do teste: avisa para lançar o estorno à mão.
    assert "estorno" in res["resultados"][0]["mensagem"]
    assert r.estado.ler()["contas_criadas"][f"norvia_campinas|{VENDA_ANA}"]["id"] == 901


def test_nunca_cria_duas_contas(tmp_path):
    tiny = _TinyCancelado()
    tiny.baixar_conta_receber_v3 = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("HTTP 400"))
    r, analise_id, ana = _analise(tmp_path, tiny)
    assert r.baixar(analise_id, [ana.id])["total_falhas"] == 1
    assert len(tiny.criadas) == 1
    # Repetir o "Erro na baixa": usa a conta criada, não cria outra.
    del tiny.baixar_conta_receber_v3
    analise = r.estado.analise(analise_id)
    ana = next(g for g in analise.grupos if g.id_venda == VENDA_ANA)
    assert ana.situacao == ml.SIT_ERRO_API and ana.conta_id == 901
    assert r.baixar(analise_id, [ana.id])["total_sucessos"] == 1
    assert len(tiny.criadas) == 1


def test_conta_que_ja_cita_a_venda_e_reaproveitada(tmp_path):
    tiny = _TinyCancelado()
    r, analise_id, ana = _analise(tmp_path, tiny)
    tiny.contas["Ana Souza"].append({"id": 950, "historico": f"OC nº {VENDA_ANA}", "situacao": "aberto",
                                     "valor": 110, "saldo": 110})
    tiny.situacao_atual[950] = "aberto"
    tiny.obter_conta_receber_v3 = lambda token, cid: {"id": 950, "historico": f"OC nº {VENDA_ANA}",
                                                      "situacao": tiny.situacao_atual[950], "valor": 110,
                                                      "saldo": 0 if tiny.situacao_atual[950] == "pago" else 110}
    assert r.baixar(analise_id, [ana.id])["total_sucessos"] == 1
    assert tiny.criadas == [] and [b[0] for b in tiny.baixas] == [950]


def test_resposta_incerta_nao_repete_a_criacao(tmp_path):
    tiny = _TinyCancelado(incerto=True)
    tiny.list_contas_receber_v3 = lambda token, nome_cliente=None, id_nota=None, **kw: []  # não aparece na busca
    r, analise_id, ana = _analise(tmp_path, tiny)
    res = r.baixar(analise_id, [ana.id])
    assert res["total_falhas"] == 1 and "confira no Tiny" in res["resultados"][0]["mensagem"]
    res2 = r.baixar(analise_id, [ana.id])
    assert len(tiny.criadas) == 1, "a segunda tentativa só procura a conta"
    assert "confira no Tiny" in res2["resultados"][0]["mensagem"]


def test_recebido_que_nao_fecha_com_o_pedido_nao_cria_conta(tmp_path):
    tiny = _TinyCancelado(valor_pedido=50)
    r, analise_id, ana = _analise(tmp_path, tiny)
    res = r.baixar(analise_id, [ana.id])
    assert res["total_ignorados"] == 1 and tiny.criadas == []
    assert "não fecha com o pedido" in res["resultados"][0]["mensagem"]


# Revesta, 24–29/10/2026 (ex.: Rafael Teixeira, pedido 66443): pedido faturado com nota fiscal e sem
# conta a receber no Tiny. Financeiro, 16/11/2026: a baixa cria a conta do pedido, como na cancelada.

def test_pedido_com_nota_e_sem_conta_vira_sem_conta_a_receber(tmp_path):
    _, _, ana = _analise(tmp_path, _TinyCancelado(situacao_pedido=6, nota={"id": 824845325}))
    assert ana.situacao == ml.SIT_SEM_CONTA_RECEBER
    assert ana.pode_baixar and not ana.apto_baixa
    assert "com nota fiscal no Tiny, mas sem conta a receber" in ana.mensagem
    assert "cria a conta de R$ 110.00" in ana.mensagem


def test_sem_conta_a_receber_cria_a_conta_baixa_e_nao_pede_estorno(tmp_path):
    tiny = _TinyCancelado(situacao_pedido=6, nota={"id": 824845325})
    r, analise_id, ana = _analise(tmp_path, tiny)
    res = r.baixar(analise_id, [ana.id], usuario="Fulano")
    assert res["total_sucessos"] == 1, res
    assert [c["valor"] for c in tiny.criadas] == [Decimal("110")]
    assert tiny.criadas[0]["historico"] == f"Ref. ao pedido de venda nº 32851, Ana Souza - OC nº {VENDA_ANA}"
    assert [b[0] for b in tiny.baixas] == [901]
    assert len(tiny.caixa) == 2
    assert "estorno" not in res["resultados"][0]["mensagem"]


def test_sem_conta_a_receber_que_nao_fecha_com_o_pedido_nao_cria_conta(tmp_path):
    tiny = _TinyCancelado(situacao_pedido=6, nota={"id": 824845325}, valor_pedido=99)
    r, analise_id, ana = _analise(tmp_path, tiny)
    res = r.baixar(analise_id, [ana.id], usuario="Fulano")
    assert res["total_sucessos"] == 0 and tiny.criadas == []
    assert "não fecha com o pedido" in res["resultados"][0]["mensagem"]
