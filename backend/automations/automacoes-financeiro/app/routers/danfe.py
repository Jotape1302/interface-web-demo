"""
DANFEs: upload em lote, varredura SEFAZ (NSU), importação por chave, revisão humana e
lançamento no Tiny (contas a pagar), além das categorias do Tiny usadas na revisão.

Separado de app/api.py (que monta o FastAPI, as rotinas de fundo e inclui os routers).
"""
import asyncio
import json
import logging
import shutil
import tempfile
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

from app.audit import load_resolved_failures, mark_failure_resolved, record_audit_error, resolve_failures_for_chave
from app.categorization import CategorizedItem, GroupedLancamento, group_items_by_category
from app import forma_pagamento as forma_pagamento_sugestao
from app.category_history import CategoryHistoryIndex, forma_pagamento_confirmada
from app.category_history import get_index as get_category_history
from app.cert_status import get_certificates_status
from app.fuso import FUSO_SP, agora_sp
from app.config import settings
from app.nfe_client import (
    NFeData,
    NFeDuplicate,
    NFeNaoDestinadaError,
    dados_fiscais_do_arquivo,
    enrich_nfe_data_from_file_context,
    get_nfe_provider,
    nome_curto_empresa,
    validar_nsu,
)
from app.nfe_items import NFeItem
from app.review_pipeline import already_launched_in_tiny, stage_note_for_review
from app.review_store import (
    ReviewItem,
    ReviewRecord,
    archive_pending,
    count_pending,
    get_pending,
    list_archived,
    list_confirmed,
    list_pending,
    remove_pending,
    restore_archived,
    update_qwen_suggestions,
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
from app.tiny_client import (
    PAYMENT_METHOD_MARCADOR,
    TinyCadastroError,
    PAYMENT_METHOD_NFE_LABELS,
    TinyClient,
    dividir_em_parcelas,
    is_v3_token,
)


logger = logging.getLogger("automacao_nfe.api")

router = APIRouter()


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
    bandeira_cartao_nfe: Optional[str] = None
    # Parcelas declaradas no XML (cobr/dup), limitadas a MAX_PARCELAS: a tela pré-seleciona.
    parcelas_nfe: Optional[int] = None
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
    # Para o registro de treino do gateway (atividades.ts), que tira o campo antes de responder ao painel.
    treino: Optional[Dict[str, Any]] = None


class BatchProcessResponse(BaseModel):
    total: int
    success_count: int
    failed_count: int
    total_amount: float
    items: List[ProcessItemResult]


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
        bandeira_cartao_nfe=nfe_data.bandeira_cartao_nfe,
        parcelas_nfe=min(nfe_data.parcelas_nfe, MAX_PARCELAS) if nfe_data.parcelas_nfe else None,
        marcador_caixa=nfe_data.marcador_caixa,
    )


def _parcelas_do_xml(file_path: Path) -> Optional[int]:
    """Quantidade de duplicatas (cobr -> dup) do XML da nota em revisão; None se não for XML."""
    try:
        if file_path.suffix.lower() != ".xml" or not file_path.exists():
            return None
        return len(re.findall(r"<(?:\w+:)?dup[\s>]", file_path.read_text(encoding="utf-8", errors="ignore"))) or None
    except OSError:
        return None


def _category_name(categoria_id: str) -> str:
    cat = CATEGORY_BY_ID.get(categoria_id)
    return cat.nome if cat else CATEGORY_BY_ID[DEFAULT_CATEGORY_ID].nome


def _unique_target_path(dest_dir: Path, original_path: Path) -> Path:
    """Evita sobrescrita se já existir arquivo com o mesmo nome no destino."""
    target = dest_dir / original_path.name
    counter = 1
    while target.exists():
        timestamp = agora_sp().strftime("%Y%m%d_%H%M%S")
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
            processed_at=agora_sp().isoformat(),
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
        processed_at=agora_sp().isoformat()
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
        paginas = await asyncio.to_thread(_paginas_pdf, destino)
        if paginas is not None and paginas > settings.UPLOAD_MAX_PDF_PAGES:
            destino.unlink(missing_ok=True)
            return f"PDF com {paginas} páginas: o limite é {settings.UPLOAD_MAX_PDF_PAGES} páginas por arquivo."
    return None


def _item_erro(filename: str, step: str, mensagem: str, **extras: Any) -> ProcessItemResult:
    """Resultado de erro de um item do lote (um único ponto para o `processed_at`)."""
    return ProcessItemResult(
        filename=filename,
        status="error",
        step=step,
        error_message=mensagem,
        processed_at=agora_sp().isoformat(),
        **extras,
    )


def _processar_arquivo(
    scanner: DANFEScanner,
    nfe_provider: Any,
    temp_file: Path,
    safe_filename: str,
) -> Tuple[ProcessItemResult, float]:
    """
    Etapas síncronas de um arquivo do lote (scan -> dados fiscais -> staging para revisão).
    Nunca levanta: uma falha vira `ProcessItemResult` de erro, sem derrubar o lote. Devolve
    o resultado e o valor da nota (0.0 se houve erro).
    """
    # 1. Extração da Chave de 44 Dígitos
    try:
        scan_result = scanner.scan_file(temp_file)
    except Exception as e:
        # Imagem corrompida, PDF ilegível etc. não pode derrubar o lote inteiro.
        err = f"Falha inesperada ao escanear o arquivo: {e}"
        logger.error(f"[{safe_filename}] {err}", exc_info=True)
        record_audit_error(details=err, original_filename=safe_filename, step="scan", cfg=settings)
        return _item_erro(safe_filename, "scan", err), 0.0
    if not scan_result or not scan_result.key:
        err = "Chave de acesso não localizada por código de barras nem por OCR."
        logger.warning(f"[{safe_filename}] {err}")
        record_audit_error(details=err, original_filename=safe_filename, step="scan", cfg=settings)
        return _item_erro(safe_filename, "scan", err), 0.0

    contexto_scan = dict(
        key=scan_result.key, scan_method=scan_result.method, page_number=scan_result.page_number
    )

    # 2. Dados fiscais: o XML completo da NF-e já traz tudo (emitente, itens, parcelas).
    # Consultar a SEFAZ só pela chave falhava para notas antigas (cStat 632 "fora de
    # prazo", > 90 dias) — justamente o caso de quem tem o XML em mãos.
    try:
        nfe_data: NFeData = dados_fiscais_do_arquivo(temp_file, scan_result.key, scan_result.method, nfe_provider)
        nfe_data = enrich_nfe_data_from_file_context(nfe_data, temp_file, raw_ocr_text=scan_result.raw_text)
    except Exception as e:
        err = f"Falha na consulta fiscal da chave {scan_result.key}: {e}"
        if isinstance(e, NFeNaoDestinadaError):
            # Nota de outra empresa (ou CPF): não é defeito, não vira incidente.
            err = (
                f"A SEFAZ informou que nenhuma das empresas configuradas é destinatária da nota "
                f"{scan_result.key} (cStat {e.c_stat}). Confira o destinatário no DANFE; se for uma das "
                "nossas, envie o XML da nota."
            )
            logger.warning(f"[{safe_filename}] {err}")
        else:
            logger.error(f"[{safe_filename}] {err}")
        record_audit_error(
            details=err,
            chave_acesso=scan_result.key,
            original_filename=safe_filename,
            metodo_leitura=scan_result.method,
            step="receita_federal",
            cfg=settings,
        )
        return _item_erro(safe_filename, "receita_federal", err, **contexto_scan), 0.0

    # 3. Extração de itens + sugestão de categoria + staging para revisão humana
    # (o lançamento no Tiny NÃO ocorre aqui — só depois de POST /danfe/confirm-lancamento)
    try:
        item_result = _prepare_for_review(nfe_data, scan_result, temp_file, safe_filename)
    except Exception as e:
        err = f"Falha ao preparar a nota para revisão/categorização: {e}"
        logger.error(f"[{safe_filename}] {err}", exc_info=True)
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
        return (
            _item_erro(safe_filename, "tiny_erp", err, nfe_data=_nfe_data_to_response(nfe_data), **contexto_scan),
            0.0,
        )
    return item_result, float(nfe_data.valor_total)


@router.post("/api/v1/danfe/process-batch", response_model=BatchProcessResponse)
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
                msg = f"Falha ao ler o arquivo enviado: {e}"
                results.append(_item_erro(safe_filename, "upload", msg))
                record_audit_error(details=msg, original_filename=safe_filename, step="upload", cfg=settings)
                continue
            if limite_erro:
                logger.warning(f"[{safe_filename}] Upload recusado: {limite_erro}")
                results.append(_item_erro(safe_filename, "upload", limite_erro))
                continue

            # Scan (OCR/código de barras), consulta fiscal (SEFAZ/Tiny) e staging são
            # síncronos e demorados: fora do event loop, para não travar as demais rotas (AUT-03).
            item_result, valor = await asyncio.to_thread(
                _processar_arquivo, scanner, nfe_provider, temp_file, safe_filename
            )
            results.append(item_result)
            if item_result.status == "success":
                total_amount += valor

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
                logger.debug("Não foi possível remover %s", f, exc_info=True)
    except Exception as e:
        logger.debug(f"[AUDIT] Falha ao limpar registros legados de varredura SEFAZ: {e}")


@router.get("/api/v1/danfe/history")
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


@router.post("/api/v1/danfe/failures/resolve")
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
    # NSUs pulados (cStat 656) recuperados nesta rodada por consNSU e os que ainda estão na fila.
    nsu_recuperados: int = 0
    nsu_pendentes: int = 0
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
        pending_review_count=count_pending(),
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


@router.get("/api/v1/danfe/sefaz-status", response_model=SefazScanStatusResponse)
def get_sefaz_status() -> SefazScanStatusResponse:
    """Retorna o status da varredura direta na SEFAZ: última execução, CNPJs monitorados e próximo horário agendado."""
    return _build_sefaz_status_response()


@router.post("/api/v1/danfe/scan-sefaz", response_model=SefazScanStatusResponse)
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


@router.get("/api/v1/danfe/sefaz-nsu")
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


@router.post("/api/v1/danfe/sefaz-nsu/reset")
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


@router.post("/api/v1/danfe/import-key")
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
    except NFeNaoDestinadaError as e:
        # Não é defeito: a nota é de outra empresa (ou CPF). WARNING para não virar incidente.
        logger.warning(f"[IMPORT_KEY] Chave {raw_key}: {e}")
        empresas = ", ".join(nome_curto_empresa(c) for c in e.cnpjs)
        emitente = raw_key[6:20]
        raise HTTPException(
            status_code=422,
            detail=(
                f"A SEFAZ informou que nenhuma das empresas configuradas ({empresas}) é destinatária desta "
                f"nota (cStat {e.c_stat}; emitente CNPJ {emitente[:2]}.{emitente[2:5]}.{emitente[5:8]}/{emitente[8:12]}-{emitente[12:]}). "
                "Confira no DANFE o CNPJ do destinatário: se for de outra empresa ou de pessoa física, a nota "
                "não entra por aqui; se for uma das nossas, peça o XML ao fornecedor e envie no Upload Manual, logo abaixo."
            ),
        )
    except Exception as e:
        if getattr(e, "c_stat", None) == "632":
            logger.warning(f"[IMPORT_KEY] Chave {raw_key}: {e}")
            # Limite da própria SEFAZ (distribuição por chave só até 90 dias da emissão).
            raise HTTPException(
                status_code=422,
                detail=(
                    "A SEFAZ não entrega mais esta nota pela chave: ela tem mais de 90 dias "
                    "(cStat 632). Baixe o XML com o fornecedor, no marketplace ou num site de "
                    "consulta de NF-e e envie no Upload Manual, logo abaixo."
                ),
            )
        if getattr(e, "c_stat", None) == "656":
            logger.warning(f"[IMPORT_KEY] Chave {raw_key}: {e}")
            # Limite de consultas da SEFAZ (20 por hora por CNPJ); WARNING para não virar incidente.
            raise HTTPException(
                status_code=422,
                detail=(
                    "A SEFAZ bloqueou as consultas deste CNPJ por excesso (cStat 656, limite de "
                    "20 por hora). Aguarde cerca de 1 hora antes de tentar de novo e, enquanto "
                    "isso, use o Upload Manual do XML."
                ),
            )
        logger.error(f"[IMPORT_KEY] Falha ao consultar chave {raw_key}: {e}")
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
            logger.debug("Não foi possível criar o arquivo virtual %s", virtual_file, exc_info=True)

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
        "processed_at": agora_sp().isoformat(),
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

    # Falhas anteriores desta nota (ex.: Tiny recusou por fornecedor sem cadastro e a pessoa
    # reenviou depois de cadastrar) deixam de contar como pendência. Nunca derruba a confirmação.
    try:
        resolve_failures_for_chave(record.chave)
    except Exception as e:
        logger.warning(f"[{record.chave}] Lançada, mas não deu para marcar as falhas anteriores como resolvidas: {e}")


@router.get("/api/v1/tiny/categories", response_model=List[TinyCategoryResponse])
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


CONFIANCAS_QWEN = ("alta", "media", "baixa")


def _qwen_do_item(ri: ReviewItem) -> Optional[Tuple[str, str, Optional[str]]]:
    """Sugestão do Qwen gravada no item, se ainda for um ID do catálogo e uma confiança conhecida."""
    if ri.qwen_categoria_id in CATEGORY_BY_ID and ri.qwen_confianca in CONFIANCAS_QWEN:
        return ri.qwen_categoria_id, ri.qwen_confianca, ri.qwen_motivo
    return None


def _sugestao_item(record: ReviewRecord, ri: ReviewItem, history: Optional[CategoryHistoryIndex]) -> Dict[str, Any]:
    """
    Categoria pré-selecionada de um item pendente, pela precedência decidida em 03/11/2026:
    histórico por código > histórico por NCM > Qwen alta/média > histórico só do fornecedor >
    Qwen baixa > regra por palavra-chave. Sem `history` (notas confirmadas/arquivadas), vale o
    `categoria_sugerida_id` gravado — nas confirmadas, a escolha humana.

    `alternativas` traz o que cada fonte diria, para o registro de treino medir cada uma mesmo
    quando outra venceu na tela.
    """
    hist = history.suggest_detalhado(record.nfe_data.destinatario_cnpj, record.nfe_data.emitente_cnpj, ri) if history else None
    qwen = _qwen_do_item(ri) if history is not None else None
    alternativas = {
        "historico": {"categoria_id": hist[0], "nivel": hist[1]} if hist else None,
        "qwen": {"categoria_id": qwen[0], "confianca": qwen[1]} if qwen else None,
        "regra": ri.categoria_sugerida_id,
    }
    escolha: Dict[str, Any] = {"categoria_id": ri.categoria_sugerida_id, "origem": "regra", "nivel": None, "confianca": None, "motivo": None}
    if hist and hist[1] != "fornecedor":
        escolha.update(categoria_id=hist[0], origem="historico", nivel=hist[1])
    elif qwen and qwen[1] != "baixa":
        escolha.update(categoria_id=qwen[0], origem="qwen", confianca=qwen[1], motivo=qwen[2])
    elif hist:
        escolha.update(categoria_id=hist[0], origem="historico", nivel=hist[1])
    elif qwen:
        escolha.update(categoria_id=qwen[0], origem="qwen", confianca=qwen[1], motivo=qwen[2])
    escolha["alternativas"] = alternativas
    return escolha


def _record_to_dict(record: ReviewRecord, history: Optional[CategoryHistoryIndex] = None, alternativas: bool = False) -> Dict[str, Any]:
    """
    Com `history` (só para notas pendentes), a sugestão de categoria de cada item segue a
    precedência de `_sugestao_item` (histórico, Qwen ou regra) e a nota ganha a forma de
    pagamento sugerida (forma_pagamento.py: XML, senão o último pagamento ao fornecedor).
    `alternativas=True` inclui em cada item o que cada fonte sugeriu (registro de treino).
    """
    def item(ri: ReviewItem) -> Dict[str, Any]:
        sug = _sugestao_item(record, ri, history)
        dados = {
            "item_id": ri.item_id,
            "descricao": ri.descricao,
            "valor_total": float(ri.valor_total),
            "codigo": ri.codigo,
            "ncm": ri.ncm,
            "quantidade": float(ri.quantidade),
            "valor_unitario": float(ri.valor_unitario) if ri.valor_unitario is not None else None,
            "categoria_sugerida_id": sug["categoria_id"],
            "categoria_sugerida_nome": _category_name(sug["categoria_id"]),
            "categoria_sugerida_origem": sug["origem"],
            "categoria_sugerida_nivel": sug["nivel"],
            "categoria_sugerida_confianca": sug["confianca"],
            "categoria_sugerida_motivo": sug["motivo"],
        }
        if alternativas:
            dados["alternativas"] = sug["alternativas"]
        return dados

    # Nota em revisão desde antes de parcelas_nfe existir: conta as duplicatas no XML guardado.
    if record.nfe_data.parcelas_nfe is None:
        record.nfe_data.parcelas_nfe = _parcelas_do_xml(record.file_path)
    nota: Dict[str, Any] = {
        "chave": record.chave,
        "filename": record.filename,
        "staged_at": record.staged_at,
        "nfe_data": _nfe_data_to_response(record.nfe_data).model_dump(),
        "itens": [item(ri) for ri in record.itens],
        # Última recusa do Tiny no confirm-lancamento (limpa quando lança). Sem isto a tela só
        # mostrava o erro logo após o clique: recarregou, a nota parecia uma pendente comum.
        "last_error": record.last_error,
        "last_error_at": record.last_error_at,
    }
    if history is not None:
        nfe = record.nfe_data
        forma, origem = forma_pagamento_sugestao.sugerir(
            nfe.meio_pagamento_nfe, nfe.bandeira_cartao_nfe, nfe.destinatario_cnpj,
            history.forma_pagamento(nfe.destinatario_cnpj, nfe.emitente_cnpj),
        )
        nota["forma_pagamento_sugerida"] = forma
        nota["forma_pagamento_origem"] = origem
        # O painel deriva o meio da forma; este vale quando a forma não define um (ex.: sem marcador).
        nota["meio_pagamento_nfe_historico"] = history.meio_pagamento_nfe(nfe.destinatario_cnpj, nfe.emitente_cnpj)
    return nota


@router.get("/api/v1/danfe/pending-review")
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


@router.get("/api/v1/danfe/notas")
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


@router.post("/api/v1/danfe/archive")
def archive_nota(payload: ChaveRequest) -> Dict[str, Any]:
    """Arquiva uma nota pendente de revisão: some da revisão, sem apagar dados; pode ser restaurada depois."""
    record = archive_pending(payload.chave)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Nenhuma nota pendente de revisão encontrada para a chave {payload.chave}.",
        )
    # Para o registro de treino do gateway (atividades.ts): a nota como a revisão mostrou.
    tela = _record_to_dict(record, get_category_history(settings.PROCESSED_DIR))
    treino = {"contexto": {"chave": tela["chave"], "nfe_data": tela["nfe_data"], "itens": tela["itens"]}}
    return {"chave": record.chave, "status": "archived", "treino": treino}


@router.post("/api/v1/danfe/restore")
def restore_nota(payload: ChaveRequest) -> Dict[str, str]:
    """Restaura uma nota arquivada de volta para a revisão pendente."""
    record = restore_archived(payload.chave)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Nenhuma nota arquivada encontrada para a chave {payload.chave}.",
        )
    return {"chave": record.chave, "status": "pending"}


@router.post("/api/v1/danfe/confirm-lancamento", response_model=ConfirmLancamentoResponse)
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

    # A nota como a revisão mostrou e a sugestão de cada item, antes da escolha humana sobrescrever.
    tela = _record_to_dict(record, get_category_history(settings.PROCESSED_DIR), alternativas=True)
    treino = {
        "contexto": {
            "chave": tela["chave"],
            "nfe_data": tela["nfe_data"],
            "itens": [{k: v for k, v in i.items() if k != "alternativas"} for i in tela["itens"]],
            "forma_pagamento_sugerida": {"forma": tela.get("forma_pagamento_sugerida"), "origem": tela.get("forma_pagamento_origem")},
        },
        "sugestao": {
            i["item_id"]: {
                "categoria_id": i["categoria_sugerida_id"],
                "categoria_nome": i["categoria_sugerida_nome"],
                "origem": i["categoria_sugerida_origem"],
                "nivel": i["categoria_sugerida_nivel"],
                "confianca": i["categoria_sugerida_confianca"],
                "motivo": i["categoria_sugerida_motivo"],
                "qwen_modelo": record.qwen_modelo if i["alternativas"]["qwen"] else None,
                "alternativas": i["alternativas"],
            }
            for i in tela["itens"]
        },
    }

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
            if isinstance(e, TinyCadastroError):
                # Fornecedor sem cadastro / CNPJ divergente: ação no Tiny, não bug. WARNING para o
                # coletor não abrir incidente (inc. #19, 05/11); a recusa fica no card e na auditoria.
                logger.warning(
                    f"[{record.chave}] Tiny recusou o grupo '{grupo.categoria_nome}' "
                    f"(parcela {parcela}/{payload.parcelas}) por cadastro: {e}"
                )
            else:
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
        record.forma_pagamento = payload.forma_pagamento
        record.confirmado_em = agora_sp().isoformat()
        _finalize_confirmed(record, grupo_responses, payload.forma_pagamento, payload.parcelas)
        return ConfirmLancamentoResponse(chave=record.chave, status="success", grupos=grupo_responses, treino=treino)

    failed_groups = [g for g in grupo_responses if g.status == "error"]
    err_msgs = "; ".join([
        f"{g.categoria_nome}{f' (parcela {g.parcela}/{g.total_parcelas})' if g.total_parcelas > 1 else ''}: {g.error_message}"
        for g in failed_groups
    ]) or "Falha ao lançar no Tiny ERP"
    record.last_error = err_msgs
    record.last_error_at = agora_sp().isoformat()
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

    return ConfirmLancamentoResponse(chave=record.chave, status="partial_error", grupos=grupo_responses, treino=treino)


# --- Classificador Qwen (PC do TI) -------------------------------------------------------
# Chamado só pelo coletor da VPS (scripts/coletor-incidentes), que leva as notas pelo túnel
# SSH reverso até o agentes-qwen e traz as sugestões de volta. Protegido pela X-Internal-Key
# como todo o serviço; o gateway não repassa estas rotas ao painel.


def _item_para_qwen(record: ReviewRecord, ri: ReviewItem, history: CategoryHistoryIndex) -> Dict[str, Any]:
    hist = history.suggest_detalhado(record.nfe_data.destinatario_cnpj, record.nfe_data.emitente_cnpj, ri)
    return {
        "item_id": ri.item_id,
        "descricao": ri.descricao,
        "codigo": ri.codigo,
        "ncm": ri.ncm,
        "quantidade": float(ri.quantidade),
        "valor_total": float(ri.valor_total),
        "regra": ri.categoria_sugerida_id,
        "historico": {"categoria_id": hist[0], "nivel": hist[1]} if hist else None,
        # O mesmo produto já confirmado com o fornecedor: o histórico vence, o Qwen não precisa olhar.
        "classificar": not (hist and hist[1] == "codigo"),
    }


@router.get("/api/v1/danfe/qwen/pendentes")
def get_qwen_pendentes(limit: int = Query(20, ge=1, le=100)) -> Dict[str, Any]:
    """
    Notas em revisão ainda sem classificação do Qwen e com algum item sem histórico pelo código,
    mais antigas primeiro. Leva o catálogo fechado (`categorias`): o PC monta o JSON Schema com
    ele, então o Qwen nunca recebe um ID que a automação recusaria.
    """
    settings.ensure_directories()
    history = get_category_history(settings.PROCESSED_DIR)
    notas = []
    for record in sorted(list_pending(), key=lambda r: r.staged_at or ""):
        if record.qwen_classificado_em:
            continue
        itens = [_item_para_qwen(record, ri, history) for ri in record.itens]
        if not any(i["classificar"] for i in itens):
            continue
        notas.append({
            "chave": record.chave,
            "staged_at": record.staged_at,
            "nfe_data": _nfe_data_to_response(record.nfe_data).model_dump(),
            "itens": itens,
        })
    return {
        "total": len(notas),
        "categorias": [{"id": c.id, "grupo": c.grupo, "nome": c.nome} for c in TINY_CATEGORIES],
        "notas": notas[:limit],
    }


class QwenItemSugestao(BaseModel):
    item_id: str
    categoria_id: str
    confianca: Literal["alta", "media", "baixa"]
    motivo: str = ""


class QwenSugestoesRequest(BaseModel):
    chave: str
    staged_at: str
    modelo: str = Field(min_length=1, max_length=100)
    itens: List[QwenItemSugestao]


QWEN_MOTIVO_MAX = 500


@router.post("/api/v1/danfe/qwen/sugestoes")
def post_qwen_sugestoes(payload: QwenSugestoesRequest) -> Dict[str, Any]:
    """
    Grava a classificação do Qwen numa nota pendente. 422: algum ID fora do catálogo fechado
    (TINY_CATEGORIES) ou item que a nota não tem; 404: a nota já saiu da revisão; 409: a nota
    foi estagiada de novo depois de enviada ao Qwen (`staged_at` diferente). Nos três o coletor
    descarta a sugestão, sem tentar de novo.
    """
    fora = sorted({i.categoria_id for i in payload.itens if i.categoria_id not in CATEGORY_BY_ID})
    if fora:
        raise HTTPException(status_code=422, detail=f"Categoria(s) fora do catálogo do Tiny: {', '.join(fora)}.")
    record = get_pending(payload.chave)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Nenhuma nota pendente de revisão para a chave {payload.chave}.")
    desconhecidos = sorted({i.item_id for i in payload.itens} - {ri.item_id for ri in record.itens})
    if desconhecidos:
        raise HTTPException(status_code=422, detail=f"Item(ns) que a nota não tem: {', '.join(desconhecidos)}.")

    sugestoes = {i.item_id: (i.categoria_id, i.confianca, i.motivo.strip()[:QWEN_MOTIVO_MAX]) for i in payload.itens}
    resultado = update_qwen_suggestions(payload.chave, payload.staged_at, sugestoes, payload.modelo, agora_sp().isoformat())
    if resultado == "nao_pendente":
        raise HTTPException(status_code=404, detail=f"Nenhuma nota pendente de revisão para a chave {payload.chave}.")
    if resultado == "desatualizada":
        raise HTTPException(status_code=409, detail="A nota foi estagiada de novo depois da classificação; sugestão descartada.")
    logger.info(f"[QWEN] {len(sugestoes)} sugestão(ões) de {payload.modelo} gravada(s) na nota {payload.chave}")
    return {"chave": payload.chave, "status": "gravado", "itens": len(sugestoes)}


def _confirmado_em(record: ReviewRecord) -> datetime:
    """`confirmado_em` gravado na confirmação ou, nas notas mais antigas, a data do `.review.json`."""
    if record.confirmado_em:
        try:
            quando = datetime.fromisoformat(record.confirmado_em)
            return quando if quando.tzinfo else quando.replace(tzinfo=FUSO_SP)
        except ValueError:
            pass
    json_path = record.file_path.with_suffix(record.file_path.suffix + ".review.json")
    try:
        return datetime.fromtimestamp(json_path.stat().st_mtime, tz=FUSO_SP)
    except OSError:
        return datetime.fromtimestamp(0, tz=FUSO_SP)


def _ler_cursor(cursor: Optional[str]) -> Optional[Tuple[datetime, str]]:
    if not cursor:
        return None
    quando, _, chave = cursor.partition("|")
    try:
        data = datetime.fromisoformat(quando)
    except ValueError:
        raise HTTPException(status_code=422, detail="Cursor inválido: use o `cursor` devolvido pela chamada anterior.")
    return (data if data.tzinfo else data.replace(tzinfo=FUSO_SP)), chave


@router.get("/api/v1/danfe/qwen/confirmadas-recentes")
def get_qwen_confirmadas(cursor: Optional[str] = None, limit: int = Query(200, ge=1, le=1000)) -> Dict[str, Any]:
    """
    Notas confirmadas (processed/) depois de `cursor`, em ordem de confirmação, com a categoria
    final de cada item e o palpite do Qwen quando houve: alimentam os exemplos do classificador
    e medem o acerto. Sem `cursor`, começa do início (carga do histórico inteiro, em páginas).
    `fim=false`: há mais páginas; chame de novo com o `cursor` devolvido.
    """
    desde = _ler_cursor(cursor)
    ordenadas = sorted(((_confirmado_em(r), r.chave, r) for r in list_confirmed()), key=lambda t: (t[0], t[1]))
    novas = [t for t in ordenadas if desde is None or (t[0], t[1]) > desde]
    pagina = novas[:limit]
    confirmadas = [
        {
            "chave": r.chave,
            "confirmado_em": quando.isoformat(),
            "staged_at": r.staged_at,
            "emitente_cnpj": r.nfe_data.emitente_cnpj,
            "emitente_nome": r.nfe_data.emitente_nome,
            "destinatario_cnpj": r.nfe_data.destinatario_cnpj,
            "destinatario_nome": r.nfe_data.destinatario_nome,
            "valor_total": float(r.nfe_data.valor_total),
            "meio_pagamento_nfe": r.nfe_data.meio_pagamento_nfe,
            "forma_pagamento": forma_pagamento_confirmada(r),
            "qwen_modelo": r.qwen_modelo,
            "itens": [
                {
                    "item_id": ri.item_id,
                    "descricao": ri.descricao,
                    "codigo": ri.codigo,
                    "ncm": ri.ncm,
                    "quantidade": float(ri.quantidade),
                    "valor_total": float(ri.valor_total),
                    "categoria_id": ri.categoria_sugerida_id,
                    "qwen_categoria_id": ri.qwen_categoria_id,
                    "qwen_confianca": ri.qwen_confianca,
                }
                for ri in r.itens
            ],
        }
        for quando, _, r in pagina
    ]
    proximo = f"{pagina[-1][0].isoformat()}|{pagina[-1][1]}" if pagina else cursor
    return {"confirmadas": confirmadas, "cursor": proximo, "fim": len(novas) <= limit}
