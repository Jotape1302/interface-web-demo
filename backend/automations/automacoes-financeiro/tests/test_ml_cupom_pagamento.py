"""
Cupom pago pelo vendedor que o relatório de liberações NÃO traz em COUPON_AMOUNT (Revesta, 2026-11):
a liberação sai com bruto 54,04, tarifas 8,47 + 8,75 e líquido 34,12, e os 2,70 do cupom viram
"Diferença na liberação". O pagamento no Mercado Pago tem `coupon_fee` (fee_payer=collector) 2,70 e
o Tiny registrou 51,34 = 54,04 − 2,70. A rotina confere no pagamento e a linha vira cupom.
"""
from datetime import date
from decimal import Decimal

from app import ml_reconciliation as ml
from app.ml_apis import ClienteMercadoPago
from tests.test_ml_frete_no_caixa import PEDIDOS_ML, PEDIDOS_TINY, _conta, _grupo
from tests.test_ml_reconciliation import NORVIA, _lib, _rotina, _Tiny


def _libs(liquido="34.12", frete=None):
    libs = [_lib(SOURCE_ID="8001", GROSS_AMOUNT="54.04", NET_CREDIT_AMOUNT=liquido, MP_FEE_AMOUNT="-8.47",
                 SHIPPING_FEE_AMOUNT="-8.75", ORDER_ID="2000000000000009")]
    if frete:
        libs.append(_lib(SOURCE_ID="8002", DESCRIPTION="shipping", NET_CREDIT_AMOUNT=frete, GROSS_AMOUNT=frete,
                         ORDER_ID="2000000000000009"))
    return libs


def _analisar(libs, conta, cupons=None):
    return ml.analisar("c1", NORVIA, libs, PEDIDOS_ML, PEDIDOS_TINY, lambda nome: [conta],
                       (date(2025, 9, 1), date(2025, 9, 2)), cupons_vendedor=cupons)


def _diferencas(analise):
    return [m for m in analise.movimentos if m.tipo_operacao == ml.TIPO_DIFERENCA]


def test_sem_consulta_ao_pagamento_a_diferenca_continua_para_conferir():
    analise = _analisar(_libs(), _conta("51.34"))
    assert _grupo(analise).situacao == ml.SIT_VALOR_DIVERGENTE
    (d,) = _diferencas(analise)
    assert d.valor == Decimal("-2.70")
    assert ml.pagamentos_com_diferenca(analise.movimentos) == ["8001"]


def test_cupom_do_pagamento_igual_a_diferenca_vira_cupom_descontado_na_baixa():
    analise = _analisar(_libs(), _conta("51.34"), cupons={"8001": Decimal("2.70")})
    g = _grupo(analise)
    assert g.apto_baixa and g.cupom_descontado and g.valor_total == Decimal("51.34")
    assert not _diferencas(analise)
    cupom = next(m for m in analise.movimentos if m.tipo_operacao == ml.TIPO_CUPOM_VENDEDOR)
    assert cupom.situacao == ml.SIT_DESCONTADO_NA_BAIXA
    tipos = [l.tipo_operacao for l in analise.lancamentos.lancamentos]
    assert ml.TIPO_CUPOM_VENDEDOR not in tipos and ml.TIPO_DIFERENCA not in tipos
    assert "Tarifa de venda" in tipos and "Tarifa de envio" in tipos


def test_cupom_com_frete_dentro_da_conta():
    # Caso real (Revesta 2,53): 50,79 + frete 2,99 (outro pagamento); Tiny 51,25 = 50,79 − 2,53 + 2,99.
    libs = [_lib(SOURCE_ID="8001", GROSS_AMOUNT="50.79", NET_CREDIT_AMOUNT="40.30", MP_FEE_AMOUNT="-7.96",
                 ORDER_ID="2000000000000009"),
            _lib(SOURCE_ID="8002", DESCRIPTION="shipping", NET_CREDIT_AMOUNT="2.99", GROSS_AMOUNT="2.99",
                 ORDER_ID="2000000000000009")]
    analise = _analisar(libs, _conta("51.25"), cupons={"8001": Decimal("2.53")})
    g = _grupo(analise)
    assert g.apto_baixa and g.cupom_descontado and not g.frete_no_caixa
    assert g.valor_total == Decimal("51.25") and g.ids_pagamento == ["8001", "8002"]


def test_cupom_diferente_da_diferenca_nao_reclassifica():
    analise = _analisar(_libs(), _conta("51.34"), cupons={"8001": Decimal("2.00")})
    assert _grupo(analise).situacao == ml.SIT_VALOR_DIVERGENTE
    assert len(_diferencas(analise)) == 1


def test_cupom_com_tiny_pelo_bruto_vira_despesa_de_cupom():
    analise = _analisar(_libs(), _conta("54.04"), cupons={"8001": Decimal("2.70")})
    g = _grupo(analise)
    assert g.apto_baixa and not g.cupom_descontado
    assert ml.TIPO_CUPOM_VENDEDOR in [l.tipo_operacao for l in analise.lancamentos.lancamentos]


# ─── cliente do Mercado Pago ─────────────────────────────────────────────────


class _MPPagamento(ClienteMercadoPago):
    def __init__(self, pagamento):
        self._pagamento = pagamento

    def _chamar(self, metodo, caminho, acao, **kw):
        return self._pagamento


def test_cupom_vendedor_soma_so_o_coupon_fee_do_vendedor():
    pag = {"fee_details": [
        {"type": "coupon_fee", "amount": 2.7, "fee_payer": "collector"},
        {"type": "coupon_fee", "amount": 1.0, "fee_payer": "payer"},
        {"type": "mercadopago_fee", "amount": 8.47, "fee_payer": "collector"},
    ]}
    assert _MPPagamento(pag).cupom_vendedor("1") == Decimal("2.7")
    assert _MPPagamento({}).cupom_vendedor("1") == Decimal("0")


# ─── rotina ──────────────────────────────────────────────────────────────────


class _MPCupom:
    def __init__(self, cupom="2.70"):
        self.consultas = []
        self.cupom = Decimal(cupom)

    def liberacoes(self, de, ate, progresso=None):
        return _libs()

    def cupom_vendedor(self, pid):
        self.consultas.append(pid)
        return self.cupom


class _MLCupom:
    def pedidos(self, de, ate, progresso=None):
        return PEDIDOS_ML

    def pedido(self, pid):
        return None


class _TinyCupom(_Tiny):
    def __init__(self):
        super().__init__()
        self.contas = {"Davi Rocha": [_conta("51.34")]}
        self.situacao_atual = {90: "aberto"}

    def list_pedidos_v3(self, token, data_inicial=None, data_final=None, numero_pedido_ecommerce=None, max_pages=300):
        return PEDIDOS_TINY

    def obter_conta_receber_v3(self, token, cid):
        return {"situacao": "aberto", "valor": 51.34, "saldo": 51.34, "valorPago": 0}


def test_rotina_confere_o_cupom_no_pagamento(tmp_path):
    mp = _MPCupom()
    r = _rotina(tmp_path, ml_cliente=_MLCupom, tiny=_TinyCupom())
    r.fabrica_mp = lambda e: mp
    ex = r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    g = _grupo(r.estado.analise(ex["empresas"]["norvia_campinas"]["analise_id"]))
    assert g.apto_baixa and g.cupom_descontado and g.cupom_consultado
    assert mp.consultas == ["8001"]  # só o pagamento com diferença, e a consolidada não repete
    consolidada = r.estado.analise("consolidado_norvia_campinas")
    assert _grupo(consolidada).apto_baixa


def test_consolidada_le_o_cupom_de_grupo_antigo_uma_vez(tmp_path):
    mp = _MPCupom()
    r = _rotina(tmp_path, ml_cliente=_MLCupom, tiny=_TinyCupom())
    r.fabrica_mp = lambda e: mp
    antigo = _grupo(_analisar(_libs(), _conta("51.34")))  # fora da janela: sem a linha reclassificada
    antigo.id_venda = "3000000000000077"
    assert antigo.situacao == ml.SIT_VALOR_DIVERGENTE and not antigo.cupom_consultado

    assert r._completar_cupom(NORVIA, [antigo]) == 1
    assert antigo.apto_baixa and antigo.cupom_descontado and antigo.valor_total == Decimal("51.34")
    assert antigo.cupom_consultado and mp.consultas == ["8001"]

    sem_cupom = _grupo(_analisar(_libs(), _conta("51.34")))
    mp0 = _MPCupom("0")
    r.fabrica_mp = lambda e: mp0
    assert r._completar_cupom(NORVIA, [sem_cupom]) == 0
    assert sem_cupom.cupom_consultado and sem_cupom.situacao == ml.SIT_VALOR_DIVERGENTE
    r._completar_cupom(NORVIA, [sem_cupom])
    assert mp0.consultas == ["8001"]  # não consulta de novo


# ─── consolidada: as regras novas valem para grupos fora da janela de 60 dias ─

from tests import test_ml_frete_no_caixa as fr  # noqa: E402


def _consolidada_com(r, grupo, movimentos=()):
    """Consolidada salva com um grupo antigo e análise recente vazia (o grupo saiu da janela)."""
    antiga = fr._analisar(fr._libs(), fr._conta("28.73"))
    existente = ml.Analise(**{**antiga.__dict__, "id": "consolidado_norvia_campinas",
                              "grupos": [grupo], "movimentos": list(movimentos)})
    r.estado.salvar_analise(existente)
    vazia = ml.analisar("v1", NORVIA, [], [], [], lambda nome: [], (date(2025, 11, 1), date(2025, 11, 2)))
    r.estado.salvar_analise(vazia)
    return r._atualizar_visao_consolidada(NORVIA, vazia)


def _divergente_antigo(sem_copia=False):
    """Grupo como ficou antes de 7dfefef: frete fora da conta tratado como divergente."""
    antiga = fr._analisar(fr._libs(), fr._conta("28.73"))
    g = fr._grupo(antiga)
    ml._restaurar_descontos(g)
    g.situacao = ml.SIT_VALOR_DIVERGENTE
    if sem_copia:
        g.chaves_frete, g.movimentos_frete, g.indices_frete = [], [], []
    return g, antiga


def test_consolidada_reavalia_divergente_antigo_e_lanca_o_frete(tmp_path):
    r = _rotina(tmp_path)
    g, _ = _divergente_antigo()
    c = _consolidada_com(r, g)
    (gc,) = c.grupos
    assert gc.apto_baixa and gc.frete_no_caixa == Decimal("8.99") and gc.valor_total == Decimal("28.73")
    (l,) = [l for l in c.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE]
    assert l.categoria == "Fretes sobre Vendas" and l.valor == Decimal("8.99") and l.contato == "Davi Rocha"
    assert l.chave == gc.chaves_frete[0]
    assert len({m.indice for m in c.movimentos}) == len(c.movimentos)


def test_consolidada_acha_a_linha_do_frete_nas_analises_salvas(tmp_path):
    r = _rotina(tmp_path)
    g, antiga = _divergente_antigo(sem_copia=True)
    r.estado.salvar_analise(antiga)  # a linha do frete só existe na análise de origem
    c = _consolidada_com(r, g)
    (gc,) = c.grupos
    assert gc.apto_baixa and gc.chaves_frete and gc.movimentos_frete
    assert [l.valor for l in c.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE] == [Decimal("8.99")]
    assert gc.chaves_frete[0] not in gc.chaves_para_registro()


def test_consolidada_sem_a_linha_do_frete_nao_deixa_apto(tmp_path):
    r = _rotina(tmp_path)
    g, _ = _divergente_antigo(sem_copia=True)
    c = _consolidada_com(r, g)
    (gc,) = c.grupos
    assert gc.situacao == ml.SIT_VALOR_DIVERGENTE and not gc.frete_no_caixa
    assert "à mão" in gc.mensagem
    assert not [l for l in c.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE]


def test_consolidada_nao_relanca_frete_ja_exportado(tmp_path):
    r = _rotina(tmp_path)
    g, _ = _divergente_antigo()
    r.estado.registrar_exportados(g.chaves_frete)
    c = _consolidada_com(r, g)
    (gc,) = c.grupos
    assert gc.apto_baixa and gc.frete_no_caixa == Decimal("8.99")
    assert not [l for l in c.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE]
