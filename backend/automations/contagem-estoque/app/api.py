"""
API interna da contagem de estoque (porta API_PORT, só na rede do docker): o gateway chama ao
conferir uma contagem no painel. Toda rota, menos /health, exige `X-Internal-Key` (contrato C1).
"""
import logging
import os
import re
import secrets
from datetime import datetime
from typing import Any, Dict, Optional
from urllib.parse import unquote

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.config import TinySettings
from app.tiny_estoque import CONTA_TINY, ClienteTinyEstoque, EstoqueTinyErro, TinyAPIError, ajustar_contagem, consultar_produto, token_tiny_do_banco

logger = logging.getLogger("contagem_estoque.api")

ROTAS_PUBLICAS = frozenset({"/health", "/api/v1/health"})
_USUARIO_MAX = 120

cfg = TinySettings()
_cliente: Optional[ClienteTinyEstoque] = None


def cliente() -> ClienteTinyEstoque:
    global _cliente
    if _cliente is None:
        _cliente = ClienteTinyEstoque(token_tiny_do_banco(cfg), cfg)
    return _cliente


def _chave_configurada() -> str:
    valor = os.getenv("AUTOMATIONS_INTERNAL_KEY")
    if valor is None and cfg.AUTOMATIONS_INTERNAL_KEY is not None:
        valor = cfg.AUTOMATIONS_INTERNAL_KEY.get_secret_value()
    return (valor or "").strip()


def _auth_desligada() -> bool:
    valor = os.getenv("INTERNAL_AUTH_DISABLED")
    if valor is None:
        return cfg.INTERNAL_AUTH_DISABLED
    return valor.strip().lower() in ("1", "true", "yes", "sim")


async def exigir_chave_interna(request: Request) -> None:
    if request.url.path in ROTAS_PUBLICAS or _auth_desligada():
        return
    esperada = _chave_configurada()
    if not esperada:
        raise HTTPException(status_code=503, detail="Chave interna não configurada (AUTOMATIONS_INTERNAL_KEY).")
    recebida = request.headers.get("X-Internal-Key") or ""
    if not recebida or not secrets.compare_digest(recebida.encode("utf-8"), esperada.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Chave interna ausente ou inválida.")


def _usuario(request: Request) -> str:
    bruto = (request.headers.get("X-Usuario") or "").strip()
    try:
        bruto = unquote(bruto)
    except Exception:
        pass
    return "".join(c for c in bruto if c.isprintable()).strip()[:_USUARIO_MAX]


app = FastAPI(title="Contagem de estoque", dependencies=[Depends(exigir_chave_interna)])


class AjusteRequest(BaseModel):
    registro_id: str = Field(pattern=r"^[a-f0-9]{12}$")
    sku: str = Field(min_length=1, max_length=60)
    # Unidades contadas: fardos × unidades por fardo + unidades soltas (calculado no painel).
    quantidade: int = Field(ge=0, le=10_000_000)
    # Número e data da contagem como no painel: vão no início da observação do Tiny.
    numero: int = Field(ge=1, le=999_999)
    criado_em: str = Field(min_length=10, max_length=40)

    @field_validator("criado_em")
    @classmethod
    def _data_iso(cls, valor: str) -> str:
        try:
            datetime.fromisoformat(valor)
        except ValueError as e:
            raise ValueError("criado_em deve ser data ISO 8601") from e
        return valor


@app.get("/health")
@app.get("/api/v1/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "tiny_conta": CONTA_TINY, "banco_configurado": cfg.banco_configurado()}


def _sku_valido(bruto: str) -> str:
    sku = (bruto or "").strip().upper()
    if not sku or len(sku) > 60 or not re.fullmatch(r"[A-Z0-9][A-Z0-9 ._/-]*", sku):
        raise HTTPException(status_code=400, detail="SKU inválido.")
    return sku


@app.get("/api/v1/estoque/consultar")
def consultar(sku: str) -> Dict[str, Any]:
    """Nome do produto e saldo atual no Tiny (só leitura), para a conferência no painel."""
    sku = _sku_valido(sku)
    try:
        return consultar_produto(cliente(), sku)
    except EstoqueTinyErro as e:
        raise HTTPException(status_code=409, detail=str(e))
    except TinyAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception("[API] falha ao consultar %s no Tiny", sku)
        raise HTTPException(status_code=502, detail=f"Falha ao falar com o Tiny: {type(e).__name__}.")


@app.post("/api/v1/estoque/ajustar")
def ajustar(payload: AjusteRequest, request: Request) -> Dict[str, Any]:
    sku = _sku_valido(payload.sku)
    try:
        return ajustar_contagem(
            cliente(), sku, payload.quantidade, payload.registro_id, payload.numero, payload.criado_em, _usuario(request)
        )
    except EstoqueTinyErro as e:
        raise HTTPException(status_code=409, detail=str(e))
    except TinyAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # banco de tokens fora, rede...
        logger.exception("[API] falha ao ajustar o estoque de %s (registro %s)", sku, payload.registro_id)
        raise HTTPException(status_code=502, detail=f"Falha ao falar com o Tiny: {type(e).__name__}.")
