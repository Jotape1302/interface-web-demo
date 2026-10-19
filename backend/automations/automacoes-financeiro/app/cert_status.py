"""
Validade dos certificados digitais A1 usados na varredura SEFAZ.

Certificado vencido faz a SEFAZ recusar o mTLS e a varredura de notas para sem aviso claro
no painel (só aparece como erro genérico de conexão por CNPJ). Este módulo lê a data de
expiração de cada .pfx/.p12 descoberto pelas mesmas regras de `load_sefaz_providers`, para
o painel e o gateway alertarem com antecedência.
"""
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.config import Settings, settings
from app.nfe_client import collect_candidate_passwords

logger = logging.getLogger("automacao_nfe.cert_status")

# A partir de quantos dias antes do vencimento o painel passa a alertar.
CERT_ALERT_DAYS = 30

_cache_lock = threading.Lock()
_cache: Dict[Tuple[str, float], Dict[str, Any]] = {}


def _cert_files(cfg: Settings) -> List[Path]:
    files: List[Path] = []
    certs_dir = cfg.SEFAZ_CERTS_DIR
    if not certs_dir and not cfg.SEFAZ_CERT_PATH and Path("./secrets").exists():
        certs_dir = Path("./secrets")
    if certs_dir and Path(certs_dir).is_dir():
        for ext in ("*.pfx", "*.p12"):
            files.extend(sorted(Path(certs_dir).glob(ext)))
    if cfg.SEFAZ_CERT_PATH and str(cfg.SEFAZ_CERT_PATH).strip() not in ("", "."):
        path = Path(cfg.SEFAZ_CERT_PATH)
        if path.exists() and path not in files:
            files.append(path)
    return files


def _read_certificate(path: Path, cfg: Settings) -> Dict[str, Any]:
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    info: Dict[str, Any] = {"arquivo": path.name, "cnpj": None, "titular": None, "valido_ate": None, "erro": None}
    try:
        pfx_bytes = path.read_bytes()
    except OSError as e:
        info["erro"] = f"Não foi possível ler o arquivo: {e}"
        return info

    for pwd in collect_candidate_passwords(path, cfg) or [None]:
        try:
            _, cert, _ = pkcs12.load_key_and_certificates(pfx_bytes, pwd.encode("utf-8") if pwd else None)
        except ValueError:
            continue
        except Exception as e:  # arquivo corrompido etc.
            info["erro"] = f"Certificado ilegível: {e}"
            return info
        if cert is None:
            continue
        not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(tzinfo=timezone.utc)
        info["valido_ate"] = not_after.isoformat()
        for attr in cert.subject:
            if attr.oid == NameOID.COMMON_NAME:
                value = str(attr.value)
                info["titular"] = value.split(":")[0]
                digits = "".join(c for c in value.split(":")[-1] if c.isdigit())
                if len(digits) == 14:
                    info["cnpj"] = digits
        return info

    info["erro"] = "Nenhuma senha configurada abre este certificado."
    return info


def get_certificates_status(cfg: Optional[Settings] = None, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """
    Lista os certificados A1 com a validade e os dias restantes. A leitura do .pfx (que
    testa senhas candidatas) fica em cache por arquivo+mtime — o status da SEFAZ é
    consultado a cada poll do painel.
    """
    cfg = cfg or settings
    now = now or datetime.now(timezone.utc)
    result = []
    for path in _cert_files(cfg):
        try:
            key = (str(path.resolve()), path.stat().st_mtime)
        except OSError:
            continue
        with _cache_lock:
            info = _cache.get(key)
            if info is None:
                try:
                    info = _read_certificate(path, cfg)
                except Exception as e:
                    logger.warning(f"[CERT] Falha ao inspecionar {path.name}: {e}")
                    info = {"arquivo": path.name, "cnpj": None, "titular": None, "valido_ate": None, "erro": str(e)}
                _cache[key] = info
        dias = None
        if info["valido_ate"]:
            dias = (datetime.fromisoformat(info["valido_ate"]) - now).days
        result.append({**info, "dias_restantes": dias, "alerta": dias is not None and dias <= CERT_ALERT_DAYS})
    return result
