"""
Venda de pacote com o Tiny gravando o número do PEDIDO (11/11/2026, Luis Henrique Exemplo):
no ML o pacote é 2000057678923331 e o pedido 2000088621286074 (pagamentos 172584645148 do produto e
171685744887 do frete). A conciliação usa o pacote como número da venda; o pedido do Tiny e a conta
#895469770 citam o pedido ("OC nº 2000088621286074"). Ficava "Conta não localizada", e o frete, num
grupo "sem venda" antigo, virou um "sem cliente" repetido.
"""
from decimal import Decimal

from app import ml_reconciliation as ml
from app import ml_reconciliation_rotina as rot
from app.config import Settings

PACOTE, PEDIDO = "2000057678923331", "2000088621286074"
PAG_PRODUTO, PAG_FRETE = "172584645148", "171685744887"
CONTA = {"id": 895469770, "situacao": "aberto", "valor": 1421.69, "saldo": 1421.69,
         "historico": f"Ref. ao pedido de venda nº 32843, Luis Henrique Exemplo - OC nº {PEDIDO} | Pagamento à vista - Mercado Livre"}


def _mov(indice, pagamento, valor, tipo=ml.TIPO_RECEBIMENTO):
    return ml.Movimento(indice=indice, data="04/09/2026", tipo_operacao=tipo, descricao_mp="", id_pagamento=pagamento,
                        id_pedido=PEDIDO, id_pacote=PACOTE, valor=Decimal(valor), linha_relatorio=indice,
                        data_hora=f"2026-09-04T10:0{indice}", data_venda="07/08/2026",
                        nome_cliente="Luis Henrique Exemplo")


def _grupo(**kw):
    base = dict(id="G-1", id_venda=PACOTE, indices=[], chaves=[], valor_total=Decimal("1421.69"), data="04/09/2026",
                nome_cliente="Luis Henrique Exemplo", valor_produtos=Decimal("1421.69"),
                data_venda="07/08/2026", id_operacao=PAG_PRODUTO)
    base.update(kw)
    return ml.GrupoRecebimento(**base)


def test_grupo_guarda_o_pedido_do_pacote():
    g = ml.obter_grupos([_mov(1, PAG_PRODUTO, "1369.28"), _mov(2, PAG_FRETE, "52.41")])[0]
    assert g.id_venda == PACOTE and g.ids_pedido == [PEDIDO]
    assert ml.numeros_da_venda(g) == [PACOTE, PEDIDO]


def test_conta_que_cita_o_pedido_do_pacote_e_achada():
    g = _grupo(ids_pedido=[PEDIDO])
    ml.localizar_contas([g], lambda nome: [CONTA])
    assert (g.situacao, g.conta_id) == (ml.SIT_APTO_BAIXA, 895469770)


def test_sem_o_pedido_continua_nao_localizado_e_cita_os_numeros():
    g = _grupo()
    ml.localizar_contas([g], lambda nome: [CONTA])
    assert g.situacao == ml.SIT_NAO_LOCALIZADO and PACOTE in g.mensagem


class _MP:
    def __init__(self):
        self.consultas = []

    def pedido_do_pagamento(self, pid):
        self.consultas.append(pid)
        return PEDIDO


def _rotina(tmp_path):
    cfg = Settings(DATA_DIR=tmp_path)
    return rot.RotinaConciliacaoML(estado=rot.EstadoML(cfg=cfg), cfg=cfg, tiny=object(), obter_token_tiny=lambda e: "tok")


def test_herdado_antigo_busca_o_pedido_pelo_pagamento_e_acha_a_conta(tmp_path):
    r = _rotina(tmp_path)
    g = _grupo(situacao=ml.SIT_NAO_LOCALIZADO,
               chaves=[f"v2|{PAG_PRODUTO}|x|Recebimento", f"v2|{PAG_FRETE}|y|Recebimento"])
    mp = _MP()
    pedidas = []

    def contas_da_venda(numero):
        pedidas.append(numero)
        return [CONTA] if numero == PEDIDO else []

    assert r._relocalizar_herdados([g], contas_da_venda, cliente_mp=mp) == 1
    assert (g.situacao, g.conta_id) == (ml.SIT_APTO_BAIXA, 895469770)
    assert pedidas == [PACOTE, PEDIDO] and g.ids_pedido == [PEDIDO]
    r._completar_ids_pedido(g, mp)
    assert len(mp.consultas) == 2, "pedidos já lidos: não pergunta de novo"


def test_frete_repetido_em_grupo_sem_cliente_sai_da_consolidada():
    principal = _grupo(situacao=ml.SIT_NAO_LOCALIZADO,
                       chaves=[f"v2|{PAG_PRODUTO}|x|Recebimento", f"v2|{PAG_FRETE}|y|Recebimento"])
    frete = _grupo(id="G-2", situacao=ml.SIT_SEM_CLIENTE, valor_total=Decimal("52.41"), nome_cliente="",
                   ids_pagamento=[PAG_FRETE], id_operacao=PAG_FRETE)
    outra = _grupo(id="G-3", id_venda="2000000000000001", situacao=ml.SIT_SEM_CLIENTE, ids_pagamento=[PAG_FRETE])
    com_conta = _grupo(id="G-4", situacao=ml.SIT_NAO_LOCALIZADO, ids_pagamento=[PAG_FRETE], id_operacao="z", conta_id=1)
    mapa = {(PACOTE, PAG_PRODUTO): principal, (PACOTE, PAG_FRETE): frete,
            ("2000000000000001", PAG_FRETE): outra, (PACOTE, "z"): com_conta}
    assert rot.RotinaConciliacaoML._descartar_herdados_repetidos(mapa) == 1
    assert (PACOTE, PAG_FRETE) not in mapa
    assert mapa[(PACOTE, PAG_PRODUTO)] is principal and ("2000000000000001", PAG_FRETE) in mapa and (PACOTE, "z") in mapa


def test_grupo_com_conta_contido_em_outro_da_mesma_venda_sai_da_consolidada():
    # Anelize (12/11/2026): o recebimento de 191,41 num grupo próprio e dentro do grupo de 261,14.
    r1, r2 = "v2|174319330846|a|Recebimento|69.73|0", "v2|174290520932|b|Recebimento|191.41|0"
    maior = _grupo(id="G-1", situacao=ml.SIT_VALOR_DIVERGENTE, conta_id=895529228, chaves=[r1, r2])
    contido = _grupo(id="G-2", situacao=ml.SIT_VALOR_DIVERGENTE, conta_id=895529228, chaves=[r2])
    baixado = _grupo(id="G-3", situacao=ml.SIT_CONCILIADO, conta_id=895529228, chaves=[r2], baixado_em="2026-11-01")
    outra_venda = _grupo(id="G-4", id_venda="2000000000000001", situacao=ml.SIT_VALOR_DIVERGENTE, conta_id=1, chaves=[r2])
    so_pagamento = _grupo(id="G-5", situacao=ml.SIT_VALOR_DIVERGENTE, conta_id=2,
                          chaves=["v2|174290520932|c|Recebimento|5.00|0"], ids_pagamento=["174290520932"])
    mapa = {("v", "1"): maior, ("v", "2"): contido, ("v", "3"): baixado, ("o", "4"): outra_venda, ("v", "5"): so_pagamento}
    assert rot.RotinaConciliacaoML._descartar_herdados_repetidos(mapa) == 1
    assert ("v", "2") not in mapa, "linhas todas dentro de outro grupo da venda"
    assert {("v", "1"), ("v", "3"), ("o", "4"), ("v", "5")} <= set(mapa), "baixado, outra venda e linha diferente ficam"
