"""
Gravação de arquivos de estado JSON em `DATA_DIR` (status de rotinas, NSU da SEFAZ, caches).

Grava num arquivo temporário na mesma pasta e troca pelo definitivo (`os.replace`). Além de
nunca deixar um JSON pela metade, isso resolve o caso visto em produção em 2026-09-25: os
arquivos existentes passaram a pertencer ao root do container (`-rw-r--r-- root`) enquanto a
pasta seguia gravável (`drwxr-xrwx`); `open(path, "w")` dava Permission denied para o
`appuser` e as rotinas diárias rodavam sem conseguir registrar nada. Trocar o arquivo exige
só permissão de escrita na pasta.

Arquivos de estado comuns ficam 0644 (FILE_MODE), como o `open()` gravava antes. Segredos
(cache OAuth, tokens) usam `mode=SECRET_FILE_MODE` (0600): o `scripts/backup/backup.sh` lê os
caches entrando no userns do Docker rootless (`nsenter -U`, commit abc660a), onde o dono do
arquivo é o próprio usuário, então 0600 não quebra o backup.

Falhas de gravação ficam registradas em memória por arquivo (`erros_gravacao`) para os
endpoints de status exporem — antes eram só um warning no log e passavam dias despercebidas.
"""
import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("automacao_nfe.json_store")

_erros: Dict[str, str] = {}
_erros_lock = threading.Lock()


FILE_MODE = 0o644
SECRET_FILE_MODE = 0o600


def write_json_atomic(path: Path, data: Any, indent: Optional[int] = 2, mode: int = FILE_MODE) -> None:
    """Grava `data` em `path` de forma atômica (permissão `mode`). Levanta a exceção original em caso de falha."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=indent, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def save_json_state(path: Path, data: Any, contexto: str, indent: Optional[int] = 2) -> bool:
    """
    Grava um arquivo de estado de rotina. Não levanta: registra o erro (log ERROR + memória)
    e devolve False, para a rotina seguir e o status mostrar o problema.
    """
    path = Path(path)
    try:
        write_json_atomic(path, data, indent=indent)
    except Exception as e:
        msg = f"{path.name}: {e}"
        logger.error(f"[{contexto}] Falha ao gravar {msg}")
        with _erros_lock:
            _erros[str(path)] = msg
        return False
    with _erros_lock:
        _erros.pop(str(path), None)
    return True


def erro_gravacao(*paths: Path) -> Optional[str]:
    """Última falha ainda não resolvida ao gravar algum dos arquivos dados (None se nenhuma)."""
    with _erros_lock:
        msgs = [_erros[str(Path(p))] for p in paths if str(Path(p)) in _erros]
    return "; ".join(msgs) if msgs else None


def limpar_erros_gravacao() -> None:
    with _erros_lock:
        _erros.clear()
