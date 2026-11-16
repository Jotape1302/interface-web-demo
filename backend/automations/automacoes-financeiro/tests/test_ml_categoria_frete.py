"""11/11/2026 (financeiro): o frete pago pelo comprador entra em "Fretes sobre Vendas", não em
"Receita de Fretes" — parte do frete na baixa em duas partes, linha "Recebimento de frete" da
planilha/caixa e frete fora da conta."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import ml_reconciliation as ml
from app import ml_reconciliation_rotina as rot


def _resolvedor(categorias, **cfg):
    tiny = MagicMock()
    tiny.list_categorias_receita_despesa_v3.return_value = categorias
    base = {"ML_CATEGORIA_FRETE_ID": None, "ML_REVESTA_CATEGORIA_FRETE_ID": None}
    return rot.ResolvedorTiny(tiny, lambda emp: "tok", cfg=SimpleNamespace(**{**base, **cfg})), tiny


@pytest.mark.categoria_frete_real
def test_parte_do_frete_na_baixa_usa_fretes_sobre_vendas_pelo_nome():
    cats = [{"id": 11, "descricao": "Receita de Fretes"}, {"id": 22, "descricao": "Fretes sobre Vendas"}]
    for empresa_id in ("norvia_campinas", "revesta"):
        resolvedor, _ = _resolvedor(cats)
        assert resolvedor.categoria_frete_id(ml.EMPRESAS_ML[empresa_id]) == 22


@pytest.mark.categoria_frete_real
def test_sem_fretes_sobre_vendas_no_tiny_e_erro_e_env_fixa_outra():
    resolvedor, _ = _resolvedor([{"id": 11, "descricao": "Receita de Fretes"}])
    with pytest.raises(RuntimeError, match="Fretes sobre Vendas"):
        resolvedor.categoria_frete_id(ml.EMPRESAS_ML["norvia_campinas"])
    resolvedor, tiny = _resolvedor([], ML_CATEGORIA_FRETE_ID=33, ML_REVESTA_CATEGORIA_FRETE_ID=44)
    assert resolvedor.categoria_frete_id(ml.EMPRESAS_ML["norvia_campinas"]) == 33
    assert resolvedor.categoria_frete_id(ml.EMPRESAS_ML["revesta"]) == 44
    tiny.list_categorias_receita_despesa_v3.assert_not_called()


def test_recebimento_de_frete_vira_entrada_em_fretes_sobre_vendas():
    assert ml.MAPEAMENTO_LANCAMENTOS[ml.TIPO_RECEBIMENTO_FRETE][0] == "Fretes sobre Vendas"
    assert ml.MAPEAMENTO_LANCAMENTOS["Tarifa de envio"][0] == "Fretes sobre Vendas"
    # O cancelamento do custo de envio segue em Receita de Fretes (não foi pedido).
    assert ml.MAPEAMENTO_LANCAMENTOS["Cancelamento do custo de envio"][0] == "Receita de Fretes"
