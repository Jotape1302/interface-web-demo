"""
Tarifa de venda em partes no caixa do Tiny, como a integração do próprio Tiny lança (decisão do
usuário, 12/11/2026): custo por vender no ML, taxa de recebimento e custo por cobrar no MP, lidos do
pagamento no Mercado Pago e todos em Intermediação de Negócios. Só divide quando as partes fecham
EXATAMENTE com a linha do relatório; nunca lança a mesma parte duas vezes.
"""
from decimal import Decimal

from app import ml_reconciliation as ml
from app import ml_reconciliation_rotina as rot

from tests.test_ml_caixa_na_baixa import _TinyCaixa, _baixar_ana
from tests.test_ml_reconciliation import _MP

D = Decimal


def test_divide_como_o_tiny_na_ordem_do_caixa():
    # Venda 2000028929380354 (Campinas): 6,74 = 4,88 + 0,18 + 1,68.
    cobrancas = [("mp_financing_1x_fee", D("0.18")), ("mp_processing_fee", D("1.68")), ("ml_sale_fee", D("4.88"))]
    assert ml.dividir_tarifa_venda(D("6.74"), cobrancas) == [
        ("ml_sale_fee", "Custo por vender no Mercado Livre", D("4.88")),
        ("mp_financing_1x_fee", "Taxa de recebimento", D("0.18")),
        ("mp_processing_fee", "Custo por cobrar no Mercado Pago", D("1.68")),
    ]


def test_cobranca_desconhecida_fica_de_fora_e_soma_diferente_nao_divide():
    com_parcelamento = [("ml_sale_fee", D("4.88")), ("mp_processing_fee", D("1.68")), ("financing_fee", D("3.23"))]
    assert [n for n, _, _ in ml.dividir_tarifa_venda(D("6.56"), com_parcelamento)] == ["ml_sale_fee", "mp_processing_fee"]
    assert ml.dividir_tarifa_venda(D("6.75"), com_parcelamento) == []
    # Só uma cobrança conhecida: nada a dividir.
    assert ml.dividir_tarifa_venda(D("4.88"), [("ml_sale_fee", D("4.88"))]) == []
    assert ml.dividir_tarifa_venda(D("6.74"), []) == []


def test_duvida_nao_divide():
    # Nome repetido ou mais de uma combinação que fecha: lança inteira.
    assert ml.dividir_tarifa_venda(D("2.00"), [("ml_sale_fee", D("1.00")), ("ml_sale_fee", D("1.00"))]) == []
    ambiguas = [("ml_sale_fee", D("1.00")), ("mp_financing_1x_fee", D("1.00")), ("mp_processing_fee", D("1.00"))]
    assert ml.dividir_tarifa_venda(D("2.00"), ambiguas) == []


class _MPTarifa(_MP):
    def __init__(self, cobrancas=None, erro=None):
        self.cobrancas = cobrancas if cobrancas is not None else [
            ("ml_sale_fee", D("9.00")), ("mp_financing_1x_fee", D("0.40")), ("mp_processing_fee", D("3.10")),
            ("financing_fee", D("1.00")),
        ]
        self.erro = erro
        self.consultas = []

    def cobrancas_tarifa(self, pid):
        self.consultas.append(pid)
        if self.erro:
            raise self.erro
        return self.cobrancas


def _com_mp(mp):
    def antes(r, analise):
        r.fabrica_mp = lambda e: mp
    return antes


def test_baixa_lanca_a_tarifa_de_venda_em_partes(tmp_path):
    tiny = _TinyCaixa()
    mp = _MPTarifa()
    r, res, analise = _baixar_ana(tmp_path, tiny, antes=_com_mp(mp))
    assert res["total_sucessos"] == 1
    assert [(c["valor"], c["categoria_id"]) for c in tiny.caixa] == [
        (D("9.00"), 31), (D("0.40"), 31), (D("3.10"), 31),  # Intermediação de Negócios
        (D("7.50"), 32),  # tarifa de envio, como antes
    ]
    assert {c["historico"] for c in tiny.caixa} == {"OC 3000000000000001"}
    assert "4 lançamento(s) de caixa criado(s)" in res["resultados"][0]["mensagem"]
    assert len(mp.consultas) == 1, "um GET por pagamento"
    tarifa = next(l for l in analise.lancamentos.lancamentos
                  if l.tipo_operacao == "Tarifa de venda" and "3000000000000001" in l.historico)
    chave = ml.chave_lancamento(tarifa)
    registro = r.estado.lancamentos_tiny()
    assert registro[chave]["dividida_em"] == [chave + "|parte:ml_sale_fee", chave + "|parte:mp_financing_1x_fee",
                                              chave + "|parte:mp_processing_fee"]
    assert [registro[c]["valor"] for c in registro[chave]["dividida_em"]] == ["9.00", "0.40", "3.10"]
    assert chave in r.estado.lancamentos_exportados(), "a linha inteira sai da planilha"


def test_falha_numa_parte_repete_so_a_que_faltou(tmp_path):
    class _FalhaNaSegunda(_TinyCaixa):
        def criar_lancamento_caixa_v3(self, token, **kw):
            if kw["valor"] == D("0.40") and not getattr(self, "ja_falhou", False):
                self.ja_falhou = True
                raise RuntimeError("HTTP 500")
            return super().criar_lancamento_caixa_v3(token, **kw)

    tiny = _FalhaNaSegunda()
    r, res, analise = _baixar_ana(tmp_path, tiny, antes=_com_mp(_MPTarifa()))
    tarifa = next(l for l in analise.lancamentos.lancamentos
                  if l.tipo_operacao == "Tarifa de venda" and "3000000000000001" in l.historico)
    chave = ml.chave_lancamento(tarifa)
    registro = r.estado.lancamentos_tiny()
    assert chave not in registro, "linha inteira só conta com todas as partes"
    assert chave + "|parte:mp_financing_1x_fee" not in registro
    assert "Taxa de recebimento R$ 0.40: HTTP 500" in res["resultados"][0]["mensagem"]

    tiny.caixa.clear()
    grupo = next(g for g in analise.grupos if g.id_venda == "3000000000000001")
    contas = [{"id": 10, "historico": "OC 3000000000000001"}]
    criados, problemas = r._lancar_caixa_da_venda(
        ml.EMPRESAS_ML["norvia_campinas"], analise, grupo, "tok", 702641458, contas, "Fulano", rot.LogExecucao(),
    )
    assert (criados, problemas) == (1, [])
    assert [c["valor"] for c in tiny.caixa] == [D("0.40")]
    assert r.estado.lancamentos_tiny()[chave]["dividida_em"][1] == chave + "|parte:mp_financing_1x_fee"

    # Terceira vez: nada a lançar.
    tiny.caixa.clear()
    r._lancar_caixa_da_venda(
        ml.EMPRESAS_ML["norvia_campinas"], analise, grupo, "tok", 702641458, contas, "Fulano", rot.LogExecucao(),
    )
    assert tiny.caixa == []


def test_cobrancas_que_nao_fecham_lancam_a_tarifa_inteira(tmp_path):
    tiny = _TinyCaixa()
    mp = _MPTarifa(cobrancas=[("ml_sale_fee", D("9.00")), ("mp_processing_fee", D("3.00"))])
    r, res, _ = _baixar_ana(tmp_path, tiny, antes=_com_mp(mp))
    assert [c["valor"] for c in tiny.caixa] == [D("12.50"), D("7.50")]
    assert not any("dividida_em" in v for v in r.estado.lancamentos_tiny().values())


def test_mercado_pago_fora_do_ar_lanca_a_tarifa_inteira(tmp_path):
    tiny = _TinyCaixa()
    r, res, _ = _baixar_ana(tmp_path, tiny, antes=_com_mp(_MPTarifa(erro=RuntimeError("HTTP 503"))))
    assert res["total_sucessos"] == 1
    assert [c["valor"] for c in tiny.caixa] == [D("12.50"), D("7.50")]


def test_desligado_lanca_a_tarifa_inteira(tmp_path):
    tiny = _TinyCaixa()
    mp = _MPTarifa()

    def antes(r, analise):
        r.fabrica_mp = lambda e: mp
        r.cfg.ML_DIVIDIR_TARIFA_VENDA = False

    _baixar_ana(tmp_path, tiny, antes=antes)
    assert [c["valor"] for c in tiny.caixa] == [D("12.50"), D("7.50")]
    assert mp.consultas == []
