"""
Conta a receber achada pela nota fiscal do pedido quando a busca pelo nome do cliente falha.

06/11/2026: venda 2000026137867754 (Instituto Exemplo Sa (centro de Pesquisas, ...) ficava
"Conta não localizada": GET /contas-receber?nomeCliente= devolvia 0 contas (nem com "Instituto Vital
Brazil"), mas a conta #895456079 existe, ligada à nota fiscal do pedido, e o histórico cita a venda.
"""
from datetime import date
from decimal import Decimal

from app import ml_reconciliation as ml
from app import ml_reconciliation_rotina as rot
from app.config import Settings

from tests.test_ml_reconciliation import NORVIA, LIBERACOES, PEDIDOS_ML, PEDIDOS_TINY

CONTA_ANA = {"id": 10, "historico": "Ref. a NF nº 30078, Ana Souza - OC nº 3000000000000001",
             "situacao": "aberto", "valor": 110, "saldo": 110}


def _grupo_ana(contas_da_venda):
    analise = ml.analisar("a1", NORVIA, LIBERACOES, PEDIDOS_ML, PEDIDOS_TINY, lambda nome: [],
                          (date(2025, 9, 1), date(2025, 9, 2)), contas_da_venda=contas_da_venda)
    return next(g for g in analise.grupos if g.id_venda == "3000000000000001")


def test_nome_sem_conta_acha_pela_nota_fiscal():
    pedidos = []
    g = _grupo_ana(lambda venda: pedidos.append(venda) or [CONTA_ANA])
    assert (g.situacao, g.conta_id) == (ml.SIT_APTO_BAIXA, 10)
    assert "3000000000000001" in pedidos


def test_conta_da_nota_que_nao_cita_a_venda_nao_vale():
    outra = {**CONTA_ANA, "historico": "OC nº 2000099999999999"}
    g = _grupo_ana(lambda venda: [outra])
    assert g.situacao == ml.SIT_NAO_LOCALIZADO and g.conta_id is None
    assert "pela nota fiscal do pedido" in g.mensagem


def test_busca_pela_nota_que_falha_nao_vira_nao_localizado():
    def falha(venda):
        raise RuntimeError("HTTP 429")

    g = _grupo_ana(falha)
    assert g.situacao == ml.SIT_ERRO_PROCESSAR and "HTTP 429" in g.mensagem


def test_erro_na_busca_pelo_nome_ainda_tenta_a_nota():
    def nome_quebrado(nome):
        raise RuntimeError("HTTP 400")

    analise = ml.analisar("a1", NORVIA, LIBERACOES, PEDIDOS_ML, PEDIDOS_TINY, nome_quebrado,
                          (date(2025, 9, 1), date(2025, 9, 2)), contas_da_venda=lambda v: [CONTA_ANA])
    g = next(g for g in analise.grupos if g.id_venda == "3000000000000001")
    assert (g.situacao, g.conta_id) == (ml.SIT_APTO_BAIXA, 10)


class _TinyNota:
    def __init__(self):
        self.chamadas = []

    def list_pedidos_v3(self, token, numero_pedido_ecommerce=None, max_pages=300, **kw):
        self.chamadas.append(("pedidos", numero_pedido_ecommerce))
        return [{"id": 777}] if numero_pedido_ecommerce == "2000000000000555" else []

    def obter_pedido_v3(self, token, pedido_id):
        self.chamadas.append(("pedido", pedido_id))
        return {"id": pedido_id, "notaFiscal": {"id": 9000 + pedido_id}, "idNotaFiscal": 9000 + pedido_id}

    def list_contas_receber_v3(self, token, id_nota=None, **kw):
        self.chamadas.append(("contas", id_nota))
        return [{"id": id_nota + 1, "historico": "x"}]


def test_caminho_pedido_nota_contas_com_cache(tmp_path):
    tiny = _TinyNota()
    r = rot.RotinaConciliacaoML(estado=rot.EstadoML(cfg=Settings(DATA_DIR=tmp_path)), cfg=Settings(DATA_DIR=tmp_path),
                                tiny=tiny, obter_token_tiny=lambda e: "tok")
    contas = r._contas_pela_nota("tok", r._pedido_da_venda("tok", [{"id": 895342184, "ecommerce": {"numeroPedidoEcommerce": "2000026137867754"}}]))
    assert contas("2000026137867754") == [{"id": 9000 + 895342184 + 1, "historico": "x"}]
    assert tiny.chamadas == [("pedido", 895342184), ("contas", 9000 + 895342184)], "pedido já lido: sem nova busca"
    contas("2000026137867754")
    assert len(tiny.chamadas) == 2, "mesma venda: cache"
    # Pedido fora dos lidos no período: busca pelo número do ML.
    assert contas("2000000000000555")[0]["id"] == 9000 + 777 + 1
    assert tiny.chamadas[2] == ("pedidos", "2000000000000555")
    assert contas("2000000000000666") == []


def test_consolidada_tenta_de_novo_o_nao_localizado_antigo(tmp_path):
    r = rot.RotinaConciliacaoML(estado=rot.EstadoML(cfg=Settings(DATA_DIR=tmp_path)), cfg=Settings(DATA_DIR=tmp_path),
                                tiny=_TinyNota(), obter_token_tiny=lambda e: "tok")
    antigo = ml.GrupoRecebimento(
        id="G-1", id_venda="2000026137867754", indices=[], chaves=["k1"], valor_total=Decimal("86.72"),
        data="16/08/2026", nome_cliente="Instituto Exemplo Sa (centro de Pesquisas)",
        valor_produtos=Decimal("86.72"), data_venda="20/07/2026", situacao=ml.SIT_NAO_LOCALIZADO,
    )
    conta = {"id": 895456079, "situacao": "aberto", "valor": 86.72, "saldo": 86.72,
             "historico": "Ref. a NF nº 30078, Instituto Exemplo Sa - OC nº 2000026137867754"}
    assert r._relocalizar_herdados([antigo], lambda venda: [conta]) == 1
    assert (antigo.situacao, antigo.conta_id) == (ml.SIT_APTO_BAIXA, 895456079)


class _TinyContaForaDaNota:
    """11/11/2026, venda 2000082629008667 (Marcello): a conta #895400280 cita a venda, mas a nota
    895400543 não tem conta e o filtro nomeCliente devolve 0. Está nas contas com vencimento na
    data da parcela do pedido (28/07)."""

    def __init__(self):
        self.chamadas = []

    def list_pedidos_v3(self, token, numero_pedido_ecommerce=None, **kw):
        return [{"id": 895395240}] if numero_pedido_ecommerce else []

    def obter_pedido_v3(self, token, pedido_id):
        return {"id": pedido_id, "notaFiscal": {"id": 895400543},
                "pagamento": {"parcelas": [{"dias": 0, "data": "2026-07-28 00:00:00", "valor": 995.06}]}}

    def list_contas_receber_v3(self, token, id_nota=None, data_inicial_vencimento=None, data_final_vencimento=None, **kw):
        self.chamadas.append(("nota", id_nota) if id_nota else ("vencimento", data_inicial_vencimento, data_final_vencimento))
        if id_nota:
            return []
        return [
            {"id": 1, "historico": "Ref. ao pedido de venda nº 32600, Outro - OC nº 2000014200000000"},
            {"id": 895400280, "situacao": "aberto", "valor": 995.06, "saldo": 995.06,
             "historico": "Ref. ao pedido de venda nº 32609, Marcello Endrigo Domingues Franceschini 22388250889"
                          " - OC nº 2000082629008667 | Pagamento à vista - Mercado Livre"},
        ]


def test_conta_fora_da_nota_achada_pelo_vencimento_da_parcela(tmp_path):
    tiny = _TinyContaForaDaNota()
    r = rot.RotinaConciliacaoML(estado=rot.EstadoML(cfg=Settings(DATA_DIR=tmp_path)), cfg=Settings(DATA_DIR=tmp_path),
                                tiny=tiny, obter_token_tiny=lambda e: "tok")
    contas = r._contas_pela_nota("tok", r._pedido_da_venda("tok", []))
    achadas = ml.selecionar_contas_da_venda(contas("2000082629008667"), "2000082629008667")
    assert [c["id"] for c in achadas] == [895400280]
    assert tiny.chamadas == [("nota", 895400543), ("vencimento", "2026-07-28", "2026-07-28")]
    contas("2000014200000000")  # outra venda com parcela no mesmo dia: o dia não é lido de novo
    assert tiny.chamadas.count(("vencimento", "2026-07-28", "2026-07-28")) == 1


def test_conta_da_nota_que_cita_a_venda_nao_busca_pelo_vencimento(tmp_path):
    tiny = _TinyContaForaDaNota()
    tiny.list_contas_receber_v3 = lambda token, id_nota=None, **kw: (
        tiny.chamadas.append(("nota", id_nota)) or [{"id": 5, "historico": "OC nº 2000082629008667"}]
    )
    r = rot.RotinaConciliacaoML(estado=rot.EstadoML(cfg=Settings(DATA_DIR=tmp_path)), cfg=Settings(DATA_DIR=tmp_path),
                                tiny=tiny, obter_token_tiny=lambda e: "tok")
    contas = r._contas_pela_nota("tok", r._pedido_da_venda("tok", []))
    assert [c["id"] for c in contas("2000082629008667")] == [5]
    assert tiny.chamadas == [("nota", 895400543)]
