import io
import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.api import app
from app.audit import record_audit_error
from app.config import settings
from app.nfe_client import MockNFeProvider, NFeData, NFeDuplicate
from app.nfe_items import NFeItem
from app.review_store import stage_for_review
from app.scanner import ScanResult
from app.tiny_client import TinyContaResult


@pytest.fixture
def client():
    return TestClient(app)


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data
    assert "nfe_provider" in data


def test_health_tiny_endpoint(client):
    response = client.get("/health/tiny")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "tiny"
    assert "connected" in data
    assert "message" in data


def test_health_inter_endpoint(client):
    response = client.get("/health/inter")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "inter"
    assert data["connected"] is True
    assert "DDA" in data["message"]


def test_process_batch_empty(client):
    response = client.post("/api/v1/danfe/process-batch", files=[])
    assert response.status_code == 422 or response.status_code == 400


@patch("app.api.DANFEScanner")
@patch("app.api.get_nfe_provider")
@patch("app.api.TinyClient")
def test_process_batch_success(mock_tiny_class, mock_nfe_class, mock_scanner_class, client, tmp_path, monkeypatch):
    """
    A esteira agora pausa antes do lançamento: process-batch só escaneia, consulta
    e extrai itens/sugere categorias, deixando a nota em pending_review/ para
    revisão humana. A API do Tiny não deve ser chamada nesta etapa.
    """
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    # Mock scanner
    mock_scanner = MagicMock()
    mock_scanner.scan_file.return_value = ScanResult(
        key="35230912345678000123550010000001231000000123",
        method="barcode",
        file_path=Path("dummy.pdf"),
        page_number=1
    )
    mock_scanner_class.return_value = mock_scanner

    # Mock provider
    mock_provider = MockNFeProvider()
    mock_nfe_class.return_value = mock_provider

    # Execute request
    file_bytes = io.BytesIO(b"%PDF-1.4 dummy content")
    response = client.post(
        "/api/v1/danfe/process-batch",
        files={"files": ("danfe_teste.pdf", file_bytes, "application/pdf")}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert data["success_count"] == 1
    assert data["failed_count"] == 0
    assert len(data["items"]) == 1

    item = data["items"][0]
    assert item["status"] == "success"
    assert item["step"] == "pending_review"
    assert item["key"] == "35230912345678000123550010000001231000000123"
    assert item["scan_method"] == "barcode"
    assert item["nfe_data"]["numero_nota"] == "123"
    assert item["tiny_results"] == []
    assert len(item["itens"]) >= 1
    assert item["itens"][0]["categoria_sugerida_id"]
    mock_tiny_class.assert_not_called()
    assert list((tmp_path / "pending_review").glob("*.review.json"))


@patch("app.api.DANFEScanner")
@patch("app.api.get_nfe_provider")
@patch("app.api.already_launched_in_tiny", return_value=True)
def test_process_batch_skips_note_already_launched_in_tiny(
    mock_already_launched, mock_nfe_class, mock_scanner_class, client, tmp_path, monkeypatch
):
    """
    Incidente 2026-09-18: notas já lançadas manualmente no Tiny continuavam entrando
    em revisão via upload manual, porque só a varredura SEFAZ checava duplicidade
    antes de estagiar. Garante que process-batch (upload manual) também checa.
    """
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    mock_scanner = MagicMock()
    mock_scanner.scan_file.return_value = ScanResult(
        key="35230912345678000123550010000001231000000123",
        method="barcode",
        file_path=Path("dummy.pdf"),
        page_number=1
    )
    mock_scanner_class.return_value = mock_scanner
    mock_nfe_class.return_value = MockNFeProvider()

    file_bytes = io.BytesIO(b"%PDF-1.4 dummy content")
    response = client.post(
        "/api/v1/danfe/process-batch",
        files={"files": ("danfe_ja_lancada.pdf", file_bytes, "application/pdf")}
    )

    assert response.status_code == 200
    data = response.json()
    item = data["items"][0]
    assert item["status"] == "success"
    assert item["step"] == "tiny_erp"
    assert "já lançada" in item["error_message"]
    mock_already_launched.assert_called_once()
    assert not list((tmp_path / "pending_review").glob("*.review.json"))


def test_history_endpoint(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    settings.ensure_directories()

    response = client.get("/api/v1/danfe/history")
    assert response.status_code == 200
    data = response.json()
    assert "history" in data
    assert "total" in data


def test_resolve_failure_marks_history_item(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    settings.ensure_directories()
    error_path = record_audit_error("Falha no Tiny", chave_acesso="1" * 44)

    history = client.get("/api/v1/danfe/history").json()["history"]
    assert history[0]["resolved_at"] is None

    response = client.post("/api/v1/danfe/failures/resolve", json={"error_file": error_path.name})
    assert response.status_code == 200
    assert response.json()["resolved_at"]

    history = client.get("/api/v1/danfe/history").json()["history"]
    assert len(history) == 1
    assert history[0]["resolved_at"] == response.json()["resolved_at"]


def test_resolve_failure_rejects_unknown_or_path(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    settings.ensure_directories()

    assert client.post("/api/v1/danfe/failures/resolve", json={"error_file": "nao-existe.error.json"}).status_code == 404
    assert client.post("/api/v1/danfe/failures/resolve", json={"error_file": "../x.error.json"}).status_code == 404


def test_sefaz_status_endpoint(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    response = client.get("/api/v1/danfe/sefaz-status")
    assert response.status_code == 200
    data = response.json()
    assert data["total_novas_notas"] == 0
    assert data["cnpjs"] == []
    assert "next_scan_at" in data
    assert data["pending_review_count"] == 0


@patch("app.api.run_daily_scan")
def test_scan_sefaz_endpoint_triggers_scan(mock_run_daily_scan, client, tmp_path, monkeypatch):
    """
    O botão 'Rodar agora' dispara a varredura direta na SEFAZ de forma assíncrona
    (BackgroundTasks) e devolve o status atualizado sem bloquear por 60s.
    """
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    response = client.post("/api/v1/danfe/scan-sefaz")
    assert response.status_code == 200
    data = response.json()
    assert "next_scan_at" in data
    assert "is_running" in data
    mock_run_daily_scan.assert_called_once()


def test_sefaz_nsu_endpoints_audit_and_reset(client, tmp_path, monkeypatch):
    """Testa endpoints administrativos /api/v1/danfe/sefaz-nsu e reset."""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    # 1. GET status inicial
    res = client.get("/api/v1/danfe/sefaz-nsu")
    assert res.status_code == 200
    assert "nsu_state" in res.json()

    # 2. Reset / Set NSU
    res_reset = client.post(
        "/api/v1/danfe/sefaz-nsu/reset",
        json={"cnpj": "36592814000100", "clear_cooldown": True, "set_nsu": "000000000000500"},
    )
    assert res_reset.status_code == 200
    data = res_reset.json()
    assert data["nsu_state"]["36592814000100"] == "000000000000500"



def test_get_tiny_categories(client):
    response = client.get("/api/v1/tiny/categories")
    assert response.status_code == 200
    data = response.json()
    assert len(data) > 60
    ids = {c["id"] for c in data}
    assert "480897321" in ids  # Compras
    assert all("label" in c and "grupo" in c for c in data)


def test_get_tiny_categories_dynamic_from_account(client):
    with patch("app.api.TinyClient") as mock_tiny_cls:
        instance = mock_tiny_cls.return_value
        instance.resolve_token_for_cnpj.return_value = ("eyJh_v3_jwt", "norvia_campinas")
        instance.list_categorias_receita_despesa_v3.return_value = [
            {"id": 999, "descricao": "Materiais de Limpeza", "grupo": "Despesas Operacionais"}
        ]
        response = client.get("/api/v1/tiny/categories?cnpj=27184930000107")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["id"] == "999"
        assert data[0]["nome"] == "Materiais de Limpeza"
        assert data[0]["label"] == "Despesas Operacionais → Materiais de Limpeza"


@patch("app.api.TinyClient")
def test_confirm_lancamento_groups_by_category(mock_tiny_class, client, tmp_path, monkeypatch):
    """
    Itens da mesma categoria devem virar 1 único lançamento agrupado; categorias
    diferentes geram lançamentos separados. O Tiny só é chamado nesta confirmação,
    nunca antes.
    """
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    nfe_data = NFeData(
        chave="35230912345678000123550010000001231000000123",
        numero_nota="123",
        data_emissao=date(2026, 9, 1),
        emitente_nome="FORNECEDOR TESTE LTDA",
        emitente_cnpj="12345678000195",
        valor_total=Decimal("300.00"),
    )
    itens = [
        NFeItem(item_id="1", descricao="Detergente Limpeza", valor_total=Decimal("100.00")),
        NFeItem(item_id="2", descricao="Papel A4 Escritorio", valor_total=Decimal("100.00")),
        NFeItem(item_id="3", descricao="Detergente Limpeza 2", valor_total=Decimal("100.00")),
    ]
    original_file = tmp_path / "input_nota.pdf"
    original_file.write_bytes(b"%PDF dummy")
    stage_for_review(
        original_file, nfe_data, itens,
        categoria_por_item={"1": "701885961", "2": "484437483", "3": "701885961"}
    )

    mock_tiny = MagicMock()

    def fake_lancar(nfe, grupo, idx, total, **kw):
        return TinyContaResult(
            conta_id=1000 + idx,
            nro_documento=f"123-{idx}" if total > 1 else "123",
            valor=grupo.valor_total,
            vencimento=nfe.data_emissao,
            situacao="aberto",
            is_duplicate=False,
        )

    mock_tiny.lancar_grupo_categorizado.side_effect = fake_lancar
    mock_tiny_class.return_value = mock_tiny

    response = client.post(
        "/api/v1/danfe/confirm-lancamento",
        json={
            "chave": nfe_data.chave,
            "itens": [
                {"item_id": "1", "categoria_id": "701885961"},
                {"item_id": "2", "categoria_id": "484437483"},
                {"item_id": "3", "categoria_id": "701885961"},
            ],
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert len(data["grupos"]) == 2  # Materiais de Limpeza (2 itens) + Material de Escritório (1 item)
    total_lancado = sum(g["valor_total"] for g in data["grupos"])
    assert round(total_lancado, 2) == 300.00
    assert mock_tiny.lancar_grupo_categorizado.call_count == 2

    limpeza_grupo = next(g for g in data["grupos"] if g["categoria_id"] == "701885961")
    assert round(limpeza_grupo["valor_total"], 2) == 200.00
    assert set(limpeza_grupo["item_ids"]) == {"1", "3"}

    # Saiu de pending_review/ (sem deixar .review.json órfão) e foi para processed/
    assert not list((tmp_path / "pending_review").glob("*.review.json"))
    assert list((tmp_path / "processed").glob("*.pdf"))


@patch("app.api.TinyClient")
def test_confirm_lancamento_parcelado_gera_n_contas_por_categoria(mock_tiny_class, client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()
    nfe_data = NFeData(
        chave="35230912345678000123550010000001231000000124",
        numero_nota="124",
        data_emissao=date(2026, 9, 1),
        emitente_nome="FORNECEDOR TESTE LTDA",
        emitente_cnpj="12345678000195",
        valor_total=Decimal("300.00"),
    )
    itens = [
        NFeItem(item_id="1", descricao="Detergente Limpeza", valor_total=Decimal("200.00")),
        NFeItem(item_id="2", descricao="Papel A4 Escritorio", valor_total=Decimal("100.00")),
    ]
    original_file = tmp_path / "nota_parcelada.pdf"
    original_file.write_bytes(b"%PDF dummy")
    stage_for_review(original_file, nfe_data, itens, categoria_por_item={"1": "701885961", "2": "484437483"})

    chamadas = []

    def fake_lancar(nfe, grupo, idx, total, parcela=1, total_parcelas=1, valor_parcela=None):
        chamadas.append((grupo.categoria_id, parcela, total_parcelas, valor_parcela))
        return TinyContaResult(
            conta_id=len(chamadas), nro_documento=f"124-{idx}/{parcela}", valor=valor_parcela,
            vencimento=nfe.data_emissao, situacao="aberto", is_duplicate=False,
        )

    mock_tiny = MagicMock()
    mock_tiny.lancar_grupo_categorizado.side_effect = fake_lancar
    mock_tiny_class.return_value = mock_tiny

    response = client.post(
        "/api/v1/danfe/confirm-lancamento",
        json={"chave": nfe_data.chave, "itens": [
            {"item_id": "1", "categoria_id": "701885961"}, {"item_id": "2", "categoria_id": "484437483"},
        ], "parcelas": 3},
    )
    data = response.json()
    assert data["status"] == "success"
    assert len(data["grupos"]) == 6  # 2 categorias x 3 parcelas
    assert [(g["parcela"], g["total_parcelas"]) for g in data["grupos"][:3]] == [(1, 3), (2, 3), (3, 3)]
    assert round(sum(g["valor_total"] for g in data["grupos"]), 2) == 300.00
    assert [c[3] for c in chamadas if c[0] == "484437483"] == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]

    assert client.post(
        "/api/v1/danfe/confirm-lancamento", json={"chave": nfe_data.chave, "itens": [], "parcelas": 0}
    ).status_code == 422


@patch("app.api.TinyClient")
def test_confirm_lancamento_partial_failure_keeps_pending(mock_tiny_class, client, tmp_path, monkeypatch):
    """Se um grupo falhar no Tiny, a nota permanece em pending_review/ para nova tentativa."""
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    settings.ensure_directories()

    nfe_data = NFeData(
        chave="35230999999999000199550010000009999000000999",
        numero_nota="999",
        data_emissao=date(2026, 9, 1),
        emitente_nome="FORNECEDOR FALHA LTDA",
        emitente_cnpj="99999999000199",
        valor_total=Decimal("200.00"),
    )
    itens = [
        NFeItem(item_id="1", descricao="Item A", valor_total=Decimal("100.00")),
        NFeItem(item_id="2", descricao="Item B", valor_total=Decimal("100.00")),
    ]
    original_file = tmp_path / "input_falha.pdf"
    original_file.write_bytes(b"%PDF dummy")
    stage_for_review(
        original_file, nfe_data, itens,
        categoria_por_item={"1": "480897321", "2": "484437789"}
    )

    mock_tiny = MagicMock()

    def fake_lancar(nfe, grupo, idx, total, **kw):
        if grupo.categoria_id == "484437789":
            raise Exception("Fornecedor não encontrado no Tiny")
        return TinyContaResult(
            conta_id=2000 + idx, nro_documento=f"999-{idx}", valor=grupo.valor_total,
            vencimento=nfe.data_emissao, situacao="aberto", is_duplicate=False
        )

    mock_tiny.lancar_grupo_categorizado.side_effect = fake_lancar
    mock_tiny_class.return_value = mock_tiny

    response = client.post(
        "/api/v1/danfe/confirm-lancamento",
        json={
            "chave": nfe_data.chave,
            "itens": [
                {"item_id": "1", "categoria_id": "480897321"},
                {"item_id": "2", "categoria_id": "484437789"},
            ],
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "partial_error"
    statuses = {g["categoria_id"]: g["status"] for g in data["grupos"]}
    assert statuses["480897321"] == "success"
    assert statuses["484437789"] == "error"

    # Nota continua pendente (não foi movida nem removida) para permitir reenvio idempotente
    assert list((tmp_path / "pending_review").glob("*.review.json"))
    assert not list((tmp_path / "processed").glob("*.pdf"))

    # Erro de auditoria estruturado deve ter sido gravado em FAILED_DIR
    error_files = list((tmp_path / "failed").glob("*.error.json"))
    assert len(error_files) == 1
    err_json = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert err_json["audit_status"] == "error"
    assert err_json["chave_acesso"] == nfe_data.chave
    assert "Fornecedor não encontrado no Tiny" in err_json["details"]

    # E o endpoint de histórico deve reportar o erro
    hist_resp = client.get("/api/v1/danfe/history")
    assert hist_resp.status_code == 200
    hist_data = hist_resp.json()
    assert hist_data["total"] == 1
    assert hist_data["history"][0]["audit_status"] == "error"
    assert hist_data["history"][0]["chave_acesso"] == nfe_data.chave


def test_confirm_lancamento_unknown_chave_returns_404(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    response = client.post(
        "/api/v1/danfe/confirm-lancamento",
        json={"chave": "00000000000000000000000000000000000000000000", "itens": []},
    )
    assert response.status_code == 404


def _stage_dummy_nota(tmp_path, chave="35230911111111000111550010000001111000000111") -> NFeData:
    nfe_data = NFeData(
        chave=chave,
        numero_nota="111",
        data_emissao=date(2026, 9, 1),
        emitente_nome="FORNECEDOR ARQUIVO LTDA",
        emitente_cnpj="11111111000111",
        valor_total=Decimal("50.00"),
    )
    itens = [NFeItem(item_id="1", descricao="Item Arquivo", valor_total=Decimal("50.00"))]
    original_file = tmp_path / "input_arquivo.pdf"
    original_file.write_bytes(b"%PDF dummy")
    stage_for_review(original_file, nfe_data, itens, categoria_por_item={"1": "480897321"})
    return nfe_data


def test_archive_and_restore_nota(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    monkeypatch.setattr(settings, "ARCHIVED_DIR", tmp_path / "archived")
    settings.ensure_directories()
    nfe_data = _stage_dummy_nota(tmp_path)

    archive_res = client.post("/api/v1/danfe/archive", json={"chave": nfe_data.chave})
    assert archive_res.status_code == 200
    assert archive_res.json() == {"chave": nfe_data.chave, "status": "archived"}

    pending_res = client.get("/api/v1/danfe/notas", params={"status_filter": "pending"})
    assert pending_res.json()["total"] == 0

    archived_res = client.get("/api/v1/danfe/notas", params={"status_filter": "archived"})
    archived_data = archived_res.json()
    assert archived_data["total"] == 1
    assert archived_data["notas"][0]["chave"] == nfe_data.chave
    assert not list((tmp_path / "pending_review").glob("*.review.json"))
    assert list((tmp_path / "archived").glob("*.review.json"))

    restore_res = client.post("/api/v1/danfe/restore", json={"chave": nfe_data.chave})
    assert restore_res.status_code == 200
    assert restore_res.json() == {"chave": nfe_data.chave, "status": "pending"}

    pending_res = client.get("/api/v1/danfe/notas", params={"status_filter": "pending"})
    assert pending_res.json()["total"] == 1
    archived_res = client.get("/api/v1/danfe/notas", params={"status_filter": "archived"})
    assert archived_res.json()["total"] == 0


def test_archive_unknown_chave_returns_404(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    monkeypatch.setattr(settings, "ARCHIVED_DIR", tmp_path / "archived")
    settings.ensure_directories()

    response = client.post("/api/v1/danfe/archive", json={"chave": "0" * 44})
    assert response.status_code == 404


def test_restore_unknown_chave_returns_404(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    monkeypatch.setattr(settings, "ARCHIVED_DIR", tmp_path / "archived")
    settings.ensure_directories()

    response = client.post("/api/v1/danfe/restore", json={"chave": "0" * 44})
    assert response.status_code == 404


@patch("app.api.TinyClient")
def test_notas_endpoint_lists_confirmed_after_lancamento(mock_tiny_class, client, tmp_path, monkeypatch):
    """Depois de confirmada, a nota deve aparecer em status=confirmed com os itens preservados."""
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()

    nfe_data = _stage_dummy_nota(tmp_path)

    mock_tiny = MagicMock()
    mock_tiny.lancar_grupo_categorizado.return_value = TinyContaResult(
        conta_id=1, nro_documento="111", valor=Decimal("50.00"),
        vencimento=nfe_data.data_emissao, situacao="aberto", is_duplicate=False,
    )
    mock_tiny_class.return_value = mock_tiny

    confirm_res = client.post(
        "/api/v1/danfe/confirm-lancamento",
        json={"chave": nfe_data.chave, "itens": [{"item_id": "1", "categoria_id": "484437483"}]},
    )
    assert confirm_res.status_code == 200
    assert confirm_res.json()["status"] == "success"

    confirmed_res = client.get("/api/v1/danfe/notas", params={"status_filter": "confirmed"})
    confirmed_data = confirmed_res.json()
    assert confirmed_data["total"] == 1
    nota = confirmed_data["notas"][0]
    assert nota["chave"] == nfe_data.chave
    # Reflete a categoria efetivamente escolhida na confirmação, não a sugestão original
    assert nota["itens"][0]["categoria_sugerida_id"] == "484437483"

    pending_res = client.get("/api/v1/danfe/notas", params={"status_filter": "pending"})
    assert pending_res.json()["total"] == 0


def test_history_cleans_legacy_sefaz_scan_errors(client, tmp_path, monkeypatch):
    """Garante que arquivos legados de varredura SEFAZ em FAILED_DIR são limpos e não contabilizados como notas com falha."""
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path / "data")
    settings.ensure_directories()

    legacy_err = settings.FAILED_DIR / "SEFAZ-SCAN-27184930000280.error.json"
    legacy_err.write_text(json.dumps({
        "audit_status": "error",
        "details": "SEFAZ cStat 656: Rejeicao: Consumo Indevido",
        "emitente_cnpj": "27184930000280",
    }), encoding="utf-8")

    res = client.get("/api/v1/danfe/history")
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 0
    assert not legacy_err.exists()


def test_reconciliacao_status_endpoint(client):
    res = client.get("/api/v1/reconciliacao/status")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "empresas" in data
    emp_ids = [e["id"] for e in data["empresas"]]
    assert "fabrilux" in emp_ids
    assert "revesta" in emp_ids
    assert "norvia_campinas" in emp_ids
    assert "norvia_curitiba" in emp_ids


def _contas_por_situacao(por_situacao):
    """Simula GET /contas-pagar do Tiny v3, que filtra por uma situação por chamada."""
    def fake(token, situacao=None, **kwargs):
        return [dict(c) for c in por_situacao.get(situacao, [])]
    return fake


def test_reconciliacao_preview_endpoint(client):
    from app.inter_client import InterClient, InterTransacao
    from app.tiny_client import TinyClient

    pagamento = InterTransacao(
        empresa="fabrilux",
        transacao_id="TX-API-01",
        data_pagamento=date(2026, 9, 10),
        valor_pago=Decimal("150.50"),
        tipo_transacao="PIX",
        titulo="Pix enviado",
        descricao="PIX ALUMIX",
        nome_favorecido="ALUMIX ALUMINIOS",
    )
    conta_tiny = {
        "id": 12345,
        "numeroDocumento": "NF-777",
        "valor": 150.50,
        "dataVencimento": "2026-09-10",
        "cliente": {"nome": "Alumix Aluminios Ltda"},
    }

    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado", "mensagem": "ok"}), \
            patch.object(InterClient, "get_extrato", return_value=[pagamento]), \
            patch.object(TinyClient, "list_contas_pagar_v3", side_effect=_contas_por_situacao({"aberto": [conta_tiny]})), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        res = client.post(
            "/api/v1/reconciliacao/preview",
            json={"empresa": "fabrilux", "data_inicio": "2026-08-01", "data_fim": "2026-09-25"},
        )

    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["summary"]["total_casados"] == 1
    m0 = data["matches"][0]
    assert m0["empresa"] == "fabrilux"
    assert m0["valor_pago"] == 150.50
    assert m0["conta_pagar_id"] == 12345


def test_reconciliacao_preview_inter_desconectado_um_aviso_por_empresa(client):
    from app.inter_client import InterClient

    diag = {"status": "certificados_sem_permissao", "mensagem": "Certificados mTLS sem permissão de leitura."}
    with patch.object(InterClient, "check_credentials_status", return_value=diag), \
            patch.object(InterClient, "get_extrato") as get_extrato, \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", None):
        token_repo.return_value.is_configured.return_value = False
        res = client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux"})

    assert res.status_code == 200
    get_extrato.assert_not_called()
    avisos_inter = [a for a in res.json()["avisos"] if "Inter" in a]
    assert avisos_inter == ["Fabrilux (Inter): Certificados mTLS sem permissão de leitura."]



def test_reconciliacao_preview_tiny_recusando_vira_aviso_e_nao_zero_silencioso(client):
    """Token do Tiny expirado (401) mostrava "0 contas no Tiny" sem aviso nenhum."""
    from app.inter_client import InterClient
    from app.tiny_client import TinyOAuthManager

    recusado = MagicMock(status_code=401, text='{"mensagem": "Token inválido"}')
    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado"}), \
            patch.object(TinyOAuthManager, "is_configured", return_value=False), \
            patch.object(InterClient, "get_extrato", return_value=[]), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"), \
            patch("requests.get", return_value=recusado), \
            patch("time.sleep"):
        token_repo.return_value.is_configured.return_value = False
        res = client.post("/api/v1/reconciliacao/preview", json={"empresa": "revesta", "forcar_atualizacao": True})

    avisos = res.json()["avisos"]
    assert any("Revesta: Falha ao consultar contas no Tiny" in a and "HTTP 401" in a for a in avisos), avisos


def test_reconciliacao_preview_sem_token_do_tiny_avisa(client):
    from app.inter_client import InterClient

    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado"}), \
            patch.object(InterClient, "get_extrato", return_value=[]), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", None):
        token_repo.return_value.is_configured.return_value = False
        res = client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", "forcar_atualizacao": True})

    assert any("token do Tiny não encontrado" in a for a in res.json()["avisos"])

_BAIXA_PAYLOAD = {
    "itens": [
        {
            "empresa": "fabrilux",
            "conta_pagar_id": 12345,
            "valor_pago": 150.50,
            "data_pagamento": "2026-09-25",
            "juros": 0.0,
            "desconto": 0.0,
            "historico": "Baixa teste API",
            # metadados do histórico enviados pelo frontend: devem ser aceitos e ignorados
            "fornecedor_nome": "Alumix",
            "inter_transacao_id": "TX-1",
        }
    ]
}


def _apto_teste(empresa="fabrilux", conta_id=12345, inter_id="TX-1", valor="150.50", juros="0", desconto="0", valor_tiny=None):
    """Registra um casamento apto como a prévia faria (a baixa só aceita o que a prévia guardou)."""
    from types import SimpleNamespace
    from app import api as api_module

    api_module._registrar_aptos([SimpleNamespace(
        empresa=empresa, conta_pagar_id=conta_id, inter_transacao_id=inter_id,
        valor_pago=Decimal(valor), data_pagamento=date(2026, 9, 25),
        juros=Decimal(juros), multa=Decimal("0"), desconto=Decimal(desconto),
        valor_tiny=Decimal(valor_tiny or valor), historico_sugerido=f"Baixa conciliada Banco Inter {inter_id}",
    )])


def _conta_tiny(situacao="aberto", valor=150.50, saldo=None, valor_pago=0.0):
    return ({"id": 12345, "situacao": situacao, "valor": valor, "saldo": valor if saldo is None else saldo,
             "valorPago": valor_pago, "historico": ""}, "token-teste")


def test_reconciliacao_baixar_endpoint(client):
    from app.tiny_client import TinyClient

    _apto_teste()
    with patch.object(TinyClient, "baixar_conta_pagar_v3", return_value=True) as baixar, \
            patch.object(TinyClient, "obter_conta_pagar_v3", return_value=_conta_tiny()), \
            patch.object(TinyClient, "resolve_conta_origem_inter", return_value=42) as resolve_conta, \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        res = client.post("/api/v1/reconciliacao/baixar", json=_BAIXA_PAYLOAD)

    assert res.status_code == 200
    data = res.json()
    assert data["total_sucessos"] == 1
    assert data["resultados"][0]["status"] == "sucesso"
    assert baixar.call_args.kwargs["conta_id"] == 12345
    assert baixar.call_args.kwargs["conta_origem_id"] == 42
    resolve_conta.assert_called_once_with(token="token-teste", account_id="fabrilux")


def test_reconciliacao_baixar_sem_conta_inter_nao_baixa_na_conta_padrao(client):
    from app.tiny_client import TinyClient

    _apto_teste()
    with patch.object(TinyClient, "baixar_conta_pagar_v3") as baixar, \
            patch.object(TinyClient, "obter_conta_pagar_v3", return_value=_conta_tiny()), \
            patch.object(TinyClient, "resolve_conta_origem_inter", return_value=None), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        res = client.post("/api/v1/reconciliacao/baixar", json=_BAIXA_PAYLOAD)

    data = res.json()
    assert data["total_sucessos"] == 0
    assert data["resultados"][0]["status"] == "erro"
    assert "NÃO foi baixada" in data["resultados"][0]["mensagem"]
    baixar.assert_not_called()


def test_reconciliacao_baixar_sem_token_nao_finge_sucesso(client):
    from app.tiny_client import TinyClient

    _apto_teste()
    with patch.object(TinyClient, "baixar_conta_pagar_v3") as baixar, \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", None):
        token_repo.return_value.is_configured.return_value = False
        res = client.post("/api/v1/reconciliacao/baixar", json=_BAIXA_PAYLOAD)

    data = res.json()
    assert data["status"] == "erro"
    assert data["total_sucessos"] == 0
    assert data["resultados"][0]["status"] == "erro"
    assert "NÃO foi baixada" in data["resultados"][0]["mensagem"]
    baixar.assert_not_called()


def test_import_key_rejeita_chave_invalida(client):
    res = client.post("/api/v1/danfe/import-key", json={"chave": "3526 0912 3456"})
    assert res.status_code == 400
    assert "44 dígitos" in res.json()["detail"]


def test_reconciliacao_preview_separa_atrasadas_pagas_e_transferencias(client):
    from app.inter_client import InterClient, InterTransacao
    from app.tiny_client import TinyClient

    def pix(tx_id, valor, nome, doc, dia):
        return InterTransacao(
            empresa="fabrilux", transacao_id=tx_id, data_pagamento=date(2026, 9, dia),
            valor_pago=Decimal(valor), tipo_transacao="PIX", titulo="Pix enviado",
            descricao=nome, nome_favorecido=nome, cpf_cnpj_favorecido=doc,
        )

    extrato = [
        pix("TX-ATRASADA", "500.00", "ALUMIX ALUMINIOS", "11222333000181", 10),
        pix("TX-JA-PAGA", "812.40", "JAMEF TRANSPORTES", "29618350000106", 12),
        pix("TX-GRUPO", "32000.00", "Revesta Decoracoes", "36592814000100", 25),
        pix("TX-SEM-PAR", "77.10", "Fulano de Tal", "12345678901", 20),
    ]
    contas = {
        # vencida em 10/09 e ainda aberta: o Tiny devolve como "atrasadas", não "aberto"
        "atrasadas": [{"id": 1, "numeroDocumento": "NF-1", "valor": 500.00, "dataVencimento": "2026-09-10",
                       "cliente": {"nome": "Alumix Aluminios", "cpfCnpj": "11.222.333/0001-81"}}],
        "pago": [{"id": 2, "numeroDocumento": "CTE-9", "valor": 812.40, "dataVencimento": "2026-09-12",
                  "cliente": {"nome": "Transvia Transportes", "cpfCnpj": "29.618.350/0001-06"}}],
    }

    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado", "mensagem": "ok"}), \
            patch.object(InterClient, "get_extrato", return_value=extrato), \
            patch.object(TinyClient, "list_contas_pagar_v3", side_effect=_contas_por_situacao(contas)), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        res = client.post(
            "/api/v1/reconciliacao/preview",
            json={"empresa": "fabrilux", "data_inicio": "2026-09-01", "data_fim": "2026-09-28"},
        )

    data = res.json()
    assert [m["inter_transacao_id"] for m in data["matches"]] == ["TX-ATRASADA"]
    assert [j["inter_transacao_id"] for j in data["ja_baixadas"]] == ["TX-JA-PAGA"]
    assert data["ja_baixadas"][0]["conta_pagar_id"] == 2
    assert [t["transacao_id"] for t in data["transferencias_internas"]] == ["TX-GRUPO"]
    assert data["transferencias_internas"][0]["empresa_destino_nome"] == "Revesta"
    assert [u["transacao_id"] for u in data["unmatched_inter"]] == ["TX-SEM-PAR"]
    assert data["summary"]["total_inter_sem_par"] == 1
    assert data["summary"]["total_transferencias_internas"] == 1
    assert data["summary"]["valor_ja_baixadas"] == 812.40


def _aguardar_job(client, job_id, timeout=10):
    import time as _time
    fim = _time.time() + timeout
    while _time.time() < fim:
        job = client.get(f"/api/v1/reconciliacao/jobs/{job_id}").json()
        if job["status"] != "executando":
            return job
        _time.sleep(0.05)
    raise AssertionError("tarefa não terminou")


def test_reconciliacao_job_preview_roda_em_segundo_plano(client):
    from app.inter_client import InterClient
    from app.tiny_client import TinyClient

    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado", "mensagem": "ok"}), \
            patch.object(InterClient, "get_extrato", return_value=[]), \
            patch.object(TinyClient, "list_contas_pagar_v3", side_effect=_contas_por_situacao({})) as listar, \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        inicio = client.post("/api/v1/reconciliacao/jobs/preview", json={"empresa": "fabrilux", "data_inicio": "2026-09-01", "data_fim": "2026-09-28"})
        assert inicio.status_code == 200
        # com tudo simulado a tarefa pode terminar antes da resposta; o que importa é o job_id
        assert inicio.json()["status"] in ("executando", "concluido")
        job = _aguardar_job(client, inicio.json()["job_id"])

    assert job["status"] == "concluido", job
    assert job["tipo"] == "preview"
    assert job["resultado"]["status"] == "ok"
    # contas pagas: janela curta (±15 dias do período), não a janela ampliada das pendentes
    pago = [c.kwargs for c in listar.call_args_list if c.kwargs.get("situacao") == "pago"][0]
    assert pago["data_inicial_vencimento"] == "2026-08-17"
    assert pago["data_final_vencimento"] == "2026-10-13"


def test_reconciliacao_job_baixa_e_job_inexistente(client):
    from app.tiny_client import TinyClient

    _apto_teste()
    with patch.object(TinyClient, "baixar_conta_pagar_v3", return_value=True), \
            patch.object(TinyClient, "obter_conta_pagar_v3", return_value=_conta_tiny()), \
            patch.object(TinyClient, "resolve_conta_origem_inter", return_value=42), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        job = _aguardar_job(client, client.post("/api/v1/reconciliacao/jobs/baixar", json=_BAIXA_PAYLOAD).json()["job_id"])

    assert job["status"] == "concluido"
    assert job["resultado"]["total_sucessos"] == 1
    assert client.post("/api/v1/reconciliacao/jobs/baixar", json={"itens": []}).status_code == 400
    assert client.get("/api/v1/reconciliacao/jobs/nao-existe").status_code == 404


def _preview_fabrilux(client, extrato, contas):
    from app.inter_client import InterClient
    from app.tiny_client import TinyClient

    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado", "mensagem": "ok"}), \
            patch.object(InterClient, "get_extrato", return_value=extrato), \
            patch.object(TinyClient, "list_contas_pagar_v3", side_effect=_contas_por_situacao(contas)), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", "token-teste"):
        token_repo.return_value.is_configured.return_value = False
        return client.post(
            "/api/v1/reconciliacao/preview",
            json={"empresa": "fabrilux", "data_inicio": "2026-09-01", "data_fim": "2026-09-28"},
        ).json()


def test_transferencia_interna_com_conta_no_tiny_fica_na_aba_propria_conciliada(client):
    from app.inter_client import InterTransacao

    transf = InterTransacao(
        empresa="fabrilux", transacao_id="TX-GRUPO", data_pagamento=date(2026, 9, 25),
        valor_pago=Decimal("32000.00"), tipo_transacao="PIX", titulo="Pix enviado",
        descricao="Revesta Decoracoes - Ref. a transferência de saldo", nome_favorecido="Revesta Decoracoes",
        cpf_cnpj_favorecido="36592814000100",
    )
    contas = {"aberto": [{"id": 77, "numeroDocumento": "TRANSF-25", "valor": 32000.00, "dataVencimento": "2026-09-25",
                          "cliente": {"nome": "Revesta Decoracoes", "cpfCnpj": "36.592.814/0001-00"}}]}

    data = _preview_fabrilux(client, [transf], contas)

    # não entra em "Contas casadas": é baixada pela aba de transferências
    assert data["matches"] == []
    [t] = data["transferencias_internas"]
    assert t["transacao_id"] == "TX-GRUPO"
    assert t["situacao"] == "apta_baixa"
    assert t["empresa_destino_nome"] == "Revesta"
    assert t["conciliacao"]["conta_pagar_id"] == 77
    assert t["conciliacao"]["valor_pago"] == 32000.00
    assert t["conta_ja_baixada"] is None
    assert data["summary"]["total_transferencias_aptas"] == 1
    assert data["unmatched_tiny"] == []


def test_transferencia_interna_ja_paga_no_tiny(client):
    from app.inter_client import InterTransacao

    transf = InterTransacao(
        empresa="fabrilux", transacao_id="TX-GRUPO", data_pagamento=date(2026, 9, 25),
        valor_pago=Decimal("6000.00"), tipo_transacao="PIX", titulo="Pix enviado",
        descricao="Norvia Acabamentos Ltda", nome_favorecido="Norvia Acabamentos Ltda",
        cpf_cnpj_favorecido="27184930000280",
    )
    contas = {"pago": [{"id": 91, "numeroDocumento": "TRANSF", "valor": 6000.00, "dataVencimento": "2026-09-25",
                        "cliente": {"nome": "Norvia Acabamentos Ltda", "cpfCnpj": "27.184.930/0002-80"}}]}

    data = _preview_fabrilux(client, [transf], contas)

    assert data["ja_baixadas"] == []
    [t] = data["transferencias_internas"]
    assert t["situacao"] == "ja_baixada"
    assert t["empresa_destino_nome"] == "Norvia Curitiba"
    assert t["conta_ja_baixada"]["conta_pagar_id"] == 91
    assert t["conciliacao"] is None


def test_transferencia_interna_nao_casa_por_coincidencia_de_valor(client):
    from app.inter_client import InterTransacao

    transf = InterTransacao(
        empresa="fabrilux", transacao_id="TX-GRUPO", data_pagamento=date(2026, 9, 25),
        valor_pago=Decimal("32000.00"), tipo_transacao="PIX", titulo="Pix enviado",
        descricao="Revesta Decoracoes", nome_favorecido="Revesta Decoracoes", cpf_cnpj_favorecido="36592814000100",
    )
    # conta de terceiro com o mesmo valor: só casaria por "valor único no período"
    contas = {"aberto": [{"id": 88, "numeroDocumento": "NF-9", "valor": 32000.00, "dataVencimento": "2026-09-25",
                          "cliente": {"nome": "Grafica Horizonte", "cpfCnpj": "11.222.333/0001-81"}}]}

    data = _preview_fabrilux(client, [transf], contas)

    assert data["matches"] == []
    assert [t["transacao_id"] for t in data["transferencias_internas"]] == ["TX-GRUPO"]
    assert data["transferencias_internas"][0]["situacao"] == "sem_conta"
    assert [c["id"] for c in data["unmatched_tiny"]] == [88]


def test_erro_do_extrato_inter_aparece_como_aviso(client):
    from app.inter_client import InterClient

    resp = MagicMock(ok=False, status_code=429, text='{"title":"Too Many Requests"}')
    with patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado", "mensagem": "ok"}), \
            patch.object(InterClient, "has_credentials", return_value=True), \
            patch.object(InterClient, "get_cert_pair", return_value=("a.crt", "a.key")), \
            patch.object(InterClient, "get_token", return_value="tok"), \
            patch("app.inter_client.requests.get", return_value=resp), \
            patch("app.api.TokenRepository") as token_repo, \
            patch.object(settings, "TINY_API_TOKEN", None):
        token_repo.return_value.is_configured.return_value = False
        data = client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux"}).json()

    avisos = [a for a in data["avisos"] if "extrato" in a]
    assert len(avisos) == 1
    assert "Banco Inter" in avisos[0] and "HTTP 429" in avisos[0]


# ---------------------------------------------------------------------------
# Cache dos dados da conciliação
# ---------------------------------------------------------------------------

class _FontesSimuladas:
    """Inter/Tiny simulados que contam quantas vezes cada fonte foi consultada."""

    def __init__(self, extrato_falha=False):
        from app.inter_client import InterClient
        from app.tiny_client import TinyClient

        self.extrato = MagicMock(side_effect=RuntimeError("HTTP 503") if extrato_falha else None, return_value=[])
        self.tiny = MagicMock(side_effect=_contas_por_situacao({}))
        self._patches = [
            patch.object(InterClient, "check_credentials_status", return_value={"status": "conectado", "mensagem": "ok"}),
            patch.object(InterClient, "get_extrato", self.extrato),
            patch.object(TinyClient, "list_contas_pagar_v3", self.tiny),
            patch.object(TinyClient, "baixar_conta_pagar_v3", return_value=True),
            patch.object(TinyClient, "obter_conta_pagar_v3", return_value=_conta_tiny()),
            patch.object(TinyClient, "resolve_conta_origem_inter", return_value=42),
            patch.object(settings, "TINY_API_TOKEN", "token-teste"),
        ]
        self._repo = patch("app.api.TokenRepository")

    def __enter__(self):
        for p in self._patches:
            p.start()
        self._repo.start().return_value.is_configured.return_value = False
        return self

    def __exit__(self, *exc):
        self._repo.stop()
        for p in reversed(self._patches):
            p.stop()

    def extratos_por_empresa(self):
        return [c.args[0] for c in self.extrato.call_args_list]


_PERIODO = {"data_inicio": "2026-09-01", "data_fim": "2026-09-28"}


def test_cache_segunda_previa_nao_consulta_inter_nem_tiny(client):
    with _FontesSimuladas() as fontes:
        primeira = client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO}).json()
        chamadas_tiny = fontes.tiny.call_count
        segunda = client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO}).json()

    assert primeira["do_cache"] is False
    assert segunda["do_cache"] is True
    assert fontes.extratos_por_empresa() == ["fabrilux"]
    assert fontes.tiny.call_count == chamadas_tiny == 3  # aberto, atrasadas, pago
    assert segunda["dados_de"] == primeira["dados_de"]


def test_cache_trocar_todas_por_uma_filial_reaproveita(client):
    with _FontesSimuladas() as fontes:
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "todas", **_PERIODO})
        uma = client.post("/api/v1/reconciliacao/preview", json={"empresa": "revesta", **_PERIODO}).json()

    assert sorted(fontes.extratos_por_empresa()) == sorted(["fabrilux", "revesta", "norvia_campinas", "norvia_curitiba"])
    assert uma["do_cache"] is True


def test_cache_forcar_atualizacao_consulta_de_novo(client):
    with _FontesSimuladas() as fontes:
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO})
        forcada = client.post(
            "/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", "forcar_atualizacao": True, **_PERIODO}
        ).json()

    assert forcada["do_cache"] is False
    assert fontes.extratos_por_empresa() == ["fabrilux", "fabrilux"]


def test_cache_outro_periodo_consulta_de_novo(client):
    with _FontesSimuladas() as fontes:
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO})
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", "data_inicio": "2026-08-01", "data_fim": "2026-09-28"})

    assert fontes.extratos_por_empresa() == ["fabrilux", "fabrilux"]


def test_cache_falha_nao_fica_guardada(client):
    with _FontesSimuladas(extrato_falha=True) as fontes:
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO})
        segunda = client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO}).json()

    assert segunda["do_cache"] is False
    assert fontes.extratos_por_empresa() == ["fabrilux", "fabrilux"]


def test_cache_baixa_com_sucesso_move_a_conta_para_pagas_sem_consultar_de_novo(client):
    from app import api as api_module

    with _FontesSimuladas() as fontes:
        fontes.tiny.side_effect = _contas_por_situacao({
            "aberto": [{"id": 12345, "valor": 150.50, "dataVencimento": "2026-09-25", "situacao": "aberto"}],
        })
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "todas", **_PERIODO})
        chamadas_tiny = fontes.tiny.call_count
        _apto_teste()
        client.post("/api/v1/reconciliacao/baixar", json=_BAIXA_PAYLOAD)  # conta 12345 da fabrilux
        depois = client.post("/api/v1/reconciliacao/preview", json={"empresa": "todas", **_PERIODO}).json()

    assert depois["do_cache"] is True
    assert fontes.tiny.call_count == chamadas_tiny
    assert fontes.extratos_por_empresa().count("fabrilux") == 1
    for (emp, *_), dados in api_module._dados_cache.items():
        ids_abertas = {c["id"] for c in dados.tiny_pendentes}
        ids_pagas = {c["id"] for c in dados.tiny_pagas}
        if emp == "fabrilux":
            assert 12345 not in ids_abertas and 12345 in ids_pagas
        else:
            assert 12345 in ids_abertas, "a baixa da fabrilux não mexe nas outras filiais"


def test_job_de_previa_em_cache_volta_concluido_na_hora(client):
    with _FontesSimuladas():
        client.post("/api/v1/reconciliacao/preview", json={"empresa": "fabrilux", **_PERIODO})
        job = client.post("/api/v1/reconciliacao/jobs/preview", json={"empresa": "fabrilux", **_PERIODO}).json()

    assert job["status"] == "concluido"
    assert job["resultado"]["do_cache"] is True


def test_previa_de_todas_as_filiais_busca_em_paralelo(monkeypatch):
    """Cada filial tem conta própria no Tiny/Inter: a prévia não soma a espera de todas."""
    import time as _time
    from app import api as api_module

    atrasos = 0.3

    def dados_lentos(emp, *a, **k):
        _time.sleep(atrasos)
        return api_module._DadosEmpresa([], [], [], [], _time.time(), False), False

    monkeypatch.setattr(api_module, "_dados_empresa", dados_lentos)
    empresas = api_module._empresas_preview(api_module.ReconciliacaoPreviewRequest())
    assert len(empresas) >= 3

    inicio = _time.monotonic()
    api_module._run_preview(api_module.ReconciliacaoPreviewRequest(data_inicio="2026-09-01", data_fim="2026-09-28"))
    assert _time.monotonic() - inicio < atrasos * 2


_CHAVE_XML = "35260645182603000190550030000822281928076078"
_NFE_COMPLETA_XML = f"""<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe{_CHAVE_XML}" versao="4.00">
      <ide><nNF>82228</nNF><dhEmi>2026-06-20T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>45182603000190</CNPJ><xNome>Loja exemplo comercio varejista</xNome></emit>
      <dest><CNPJ>36592814000100</CNPJ><xNome>REVESTA DECORACOES LTDA</xNome></dest>
      <det nItem="1">
        <prod><cProd>1</cProd><xProd>Suporte Aplicador Fita Adesiva</xProd><NCM>84224090</NCM>
          <qCom>1.0000</qCom><vUnCom>72.00</vUnCom><vProd>72.00</vProd></prod>
      </det>
      <total><ICMSTot><vProd>72.00</vProd><vNF>72.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>"""


@patch("app.api.get_nfe_provider")
@patch("app.api.already_launched_in_tiny", return_value=False)
def test_upload_de_xml_completo_le_do_arquivo_sem_consultar_sefaz(
    mock_already, mock_provider_factory, client, tmp_path, monkeypatch
):
    """Nota com mais de 90 dias: a SEFAZ recusa (cStat 632), mas o XML enviado já tem tudo."""
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()
    provider = MagicMock()
    provider.get_nfe_data.side_effect = AssertionError("não deveria consultar a SEFAZ")
    mock_provider_factory.return_value = provider

    response = client.post(
        "/api/v1/danfe/process-batch",
        files={"files": ("invoice-2000017019020870.xml", io.BytesIO(_NFE_COMPLETA_XML.encode()), "text/xml")},
    )

    item = response.json()["items"][0]
    assert item["status"] == "success", item.get("error_message")
    assert item["scan_method"] == "xml"
    assert item["key"] == _CHAVE_XML
    assert item["nfe_data"]["numero_nota"] == "82228"
    assert float(item["nfe_data"]["valor_total"]) == 72.0
    provider.get_nfe_data.assert_not_called()


def test_mesma_chave_na_fila_de_revisao_substitui_a_entrada_anterior(tmp_path, monkeypatch):
    """XML subido de uma nota que a varredura SEFAZ já tinha trazido: um card só, não dois."""
    import json as _json
    from app.review_store import list_pending

    pendentes = tmp_path / "pending_review"
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", pendentes)
    settings.ensure_directories()

    _stage_dummy_nota(tmp_path)
    _stage_dummy_nota(tmp_path)

    assert len(list_pending()) == 1
    assert len(list(pendentes.glob("*.review.json"))) == 1
    json_path = next(pendentes.glob("*.review.json"))
    staged = _json.loads(json_path.read_text())["staged_filename"]
    assert sorted(p.name for p in pendentes.iterdir()) == sorted([json_path.name, staged])


def test_duplicadas_antigas_da_mesma_chave_sao_limpas_ficando_a_mais_recente(tmp_path, monkeypatch):
    import json as _json
    from app.review_store import list_pending

    pendentes = tmp_path / "pending_review"
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", pendentes)
    settings.ensure_directories()
    _stage_dummy_nota(tmp_path)
    original = next(pendentes.glob("*.review.json"))
    payload = _json.loads(original.read_text())
    # simula duas entradas antigas da mesma chave gravadas antes da correção
    for i, quando in enumerate(["2026-09-20T03:00:00", "2026-09-27T03:00:00"], start=1):
        arquivo = pendentes / f"dup{i}.xml"
        arquivo.write_text("<xml/>")
        (pendentes / f"dup{i}.xml.review.json").write_text(
            _json.dumps({**payload, "staged_filename": arquivo.name, "staged_at": quando})
        )

    registros = list_pending()

    assert len(registros) == 1
    assert registros[0].staged_at == payload["staged_at"]  # a mais recente (a de agora)
    assert not (pendentes / "dup1.xml").exists() and not (pendentes / "dup2.xml").exists()
    assert len(list(pendentes.glob("*.review.json"))) == 1


@patch("app.api.get_nfe_provider")
def test_import_key_nota_com_mais_de_90_dias_orienta_a_enviar_o_xml(mock_provider_factory, client):
    provider = MagicMock()
    provider.get_nfe_data.side_effect = RuntimeError(
        "SEFAZ retornou rejeição: cStat 632 - Rejeicao: Solicitacao fora de prazo"
    )
    mock_provider_factory.return_value = provider
    res = client.post("/api/v1/danfe/import-key", json={"chave": "41260552740396000107550010000000241143751412"})
    assert res.status_code == 422
    assert "Upload Manual" in res.json()["detail"]


@patch("app.api.already_launched_in_tiny", return_value=False)
@patch("app.api.get_nfe_provider")
def test_import_key_coloca_a_nota_em_revisao(mock_provider_factory, _mock_tiny, client, tmp_path, monkeypatch):
    # Caminho feliz: faltava file_path no ScanResult e toda importação por chave dava 500.
    monkeypatch.setattr(settings, "INPUT_DIR", tmp_path / "input")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    chave = "35260761937402000101551010000002821368274134"
    provider = MagicMock()
    provider.get_nfe_data.return_value = NFeData(
        chave=chave,
        numero_nota="282",
        data_emissao=date(2026, 7, 10),
        emitente_nome="FORNECEDOR CHAVE LTDA",
        emitente_cnpj="61937402000101",
        valor_total=Decimal("150.00"),
    )
    mock_provider_factory.return_value = provider

    res = client.post("/api/v1/danfe/import-key", json={"chave": chave})

    assert res.status_code == 200, res.text
    assert res.json()["numero_nota"] == "282"
    assert list((tmp_path / "pending_review").glob(f"*{chave}*.review.json"))


def test_erro_nao_tratado_devolve_mensagem_generica_com_id(monkeypatch):
    from fastapi.testclient import TestClient
    from app import api as api_module

    def quebra(*a, **kw):
        raise PermissionError("[Errno 13] Permission denied: '/app/input'")

    monkeypatch.setattr(api_module, "get_nfe_provider", quebra)
    resp = TestClient(api_module.app, raise_server_exceptions=False).post(
        "/api/v1/danfe/import-key", json={"chave": "3" * 44}
    )
    assert resp.status_code == 500
    corpo = resp.json()
    # AUT-10: o motivo fica no log (com o id); o cliente não recebe caminhos/exceções internas.
    assert "Permission denied" not in corpo["detail"]
    assert corpo["erro_id"] and corpo["erro_id"] in corpo["detail"]
