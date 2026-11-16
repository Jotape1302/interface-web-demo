import asyncio
import logging
import os
import uuid
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.fuso import agora_sp_naive, agora_sp, hoje_sp
from app.internal_auth import avisar_configuracao as avisar_auth_interna
from app.internal_auth import exigir_chave_interna
from app.config import settings
from app import execucoes, instancia_unica
from app.financial_dashboard import (
    sync_financial_dashboard,
)
from app.sefaz_scan import (
    next_scan_at,
    registrar_cnpjs_sem_varredura,
    run_daily_scan,
    segundos_ate_nova_tentativa,
    segundos_ate_retomar_pendencias,
)
from app.tiny_client import (
    TinyClient,
)
from app.token_repository import TokenRepository
from app.contas_pagar_rotina import (
    proxima_execucao_contas_pagar,
    store_contas_pagar,
)
from app.ml_reconciliation_rotina import (
    EmExecucao as MLEmExecucao,
    proxima_execucao as ml_proxima_execucao,
    rotina as ml_rotina,
)
from app.ml_apis import (
    sincronizar_todos_tokens_ml,
)

from app.routers import conciliacao_ml, danfe, dda, financial_dashboard, health, reconciliacao
from app.routers.reconciliacao import ReconciliacaoPreviewRequest, _run_preview

logger = logging.getLogger("automacao_nfe.api")


async def _background_sefaz_scanner(stop_event: asyncio.Event):
    """Loop de fundo: dispara a varredura direta na SEFAZ 1x/dia no horário configurado (SEFAZ_SCAN_HOUR)."""
    logger.info(f"[SEFAZ_SCAN] Agendador iniciado. Varredura diária às {settings.SEFAZ_SCAN_HOUR:02d}h.")
    try:
        await asyncio.sleep(5)
    except asyncio.CancelledError:
        return

    # Nova rodada a cada ~63 min, 24h por dia, enquanto houver CNPJ recusado pela SEFAZ (cStat 656),
    # com erro ou com NSUs/histórico a recuperar; sem pendência, volta à varredura diária das 06h.
    retentativa_em: Optional[float] = None
    tentativas = 0
    try:
        retomar = await asyncio.to_thread(segundos_ate_retomar_pendencias)
    except Exception as e:
        logger.error(f"[SEFAZ_SCAN] Falha ao ler as pendências ao subir: {e}", exc_info=True)
        retomar = None
    if retomar is not None:
        retentativa_em = float(retomar)
        logger.info(f"[SEFAZ_SCAN] Pendências de NSU/histórico em disco: nova rodada em {retomar // 60} min.")
    while not stop_event.is_set():
        if retentativa_em is not None:
            wait_seconds = retentativa_em
        else:
            now = agora_sp_naive()
            next_run = datetime.fromisoformat(next_scan_at())
            wait_seconds = max(1.0, (next_run - now).total_seconds())

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break  # stop_event foi sinalizado durante a espera
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break

        espera: Optional[int] = None
        with execucoes.execucao("rotina SEFAZ_SCAN"):
            try:
                logger.info(
                    "[SEFAZ_SCAN] Iniciando varredura diária agendada..."
                    if retentativa_em is None
                    else f"[SEFAZ_SCAN] Nova rodada {tentativas} dos CNPJs pendentes..."
                )
                summary = await asyncio.to_thread(run_daily_scan)
                logger.info(f"[SEFAZ_SCAN] Varredura concluída: {summary.total_novas_notas} nota(s) nova(s).")
                espera = segundos_ate_nova_tentativa(summary)
                await asyncio.to_thread(registrar_cnpjs_sem_varredura, summary)
            except Exception as e:
                logger.error(f"[SEFAZ_SCAN] Erro na varredura agendada: {e}", exc_info=True)

        if espera is not None:
            tentativas += 1
            retentativa_em = float(espera)
            logger.warning(
                f"[SEFAZ_SCAN] CNPJ(s) pendentes (recusa da SEFAZ, erro ou recuperação de NSUs). "
                f"Nova rodada {tentativas} em {espera // 60} min."
            )
        else:
            retentativa_em = None
            tentativas = 0


async def _background_financial_dashboard_sync(stop_event: asyncio.Event):
    """Loop de fundo: sincroniza o Dashboard Financeiro 1x/dia (FINANCIAL_DASHBOARD_SYNC_HOUR)."""
    from app.financial_dashboard import next_sync_at as _next_sync_at

    logger.info(
        f"[FINANCIAL_DASHBOARD] Agendador iniciado. Sincronização diária às "
        f"{settings.FINANCIAL_DASHBOARD_SYNC_HOUR:02d}h."
    )
    try:
        await asyncio.sleep(15)
    except asyncio.CancelledError:
        return

    while not stop_event.is_set():
        now = agora_sp_naive()
        next_run = datetime.fromisoformat(_next_sync_at())
        wait_seconds = max(1.0, (next_run - now).total_seconds())

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break

        with execucoes.execucao("rotina FINANCIAL_DASHBOARD"):
            try:
                logger.info("[FINANCIAL_DASHBOARD] Iniciando sincronização diária agendada...")
                summary = await asyncio.to_thread(sync_financial_dashboard)
                ok_count = sum(1 for r in summary.resultados if r.ok)
                logger.info(
                    f"[FINANCIAL_DASHBOARD] Sincronização concluída: {ok_count}/{len(summary.resultados)} empresa(s) ok."
                )
            except Exception as e:
                logger.error(f"[FINANCIAL_DASHBOARD] Erro na sincronização agendada: {e}", exc_info=True)


async def _background_ml_reconciliation(stop_event: asyncio.Event):
    """Loop de fundo: conciliação Mercado Livre 1x/dia (ML_RECONCILIATION_HOUR), liberações de ontem."""
    logger.info(f"[CONCILIACAO_ML] Agendador iniciado. Conciliação diária às {settings.ML_RECONCILIATION_HOUR:02d}h.")
    while not stop_event.is_set():
        wait_seconds = max(1.0, (ml_proxima_execucao() - agora_sp()).total_seconds())
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break
        with execucoes.execucao("rotina CONCILIACAO_ML"):
            try:
                logger.info("[CONCILIACAO_ML] Iniciando conciliação diária agendada...")
                execucao = await asyncio.to_thread(ml_rotina.executar, "agendada")
                logger.info(f"[CONCILIACAO_ML] Conciliação diária concluída: {execucao['status']}.")
            except MLEmExecucao:
                logger.warning("[CONCILIACAO_ML] Conciliação diária pulada: já havia uma execução manual em andamento.")
            except Exception as e:
                logger.error(f"[CONCILIACAO_ML] Erro na conciliação diária agendada: {e}", exc_info=True)


async def _background_ml_token_sync(stop_event: asyncio.Event):
    """Loop de fundo: sincroniza tokens do Mercado Livre a cada 2 horas (mantém ml_tokens.json sempre ativo)."""
    logger.info("[CONCILIACAO_ML] Sincronizador de fundo de tokens do Mercado Livre iniciado (intervalo: 2h).")
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=10.0)
        return
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass

    while not stop_event.is_set():
        try:
            logger.info("[CONCILIACAO_ML] Verificando e sincronizando tokens do Mercado Livre...")
            await asyncio.to_thread(sincronizar_todos_tokens_ml, settings, False)
        except Exception as e:
            logger.warning(f"[CONCILIACAO_ML] Aviso no sincronizador de tokens em segundo plano: {e}")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=7200.0)
            break
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass


async def _background_dda(stop_event: asyncio.Event):
    """Loop de fundo: boletos do DDA (Polp → Tiny → Inter → baixa) a cada DDA_INTERVALO_MINUTOS."""
    from app.dda_pagamentos import proxima_espera_segundos, rotina as dda_rotina

    if not settings.DDA_ATIVO:
        logger.info("[DDA] Rotina desligada (DDA_ATIVO=false).")
        return
    logger.info(f"[DDA] Rotina iniciada: a cada {settings.DDA_INTERVALO_MINUTOS} min "
                f"(agendar no Inter: {'sim' if settings.DDA_AGENDAR_NO_INTER else 'não'}).")
    espera = 60.0
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=espera)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break
        espera = float(proxima_espera_segundos())
        with execucoes.execucao("rotina DDA"):
            try:
                resumo = await asyncio.to_thread(dda_rotina.executar, "agendada")
                logger.info(f"[DDA] Rodada concluída: {resumo}")
            except RuntimeError as e:
                logger.warning(f"[DDA] Rodada pulada: {e}")
            except Exception as e:
                logger.error(f"[DDA] Erro na rodada agendada: {e}", exc_info=True)


async def _background_contas_pagar_sync(stop_event: asyncio.Event):
    """Loop de fundo: conferência diária de Contas a Pagar às CONTAS_PAGAR_ROTINA_HOUR."""
    logger.info(
        f"[CONTAS_PAGAR_ROTINA] Agendador iniciado. Conferência diária às {settings.CONTAS_PAGAR_ROTINA_HOUR:02d}h."
    )
    while not stop_event.is_set():
        wait_seconds = max(1.0, (proxima_execucao_contas_pagar() - agora_sp()).total_seconds())
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break
        with execucoes.execucao("rotina CONTAS_PAGAR_ROTINA"):
            try:
                logger.info("[CONTAS_PAGAR_ROTINA] Iniciando conferência diária agendada de Contas a Pagar...")
                await asyncio.to_thread(_executar_rotina_diaria_contas_pagar)
                logger.info("[CONTAS_PAGAR_ROTINA] Conferência diária de Contas a Pagar concluída.")
            except Exception as e:
                logger.error(f"[CONTAS_PAGAR_ROTINA] Erro na conferência diária agendada: {e}", exc_info=True)


def _executar_rotina_diaria_contas_pagar():
    """Executa a rotina diária de conferência de Contas a Pagar."""
    dias = settings.CONTAS_PAGAR_ROTINA_DIAS or 60
    dt_fim = hoje_sp()
    dt_inicio = dt_fim - timedelta(days=dias)
    req = ReconciliacaoPreviewRequest(
        empresa="todas",
        data_inicio=dt_inicio.isoformat(),
        data_fim=dt_fim.isoformat(),
        forcar_atualizacao=True,
    )
    res = _run_preview(req)
    try:
        store_contas_pagar.conferir_baixas_externas(TinyClient(), TokenRepository(settings), settings)
    except Exception as e_ext:
        logger.warning(f"[CONTAS_PAGAR_ROTINA] Erro ao conferir baixas externas: {e_ext}")
    return res


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gerencia ciclo de vida do serviço: assegura diretórios e tarefas de background."""
    settings.ensure_directories()
    # Um processo por DATA_DIR: fila de tarefas e caches em memória, locks só entre threads.
    instancia_unica.adquirir(settings.DATA_DIR)
    avisar_auth_interna()
    stop_event = asyncio.Event()
    task = asyncio.create_task(_background_sefaz_scanner(stop_event))
    financial_task = asyncio.create_task(_background_financial_dashboard_sync(stop_event))
    ml_task = asyncio.create_task(_background_ml_reconciliation(stop_event))
    contas_pagar_task = asyncio.create_task(_background_contas_pagar_sync(stop_event))
    dda_task = asyncio.create_task(_background_dda(stop_event))
    ml_token_task = None
    if not settings.MOCK_MODE and settings.TMS_USER and settings.TMS_PASSWORD:
        ml_token_task = asyncio.create_task(_background_ml_token_sync(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        task.cancel()
        financial_task.cancel()
        ml_task.cancel()
        contas_pagar_task.cancel()
        dda_task.cancel()
        try:
            await dda_task
        except asyncio.CancelledError:
            pass
        if ml_token_task:
            ml_token_task.cancel()
            try:
                await ml_token_task
            except asyncio.CancelledError:
                pass
        try:
            await contas_pagar_task
        except asyncio.CancelledError:
            pass
        try:
            await ml_task
        except asyncio.CancelledError:
            pass
        try:
            await task
        except asyncio.CancelledError:
            pass
        try:
            await financial_task
        except asyncio.CancelledError:
            pass
        instancia_unica.liberar()


app = FastAPI(
    title="Automação Fiscal NF-e / DANFE -> Tiny ERP",
    description="Motor funcional de leitura de DANFEs, extração de 44 dígitos, consulta na Receita Federal e integração com Tiny ERP.",
    version="1.0.0",
    lifespan=lifespan,
    # Chave interna do gateway em todas as rotas, menos /health e /api/v1/health (app/internal_auth.py).
    dependencies=[Depends(exigir_chave_interna)],
    # A dependência global não cobre /docs, /redoc e /openapi.json (SEC-05): desligados.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.exception_handler(Exception)
async def _erro_nao_tratado(request: Request, exc: Exception) -> JSONResponse:
    # Detalhe só no log (pode trazer resposta crua do Tiny/Inter, caminhos, etc.); o cliente
    # recebe uma mensagem genérica com o id para achar a linha no log.
    # Id de correlação: o X-Request-Id do gateway quando vier (mesmo id nos dois logs), senão um novo.
    req_id = request.headers.get("x-request-id") or ""
    erro_id = req_id if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", req_id) else uuid.uuid4().hex[:12]
    logger.error(f"Erro não tratado [{erro_id}] em {request.method} {request.url.path}: {exc}", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Erro interno no serviço (id {erro_id}). Consulte os logs da automação.", "erro_id": erro_id},
    )

# CORS: o navegador nunca fala direto com esta API (passa pelo gateway, servidor a servidor),
# então por padrão nenhuma origem é liberada. CORS_ORIGINS (lista separada por vírgula) só
# para desenvolvimento local, se for preciso chamar a API direto do navegador.
allowed_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Internal-Key", "X-Usuario"],
    )


# Contagem de execuções por rota/rotina para o monitor dos agentes Qwen (app/execucoes.py).
execucoes.instalar(app)

for _router in (health.router, danfe.router, financial_dashboard.router, reconciliacao.router, conciliacao_ml.router, dda.router):
    app.include_router(_router)
