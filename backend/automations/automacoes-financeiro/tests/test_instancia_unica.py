"""Um processo da API por DATA_DIR (app/instancia_unica.py)."""
import subprocess
import sys

from app import instancia_unica


def test_segunda_instancia_da_api_no_mesmo_data_dir_falha(tmp_path):
    instancia_unica.adquirir(tmp_path)
    try:
        # Outro processo (flock é por descrição de arquivo aberta: dentro do mesmo processo
        # não daria para simular a segunda instância).
        codigo = (
            "import sys; from pathlib import Path; from app import instancia_unica as i\n"
            "try:\n    i.adquirir(Path(sys.argv[1]))\nexcept i.OutraInstanciaAtiva as e:\n"
            "    print(e); sys.exit(3)\n"
        )
        res = subprocess.run([sys.executable, "-c", codigo, str(tmp_path)], capture_output=True, text=True)
        assert res.returncode == 3, res.stderr
        assert "Outra instância" in res.stdout
    finally:
        instancia_unica.liberar()

    res = subprocess.run([sys.executable, "-c", codigo, str(tmp_path)], capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
