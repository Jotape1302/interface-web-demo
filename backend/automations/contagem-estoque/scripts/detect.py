#!/usr/bin/env python3
"""
Conta os marcadores de uma foto pelo terminal, com o MESMO detector do bot.

    python scripts/detect.py foto_estoque.jpg [--output-dir temp/processed]
"""
import argparse
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import BotSettings, DetectorSettings  # noqa: E402
from app.detector import detect_markers  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Conta os prendedores verdes em uma fotografia.")
    parser.add_argument("image", type=Path, help="Caminho da fotografia")
    parser.add_argument("--output-dir", type=Path, default=None, help="Onde gravar a imagem anotada")
    args = parser.parse_args()

    output_dir = args.output_dir or BotSettings().processed_dir
    try:
        result = detect_markers(args.image, output_dir, uuid.uuid4().hex, DetectorSettings())
    except (ValueError, OSError) as e:
        print(f"Erro: {e}", file=sys.stderr)
        return 1

    print(f"Marcadores detectados: {result.count}")
    print(f"Imagem processada: {result.annotated_image_path.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
