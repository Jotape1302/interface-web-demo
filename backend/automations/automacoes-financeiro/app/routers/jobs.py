"""
Fila em memória das tarefas longas (prévia/baixa da conciliação Inter e baixa da conciliação ML).

Separado de app/api.py (que monta o FastAPI, as rotinas de fundo e inclui os routers).
"""
import logging
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Callable, Dict

from fastapi import HTTPException

from app import execucoes


logger = logging.getLogger("automacao_nfe.api")


# =============================================================================
# Tarefas em segundo plano da conciliação
# =============================================================================
# A prévia (extrato Inter + 3 listagens paginadas do Tiny por filial, com throttle de 2s
# por página) e a baixa (uma chamada ao Tiny por conta) passam de 1 minuto — mais que o
# timeout do NGINX. A tela inicia uma tarefa e consulta o andamento até terminar.
# Guardadas em memória: a API roda num único processo uvicorn (app/main.py).

_Progresso = Callable[[str, int, int], None]

_RECONCILIACAO_JOB_TTL_SECONDS = 3600
_reconciliacao_jobs: Dict[str, Dict[str, Any]] = {}
_reconciliacao_jobs_lock = threading.Lock()


def _limpar_jobs_antigos() -> None:
    limite = time.time() - _RECONCILIACAO_JOB_TTL_SECONDS
    with _reconciliacao_jobs_lock:
        for job_id in [j for j, job in _reconciliacao_jobs.items() if job["_criado_ts"] < limite and job["status"] != "executando"]:
            del _reconciliacao_jobs[job_id]


def _job_publico(job: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def _iniciar_job(tipo: str, executar: Callable[[_Progresso], Any], sincrono: bool = False) -> Dict[str, Any]:
    """`sincrono=True` roda na própria requisição (ex.: prévia toda em cache, milissegundos):
    a tela recebe o job já concluído e não espera o ciclo de consulta de andamento."""
    _limpar_jobs_antigos()
    job_id = str(uuid.uuid4())
    job: Dict[str, Any] = {
        "job_id": job_id,
        "tipo": tipo,
        "status": "executando",
        "etapa": "Iniciando",
        "atual": 0,
        "total": 0,
        "iniciado_em": datetime.now().isoformat(),
        "concluido_em": None,
        "resultado": None,
        "erro": None,
        "_criado_ts": time.time(),
    }
    with _reconciliacao_jobs_lock:
        _reconciliacao_jobs[job_id] = job

    def progresso(etapa: str, atual: int, total: int) -> None:
        with _reconciliacao_jobs_lock:
            job.update(etapa=etapa, atual=atual, total=total)

    def rodar() -> None:
        with execucoes.execucao(f"tarefa {tipo}"):
            try:
                resultado = executar(progresso)
                with _reconciliacao_jobs_lock:
                    job.update(status="concluido", resultado=resultado, concluido_em=datetime.now().isoformat())
            except HTTPException as e:
                with _reconciliacao_jobs_lock:
                    job.update(status="erro", erro=str(e.detail), concluido_em=datetime.now().isoformat())
            except Exception as e:
                logger.error(f"[RECONCILIACAO_JOB] Tarefa {tipo} {job_id} falhou: {e}", exc_info=True)
                with _reconciliacao_jobs_lock:
                    job.update(status="erro", erro=str(e), concluido_em=datetime.now().isoformat())

    if sincrono:
        rodar()
    else:
        threading.Thread(target=rodar, name=f"reconciliacao-{tipo}-{job_id[:8]}", daemon=True).start()
    with _reconciliacao_jobs_lock:
        return _job_publico(job)


def _dominio_job(tipo: str) -> str:
    return "ml" if tipo.startswith("ml_") else "dda" if tipo.startswith("dda_") else "inter"


def _consultar_job(job_id: str, conciliacao_ml: bool = False, dominio: str = "") -> Dict[str, Any]:
    """Cada conciliação só enxerga as próprias tarefas (SEC-04): no gateway elas têm permissões
    diferentes (accounts_payable × ml_reconciliation), então a fila compartilhada não pode vazar
    o resultado de uma pela rota da outra. Domínios: inter (padrão), ml, dda."""
    esperado = dominio or ("ml" if conciliacao_ml else "inter")
    with _reconciliacao_jobs_lock:
        job = _reconciliacao_jobs.get(job_id)
        if not job or _dominio_job(str(job.get("tipo", ""))) != esperado:
            raise HTTPException(status_code=404, detail="Tarefa não encontrada (expirada ou a API foi reiniciada).")
        return _job_publico(job)
