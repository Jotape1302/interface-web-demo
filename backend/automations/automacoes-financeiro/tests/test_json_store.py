import json
import os
import stat

from app.json_store import erro_gravacao, limpar_erros_gravacao, save_json_state, write_json_atomic


def test_grava_por_cima_de_arquivo_sem_permissao_de_escrita(tmp_path):
    """Caso de produção (2026-09-25): arquivo antigo -rw-r--r- de outro dono, pasta gravável."""
    alvo = tmp_path / "financial_dashboard_status.json"
    alvo.write_text('{"last_sync_finished_at": "2026-09-25T04:30:32"}')
    alvo.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)  # 0444: open(path, "w") falharia

    write_json_atomic(alvo, {"last_sync_finished_at": "2026-09-28T04:30:00"})

    assert json.loads(alvo.read_text())["last_sync_finished_at"] == "2026-09-28T04:30:00"
    assert [p.name for p in tmp_path.iterdir()] == ["financial_dashboard_status.json"]  # sem .tmp sobrando


def test_falha_de_gravacao_fica_exposta_e_some_ao_gravar_de_novo(tmp_path):
    limpar_erros_gravacao()
    pasta = tmp_path / "data"
    pasta.mkdir()
    alvo = pasta / "sefaz_nsu_state.json"
    pasta.chmod(stat.S_IRUSR | stat.S_IXUSR)  # pasta sem escrita: nem a troca atômica funciona
    try:
        assert save_json_state(alvo, {"ult_nsu": "1"}, "TESTE") is False
        assert "sefaz_nsu_state.json" in (erro_gravacao(alvo) or "")
    finally:
        pasta.chmod(stat.S_IRWXU)

    assert save_json_state(alvo, {"ult_nsu": "2"}, "TESTE") is True
    assert erro_gravacao(alvo) is None
    assert json.loads(alvo.read_text()) == {"ult_nsu": "2"}
    assert not any(n.endswith(".tmp") for n in os.listdir(pasta))


def test_arquivo_gravado_fica_legivel_para_o_backup_do_host(tmp_path):
    # mkstemp cria 0600; no Docker rootless o backup.sh (outro uid no host) não leria.
    destino = tmp_path / "sefaz_nsu_state.json"
    write_json_atomic(destino, {"ultNSU": "1"})
    assert stat.S_IMODE(os.stat(destino).st_mode) == 0o644
