import json
from pathlib import Path
from unittest.mock import MagicMock

from app.config import settings
from app.main import NFeAutomationOrchestrator
from app.nfe_client import NFeData, MockNFeProvider
from app.scanner import ScanResult
from app.tiny_client import TinyClient


def test_orchestrator_successful_flow(tmp_path: Path, monkeypatch):
    input_dir = tmp_path / "input"
    processed_dir = tmp_path / "processed"
    failed_dir = tmp_path / "failed"
    log_dir = tmp_path / "logs"

    monkeypatch.setattr(settings, "INPUT_DIR", input_dir)
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed_dir)
    monkeypatch.setattr(settings, "FAILED_DIR", failed_dir)
    monkeypatch.setattr(settings, "LOG_DIR", log_dir)
    monkeypatch.setattr(settings, "MOCK_MODE", True)  # simulação só com MOCK_MODE=true explícito
    settings.ensure_directories()

    test_file = input_dir / "danfe_teste.pdf"
    test_file.write_bytes(b"%PDF-1.4 dummy content")

    mock_scanner = MagicMock()
    mock_scanner.scan_file.return_value = ScanResult(
        key="35230912345678000123550010000001231000000123",
        method="barcode",
        file_path=test_file,
        page_number=1
    )

    mock_provider = MockNFeProvider()
    tiny_client = TinyClient(token="mock")

    orchestrator = NFeAutomationOrchestrator(
        scanner=mock_scanner,
        nfe_provider=mock_provider,
        tiny_client=tiny_client
    )

    success = orchestrator.process_file(test_file)
    assert success is True

    assert not test_file.exists()
    processed_file = processed_dir / "danfe_teste.pdf"
    assert processed_file.exists()

    meta_file = processed_dir / "danfe_teste.pdf.meta.json"
    assert meta_file.exists()
    with open(meta_file, "r", encoding="utf-8") as f:
        meta_data = json.load(f)
    assert meta_data["chave_acesso"] == "35230912345678000123550010000001231000000123"
    assert meta_data["metodo_leitura"] == "barcode"
    # Padronização de negócio: mesmo com múltiplas duplicatas na NF-e mockada,
    # o lançamento no Tiny é sempre 1 parcela única (ver NFeData.get_effective_duplicatas).
    assert len(meta_data["lancamentos_tiny"]) == 1


def test_orchestrator_failed_scan_flow(tmp_path: Path, monkeypatch):
    input_dir = tmp_path / "input"
    processed_dir = tmp_path / "processed"
    failed_dir = tmp_path / "failed"
    log_dir = tmp_path / "logs"

    monkeypatch.setattr(settings, "INPUT_DIR", input_dir)
    monkeypatch.setattr(settings, "PROCESSED_DIR", processed_dir)
    monkeypatch.setattr(settings, "FAILED_DIR", failed_dir)
    monkeypatch.setattr(settings, "LOG_DIR", log_dir)
    settings.ensure_directories()

    test_file = input_dir / "danfe_ilegivel.png"
    test_file.write_bytes(b"dummy image")

    mock_scanner = MagicMock()
    mock_scanner.scan_file.return_value = None

    orchestrator = NFeAutomationOrchestrator(
        scanner=mock_scanner,
        nfe_provider=MockNFeProvider(),
        tiny_client=TinyClient(token="mock")
    )

    success = orchestrator.process_file(test_file)
    assert success is False

    assert not test_file.exists()
    failed_file = failed_dir / "danfe_ilegivel.png"
    assert failed_file.exists()

    error_file = failed_dir / "danfe_ilegivel.png.error.txt"
    assert error_file.exists()
    content = error_file.read_text(encoding="utf-8")
    assert "Chave de acesso não localizada" in content
