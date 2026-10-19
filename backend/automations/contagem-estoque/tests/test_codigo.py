"""Leitura do código da prateleira (app/codigo.py)."""
import cv2
import numpy as np
import pytest

from app.codigo import leitor_completo, ler_codigos


def _qr(texto: str, lado: int) -> np.ndarray:
    qr = cv2.QRCodeEncoder.create().encode(texto)
    qr = cv2.copyMakeBorder(qr, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(cv2.resize(qr, (lado, lado), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)


def _fundo() -> np.ndarray:
    return np.full((900, 1280, 3), 150, np.uint8)


def test_le_um_qr():
    img = _fundo()
    img[100:300, 100:300] = _qr("PRAT-N6-AP2", 200)
    assert ler_codigos(img) == ["PRAT-N6-AP2"]


def test_le_dois_qr_distintos():
    img = _fundo()
    img[100:300, 100:300] = _qr("PRAT-A", 200)
    img[100:300, 600:800] = _qr("PRAT-B", 200)
    assert ler_codigos(img) == ["PRAT-A", "PRAT-B"]


def test_foto_sem_codigo():
    assert ler_codigos(_fundo()) == []


@pytest.mark.skipif(not leitor_completo(), reason="libzbar não instalada (no container ela existe)")
def test_le_code128_com_pyzbar():
    barcode = pytest.importorskip("barcode")
    from io import BytesIO

    from barcode.writer import ImageWriter

    buf = BytesIO()
    barcode.get("code128", "PRAT-N6-AP2", writer=ImageWriter()).write(buf)
    etiqueta = cv2.imdecode(np.frombuffer(buf.getvalue(), np.uint8), cv2.IMREAD_COLOR)
    img = _fundo()
    h, w = etiqueta.shape[:2]
    img[100:100 + h, 100:100 + w] = etiqueta
    assert ler_codigos(img) == ["PRAT-N6-AP2"]
