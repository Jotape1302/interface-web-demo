"""
Frete pago pelo comprador fora da conta do Tiny (padrão da Campinas): a conta a receber tem só os
produtos e o Mercado Pago libera produtos + "Recebimento de frete". A baixa é o produto (igual ao
saldo) e o frete vira lançamento de caixa em Fretes sobre Vendas, que continua saindo até ser exportado.
"""
from datetime import date
from decimal import Decimal

from app import ml_reconciliation as ml
from tests.test_ml_reconciliation import NORVIA, _lib, _rotina, _Tiny

VENDA = "3000000000000009"
PEDIDOS_ML = [{"id": 2000000000000009, "pack_id": int(VENDA), "status": "paid", "payments": [{"id": 8001}]}]
PEDIDOS_TINY = [{"ecommerce": {"numeroPedidoEcommerce": VENDA}, "cliente": {"nome": "Davi Rocha", "cpfCnpj": "333.333.333-33"}}]


def _libs(bruto="28.73", frete="8.99", parcelamento=None, cupom=None):
    pag = dict(SOURCE_ID="8001", NET_CREDIT_AMOUNT=bruto, GROSS_AMOUNT=bruto, ORDER_ID="2000000000000009")
    liquido = Decimal(bruto)
    if parcelamento:
        pag["FINANCING_FEE_AMOUNT"] = f"-{parcelamento}"
        liquido -= Decimal(parcelamento)
    if cupom:
        pag["COUPON_AMOUNT"] = f"-{cupom}"
        liquido -= Decimal(cupom)
    pag["NET_CREDIT_AMOUNT"] = str(liquido)
    return [
        _lib(**pag),
        _lib(SOURCE_ID="8001", DESCRIPTION="shipping", NET_CREDIT_AMOUNT=frete, GROSS_AMOUNT=frete,
             ORDER_ID="2000000000000009"),
    ]


def _conta(saldo, valor_pago="0"):
    return {"id": 90, "situacao": "aberto", "valor": saldo, "saldo": saldo, "valorPago": valor_pago,
            "historico": f"Ref. ao pedido de venda - OC nº {VENDA}"}


def _analisar(libs, conta, baixas=None, exportados=None):
    return ml.analisar("f1", NORVIA, libs, PEDIDOS_ML, PEDIDOS_TINY, lambda nome: [conta],
                       (date(2025, 9, 1), date(2025, 9, 2)), baixas_feitas=baixas, exportados=exportados)


def _grupo(analise):
    return next(g for g in analise.grupos if g.id_venda == VENDA)


def _fretes(analise):
    return [l for l in analise.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE]


def test_frete_fora_da_conta_baixa_o_produto_e_lanca_o_frete():
    analise = _analisar(_libs(), _conta("28.73"))
    g = _grupo(analise)
    assert g.apto_baixa
    assert g.valor_total == Decimal("28.73") and g.valor_frete == 0 and g.frete_no_caixa == Decimal("8.99")
    assert "Fretes sobre Vendas" in g.mensagem
    (l,) = _fretes(analise)
    assert l.categoria == "Fretes sobre Vendas" and l.valor == Decimal("8.99") and l.tipo == "C"
    assert l.contato == "Davi Rocha" and l.chave == g.chaves_frete[0]
    frete_mov = next(m for m in analise.movimentos if m.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE)
    assert frete_mov.situacao == ml.SIT_LANCAMENTO_CRIADO
    # Reavaliar (visão consolidada, baixa) não desconta duas vezes.
    ml.avaliar_conta(g)
    assert g.valor_total == Decimal("28.73") and g.frete_no_caixa == Decimal("8.99") and g.apto_baixa
    assert g.chaves_frete[0] not in g.chaves_para_registro()


def test_frete_dentro_da_conta_continua_baixado_na_conta():
    analise = _analisar(_libs(), _conta("37.72"))
    g = _grupo(analise)
    assert g.apto_baixa and not g.frete_no_caixa and g.valor_frete == Decimal("8.99")
    assert not _fretes(analise)


def test_conta_com_pagamento_parcial_nao_presume_frete():
    analise = _analisar(_libs(), _conta("28.73", valor_pago="8.99"))
    g = _grupo(analise)
    assert g.situacao == ml.SIT_VALOR_DIVERGENTE and not g.frete_no_caixa
    assert not _fretes(analise)


def test_diferenca_que_nao_e_o_frete_continua_divergente():
    analise = _analisar(_libs(), _conta("25.00"))
    assert _grupo(analise).situacao == ml.SIT_VALOR_DIVERGENTE


def test_frete_fora_da_conta_em_venda_parcelada():
    # Caso real: 228,96 + frete 11,99 = 240,95; custos de parcelamento 10,83; saldo do Tiny 228,96.
    analise = _analisar(_libs(bruto="228.96", frete="11.99", parcelamento="10.83"), _conta("228.96"))
    g = _grupo(analise)
    assert g.apto_baixa and not g.parcelamento_descontado
    assert g.valor_total == Decimal("228.96") and g.frete_no_caixa == Decimal("11.99")
    tipos = [l.tipo_operacao for l in analise.lancamentos.lancamentos]
    assert ml.TIPO_RECEBIMENTO_FRETE in tipos and "Custos de parcelamento" in tipos


def test_venda_baixada_mantem_o_frete_no_caixa_ate_exportar():
    analise = _analisar(_libs(), _conta("28.73"))
    g = _grupo(analise)
    baixas = {c: "2025-09-03" for c in g.chaves_para_registro()}

    depois = _analisar(_libs(), _conta("0"), baixas=baixas)
    g2 = _grupo(depois)
    assert g2.situacao == ml.SIT_CONCILIADO and g2.frete_no_caixa == Decimal("8.99")
    assert [l.valor for l in _fretes(depois)] == [Decimal("8.99")]

    exportado = _analisar(_libs(), _conta("0"), baixas=baixas, exportados={g.chaves_frete[0]: "2025-09-04"})
    g3 = _grupo(exportado)
    assert g3.situacao == ml.SIT_CONCILIADO and not g3.frete_no_caixa
    assert not _fretes(exportado)


def test_cupom_do_vendedor_e_frete_fora_da_conta():
    # Caso real (Campinas, 07/10/2026, 25 vendas): liberado 56,44 + frete 8,99 = 65,43; cupom pago
    # pelo vendedor 1,92 (coupon_fee, fee_payer=collector); parcelamento 3,95; Tiny 54,52 = 56,44 − 1,92.
    analise = _analisar(_libs(bruto="56.44", frete="8.99", parcelamento="3.95", cupom="1.92"), _conta("54.52"))
    g = _grupo(analise)
    assert g.apto_baixa and g.cupom_descontado and not g.parcelamento_descontado
    assert g.valor_total == Decimal("54.52") and g.frete_no_caixa == Decimal("8.99")
    assert "cupom pago pelo vendedor" in g.mensagem and "Fretes sobre Vendas" in g.mensagem
    tipos = [l.tipo_operacao for l in analise.lancamentos.lancamentos]
    # O cupom já está fora da receita no Tiny: lançar como despesa contaria o desconto duas vezes.
    assert ml.TIPO_CUPOM_VENDEDOR not in tipos
    assert "Custos de parcelamento" in tipos and ml.TIPO_RECEBIMENTO_FRETE in tipos
    cupom_mov = next(m for m in analise.movimentos if m.tipo_operacao == ml.TIPO_CUPOM_VENDEDOR)
    assert cupom_mov.situacao == ml.SIT_DESCONTADO_NA_BAIXA
    ml.avaliar_conta(g)
    assert g.valor_total == Decimal("54.52") and g.valor_produtos == Decimal("54.52") and g.apto_baixa


def test_cupom_com_tiny_pelo_bruto_continua_despesa():
    analise = _analisar(_libs(bruto="56.44", frete="8.99", cupom="1.92"), _conta("65.43"))
    g = _grupo(analise)
    assert g.apto_baixa and not g.cupom_descontado and not g.frete_no_caixa
    assert ml.TIPO_CUPOM_VENDEDOR in [l.tipo_operacao for l in analise.lancamentos.lancamentos]


def test_cupom_que_nao_fecha_continua_divergente():
    analise = _analisar(_libs(bruto="56.44", frete="8.99", cupom="1.92"), _conta("54.00"))
    g = _grupo(analise)
    assert g.situacao == ml.SIT_VALOR_DIVERGENTE and not g.cupom_descontado and not g.frete_no_caixa
    assert g.valor_total == Decimal("65.43")


# ─── rotina: a baixa no Tiny vai só pelo produto ──────────────────────────────


class _MPFrete:
    def liberacoes(self, de, ate, progresso=None):
        return _libs()


class _MLFrete:
    def pedidos(self, de, ate, progresso=None):
        return PEDIDOS_ML

    def pedido(self, pid):
        return None


class _TinyFrete(_Tiny):
    def __init__(self):
        super().__init__()
        self.contas = {"Davi Rocha": [_conta("28.73")]}
        self.situacao_atual = {90: "aberto"}

    def list_pedidos_v3(self, token, data_inicial=None, data_final=None, numero_pedido_ecommerce=None, max_pages=300):
        return PEDIDOS_TINY

    def obter_conta_receber_v3(self, token, cid):
        sit = self.situacao_atual[cid]
        saldo = 0 if sit == "pago" else 28.73
        return {"situacao": sit, "valor": 28.73, "saldo": saldo, "valorPago": 28.73 - saldo}


def test_rotina_baixa_so_o_produto_e_nao_registra_o_frete(tmp_path):
    tiny = _TinyFrete()
    r = _rotina(tmp_path, ml_cliente=_MLFrete, tiny=tiny)
    r.fabrica_mp = lambda e: _MPFrete()
    ex = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    analise_id = ex["empresas"]["norvia_campinas"]["analise_id"]
    g = _grupo(r.estado.analise(analise_id))
    assert g.apto_baixa and g.frete_no_caixa == Decimal("8.99")

    res = r.baixar(analise_id, [g.id])
    assert res["total_sucessos"] == 1
    assert len(tiny.baixas) == 1
    cid, kw = tiny.baixas[0]
    assert cid == 90 and Decimal(str(kw.get("valor_pago") or kw.get("valor"))) == Decimal("28.73")
    registradas = r.estado.ler().get("baixas") or {}
    assert g.chaves_frete[0] not in registradas
    assert all(c in registradas for c in g.chaves_produtos)

    # Rodada seguinte: venda conciliada, frete ainda na planilha de lançamentos.
    ex2 = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    a2 = r.estado.analise(ex2["empresas"]["norvia_campinas"]["analise_id"])
    assert _grupo(a2).situacao == ml.SIT_CONCILIADO
    assert [l.valor for l in _fretes(a2)] == [Decimal("8.99")]


def _parcela(n, valor, valor_pago="0", situacao="aberto"):
    saldo = str(Decimal(valor) - Decimal(valor_pago))
    return {"id": 90 + n, "situacao": situacao, "valor": valor, "saldo": saldo, "valorPago": valor_pago,
            "historico": f"Ref. ao pedido de venda - OC nº {VENDA} - parcela {n}/2"}


def _analisar_parcelas(libs, parcelas):
    return ml.analisar("f1", NORVIA, libs, PEDIDOS_ML, PEDIDOS_TINY, lambda nome: list(parcelas),
                       (date(2025, 9, 1), date(2025, 9, 2)))


def test_frete_fora_da_conta_com_venda_em_parcelas_intactas():
    # Caso real (Campinas 01/09): produtos 68,11 + frete 8,99; Tiny dividiu os 68,11 em parcelas.
    analise = _analisar_parcelas(_libs(bruto="68.11"), [_parcela(1, "34.06"), _parcela(2, "34.05")])
    g = _grupo(analise)
    assert g.apto_baixa and g.valor_total == Decimal("68.11") and g.frete_no_caixa == Decimal("8.99")
    (l,) = _fretes(analise)
    assert l.valor == Decimal("8.99") and l.categoria == "Fretes sobre Vendas"


def test_parcela_ja_paga_nao_presume_frete():
    # Uma parcela já baixada: o excedente pode ser outra coisa, fica divergente.
    analise = _analisar_parcelas(
        _libs(bruto="68.11"),
        [_parcela(1, "10.00", valor_pago="10.00", situacao="pago"), _parcela(2, "34.06"), _parcela(3, "34.05")],
    )
    g = _grupo(analise)
    assert g.situacao == ml.SIT_VALOR_DIVERGENTE and not g.frete_no_caixa and not _fretes(analise)
