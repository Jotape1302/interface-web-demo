"""
Dashboard Financeiro: status, sincronização sob demanda e leitura do cache consolidado.

Separado de app/api.py (que monta o FastAPI, as rotinas de fundo e inclui os routers).
"""
import logging
import math
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.financial_dashboard import (
    get_dashboard_response,
    get_sync_status,
    is_sync_running,
    sync_cooldown_remaining_seconds,
    sync_financial_dashboard,
)


logger = logging.getLogger("automacao_nfe.api")

router = APIRouter()


class FinancialDashboardCompanyStatus(BaseModel):
    account_id: str
    cnpj: str
    ok: bool
    erro: Optional[str] = None
    caixa_lancamentos: int = 0
    contas_pagar_abertas: int = 0
    contas_receber_abertas: int = 0


class FinancialDashboardStatusResponse(BaseModel):
    last_sync_started_at: Optional[str] = None
    last_sync_finished_at: Optional[str] = None
    next_sync_at: str
    companies: List[FinancialDashboardCompanyStatus]
    is_running: bool = False
    cooldown_seconds_remaining: int = 0


@router.get("/api/v1/financial-dashboard/status", response_model=FinancialDashboardStatusResponse)
def get_financial_dashboard_status() -> FinancialDashboardStatusResponse:
    """Status da sincronização do Dashboard Financeiro: última execução, empresas e próximo horário agendado."""
    settings.ensure_directories()
    return FinancialDashboardStatusResponse(**get_sync_status())


@router.post("/api/v1/financial-dashboard/sync", response_model=FinancialDashboardStatusResponse)
def trigger_financial_dashboard_sync(background_tasks: BackgroundTasks, force: bool = False) -> FinancialDashboardStatusResponse:
    """
    Dispara a sincronização do Dashboard Financeiro em background (evita timeout HTTP,
    já que iterar todas as categorias x 4 empresas pode levar alguns minutos) e retorna
    imediatamente o status atual.
    """
    if is_sync_running():
        return FinancialDashboardStatusResponse(**get_sync_status())

    remaining = sync_cooldown_remaining_seconds()
    if remaining > 0 and not force:
        mins = max(1, math.ceil(remaining / 60))
        raise HTTPException(
            status_code=429,
            detail=f"Sincronização em cooldown para não sobrecarregar a API do Tiny ERP. Tente novamente em {mins} min.",
        )

    background_tasks.add_task(sync_financial_dashboard)
    return FinancialDashboardStatusResponse(**get_sync_status())


@router.get("/api/v1/financial-dashboard")
def get_financial_dashboard(
    date_from: str,
    date_to: str,
    company: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Retorna os KPIs do Dashboard Financeiro calculados a partir do último cache
    sincronizado (nenhuma chamada ao Tiny ERP acontece nesta requisição). `date_from`/
    `date_to` (YYYY-MM-DD) vêm do filtro de calendário padrão da interface — o período
    de comparação anterior é calculado com a mesma duração, terminando no dia anterior.
    """
    try:
        date.fromisoformat(date_from)
        date.fromisoformat(date_to)
    except ValueError:
        raise HTTPException(status_code=422, detail="date_from/date_to devem estar no formato YYYY-MM-DD.")
    response = get_dashboard_response(date_from=date_from, date_to=date_to, company=company)
    if response is None:
        raise HTTPException(
            status_code=404,
            detail="Dashboard Financeiro ainda não foi sincronizado. Use 'Sincronizar agora' ou aguarde a rotina diária.",
        )
    return response
