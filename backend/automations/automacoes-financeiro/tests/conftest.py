import pytest


@pytest.fixture(autouse=True)
def _limpa_cache_conciliacao():
    """O cache da conciliação vive no módulo: sem isto, um teste herdaria os dados simulados do anterior."""
    from app.api import invalidar_cache_conciliacao, limpar_aptos_baixa

    invalidar_cache_conciliacao()
    limpar_aptos_baixa()
    yield
    invalidar_cache_conciliacao()
    limpar_aptos_baixa()


@pytest.fixture(autouse=True)
def _sem_chave_interna_por_padrao(monkeypatch):
    """
    A chave interna (app/internal_auth.py) tem testes próprios em test_internal_auth.py; nos
    demais a checagem fica desligada, como em dev local.
    """
    monkeypatch.setenv("INTERNAL_AUTH_DISABLED", "true")
    monkeypatch.delenv("AUTOMATIONS_INTERNAL_KEY", raising=False)


@pytest.fixture(autouse=True)
def _registro_de_baixas_isolado(tmp_path, monkeypatch):
    """O registro persistente de baixas do Inter vai para uma pasta temporária por teste."""
    from app import api

    monkeypatch.setattr(api, "_arquivo_registro_baixas", lambda: tmp_path / "reconciliacao_inter_baixas.json")


@pytest.fixture(autouse=True)
def _falhar_gravacao_fora_tmp(tmp_path, monkeypatch):
    """T1: Faz falhar qualquer gravação atômica que tente escrever fora de diretório temporário."""
    import tempfile
    from pathlib import Path
    from app import json_store

    orig_write = json_store.write_json_atomic

    class NonHermeticWriteError(BaseException):
        pass

    def safe_write(path, data, indent=2, mode=json_store.FILE_MODE):
        p = Path(path).resolve()
        tmp_root = Path(tempfile.gettempdir()).resolve()
        try:
            p.relative_to(tmp_root)
        except ValueError:
            raise NonHermeticWriteError(f"T1: Gravação atômica não-hermética fora de tmp_path detectada em: {p}")
        return orig_write(path, data, indent=indent, mode=mode)

    monkeypatch.setattr(json_store, "write_json_atomic", safe_write)


@pytest.fixture(autouse=True)
def _isolamento_tokens_ml(tmp_path, monkeypatch):
    """T1: Garante hermeticidade para manipulação de tokens ML redirecionando DATA_DIR e ML_TOKENS_FILE para tmp_path."""
    from app.config import settings
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ML_TOKENS_FILE", str(tmp_path / "ml_tokens.json"))
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(settings, "ML_TOKENS_FILE", tmp_path / "ml_tokens.json")


