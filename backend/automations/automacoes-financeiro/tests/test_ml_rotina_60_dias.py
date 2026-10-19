from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from app import ml_reconciliation as ml
from app import ml_reconciliation_rotina as rot
from app.config import Settings


def _lib(**campos):
    base = {
        "DATE": "2026-09-01T10:00:00.000-03:00",
        "RECORD_TYPE": "release",
        "DESCRIPTION": "payment",
        "NET_CREDIT_AMOUNT": "0",
        "NET_DEBIT_AMOUNT": "0",
        "GROSS_AMOUNT": "0",
        "ORDER_ID": "",
        "PACK_ID": "",
    }
    base.update({k: str(v) for k, v in campos.items()})
    return base


class MockTiny:
    def __init__(self):
        self.chamadas_pedidos: List[Dict[str, Any]] = []
        self.pedidos_por_data: Dict[str, List[Dict[str, Any]]] = {}
        self.contas: Dict[int, Dict[str, Any]] = {}

    def list_pedidos_v3(
        self,
        token: str,
        data_inicial: Optional[str] = None,
        data_final: Optional[str] = None,
        numero_pedido_ecommerce: Optional[str] = None,
        max_pages: int = 300,
    ) -> List[Dict[str, Any]]:
        self.chamadas_pedidos.append({"de": data_inicial, "ate": data_final, "ecommerce": numero_pedido_ecommerce})
        if numero_pedido_ecommerce:
            return []
        key = f"{data_inicial}_{data_final}"
        return list(self.pedidos_por_data.get(key, []))

    def list_contas_receber_v3(self, token: str, nome_cliente: str = "", **kwargs) -> List[Dict[str, Any]]:
        return [c for c in self.contas.values() if c.get("cliente", {}).get("nome") == nome_cliente]

    def obter_conta_receber_v3(self, token: str, conta_id: int) -> Dict[str, Any]:
        if conta_id in self.contas:
            return dict(self.contas[conta_id])
        return {"id": conta_id, "situacao": "aberto", "saldo": 100.0, "valorPago": 0.0}

    def obter_contas_financeiras_v3(self, token: str) -> List[Dict[str, Any]]:
        return [{"id": 1, "nome": "Mercado Livre - NORVIA"}]

    def list_categorias_receita_despesa_v3(self, token: str) -> List[Dict[str, Any]]:
        return [{"id": 2, "descricao": "Recebimento de Vendas"}]


def test_periodo_padrao_60_dias():
    hoje = date(2026, 10, 15)
    de, ate = rot.periodo_padrao(hoje=hoje, dias=60)
    assert ate == date(2026, 10, 14)
    assert de == date(2026, 8, 16)
    assert (ate - de).days + 1 == 60


def test_fatiar_periodo():
    de = date(2026, 8, 16)
    ate = date(2026, 10, 14)
    fatias = rot.fatiar_periodo(de, ate, max_dias_fatia=15)
    assert len(fatias) == 4
    # Primeira fatia: 16/08 a 30/08 (15 dias)
    assert fatias[0] == (date(2026, 8, 16), date(2026, 8, 30))
    assert (fatias[0][1] - fatias[0][0]).days + 1 == 15
    # Última fatia termina exatamente em 'ate'
    assert fatias[-1][1] == ate
    # As fatias são contínuas sem sobreposição e sem gaps
    for i in range(len(fatias) - 1):
        assert fatias[i][1] + timedelta(days=1) == fatias[i + 1][0]

    # Casos de borda
    assert rot.fatiar_periodo(date(2026, 10, 15), date(2026, 10, 14)) == []
    assert rot.fatiar_periodo(date(2026, 10, 15), date(2026, 10, 15)) == [(date(2026, 10, 15), date(2026, 10, 15))]


def test_busca_pedidos_tiny_fatiada_deduplica(tmp_path):
    tiny = MockTiny()
    de = date(2026, 9, 1)
    ate = date(2026, 9, 30)

    # 2 fatias de 15 dias: 2026-09-01 a 2026-09-15 e 2026-09-16 a 2026-09-30
    # O pedido 1001 aparece em ambas as fatias para testar a deduplicação
    tiny.pedidos_por_data["2026-09-01_2026-09-15"] = [
        {"id": 1001, "numeroPedidoEcommerce": "PED-01", "cliente": {"nome": "Cliente Um"}},
        {"id": 1002, "numeroPedidoEcommerce": "PED-02", "cliente": {"nome": "Cliente Dois"}},
    ]
    tiny.pedidos_por_data["2026-09-16_2026-09-30"] = [
        {"id": 1001, "numeroPedidoEcommerce": "PED-01", "cliente": {"nome": "Cliente Um"}},
        {"id": 1003, "numeroPedidoEcommerce": "PED-03", "cliente": {"nome": "Cliente Tres"}},
    ]

    cfg = Settings(DATA_DIR=str(tmp_path))
    estado = rot.EstadoML(pasta=tmp_path, cfg=cfg)

    # Mock das APIs do Mercado Pago e Mercado Livre
    mp = MagicMock()
    mp.liberacoes.return_value = [
        _lib(SOURCE_ID="5001", ORDER_ID="PED-01", NET_CREDIT_AMOUNT="100.00", GROSS_AMOUNT="100.00"),
    ]
    ml_client = MagicMock()
    ml_client.pedidos.return_value = []

    rotina = rot.RotinaConciliacaoML(
        estado=estado,
        cfg=cfg,
        tiny=tiny,
        fabrica_mp=lambda e: mp,
        fabrica_ml=lambda e: ml_client,
        obter_token_tiny=lambda emp_id: "token-teste",
    )

    ex = rotina.executar("manual", ["norvia_campinas"], de=de, ate=ate)
    assert ex["status"] == "ok"
    # Fatiou a busca e consultou o Tiny
    assert len(tiny.chamadas_pedidos) >= 2


def test_visao_consolidada_e_baixa_externa(tmp_path):
    tiny = MockTiny()
    # Conta inicialmente em aberto no Tiny
    tiny.contas[999] = {
        "id": 999,
        "historico": "OC PED-6001 parcela 1/1",
        "situacao": "aberto",
        "valor": 100.0,
        "saldo": 100.0,
        "valorPago": 0.0,
        "cliente": {"nome": "Cliente Teste"},
    }

    cfg = Settings(DATA_DIR=str(tmp_path))
    estado = rot.EstadoML(pasta=tmp_path, cfg=cfg)

    mp = MagicMock()
    mp.liberacoes.return_value = [
        _lib(SOURCE_ID="6001", ORDER_ID="PED-6001", NET_CREDIT_AMOUNT="100.00", GROSS_AMOUNT="100.00"),
    ]
    ml_client = MagicMock()
    ml_client.pedidos.return_value = [
        {"id": "PED-6001", "payments": [{"id": 6001}], "pack_id": None},
    ]

    # Pedido no Tiny com cliente correspondente
    de = date(2026, 9, 1)
    ate = date(2026, 9, 15)
    tiny.pedidos_por_data[f"{de.isoformat()}_{ate.isoformat()}"] = [
        {"id": 2001, "numeroPedidoEcommerce": "PED-6001", "cliente": {"nome": "Cliente Teste"}},
    ]

    rotina = rot.RotinaConciliacaoML(
        estado=estado,
        cfg=cfg,
        tiny=tiny,
        fabrica_mp=lambda e: mp,
        fabrica_ml=lambda e: ml_client,
        obter_token_tiny=lambda emp_id: "token-teste",
    )

    # 1. Primeira execução: gera análise e visão consolidada
    rotina.executar("manual", ["norvia_campinas"], de=de, ate=ate)
    cons = estado.analise("consolidado_norvia_campinas")
    assert cons is not None
    assert len(cons.grupos) == 1
    assert cons.grupos[0].id_venda == "PED-6001"
    assert cons.grupos[0].apto_baixa is True

    # 2. Agora simulamos que a conta foi liquidada/baixada no Tiny externamente
    tiny.contas[999]["situacao"] = "liquidada"
    tiny.contas[999]["saldo"] = 0.0
    tiny.contas[999]["valorPago"] = 100.0

    # Nova execução da rotina confere a conta
    rotina.executar("manual", ["norvia_campinas"], de=de, ate=ate)
    cons_atualizada = estado.analise("consolidado_norvia_campinas")
    assert cons_atualizada is not None
    g = cons_atualizada.grupos[0]
    assert g.situacao == ml.SIT_CONCILIADO
    assert g.apto_baixa is False
    assert "Baixado externamente no Tiny" in g.mensagem


def test_deduplicacao_estrita_lancamentos_exportados(tmp_path):
    cfg = Settings(DATA_DIR=str(tmp_path))
    estado = rot.EstadoML(pasta=tmp_path, cfg=cfg)

    # Primeira exportação
    chaves_1 = ["chave_a", "chave_b", "chave_c"]
    estado.registrar_exportados(chaves_1)
    exp = estado.lancamentos_exportados()
    assert set(exp.keys()) == {"chave_a", "chave_b", "chave_c"}

    # Segunda exportação com repetições e chave nova
    chaves_2 = ["chave_b", "chave_c", "chave_d", ""]
    estado.registrar_exportados(chaves_2)
    exp2 = estado.lancamentos_exportados()
    assert set(exp2.keys()) == {"chave_a", "chave_b", "chave_c", "chave_d"}
    assert "" not in exp2


def test_visao_consolidada_ids_unicos_entre_analises(tmp_path):
    """Grupos de análises diferentes (cada uma com seu "G-0") não podem colidir: a baixa acha o grupo pelo id."""
    tiny = MockTiny()
    for conta_id, venda, cliente in ((901, "PED-7001", "Cliente A"), (902, "PED-7002", "Cliente B")):
        tiny.contas[conta_id] = {
            "id": conta_id, "historico": f"OC {venda} parcela 1/1", "situacao": "aberto",
            "valor": 100.0, "saldo": 100.0, "valorPago": 0.0, "cliente": {"nome": cliente},
        }
    cfg = Settings(DATA_DIR=str(tmp_path))
    estado = rot.EstadoML(pasta=tmp_path, cfg=cfg)
    mp, ml_client = MagicMock(), MagicMock()
    rotina = rot.RotinaConciliacaoML(
        estado=estado, cfg=cfg, tiny=tiny, fabrica_mp=lambda e: mp, fabrica_ml=lambda e: ml_client,
        obter_token_tiny=lambda emp_id: "token-teste",
    )

    for dia, venda, pagamento, cliente, pedido in (
        (date(2026, 9, 1), "PED-7001", 7001, "Cliente A", 3001),
        (date(2026, 9, 2), "PED-7002", 7002, "Cliente B", 3002),
    ):
        mp.liberacoes.return_value = [
            _lib(SOURCE_ID=str(pagamento), ORDER_ID=venda, NET_CREDIT_AMOUNT="100.00", GROSS_AMOUNT="100.00"),
        ]
        ml_client.pedidos.return_value = [{"id": venda, "payments": [{"id": pagamento}], "pack_id": None}]
        tiny.pedidos_por_data.clear()
        tiny.pedidos_por_data[f"{dia.isoformat()}_{dia.isoformat()}"] = [
            {"id": pedido, "numeroPedidoEcommerce": venda, "cliente": {"nome": cliente}},
        ]
        rotina.executar("manual", ["norvia_campinas"], de=dia, ate=dia)

    cons = estado.analise("consolidado_norvia_campinas")
    ids = [g.id for g in cons.grupos]
    assert len(cons.grupos) == 2
    assert len(set(ids)) == 2
    assert all(i.startswith("C-") for i in ids)
