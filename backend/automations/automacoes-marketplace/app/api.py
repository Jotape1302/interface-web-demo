"""
API das automações de Marketplace. O gateway é o único cliente: aplica login e permissão de
área e repassa para cá (/api/marketplace/<automação>/* → /api/v1/<automação>/*).

- /api/v1/dimensoes/*: automação 1, Padronização de dimensões (padronizacao.py).
- /api/v1/fretes/*: automação 2, Tipo de frete (rotina.py).
"""
import asyncio
import logging
import re
import unicodedata
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import FILIAIS, settings
from app.db import criar_repositorio
from app.estado import Estado, estado, lista_anuncios
from app.internal_auth import avisar_configuracao, exigir_chave_interna, usuario_da_requisicao
from app.padronizacao import Padronizacao, vazio_dimensoes
from app.rotina import A_COMBINAR, BLOQUEIO_TEXTO, Rotina

logger = logging.getLogger("marketplace.api")

repositorio = criar_repositorio()
estado_dimensoes = Estado(arquivo="dimensoes.json", vazio=vazio_dimensoes)
rotina = Rotina(estado, repositorio)
padronizacao = Padronizacao(estado_dimensoes, repositorio, estado_fretes=estado)

STATUS_NO_CATALOGO = ("active", "paused", "under_review")


def proxima(hora: int, agora_dt: Optional[datetime] = None) -> datetime:
    agora_dt = agora_dt or datetime.now()
    alvo = agora_dt.replace(hour=hora, minute=0, second=0, microsecond=0)
    return alvo if alvo > agora_dt else alvo + timedelta(days=1)


def proxima_execucao(agora_dt: Optional[datetime] = None) -> datetime:
    return proxima(settings.FRETES_HORA_DIARIA, agora_dt)


async def _agendar(parar: asyncio.Event, hora: int, tarefa, nome: str) -> None:
    while not parar.is_set():
        espera = (proxima(hora) - datetime.now()).total_seconds()
        try:
            await asyncio.wait_for(parar.wait(), timeout=max(1.0, espera))
            return
        except asyncio.TimeoutError:
            pass
        try:
            await asyncio.to_thread(tarefa, "agendada")
        except Exception as e:
            logger.error(f"[{nome}] Erro na execução diária: {e}", exc_info=True)


async def _conferencias(parar: asyncio.Event) -> None:
    while not parar.is_set():
        try:
            await asyncio.wait_for(parar.wait(), timeout=60)
            return
        except asyncio.TimeoutError:
            pass
        try:
            await asyncio.to_thread(rotina.conferir_vencidas)
        except Exception as e:
            logger.error(f"[FRETES] Erro na conferência de fretes: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    avisar_configuracao()
    parar = asyncio.Event()
    # Coleta interrompida por um restart não fica marcada como "em andamento" para sempre.
    if estado_dimensoes.ler().get("em_execucao"):
        with estado_dimensoes.alterar() as dados:
            dados["em_execucao"] = None
            dados["progresso"] = None
    tarefas = [
        asyncio.create_task(_agendar(parar, settings.DIMENSOES_HORA_COLETA, padronizacao.coletar, "DIMENSOES")),
        asyncio.create_task(_agendar(parar, settings.FRETES_HORA_DIARIA, rotina.executar, "FRETES")),
        asyncio.create_task(_conferencias(parar)),
    ]
    logger.info(
        f"[MARKETPLACE] Coleta de dimensões às {settings.DIMENSOES_HORA_COLETA:02d}h; "
        f"tipo de frete às {settings.FRETES_HORA_DIARIA:02d}h."
    )
    yield
    parar.set()
    for t in tarefas:
        t.cancel()


# Chave interna do gateway em todas as rotas, menos /health e /api/v1/health (app/internal_auth.py).
# A dependência global (chave interna) não cobre /docs, /redoc e /openapi.json (SEC-05): desligados.
app = FastAPI(
    title="Automações de Marketplace",
    lifespan=lifespan,
    dependencies=[Depends(exigir_chave_interna)],
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.exception_handler(Exception)
async def _erro_nao_tratado(request: Request, exc: Exception) -> JSONResponse:
    # Detalhe só no log; o cliente recebe mensagem genérica com o id para achar a linha no log.
    # Id de correlação: o X-Request-Id do gateway quando vier (mesmo id nos dois logs), senão um novo.
    req_id = request.headers.get("x-request-id") or ""
    erro_id = req_id if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", req_id) else uuid.uuid4().hex[:12]
    logger.error(f"Erro não tratado [{erro_id}] em {request.method} {request.url.path}: {exc}", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Erro interno no serviço (id {erro_id}). Consulte os logs da automação.", "erro_id": erro_id},
    )


def _normalizar(texto: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", texto or "") if unicodedata.category(c) != "Mn").lower()


@app.get("/health")
@app.get("/api/v1/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "automacoes-marketplace"}


# =============================================================================================
# Automação 2 — Tipo de frete
# =============================================================================================

def _situacao(reg: Dict[str, Any], aguardando: set) -> str:
    chave = f"{reg['filial']}:{reg['mlb']}"
    if chave in aguardando:
        return "conferindo"
    if reg.get("falha_envio"):
        return "falha"
    if reg.get("modo_envio") == A_COMBINAR:
        return "bloqueado" if reg.get("bloqueio") else "a_combinar"
    return "ok"


def _publico(reg: Dict[str, Any], aguardando: set) -> Dict[str, Any]:
    bloqueio = reg.get("bloqueio")
    return {
        **reg,
        "situacao": _situacao(reg, aguardando),
        "bloqueio_texto": BLOQUEIO_TEXTO.get(bloqueio) if bloqueio else None,
    }


def _aguardando(dados: Dict[str, Any]) -> set:
    return {f"{t['filial']}:{t['mlb']}" for t in dados["trocas"] if t.get("status") == "aguardando"}


@app.get("/api/v1/fretes/status")
def status() -> Dict[str, Any]:
    dados = estado.ler()
    aguardando = _aguardando(dados)
    catalogo = [a for a in lista_anuncios(dados) if a.get("status") in STATUS_NO_CATALOGO]
    contagem: Dict[str, int] = {}
    envios: Dict[str, int] = {}  # por modo de envio (me1, me2, not_specified...)
    for a in catalogo:
        s = _situacao(a, aguardando)
        contagem[s] = contagem.get(s, 0) + 1
        if a.get("modo_envio"):
            envios[a["modo_envio"]] = envios.get(a["modo_envio"], 0) + 1
    contas = {}
    for filial in FILIAIS:
        token = estado.token(filial)
        contas[filial] = {
            "rotulo": settings.rotulos()[filial],
            "conectada": bool(token.get("access_token") or settings.access_token_env(filial)),
            "renovado_em": token.get("renovado_em"),
            "me1": filial in settings.contas_com_me1(),
        }
    execucoes = dados["execucoes"]
    return {
        "configurado": any(c["conectada"] for c in contas.values()),
        "contas": contas,
        "em_execucao": rotina.em_execucao,
        "ultima_execucao": execucoes[-1] if execucoes else None,
        "proxima_execucao": proxima_execucao().astimezone().isoformat(timespec="seconds"),
        "total_anuncios": len(catalogo),
        "contagem": contagem,
        "envios": envios,
        "desfeitos": sum(1 for a in catalogo if a.get("falha_envio")),
        # Mesmo critério da aba Anúncios filtrada por situação "conferindo" (clique no card).
        "aguardando_conferencia": sum(1 for a in lista_anuncios(dados) if f"{a['filial']}:{a['mlb']}" in aguardando),
        "sem_padrao": sum(1 for a in catalogo if a.get("bloqueio") in ("sem_padrao", "sem_sku")),
        "minutos_conferencia": settings.FRETES_MINUTOS_CONFERENCIA,
    }


@app.get("/api/v1/fretes/anuncios")
def listar_anuncios(
    q: str = "",
    filial: str = "",
    situacao: str = "",
    modo: str = "",
    bloqueio: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    dados = estado.ler()
    aguardando = _aguardando(dados)
    termo = _normalizar(q.strip())
    bloqueios = {b for b in bloqueio.split(",") if b}
    itens: List[Dict[str, Any]] = []
    for reg in lista_anuncios(dados):
        if filial and reg["filial"] != filial:
            continue
        if modo and (reg.get("modo_envio") or "") != modo:
            continue
        if bloqueios and reg.get("bloqueio") not in bloqueios:
            continue
        sit = _situacao(reg, aguardando)
        if situacao and sit != situacao:
            continue
        if not situacao and reg.get("status") not in STATUS_NO_CATALOGO:
            continue
        if termo and termo not in _normalizar(f"{reg['mlb']} {reg.get('sku') or ''} {reg.get('titulo') or ''}"):
            continue
        itens.append(_publico(reg, aguardando))
    itens.sort(key=lambda r: (r["situacao"] not in ("a_combinar", "bloqueado"), _normalizar(r.get("titulo") or "")))
    inicio = (page - 1) * page_size
    return {"itens": itens[inicio : inicio + page_size], "total": len(itens), "page": page, "page_size": page_size}


@app.get("/api/v1/fretes/desfeitos")
def listar_desfeitos() -> Dict[str, Any]:
    """Anúncios em que o ML desfez a última alteração (ou ela falhou): lista do card "ML desfez"."""
    dados = estado.ler()
    aguardando = _aguardando(dados)
    itens = [
        _publico(r, aguardando)
        for r in lista_anuncios(dados)
        if r.get("falha_envio") and r.get("status") in STATUS_NO_CATALOGO
    ]
    itens.sort(key=lambda r: r["falha_envio"].get("em") or "", reverse=True)
    return {"itens": itens, "total": len(itens)}


class AnuncioRef(BaseModel):
    filial: str
    mlb: str


class RetentarBody(BaseModel):
    anuncios: List[AnuncioRef]
    usuario: Optional[str] = None


@app.post("/api/v1/fretes/retentar")
async def retentar(body: RetentarBody, request: Request) -> Dict[str, Any]:
    """
    Nova tentativa nos anúncios selecionados, em segundo plano (com a pausa entre alterações,
    muitos anúncios passariam do tempo de resposta). O resultado aparece no histórico.
    """
    if not body.anuncios:
        raise HTTPException(status_code=422, detail="Selecione ao menos um anúncio.")
    alvos = [a.model_dump() for a in body.anuncios]
    # Autor: X-Usuario do gateway (sessão); o `usuario` do corpo só sem o header.
    asyncio.get_running_loop().run_in_executor(None, rotina.retentar, alvos, usuario_da_requisicao(request, body.usuario))
    return {"status": "iniciada", "total": len(alvos)}


@app.get("/api/v1/fretes/historico")
def historico(status_filtro: str = Query("", alias="status"), filial: str = "", limit: int = Query(200, ge=1, le=2000)) -> Dict[str, Any]:
    trocas = [
        t
        for t in reversed(estado.ler()["trocas"])
        if (not status_filtro or t.get("status") == status_filtro) and (not filial or t["filial"] == filial)
    ]
    return {"itens": trocas[:limit], "total": len(trocas), "execucoes": list(reversed(estado.ler()["execucoes"]))[:30]}


@app.post("/api/v1/fretes/executar")
async def executar_agora() -> Dict[str, Any]:
    if rotina.em_execucao:
        return {"status": "em_execucao", "iniciada_em": rotina.em_execucao}
    asyncio.get_running_loop().run_in_executor(None, rotina.executar, "manual")
    return {"status": "iniciada"}


@app.get("/api/v1/fretes/avisos")
def avisos(depois_de: int = 0) -> Dict[str, Any]:
    """Avisos novos (das duas automações) para o gateway notificar (setor Marketplace + admins)."""
    dados = estado.ler()
    itens = [a for a in dados["avisos"] if int(a["id"]) > depois_de]
    return {"itens": itens, "ultimo_id": int(dados.get("proximo_aviso") or 1) - 1}


# =============================================================================================
# Automação 1 — Padronização de dimensões
# =============================================================================================

@app.get("/api/v1/dimensoes/status")
def dimensoes_status() -> Dict[str, Any]:
    dados = estado_dimensoes.ler()
    produtos = list(dados["produtos"].values())
    por_status: Dict[str, int] = {}
    por_conf: Dict[str, int] = {}
    for p in produtos:
        por_status[p["status"]] = por_status.get(p["status"], 0) + 1
        if p["status"] != "padronizado":
            por_conf[p["confiabilidade"]] = por_conf.get(p["confiabilidade"], 0) + 1
    execucoes = dados["execucoes"]
    return {
        "banco_configurado": settings.banco_configurado(),
        "contas_tiny": [{"id": c, "rotulo": settings.rotulo_tiny(c)} for c in settings.contas_tiny()],
        "em_execucao": dados.get("em_execucao"),
        "progresso": dados.get("progresso") if dados.get("em_execucao") else None,
        "ultima_execucao": execucoes[-1] if execucoes else None,
        "proxima_execucao": proxima(settings.DIMENSOES_HORA_COLETA).astimezone().isoformat(timespec="seconds"),
        "total_produtos": len(produtos),
        "por_status": por_status,
        "pendentes_por_confiabilidade": por_conf,
        "com_erro_de_envio": sum(1 for p in produtos if (p.get("envio") or {}).get("status") == "erro"),
        "enviando": sum(1 for p in produtos if (p.get("envio") or {}).get("status") == "enviando"),
        "anuncios_sem_sku": len(dados.get("anuncios_sem_sku") or []),
    }


@app.get("/api/v1/dimensoes/produtos")
def dimensoes_produtos(
    status_filtro: str = Query("", alias="status"),
    confiabilidade: str = "",
    envio: str = "",
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    termo = _normalizar(q.strip())
    status_ok = {s for s in status_filtro.split(",") if s}
    itens = []
    for p in estado_dimensoes.ler()["produtos"].values():
        if status_ok and p["status"] not in status_ok:
            continue
        if confiabilidade and p["confiabilidade"] != confiabilidade:
            continue
        if envio and (p.get("envio") or {}).get("status") != envio:
            continue
        if termo and termo not in _normalizar(f"{p['sku']} {p.get('descricao') or ''}"):
            continue
        itens.append(p)
    ordem_conf = {"baixa": 0, "media": 1, "alta": 2}
    itens.sort(key=lambda p: (ordem_conf.get(p["confiabilidade"], 0), _normalizar(p.get("descricao") or "")))
    inicio = (page - 1) * page_size
    return {"itens": itens[inicio : inicio + page_size], "total": len(itens), "page": page, "page_size": page_size}


@app.get("/api/v1/dimensoes/sem-sku")
def dimensoes_sem_sku() -> Dict[str, Any]:
    itens = estado_dimensoes.ler().get("anuncios_sem_sku") or []
    return {"itens": itens, "total": len(itens)}


class ProdutoValidado(BaseModel):
    sku: str
    altura: Optional[float] = None
    largura: Optional[float] = None
    comprimento: Optional[float] = None
    peso: Optional[int] = None


class ValidarBody(BaseModel):
    produtos: List[ProdutoValidado]
    usuario: Optional[str] = None


@app.post("/api/v1/dimensoes/validar")
async def dimensoes_validar(body: ValidarBody, request: Request) -> Dict[str, Any]:
    """
    Grava as medidas revisadas em dimensoes_produtos (na hora) e envia às plataformas em
    segundo plano (Tiny + ML, com as pausas de cada API). O resultado aparece por produto.
    """
    if not body.produtos:
        raise HTTPException(status_code=422, detail="Selecione ao menos um produto.")
    try:
        res = await asyncio.to_thread(
            padronizacao.validar, [p.model_dump() for p in body.produtos], usuario_da_requisicao(request, body.usuario)
        )
    except Exception as e:
        erro_id = uuid.uuid4().hex[:12]
        logger.error(f"[DIMENSOES] Falha ao gravar em dimensoes_produtos [{erro_id}]: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Falha ao gravar as dimensões no banco (id {erro_id}; detalhe no log).")
    if res["gravados"]:
        asyncio.get_running_loop().run_in_executor(None, padronizacao.enviar, res["gravados"])
    return res


class ReenviarBody(BaseModel):
    skus: List[str]
    usuario: Optional[str] = None


@app.post("/api/v1/dimensoes/reenviar")
async def dimensoes_reenviar(body: ReenviarBody, request: Request) -> Dict[str, Any]:
    """Reenvia às plataformas o padrão já gravado (ex.: depois de uma falha no Tiny ou no ML)."""
    if not body.skus:
        raise HTTPException(status_code=422, detail="Selecione ao menos um produto.")
    usuario = usuario_da_requisicao(request, body.usuario)
    logger.info(f"[DIMENSOES] Reenvio de {len(body.skus)} produto(s){f' por {usuario}' if usuario else ''}.")
    with estado_dimensoes.alterar() as dados:
        for sku in body.skus:
            if sku in dados["produtos"] and dados["produtos"][sku].get("padrao"):
                envio = dados["produtos"][sku].get("envio") or {}
                dados["produtos"][sku]["envio"] = {**envio, "status": "enviando", "em": envio.get("em")}
    asyncio.get_running_loop().run_in_executor(None, padronizacao.enviar, body.skus)
    return {"status": "iniciado", "total": len(body.skus)}


@app.post("/api/v1/dimensoes/executar")
async def dimensoes_executar() -> Dict[str, Any]:
    if estado_dimensoes.ler().get("em_execucao"):
        return {"status": "em_execucao"}
    asyncio.get_running_loop().run_in_executor(None, padronizacao.coletar, "manual")
    return {"status": "iniciada"}
