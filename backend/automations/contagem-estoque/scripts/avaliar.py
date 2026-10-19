#!/usr/bin/env python3
"""
Avalia o detector contra a base de fotos reais com contagem conhecida (tests/fotos_reais/).

Para cada foto do contagens.csv, compara a quantidade detectada com a esperada e mostra a
taxa de acerto e o erro médio. Use antes de mudar qualquer parâmetro do detector: uma
mudança que acerta a foto nova mas erra outras aparece aqui.

    python scripts/avaliar.py                       # base padrão, parâmetros do .env
    MARKER_HUE_MIN=30 python scripts/avaliar.py     # testa um parâmetro sem editar nada
    python scripts/avaliar.py --pasta /outra/base   # outra pasta com o mesmo contagens.csv
"""
import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import DetectorSettings  # noqa: E402
from app.detector import analyze, load_image  # noqa: E402

BASE_PADRAO = Path(__file__).resolve().parent.parent / "tests" / "fotos_reais"


def ler_base(pasta: Path) -> list[tuple[Path, int]]:
    with (pasta / "contagens.csv").open(encoding="utf-8") as f:
        return [(pasta / linha["arquivo"], int(linha["quantidade"])) for linha in csv.DictReader(f, delimiter=";")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pasta", type=Path, default=BASE_PADRAO)
    args = parser.parse_args()

    settings = DetectorSettings()
    base = ler_base(args.pasta)
    acertos = 0
    erro_abs = 0
    print(f"{'foto':32s} {'esperado':>8s} {'contado':>8s} {'erro':>5s}  alertas")
    for foto, esperado in base:
        analise = analyze(load_image(foto), settings)
        contado = len(analise.detections)
        erro = contado - esperado
        acertos += erro == 0
        erro_abs += abs(erro)
        marca = "" if erro == 0 else "  <<<"
        print(f"{foto.name:32s} {esperado:8d} {contado:8d} {erro:+5d}  {'; '.join(analise.alertas) or '-'}{marca}")
    total = len(base)
    print(f"\nAcertos: {acertos}/{total} ({100 * acertos / total:.0f}%)  |  erro médio: {erro_abs / total:.2f} pacote(s) por foto")
    return 0 if acertos == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
