"""
API da automação de e-mail marketing da Norvia (RD Station + kit Instagram), atrás do gateway.

Chave interna em todas as rotas menos /health (app/internal_auth.py). Quem aprova/gera vem do
X-Usuario que o gateway põe a partir da sessão, nunca do corpo da requisição.
"""
from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from app import execucoes, rotina
from app.ambientes.gerenciador import (
    aprovar_ambiente,
    inicializar_estoque_inicial,
    iniciar_geracao_ambientes,
    listar_ambientes,
    obter_caminho_imagem,
    recusar_ambiente,
)
from app.ambientes.provedores import RENDER_POR_LINHA
from app.config import PRODUTOS_NORVIA
from app.historico import alterar_estado, ler_estado, obter_ultimas_execucoes
from app.instagram.carrossel import gerar_zip_carrossel, obter_caminho_slide
from app.internal_auth import avisar_configuracao, exigir_chave_interna, usuario_da_requisicao

logger = logging.getLogger("marketing.api")


async def _agendador_sexta(parar: asyncio.Event) -> None:
    """Gera o lote na sexta à HORA_GERACAO_SEXTA, uma vez por sexta (estado.json guarda a última)."""
    while not parar.is_set():
        proxima = rotina.proxima_geracao_agendada()
        if proxima is None:
            return
        espera = (proxima - rotina.agora()).total_seconds()
        try:
            await asyncio.wait_for(parar.wait(), timeout=max(1.0, espera))
            return
        except asyncio.TimeoutError:
            pass
        dia = rotina.agora().date().isoformat()
        if ler_estado().get("ultima_geracao_agendada") == dia:
            continue
        alterar_estado(ultima_geracao_agendada=dia)
        if not rotina.iniciar_geracao("rotina de sexta"):
            logger.warning("[MARKETING] Geração agendada pulada: já havia uma em andamento.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    avisar_configuracao()
    inicializar_estoque_inicial()
    parar = asyncio.Event()
    tarefa = asyncio.create_task(_agendador_sexta(parar))
    proxima = rotina.proxima_geracao_agendada()
    logger.info(f"[MARKETING] Próxima geração automática: {proxima:%d/%m/%Y %H:%M}" if proxima
                else "[MARKETING] Geração automática de sexta desligada.")
    yield
    parar.set()
    tarefa.cancel()


# A dependência global (chave interna) não cobre /docs, /redoc e /openapi.json (SEC-05): desligados.
app = FastAPI(
    title="Automação de E-mail Marketing",
    lifespan=lifespan,
    dependencies=[Depends(exigir_chave_interna)],
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
execucoes.instalar(app)


class TrocarProdutoRequest(BaseModel):
    produto_slug: str


@app.get("/health")
@app.get("/api/v1/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "servico": "automacoes-marketing"}


@app.get("/api/v1/status")
def status_automacao() -> Dict[str, Any]:
    return rotina.obter_status_automacao()


@app.get("/api/v1/rascunhos")
def get_rascunhos() -> List[Dict[str, Any]]:
    return rotina.listar_rascunhos()


@app.get("/api/v1/produtos")
def get_produtos_editoriais() -> List[Dict[str, Any]]:
    """Linhas editoriais (produtos que podem ser destaque de uma edição)."""
    return [
        {
            "slug": slug,
            "nome": prod.get("nome", ""),
            "nome_curto": prod.get("nome_curto", prod.get("nome", "")),
            "referencia": prod.get("referencia", ""),
            "categoria_tag": prod.get("categoria_tag", ""),
            "categoria_oficial": prod.get("categoria_oficial", ""),
            "imagem_preview": prod.get("imagem_path") or "",
            "imagem_rd_station": prod.get("imagem_cdn_oficial") or "",
            "render_3d": RENDER_POR_LINHA.get(slug, ""),
            "url_produto": prod.get("cta_url") or "https://www.norvia.example/",
            "especificacoes_site": prod.get("especificacoes_site", ""),
            "descricao_curta": prod.get("descricao_curta") or prod.get("resumo_card") or "",
            "resumo_card": prod.get("resumo_card") or prod.get("descricao_curta") or "",
            "marca": "Norvia",
            "marca_propria": True,
        }
        for slug, prod in PRODUTOS_NORVIA.items()
    ]


@app.get("/api/v1/catalogo")
def get_catalogo(apenas_proprios: bool = Query(default=True)) -> Dict[str, Any]:
    prods = rotina.listar_catalogo_oficial(apenas_marca_propria=apenas_proprios)
    return {"total": len(prods), "filtro_apenas_marca_propria": apenas_proprios, "produtos": prods}


@app.get("/api/v1/execucoes")
def get_execucoes(limite: int = Query(default=50, ge=1, le=200)) -> List[Dict[str, Any]]:
    return obter_ultimas_execucoes(limite=limite)


@app.get("/api/v1/rascunhos/{rascunho_id}/carrossel/{slide_num}")
def get_slide_carrossel(rascunho_id: str, slide_num: int):
    """Entrega a imagem JPEG 1080x1350 do slide n do carrossel."""
    if not re.match(r"^[A-Za-z0-9-]{1,64}$", rascunho_id):
        raise HTTPException(status_code=400, detail="ID de rascunho inválido.")
    caminho = obter_caminho_slide(rascunho_id, slide_num)
    if not caminho or not caminho.exists():
        raise HTTPException(status_code=404, detail="Slide do carrossel não encontrado.")
    return FileResponse(caminho, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/v1/rascunhos/{rascunho_id}/carrossel.zip")
def get_zip_carrossel(rascunho_id: str):
    """Entrega o arquivo ZIP com todos os slides e legenda.txt do carrossel."""
    if not re.match(r"^[A-Za-z0-9-]{1,64}$", rascunho_id):
        raise HTTPException(status_code=400, detail="ID de rascunho inválido.")
    rascunhos = rotina.listar_rascunhos()
    encontrado = next((r for r in rascunhos if r.get("id") == rascunho_id), None)
    legenda = (encontrado.get("copy") or {}).get("legenda_instagram", "") if encontrado else ""
    zip_bytes = gerar_zip_carrossel(rascunho_id, legenda=legenda)
    if not zip_bytes:
        raise HTTPException(status_code=404, detail="Carrossel não encontrado para download.")
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="carrossel-{rascunho_id}.zip"',
            "Cache-Control": "private, no-cache",
        },
    )


@app.post("/api/v1/gerar-lote-semanal", status_code=status.HTTP_202_ACCEPTED)
def post_gerar_lote(request: Request):
    usuario = usuario_da_requisicao(request) or "painel"
    if not rotina.iniciar_geracao(usuario):
        return JSONResponse(status_code=409, content={"detail": "Já existe uma geração em andamento. Aguarde terminar."})
    return {"status": "iniciado", "mensagem": "Geração iniciada. As edições aparecem aqui quando terminar."}


@app.post("/api/v1/rascunhos/{rascunho_id}/aprovar")
def post_aprovar_rascunho(rascunho_id: str, request: Request) -> Dict[str, Any]:
    aprovador = usuario_da_requisicao(request)
    if not aprovador:
        raise HTTPException(status_code=400, detail="Aprovação sem usuário identificado.")
    atualizado = rotina.aprovar_rascunho(rascunho_id, aprovado_por=aprovador)
    if not atualizado:
        raise HTTPException(status_code=404, detail=f"Rascunho '{rascunho_id}' não encontrado.")
    return {"status": "ok", "mensagem": "Rascunho aprovado.", "rascunho": atualizado}


@app.post("/api/v1/rascunhos/{rascunho_id}/produto", status_code=status.HTTP_202_ACCEPTED)
def post_trocar_produto(rascunho_id: str, req: TrocarProdutoRequest, request: Request):
    usuario = usuario_da_requisicao(request) or "painel"
    sucesso, mensagem, codigo = rotina.iniciar_troca_produto(rascunho_id, req.produto_slug, usuario=usuario)
    if not sucesso:
        if codigo == 409:
            return JSONResponse(status_code=409, content={"detail": mensagem})
        raise HTTPException(status_code=codigo, detail=mensagem)
    return {"status": "iniciado", "mensagem": mensagem}


class GerarAmbientesRequest(BaseModel):
    produto_slug: str
    quantidade: int = Field(default=4, ge=1, le=4)


@app.get("/api/v1/ambientes")
def get_ambientes(filtro_slug: Optional[str] = None) -> List[Dict[str, Any]]:
    return listar_ambientes(filtro_slug=filtro_slug)


@app.get("/api/v1/ambientes/{imagem_id}.jpg")
def get_ambiente_imagem(imagem_id: str):
    """Entrega a imagem JPEG 3:2 ou 4:5 do ambiente."""
    caminho = obter_caminho_imagem(imagem_id)
    if not caminho or not caminho.exists():
        raise HTTPException(status_code=404, detail="Imagem de ambiente não encontrada.")
    return FileResponse(caminho, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@app.post("/api/v1/ambientes/gerar", status_code=status.HTTP_202_ACCEPTED)
def post_gerar_ambientes(req: GerarAmbientesRequest, request: Request):
    usuario = usuario_da_requisicao(request) or "painel"
    sucesso, mensagem, codigo = iniciar_geracao_ambientes(req.produto_slug, usuario=usuario, quantidade=req.quantidade)
    if not sucesso:
        if codigo in (409, 429):
            return JSONResponse(status_code=codigo, content={"detail": mensagem})
        raise HTTPException(status_code=codigo, detail=mensagem)
    return {"status": "iniciado", "mensagem": mensagem}


@app.post("/api/v1/ambientes/{imagem_id}/aprovar")
def post_aprovar_ambiente(imagem_id: str, request: Request) -> Dict[str, Any]:
    usuario = usuario_da_requisicao(request)
    if not usuario:
        raise HTTPException(status_code=400, detail="Aprovação sem usuário identificado.")
    sucesso, mensagem, registro = aprovar_ambiente(imagem_id, usuario)
    if not sucesso:
        raise HTTPException(status_code=400, detail=mensagem)
    return {"status": "ok", "mensagem": mensagem, "ambiente": registro}


@app.post("/api/v1/ambientes/{imagem_id}/recusar")
def post_recusar_ambiente(imagem_id: str, request: Request) -> Dict[str, Any]:
    usuario = usuario_da_requisicao(request)
    if not usuario:
        raise HTTPException(status_code=400, detail="Recusa sem usuário identificado.")
    sucesso, mensagem, registro = recusar_ambiente(imagem_id, usuario)
    if not sucesso:
        raise HTTPException(status_code=400, detail=mensagem)
    return {"status": "ok", "mensagem": mensagem, "ambiente": registro}

