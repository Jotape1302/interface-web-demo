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
from pydantic import BaseModel, Field

from app import execucoes
from app.config import FILIAIS, FUSO_SP, settings
from app.db import criar_repositorio
from app.estado import Estado, agora, estado, lista_anuncios, ler_data
from app.internal_auth import avisar_configuracao, exigir_chave_interna, usuario_da_requisicao
from app.padronizacao import DIFERENTE, Padronizacao, enviados_ml, vazio_dimensoes
from app.rotina import A_COMBINAR, BLOQUEIO_TEXTO, Rotina, precisa_corrigir

logger = logging.getLogger("marketplace.api")

repositorio = criar_repositorio()
estado_dimensoes = Estado(arquivo="dimensoes.json", vazio=vazio_dimensoes)
padronizacao = Padronizacao(estado_dimensoes, repositorio, estado_fretes=estado)
rotina = Rotina(estado, padronizacao.padroes_por_filial)

STATUS_NO_CATALOGO = ("active", "paused", "under_review")


def proxima(hora: int, agora_dt: Optional[datetime] = None) -> datetime:
    agora_dt = agora_dt or datetime.now(FUSO_SP)
    alvo = agora_dt.replace(hour=hora, minute=0, second=0, microsecond=0)
    return alvo if alvo > agora_dt else alvo + timedelta(days=1)


def proxima_execucao(agora_dt: Optional[datetime] = None) -> datetime:
    return proxima(settings.FRETES_HORA_DIARIA, agora_dt)


# Referência dos jobs em segundo plano: o loop só guarda referência fraca de um future solto, e
# uma exceção no job ficaria sem registro.
_jobs: set = set()


def _registrar_fim(nome: str, fut: "asyncio.Future") -> None:
    _jobs.discard(fut)
    if fut.cancelled():
        logger.warning(f"[{nome}] Job em segundo plano cancelado.")
        return
    exc = fut.exception()
    if exc is not None:
        logger.error(f"[{nome}] Job em segundo plano falhou: {exc}", exc_info=exc)


def disparar(nome: str, fn, *args: Any) -> "asyncio.Future":
    """Roda `fn` no executor guardando o future e logando a exceção do job."""
    fut = asyncio.get_running_loop().run_in_executor(None, fn, *args)
    _jobs.add(fut)
    fut.add_done_callback(lambda f: _registrar_fim(nome, f))
    return fut


def recuperar_orfaos() -> None:
    """
    Job interrompido por um restart não fica "em execução"/"enviando" para sempre: zera o
    marcador e deixa o registro no histórico (e um aviso) de que foi interrompido.
    """
    dados_d = estado_dimensoes.ler()
    orfaos_envio = [s for s, p in dados_d["produtos"].items() if (p.get("envio") or {}).get("status") == "enviando"]
    if dados_d.get("em_execucao") or orfaos_envio:
        with estado_dimensoes.alterar() as dados:
            inicio = dados.get("em_execucao")
            if inicio:
                dados["execucoes"] = (dados["execucoes"] + [{
                    "iniciada_em": inicio, "concluida_em": agora(), "origem": "reinicio", "status": "interrompida",
                    "resumo": {"erros": ["Coleta interrompida por reinício do serviço."]},
                }])[-30:]
            dados["em_execucao"] = None
            dados["progresso"] = None
            for sku in orfaos_envio:
                envio = dados["produtos"][sku]["envio"]
                envio.update({
                    "status": "erro", "em": agora(),
                    "destinos": {"interrompido": {
                        "status": "erro", "local": "Envio ao ML", "em": agora(),
                        "mensagem": "Envio interrompido por reinício do serviço; reenvie o produto.",
                    }},
                })
        logger.warning(f"[MARKETPLACE] Dimensões: coleta/envio órfão após reinício (envios: {len(orfaos_envio)}).")
    pendente = estado.ler().get("execucao_em_andamento")
    if pendente:
        with estado.alterar() as dados:
            dados["execucao_em_andamento"] = None
            estado.registrar_execucao(dados, {
                "iniciada_em": pendente, "concluida_em": agora(), "origem": "reinicio", "status": "interrompida",
                "resumo": {"contas": {}, "novos": 0, "trocas": 0, "corrigidos": 0,
                           "erros": ["Verificação de fretes interrompida por reinício do serviço."]},
            })
            estado.registrar_aviso(dados, "fretes_erro", "Verificação de fretes interrompida",
                                   "O serviço reiniciou durante a verificação; ela foi registrada como interrompida.")


async def _agendar(parar: asyncio.Event, hora: int, tarefa, nome: str) -> None:
    while not parar.is_set():
        espera = (proxima(hora) - datetime.now(FUSO_SP)).total_seconds()
        try:
            await asyncio.wait_for(parar.wait(), timeout=max(1.0, espera))
            return
        except asyncio.TimeoutError:
            pass
        with execucoes.execucao(f"rotina {nome}"):
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
        with execucoes.execucao("rotina FRETES_CONFERENCIA"):
            try:
                await asyncio.to_thread(rotina.conferir_vencidas)
            except Exception as e:
                logger.error(f"[FRETES] Erro na conferência de fretes: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    avisar_configuracao()
    parar = asyncio.Event()
    recuperar_orfaos()
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
    padronizacao.parar.set()  # a coleta pode estar esperando o token do ML (até 40 min)
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


# Contagem de execuções por rota/rotina para o monitor dos agentes Qwen (app/execucoes.py).
execucoes.instalar(app)


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
    if precisa_corrigir(reg) and not reg.get("bloqueio"):
        return "tipo_inconsistente"  # ex.: embalagem de 2 m em ME1 — o botão "Corrigir tipo de frete" acerta
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
    anuncios: List[AnuncioRef] = Field(max_length=200)
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
    disparar("FRETES", rotina.retentar, alvos, usuario_da_requisicao(request, body.usuario))
    return {"status": "iniciada", "total": len(alvos)}


def _periodo(de: str, ate: str) -> Optional[tuple]:
    """`de`/`ate` (AAAA-MM-DD, horário de São Paulo, inclusivos); vazios = sem filtro de período."""
    if not de and not ate:
        return None
    try:
        ini, fim = datetime.strptime(de, "%Y-%m-%d").date(), datetime.strptime(ate, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Informe de e ate no formato AAAA-MM-DD.")
    if ini > fim:
        raise HTTPException(status_code=422, detail="A data inicial não pode ser depois da final.")
    return ini, fim


def _no_periodo(iso: Optional[str], periodo: Optional[tuple]) -> bool:
    if periodo is None:
        return True
    if not iso:
        return False
    try:
        dia = ler_data(iso).astimezone(FUSO_SP).date()
    except ValueError:
        return False
    return periodo[0] <= dia <= periodo[1]


@app.get("/api/v1/fretes/historico")
def historico(
    status_filtro: str = Query("", alias="status"),
    filial: str = "",
    limit: int = Query(200, ge=1, le=2000),
    de: str = "",
    ate: str = "",
) -> Dict[str, Any]:
    periodo = _periodo(de, ate)
    trocas = [
        t
        for t in reversed(estado.ler()["trocas"])
        if (not status_filtro or t.get("status") == status_filtro)
        and (not filial or t["filial"] == filial)
        and _no_periodo(t.get("feita_em"), periodo)
    ]
    # Trocas ok que já saíram do histórico (limite de 2.000), por dia: o ROI soma com o total.
    ok_arquivadas = sum(
        n
        for dia, por_filial in (estado.ler().get("trocas_ok_arquivadas") or {}).items()
        if periodo is None or periodo[0].isoformat() <= dia <= periodo[1].isoformat()
        for f, n in por_filial.items()
        if not filial or f == filial
    ) if status_filtro in ("", "ok") else 0
    return {
        "itens": trocas[:limit], "total": len(trocas), "ok_arquivadas": ok_arquivadas,
        "execucoes": list(reversed(estado.ler()["execucoes"]))[:30],
    }


@app.post("/api/v1/fretes/executar")
async def executar_agora() -> Dict[str, Any]:
    if rotina.em_execucao:
        return {"status": "em_execucao", "iniciada_em": rotina.em_execucao}
    disparar("FRETES", rotina.executar, "manual")
    return {"status": "iniciada"}


@app.post("/api/v1/fretes/corrigir-tipo")
async def corrigir_tipo() -> Dict[str, Any]:
    """
    Varredura: além dos "a combinar", troca os anúncios em ME1/ME2 cujo tipo não bate com a
    embalagem (medidas do Tiny: 1 m/2 m → ME2; 3 m → ME1). Roda em segundo plano, como a rotina.
    """
    if rotina.em_execucao:
        return {"status": "em_execucao", "iniciada_em": rotina.em_execucao}
    disparar("FRETES", lambda: rotina.executar("varredura", varredura=True))
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
def dimensoes_status(de: str = "", ate: str = "") -> Dict[str, Any]:
    periodo = _periodo(de, ate)
    dados = estado_dimensoes.ler()
    produtos = list(dados["produtos"].values())
    por_status: Dict[str, int] = {}
    for p in produtos:
        por_status[p["status"]] = por_status.get(p["status"], 0) + 1
    execucoes = dados["execucoes"]
    return {
        "banco_configurado": settings.banco_configurado(),
        "contas_tiny": [
            {"id": c, "rotulo": settings.rotulo_tiny(c), "filial": f} for f, c in settings.tiny_por_filial().items()
        ],
        "em_execucao": dados.get("em_execucao"),
        "progresso": dados.get("progresso") if dados.get("em_execucao") else None,
        "ultima_execucao": execucoes[-1] if execucoes else None,
        "proxima_execucao": proxima(settings.DIMENSOES_HORA_COLETA).astimezone().isoformat(timespec="seconds"),
        "total_produtos": len(produtos),
        "por_status": por_status,
        "anuncios_a_enviar": sum(1 for p in produtos for a in p["anuncios"] if a.get("situacao") == "diferente"),
        # Enviados pela automação (ROI), pela data do 1º envio com sucesso; produto que já estava
        # igual ao Tiny não conta. Registro próprio (enviados_ml): coleta e reenvio não apagam.
        "produtos_enviados": sum(1 for em in enviados_ml(dados).values() if _no_periodo(em, periodo)),
        "com_erro_de_envio": sum(1 for p in produtos if (p.get("envio") or {}).get("status") == "erro"),
        "enviando": sum(1 for p in produtos if (p.get("envio") or {}).get("status") == "enviando"),
        "anuncios_sem_sku": len(dados.get("anuncios_sem_sku") or []),
    }


@app.get("/api/v1/dimensoes/produtos")
def dimensoes_produtos(
    status_filtro: str = Query("", alias="status"),
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
        if envio and (p.get("envio") or {}).get("status") != envio:
            continue
        if termo and termo not in _normalizar(f"{p['sku']} {p.get('descricao') or ''}"):
            continue
        itens.append(p)
    ordem = {"pendente": 0, "bloqueado": 1, "sem_medida": 2, "padronizado": 3}
    itens.sort(key=lambda p: (ordem.get(p["status"], 9), _normalizar(p.get("descricao") or "")))
    inicio = (page - 1) * page_size
    return {"itens": itens[inicio : inicio + page_size], "total": len(itens), "page": page, "page_size": page_size}


@app.get("/api/v1/dimensoes/sem-sku")
def dimensoes_sem_sku() -> Dict[str, Any]:
    itens = estado_dimensoes.ler().get("anuncios_sem_sku") or []
    return {"itens": itens, "total": len(itens)}


class SkusBody(BaseModel):
    skus: List[str] = Field(max_length=200)
    usuario: Optional[str] = None


TREINO_MAX_PRODUTOS = 300


def _treino_dimensoes(skus: List[str]) -> Dict[str, Any]:
    """Para o registro de treino do gateway (atividades.ts): os produtos com anúncio diferente do
    Tiny (a sugestão é mandar as medidas do Tiny em todos) como a tela mostrou, antes do envio
    mudar o estado. Os escolhidos sempre entram; os demais até TREINO_MAX_PRODUTOS."""
    produtos = estado_dimensoes.ler()["produtos"]
    candidatos = [sku for sku, reg in produtos.items() if any(a.get("situacao") == DIFERENTE for a in reg.get("anuncios", []))]
    escolhidos = [s for s in dict.fromkeys(skus) if s in produtos]
    outros = [s for s in candidatos if s not in set(escolhidos)][: max(0, TREINO_MAX_PRODUTOS - len(escolhidos))]
    return {
        "contexto": {"produtos": {sku: produtos[sku] for sku in escolhidos + outros}, "total_candidatos": len(candidatos)},
        "sugestao": {"enviar_medidas_do_tiny": candidatos},
    }


def _confirmar_e_enviar(body: SkusBody, request: Request, acao: str) -> Dict[str, Any]:
    if not body.skus:
        raise HTTPException(status_code=422, detail="Selecione ao menos um produto.")
    usuario = usuario_da_requisicao(request, body.usuario)
    treino = _treino_dimensoes(body.skus)
    res = padronizacao.confirmar(body.skus, usuario)
    logger.info(f"[DIMENSOES] {acao} de {len(res['aceitos'])} produto(s){f' por {usuario}' if usuario else ''}.")
    if res["aceitos"]:
        disparar("DIMENSOES", padronizacao.enviar, res["aceitos"])
    return {**res, "treino": treino}


@app.post("/api/v1/dimensoes/validar")
async def dimensoes_validar(body: SkusBody, request: Request) -> Dict[str, Any]:
    """
    Confirma o envio ao ML das medidas do Tiny nos anúncios diferentes dos SKUs selecionados. O
    envio segue em segundo plano (com a pausa do ML); o resultado aparece por produto.
    """
    return _confirmar_e_enviar(body, request, "Envio confirmado")


@app.post("/api/v1/dimensoes/reenviar")
async def dimensoes_reenviar(body: SkusBody, request: Request) -> Dict[str, Any]:
    """Reenvia os anúncios que falharam (continuam diferentes do Tiny)."""
    return _confirmar_e_enviar(body, request, "Reenvio")


@app.post("/api/v1/dimensoes/executar")
async def dimensoes_executar() -> Dict[str, Any]:
    if estado_dimensoes.ler().get("em_execucao"):
        return {"status": "em_execucao"}
    disparar("DIMENSOES", padronizacao.coletar, "manual")
    return {"status": "iniciada"}
