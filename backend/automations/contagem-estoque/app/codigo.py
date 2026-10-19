"""
Leitura do código da prateleira (código de barras ou QR) na mesma foto da contagem.

A contagem só vale para o estoque se a foto identificar UMA prateleira: o bot recusa o
registro quando não acha código nenhum ou acha mais de um. Leitores, do mais completo ao
mais simples:
- pyzbar (libzbar): Code 128, Code 39, EAN/UPC, QR... — o padrão no container (Dockerfile
  instala libzbar0);
- OpenCV: QR (QRCodeDetector) e EAN/UPC (barcode.BarcodeDetector) — sempre disponível; é o
  que sobra quando a libzbar não está instalada (ex.: máquina de desenvolvimento).

Códigos pequenos na foto não são lidos: nas fotos de teste (1280 px, foto comprimida pelo
Telegram) as etiquetas QR atuais dos montantes, com ~25 px, nem foram localizadas. A etiqueta
da prateleira precisa ocupar ~150 px de largura na foto, ou a foto ir "como arquivo".
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

logger = logging.getLogger("contagem_estoque.codigo")

try:  # a libzbar é biblioteca do sistema: sem ela o import falha
    from pyzbar import pyzbar as _pyzbar
except Exception as e:  # pragma: no cover - depende do sistema
    _pyzbar = None
    logger.warning("pyzbar/libzbar indisponível (%s): lendo só QR e EAN/UPC pelo OpenCV", e)

# Abaixo deste lado maior a imagem é ampliada 2x numa segunda tentativa (códigos pequenos).
_AMPLIAR_ABAIXO_DE = 2000


def leitor_completo() -> bool:
    """True quando Code 128 e demais formatos 1D são lidos (pyzbar disponível)."""
    return _pyzbar is not None


def _pyzbar_ler(cinza: np.ndarray) -> set[str]:
    if _pyzbar is None:
        return set()
    achados = set()
    for simbolo in _pyzbar.decode(cinza):
        try:
            texto = simbolo.data.decode("utf-8").strip()
        except UnicodeDecodeError:
            continue
        if texto:
            achados.add(texto)
    return achados


def _opencv_ler(imagem: np.ndarray) -> set[str]:
    achados: set[str] = set()
    try:
        ok, textos, _pontos, _ = cv2.QRCodeDetector().detectAndDecodeMulti(imagem)
        if ok:
            achados.update(t.strip() for t in textos if t and t.strip())
    except cv2.error:
        pass
    try:
        ok, textos, *_ = cv2.barcode.BarcodeDetector().detectAndDecodeMulti(imagem)
        if ok:
            achados.update(t.strip() for t in textos if t and t.strip())
    except (cv2.error, AttributeError):
        pass
    return achados


def ler_codigos(imagem: np.ndarray) -> list[str]:
    """Textos distintos dos códigos encontrados na imagem (vazio = nenhum lido)."""
    cinza = cv2.cvtColor(imagem, cv2.COLOR_BGR2GRAY) if imagem.ndim == 3 else imagem
    achados = _pyzbar_ler(cinza) | _opencv_ler(imagem)
    if not achados and max(imagem.shape[:2]) < _AMPLIAR_ABAIXO_DE:
        ampliada = cv2.resize(imagem, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        cinza2 = cv2.cvtColor(ampliada, cv2.COLOR_BGR2GRAY) if ampliada.ndim == 3 else ampliada
        achados = _pyzbar_ler(cinza2) | _opencv_ler(ampliada)
    return sorted(achados)
