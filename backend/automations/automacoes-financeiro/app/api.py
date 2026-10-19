import asyncio
import json
import logging
import os
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import time
import uuid
import math
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, Tuple
from urllib.parse import quote

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.internal_auth import avisar_configuracao as avisar_auth_interna
from app.internal_auth import chave_valida, exigir_chave_interna, usuario_da_requisicao
from app.audit import load_resolved_failures, mark_failure_resolved, record_audit_error
from app.categorization import CategorizedItem, GroupedLancamento, group_items_by_category
from app.category_history import CategoryHistoryIndex
from app.category_history import get_index as get_category_history
from app.cert_status import get_certificates_status
from app.config import settings
from app.financial_dashboard import (
    get_dashboard_response,
    get_sync_status,
    is_sync_running,
    sync_cooldown_remaining_seconds,
    sync_financial_dashboard,
)
from app.nfe_client import BaseNFeProvider, NFeData, NFeDuplicate, dados_fiscais_do_arquivo, get_nfe_provider, enrich_nfe_data_from_file_context, validar_nsu
from app.nfe_items import NFeItem
from app.review_pipeline import already_launched_in_tiny, stage_note_for_review
from app.review_store import (
    ReviewItem,
    ReviewRecord,
    archive_pending,
    get_pending,
    list_archived,
    list_confirmed,
    list_pending,
    remove_pending,
    restore_archived,
    write_record_json,
)
from app.scanner import DANFEScanner, ScanResult
from app.sefaz_scan import (
    clear_cnpj_cooldown,
    get_scan_status,
    is_scan_running,
    load_cooldown_state,
    load_nsu_state,
    next_scan_at,
    run_daily_scan,
    save_nsu_checkpoint,
    scan_cooldown_remaining_seconds,
)
from app.tiny_categories import CATEGORY_BY_ID, DEFAULT_CATEGORY_ID, TINY_CATEGORIES
from app.json_store import save_json_state
from app.tiny_client import (
    PAYMENT_METHOD_MARCADOR,
    PAYMENT_METHOD_NFE_LABELS,
    SITUACOES_CONTA_PAGAR_BAIXAVEIS,
    TinyClient,
    dividir_em_parcelas,
    is_v3_token,
)
from app.token_repository import TokenRepository
from app.inter_client import InterClient, InterTransacao, INTER_EMPRESAS, _parse_date
from app import ml_reconciliation as ml
from app.contas_pagar_rotina import (
    proxima_execucao_contas_pagar,
    store_contas_pagar,
)
from app.ml_reconciliation_rotina import (
    EmExecucao as MLEmExecucao,
    periodo_padrao as ml_periodo_padrao,
    proxima_execucao as ml_proxima_execucao,
    resumo_execucao as ml_resumo_execucao,
    rotina as ml_rotina,
    token_tiny as ml_token_tiny,
    validar_periodo as ml_validar_periodo,
)
from app.ml_apis import (
    sincronizar_todos_tokens_ml,
    token_ml,
    _candidatos_ml_tokens_files,
    token_esta_valido,
)
from app.reconciliation import (
    match_transactions,
    match_transactions_ja_baixadas,
    JA_BAIXADAS_TOLERANCIA_DIAS,
    split_transferencias_internas,
    destino_transferencia_interna,
    MatchMethod,
    EMPRESA_LABELS,
    _to_decimal,
    _extract_cnpj_from_tiny,
    _extract_supplier_name_from_tiny,
)

logger = logging.getLogger("automacao_nfe.api")


async def _background_sefaz_scanner(stop_event: asyncio.Event):
    """Loop de fundo: dispara a varredura direta na SEFAZ 1x/dia no horário configurado (SEFAZ_SCAN_HOUR)."""
    logger.info(f"[SEFAZ_SCAN] Agendador iniciado. Varredura diária às {settings.SEFAZ_SCAN_HOUR:02d}h.")
    try:
        await asyncio.sleep(5)
    except asyncio.CancelledError:
        return

    while not stop_event.is_set():
        now = datetime.now()
        next_run = datetime.fromisoformat(next_scan_at())
        wait_seconds = max(1.0, (next_run - now).total_seconds())

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break  # stop_event foi sinalizado durante a espera
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break

        try:
            logger.info("[SEFAZ_SCAN] Iniciando varredura diária agendada...")
            summary = await asyncio.to_thread(run_daily_scan)
            logger.info(f"[SEFAZ_SCAN] Varredura concluída: {summary.total_novas_notas} nota(s) nova(s).")
        except Exception as e:
            logger.error(f"[SEFAZ_SCAN] Erro na varredura agendada: {e}", exc_info=True)


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
        now = datetime.now()
        next_run = datetime.fromisoformat(_next_sync_at())
        wait_seconds = max(1.0, (next_run - now).total_seconds())

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break

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
        wait_seconds = max(1.0, (ml_proxima_execucao() - datetime.now()).total_seconds())
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break
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


async def _background_contas_pagar_sync(stop_event: asyncio.Event):
    """Loop de fundo: conferência diária de Contas a Pagar às CONTAS_PAGAR_ROTINA_HOUR."""
    logger.info(
        f"[CONTAS_PAGAR_ROTINA] Agendador iniciado. Conferência diária às {settings.CONTAS_PAGAR_ROTINA_HOUR:02d}h."
    )
    while not stop_event.is_set():
        wait_seconds = max(1.0, (proxima_execucao_contas_pagar() - datetime.now()).total_seconds())
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            break
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            break
        try:
            logger.info("[CONTAS_PAGAR_ROTINA] Iniciando conferência diária agendada de Contas a Pagar...")
            await asyncio.to_thread(_executar_rotina_diaria_contas_pagar)
            logger.info("[CONTAS_PAGAR_ROTINA] Conferência diária de Contas a Pagar concluída.")
        except Exception as e:
            logger.error(f"[CONTAS_PAGAR_ROTINA] Erro na conferência diária agendada: {e}", exc_info=True)


def _executar_rotina_diaria_contas_pagar():
    """Executa a rotina diária de conferência de Contas a Pagar."""
    dias = settings.CONTAS_PAGAR_ROTINA_DIAS or 60
    dt_fim = date.today()
    dt_inicio = dt_fim - timedelta(days=dias)
    req = ReconciliacaoPreviewRequest(
        empresa="todas",
        data_inicio=dt_inicio.isoformat(),
        data_fim=dt_fim.isoformat(),
        forcar_atualizacao=True,
    )
    res = _run_preview(req)
    try:
        store_contas_pagar.conferir_baixas_externas(tiny_client, token_repo, settings)
    except Exception as e_ext:
        logger.warning(f"[CONTAS_PAGAR_ROTINA] Erro ao conferir baixas externas: {e_ext}")
    return res


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gerencia ciclo de vida do serviço: assegura diretórios e tarefas de background."""
    settings.ensure_directories()
    avisar_auth_interna()
    stop_event = asyncio.Event()
    task = asyncio.create_task(_background_sefaz_scanner(stop_event))
    financial_task = asyncio.create_task(_background_financial_dashboard_sync(stop_event))
    ml_task = asyncio.create_task(_background_ml_reconciliation(stop_event))
    contas_pagar_task = asyncio.create_task(_background_contas_pagar_sync(stop_event))
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


# Modelos Pydantic para respostas da API
class DuplicateResponse(BaseModel):
    numero: str
    vencimento: str
    valor: float


class NFeDataResponse(BaseModel):
    chave: str
    numero_nota: str
    data_emissao: str
    emitente_nome: str
    emitente_cnpj: str
    valor_total: float
    duplicatas: List[DuplicateResponse]
    destinatario_cnpj: Optional[str] = None
    destinatario_nome: Optional[str] = None
    meio_pagamento_nfe: Optional[str] = None
    # Marcador de caixa/cartão lido do nome do arquivo ("Cartão Clara", "Caixa Visa"...): a tela
    # de revisão pré-seleciona a forma de pagamento por ele, antes do padrão da empresa.
    marcador_caixa: Optional[str] = None


class TinyContaResponse(BaseModel):
    conta_id: Optional[int] = None
    nro_documento: str
    valor: float
    vencimento: str
    situacao: str
    is_duplicate: bool = False


class TinyCategoryResponse(BaseModel):
    id: str
    nome: str
    grupo: str
    label: str


class NFeItemResponse(BaseModel):
    item_id: str
    descricao: str
    valor_total: float
    codigo: Optional[str] = None
    ncm: Optional[str] = None
    quantidade: float
    valor_unitario: Optional[float] = None
    categoria_sugerida_id: str
    categoria_sugerida_nome: str


class ProcessItemResult(BaseModel):
    filename: str
    status: str  # "success" | "error"
    step: str    # "scan" | "receita_federal" | "tiny_erp" | "pending_review" | "completed"
    key: Optional[str] = None
    scan_method: Optional[str] = None
    page_number: Optional[int] = None
    nfe_data: Optional[NFeDataResponse] = None
    itens: List[NFeItemResponse] = []
    tiny_results: List[TinyContaResponse] = []
    error_message: Optional[str] = None
    processed_at: str


class ChaveRequest(BaseModel):
    chave: str


class ConfirmItemCategoria(BaseModel):
    item_id: str
    categoria_id: str


MAX_PARCELAS = 12


class ConfirmLancamentoRequest(BaseModel):
    chave: str
    itens: List[ConfirmItemCategoria]
    forma_pagamento: str = "pix"
    meio_pagamento_nfe: Optional[str] = None
    # Quantidade de parcelas escolhida na revisão: cada categoria vira N contas no Tiny.
    parcelas: int = Field(default=1, ge=1, le=MAX_PARCELAS)


class GroupedLancamentoResponse(BaseModel):
    categoria_id: str
    categoria_nome: str
    valor_total: float
    item_ids: List[str]
    parcela: int = 1
    total_parcelas: int = 1
    tiny_result: Optional[TinyContaResponse] = None
    status: str  # "success" | "error"
    error_message: Optional[str] = None


class ConfirmLancamentoResponse(BaseModel):
    chave: str
    status: str  # "success" | "partial_error"
    grupos: List[GroupedLancamentoResponse]


class BatchProcessResponse(BaseModel):
    total: int
    success_count: int
    failed_count: int
    total_amount: float
    items: List[ProcessItemResult]


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


def _nfe_data_to_response(nfe_data: NFeData) -> NFeDataResponse:
    return NFeDataResponse(
        chave=nfe_data.chave,
        numero_nota=nfe_data.numero_nota,
        data_emissao=nfe_data.data_emissao.isoformat(),
        emitente_nome=nfe_data.emitente_nome,
        emitente_cnpj=nfe_data.emitente_cnpj,
        valor_total=float(nfe_data.valor_total),
        duplicatas=[
            DuplicateResponse(numero=d.numero, vencimento=d.vencimento.isoformat(), valor=float(d.valor))
            for d in nfe_data.get_effective_duplicatas()
        ],
        destinatario_cnpj=nfe_data.destinatario_cnpj,
        destinatario_nome=nfe_data.destinatario_nome,
        meio_pagamento_nfe=nfe_data.meio_pagamento_nfe,
        marcador_caixa=nfe_data.marcador_caixa,
    )


def _category_name(categoria_id: str) -> str:
    cat = CATEGORY_BY_ID.get(categoria_id)
    return cat.nome if cat else CATEGORY_BY_ID[DEFAULT_CATEGORY_ID].nome


def _unique_target_path(dest_dir: Path, original_path: Path) -> Path:
    """Evita sobrescrita se já existir arquivo com o mesmo nome no destino."""
    target = dest_dir / original_path.name
    counter = 1
    while target.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        target = dest_dir / f"{original_path.stem}_{timestamp}_{counter}{original_path.suffix}"
        counter += 1
    return target


def _prepare_for_review(
    nfe_data: NFeData,
    scan_result: ScanResult,
    file_path: Path,
    safe_filename: str
) -> ProcessItemResult:
    """
    Substitui o antigo lançamento direto no Tiny: extrai itens (XML/OCR/fallback),
    sugere uma categoria por item e coloca a nota em `pending_review/` aguardando
    confirmação humana. Não chama a API do Tiny.

    Antes de estagiar, confere se a nota já foi lançada no Tiny (por essa automação
    antes, ou manualmente por alguém do time) — mesma checagem usada na varredura
    SEFAZ (`already_launched_in_tiny`). Sem isso, o upload manual (ex.: contingência)
    podia colocar em revisão algo que já estava resolvido no Tiny.
    """
    if already_launched_in_tiny(nfe_data):
        logger.info(f"Nota {nfe_data.chave} já lançada no Tiny ERP. Ignorando upload (não vai para revisão).")
        return ProcessItemResult(
            filename=safe_filename,
            status="success",
            step="tiny_erp",
            key=scan_result.key,
            scan_method=scan_result.method,
            page_number=scan_result.page_number,
            nfe_data=_nfe_data_to_response(nfe_data),
            itens=[],
            tiny_results=[],
            error_message="Nota já lançada no Tiny ERP — não enviada para revisão, para evitar duplicidade.",
            processed_at=datetime.now().isoformat(),
        )

    record: ReviewRecord = stage_note_for_review(nfe_data, file_path, raw_ocr_text=scan_result.raw_text)

    item_responses = [
        NFeItemResponse(
            item_id=ri.item_id,
            descricao=ri.descricao,
            valor_total=float(ri.valor_total),
            codigo=ri.codigo,
            ncm=ri.ncm,
            quantidade=float(ri.quantidade),
            valor_unitario=float(ri.valor_unitario) if ri.valor_unitario is not None else None,
            categoria_sugerida_id=ri.categoria_sugerida_id,
            categoria_sugerida_nome=_category_name(ri.categoria_sugerida_id),
        )
        for ri in record.itens
    ]

    return ProcessItemResult(
        filename=safe_filename,
        status="success",
        step="pending_review",
        key=scan_result.key,
        scan_method=scan_result.method,
        page_number=scan_result.page_number,
        nfe_data=_nfe_data_to_response(nfe_data),
        itens=item_responses,
        tiny_results=[],
        error_message=None,
        processed_at=datetime.now().isoformat()
    )


def _check_tiny_configured() -> bool:
    token_repo = TokenRepository(settings)
    return bool(
        settings.TINY_CLIENT_ID
        or settings.TINY_API_TOKEN
        or settings.TINY_TOKEN_CACHE_FILE.exists()
        or token_repo.is_configured()
    )


@app.get("/health", response_model=HealthResponse, response_model_exclude_none=True)
@app.get("/api/v1/health", response_model=HealthResponse, response_model_exclude_none=True)
def health_check(request: Request) -> HealthResponse:
    """Status do motor. Público com status mínimo; com a chave interna, inclui os provedores."""
    if not chave_valida(request):
        return HealthResponse(status="ok", timestamp=datetime.now().isoformat())
    settings.ensure_directories()
    tiny_configured = _check_tiny_configured()
    return HealthResponse(
        status="ok",
        version="1.0.0",
        nfe_provider=settings.NFE_PROVIDER,
        ocr_enabled=settings.OCR_ENABLED,
        tiny_configured=tiny_configured,
        timestamp=datetime.now().isoformat()
    )


@app.get("/health/tiny", response_model=ServiceHealthDetail)
@app.get("/api/v1/health/tiny", response_model=ServiceHealthDetail)
def health_tiny() -> ServiceHealthDetail:
    """Retorna o status de saúde e configuração da integração Tiny ERP."""
    settings.ensure_directories()
    tiny_configured = _check_tiny_configured()
    return ServiceHealthDetail(
        service="tiny",
        status="ok" if tiny_configured else "warning",
        connected=tiny_configured,
        message="API v3 e integração fiscal operacional." if tiny_configured else "Credenciais Tiny ERP não configuradas.",
        timestamp=datetime.now().isoformat()
    )


@app.get("/health/inter", response_model=ServiceHealthDetail)
@app.get("/api/v1/health/inter", response_model=ServiceHealthDetail)
def health_inter() -> ServiceHealthDetail:
    """Retorna o status operacional do módulo Banco Inter / DDA."""
    return ServiceHealthDetail(
        service="inter",
        status="ok",
        connected=True,
        message="Módulo DDA e conciliação bancária operacional.",
        timestamp=datetime.now().isoformat()
    )


_UPLOAD_CHUNK = 1024 * 1024


def _paginas_pdf(caminho: Path) -> Optional[int]:
    """Nº de páginas do PDF (pdfinfo/poppler); None se não der para contar."""
    try:
        from pdf2image import pdfinfo_from_path

        kwargs = {"poppler_path": settings.POPPLER_PATH} if settings.POPPLER_PATH else {}
        return int(pdfinfo_from_path(str(caminho), **kwargs).get("Pages") or 0)
    except Exception as e:
        logger.debug(f"Não foi possível contar as páginas de {caminho.name}: {e}")
        return None


async def _salvar_upload_limitado(upload_file: UploadFile, destino: Path) -> Optional[str]:
    """
    Grava o upload em `destino` em blocos, parando ao passar de UPLOAD_MAX_FILE_MB (não lê o
    arquivo inteiro para a memória). PDF com mais de UPLOAD_MAX_PDF_PAGES páginas é recusado
    antes do OCR. Devolve a mensagem de recusa, ou None se o arquivo foi aceito.
    """
    limite = settings.UPLOAD_MAX_FILE_MB * 1024 * 1024
    total = 0
    with open(destino, "wb") as f:
        while True:
            bloco = await upload_file.read(_UPLOAD_CHUNK)
            if not bloco:
                break
            total += len(bloco)
            if total > limite:
                break
            f.write(bloco)
    if total > limite:
        destino.unlink(missing_ok=True)
        return f"Arquivo maior que o limite de {settings.UPLOAD_MAX_FILE_MB} MB."
    if destino.suffix.lower() == ".pdf":
        paginas = _paginas_pdf(destino)
        if paginas is not None and paginas > settings.UPLOAD_MAX_PDF_PAGES:
            destino.unlink(missing_ok=True)
            return f"PDF com {paginas} páginas: o limite é {settings.UPLOAD_MAX_PDF_PAGES} páginas por arquivo."
    return None


@app.post("/api/v1/danfe/process-batch", response_model=BatchProcessResponse)
async def process_batch_files(
    files: List[UploadFile] = File(...)
) -> BatchProcessResponse:
    """
    Recebe um lote de imagens/PDFs de DANFE, executa a extração da chave de 44 dígitos
    (Código de barras ou OCR), consulta os dados fiscais na API da Receita Federal
    e efetua o lançamento de Contas a Pagar no ERP Tiny.
    """
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nenhum arquivo enviado no lote."
        )
    if len(files) > settings.UPLOAD_MAX_FILES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Lote com {len(files)} arquivos: o máximo é {settings.UPLOAD_MAX_FILES} por envio.",
        )

    scanner = DANFEScanner()
    nfe_provider = get_nfe_provider(settings)

    results: List[ProcessItemResult] = []
    total_amount = 0.0

    # Processa cada arquivo em diretório temporário isolado
    with tempfile.TemporaryDirectory() as temp_dir_str:
        temp_dir = Path(temp_dir_str)

        for upload_file in files:
            safe_filename = Path(upload_file.filename or "danfe.pdf").name
            temp_file = temp_dir / safe_filename

            # Salva o arquivo temporário (com teto de tamanho e de páginas: AUT-11)
            try:
                limite_erro = await _salvar_upload_limitado(upload_file, temp_file)
            except Exception as e:
                logger.error(f"Erro ao receber arquivo {safe_filename}: {e}")
                results.append(
                    ProcessItemResult(
                        filename=safe_filename,
                        status="error",
                        step="upload",
                        error_message=f"Falha ao ler o arquivo enviado: {e}",
                        processed_at=datetime.now().isoformat()
                    )
                )
                record_audit_error(
                    details=f"Falha ao ler o arquivo enviado: {e}",
                    original_filename=safe_filename,
                    step="upload",
                    cfg=settings,
                )
                continue
            if limite_erro:
                logger.warning(f"[{safe_filename}] Upload recusado: {limite_erro}")
                results.append(
                    ProcessItemResult(
                        filename=safe_filename,
                        status="error",
                        step="upload",
                        error_message=limite_erro,
                        processed_at=datetime.now().isoformat()
                    )
                )
                continue

            # 1. Extração da Chave de 44 Dígitos
            try:
                scan_result = scanner.scan_file(temp_file)
            except Exception as e:
                # Uma exceção aqui (imagem corrompida, PDF ilegível, etc.) não pode
                # derrubar o lote inteiro: sem este guard, o endpoint retornava HTTP 500
                # descartando os resultados de todos os arquivos já processados no lote.
                err = f"Falha inesperada ao escanear o arquivo: {e}"
                logger.error(f"[{safe_filename}] {err}", exc_info=True)
                results.append(
                    ProcessItemResult(
                        filename=safe_filename,
                        status="error",
                        step="scan",
                        error_message=err,
                        processed_at=datetime.now().isoformat()
                    )
                )
                record_audit_error(
                    details=err,
                    original_filename=safe_filename,
                    step="scan",
                    cfg=settings,
                )
                continue
            if not scan_result or not scan_result.key:
                err = "Chave de acesso não localizada por código de barras nem por OCR."
                logger.warning(f"[{safe_filename}] {err}")
                results.append(
                    ProcessItemResult(
                        filename=safe_filename,
                        status="error",
                        step="scan",
                        error_message=err,
                        processed_at=datetime.now().isoformat()
                    )
                )
                record_audit_error(
                    details=err,
                    original_filename=safe_filename,
                    step="scan",
                    cfg=settings,
                )
                continue

            # 2. Dados fiscais: o XML completo da NF-e já traz tudo (emitente, itens, parcelas).
            # Consultar a SEFAZ só pela chave falhava para notas antigas (cStat 632 "fora de
            # prazo", > 90 dias) — justamente o caso de quem tem o XML em mãos.
            try:
                nfe_data: NFeData = dados_fiscais_do_arquivo(temp_file, scan_result.key, scan_result.method, nfe_provider)
                nfe_data = enrich_nfe_data_from_file_context(nfe_data, temp_file, raw_ocr_text=scan_result.raw_text)
            except Exception as e:
                err = f"Falha na consulta fiscal da chave {scan_result.key}: {e}"
                logger.error(f"[{safe_filename}] {err}")
                results.append(
                    ProcessItemResult(
                        filename=safe_filename,
                        status="error",
                        step="receita_federal",
                        key=scan_result.key,
                        scan_method=scan_result.method,
                        page_number=scan_result.page_number,
                        error_message=err,
                        processed_at=datetime.now().isoformat()
                    )
                )
                record_audit_error(
                    details=err,
                    chave_acesso=scan_result.key,
                    original_filename=safe_filename,
                    metodo_leitura=scan_result.method,
                    step="receita_federal",
                    cfg=settings,
                )
                continue

            # 3. Extração de itens + sugestão de categoria + staging para revisão humana
            # (o lançamento no Tiny NÃO ocorre aqui — só depois de POST /danfe/confirm-lancamento)
            try:
                item_result = _prepare_for_review(nfe_data, scan_result, temp_file, safe_filename)
            except Exception as e:
                err = f"Falha ao preparar a nota para revisão/categorização: {e}"
                logger.error(f"[{safe_filename}] {err}", exc_info=True)
                results.append(
                    ProcessItemResult(
                        filename=safe_filename,
                        status="error",
                        step="tiny_erp",
                        key=scan_result.key,
                        scan_method=scan_result.method,
                        page_number=scan_result.page_number,
                        nfe_data=_nfe_data_to_response(nfe_data),
                        error_message=err,
                        processed_at=datetime.now().isoformat()
                    )
                )
                record_audit_error(
                    details=err,
                    chave_acesso=scan_result.key,
                    original_filename=safe_filename,
                    numero_nota=nfe_data.numero_nota,
                    emitente_nome=nfe_data.emitente_nome,
                    emitente_cnpj=nfe_data.emitente_cnpj,
                    destinatario_nome=nfe_data.destinatario_nome,
                    destinatario_cnpj=nfe_data.destinatario_cnpj,
                    valor_total=float(nfe_data.valor_total),
                    metodo_leitura=scan_result.method,
                    step="tiny_erp",
                    cfg=settings,
                )
                continue

            total_amount += float(nfe_data.valor_total)
            results.append(item_result)

    success_count = sum(1 for r in results if r.status == "success")
    failed_count = sum(1 for r in results if r.status == "error")

    return BatchProcessResponse(
        total=len(results),
        success_count=success_count,
        failed_count=failed_count,
        total_amount=round(total_amount, 2),
        items=results
    )


def _clean_sefaz_scan_errors_from_failed_dir() -> None:
    """
    Remove arquivos legados de auditoria de varredura SEFAZ do FAILED_DIR.
    O FAILED_DIR é exclusivo para NF-es/DANFEs reais com erro de processamento ou lançamento Tiny.
    O status da varredura SEFAZ (inclusive cooldown e cStat 656) é gerido de forma dedicada em sefaz_scan_status.json.
    """
    try:
        for f in settings.FAILED_DIR.glob("*SEFAZ-SCAN*"):
            try:
                f.unlink(missing_ok=True)
            except Exception:
                pass
    except Exception as e:
        logger.debug(f"[AUDIT] Falha ao limpar registros legados de varredura SEFAZ: {e}")


@app.get("/api/v1/danfe/history")
def get_processing_history(limit: int = 100) -> Dict[str, Any]:
    """Retorna o histórico de auditoria das notas processadas e com erro."""
    settings.ensure_directories()
    _clean_sefaz_scan_errors_from_failed_dir()
    items: List[Dict[str, Any]] = []

    # Carrega arquivos de metadados de sucesso
    meta_files = sorted(
        settings.PROCESSED_DIR.glob("*.meta.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True
    )[:limit]

    for mf in meta_files:
        try:
            with open(mf, "r", encoding="utf-8") as f:
                data = json.load(f)
                data["audit_status"] = "success"
                items.append(data)
        except Exception:
            continue

    # Carrega erros (.error.json estruturados e .error.txt legados)
    json_errors = [f for f in settings.FAILED_DIR.glob("*.error.json") if "SEFAZ-SCAN" not in f.name]
    txt_errors = [f for f in settings.FAILED_DIR.glob("*.error.txt") if "SEFAZ-SCAN" not in f.name]
    resolved = load_resolved_failures()
    error_files = sorted(
        json_errors + txt_errors,
        key=lambda p: p.stat().st_mtime,
        reverse=True
    )[:limit]

    for ef in error_files:
        try:
            if ef.name.endswith(".error.json"):
                with open(ef, "r", encoding="utf-8") as f:
                    err_data = json.load(f)
                    err_data.setdefault("audit_status", "error")
                    err_data.setdefault("error_file", ef.name)
                    if "processed_at" not in err_data:
                        err_data["processed_at"] = datetime.fromtimestamp(ef.stat().st_mtime).isoformat()
                    err_data["resolved_at"] = resolved.get(ef.name)
                    items.append(err_data)
            else:
                content = ef.read_text(encoding="utf-8")
                items.append({
                    "audit_status": "error",
                    "error_file": ef.name,
                    "details": content,
                    "processed_at": datetime.fromtimestamp(ef.stat().st_mtime).isoformat(),
                    "resolved_at": resolved.get(ef.name),
                })
        except Exception:
            continue

    # Ordena por data decrescente
    items.sort(key=lambda x: x.get("processed_at", ""), reverse=True)
    return {"total": len(items), "history": items[:limit]}


class ResolveFailureRequest(BaseModel):
    error_file: str


@app.post("/api/v1/danfe/failures/resolve")
def resolve_failure(payload: ResolveFailureRequest) -> Dict[str, str]:
    """Marca uma falha como resolvida manualmente: sai das pendências, mas continua no histórico."""
    resolved_at = mark_failure_resolved(payload.error_file)
    if not resolved_at:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Nenhuma falha encontrada para o arquivo {payload.error_file}.",
        )
    return {"error_file": payload.error_file, "resolved_at": resolved_at}


class SefazCnpjStatus(BaseModel):
    cnpj: str
    novas_notas: int
    duplicadas_ignoradas: int
    canceladas_ignoradas: int
    eventos_ignorados: int
    ja_lancadas_tiny: int = 0
    destinatario_divergente_ignorado: int = 0
    notas_saida_ignoradas: int = 0
    ult_nsu: Optional[str] = None
    status: str  # "ok" | "erro" | "cooldown"
    erro: Optional[str] = None
    cooldown_until: Optional[str] = None
    cooldown_seconds_remaining: int = 0


class CertificadoStatus(BaseModel):
    arquivo: str
    cnpj: Optional[str] = None
    titular: Optional[str] = None
    valido_ate: Optional[str] = None
    dias_restantes: Optional[int] = None
    alerta: bool = False
    erro: Optional[str] = None


class SefazScanStatusResponse(BaseModel):
    last_scan_started_at: Optional[str] = None
    last_scan_finished_at: Optional[str] = None
    next_scan_at: str
    total_novas_notas: int
    pending_review_count: int
    cnpjs: List[SefazCnpjStatus]
    cooldown_seconds_remaining: int = 0
    is_running: bool = False
    certificados: List[CertificadoStatus] = []


def _build_sefaz_status_response() -> SefazScanStatusResponse:
    settings.ensure_directories()
    status_data = get_scan_status()
    return SefazScanStatusResponse(
        last_scan_started_at=status_data.get("last_scan_started_at"),
        last_scan_finished_at=status_data.get("last_scan_finished_at"),
        next_scan_at=next_scan_at(),
        total_novas_notas=status_data.get("total_novas_notas", 0),
        pending_review_count=len(list_pending()),
        cnpjs=[SefazCnpjStatus(**c) for c in status_data.get("cnpjs", [])],
        cooldown_seconds_remaining=scan_cooldown_remaining_seconds(),
        is_running=status_data.get("is_running", False) or is_scan_running(),
        certificados=[CertificadoStatus(**c) for c in _safe_certificates_status()],
    )


def _safe_certificates_status() -> List[Dict[str, Any]]:
    # Informativo: nunca deixa o status da varredura cair por causa da leitura do certificado.
    try:
        return get_certificates_status()
    except Exception as e:
        logger.warning(f"Falha ao inspecionar certificados A1: {e}")
        return []


@app.get("/api/v1/danfe/sefaz-status", response_model=SefazScanStatusResponse)
def get_sefaz_status() -> SefazScanStatusResponse:
    """Retorna o status da varredura direta na SEFAZ: última execução, CNPJs monitorados e próximo horário agendado."""
    return _build_sefaz_status_response()


@app.post("/api/v1/danfe/scan-sefaz", response_model=SefazScanStatusResponse)
def trigger_sefaz_scan(
    background_tasks: BackgroundTasks,
    force: bool = False,
) -> SefazScanStatusResponse:
    """
    Dispara a varredura direta na SEFAZ de forma não-bloqueante (evita timeout HTTP 504):
    consulta a distribuição por NSU dos CNPJs elegíveis em segundo plano e retorna
    imediatamente com o status inicial.
    """
    if is_scan_running():
        return _build_sefaz_status_response()

    remaining = scan_cooldown_remaining_seconds()
    if remaining > 0 and not force:
        mins = max(1, math.ceil(remaining / 60))
        raise HTTPException(
            status_code=429,
            detail=(
                "Varredura em cooldown para evitar bloqueio da SEFAZ (cStat 656 - Consumo "
                f"Indevido). Tente novamente em {mins} min."
            ),
        )

    # Executa a varredura em background para devolver a resposta HTTP imediatamente ao navegador/proxy
    background_tasks.add_task(run_daily_scan, force=force)
    return _build_sefaz_status_response()


@app.get("/api/v1/danfe/sefaz-nsu")
def get_sefaz_nsu_state() -> Dict[str, Any]:
    """Auditoria de diagnóstico: retorna checkpoints de NSU e cooldowns por CNPJ."""
    settings.ensure_directories()
    return {
        "nsu_state": load_nsu_state(settings),
        "cooldown_state": load_cooldown_state(settings),
        "status": get_scan_status(settings),
    }


class SefazResetRequest(BaseModel):
    cnpj: Optional[str] = None
    clear_cooldown: bool = True
    set_nsu: Optional[str] = None


@app.post("/api/v1/danfe/sefaz-nsu/reset")
def reset_sefaz_state(req: SefazResetRequest) -> Dict[str, Any]:
    """Administrativo: permite resetar cooldown ou ajustar o NSU de um CNPJ travado."""
    settings.ensure_directories()
    if req.cnpj is not None:
        req.cnpj = re.sub(r"\D", "", req.cnpj)
        if len(req.cnpj) != 14:
            raise HTTPException(status_code=422, detail="CNPJ inválido: informe os 14 dígitos.")
    if req.set_nsu is not None:
        try:
            req.set_nsu = validar_nsu(req.set_nsu)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        if not req.cnpj:
            raise HTTPException(status_code=422, detail="Informe o CNPJ para ajustar o NSU.")
    if req.clear_cooldown:
        clear_cnpj_cooldown(req.cnpj, settings)
    if req.set_nsu and req.cnpj:
        save_nsu_checkpoint(req.cnpj, req.set_nsu, settings)
    return {
        "ok": True,
        "nsu_state": load_nsu_state(settings),
        "cooldown_state": load_cooldown_state(settings),
    }


class ImportKeyRequest(BaseModel):
    chave: str


@app.post("/api/v1/danfe/import-key")
def import_nfe_by_key(req: ImportKeyRequest) -> Dict[str, Any]:
    """Importa uma NF-e diretamente da SEFAZ pela chave de acesso de 44 dígitos."""
    settings.ensure_directories()
    raw_key = re.sub(r"\D", "", req.chave)
    if len(raw_key) != 44:
        raise HTTPException(
            status_code=400,
            detail=f"Chave de acesso inválida. Deve conter exatamente 44 dígitos (encontrados {len(raw_key)}).",
        )

    nfe_provider = get_nfe_provider(settings)
    try:
        nfe_data = nfe_provider.get_nfe_data(raw_key)
    except Exception as e:
        logger.error(f"[IMPORT_KEY] Falha ao consultar chave {raw_key}: {e}")
        if "632" in str(e):
            # Limite da própria SEFAZ (distribuição por chave só até 90 dias da emissão).
            raise HTTPException(
                status_code=422,
                detail=(
                    "A SEFAZ não entrega mais esta nota pela chave: ela tem mais de 90 dias "
                    "(cStat 632). Baixe o XML com o fornecedor, no marketplace ou num site de "
                    "consulta de NF-e e envie no Upload Manual, logo abaixo."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Falha ao consultar a chave na SEFAZ: {e}",
        )

    safe_filename = f"{raw_key}.xml"
    virtual_file = settings.INPUT_DIR / safe_filename
    if not virtual_file.exists():
        try:
            virtual_file.write_text(f"<!-- Chave {raw_key} importada via consulta direta SEFAZ -->", encoding="utf-8")
        except Exception:
            pass

    scan_result = ScanResult(
        key=raw_key,
        method="manual_key",
        file_path=virtual_file,
        page_number=1,
        raw_text=f"Chave manual {raw_key}",
    )

    try:
        item_res = _prepare_for_review(nfe_data, scan_result, virtual_file, safe_filename)
        return {
            "status": "success",
            "message": f"NF-e {nfe_data.numero_nota} ({nfe_data.emitente_nome}) pronta para conferência.",
            "chave": raw_key,
            "numero_nota": nfe_data.numero_nota,
            "emitente_nome": nfe_data.emitente_nome,
            "valor_total": float(nfe_data.valor_total),
            "result": item_res.dict() if hasattr(item_res, "dict") else item_res.__dict__,
        }
    except Exception as e:
        logger.error(f"[IMPORT_KEY] Erro ao estagiar nota {raw_key}: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Falha ao estagiar a nota para revisão: {e}",
        )


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


@app.get("/api/v1/financial-dashboard/status", response_model=FinancialDashboardStatusResponse)
def get_financial_dashboard_status() -> FinancialDashboardStatusResponse:
    """Status da sincronização do Dashboard Financeiro: última execução, empresas e próximo horário agendado."""
    settings.ensure_directories()
    return FinancialDashboardStatusResponse(**get_sync_status())


@app.post("/api/v1/financial-dashboard/sync", response_model=FinancialDashboardStatusResponse)
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


@app.get("/api/v1/financial-dashboard")
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


def _finalize_confirmed(
    record: ReviewRecord,
    grupo_responses: List["GroupedLancamentoResponse"],
    forma_pagamento: str,
    parcelas: int = 1,
) -> None:
    """Move a nota confirmada de pending_review/ para processed/ e grava a auditoria do lançamento."""
    settings.ensure_directories()
    dest_path = _unique_target_path(settings.PROCESSED_DIR, record.file_path)
    shutil.move(str(record.file_path), str(dest_path))

    meta_path = dest_path.with_suffix(dest_path.suffix + ".meta.json")
    metadata = {
        "processed_at": datetime.now().isoformat(),
        "original_filename": record.filename,
        "chave_acesso": record.chave,
        "numero_nota": record.nfe_data.numero_nota,
        "emitente": {
            "razao_social": record.nfe_data.emitente_nome,
            "cnpj": record.nfe_data.emitente_cnpj
        },
        "destinatario": {
            "razao_social": record.nfe_data.destinatario_nome,
            "cnpj": record.nfe_data.destinatario_cnpj,
        },
        "forma_pagamento": forma_pagamento,
        "marcador_empresa": record.nfe_data.marcador_empresa,
        "marcador_pagamento": record.nfe_data.marcador_caixa,
        "meio_pagamento_nfe": record.nfe_data.meio_pagamento_nfe,
        "valor_total": float(record.nfe_data.valor_total),
        "parcelas": parcelas,
        "categorias": [
            {
                "categoria_id": g.categoria_id,
                "categoria_nome": g.categoria_nome,
                "valor": g.valor_total,
                "item_ids": g.item_ids,
                "parcela": g.parcela,
            }
            for g in grupo_responses
        ],
        "lancamentos_tiny": [
            {
                "conta_id": g.tiny_result.conta_id,
                "nro_documento": g.tiny_result.nro_documento,
                "valor": g.tiny_result.valor,
                "vencimento": g.tiny_result.vencimento,
                "situacao": g.tiny_result.situacao,
                "is_duplicate": g.tiny_result.is_duplicate
            }
            for g in grupo_responses if g.tiny_result
        ]
    }

    try:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.warning(f"Não foi possível salvar arquivo de metadados: {e}")

    # Preserva o .review.json (itens, categorias efetivamente usadas) ao lado do
    # arquivo em processed/, para que "Lançados no Tiny" continue mostrando o
    # detalhe completo da nota, não só o resumo de auditoria do .meta.json.
    record.file_path = dest_path
    write_record_json(record)

    remove_pending(record.chave)


@app.get("/api/v1/tiny/categories", response_model=List[TinyCategoryResponse])
def get_tiny_categories(
    cnpj: Optional[str] = None,
    account_id: Optional[str] = None,
) -> List[TinyCategoryResponse]:
    """
    Retorna as categorias oficiais de receita/despesa do Tiny ERP.
    Se cnpj ou account_id forem informados e a conta possuir token v3 ativo,
    consulta dinamicamente as categorias reais daquela empresa no Tiny ERP.
    Caso contrário, retorna o catálogo oficial de referência (TINY_CATEGORIES).
    """
    if cnpj or account_id:
        try:
            tiny_client = TinyClient()
            token, _resolved_acc = tiny_client.resolve_token_for_cnpj(cnpj=cnpj, account_id=account_id)
            if token and is_v3_token(token):
                account_cats = tiny_client.list_categorias_receita_despesa_v3(token)
                if account_cats:
                    return [
                        TinyCategoryResponse(
                            id=str(c["id"]),
                            nome=c.get("descricao", ""),
                            grupo=c.get("grupo") or "Despesas",
                            label=f"{c.get('grupo', 'Despesas')} → {c.get('descricao', '')}",
                        )
                        for c in account_cats
                        if c.get("id") and c.get("descricao")
                    ]
        except Exception as e:
            logger.warning(f"Falha ao consultar categorias dinâmicas do Tiny para cnpj={cnpj}: {e}")

    return [TinyCategoryResponse(id=c.id, nome=c.nome, grupo=c.grupo, label=c.label) for c in TINY_CATEGORIES]


def _record_to_dict(record: ReviewRecord, history: Optional[CategoryHistoryIndex] = None) -> Dict[str, Any]:
    """
    Com `history` (só para notas pendentes), a sugestão de categoria de cada item passa a
    vir das notas anteriores do mesmo fornecedor quando houver — ver category_history.py.
    `categoria_sugerida_origem` diz de onde veio ("historico" ou "regra").
    """

    def sugestao(ri: ReviewItem) -> Tuple[str, str]:
        if history is not None:
            cat = history.suggest(record.nfe_data.destinatario_cnpj, record.nfe_data.emitente_cnpj, ri)
            if cat:
                return cat, "historico"
        return ri.categoria_sugerida_id, "regra"

    return {
        "chave": record.chave,
        "filename": record.filename,
        "staged_at": record.staged_at,
        "nfe_data": _nfe_data_to_response(record.nfe_data).model_dump(),
        "itens": [
            {
                "item_id": ri.item_id,
                "descricao": ri.descricao,
                "valor_total": float(ri.valor_total),
                "codigo": ri.codigo,
                "ncm": ri.ncm,
                "quantidade": float(ri.quantidade),
                "valor_unitario": float(ri.valor_unitario) if ri.valor_unitario is not None else None,
                "categoria_sugerida_id": cat_id,
                "categoria_sugerida_nome": _category_name(cat_id),
                "categoria_sugerida_origem": origem,
            }
            for ri in record.itens
            for cat_id, origem in [sugestao(ri)]
        ],
    }


@app.get("/api/v1/danfe/pending-review")
def get_pending_review_endpoint() -> Dict[str, Any]:
    """Lista as notas aguardando revisão/categorização humana antes do lançamento no Tiny."""
    settings.ensure_directories()
    history = get_category_history(settings.PROCESSED_DIR)
    items = [_record_to_dict(record, history) for record in list_pending()]
    return {"total": len(items), "pending": items}


_NOTAS_LOADERS = {
    "pending": list_pending,
    "confirmed": list_confirmed,
    "archived": list_archived,
}


@app.get("/api/v1/danfe/notas")
def get_notas_endpoint(status_filter: Literal["pending", "confirmed", "archived"] = "pending") -> Dict[str, Any]:
    """
    Lista notas por status: `pending` (aguardando revisão), `confirmed` (já lançadas no
    Tiny) ou `archived` (arquivadas pelo usuário, sem deletar). Combina com os filtros de
    empresa/emitente/período aplicados no frontend sobre a lista retornada.
    """
    settings.ensure_directories()
    history = get_category_history(settings.PROCESSED_DIR) if status_filter == "pending" else None
    items = [_record_to_dict(record, history) for record in _NOTAS_LOADERS[status_filter]()]
    return {"total": len(items), "status": status_filter, "notas": items}


@app.post("/api/v1/danfe/archive")
def archive_nota(payload: ChaveRequest) -> Dict[str, str]:
    """Arquiva uma nota pendente de revisão: some da revisão, sem apagar dados; pode ser restaurada depois."""
    record = archive_pending(payload.chave)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Nenhuma nota pendente de revisão encontrada para a chave {payload.chave}.",
        )
    return {"chave": record.chave, "status": "archived"}


@app.post("/api/v1/danfe/restore")
def restore_nota(payload: ChaveRequest) -> Dict[str, str]:
    """Restaura uma nota arquivada de volta para a revisão pendente."""
    record = restore_archived(payload.chave)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Nenhuma nota arquivada encontrada para a chave {payload.chave}.",
        )
    return {"chave": record.chave, "status": "pending"}


@app.post("/api/v1/danfe/confirm-lancamento", response_model=ConfirmLancamentoResponse)
def confirm_lancamento(payload: ConfirmLancamentoRequest) -> ConfirmLancamentoResponse:
    """
    Confirma a categorização humana de uma nota em revisão e efetua o lançamento
    agrupado por categoria no Tiny ERP. Só a partir daqui a API do Tiny é chamada.
    Idempotente em caso de falha parcial: como o número do documento de cada grupo
    é determinístico, reenviar após um erro parcial não duplica os grupos já lançados
    (`check_duplicate_conta_v3` os identifica e retorna 'duplicada').
    """
    record = get_pending(payload.chave)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Nenhuma nota pendente de revisão encontrada para a chave {payload.chave}."
        )

    if payload.forma_pagamento not in PAYMENT_METHOD_MARCADOR:
        raise HTTPException(
            status_code=422,
            detail=f"Forma de pagamento '{payload.forma_pagamento}' inválida.",
        )
    if payload.meio_pagamento_nfe and payload.meio_pagamento_nfe not in PAYMENT_METHOD_NFE_LABELS:
        raise HTTPException(
            status_code=422,
            detail=f"Meio de pagamento da NFe '{payload.meio_pagamento_nfe}' inválido.",
        )

    # Marcador de pagamento (Clara/Caixa Visa/Caixa Visa Norvia/Caixa Elo) ou nenhum
    # (Pix/Boleto não usam marcador no Tiny). O marcador de empresa continua sendo
    # resolvido automaticamente pelo TinyClient a partir do destinatário da nota.
    record.nfe_data.marcador_caixa = PAYMENT_METHOD_MARCADOR[payload.forma_pagamento]
    if payload.meio_pagamento_nfe:
        record.nfe_data.meio_pagamento_nfe = payload.meio_pagamento_nfe

    # Pix é pago no dia da emissão da nota, independente das duplicatas extraídas do XML.
    # Boleto usa o vencimento já presente na nota (comportamento padrão, sem override).
    if payload.forma_pagamento == "pix":
        record.nfe_data.duplicatas = [
            NFeDuplicate(
                numero="001",
                vencimento=record.nfe_data.data_emissao,
                valor=record.nfe_data.valor_total,
            )
        ]

    categoria_escolhida = {ci.item_id: ci.categoria_id for ci in payload.itens}
    for ri in record.itens:
        if ri.item_id in categoria_escolhida:
            ri.categoria_sugerida_id = categoria_escolhida[ri.item_id]

    categorized_items = [
        CategorizedItem(
            item=NFeItem(
                item_id=ri.item_id,
                descricao=ri.descricao,
                valor_total=ri.valor_total,
                codigo=ri.codigo,
                ncm=ri.ncm,
                quantidade=ri.quantidade,
                valor_unitario=ri.valor_unitario,
            ),
            categoria_id=categoria_escolhida.get(ri.item_id) or ri.categoria_sugerida_id or DEFAULT_CATEGORY_ID,
        )
        for ri in record.itens
    ]

    grupos: List[GroupedLancamento] = group_items_by_category(categorized_items, record.nfe_data.valor_total)
    if not grupos:
        raise HTTPException(status_code=422, detail="Nenhum item categorizado para lançar.")

    tiny_client = TinyClient()
    grupo_responses: List[GroupedLancamentoResponse] = []
    all_success = True

    lancamentos = [
        (idx, grupo, parcela, valor)
        for idx, grupo in enumerate(grupos, start=1)
        for parcela, valor in enumerate(dividir_em_parcelas(grupo.valor_total, payload.parcelas), start=1)
    ]
    for idx, grupo, parcela, valor in lancamentos:
        base_resposta = dict(
            categoria_id=grupo.categoria_id,
            categoria_nome=grupo.categoria_nome,
            valor_total=float(valor),
            item_ids=grupo.item_ids,
            parcela=parcela,
            total_parcelas=payload.parcelas,
        )
        try:
            result = tiny_client.lancar_grupo_categorizado(
                record.nfe_data, grupo, idx, len(grupos),
                parcela=parcela, total_parcelas=payload.parcelas, valor_parcela=valor,
            )
            grupo_responses.append(GroupedLancamentoResponse(
                **base_resposta,
                tiny_result=TinyContaResponse(
                    conta_id=result.conta_id,
                    nro_documento=result.nro_documento,
                    valor=float(result.valor),
                    vencimento=result.vencimento.isoformat(),
                    situacao=result.situacao,
                    is_duplicate=result.is_duplicate,
                ),
                status="success",
            ))
        except Exception as e:
            all_success = False
            logger.error(
                f"[{record.chave}] Falha ao lançar grupo '{grupo.categoria_nome}' "
                f"(parcela {parcela}/{payload.parcelas}): {e}",
                exc_info=True,
            )
            grupo_responses.append(GroupedLancamentoResponse(
                **base_resposta,
                tiny_result=None,
                status="error",
                error_message=str(e),
            ))

    if all_success:
        record.last_error = None
        record.last_error_at = None
        _finalize_confirmed(record, grupo_responses, payload.forma_pagamento, payload.parcelas)
        return ConfirmLancamentoResponse(chave=record.chave, status="success", grupos=grupo_responses)

    failed_groups = [g for g in grupo_responses if g.status == "error"]
    err_msgs = "; ".join([
        f"{g.categoria_nome}{f' (parcela {g.parcela}/{g.total_parcelas})' if g.total_parcelas > 1 else ''}: {g.error_message}"
        for g in failed_groups
    ]) or "Falha ao lançar no Tiny ERP"
    record.last_error = err_msgs
    record.last_error_at = datetime.now().isoformat()
    try:
        write_record_json(record)
    except Exception as e_save:
        logger.warning(f"Falha ao persistir erro em {record.chave}.review.json: {e_save}")

    record_audit_error(
        details=f"Falha ao lançar no Tiny ERP: {err_msgs}",
        chave_acesso=record.chave,
        original_filename=record.filename,
        numero_nota=record.nfe_data.numero_nota,
        emitente_nome=record.nfe_data.emitente_nome,
        emitente_cnpj=record.nfe_data.emitente_cnpj,
        destinatario_nome=record.nfe_data.destinatario_nome,
        destinatario_cnpj=record.nfe_data.destinatario_cnpj,
        valor_total=float(record.nfe_data.valor_total),
        metodo_leitura=getattr(record.nfe_data, "metodo_leitura", None) or "xml_sefaz",
        step="tiny_erp",
        cfg=settings,
    )

    return ConfirmLancamentoResponse(chave=record.chave, status="partial_error", grupos=grupo_responses)


# =============================================================================
# CONCILIAÇÃO BANCÁRIA: BANCO INTER × CONTAS A PAGAR TINY ERP
# =============================================================================

class ReconciliacaoPreviewRequest(BaseModel):
    empresa: Optional[str] = "todas"
    data_inicio: Optional[str] = None
    data_fim: Optional[str] = None
    tolerance_days: int = 60
    # True = ignora o cache e consulta Inter/Tiny de novo (botão "Comparar"/"Atualizar").
    forcar_atualizacao: bool = False


class BaixaItemRequest(BaseModel):
    """
    O que o cliente escolhe: QUAL casamento da prévia baixar (empresa + conta + débito do Inter).
    valor_pago, data_pagamento, juros, multa, desconto e conta_origem_id continuam aceitos por
    compatibilidade com a tela, mas são IGNORADOS: a baixa usa os valores do extrato guardados
    na prévia do servidor (AUT-02). `historico` é só texto (até 200 caracteres).
    """
    empresa: str
    conta_pagar_id: int
    inter_transacao_id: Optional[str] = None
    valor_pago: Optional[float] = None
    data_pagamento: Optional[str] = None
    juros: float = 0.0
    multa: float = 0.0
    desconto: float = 0.0
    historico: Optional[str] = None
    conta_origem_id: Optional[int] = None


class ReconciliacaoBaixarRequest(BaseModel):
    itens: List[BaixaItemRequest]


@app.get("/api/v1/reconciliacao/status")
def get_reconciliacao_status():
    """Retorna o status de configuração do Banco Inter e do Tiny ERP para cada filial."""
    token_repo = TokenRepository(settings)
    inter_client = InterClient(certs_dir=settings.INTER_CERTS_DIR, base_url=settings.INTER_BASE_URL)

    empresas_status = []
    for emp_id, emp_label in EMPRESA_LABELS.items():
        creds = INTER_EMPRESAS.get(emp_id, {})
        cnpj = creds.get("cnpj")

        # Verifica Tiny
        tiny_ok = False
        if token_repo.is_configured():
            t_res = token_repo.get_token_by_cnpj_or_account(cnpj=cnpj, account_id=emp_id)
            tiny_ok = bool(t_res and t_res[0])
        if not tiny_ok and settings.TINY_API_TOKEN:
            tiny_ok = True

        # Verifica Inter com detalhamento de saúde
        inter_diag = inter_client.check_credentials_status(emp_id)
        inter_ok = (inter_diag.get("status") == "conectado")

        empresas_status.append({
            "id": emp_id,
            "nome": emp_label,
            "cnpj": cnpj,
            "inter_configurado": inter_ok,
            "inter_status": inter_diag.get("status"),
            "inter_mensagem": inter_diag.get("mensagem"),
            "tiny_configurado": tiny_ok,
        })

    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "empresas": empresas_status,
    }


def _inter_tx_json(itx: InterTransacao) -> Dict[str, Any]:
    return {
        "empresa": itx.empresa,
        "empresa_nome": EMPRESA_LABELS.get(itx.empresa, itx.empresa.title()),
        "transacao_id": itx.transacao_id,
        "data_pagamento": itx.data_pagamento.isoformat(),
        "valor_pago": float(itx.valor_pago),
        "tipo_transacao": itx.tipo_transacao,
        "titulo": itx.titulo,
        "descricao": itx.descricao,
        "nome_favorecido": itx.nome_favorecido,
        "cpf_cnpj_favorecido": itx.cpf_cnpj_favorecido,
        "codigo_barras": itx.codigo_barras,
    }


# =============================================================================
# Cache dos dados de origem da conciliação (por filial e período)
# =============================================================================
# Buscar é o caro: extrato do Inter + 3 listagens paginadas do Tiny por filial, com throttle de
# 2s por página (minutos). Cruzar é barato. Por isso o cache guarda os dados brutos de cada
# filial: abrir a página de novo, trocar "Todas" por uma filial (ou o contrário) ou filtrar
# texto não consulta Inter/Tiny outra vez. Consulta com falha não é guardada. A baixa descarta
# o cache das filiais que tiveram conta baixada; "Comparar" força uma consulta nova.
# Em memória: a API roda num único processo uvicorn (app/main.py).

RECONCILIACAO_CACHE_TTL_SECONDS = 15 * 60


@dataclass
class _DadosEmpresa:
    inter_txs: List[InterTransacao]
    tiny_pendentes: List[Dict[str, Any]]
    tiny_pagas: List[Dict[str, Any]]
    avisos: List[str]
    buscado_em: float
    falhou: bool


_dados_cache: Dict[Tuple[str, date, date, int], _DadosEmpresa] = {}
_dados_cache_lock = threading.Lock()


def invalidar_cache_conciliacao(empresas: Optional[List[str]] = None) -> None:
    """Descarta os dados em cache das filiais dadas (todas, se None)."""
    with _dados_cache_lock:
        for chave in [k for k in _dados_cache if empresas is None or k[0] in empresas]:
            del _dados_cache[chave]


def marcar_baixadas_no_cache(baixadas: List[Tuple[str, int]]) -> None:
    """
    Depois de uma baixa com sucesso, move as contas de "em aberto" para "pagas" nos dados em
    cache da filial, em vez de descartar tudo: a prévia seguinte fica instantânea e a conta
    passa a aparecer como já baixada, como apareceria consultando o Tiny de novo.
    """
    por_empresa: Dict[str, set] = {}
    for emp, conta_id in baixadas:
        por_empresa.setdefault(emp, set()).add(int(conta_id))
    with _dados_cache_lock:
        for (emp, *_), dados in _dados_cache.items():
            ids = por_empresa.get(emp)
            if not ids:
                continue
            movidas = [c for c in dados.tiny_pendentes if int(c.get("id") or 0) in ids]
            if not movidas:
                continue
            dados.tiny_pendentes = [c for c in dados.tiny_pendentes if int(c.get("id") or 0) not in ids]
            dados.tiny_pagas = dados.tiny_pagas + [{**c, "situacao": "pago"} for c in movidas]


def _periodo_preview(payload: "ReconciliacaoPreviewRequest") -> Tuple[date, date]:
    hoje = date.today()
    try:
        dt_inicio = date.fromisoformat(payload.data_inicio) if payload.data_inicio else hoje - timedelta(days=30)
    except Exception:
        dt_inicio = hoje - timedelta(days=30)
    try:
        dt_fim = date.fromisoformat(payload.data_fim) if payload.data_fim else hoje
    except Exception:
        dt_fim = hoje
    return dt_inicio, dt_fim


def _empresas_preview(payload: "ReconciliacaoPreviewRequest") -> List[str]:
    alvo = (payload.empresa or "todas").lower().strip()
    if alvo == "todas":
        return list(EMPRESA_LABELS.keys())
    if alvo in EMPRESA_LABELS:
        return [alvo]
    raise HTTPException(
        status_code=400,
        detail=f"Empresa '{payload.empresa}' inválida. Escolha entre: {', '.join(EMPRESA_LABELS.keys())} ou 'todas'.",
    )


def _cache_valido(chave: Tuple[str, date, date, int]) -> Optional[_DadosEmpresa]:
    with _dados_cache_lock:
        dados = _dados_cache.get(chave)
        if dados and time.time() - dados.buscado_em < RECONCILIACAO_CACHE_TTL_SECONDS:
            return dados
        _dados_cache.pop(chave, None)
        return None


def _preview_todo_em_cache(payload: "ReconciliacaoPreviewRequest") -> bool:
    if payload.forcar_atualizacao:
        return False
    dt_inicio, dt_fim = _periodo_preview(payload)
    tolerance_days = payload.tolerance_days or 60
    return all(_cache_valido((emp, dt_inicio, dt_fim, tolerance_days)) for emp in _empresas_preview(payload))


def _dados_empresa(
    emp: str,
    dt_inicio: date,
    dt_fim: date,
    tolerance_days: int,
    forcar: bool = False,
    progresso: Optional[Callable[[str], None]] = None,
) -> Tuple[_DadosEmpresa, bool]:
    """Extrato do Inter + contas do Tiny de uma filial, do cache quando possível. Retorna (dados, do_cache)."""
    chave = (emp, dt_inicio, dt_fim, tolerance_days)
    if not forcar:
        em_cache = _cache_valido(chave)
        if em_cache:
            return em_cache, True

    emp_label = EMPRESA_LABELS.get(emp, emp.title())
    emp_cnpj = INTER_EMPRESAS.get(emp, {}).get("cnpj")
    inter_client = InterClient(certs_dir=settings.INTER_CERTS_DIR, base_url=settings.INTER_BASE_URL)
    tiny_client = TinyClient()
    token_repo = TokenRepository(settings)

    pendentes: List[Dict[str, Any]] = []
    pagas: List[Dict[str, Any]] = []
    avisos: List[str] = []
    falhou = False

    # Janela de vencimento mais larga que a do extrato: pagamentos do período quitam contas
    # vencidas antes dele (em atraso) ou que só vencem depois (pagas adiantadas).
    venc_inicio = dt_inicio - timedelta(days=tolerance_days)
    venc_fim = dt_fim + timedelta(days=30)

    # 1. Extrato do Inter — em paralelo com o Tiny (APIs independentes).
    def _extrato_inter() -> Tuple[List[InterTransacao], List[str], bool]:
        if progresso:
            progresso(f"{emp_label}: extrato do Banco Inter")
        inter_diag = inter_client.check_credentials_status(emp)
        if inter_diag.get("status") != "conectado":
            # Sem conexão o extrato falharia com o mesmo erro; um aviso por empresa basta.
            return [], [f"{emp_label} (Inter): {inter_diag.get('mensagem')}"], True
        try:
            txs = inter_client.get_extrato(emp, dt_inicio, dt_fim, allow_demo=False)
            logger.info(f"[RECONCILIACAO] {emp_label}: {len(txs)} débito(s) no extrato do Inter.")
            if not txs:
                return txs, [f"{emp_label}: o extrato não trouxe nenhum débito no período — confira as datas."], False
            return txs, [], False
        except Exception as e_inter:
            msg = f"{emp_label}: Falha ao consultar extrato no Banco Inter: {e_inter}"
            logger.warning(f"[RECONCILIACAO] {msg}")
            return [], [msg], True

    inter_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"inter-{emp}")
    inter_futuro = inter_pool.submit(_extrato_inter)
    inter_pool.shutdown(wait=False)

    # 2. Contas a pagar no Tiny
    tiny_token = None
    if token_repo.is_configured():
        res = token_repo.get_token_by_cnpj_or_account(cnpj=emp_cnpj, account_id=emp)
        if res:
            tiny_token = res[0]
    if not tiny_token:
        tiny_token = settings.TINY_API_TOKEN or "mock"

    if progresso:
        progresso(f"{emp_label}: contas a pagar no Tiny")
    if not tiny_token or tiny_token in ("mock", "seu_token_aqui"):
        # Sem token a filial vinha com "0 contas no Tiny" e nenhum aviso.
        avisos.append(f"{emp_label}: token do Tiny não encontrado (api_tokens) — contas do Tiny não consultadas.")
        falhou = True
    else:
        try:
            # "aberto" no Tiny v3 NÃO inclui as vencidas ("atrasadas"): sem elas, uma conta paga
            # no vencimento e não baixada vira atrasada no dia seguinte e o débito aparece
            # como "sem par". A API não aceita duas situações na mesma chamada.
            pendentes_por_id: Dict[int, Dict[str, Any]] = {}
            for situacao in ("aberto", "atrasadas"):
                for c in tiny_client.list_contas_pagar_v3(
                    token=tiny_token,
                    situacao=situacao,
                    data_inicial_vencimento=venc_inicio.isoformat(),
                    data_final_vencimento=venc_fim.isoformat(),
                    estrito=True,
                ):
                    c["empresa"] = emp
                    pendentes_por_id[int(c["id"])] = c
            pendentes = list(pendentes_por_id.values())
        except Exception as e_tiny:
            msg = f"{emp_label}: Falha ao consultar contas no Tiny: {e_tiny}"
            logger.warning(f"[RECONCILIACAO] {msg}")
            avisos.append(msg)
            falhou = True

        try:
            # Contas pagas só casam com vencimento a até JA_BAIXADAS_TOLERANCIA_DIAS do
            # pagamento (fora o código de barras): janela curta, porque cada página do Tiny
            # custa 2s de throttle e filiais grandes têm milhares de contas pagas.
            for c in tiny_client.list_contas_pagar_v3(
                token=tiny_token,
                situacao="pago",
                data_inicial_vencimento=(dt_inicio - timedelta(days=JA_BAIXADAS_TOLERANCIA_DIAS)).isoformat(),
                data_final_vencimento=(dt_fim + timedelta(days=JA_BAIXADAS_TOLERANCIA_DIAS)).isoformat(),
                estrito=True,
            ):
                c["empresa"] = emp
                pagas.append(c)
        except Exception as e_tiny:
            msg = f"{emp_label}: Falha ao consultar contas já pagas no Tiny (débitos já baixados podem aparecer sem par): {e_tiny}"
            logger.warning(f"[RECONCILIACAO] {msg}")
            avisos.append(msg)
            falhou = True

    inter_txs, avisos_inter, falhou_inter = inter_futuro.result()
    avisos = avisos_inter + avisos
    falhou = falhou or falhou_inter

    dados = _DadosEmpresa(inter_txs, pendentes, pagas, avisos, time.time(), falhou)
    if not falhou:
        with _dados_cache_lock:
            _dados_cache[chave] = dados
    return dados, False


@app.get("/api/v1/reconciliacao/estado")
def obter_estado_reconciliacao():
    """Retorna o estado persistido das pendências de Contas a Pagar (Inter × Tiny)."""
    return store_contas_pagar.carregar()


@app.post("/api/v1/reconciliacao/preview")
def preview_reconciliacao(payload: ReconciliacaoPreviewRequest):
    """Versão síncrona (testes/uso interno). A tela usa POST /reconciliacao/jobs/preview."""
    return _run_preview(payload)


def _run_preview(payload: ReconciliacaoPreviewRequest, progresso: Optional["_Progresso"] = None):
    """
    Executa o cruzamento entre o extrato do Banco Inter e as contas em aberto do Tiny.
    Retorna uma lista estruturada de casamentos e itens pendentes para revisão humana.
    """
    target_empresa = (payload.empresa or "todas").lower().strip()
    empresas = _empresas_preview(payload)
    dt_inicio, dt_fim = _periodo_preview(payload)

    tolerance_days = payload.tolerance_days or 60

    all_inter_txs: List[InterTransacao] = []
    all_tiny_contas: List[Dict[str, Any]] = []
    all_tiny_pagas: List[Dict[str, Any]] = []
    avisos: List[str] = []
    buscados_em: List[float] = []
    todos_do_cache = True

    # Filiais em paralelo: cada uma tem sua conta no Tiny (limite e throttle próprios, ver
    # _throttle_tiny_dashboard_call) e seu certificado no Inter. Em sequência, a prévia de
    # "todas" somava a espera de todas as filiais.
    concluidas = [0]
    concluidas_lock = threading.Lock()

    def _buscar(emp: str) -> Tuple[_DadosEmpresa, bool]:
        def _etapa(etapa: str) -> None:
            if progresso:
                with concluidas_lock:
                    feitas = concluidas[0]
                progresso(etapa, feitas, len(empresas))

        try:
            return _dados_empresa(
                emp, dt_inicio, dt_fim, tolerance_days,
                forcar=payload.forcar_atualizacao,
                progresso=_etapa if progresso else None,
            )
        finally:
            with concluidas_lock:
                concluidas[0] += 1

    with ThreadPoolExecutor(max_workers=max(1, len(empresas)), thread_name_prefix="preview-filial") as pool:
        por_empresa = list(pool.map(_buscar, empresas))

    for dados, do_cache in por_empresa:
        todos_do_cache = todos_do_cache and do_cache
        buscados_em.append(dados.buscado_em)
        all_inter_txs.extend(dados.inter_txs)
        all_tiny_contas.extend(dados.tiny_pendentes)
        all_tiny_pagas.extend(dados.tiny_pagas)
        avisos.extend(dados.avisos)

    if progresso:
        progresso("Cruzando extrato e contas", len(empresas), len(empresas))

    # 3. Cruzamento completo com as contas em aberto (transferências entre empresas do grupo
    # entram também: se houver conta lançada no Tiny para elas, precisam ser baixadas)
    res = match_transactions(
        empresa=target_empresa,
        inter_transacoes=all_inter_txs,
        tiny_contas=all_tiny_contas,
        tolerance_days=tolerance_days,
    )

    # Transferência interna casada só por "valor único no período" é coincidência provável
    # (ex.: R$ 32.000 para a Revesta x uma conta qualquer de R$ 32.000): desfaz.
    inter_por_id = {itx.transacao_id: itx for itx in all_inter_txs}
    conta_por_id = {int(c["id"]): c for c in all_tiny_contas if c.get("id")}
    all_matches = []
    for m in res.matches:
        if m.metodo_match == MatchMethod.VALOR_DATA_UNICO and destino_transferencia_interna(inter_por_id[m.inter_transacao_id]):
            if m.conta_pagar_id in conta_por_id:
                res.unmatched_tiny.append(conta_por_id[m.conta_pagar_id])
            continue
        all_matches.append(m)
    casados = {m.inter_transacao_id for m in all_matches}
    sem_conta_aberta = [itx for itx in all_inter_txs if itx.transacao_id not in casados]

    # 4. Débitos sem conta em aberto que correspondem a contas já pagas no Tiny
    ja_baixadas, restantes = match_transactions_ja_baixadas(
        empresa=target_empresa,
        inter_transacoes=sem_conta_aberta,
        tiny_contas_pagas=all_tiny_pagas,
        tolerance_days=JA_BAIXADAS_TOLERANCIA_DIAS,
    )

    # 5. Transferências entre empresas do grupo ficam na aba própria, já conciliadas: casadas
    # com conta em aberto (aptas para baixa ali mesmo), casadas com conta já paga, ou sem conta.
    def _eh_transferencia(inter_id: str) -> bool:
        return destino_transferencia_interna(inter_por_id[inter_id]) is not None

    transf_casadas = {m.inter_transacao_id: m for m in all_matches if _eh_transferencia(m.inter_transacao_id)}
    transf_ja_baixadas = {m.inter_transacao_id: m for m in ja_baixadas if _eh_transferencia(m.inter_transacao_id)}
    all_matches = [m for m in all_matches if m.inter_transacao_id not in transf_casadas]
    ja_baixadas = [m for m in ja_baixadas if m.inter_transacao_id not in transf_ja_baixadas]
    all_unmatched_inter, transf_sem_conta = split_transferencias_internas(restantes)
    transferencias_internas = [
        (itx, destino, transf_casadas.get(itx.transacao_id), transf_ja_baixadas.get(itx.transacao_id))
        for itx in all_inter_txs
        if (destino := destino_transferencia_interna(itx))
    ]
    # Contas vencidas antes do período só entram para o cruzamento; na lista de pendências
    # ficam as do período, como antes.
    all_unmatched_tiny = [
        c for c in res.unmatched_tiny
        if (venc := _parse_date(c.get("dataVencimento") or c.get("vencimento"))) is None
        or dt_inicio <= venc <= dt_fim
    ]

    total_casados = len(all_matches)
    valor_total_casados = sum((m.valor_pago for m in all_matches), Decimal("0.00"))
    total_inter_sem_par = len(all_unmatched_inter)
    valor_inter_sem_par = sum((t.valor_pago for t in all_unmatched_inter), Decimal("0.00"))
    total_tiny_sem_par = len(all_unmatched_tiny)
    valor_tiny_sem_par = sum((_to_decimal(c.get("valor") or c.get("saldo")) for c in all_unmatched_tiny), Decimal("0.00"))

    def _match_json(m) -> Dict[str, Any]:
        return {
            "id": m.id,
            "empresa": m.empresa,
            "empresa_nome": m.empresa_nome,
            "conta_pagar_id": m.conta_pagar_id,
            "numero_documento": m.numero_documento,
            "fornecedor_nome": m.fornecedor_nome,
            "fornecedor_cnpj": m.fornecedor_cnpj,
            "data_vencimento": m.data_vencimento.isoformat(),
            "valor_tiny": float(m.valor_tiny),
            "inter_transacao_id": m.inter_transacao_id,
            "tipo_transacao_inter": m.tipo_transacao_inter,
            "data_pagamento": m.data_pagamento.isoformat(),
            "valor_pago": float(m.valor_pago),
            "valor_original_inter": float(m.valor_original_inter) if m.valor_original_inter else None,
            "juros": float(m.juros),
            "multa": float(m.multa),
            "desconto": float(m.desconto),
            "codigo_barras": m.codigo_barras,
            "metodo_match": m.metodo_match.value,
            "confianca": m.confianca,
            "motivo": m.motivo,
            "status_tiny": m.status_tiny,
            "historico_sugerido": m.historico_sugerido,
        }

    def _ja_baixada_json(m) -> Dict[str, Any]:
        return {
            "empresa": m.empresa,
            "empresa_nome": m.empresa_nome,
            "inter_transacao_id": m.inter_transacao_id,
            "data_pagamento": m.data_pagamento.isoformat(),
            "valor_pago": float(m.valor_pago),
            "tipo_transacao": m.tipo_transacao_inter,
            "nome_favorecido": inter_por_id[m.inter_transacao_id].nome_favorecido,
            "cpf_cnpj_favorecido": inter_por_id[m.inter_transacao_id].cpf_cnpj_favorecido,
            "conta_pagar_id": m.conta_pagar_id,
            "numero_documento": m.numero_documento,
            "fornecedor_nome": m.fornecedor_nome,
            "data_vencimento": m.data_vencimento.isoformat(),
            "valor_tiny": float(m.valor_tiny),
            "metodo_match": m.metodo_match.value,
            "confianca": m.confianca,
            "motivo": m.motivo,
        }

    matches_json = [_match_json(m) for m in all_matches]
    unmatched_inter_json = [_inter_tx_json(itx) for itx in all_unmatched_inter]
    ja_baixadas_json = [_ja_baixada_json(m) for m in ja_baixadas]
    transferencias_json = [
        {
            **_inter_tx_json(itx),
            "empresa_destino_nome": destino,
            "situacao": "apta_baixa" if casada else ("ja_baixada" if ja_baixada else "sem_conta"),
            "conciliacao": _match_json(casada) if casada else None,
            "conta_ja_baixada": _ja_baixada_json(ja_baixada) if ja_baixada else None,
        }
        for itx, destino, casada, ja_baixada in transferencias_internas
    ]
    transferencias_aptas = [casada for _, _, casada, _ in transferencias_internas if casada]
    # O que a baixa vai aceitar depois (AUT-02): só estes pares conta × débito, com estes valores.
    _registrar_aptos(all_matches + transferencias_aptas)

    unmatched_tiny_json = []
    for c in all_unmatched_tiny:
        c_emp = str(c.get("empresa") or target_empresa).lower()
        unmatched_tiny_json.append({
            "id": int(c.get("id") or 0),
            "empresa": c_emp,
            "empresa_nome": EMPRESA_LABELS.get(c_emp, c_emp.title()),
            "numero_documento": str(c.get("numeroDocumento") or c.get("documento") or c.get("id") or "-"),
            "fornecedor_nome": _extract_supplier_name_from_tiny(c),
            "fornecedor_cnpj": _extract_cnpj_from_tiny(c),
            "data_vencimento": str(c.get("dataVencimento") or c.get("vencimento") or "").split("T")[0],
            "valor": float(_to_decimal(c.get("valor") or c.get("saldo"))),
            "historico": str(c.get("historico") or ""),
        })

    resultado_preview = {
        "status": "ok",
        "data_inicio": dt_inicio.isoformat(),
        "data_fim": dt_fim.isoformat(),
        # Momento da consulta mais antiga ao Inter/Tiny entre as filiais (dados em cache ficam
        # até RECONCILIACAO_CACHE_TTL_SECONDS); do_cache = nenhuma filial foi consultada agora.
        "dados_de": datetime.fromtimestamp(min(buscados_em)).astimezone().isoformat() if buscados_em else datetime.now().astimezone().isoformat(),
        "do_cache": todos_do_cache,
        "summary": {
            "total_casados": total_casados,
            "valor_total_casados": float(valor_total_casados),
            "total_inter_sem_par": total_inter_sem_par,
            "valor_inter_sem_par": float(valor_inter_sem_par),
            "total_tiny_sem_par": total_tiny_sem_par,
            "valor_tiny_sem_par": float(valor_tiny_sem_par),
            "total_ja_baixadas": len(ja_baixadas),
            "valor_ja_baixadas": float(sum((m.valor_pago for m in ja_baixadas), Decimal("0.00"))),
            "total_transferencias_internas": len(transferencias_internas),
            "valor_transferencias_internas": float(sum((t.valor_pago for t, _, _, _ in transferencias_internas), Decimal("0.00"))),
            "total_transferencias_aptas": len(transferencias_aptas),
            "valor_transferencias_aptas": float(sum((m.valor_pago for m in transferencias_aptas), Decimal("0.00"))),
        },
        "matches": matches_json,
        "unmatched_inter": unmatched_inter_json,
        "unmatched_tiny": unmatched_tiny_json,
        "ja_baixadas": ja_baixadas_json,
        "transferencias_internas": transferencias_json,
        "avisos": avisos,
    }
    try:
        store_contas_pagar.mesclar_preview(
            resultado_preview,
            tipo_execucao="preview_manual" if progresso else "preview_sincrono",
            sucesso=True,
            mensagem="Prévia executada com sucesso.",
        )
    except Exception as e_mesclar:
        logger.warning(f"[CONTAS_PAGAR_ROTINA] Erro ao mesclar prévia no estado persistente: {e_mesclar}")

    return resultado_preview


# =============================================================================
# Baixa: só o que a prévia do servidor deu como apto (AUT-02) e sem repetir (AUT-03)
# =============================================================================
# O cliente escolhe QUAIS casamentos baixar (empresa + conta_pagar_id + inter_transacao_id);
# valor, data, juros, multa, desconto e conta de origem vêm do extrato do Inter guardado na
# prévia, nunca do corpo da requisição. Antes de baixar, a conta é relida no Tiny (tem de
# estar em aberto e com o valor da prévia). Cada débito do Inter baixa uma conta só: o registro
# persistente das baixas feitas impede reaproveitar o mesmo débito, e a trava por
# (empresa, conta) impede duas baixas simultâneas da mesma conta.

APTOS_BAIXA_TTL_SECONDS = 3600  # igual ao TTL das tarefas: prévia de mais de 1h exige "Comparar" de novo
REGISTRO_BAIXAS_MAX = 20000
_TOLERANCIA_VALOR = Decimal("0.05")  # mesma tolerância do cruzamento por valor (reconciliation.py)


@dataclass
class _AptoBaixa:
    empresa: str
    conta_pagar_id: int
    inter_transacao_id: str
    valor_pago: Decimal
    data_pagamento: date
    juros: Decimal
    multa: Decimal
    desconto: Decimal
    valor_tiny: Decimal
    historico_sugerido: str
    registrado_em: float


_aptos_baixa: Dict[Tuple[str, int, str], _AptoBaixa] = {}
_aptos_lock = threading.Lock()
_baixas_em_andamento: set = set()  # {(empresa, conta_pagar_id)}
_baixas_em_andamento_lock = threading.Lock()
_registro_baixas_lock = threading.Lock()


def _registrar_aptos(casamentos: List[Any]) -> None:
    """Guarda os casamentos aptos de uma prévia (contas casadas + transferências aptas)."""
    agora_ts = time.time()
    with _aptos_lock:
        for chave in [k for k, a in _aptos_baixa.items() if agora_ts - a.registrado_em >= APTOS_BAIXA_TTL_SECONDS]:
            del _aptos_baixa[chave]
        for m in casamentos:
            chave = (str(m.empresa), int(m.conta_pagar_id), str(m.inter_transacao_id))
            _aptos_baixa[chave] = _AptoBaixa(
                empresa=str(m.empresa),
                conta_pagar_id=int(m.conta_pagar_id),
                inter_transacao_id=str(m.inter_transacao_id),
                valor_pago=Decimal(m.valor_pago),
                data_pagamento=m.data_pagamento,
                juros=Decimal(m.juros or 0),
                multa=Decimal(m.multa or 0),
                desconto=Decimal(m.desconto or 0),
                valor_tiny=Decimal(m.valor_tiny),
                historico_sugerido=str(m.historico_sugerido or ""),
                registrado_em=agora_ts,
            )


def _apto_para(empresa: str, conta_pagar_id: int, inter_transacao_id: str) -> Optional[_AptoBaixa]:
    with _aptos_lock:
        apto = _aptos_baixa.get((empresa, int(conta_pagar_id), inter_transacao_id))
        if apto and time.time() - apto.registrado_em < APTOS_BAIXA_TTL_SECONDS:
            return apto
        return None


def limpar_aptos_baixa() -> None:
    with _aptos_lock:
        _aptos_baixa.clear()


def _arquivo_registro_baixas() -> Path:
    return settings.DATA_DIR / "reconciliacao_inter_baixas.json"


def _ler_registro_baixas() -> Dict[str, Any]:
    try:
        with open(_arquivo_registro_baixas(), "r", encoding="utf-8") as f:
            dados = json.load(f)
        if isinstance(dados, dict) and isinstance(dados.get("transacoes"), dict):
            return dados
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.error(f"[RECONCILIACAO_BAIXA] Registro de baixas ilegível ({_arquivo_registro_baixas()}): {e}")
        raise RuntimeError("Registro de baixas ilegível: baixa suspensa para não repetir pagamentos. Veja os logs.")
    return {"transacoes": {}}


def _baixa_registrada(inter_transacao_id: str) -> Optional[Dict[str, Any]]:
    with _registro_baixas_lock:
        return _ler_registro_baixas()["transacoes"].get(inter_transacao_id)


def _registrar_baixa_feita(apto: _AptoBaixa, usuario: str) -> None:
    with _registro_baixas_lock:
        dados = _ler_registro_baixas()
        transacoes: Dict[str, Any] = dados["transacoes"]
        transacoes[apto.inter_transacao_id] = {
            "empresa": apto.empresa,
            "conta_pagar_id": apto.conta_pagar_id,
            "valor_pago": float(apto.valor_pago),
            "data_pagamento": apto.data_pagamento.isoformat(),
            "baixado_em": datetime.now().isoformat(timespec="seconds"),
            "usuario": usuario,
        }
        if len(transacoes) > REGISTRO_BAIXAS_MAX:
            for chave in list(transacoes)[: len(transacoes) - REGISTRO_BAIXAS_MAX]:
                del transacoes[chave]
        save_json_state(_arquivo_registro_baixas(), dados, "RECONCILIACAO_BAIXA")


def _reservar_baixas(payload: "ReconciliacaoBaixarRequest") -> set:
    """Trava (empresa, conta) do pedido; 409 se alguma já está numa baixa em andamento."""
    chaves = {(i.empresa, int(i.conta_pagar_id)) for i in payload.itens}
    with _baixas_em_andamento_lock:
        conflito = sorted(chaves & _baixas_em_andamento)
        if conflito:
            contas = ", ".join(f"#{cid} ({EMPRESA_LABELS.get(emp, emp)})" for emp, cid in conflito)
            raise HTTPException(status_code=409, detail=f"Já existe uma baixa em andamento para a(s) conta(s) {contas}. Aguarde terminar.")
        _baixas_em_andamento.update(chaves)
    return chaves


def _liberar_baixas(chaves: set) -> None:
    with _baixas_em_andamento_lock:
        _baixas_em_andamento.difference_update(chaves)


def _num_conta(valor: Any) -> Optional[Decimal]:
    try:
        return None if valor is None or valor == "" else Decimal(str(valor))
    except Exception:
        return None


def _conferir_conta_para_baixa(conta: Dict[str, Any], apto: _AptoBaixa) -> Optional[str]:
    """Motivo para NÃO baixar a conta relida no Tiny (None = pode baixar)."""
    cid = apto.conta_pagar_id
    situacao = str(conta.get("situacao") or "").strip().lower()
    if situacao not in SITUACOES_CONTA_PAGAR_BAIXAVEIS:
        return f"Conta #{cid} já não está em aberto no Tiny (situação '{situacao or 'desconhecida'}'): não baixada."
    valor = _num_conta(conta.get("valor"))
    if valor is not None and abs(valor - apto.valor_tiny) > _TOLERANCIA_VALOR:
        return (
            f"Valor da conta #{cid} mudou no Tiny desde a comparação (R$ {apto.valor_tiny:.2f} → R$ {valor:.2f}): "
            "não baixada. Compare de novo."
        )
    em_aberto = _num_conta(conta.get("saldo"))
    if em_aberto is None and valor is not None:
        em_aberto = valor - (_num_conta(conta.get("valorPago")) or Decimal("0"))
    principal = apto.valor_pago - apto.juros - apto.multa + apto.desconto
    if em_aberto is not None and principal - em_aberto > _TOLERANCIA_VALOR:
        return (
            f"Pagamento de R$ {principal:.2f} (sem juros/multa/desconto) é maior que o saldo em aberto da conta #{cid} "
            f"(R$ {em_aberto:.2f}): não baixada. Confira no Tiny."
        )
    return None


@app.post("/api/v1/reconciliacao/baixar")
def executar_baixa_reconciliacao(payload: ReconciliacaoBaixarRequest, request: Request):
    """Versão síncrona (testes/uso interno). A tela usa POST /reconciliacao/jobs/baixar."""
    if not payload.itens:
        raise HTTPException(status_code=400, detail="Nenhum item informado para baixa.")
    usuario = usuario_da_requisicao(request)
    chaves = _reservar_baixas(payload)
    try:
        return _run_baixa(payload, usuario=usuario)
    finally:
        _liberar_baixas(chaves)


def _resultado(item: "BaixaItemRequest", status_item: str, mensagem: str, apto: Optional[_AptoBaixa] = None) -> Dict[str, Any]:
    res: Dict[str, Any] = {
        "conta_pagar_id": item.conta_pagar_id,
        "empresa": item.empresa,
        "inter_transacao_id": item.inter_transacao_id,
        "status": status_item,
        "mensagem": mensagem,
    }
    if apto is not None:
        # Valores efetivamente usados (do extrato guardado na prévia), para o histórico do gateway.
        res.update(
            valor_pago=float(apto.valor_pago),
            data_pagamento=apto.data_pagamento.isoformat(),
            juros=float(apto.juros),
            multa=float(apto.multa),
            desconto=float(apto.desconto),
        )
    return res


def _run_baixa(payload: ReconciliacaoBaixarRequest, progresso: Optional["_Progresso"] = None, usuario: str = ""):
    """
    Executa a baixa no Tiny ERP das contas selecionadas e confirmadas pelo usuário.
    Gera relatório detalhado de sucesso/erro por conta. Quem chama já reservou as contas
    (_reservar_baixas).
    """
    if not payload.itens:
        raise HTTPException(status_code=400, detail="Nenhum item informado para baixa.")

    token_repo = TokenRepository(settings)
    tiny_client = TinyClient()

    resultados = []
    sucessos = 0
    falhas = 0
    vistos_contas: set = set()
    vistos_transacoes: set = set()
    if usuario:
        logger.info(f"[RECONCILIACAO_BAIXA] Baixa de {len(payload.itens)} conta(s) solicitada por {usuario}.")

    for idx_item, item in enumerate(payload.itens):
        emp = item.empresa
        cid = item.conta_pagar_id
        itx_id = (item.inter_transacao_id or "").strip()
        if progresso:
            progresso(f"Baixando conta #{cid} ({EMPRESA_LABELS.get(emp, emp)})", idx_item, len(payload.itens))

        def _falha(mensagem: str, apto: Optional[_AptoBaixa] = None) -> None:
            nonlocal falhas
            resultados.append(_resultado(item, "erro", mensagem, apto))
            falhas += 1

        if not itx_id:
            _falha(f"Conta #{cid} NÃO foi baixada: falta o débito do Inter (inter_transacao_id). Compare de novo e selecione.")
            continue
        if (emp, cid) in vistos_contas or itx_id in vistos_transacoes:
            _falha(f"Conta #{cid} NÃO foi baixada: repetida no mesmo pedido (conta ou débito do Inter já incluídos).")
            continue
        vistos_contas.add((emp, cid))
        vistos_transacoes.add(itx_id)

        apto = _apto_para(emp, cid, itx_id)
        if apto is None:
            _falha(
                f"Conta #{cid} NÃO foi baixada: não consta como apta com este débito do Inter na última comparação "
                "(ou a comparação expirou). Clique em Comparar e selecione de novo."
            )
            continue

        try:
            ja_feita = _baixa_registrada(itx_id)
        except RuntimeError as e:
            _falha(str(e), apto)
            continue
        if ja_feita:
            _falha(
                f"Débito do Inter já usado na baixa da conta #{ja_feita.get('conta_pagar_id')} em "
                f"{ja_feita.get('baixado_em')}: conta #{cid} NÃO foi baixada de novo.",
                apto,
            )
            continue

        tiny_token = None
        if token_repo.is_configured():
            res = token_repo.get_token_by_cnpj_or_account(account_id=emp)
            if res:
                tiny_token = res[0]
        if not tiny_token:
            tiny_token = settings.TINY_API_TOKEN or "mock"

        if tiny_token in ("mock", "seu_token_aqui"):
            # Antes isto respondia "baixada com sucesso (Simulado)" sem tocar no Tiny — em produção,
            # com o token da filial ausente, o usuário via sucesso e a conta continuava em aberto.
            logger.error(f"[RECONCILIACAO_BAIXA] Conta #{cid} ({emp}) não baixada: token do Tiny não configurado.")
            _falha(f"Token do Tiny não configurado para '{emp}': conta #{cid} NÃO foi baixada.", apto)
            continue

        try:
            try:
                conta_atual, tiny_token = tiny_client.obter_conta_pagar_v3(token=tiny_token, conta_id=cid)
            except Exception as e_ler:
                raise RuntimeError(f"Conta #{cid} NÃO foi baixada: não foi possível relê-la no Tiny ({e_ler}).")
            motivo = _conferir_conta_para_baixa(conta_atual, apto)
            if motivo:
                logger.warning(f"[RECONCILIACAO_BAIXA] {motivo}")
                _falha(motivo, apto)
                continue

            # Conta de origem sempre resolvida aqui (a "Banco Inter" da filial), nunca do cliente.
            conta_origem_id = tiny_client.resolve_conta_origem_inter(token=tiny_token, account_id=emp)
            if not conta_origem_id:
                # Sem contaOrigem o Tiny baixa na conta padrão dele, que pode ser qualquer uma.
                raise RuntimeError(
                    f"Conta 'Banco Inter' de {EMPRESA_LABELS.get(emp, emp)} não encontrada no Tiny "
                    f"(ou há mais de uma): conta #{cid} NÃO foi baixada."
                )

            historico = (item.historico or "").strip()[:200] or apto.historico_sugerido or f"Baixa conciliada Banco Inter {itx_id}"
            tiny_client.baixar_conta_pagar_v3(
                token=tiny_token,
                conta_id=cid,
                valor_pago=float(apto.valor_pago),
                data_pagamento=apto.data_pagamento.isoformat(),
                conta_origem_id=conta_origem_id,
                juros=float(apto.juros),
                multa=float(apto.multa),
                desconto=float(apto.desconto),
                historico=historico,
                conta_atual=conta_atual,
            )
            try:
                _registrar_baixa_feita(apto, usuario)
            except Exception as e_reg:  # a baixa entrou; só o registro local falhou
                logger.error(f"[RECONCILIACAO_BAIXA] Conta #{cid} baixada, mas o registro local falhou: {e_reg}")
            logger.info(
                f"[RECONCILIACAO_BAIXA] Conta #{cid} ({emp}) baixada: R$ {apto.valor_pago:.2f} em "
                f"{apto.data_pagamento.isoformat()} (débito {itx_id}){f' por {usuario}' if usuario else ''}."
            )
            resultados.append(_resultado(item, "sucesso", f"Conta #{cid} baixada com sucesso no Tiny ERP.", apto))
            sucessos += 1
        except Exception as e:
            logger.error(f"[RECONCILIACAO_BAIXA] Falha ao baixar conta #{cid} ({emp}): {e}")
            _falha(str(e), apto)

    # As contas baixadas mudaram de situação no Tiny: atualiza o cache sem consultar tudo de novo.
    baixadas = [(r["empresa"], r["conta_pagar_id"]) for r in resultados if r["status"] == "sucesso"]
    if baixadas:
        marcar_baixadas_no_cache(baixadas)
        try:
            itens_remover = [
                {
                    "empresa": r["empresa"],
                    "conta_pagar_id": r["conta_pagar_id"],
                    "numero_documento": r.get("numero_documento"),
                    "valor_pago": r.get("valor_pago"),
                }
                for r in resultados
                if r["status"] == "sucesso"
            ]
            store_contas_pagar.remover_contas_baixadas(itens_remover, motivo="automacao")
        except Exception as e_rem:
            logger.warning(f"[CONTAS_PAGAR_ROTINA] Erro ao remover baixas do estado persistente: {e_rem}")

    return {
        "status": "concluido" if falhas == 0 else ("parcial" if sucessos > 0 else "erro"),
        "total_solicitados": len(payload.itens),
        "total_sucessos": sucessos,
        "total_falhas": falhas,
        "resultados": resultados,
    }


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


@app.post("/api/v1/reconciliacao/jobs/preview")
def iniciar_job_preview(payload: ReconciliacaoPreviewRequest) -> Dict[str, Any]:
    return _iniciar_job(
        "preview",
        lambda progresso: _run_preview(payload, progresso),
        sincrono=_preview_todo_em_cache(payload),
    )


@app.post("/api/v1/reconciliacao/jobs/baixar")
def iniciar_job_baixa(payload: ReconciliacaoBaixarRequest, request: Request) -> Dict[str, Any]:
    if not payload.itens:
        raise HTTPException(status_code=400, detail="Nenhum item informado para baixa.")
    usuario = usuario_da_requisicao(request)
    chaves = _reservar_baixas(payload)  # 409 se outra baixa em andamento já pegou alguma destas contas

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            return _run_baixa(payload, progresso, usuario=usuario)
        finally:
            _liberar_baixas(chaves)

    try:
        return _iniciar_job("baixar", executar)
    except Exception:
        _liberar_baixas(chaves)
        raise


def _consultar_job(job_id: str, conciliacao_ml: bool) -> Dict[str, Any]:
    """Cada conciliação só enxerga as próprias tarefas (SEC-04): no gateway elas têm permissões
    diferentes (accounts_payable × ml_reconciliation), então a fila compartilhada não pode vazar
    o resultado de uma pela rota da outra."""
    with _reconciliacao_jobs_lock:
        job = _reconciliacao_jobs.get(job_id)
        if not job or str(job.get("tipo", "")).startswith("ml_") != conciliacao_ml:
            raise HTTPException(status_code=404, detail="Tarefa não encontrada (expirada ou a API foi reiniciada).")
        return _job_publico(job)


@app.get("/api/v1/reconciliacao/jobs/{job_id}")
def consultar_job(job_id: str) -> Dict[str, Any]:
    return _consultar_job(job_id, conciliacao_ml=False)

# =============================================================================
# CONCILIAÇÃO MERCADO LIVRE × CONTAS A RECEBER TINY ERP
# =============================================================================
# Vendas (API do Mercado Livre) × liberações (relatório do Mercado Pago) × Contas a Receber do
# Tiny. Regras em app/ml_reconciliation.py; coleta, histórico e baixa em
# app/ml_reconciliation_rotina.py. Roda sozinha 1x/dia (ML_RECONCILIATION_HOUR) e sob demanda;
# as duas tarefas usam a fila de tarefas da conciliação Inter, mas são consultadas só por
# /conciliacao-ml/jobs/{id}. A baixa é sempre confirmada pelo usuário.


class MLExecutarRequest(BaseModel):
    empresas: Optional[List[str]] = None
    de: Optional[date] = None
    ate: Optional[date] = None


class MLBaixarRequest(BaseModel):
    analise_id: str
    grupos: List[str]
    usuario: Optional[str] = None


def _ml_analise_ou_404(analise_id: str) -> ml.Analise:
    analise = ml_rotina.estado.analise(analise_id)
    if analise is None:
        raise HTTPException(status_code=404, detail="Análise não encontrada (removida pela retenção ou inexistente).")
    return analise


@app.get("/api/v1/conciliacao-ml/status")
def ml_status() -> Dict[str, Any]:
    return ml_rotina.status()


@app.post("/api/v1/conciliacao-ml/executar")
def ml_executar(payload: MLExecutarRequest) -> Dict[str, Any]:
    """Executa agora (fora do horário diário). Sem período: as liberações de ontem."""
    if ml_rotina.em_execucao:
        raise HTTPException(status_code=409, detail="Já existe uma conciliação Mercado Livre em andamento. Aguarde terminar.")
    de, ate = payload.de, payload.ate
    if (de is None) != (ate is None):
        raise HTTPException(status_code=400, detail="Informe a data inicial e a final, ou nenhuma (ontem).")
    if de is None or ate is None:
        de, ate = ml_periodo_padrao()
    try:
        ml_validar_periodo(de, ate)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    empresas = payload.empresas or None
    if empresas and any(e not in ml.EMPRESAS_ML for e in empresas):
        raise HTTPException(status_code=400, detail="Empresa sem conciliação Mercado Livre.")

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            execucao = ml_rotina.executar("manual", empresas, de, ate, progresso=progresso)
        except MLEmExecucao as e:
            raise HTTPException(status_code=409, detail=str(e))
        return ml_resumo_execucao(execucao)

    return _iniciar_job("ml_executar", executar)


@app.get("/api/v1/conciliacao-ml/execucoes")
def ml_execucoes(limit: int = 30, tipo: str = "") -> Dict[str, Any]:
    execucoes = [e for e in reversed(ml_rotina.estado.ler()["execucoes"]) if not tipo or e.get("tipo", "analise") == tipo]
    return {"itens": [ml_resumo_execucao(e) for e in execucoes[: max(1, min(limit, 200))]], "total": len(execucoes)}


@app.get("/api/v1/conciliacao-ml/execucoes/{execucao_id}")
def ml_execucao(execucao_id: str) -> Dict[str, Any]:
    for e in ml_rotina.estado.ler()["execucoes"]:
        if e.get("id") == execucao_id:
            return e
    raise HTTPException(status_code=404, detail="Execução não encontrada.")


@app.get("/api/v1/conciliacao-ml/analises")
def ml_analises(empresa: str = "", limit: int = 30) -> Dict[str, Any]:
    todas = ml_rotina.estado.ler()["analises"]
    filtradas = [a for a in todas if not empresa or a.get("empresa") == empresa]
    consolidadas = [a for a in filtradas if a.get("analise_id", "").startswith("consolidado_")]
    normais = [a for a in reversed(filtradas) if not a.get("analise_id", "").startswith("consolidado_")]
    ordenadas = consolidadas + normais
    return {"itens": ordenadas[: max(1, min(limit, 200))], "total": len(ordenadas)}


@app.get("/api/v1/conciliacao-ml/analises/{analise_id}")
def ml_consultar_analise(analise_id: str) -> Dict[str, Any]:
    return ml.analise_json(_ml_analise_ou_404(analise_id))


@app.get("/api/v1/conciliacao-ml/analises/{analise_id}/arquivos/{tipo}")
def ml_baixar_arquivo(analise_id: str, tipo: str, incluir_exportados: bool = False) -> Response:
    analise = _ml_analise_ou_404(analise_id)
    if tipo not in ml.TIPOS_ARQUIVO:
        raise HTTPException(status_code=404, detail=f"Arquivo '{tipo}' inexistente. Use: {', '.join(ml.TIPOS_ARQUIVO)}.")
    headers = {}
    excluir = None
    if tipo == "lancamentos":
        # ML-5: lançamento que já saiu numa planilha fica de fora (evita importar duas vezes no
        # Tiny). `incluir_exportados=true` gera tudo de novo (ex.: a importação anterior falhou).
        chaves = [ml.chave_lancamento(l) for l in analise.lancamentos.lancamentos]
        exportados = ml_rotina.estado.lancamentos_exportados()
        ja = [c for c in chaves if c in exportados]
        novos = chaves if incluir_exportados else [c for c in chaves if c not in exportados]
        if not incluir_exportados and chaves and not novos:
            raise HTTPException(
                status_code=409,
                detail=f"Os {len(chaves)} lançamento(s) desta análise já foram exportados em planilha anterior. "
                "Baixe de novo só se a importação no Tiny falhou.",
            )
        excluir = None if incluir_exportados else set(exportados)
        headers = {"X-Lancamentos-Total": str(len(chaves)), "X-Lancamentos-Ja-Exportados": str(len(ja)),
                   "X-Lancamentos-Na-Planilha": str(len(novos))}
    nome, conteudo = ml.gerar_arquivo(analise, tipo, excluir_lancamentos=excluir)
    if tipo == "lancamentos":
        ml_rotina.estado.registrar_exportados(novos)
    return Response(
        content=conteudo,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(nome)}", **headers},
    )


@app.post("/api/v1/conciliacao-ml/jobs/baixar")
def ml_iniciar_baixa(payload: MLBaixarRequest, request: Request) -> Dict[str, Any]:
    if not payload.grupos:
        raise HTTPException(status_code=400, detail="Nenhum recebimento selecionado para baixa.")
    analise = _ml_analise_ou_404(payload.analise_id)
    if ml_token_tiny(analise.empresa_id) is None:
        raise HTTPException(status_code=409, detail=f"Token do Tiny não configurado para {analise.empresa_nome}: baixa indisponível.")

    # Autor da auditoria: X-Usuario do gateway (sessão); o `usuario` do corpo só sem o header.
    usuario = usuario_da_requisicao(request, payload.usuario)

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            return ml_rotina.baixar(payload.analise_id, payload.grupos, usuario=usuario, progresso=progresso)
        except MLEmExecucao as e:
            raise HTTPException(status_code=409, detail=str(e))

    return _iniciar_job("ml_baixar", executar)


@app.get("/api/v1/conciliacao-ml/jobs/{job_id}")
def ml_consultar_job(job_id: str) -> Dict[str, Any]:
    return _consultar_job(job_id, conciliacao_ml=True)


@app.get("/api/v1/conciliacao-ml/avisos")
def ml_avisos(depois_de: int = 0) -> Dict[str, Any]:
    """Avisos novos para o gateway notificar (permissão conciliacao_ml:ver)."""
    dados = ml_rotina.estado.ler()
    itens = [a for a in dados["avisos"] if int(a["id"]) > depois_de]
    return {"itens": itens, "ultimo_id": int(dados.get("proximo_aviso") or 1) - 1}


_ML_TOKENS_SYNC_LAST_TS: float = 0.0
_ML_TOKENS_SYNC_COOLDOWN_SEGUNDOS: float = 60.0


@app.post("/api/v1/conciliacao-ml/tokens/sincronizar")
def ml_sincronizar_tokens(request: Request) -> Any:
    """Força sincronização imediata dos tokens do Mercado Livre via TMS / OAuth."""
    global _ML_TOKENS_SYNC_LAST_TS
    agora = time.time()
    decorrido = agora - _ML_TOKENS_SYNC_LAST_TS
    if decorrido < _ML_TOKENS_SYNC_COOLDOWN_SEGUNDOS:
        restante = int(math.ceil(_ML_TOKENS_SYNC_COOLDOWN_SEGUNDOS - decorrido))
        raise HTTPException(
            status_code=429,
            detail=f"Aguarde {restante} segundos antes de solicitar uma nova sincronização de tokens.",
        )

    _ML_TOKENS_SYNC_LAST_TS = agora

    if settings.MOCK_MODE:
        return {
            "ok": True,
            "mock": True,
            "contas": {
                "norvia": {"conectado": True, "renovado": True},
                "revesta": {"conectado": True, "renovado": True},
            },
            "tokens_atualizados": ["norvia", "revesta"],
        }

    try:
        tokens_obtidos = sincronizar_todos_tokens_ml(settings, forcar=True) or {}

        # Ler dados do disco diretamente para checar validade com token_esta_valido
        # SEM chamar token_ml (que dispararia novas renovações ou trataria token vencido como válido)
        tokens_disco: Dict[str, Any] = {}
        for arq in _candidatos_ml_tokens_files(settings):
            if arq.is_file():
                try:
                    d = json.loads(arq.read_text(encoding="utf-8"))
                    if isinstance(d, dict):
                        for k, v in d.items():
                            if k not in tokens_disco and isinstance(v, dict):
                                tokens_disco[k] = v
                except Exception:
                    pass

        resumo: Dict[str, Dict[str, Any]] = {}
        contas_esperadas = ("norvia", "revesta")
        for conta in contas_esperadas:
            dados_conta = tokens_disco.get(conta) or {}
            conectado = token_esta_valido(dados_conta)
            renovado = conta in tokens_obtidos and bool(tokens_obtidos[conta].get("access_token"))
            info_conta: Dict[str, Any] = {
                "conectado": conectado,
                "renovado": renovado,
            }
            if not renovado:
                info_conta["motivo"] = "Falha ao renovar via TMS"
            resumo[conta] = info_conta

        todas_renovadas = all(resumo[c]["renovado"] for c in contas_esperadas)
        todas_conectadas = all(resumo[c]["conectado"] for c in contas_esperadas)

        return {
            "ok": todas_renovadas and todas_conectadas,
            "contas": resumo,
            "tokens_atualizados": [c for c in contas_esperadas if resumo[c]["renovado"]],
        }
    except HTTPException:
        raise
    except Exception as e:
        req_id = request.headers.get("x-request-id") or ""
        erro_id = req_id if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", req_id) else uuid.uuid4().hex[:12]
        logger.error(f"[CONCILIACAO_ML] Erro não tratado [{erro_id}] ao sincronizar tokens: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"Erro interno ao sincronizar tokens (id {erro_id}). Consulte os logs da automação.",
                "erro_id": erro_id,
            },
        )
