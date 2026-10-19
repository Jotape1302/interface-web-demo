import pytest
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock

from app.contas_pagar_rotina import EstadoContasPagar, proxima_execucao_contas_pagar


def test_estado_inicial_quando_arquivo_nao_existe(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)
    estado = store.carregar()
    assert estado["status"] == "vazio"
    assert estado["matches"] == []
    assert estado["unmatched_tiny"] == []
    assert estado["summary"]["total_casados"] == 0


def test_mesclar_preview_e_preservar_pendencias_antigas(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)

    # 1. Primeira prévia com 1 match e 1 conta tiny antiga
    preview1 = {
        "status": "ok",
        "data_inicio": "2026-08-01",
        "data_fim": "2026-08-31",
        "matches": [
            {
                "id": "m1",
                "empresa": "norvia",
                "conta_pagar_id": 101,
                "inter_transacao_id": "itx_1",
                "valor_pago": 150.0,
                "valor_tiny": 150.0,
            }
        ],
        "unmatched_tiny": [
            {
                "id": 201,
                "empresa": "norvia",
                "numero_documento": "DOC-ANTIGO-201",
                "valor": 500.0,
                "data_vencimento": "2026-08-10",
            }
        ],
        "unmatched_inter": [
            {
                "empresa": "norvia",
                "transacao_id": "itx_avulso_1",
                "valor_pago": 80.0,
            }
        ],
        "ja_baixadas": [],
        "transferencias_internas": [],
        "avisos": ["Aviso da primeira execução"],
    }

    res1 = store.mesclar_preview(preview1, tipo_execucao="rotina")
    assert res1["status"] == "ok"
    assert len(res1["matches"]) == 1
    assert len(res1["unmatched_tiny"]) == 1
    assert res1["summary"]["total_casados"] == 1
    assert res1["summary"]["total_tiny_sem_par"] == 1
    assert res1["summary"]["valor_tiny_sem_par"] == 500.0

    # 2. Segunda prévia com janela mais recente (setembro): não traz a conta 201, traz a conta 202
    preview2 = {
        "status": "ok",
        "data_inicio": "2026-09-01",
        "data_fim": "2026-09-30",
        "matches": [
            {
                "id": "m2",
                "empresa": "norvia",
                "conta_pagar_id": 102,
                "inter_transacao_id": "itx_2",
                "valor_pago": 200.0,
                "valor_tiny": 200.0,
            }
        ],
        "unmatched_tiny": [
            {
                "id": 202,
                "empresa": "norvia",
                "numero_documento": "DOC-NOVO-202",
                "valor": 300.0,
                "data_vencimento": "2026-09-15",
            }
        ],
        "unmatched_inter": [],
        "ja_baixadas": [],
        "transferencias_internas": [],
        "avisos": ["Aviso da segunda execução"],
    }

    res2 = store.mesclar_preview(preview2, tipo_execucao="preview_manual")

    # Contas antigas (101 e 201) permanecem preservadas!
    matches_ids = {m["conta_pagar_id"] for m in res2["matches"]}
    tiny_ids = {c["id"] for c in res2["unmatched_tiny"]}
    assert 101 in matches_ids
    assert 102 in matches_ids
    assert 201 in tiny_ids
    assert 202 in tiny_ids
    assert res2["summary"]["total_casados"] == 2
    assert res2["summary"]["total_tiny_sem_par"] == 2
    assert res2["summary"]["valor_tiny_sem_par"] == 800.0
    assert len(res2["execucoes"]) == 2


def test_remover_contas_baixadas_imediato(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)

    preview = {
        "status": "ok",
        "data_inicio": "2026-09-01",
        "data_fim": "2026-09-30",
        "matches": [
            {
                "empresa": "norvia",
                "conta_pagar_id": 101,
                "inter_transacao_id": "itx_1",
                "valor_pago": 150.0,
            },
            {
                "empresa": "revesta",
                "conta_pagar_id": 102,
                "inter_transacao_id": "itx_2",
                "valor_pago": 300.0,
            },
        ],
        "unmatched_tiny": [
            {"id": 201, "empresa": "norvia", "valor": 50.0},
        ],
        "unmatched_inter": [],
        "ja_baixadas": [],
        "transferencias_internas": [],
    }
    store.mesclar_preview(preview)

    # Baixa da conta 101 pela tela
    res = store.remover_contas_baixadas(
        [{"empresa": "norvia", "conta_pagar_id": 101, "valor_pago": 150.0}],
        motivo="automacao",
    )

    matches_restantes = [m["conta_pagar_id"] for m in res["matches"]]
    assert matches_restantes == [102]
    assert res["summary"]["total_casados"] == 1
    assert len(res["historico_saidas"]) == 1
    assert res["historico_saidas"][0]["conta_pagar_id"] == 101
    assert res["historico_saidas"][0]["motivo"] == "automacao"


def test_conferir_baixas_externas(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)

    preview = {
        "status": "ok",
        "data_inicio": "2026-09-01",
        "data_fim": "2026-09-30",
        "matches": [
            {
                "empresa": "norvia",
                "conta_pagar_id": 555,
                "inter_transacao_id": "itx_555",
                "valor_pago": 120.0,
            }
        ],
        "unmatched_tiny": [
            {"id": 666, "empresa": "norvia", "valor": 70.0},
        ],
        "unmatched_inter": [],
        "ja_baixadas": [],
        "transferencias_internas": [],
    }
    store.mesclar_preview(preview)

    mock_tiny = MagicMock()
    # Conta 555 foi liquidada externamente no Tiny (situação 'pago', saldo 0)
    mock_tiny.obter_conta_pagar_v3.return_value = (
        {"id": 555, "situacao": "pago", "saldo": "0.00"},
        "token_123",
    )
    mock_repo = MagicMock()
    mock_repo.is_configured.return_value = True
    mock_repo.get_token_by_cnpj_or_account.return_value = ("token_123",)

    cfg = MagicMock()
    cfg.MOCK_MODE = False
    cfg.TINY_API_TOKEN = "token_123"

    qtd = store.conferir_baixas_externas(mock_tiny, mock_repo, cfg=cfg)
    assert qtd >= 1

    pos = store.carregar()
    matches_restantes = [m["conta_pagar_id"] for m in pos["matches"]]
    assert 555 not in matches_restantes
    saida = [s for s in pos["historico_saidas"] if s["conta_pagar_id"] == 555]
    assert len(saida) == 1
    assert saida[0]["motivo"] == "baixa_externa_tiny"


def test_proxima_execucao_contas_pagar():
    cfg = MagicMock()
    cfg.CONTAS_PAGAR_ROTINA_HOUR = 7

    # Se agora são 06:00, próxima é hoje às 07:00
    dt_antes = datetime(2026, 10, 13, 6, 0, 0)
    prox = proxima_execucao_contas_pagar(cfg, agora_dt=dt_antes)
    assert prox.day == 13
    assert prox.hour == 7

    # Se agora são 08:00, próxima é amanhã às 07:00
    dt_depois = datetime(2026, 10, 13, 8, 0, 0)
    prox2 = proxima_execucao_contas_pagar(cfg, agora_dt=dt_depois)
    assert prox2.day == 14
    assert prox2.hour == 7


def _previa(**listas):
    base = {"status": "ok", "matches": [], "unmatched_tiny": [], "unmatched_inter": [],
            "ja_baixadas": [], "transferencias_internas": [], "avisos": []}
    base.update(listas)
    return base


def test_conta_casada_com_outra_transacao_nao_duplica(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)
    store.mesclar_preview(_previa(matches=[{"empresa": "revesta", "conta_pagar_id": 10, "inter_transacao_id": "itx_a"}]))
    estado = store.mesclar_preview(_previa(matches=[{"empresa": "revesta", "conta_pagar_id": 10, "inter_transacao_id": "itx_b"}]))
    assert [m["inter_transacao_id"] for m in estado["matches"]] == ["itx_b"]


def test_debito_sem_par_sai_quando_vira_ja_baixado_ou_transferencia(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)
    store.mesclar_preview(_previa(unmatched_inter=[
        {"empresa": "revesta", "transacao_id": "itx_1"}, {"empresa": "revesta", "transacao_id": "itx_2"},
    ]))
    estado = store.mesclar_preview(_previa(
        ja_baixadas=[{"empresa": "revesta", "conta_pagar_id": 7, "inter_transacao_id": "itx_1"}],
        transferencias_internas=[{"empresa": "revesta", "transacao_id": "itx_2"}],
    ))
    assert estado["unmatched_inter"] == []


def test_avisos_sao_da_ultima_execucao(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)
    store.mesclar_preview(_previa(avisos=["Inter fora do ar"]))
    assert store.mesclar_preview(_previa(avisos=[]))["avisos"] == []


def test_conta_parcial_sem_saldo_informado_nao_sai(tmp_path):
    store = EstadoContasPagar(data_dir=tmp_path)
    store.mesclar_preview(_previa(unmatched_tiny=[{"id": 77, "empresa": "revesta", "valor": 50.0}]))
    mock_tiny = MagicMock()
    mock_tiny.obter_conta_pagar_v3.return_value = ({"id": 77, "situacao": "parcial"}, "tok")
    mock_repo = MagicMock()
    mock_repo.is_configured.return_value = False
    cfg = MagicMock(MOCK_MODE=False, TINY_API_TOKEN="tok")

    assert store.conferir_baixas_externas(mock_tiny, mock_repo, cfg=cfg) == 0
    assert [c["id"] for c in store.carregar()["unmatched_tiny"]] == [77]
