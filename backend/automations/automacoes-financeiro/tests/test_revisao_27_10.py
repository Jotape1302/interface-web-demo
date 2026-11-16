"""Correções da revisão de 2026-10-27: fuso, retry HTTP, lote DANFE fora do event loop, dinheiro."""
import asyncio
import io
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import fuso, http_retry
from app.api import app
from app.config import settings
from app.dinheiro import dinheiro_json
from app.ml_apis import APIMercadoError, ClienteMercadoLivre
from app.ml_reconciliation_rotina import baixa_entrou
from app.nfe_client import MockNFeProvider
from app.scanner import ScanResult
from app import tiny_client
from tests.test_ml_correcoes import _executar, _grupo_ana, _rotina, _TinyComValorPago


# ─── AUT-04/05: fuso de São Paulo ───────────────────────────────────────────


def _relogio_fixo(monkeypatch, instante_utc: datetime):
    class _DT(datetime):
        @classmethod
        def now(cls, tz=None):
            return instante_utc.astimezone(tz) if tz else instante_utc

    monkeypatch.setattr(fuso, "datetime", _DT)


def test_hoje_sp_perto_da_meia_noite_utc(monkeypatch):
    # 28/10 01:30 UTC ainda é 27/10 22:30 em São Paulo.
    _relogio_fixo(monkeypatch, datetime(2026, 10, 28, 1, 30, tzinfo=timezone.utc))
    assert fuso.hoje_sp() == date(2026, 10, 27)
    assert fuso.agora_sp().utcoffset().total_seconds() == -3 * 3600
    assert fuso.agora_sp_naive().hour == 22 and fuso.agora_sp_naive().tzinfo is None


def test_fuso_sp_e_a_mesma_zona_nos_modulos():
    from app import ml_apis, ml_reconciliation

    assert ml_apis.FUSO_SP is fuso.FUSO_SP and ml_reconciliation.FUSO_SP is fuso.FUSO_SP
    assert fuso.FUSO_SP.key == "America/Sao_Paulo"


# ─── AUT-06: retry com Retry-After ──────────────────────────────────────────


class _Resp:
    def __init__(self, status, headers=None, body=None):
        self.status_code, self.headers, self._body = status, headers or {}, body or {}
        self.content, self.text = b"{}", ""

    def json(self):
        return self._body


class _Http:
    def __init__(self, *respostas):
        self.respostas, self.chamadas = list(respostas), []

    def request(self, metodo, url, **kw):
        self.chamadas.append(metodo)
        return self.respostas.pop(0)


def _cliente(http):
    return ClienteMercadoLivre("conta", lambda: "tok", http=http, base_url="https://ml.test")


def test_429_respeita_retry_after_com_teto(monkeypatch):
    esperas = []
    monkeypatch.setattr("app.ml_apis.time.sleep", esperas.append)
    http = _Http(_Resp(429, {"Retry-After": "7"}), _Resp(429, {"Retry-After": "900"}), _Resp(200))
    _cliente(http)._chamar("GET", "/x", "ler")
    assert esperas == [7.0, 60.0]  # teto de 60 s


def test_429_sem_retry_after_usa_backoff_exponencial_com_jitter(monkeypatch):
    esperas = []
    monkeypatch.setattr("app.ml_apis.time.sleep", esperas.append)
    http = _Http(_Resp(429), _Resp(429), _Resp(429), _Resp(200))
    _cliente(http)._chamar("GET", "/x", "ler")
    assert len(esperas) == 3 and len(http.chamadas) == 4  # até 4 tentativas
    assert 1 <= esperas[0] <= 1.5 and 2 <= esperas[1] <= 3 and 4 <= esperas[2] <= 6


def test_5xx_repete_leitura_mas_nao_repete_escrita(monkeypatch):
    monkeypatch.setattr("app.ml_apis.time.sleep", lambda s: None)
    leitura = _Http(_Resp(503), _Resp(200))
    _cliente(leitura)._chamar("GET", "/x", "ler")
    assert leitura.chamadas == ["GET", "GET"]

    escrita = _Http(_Resp(503), _Resp(200))
    with pytest.raises(APIMercadoError):
        _cliente(escrita)._chamar("POST", "/x", "gravar")
    assert escrita.chamadas == ["POST"]  # sem repetir a escrita

    limitada = _Http(_Resp(429, {"Retry-After": "1"}), _Resp(200))
    _cliente(limitada)._chamar("POST", "/x", "gravar")
    assert limitada.chamadas == ["POST", "POST"]  # 429 repete (o servidor recusou antes)


def test_retry_after_em_data_http_e_invalido():
    assert http_retry.retry_after_segundos(_Resp(429, {"Retry-After": "abc"})) is None
    assert http_retry.retry_after_segundos(_Resp(429, {})) is None
    assert http_retry.retry_after_segundos(_Resp(429, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"})) == 0.0


def test_tiny_get_com_retry_respeita_retry_after(monkeypatch):
    esperas = []
    monkeypatch.setattr(tiny_client.time, "sleep", esperas.append)
    monkeypatch.setattr(tiny_client, "_throttle_tiny_api_call", lambda *a: None)
    respostas = [_Resp(429, {"Retry-After": "3"}), _Resp(500), _Resp(200)]
    monkeypatch.setattr(tiny_client.requests, "get", lambda url, **kw: respostas.pop(0))
    resp = tiny_client._get_com_retry("https://tiny.test", headers={})
    assert resp.status_code == 200 and esperas[0] == 3.0 and len(esperas) == 2


# ─── AUT-01: dinheiro em Decimal ────────────────────────────────────────────


def test_valor_para_tiny_quantiza_a_duas_casas():
    assert tiny_client._valor_para_tiny(Decimal("133.775")) == 133.78
    assert tiny_client._valor_para_tiny(Decimal("0.1") + Decimal("0.2")) == 0.3
    assert tiny_client._valor_para_tiny(44.05) == 44.05


def test_baixa_entrou_compara_em_decimal():
    tent = {"valor": "0.30", "valor_pago_antes": "0.1", "saldo_antes": "10"}
    assert baixa_entrou(tent, {"valorPago": Decimal("0.4")}) is True
    assert baixa_entrou(tent, {"valorPago": Decimal("0.3")}) is False


def test_dinheiro_json_arredonda_sem_residuo_de_float():
    assert dinheiro_json(sum((Decimal("0.1"),) * 3, Decimal("0"))) == 0.3
    assert dinheiro_json("10.005") == 10.01
    assert dinheiro_json(None) == 0.0


# ─── AUT-02: releitura de conferência que também falha ──────────────────────


def test_releitura_de_conferencia_que_falha_e_logada_com_tipo_e_mensagem(tmp_path, caplog):
    tiny = _TinyComValorPago(falha="timeout", entra=True, releitura_falha=True)
    r = _rotina(tmp_path, tiny=tiny)
    analise, _ = _executar(r)
    with caplog.at_level("WARNING"):
        res = r.baixar(analise.id, [_grupo_ana(analise)])
    assert res["total_falhas"] == 1 and "sem confirmação" in res["resultados"][0]["mensagem"]
    assert "releitura de conferência falhou" in caplog.text
    assert "ConnectionError: Tiny fora do ar" in caplog.text


# ─── AUT-03: lote DANFE não bloqueia o event loop ───────────────────────────


@patch("app.routers.danfe.DANFEScanner")
@patch("app.routers.danfe.get_nfe_provider")
def test_process_batch_roda_trabalho_sincrono_em_thread(mock_nfe, mock_scanner_class, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    monkeypatch.setattr(settings, "PENDING_REVIEW_DIR", tmp_path / "pending_review")
    settings.ensure_directories()
    scanner = MagicMock()
    scanner.scan_file.return_value = ScanResult(
        key="35230912345678000123550010000001231000000123", method="barcode",
        file_path=Path("d.pdf"), page_number=1,
    )
    mock_scanner_class.return_value = scanner
    mock_nfe.return_value = MockNFeProvider()

    chamadas = []
    original = asyncio.to_thread

    async def espiao(func, *args, **kwargs):
        chamadas.append(getattr(func, "__name__", str(func)))
        return await original(func, *args, **kwargs)

    monkeypatch.setattr("app.routers.danfe.asyncio.to_thread", espiao)
    resp = TestClient(app).post(
        "/api/v1/danfe/process-batch",
        files=[("files", ("a.pdf", io.BytesIO(b"%PDF-1.4 x"), "application/pdf"))],
    )
    assert resp.status_code == 200 and resp.json()["success_count"] == 1
    assert "_processar_arquivo" in chamadas  # scan + SEFAZ/Tiny fora do loop
    assert resp.json()["items"][0]["processed_at"].endswith("-03:00")


@patch("app.routers.danfe.DANFEScanner")
@patch("app.routers.danfe.get_nfe_provider")
def test_process_batch_falha_do_scan_nao_derruba_o_lote(mock_nfe, mock_scanner_class, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    settings.ensure_directories()
    scanner = MagicMock()
    scanner.scan_file.side_effect = ValueError("imagem corrompida")
    mock_scanner_class.return_value = scanner
    resp = TestClient(app).post(
        "/api/v1/danfe/process-batch",
        files=[("files", ("a.pdf", io.BytesIO(b"%PDF-1.4 x"), "application/pdf"))],
    )
    item = resp.json()["items"][0]
    assert resp.status_code == 200 and item["status"] == "error" and item["step"] == "scan"
    assert "imagem corrompida" in item["error_message"]
