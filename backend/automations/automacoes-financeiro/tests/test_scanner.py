from unittest.mock import patch

import cv2
import numpy as np
import pytest

from app.scanner import DANFEScanner, validate_nfe_key, extract_key_from_text


def generate_valid_nfe_key(base_43: str) -> str:
    """Função utilitária para gerar chave com DV SEFAZ válido a partir de 43 dígitos."""
    assert len(base_43) == 43
    weights = [2, 3, 4, 5, 6, 7, 8, 9]
    total_sum = 0
    weight_idx = 0
    for ch in reversed(base_43):
        total_sum += int(ch) * weights[weight_idx]
        weight_idx = (weight_idx + 1) % len(weights)
    rem = total_sum % 11
    dv = 0 if rem in (0, 1) else (11 - rem)
    return f"{base_43}{dv}"


def test_validate_nfe_key_valid():
    base = "3523091234567800012355001000000123100000012"
    valid_key = generate_valid_nfe_key(base)
    assert len(valid_key) == 44
    assert validate_nfe_key(valid_key) is True


def test_validate_nfe_key_invalid_dv():
    base = "3523091234567800012355001000000123100000012"
    valid_key = generate_valid_nfe_key(base)
    wrong_dv = "0" if valid_key[-1] != "0" else "1"
    invalid_key = valid_key[:-1] + wrong_dv
    assert validate_nfe_key(invalid_key) is False


def test_validate_nfe_key_invalid_length_or_chars():
    assert validate_nfe_key("12345") is False
    assert validate_nfe_key("3523091234567800012355001000000123100000012A") is False
    assert validate_nfe_key("") is False


def test_extract_key_from_text_continuous():
    base = "3523091234567800012355001000000123100000012"
    valid_key = generate_valid_nfe_key(base)
    raw_text = f"DANFE DOCUMENTO AUXILIAR\nCHAVE DE ACESSO: {valid_key}\nPROTOCOLO: 13523000"
    extracted = extract_key_from_text(raw_text)
    assert extracted == valid_key


def test_extract_key_from_text_grouped_spaces():
    base = "3523091234567800012355001000000123100000012"
    valid_key = generate_valid_nfe_key(base)
    grouped = " ".join([valid_key[i:i+4] for i in range(0, 44, 4)])
    raw_text = f"Consulta de autenticidade no portal www.nfe.fazenda.gov.br\nCHAVE:\n{grouped}\n"
    extracted = extract_key_from_text(raw_text)
    assert extracted == valid_key


def _nfce_key() -> str:
    base = "4126094382061700016665001000012345100012345"  # PR, 09/2026, modelo 65
    weights = [2, 3, 4, 5, 6, 7, 8, 9]
    total = sum(int(d) * weights[i % 8] for i, d in enumerate(reversed(base)))
    remainder = total % 11
    return base + str(0 if remainder < 2 else 11 - remainder)


@pytest.mark.parametrize("rotate", [None, cv2.ROTATE_90_CLOCKWISE])
def test_scan_nfce_qrcode_foto_celular(tmp_path, rotate):
    """Foto grande, levemente torta e com ruído do QR de um cupom NFC-e (URL com ?p=<chave>|...)."""
    key = _nfce_key()
    url = f"http://www.fazenda.pr.gov.br/nfce/qrcode?p={key}|2|1|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01"
    qr = cv2.QRCodeEncoder_create().encode(url)
    qr = cv2.resize(qr, (qr.shape[1] * 8,) * 2, interpolation=cv2.INTER_NEAREST)

    photo = np.full((3000, 2200), 235, np.uint8)
    photo[1400:1400 + qr.shape[0], 700:700 + qr.shape[1]] = qr
    photo = cv2.GaussianBlur(photo, (5, 5), 0)
    photo = cv2.warpAffine(photo, cv2.getRotationMatrix2D((1100, 1500), 7, 1), (2200, 3000), borderValue=200)
    rng = np.random.default_rng(0)
    photo = np.clip(photo.astype(int) + rng.normal(0, 8, photo.shape), 0, 255).astype(np.uint8)
    if rotate is not None:
        photo = cv2.rotate(photo, rotate)

    path = tmp_path / "cupom_nfce.jpg"
    cv2.imwrite(str(path), photo, [cv2.IMWRITE_JPEG_QUALITY, 80])

    with patch("app.scanner.PYZBAR_AVAILABLE", False):  # o QR não pode depender da libzbar
        result = DANFEScanner().scan_file(path)

    assert result is not None
    assert result.key == key
    assert result.method == "barcode"
