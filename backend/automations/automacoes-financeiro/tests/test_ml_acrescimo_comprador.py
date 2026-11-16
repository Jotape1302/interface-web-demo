"""
Acréscimo pago pelo comprador no parcelamento (Campinas, 2026-11): o relatório de liberações traz o
bruto com o acréscimo e uma linha "Custos de parcelamento" maior que ele (ex.: 6,62), e o Tiny tem o
preço sem o acréscimo (excedente 3,23). O pagamento no Mercado Pago tem `charges_details`
financing_transfer do payer = 3,23. A baixa sai sem os 3,23 e a linha de parcelamento é dividida:
3,23 descontado na baixa e 3,39 continua como lançamento de caixa.
"""
from datetime import date
from decimal import Decimal

from app import ml_reconciliation as ml
from app.ml_apis import ClienteMercadoPago
from tests import test_ml_frete_no_caixa as fr
from tests.test_ml_reconciliation import NORVIA, _rotina

# bruto 28,73 + frete 8,99 (mesmo pagamento) = 37,72; Tiny 34,49 = 37,72 − 3,23 de acréscimo.
LIBS = fr._libs(parcelamento="6.62")


def _analisar(conta="34.49", acrescimo="3.23", bloqueadas=(), consultas=None):
    def ler(g):
        if consultas is not None:
            consultas.append(g.id_venda)
        return Decimal(acrescimo) if acrescimo is not None else None

    return ml.analisar("a1", NORVIA, LIBS, fr.PEDIDOS_ML, fr.PEDIDOS_TINY, lambda nome: [fr._conta(conta)],
                       (date(2025, 9, 1), date(2025, 9, 2)), acrescimo_do_grupo=ler, bloqueadas=bloqueadas)


def _parcelamento(analise):
    return [l for l in analise.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_CUSTO_PARCELAMENTO]


def test_acrescimo_igual_ao_excedente_divide_a_linha_de_parcelamento():
    analise = _analisar()
    g = fr._grupo(analise)
    assert g.apto_baixa and g.acrescimo_descontado and not g.parcelamento_descontado
    assert g.valor_total == Decimal("34.49") and "acréscimo" in g.mensagem
    (l,) = _parcelamento(analise)
    assert l.valor == Decimal("3.39") and l.desconto_baixa == Decimal("3.23")
    mov = next(m for m in analise.movimentos if m.tipo_operacao == ml.TIPO_CUSTO_PARCELAMENTO)
    assert mov.valor == Decimal("-6.62") and mov.situacao == ml.SIT_LANCAMENTO_CRIADO  # relatório intacto


def test_acrescimo_diferente_do_excedente_continua_divergente():
    analise = _analisar(acrescimo="3.00")
    g = fr._grupo(analise)
    assert g.situacao == ml.SIT_VALOR_DIVERGENTE and g.acrescimo_consultado and not g.acrescimo_descontado
    assert [l.valor for l in _parcelamento(analise)] == [Decimal("6.62")]


def test_so_divergente_com_parcelamento_consulta_o_pagamento():
    consultas = []
    analise = _analisar(conta="37.72", consultas=consultas)  # Tiny pelo bruto: apto sem consulta
    assert fr._grupo(analise).apto_baixa and consultas == []
    assert [l.valor for l in _parcelamento(analise)] == [Decimal("6.62")]


def test_consulta_com_erro_fica_para_depois():
    analise = _analisar(acrescimo=None)
    g = fr._grupo(analise)
    assert g.situacao == ml.SIT_VALOR_DIVERGENTE and not g.acrescimo_consultado


def test_parcelamento_ja_exportado_fica_cheio_e_o_acrescimo_entra_no_caixa():
    # Caso real (Campinas, venda 2000027262486935): a planilha já levou os 6,62 cheios.
    chave = fr._grupo(_analisar(conta="37.72")).chaves_parcelamento[0]
    analise = _analisar(bloqueadas={chave})
    g = fr._grupo(analise)
    assert g.apto_baixa and g.acrescimo_descontado and g.acrescimo_bloqueado
    assert g.valor_total == Decimal("34.49") and "entrada em Intermediação" in g.mensagem
    (l,) = _parcelamento(analise)
    assert l.valor == Decimal("6.62") and l.desconto_baixa == 0
    (e,) = [l for l in analise.lancamentos.lancamentos if l.tipo_operacao == ml.TIPO_ACRESCIMO_COMPRADOR]
    assert (e.tipo, e.fluxo, e.valor, e.categoria) == ("C", "RECEBIMENTO", Decimal("3.23"), "Intermediação de Negócios")
    assert e.chave == chave + ml.SUFIXO_ACRESCIMO and ml.TIPO_ACRESCIMO_COMPRADOR in e.historico
    # Na baixa (cópia do grupo, sem a entrada): a entrada é refeita uma vez só.
    lancs = ml.ajustar_lancamentos_parcelamento(ml.ajustar_lancamentos_parcelamento([l, e], g), g)
    assert sorted((x.tipo_operacao, x.valor) for x in lancs) == [
        (ml.TIPO_ACRESCIMO_COMPRADOR, Decimal("3.23")), (ml.TIPO_CUSTO_PARCELAMENTO, Decimal("6.62"))]
    ml._restaurar_descontos(g)
    assert [x.tipo_operacao for x in ml.ajustar_lancamentos_parcelamento([l, e], g)] == [ml.TIPO_CUSTO_PARCELAMENTO]


def test_parcelamento_inteiro_continua_valendo_antes_do_acrescimo():
    # Tiny 31,10 = 37,72 − 6,62: a regra antiga (parcelamento inteiro) fecha primeiro.
    analise = _analisar(conta="31.10")
    g = fr._grupo(analise)
    assert g.apto_baixa and g.parcelamento_descontado and not g.acrescimo_descontado
    assert not _parcelamento(analise)


def test_restaurar_volta_ao_bruto():
    g = fr._grupo(_analisar())
    ml._restaurar_descontos(g)
    assert g.valor_total == Decimal("37.72") and not g.acrescimo_descontado


def test_ajuste_das_copias_e_idempotente():
    analise = _analisar()
    g = fr._grupo(analise)
    (l,) = _parcelamento(analise)
    cheio = ml.Lancamento(**{**l.__dict__, "valor": Decimal("6.62"), "desconto_baixa": Decimal("0")})
    (a,) = ml.ajustar_lancamentos_parcelamento([cheio], g)
    (b,) = ml.ajustar_lancamentos_parcelamento([a], g)
    assert a.valor == b.valor == Decimal("3.39")
    ml._restaurar_descontos(g)
    (c,) = ml.ajustar_lancamentos_parcelamento([a], g)
    assert c.valor == Decimal("6.62") and c.desconto_baixa == 0


def test_grupo_salvo_mantem_o_acrescimo(tmp_path):
    analise = _analisar()
    volta = ml.analise_de_dict(ml.analise_para_dict(analise))
    g = fr._grupo(volta)
    assert g.acrescimo_descontado and g.valor_acrescimo == Decimal("3.23")
    (l,) = _parcelamento(volta)
    assert l.desconto_baixa == Decimal("3.23")


# ─── cliente do Mercado Pago ─────────────────────────────────────────────────


class _MPPagamento(ClienteMercadoPago):
    def __init__(self, pagamento):
        self._pagamento = pagamento

    def _chamar(self, metodo, caminho, acao, **kw):
        return self._pagamento


def test_acrescimo_soma_so_o_financing_transfer_do_comprador():
    pag = {"charges_details": [
        {"name": "financing_transfer", "accounts": {"from": "payer", "to": "collector"},
         "amounts": {"original": 3.5, "refunded": 0.27}},
        {"name": "mp_financing_fee", "accounts": {"from": "collector", "to": "mp"}, "amounts": {"original": 6.62}},
        {"name": "financing_transfer", "accounts": {"from": "collector", "to": "payer"}, "amounts": {"original": 9}},
    ]}
    assert _MPPagamento(pag).acrescimo_comprador("1") == Decimal("3.23")
    assert _MPPagamento({}).acrescimo_comprador("1") == Decimal("0")


# ─── consolidada: grupo antigo ───────────────────────────────────────────────


class _MPAcrescimo:
    def __init__(self, valor="3.23"):
        self.valor = Decimal(valor)
        self.consultas = []

    def acrescimo_comprador(self, pid):
        self.consultas.append(pid)
        return self.valor


def test_consolidada_le_o_acrescimo_de_grupo_antigo_e_ajusta_a_copia(tmp_path):
    r = _rotina(tmp_path)
    mp = _MPAcrescimo()
    r.fabrica_mp = lambda e: mp
    origem = ml.analisar("o1", NORVIA, LIBS, fr.PEDIDOS_ML, fr.PEDIDOS_TINY, lambda nome: [fr._conta("34.49")],
                         (date(2025, 9, 1), date(2025, 9, 2)))
    antigo = fr._grupo(origem)
    assert antigo.situacao == ml.SIT_VALOR_DIVERGENTE
    antigo.lancamentos_caixa = [ml._para_json(l.__dict__) for l in origem.lancamentos.lancamentos
                                if l.tipo_operacao == ml.TIPO_CUSTO_PARCELAMENTO]
    antigo.chaves_parcelamento = []  # grupo de antes da regra

    assert r._completar_acrescimo(NORVIA, [antigo]) == 1
    assert antigo.apto_baixa and antigo.acrescimo_descontado and mp.consultas == ["8001"]
    assert antigo.chaves_parcelamento
    vazia = ml.analisar("v1", NORVIA, [], [], [], lambda nome: [], (date(2025, 11, 1), date(2025, 11, 2)))
    lancs, _ = r._lancamentos_do_grupo(vazia, antigo)
    assert [l.valor for l in lancs if l.tipo_operacao == ml.TIPO_CUSTO_PARCELAMENTO] == [Decimal("3.39")]

    r._completar_acrescimo(NORVIA, [antigo])
    assert mp.consultas == ["8001"]  # não consulta de novo


def _antigo(r):
    origem = ml.analisar("o1", NORVIA, LIBS, fr.PEDIDOS_ML, fr.PEDIDOS_TINY, lambda nome: [fr._conta("34.49")],
                         (date(2025, 9, 1), date(2025, 9, 2)))
    antigo = fr._grupo(origem)
    antigo.lancamentos_caixa = [ml._para_json(l.__dict__) for l in origem.lancamentos.lancamentos
                                if l.tipo_operacao == ml.TIPO_CUSTO_PARCELAMENTO]
    return antigo


def test_consolidada_com_parcelamento_ja_exportado_lanca_a_entrada(tmp_path):
    r = _rotina(tmp_path)
    r.fabrica_mp = lambda e: _MPAcrescimo()
    antigo = _antigo(r)
    r.estado.registrar_exportados(antigo.chaves_parcelamento)
    assert r._completar_acrescimo(NORVIA, [antigo]) == 1
    assert antigo.apto_baixa and antigo.acrescimo_bloqueado
    vazia = ml.analisar("v1", NORVIA, [], [], [], lambda nome: [], (date(2025, 11, 1), date(2025, 11, 2)))
    lancs, _ = r._lancamentos_do_grupo(vazia, antigo)
    ja = r._ja_no_caixa()
    assert [(l.tipo_operacao, l.valor) for l in lancs if ml.chave_lancamento(l) not in ja] == [
        (ml.TIPO_ACRESCIMO_COMPRADOR, Decimal("3.23"))]
    assert not r.estado.acrescimos_divididos()


def test_linha_dividida_e_exportada_depois_continua_dividida(tmp_path):
    r = _rotina(tmp_path)
    r.fabrica_mp = lambda e: _MPAcrescimo()
    antigo = _antigo(r)
    assert r._completar_acrescimo(NORVIA, [antigo]) == 1 and not antigo.acrescimo_bloqueado
    assert r.estado.acrescimos_divididos() == set(antigo.chaves_parcelamento)
    # A planilha leva a linha dividida (3,39); a reavaliação seguinte não pode lançar o acréscimo à parte.
    r.estado.registrar_exportados(antigo.chaves_parcelamento)
    de_novo = _antigo(r)
    assert r._completar_acrescimo(NORVIA, [de_novo]) == 1
    assert not de_novo.acrescimo_bloqueado
    vazia = ml.analisar("v1", NORVIA, [], [], [], lambda nome: [], (date(2025, 11, 1), date(2025, 11, 2)))
    lancs, _ = r._lancamentos_do_grupo(vazia, de_novo)
    assert not [l for l in lancs if l.tipo_operacao == ml.TIPO_ACRESCIMO_COMPRADOR]


class _MPPorPagamento:
    """Acréscimo só no pagamento do produto; o do frete (liberação à parte) não tem."""

    def __init__(self, por_pagamento):
        self.por_pagamento = {k: Decimal(v) for k, v in por_pagamento.items()}
        self.consultas = []

    def acrescimo_comprador(self, pid):
        self.consultas.append(pid)
        return self.por_pagamento.get(pid, Decimal("0"))


def test_pagamentos_do_grupo_antigo_saem_das_chaves():
    g = ml.GrupoRecebimento(id="G-1", id_venda="2000096447709203", indices=[], valor_total=Decimal("46.24"),
                            chaves=["v2|170194868995|2026-08-14T08:25|Recebimento de frete",
                                    "v2|171086519892|2026-08-14T08:25|Recebimento",
                                    "170194868995|14/08/2026|Recebimento|1.00|"],
                            id_operacao="170194868995", data="14/08/2026", nome_cliente="Marcos Exemplo Cunha")
    assert ml.pagamentos_do_grupo(g) == ["170194868995", "171086519892"]
    g.ids_pagamento = ["9"]
    assert ml.pagamentos_do_grupo(g) == ["9"]


def test_grupo_antigo_le_o_acrescimo_em_todos_os_pagamentos_e_nao_so_no_do_frete(tmp_path):
    """11/11/2026, venda 2000096447709203 (Marcos): produto (pagamento 171086519892, acréscimo 0,91)
    e frete (170194868995) liberados à parte. O grupo antigo não tinha `ids_pagamento` e o acréscimo
    era lido só no pagamento do frete: 0, e o grupo ficava 'valor acima do saldo' para sempre."""
    r = _rotina(tmp_path)
    antigo = _antigo(r)
    pagamento_produto = antigo.chaves[0].split("|")[1]
    antigo.ids_pagamento = []
    antigo.id_operacao = "170194868995"
    antigo.chaves = ["v2|170194868995|x|Recebimento de frete"] + antigo.chaves
    antigo.acrescimo_consultado = True  # leitura antiga, só no pagamento do frete
    antigo.valor_acrescimo = Decimal("0")
    mp = _MPPorPagamento({pagamento_produto: "3.23"})
    r.fabrica_mp = lambda e: mp

    assert ml.precisa_acrescimo(antigo)
    assert r._completar_acrescimo(NORVIA, [antigo]) == 1
    assert antigo.apto_baixa and antigo.acrescimo_descontado
    assert set(mp.consultas) == {"170194868995", pagamento_produto}
    assert not ml.precisa_acrescimo(antigo)  # pagamentos gravados: não lê de novo
