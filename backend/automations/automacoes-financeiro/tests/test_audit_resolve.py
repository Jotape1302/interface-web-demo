"""resolve_failures_for_chave: falhas abertas da nota saem das pendências quando ela é lançada."""

import json

from app.audit import load_resolved_failures, mark_failure_resolved, record_audit_error, resolve_failures_for_chave
from app.config import settings

CHAVE = "35261176139148000173550010000001231000000123"
OUTRA = "35261176139148000173550010000001241000000124"


def test_resolve_so_as_abertas_da_chave(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    a = record_audit_error(details="fornecedor", chave_acesso=CHAVE, step="tiny_erp", cfg=settings).name
    b = record_audit_error(details="scan", chave_acesso=CHAVE, step="receita_federal", cfg=settings).name
    c = record_audit_error(details="outra nota", chave_acesso=OUTRA, step="tiny_erp", cfg=settings).name
    antes = mark_failure_resolved(b, cfg=settings)

    assert sorted(resolve_failures_for_chave(CHAVE)) == [a]
    resolvidas = load_resolved_failures(settings)
    assert a in resolvidas and resolvidas[b] == antes and c not in resolvidas
    assert resolve_failures_for_chave(CHAVE) == []  # idempotente


def test_chave_invalida_nao_varre_nada(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    record_audit_error(details="x", chave_acesso=CHAVE, step="tiny_erp", cfg=settings)
    assert resolve_failures_for_chave("") == []
    assert resolve_failures_for_chave("*") == []
    assert not (tmp_path / "failed" / "_resolved.json").exists()


def test_nome_com_a_chave_mas_conteudo_de_outra_nao_resolve(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "FAILED_DIR", tmp_path / "failed")
    f = record_audit_error(details="x", chave_acesso=CHAVE, step="tiny_erp", cfg=settings)
    dados = json.loads(f.read_text(encoding="utf-8"))
    dados["chave_acesso"] = OUTRA
    f.write_text(json.dumps(dados), encoding="utf-8")
    assert resolve_failures_for_chave(CHAVE) == []
