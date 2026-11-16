"""
Boletos do DDA (Polp) → contas a pagar do Tiny → pagamento agendado no Inter → baixa.
Regras em app/dda_pagamentos.py. Separado de app/api.py (que monta o FastAPI e as rotinas de fundo).
"""
import logging
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.dda_pagamentos import resumo_avisos, rotina
from app.internal_auth import usuario_da_requisicao
from app.routers.jobs import _Progresso, _consultar_job, _iniciar_job

logger = logging.getLogger("automacao_nfe.api")

router = APIRouter()


class VincularRequest(BaseModel):
    conta_id: int = Field(gt=0)


class CriarContaRequest(BaseModel):
    categoria_id: int = Field(gt=0)
    historico: str = Field(default="", max_length=500)


class ValidarRequest(BaseModel):
    ids: List[str] = Field(min_length=1, max_length=300)


class CriarContaItem(BaseModel):
    boleto_id: str = Field(min_length=1, max_length=64)
    categoria_id: int = Field(gt=0)
    historico: str = Field(default="", max_length=500)


class CriarContasRequest(BaseModel):
    itens: List[CriarContaItem] = Field(min_length=1, max_length=200)


class MotivoRequest(BaseModel):
    motivo: str = Field(default="", max_length=300)


def _boleto_ou_404(boleto_id: str) -> None:
    if boleto_id not in rotina.estado.ler()["boletos"]:
        raise HTTPException(status_code=404, detail="Boleto não encontrado.")


def _acao(funcao, *args: Any) -> Dict[str, Any]:
    try:
        return {"boleto": funcao(*args)}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/api/v1/dda/status")
def dda_status() -> Dict[str, Any]:
    return rotina.status()


@router.get("/api/v1/dda/boletos")
def dda_boletos() -> Dict[str, Any]:
    return {"itens": rotina.boletos()}


@router.get("/api/v1/dda/categorias")
def dda_categorias(empresa: str) -> Dict[str, Any]:
    try:
        return {"itens": rotina.categorias(empresa)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/api/v1/dda/execucoes")
def dda_execucoes() -> Dict[str, Any]:
    return {"itens": list(reversed(rotina.estado.ler()["execucoes"]))[:30]}


@router.get("/api/v1/dda/avisos")
def dda_avisos(depois_de: int = 0) -> Dict[str, Any]:
    """Avisos novos para o gateway notificar (agendado, recusado, erro da rotina)."""
    itens, ultimo = resumo_avisos(depois_de)
    return {"itens": itens, "ultimo_id": ultimo}


@router.post("/api/v1/dda/jobs/executar")
def dda_executar(request: Request) -> Dict[str, Any]:
    if rotina.status()["em_execucao"]:
        raise HTTPException(status_code=409, detail="Já existe uma rodada do DDA em andamento.")
    usuario = usuario_da_requisicao(request)

    def executar(progresso: _Progresso) -> Any:
        progresso("Buscando boletos na Polp, casando com o Tiny e acompanhando o Inter", 0, 1)
        return rotina.executar("manual", usuario)

    return _iniciar_job("dda_executar", executar)


@router.post("/api/v1/dda/boletos/validar")
def dda_validar(corpo: ValidarRequest, request: Request) -> Dict[str, Any]:
    return rotina.validar(corpo.ids, usuario_da_requisicao(request))


@router.post("/api/v1/dda/jobs/criar-contas")
def dda_criar_contas(corpo: CriarContasRequest, request: Request) -> Dict[str, Any]:
    """Criação em lote (uma chamada ao Tiny por boleto, com throttle): tarefa em segundo plano."""
    usuario = usuario_da_requisicao(request)
    itens = [i.model_dump() for i in corpo.itens]
    return _iniciar_job("dda_criar_contas", lambda progresso: rotina.criar_contas_lote(itens, usuario, progresso))


@router.get("/api/v1/dda/jobs/{job_id}")
def dda_job(job_id: str) -> Dict[str, Any]:
    return _consultar_job(job_id, dominio="dda")


@router.post("/api/v1/dda/boletos/{boleto_id}/vincular")
def dda_vincular(boleto_id: str, corpo: VincularRequest, request: Request) -> Dict[str, Any]:
    _boleto_ou_404(boleto_id)
    return _acao(rotina.vincular_conta, boleto_id, corpo.conta_id, usuario_da_requisicao(request))


@router.post("/api/v1/dda/boletos/{boleto_id}/criar-conta")
def dda_criar_conta(boleto_id: str, corpo: CriarContaRequest, request: Request) -> Dict[str, Any]:
    _boleto_ou_404(boleto_id)
    return _acao(rotina.criar_conta, boleto_id, corpo.categoria_id, corpo.historico, usuario_da_requisicao(request))


@router.post("/api/v1/dda/boletos/{boleto_id}/descartar")
def dda_descartar(boleto_id: str, corpo: MotivoRequest, request: Request) -> Dict[str, Any]:
    _boleto_ou_404(boleto_id)
    return _acao(rotina.descartar, boleto_id, corpo.motivo, usuario_da_requisicao(request))


@router.post("/api/v1/dda/boletos/{boleto_id}/reabrir")
def dda_reabrir(boleto_id: str, request: Request) -> Dict[str, Any]:
    _boleto_ou_404(boleto_id)
    return _acao(rotina.reabrir, boleto_id, usuario_da_requisicao(request))


# --- Classificador Qwen dos boletos (PC do TI) --------------------------------------------
# Como /api/v1/danfe/qwen/*: só o coletor da VPS chama (pelo gateway, com a X-Internal-Key),
# levando os boletos pelo túnel até o agentes-qwen e trazendo as sugestões de volta.


class QwenBoletoSugestao(BaseModel):
    boleto_id: str = Field(min_length=1, max_length=64)
    versao: str = Field(min_length=1, max_length=200)
    modelo: str = Field(min_length=1, max_length=100)
    categoria_id: str = Field(min_length=1, max_length=30)
    confianca: Literal["alta", "media", "baixa"]
    motivo: str = Field(default="", max_length=2000)


@router.get("/api/v1/dda/qwen/pendentes")
def dda_qwen_pendentes(limit: int = Query(10, ge=1, le=100)) -> Dict[str, Any]:
    """Boletos sem conta ainda sem classificação, com o histórico do fornecedor e o catálogo de
    cada empresa (o PC monta o JSON Schema com ele: o Qwen nunca devolve um ID que a conta não tem)."""
    return rotina.qwen_pendentes(limit)


@router.post("/api/v1/dda/qwen/sugestoes")
def dda_qwen_sugestoes(corpo: QwenBoletoSugestao) -> Dict[str, Any]:
    """404: o boleto saiu de 'sem conta'; 409: mudou de valor/vencimento/fornecedor depois de ir ao
    Qwen; 422: categoria fora do catálogo da empresa. Nos três o coletor descarta a sugestão."""
    try:
        r = rotina.gravar_qwen(corpo.boleto_id, corpo.versao, corpo.modelo, corpo.categoria_id, corpo.confianca, corpo.motivo)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    if r == "nao_pendente":
        raise HTTPException(status_code=404, detail=f"Boleto {corpo.boleto_id} não está mais sem conta.")
    if r == "desatualizada":
        raise HTTPException(status_code=409, detail="O boleto mudou depois da classificação; sugestão descartada.")
    if r == "fora_do_catalogo":
        raise HTTPException(status_code=422, detail=f"Categoria {corpo.categoria_id} fora do catálogo da empresa.")
    logger.info(f"[QWEN] Sugestão de {corpo.modelo} gravada no boleto DDA {corpo.boleto_id}")
    return {"boleto_id": corpo.boleto_id, "status": "gravado"}


@router.get("/api/v1/dda/qwen/confirmadas-recentes")
def dda_qwen_confirmadas(cursor: Optional[str] = None, limit: int = Query(200, ge=1, le=1000)) -> Dict[str, Any]:
    """Histórico de categoria (saídas do Tiny e escolhas do painel) depois de `cursor` (o seq do
    último registro recebido). Sem cursor, começa do início. `fim=false`: há mais páginas."""
    try:
        depois_de = int(cursor) if cursor else 0
    except ValueError:
        raise HTTPException(status_code=422, detail="Cursor inválido: use o `cursor` devolvido pela chamada anterior.")
    registros, ultimo, fim = rotina.historico.confirmadas(depois_de, limit)
    return {"confirmadas": registros, "cursor": str(ultimo), "fim": fim}
