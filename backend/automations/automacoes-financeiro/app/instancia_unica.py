"""
Garante um único processo da API por DATA_DIR.

Várias partes do estado só são seguras com um processo: a fila de tarefas da conciliação
(app/routers/jobs.py) e os caches ficam em memória, e os arquivos de estado em DATA_DIR
(NSU da SEFAZ, status das rotinas, registro de baixas) são protegidos por `threading.Lock`,
que não vale entre processos. Com `uvicorn --workers 2`, ou dois containers no mesmo volume,
as rotinas diárias rodariam em dobro e as gravações poderiam se sobrepor sem erro nenhum.

O lifespan da API pega um `flock` exclusivo em DATA_DIR/.api.lock; um segundo processo
falha na subida com a mensagem abaixo. O sistema operacional solta o lock quando o processo
morre (inclusive kill -9), então não sobra lock "preso" depois de um crash.
"""
import fcntl
import os
from pathlib import Path
from typing import IO, Optional

NOME_ARQUIVO = ".api.lock"

_arquivo: Optional[IO[str]] = None


class OutraInstanciaAtiva(RuntimeError):
    pass


def adquirir(data_dir: Path) -> None:
    """Pega o lock exclusivo; levanta OutraInstanciaAtiva se outro processo já o tem."""
    global _arquivo
    if _arquivo is not None:
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    arquivo = open(data_dir / NOME_ARQUIVO, "a+", encoding="utf-8")
    try:
        fcntl.flock(arquivo.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        arquivo.seek(0)
        dono = arquivo.read().strip() or "desconhecido"
        arquivo.close()
        raise OutraInstanciaAtiva(
            f"Outra instância da API já usa {data_dir} (PID {dono}). Rode um único processo "
            "(sem --workers > 1 e sem dois containers no mesmo volume de dados)."
        ) from None
    arquivo.seek(0)
    arquivo.truncate()
    arquivo.write(str(os.getpid()))
    arquivo.flush()
    _arquivo = arquivo


def liberar() -> None:
    global _arquivo
    if _arquivo is None:
        return
    try:
        fcntl.flock(_arquivo.fileno(), fcntl.LOCK_UN)
    finally:
        _arquivo.close()
        _arquivo = None
