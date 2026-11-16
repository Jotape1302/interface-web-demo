"""
Saúde do motor: /health público (status mínimo) e detalhes de Tiny e Inter.

Separado de app/api.py (que monta o FastAPI, as rotinas de fundo e inclui os routers).
"""
import logging
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.fuso import agora_sp
from app.internal_auth import chave_valida
from app.config import settings
from app.token_repository import TokenRepository


logger = logging.getLogger("automacao_nfe.api")

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    # Detalhes só para quem traz a chave interna (o gateway); sem ela, só status e horário.
    version: Optional[str] = None
    nfe_provider: Optional[str] = None
    ocr_enabled: Optional[bool] = None
    tiny_configured: Optional[bool] = None


class ServiceHealthDetail(BaseModel):
    service: str
    status: str
    connected: bool
    message: str
    timestamp: str


def _check_tiny_configured() -> bool:
    token_repo = TokenRepository(settings)
    return bool(
        settings.TINY_CLIENT_ID
        or settings.TINY_API_TOKEN
        or settings.TINY_TOKEN_CACHE_FILE.exists()
        or token_repo.is_configured()
    )


@router.get("/health", response_model=HealthResponse, response_model_exclude_none=True)
@router.get("/api/v1/health", response_model=HealthResponse, response_model_exclude_none=True)
def health_check(request: Request) -> HealthResponse:
    """Status do motor. Público com status mínimo; com a chave interna, inclui os provedores."""
    if not chave_valida(request):
        return HealthResponse(status="ok", timestamp=agora_sp().isoformat())
    settings.ensure_directories()
    tiny_configured = _check_tiny_configured()
    return HealthResponse(
        status="ok",
        version="1.0.0",
        nfe_provider=settings.NFE_PROVIDER,
        ocr_enabled=settings.OCR_ENABLED,
        tiny_configured=tiny_configured,
        timestamp=agora_sp().isoformat()
    )


@router.get("/health/tiny", response_model=ServiceHealthDetail)
@router.get("/api/v1/health/tiny", response_model=ServiceHealthDetail)
def health_tiny() -> ServiceHealthDetail:
    """Retorna o status de saúde e configuração da integração Tiny ERP."""
    settings.ensure_directories()
    tiny_configured = _check_tiny_configured()
    return ServiceHealthDetail(
        service="tiny",
        status="ok" if tiny_configured else "warning",
        connected=tiny_configured,
        message="API v3 e integração fiscal operacional." if tiny_configured else "Credenciais Tiny ERP não configuradas.",
        timestamp=agora_sp().isoformat()
    )


@router.get("/health/inter", response_model=ServiceHealthDetail)
@router.get("/api/v1/health/inter", response_model=ServiceHealthDetail)
def health_inter() -> ServiceHealthDetail:
    """Retorna o status operacional do módulo Banco Inter / DDA."""
    return ServiceHealthDetail(
        service="inter",
        status="ok",
        connected=True,
        message="Módulo DDA e conciliação bancária operacional.",
        timestamp=agora_sp().isoformat()
    )
