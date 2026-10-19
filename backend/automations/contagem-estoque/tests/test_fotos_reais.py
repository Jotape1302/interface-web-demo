"""
Regressão com fotos reais do estoque (tests/fotos_reais/contagens.csv): qualquer mudança no
detector que altere a contagem de uma foto conhecida faz este teste falhar. Para crescer a
base, ver README ("Base de validação").

Na cópia de portfólio as fotos reais não são publicadas: sem a pasta, o módulo é pulado.
"""
import csv
from pathlib import Path

import pytest

from app.codigo import ler_codigos
from app.config import DetectorSettings
from app.detector import analyze, load_image

PASTA = Path(__file__).parent / "fotos_reais"
pytestmark = pytest.mark.skipif(not PASTA.is_dir(), reason="fotos reais fora da cópia de portfólio")


def _base():
    if not PASTA.is_dir():
        return []
    with (PASTA / "contagens.csv").open(encoding="utf-8") as f:
        return [(linha["arquivo"], int(linha["quantidade"])) for linha in csv.DictReader(f, delimiter=";")]


@pytest.mark.parametrize("arquivo,esperado", _base())
def test_contagem_bate_com_a_foto_real(arquivo, esperado):
    analise = analyze(load_image(PASTA / arquivo), DetectorSettings(_env_file=None))
    assert len(analise.detections) == esperado


def test_etiquetas_pequenas_atuais_nao_sao_lidas():
    """Documenta o limite: os QR de ~25 px dos montantes nessas fotos (1280 px) não são lidos."""
    assert ler_codigos(load_image(PASTA / "prateleira-n6-01.jpg")) == []
