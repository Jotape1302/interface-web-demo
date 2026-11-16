"""Apto para baixa continua baixável depois de sair da janela de 60 dias da análise (visão consolidada)."""
from datetime import date

from app import ml_reconciliation as ml
from tests.test_ml_reconciliation import LIBERACOES, _rotina

CONSOLIDADA = "consolidado_norvia_campinas"


class _MPSemVendas:
    """Rodada futura: a janela já não alcança as vendas antigas (só o saldo inicial)."""

    def liberacoes(self, de, ate, progresso=None):
        return LIBERACOES[:1]


def test_apto_antigo_fica_na_consolidada_e_e_baixado(tmp_path):
    r = _rotina(tmp_path)
    r.executar("manual", ["norvia_campinas"], date(2025, 9, 1), date(2025, 9, 2))
    apto = next(g for g in r.estado.analise(CONSOLIDADA).grupos if g.conta_id == 10)
    assert apto.situacao == ml.SIT_APTO_BAIXA

    # Rodada 70 dias depois: a análise nova não traz mais essa venda.
    r.fabrica_mp = lambda e: _MPSemVendas()
    r.executar("manual", ["norvia_campinas"], date(2025, 11, 10), date(2025, 11, 11))
    cons = r.estado.analise(CONSOLIDADA)
    ainda = next(g for g in cons.grupos if g.id == apto.id)
    assert ainda.situacao == ml.SIT_APTO_BAIXA
    pend = next(e for e in r.pendencias()["empresas"] if e["id"] == "norvia_campinas")
    assert pend["analise_id"] == CONSOLIDADA and pend["aptos_baixa"] >= 1

    res = r.baixar(CONSOLIDADA, [apto.id])
    assert res["total_sucessos"] == 1
    assert [cid for cid, _ in r.tiny.baixas] == [10]
    assert next(g for g in r.estado.analise(CONSOLIDADA).grupos if g.id == apto.id).situacao == ml.SIT_CONCILIADO
