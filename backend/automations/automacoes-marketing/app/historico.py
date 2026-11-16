"""
Histórico das operações da automação (aba "Histórico de execuções") e estado da rotina, em data/.

Fica no disco (volume do container) para sobreviver ao rebuild. Sem histórico, a lista vem vazia:
nada de execuções de exemplo em produção.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app import config

logger = logging.getLogger("marketing.historico")

MAX_EXECUCOES = 200
_LOCK = threading.Lock()


def _ler(caminho: Path, padrao: Any) -> Any:
    if not caminho.exists():
        return padrao
    try:
        return json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("Não foi possível ler %s: %s", caminho.name, exc)
        return padrao


def _gravar(caminho: Path, dados: Any) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    temporario = caminho.with_suffix(caminho.suffix + ".tmp")
    temporario.write_text(json.dumps(dados, indent=2, ensure_ascii=False), encoding="utf-8")
    temporario.replace(caminho)


def registrar_execucao(tipo: str, sucesso: bool, detalhes: Optional[dict] = None) -> dict:
    item = {
        "id": f"exec-{time.time_ns()}",
        "tipo": tipo,
        "sucesso": sucesso,
        "detalhes": detalhes or {},
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    with _LOCK:
        itens = _ler(config.CAMINHO_EXECUCOES_JSON, [])
        itens.insert(0, item)
        _gravar(config.CAMINHO_EXECUCOES_JSON, itens[:MAX_EXECUCOES])
    return item


def obter_ultimas_execucoes(limite: int = 50) -> List[dict]:
    with _LOCK:
        return list(_ler(config.CAMINHO_EXECUCOES_JSON, [])[:limite])


def ler_estado() -> Dict[str, Any]:
    with _LOCK:
        return dict(_ler(config.CAMINHO_ESTADO_JSON, {}))


def alterar_estado(**campos: Any) -> Dict[str, Any]:
    with _LOCK:
        estado = dict(_ler(config.CAMINHO_ESTADO_JSON, {}))
        estado.update(campos)
        _gravar(config.CAMINHO_ESTADO_JSON, estado)
        return estado


def ler_json(caminho: Path, padrao: Any) -> Any:
    with _LOCK:
        return _ler(caminho, padrao)


def gravar_json(caminho: Path, dados: Any) -> None:
    with _LOCK:
        _gravar(caminho, dados)
