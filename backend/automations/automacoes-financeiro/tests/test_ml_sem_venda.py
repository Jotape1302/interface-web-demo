"""
Recebimento "sem venda" (06/11/2026): o pagamento 173604496909 (Maysa, R$ 2.453,64) era do pedido
2000036158838540, mas o relatório não trazia o pedido e o pedido não veio na busca do Mercado
Livre. O Mercado Pago diz de qual pedido é o pagamento; só vale se o pedido trouxer o mesmo pagamento.
"""
from decimal import Decimal

from app import ml_reconciliation as ml
from app.ml_reconciliation_rotina import RotinaConciliacaoML

from tests.test_ml_reconciliation import LIBERACOES, PEDIDOS_ML, _ML, _rotina


class _MPPedidos:
    def __init__(self, pedidos):
        self.pedidos = pedidos
        self.consultas = []

    def pedido_do_pagamento(self, pid):
        self.consultas.append(pid)
        return self.pedidos.get(pid, "")


def test_analise_liga_pelo_pagamento_o_recebimento_sem_pedido_no_relatorio():
    movs = ml.expandir_liberacoes(LIBERACOES)
    for m in movs:
        m.id_pedido = m.id_pacote = ""
    pedidos_ml = [p for p in PEDIDOS_ML if p["id"] != 2000000000000001]
    # 5001 é do pedido ...001; 5004 diz ser do ...002, que não traz esse pagamento: não entra.
    mp = _MPPedidos({"5001": "2000000000000001", "5004": "2000000000000002"})
    ligados = RotinaConciliacaoML._ligar_pagamentos_sem_venda(mp, _ML(), movs, pedidos_ml)
    assert ligados == 1
    assert [p["id"] for p in pedidos_ml if p["id"] == 2000000000000001] == [2000000000000001]
    comparativo = ml.cruzar_vendas(movs, pedidos_ml, [])
    assert any(i.id_pacote == "3000000000000001" and i.casou_por == ml.CASOU_PAGAMENTO for i in comparativo)


def _sem_venda(pid):
    return ml.GrupoRecebimento(
        id=f"C-x-{pid}", id_venda="", indices=[], chaves=[f"v2|{pid}|x"], valor_total=Decimal("110.00"),
        valor_produtos=Decimal("110.00"), data="25/08/2025", data_venda="18/08/2025", nome_cliente="", id_operacao=pid,
        situacao=ml.SIT_SEM_CLIENTE, mensagem="Recebimento sem venda do Mercado Livre ligada ao pagamento.",
    )


def test_herdado_sem_venda_acha_venda_cliente_e_conta(tmp_path):
    r = _rotina(tmp_path)
    g, outro = _sem_venda("5001"), _sem_venda("7777")
    mp = _MPPedidos({"5001": "2000000000000001"})
    achados = r._religar_herdados_sem_venda(ml.EMPRESAS_ML["norvia_campinas"], [g, outro], "tok", mp, None)
    assert achados == 1
    assert (g.id_venda, g.nome_cliente, g.conta_id, g.situacao) == ("3000000000000001", "Ana Souza", 10, ml.SIT_APTO_BAIXA)
    assert g.ids_pagamento == ["5001"]
    # Pagamento que não é de pedido desta conta: marcado, a próxima rodada não pergunta de novo.
    assert outro.venda_procurada and outro.situacao == ml.SIT_SEM_CLIENTE
    mp.consultas.clear()
    r._religar_herdados_sem_venda(ml.EMPRESAS_ML["norvia_campinas"], [outro], "tok", mp, None)
    assert mp.consultas == []


def test_herdado_com_venda_mas_sem_pedido_no_tiny_continua_sem_cliente(tmp_path):
    r = _rotina(tmp_path)
    g = _sem_venda("5004")
    mp = _MPPedidos({"5004": "2000000000000003"})
    # O pedido ...003 traz o 5004, mas o Tiny de teste não acha o número na busca por pedido.
    r.tiny.list_pedidos_v3 = lambda token, **kw: []
    assert r._religar_herdados_sem_venda(ml.EMPRESAS_ML["norvia_campinas"], [g], "tok", mp, None) == 0
    assert g.id_venda == "2000000000000003" and g.situacao == ml.SIT_SEM_CLIENTE
    assert "não encontrada nos pedidos do Tiny" in g.mensagem
