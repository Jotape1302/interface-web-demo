"""
HEALTHCHECK do container (Dockerfile). O mesmo container roda em dois modos (app/main.py):

- API (`--serve`, `RUN_MODE=serve` ou `SERVE_API=1`): consulta GET /health na porta da API;
- daemon de varredura: não há porta para consultar, então basta o processo estar de pé.

Lê a linha de comando do PID 1 para saber o modo e a porta (`--port`), sem depender do compose.
Sai com 0 (saudável) ou 1 (doente), como o Docker espera.
"""
import os
import sys
import urllib.request
from pathlib import Path
from typing import List


def _cmdline_pid1() -> List[str]:
    try:
        return Path("/proc/1/cmdline").read_bytes().decode(errors="replace").split("\0")
    except OSError:
        return []


def _modo_api(args: List[str]) -> bool:
    return (
        "--serve" in args
        or os.environ.get("RUN_MODE") == "serve"
        or os.environ.get("SERVE_API", "").lower() in ("1", "true", "yes")
    )


def _porta(args: List[str]) -> int:
    for i, arg in enumerate(args):
        if arg == "--port" and i + 1 < len(args):
            return int(args[i + 1])
        if arg.startswith("--port="):
            return int(arg.split("=", 1)[1])
    return 8000


def main() -> int:
    args = _cmdline_pid1()
    if not _modo_api(args):
        return 0
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{_porta(args)}/health", timeout=4) as res:
            return 0 if res.status == 200 else 1
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
