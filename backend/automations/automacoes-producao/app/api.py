"""
Servidor de impressão da Produção: roda no PC do encarregado, que tem a impressora de etiquetas
na USB. O botão do sistema de OP (no tablet, mesma rede local) manda um JSON com os dados da
etiqueta; aqui o comando (EPL ou ZPL, ver LINGUAGEM) é montado e vai direto para a impressora. Não consulta Tiny nem o servidor.
"""
import logging
import secrets
import uuid
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.etiqueta_comum import MAX_COPIAS
from app.etiquetas_epl import CODIFICACAO_EPL, gerar_epl
from app.etiquetas_zpl import avisos_etiqueta, gerar_zpl
from app.impressora import ImpressoraIndisponivel, encontrar_impressora, imprimir
from app.limite import limitar_copias, limitar_requisicoes

logger = logging.getLogger("producao.api")


def conferir_chave(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
) -> None:
    """Exposto na internet (Cloudflare): sem chave configurada, recusa tudo em vez de ficar aberto."""
    if not settings.CHAVE_API:
        raise HTTPException(status_code=503, detail="Servidor sem CHAVE_API configurada no .env.")
    recebida = x_api_key
    if not recebida and authorization and authorization.lower().startswith("bearer "):
        recebida = authorization[7:].strip()
    if not recebida or not secrets.compare_digest(recebida.encode(), settings.CHAVE_API.encode()):
        raise HTTPException(status_code=401, detail="Chave inválida ou ausente (header X-Api-Key).")


app = FastAPI(
    title="Norvia Produção — Impressão de Etiquetas",
    version="2.1.0",
    description="Recebe os dados da etiqueta por JSON e imprime na impressora USB deste PC.",
    dependencies=[Depends(conferir_chave)],
    docs_url="/docs" if settings.DOCS else None,
    redoc_url=None,
    openapi_url="/openapi.json" if settings.DOCS else None,
)

# O sistema de OP roda no navegador do tablet, em outra origem: precisa de CORS. E o Chrome pede
# licença (Private Network Access) para uma página de fora chamar um IP da rede local.
# Origens em CORS_ORIGINS (.env); vazio = "*", aceitável porque toda rota exige a CHAVE_API e
# nada usa cookie (sem allow_credentials).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origens_cors(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Api-Key", "Authorization"],
    allow_private_network=True,
)


class Etiqueta(BaseModel):
    sku: str = Field(..., min_length=1, max_length=60)
    descricao: str = Field(..., min_length=1, max_length=300)
    gtin: Optional[str] = Field(None, max_length=14)
    localizacao: Optional[str] = Field(None, max_length=120)
    op: Optional[str] = Field(None, max_length=60)
    copias: int = Field(..., ge=1, le=MAX_COPIAS)


def _erro(status: int, mensagem: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"sucesso": False, "erro": mensagem})


@app.exception_handler(HTTPException)
async def _http_erro(_: Request, exc: HTTPException) -> JSONResponse:
    resposta = _erro(exc.status_code, str(exc.detail))
    for nome, valor in (exc.headers or {}).items():
        resposta.headers[nome] = valor
    return resposta


@app.exception_handler(RequestValidationError)
async def _validacao_erro(_: Request, exc: RequestValidationError) -> JSONResponse:
    campos = "; ".join(
        f"{'.'.join(str(p) for p in e['loc'] if p != 'body') or 'corpo'}: {e['msg'].removeprefix('Value error, ')}" for e in exc.errors()
    )
    return _erro(422, f"JSON inválido — {campos}")


def _comando(etiqueta: Etiqueta) -> Tuple[str, str]:
    """Comando da etiqueta na LINGUAGEM configurada e a codificação dos bytes para a impressora."""
    comum = dict(
        copias=etiqueta.copias,
        dpi=settings.DPI,
        largura_mm=settings.LARGURA_MM,
        altura_mm=settings.ALTURA_MM,
        remover_acentos=settings.REMOVER_ACENTOS,
    )
    if settings.LINGUAGEM == "zpl":
        return gerar_zpl(etiqueta.model_dump(), **comum), "utf-8"
    return (
        gerar_epl(etiqueta.model_dump(), densidade=settings.DENSIDADE, gap_dots=settings.GAP_DOTS, **comum),
        CODIFICACAO_EPL,
    )


@app.get("/status")
def status() -> Dict[str, Any]:
    """Para conferir do tablet se o PC está no ar e achou a impressora."""
    nome = "simulação" if settings.SIMULACAO else encontrar_impressora()
    return {"status": "ok", "impressora": nome, "impressoraEncontrada": bool(nome), "linguagem": settings.LINGUAGEM}


@app.post("/etiquetas/imprimir", dependencies=[Depends(limitar_requisicoes)])
def rota_imprimir(etiqueta: Etiqueta, request: Request) -> Dict[str, Any]:
    limitar_copias(request, etiqueta.copias)
    comando, codificacao = _comando(etiqueta)
    try:
        nome = imprimir(comando, codificacao=codificacao)
    except ImpressoraIndisponivel as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        # Detalhe (caminho, erro do spooler) só no log do PC; a resposta leva o id para achar a linha.
        erro_id = uuid.uuid4().hex[:8]
        logger.exception(f"Falha ao imprimir [{erro_id}]: {e}")
        raise HTTPException(status_code=500, detail=f"Falha ao enviar para a impressora (id {erro_id}; detalhe na janela do servidor).")

    agora = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    logger.info(f"[{agora}] OP {etiqueta.op or '-'} | SKU {etiqueta.sku} | {etiqueta.copias} etiqueta(s) → {nome}")
    return {
        "sucesso": True,
        "impressora": nome,
        "sku": etiqueta.sku,
        "copias": etiqueta.copias,
        "op": etiqueta.op,
        "avisos": avisos_etiqueta(etiqueta.model_dump()),
    }


@app.post("/etiquetas/comandos", response_class=PlainTextResponse, dependencies=[Depends(limitar_requisicoes)])
@app.post("/etiquetas/zpl", response_class=PlainTextResponse, dependencies=[Depends(limitar_requisicoes)])
def rota_comandos(etiqueta: Etiqueta) -> PlainTextResponse:
    """
    Mesmo JSON do imprimir, mas só devolve o comando, sem imprimir, na LINGUAGEM configurada (EPL
    por padrão; ZPL com LINGUAGEM=zpl, para conferir em labelary.com). /etiquetas/zpl é o nome
    antigo, mantido por compatibilidade: também segue a LINGUAGEM.
    """
    comando, _ = _comando(etiqueta)
    return PlainTextResponse(comando, media_type="text/plain; charset=utf-8", headers={"X-Linguagem": settings.LINGUAGEM})
