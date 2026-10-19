"""
Módulo de auditoria fiscal para persistência e recuperação de falhas e erros
da esteira de processamento de NF-e, varredura direta na SEFAZ e lançamentos
no Tiny ERP.
"""
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from app.config import settings, Settings

logger = logging.getLogger("automacao_nfe.audit")


def record_audit_error(
    details: str,
    chave_acesso: Optional[str] = None,
    original_filename: Optional[str] = None,
    numero_nota: Optional[str] = None,
    emitente_nome: Optional[str] = None,
    emitente_cnpj: Optional[str] = None,
    destinatario_nome: Optional[str] = None,
    destinatario_cnpj: Optional[str] = None,
    valor_total: Optional[float] = None,
    metodo_leitura: Optional[str] = None,
    step: Optional[str] = None,
    timestamp: Optional[datetime] = None,
    cfg: Optional[Settings] = None,
) -> Path:
    """
    Grava um registro de auditoria de falha em FAILED_DIR no formato JSON estruturado (.error.json).
    Esse arquivo é lido por GET /api/v1/danfe/history e consumido pelo Gateway (Visão Geral)
    e pelo Histórico de Lotes do DANFE, contabilizando falhas reais no gráfico de 14 dias
    e nas métricas de assertividade.
    """
    cfg = cfg or settings
    cfg.ensure_directories()

    dt = timestamp or datetime.now(timezone.utc)
    ts_str = dt.isoformat()
    file_ts = dt.strftime("%Y%m%d_%H%M%S_%f")
    key_part = f"_{chave_acesso}" if chave_acesso else ""
    error_filename = f"{file_ts}{key_part}.error.json"
    target_path = cfg.FAILED_DIR / error_filename

    payload: Dict[str, Any] = {
        "audit_status": "error",
        "processed_at": ts_str,
        "chave_acesso": chave_acesso,
        "original_filename": original_filename or (f"SEFAZ_{chave_acesso}" if chave_acesso else "DANFE_ERROR"),
        "numero_nota": numero_nota,
        "emitente": {
            "razao_social": emitente_nome or "Não identificado",
            "cnpj": emitente_cnpj or "",
        },
        "destinatario": {
            "razao_social": destinatario_nome or "",
            "cnpj": destinatario_cnpj or "",
        },
        "valor_total": float(valor_total) if valor_total is not None else 0.0,
        "details": details,
        "metodo_leitura": metodo_leitura,
        "step": step,
        "error_file": error_filename,
    }

    try:
        with open(target_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        logger.info(f"[AUDIT] Registro de erro gravado em {target_path.name}: {details}")
    except Exception as e:
        logger.error(f"[AUDIT] Falha ao gravar auditoria de erro em {target_path}: {e}", exc_info=True)

    return target_path


RESOLVED_FAILURES_FILENAME = "_resolved.json"


def load_resolved_failures(cfg: Optional[Settings] = None) -> Dict[str, str]:
    """
    Falhas marcadas manualmente como resolvidas (ex.: nota lançada direto no Tiny), no formato
    {error_file: resolved_at}. O .error.json continua em FAILED_DIR para o gráfico de 14 dias;
    a marcação só tira a falha da lista de pendências.
    """
    cfg = cfg or settings
    path = cfg.FAILED_DIR / RESOLVED_FAILURES_FILENAME
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.error(f"[AUDIT] Falha ao ler {path.name}: {e}")
        return {}


def mark_failure_resolved(error_file: str, cfg: Optional[Settings] = None) -> Optional[str]:
    """
    Marca a falha `error_file` (nome do arquivo em FAILED_DIR) como resolvida.
    Retorna o timestamp da resolução, ou None se o arquivo de erro não existir.
    """
    cfg = cfg or settings
    cfg.ensure_directories()
    # Só aceita um nome de arquivo de erro dentro de FAILED_DIR, nunca um caminho.
    if Path(error_file).name != error_file or not error_file.endswith((".error.json", ".error.txt")):
        return None
    if not (cfg.FAILED_DIR / error_file).is_file():
        return None

    resolved = load_resolved_failures(cfg)
    resolved_at = resolved.get(error_file) or datetime.now(timezone.utc).isoformat()
    resolved[error_file] = resolved_at

    path = cfg.FAILED_DIR / RESOLVED_FAILURES_FILENAME
    tmp_path = path.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(resolved, f, indent=2, ensure_ascii=False)
    tmp_path.replace(path)
    logger.info(f"[AUDIT] Falha {error_file} marcada como resolvida")
    return resolved_at
