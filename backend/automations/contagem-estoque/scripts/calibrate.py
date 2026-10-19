#!/usr/bin/env python3
"""
Ferramenta de calibração (só para desenvolvimento). Para uma foto, grava:

  1_original.jpg            imagem na resolução de processamento
  2_mascara.png             máscara da cor do marcador (branco = entrou na faixa HSV)
  3_regioes.jpg             só o que entrou na máscara, com cada região em caixa:
                            verde = contada, vermelho = descartada (e o motivo)
  4_anotada.jpg             exatamente o que o bot devolve
  painel.jpg                as quatro lado a lado

e imprime cada região com área, proporção e HSV mediano, para ajustar a configuração.
Os parâmetros vêm do .env/ambiente, então dá para testar sem editar nada:

    MARKER_HUE_MIN=40 MIN_MARKER_AREA=80 python scripts/calibrate.py foto.jpg
"""
import argparse
import sys
import uuid
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import BotSettings, DetectorSettings  # noqa: E402
from app.detector import Analysis, analyze, annotate, load_image, save_jpeg  # noqa: E402

_ACCEPTED = (0, 200, 0)
_REJECTED = (0, 0, 255)
_DIM_FACTOR = 0.25  # quanto escurecer o que ficou fora da máscara


def regions_view(analysis: Analysis) -> np.ndarray:
    dimmed = (analysis.image * _DIM_FACTOR).astype(np.uint8)
    view = np.where(analysis.mask[..., None] > 0, analysis.image, dimmed)
    for cand in analysis.candidates:
        x, y, w, h = cand.bbox
        color = _REJECTED if cand.rejection else _ACCEPTED
        cv2.rectangle(view, (x, y), (x + w, y + h), color, 2)
        if cand.rejection:
            cv2.putText(view, cand.rejection, (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)
    return view


def panel(images: list[np.ndarray]) -> np.ndarray:
    tiles = [cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if img.ndim == 2 else img for img in images]
    return np.vstack([np.hstack(tiles[0:2]), np.hstack(tiles[2:4])])


def median_hsv(analysis: Analysis, bbox: tuple[int, int, int, int]) -> tuple[int, int, int] | None:
    x, y, w, h = bbox
    hsv = cv2.cvtColor(analysis.image[y : y + h, x : x + w], cv2.COLOR_BGR2HSV)
    pixels = hsv[analysis.mask[y : y + h, x : x + w] > 0]
    if len(pixels) == 0:
        return None
    return tuple(int(v) for v in np.median(pixels, axis=0))


def print_report(analysis: Analysis, settings: DetectorSettings) -> None:
    print(f"Marcadores contados: {len(analysis.detections)}")
    print(
        f"Faixa HSV: H {settings.MARKER_HUE_MIN}-{settings.MARKER_HUE_MAX}  "
        f"S {settings.MARKER_SATURATION_MIN}-{settings.MARKER_SATURATION_MAX}  "
        f"V {settings.MARKER_VALUE_MIN}-{settings.MARKER_VALUE_MAX}"
    )
    print(
        f"Área aceita nesta imagem: {analysis.min_area:.0f}"
        f"-{settings.MAX_MARKER_AREA * analysis.area_scale:.0f} px  |  "
        f"proporção {settings.MIN_ASPECT_RATIO}-{settings.MAX_ASPECT_RATIO}  |  "
        f"escala {analysis.scale:.3f}  |  junta pedaços a até {analysis.merge_gap:.1f} px"
    )
    print(f"\n{'status':<14}{'x,y,larg,alt':<22}{'área':>8}{'proporção':>11}   HSV mediano")
    for cand in sorted(analysis.candidates, key=lambda c: (c.bbox[1], c.bbox[0])):
        hsv = median_hsv(analysis, cand.bbox)
        print(
            f"{cand.rejection or 'contado':<14}{','.join(map(str, cand.bbox)):<22}"
            f"{cand.area:>8.0f}{cand.aspect_ratio:>11}   {hsv if hsv else '-'}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Gera máscara e imagens de calibração da cor do marcador.")
    parser.add_argument("image", type=Path)
    parser.add_argument("--output-dir", type=Path, default=None, help="Padrão: temp/calibracao/<foto>_<id>")
    args = parser.parse_args()

    settings = DetectorSettings()
    try:
        analysis = analyze(load_image(args.image), settings)
    except ValueError as e:
        print(f"Erro: {e}", file=sys.stderr)
        return 1

    out = args.output_dir or BotSettings().TEMP_DIR / "calibracao" / f"{args.image.stem}_{uuid.uuid4().hex[:8]}"
    views = [analysis.image, analysis.mask, regions_view(analysis), annotate(analysis.image, analysis.detections)]
    save_jpeg(views[0], out / "1_original.jpg")
    cv2.imwrite(str(out / "2_mascara.png"), views[1])
    save_jpeg(views[2], out / "3_regioes.jpg")
    save_jpeg(views[3], out / "4_anotada.jpg")
    save_jpeg(panel(views), out / "painel.jpg")

    print_report(analysis, settings)
    print(f"\nArquivos em: {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
