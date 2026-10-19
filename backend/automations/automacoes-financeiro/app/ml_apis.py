"""
APIs do Mercado Pago e do Mercado Livre usadas pela conciliação ML (app/ml_reconciliation*.py).

- Mercado Pago, relatório de Liberações (`/v1/account/release_report`): cada linha é um movimento
  que afetou o saldo disponível (liberação de venda, devolução, reclamação, envio, saque...), com
  o ID do pagamento (`SOURCE_ID`) e, nas vendas, o pedido/pacote do Mercado Livre. O relatório é
  gerado de forma assíncrona: pede-se o período, espera-se o arquivo aparecer na listagem e
  baixa-se o CSV.
- Mercado Livre, pedidos (`/orders/search`): a venda com o pacote e os IDs dos pagamentos, que
  ligam a venda à liberação.

Tokens: o do Mercado Pago é a credencial de produção da conta (não expira). Os do Mercado Livre
são sincronizados periodicamente a partir do TMS e gravados em ml_tokens.json na pasta própria
de dados (DATA_DIR).
"""
from __future__ import annotations

import csv
import io
import ipaddress
import json
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests

from app.config import Settings, settings

logger = logging.getLogger("automacao_nfe.ml_apis")

# Brasil sem horário de verão desde 2019: o fuso de São Paulo é fixo em -03:00.
FUSO_SP = timezone(timedelta(hours=-3))

# Colunas pedidas no relatório de Liberações (chaves em inglês, estáveis para a leitura).
COLUNAS_LIBERACOES = (
    "DATE",
    "SOURCE_ID",
    "EXTERNAL_REFERENCE",
    "RECORD_TYPE",
    "DESCRIPTION",
    "NET_CREDIT_AMOUNT",
    "NET_DEBIT_AMOUNT",
    "GROSS_AMOUNT",
    "MP_FEE_AMOUNT",
    "FINANCING_FEE_AMOUNT",
    "SHIPPING_FEE_AMOUNT",
    "TAXES_AMOUNT",
    "COUPON_AMOUNT",
    "INSTALLMENTS",
    "PAYMENT_METHOD",
    "TRANSACTION_APPROVAL_DATE",
    "ORDER_ID",
    "PACK_ID",
    "SHIPPING_ID",
    "BALANCE_AMOUNT",
)
COLUNAS_OBRIGATORIAS = ("DATE", "SOURCE_ID", "DESCRIPTION", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT")

Progresso = Callable[[str], None]


class APIMercadoError(RuntimeError):
    def __init__(self, mensagem: str, status: Optional[int] = None) -> None:
        super().__init__(mensagem)
        self.status = status


class SemCredencial(APIMercadoError):
    """Conta sem token configurado (ou com token expirado): a empresa fica de fora da execução."""


# ─────────────────────────────────────────────────────────────────────────────
# Tokens
# ─────────────────────────────────────────────────────────────────────────────


_TMS_ML_TOKEN_CACHE: Dict[str, Tuple[str, float]] = {}
_RENOVA_ML_LOCK = threading.RLock()


def _candidatos_ml_tokens_files(cfg: Optional[Settings] = None) -> List[Path]:
    cfg = cfg or settings
    # DATA_DIR primeiro: é onde o financeiro grava o token renovado. Lido depois do ML_TOKENS_FILE
    # (ex.: arquivo do marketplace), um token vencido lá forçaria renovação no TMS a cada chamada.
    candidatos = []
    if cfg.DATA_DIR:
        candidatos.append(Path(cfg.DATA_DIR) / "ml_tokens.json")
    if cfg.ML_TOKENS_FILE:
        candidatos.append(Path(cfg.ML_TOKENS_FILE))
    resultado: List[Path] = []
    for c in candidatos:
        if c and c not in resultado:
            resultado.append(c)
    return resultado


def token_esta_valido(dados_conta: Dict[str, Any], margem_segundos: int = 900) -> bool:
    """
    Verifica se o access_token existe e se ainda não expirou com base em 'renovado_em' e 'expires_in'.
    Tokens do Mercado Livre duram 6 horas (21600s). Margem de segurança padrão: 15 minutos (900s).
    """
    if not isinstance(dados_conta, dict):
        return False
    access_token = dados_conta.get("access_token")
    if not access_token or not str(access_token).strip():
        return False

    renovado_em_str = dados_conta.get("renovado_em")
    if not renovado_em_str:
        # Sem data de renovação registrada: assume que pode estar válido (será testado na API)
        return True

    try:
        dt_renovado = datetime.fromisoformat(str(renovado_em_str).replace("Z", "+00:00"))
        if not dt_renovado.tzinfo:
            dt_renovado = dt_renovado.replace(tzinfo=timezone.utc)
        duracao = float(dados_conta.get("expires_in") or 21600)
        expira_em = dt_renovado + timedelta(seconds=max(60.0, duracao - margem_segundos))
        return datetime.now(timezone.utc) < expira_em
    except Exception:
        return True


def salvar_ml_tokens_em_disco(tokens: Dict[str, Any], cfg: Optional[Settings] = None) -> None:
    """
    Grava os tokens atualizados atomicamente com modo restrito 0600 exclusivamente no próprio DATA_DIR.
    O financeiro nunca grava no volume de outra automação (T1, Decisão 3).
    Preserva dados anteriores de outras filiais se houver.
    """
    cfg = cfg or settings
    from app.json_store import write_json_atomic, SECRET_FILE_MODE

    destino = Path(cfg.DATA_DIR) / "ml_tokens.json"
    try:
        destino.parent.mkdir(parents=True, exist_ok=True)
        existente: Dict[str, Any] = {}
        if destino.is_file():
            try:
                existente = json.loads(destino.read_text(encoding="utf-8")) or {}
            except Exception:
                existente = {}

        fundido = {**existente, **tokens}
        write_json_atomic(destino, fundido, mode=SECRET_FILE_MODE)
        logger.debug(f"[CONCILIACAO_ML] Tokens do Mercado Livre salvos em {destino}")
    except Exception as e:
        logger.debug(f"[CONCILIACAO_ML] Não foi possível salvar tokens em {destino}: {e}")



def obter_credenciais_tms(cfg: Optional[Settings] = None) -> Tuple[str, Optional[str], Optional[str]]:
    """Obtém (base_url, user, password) do TMS exclusivamente a partir da cfg ou de variáveis de ambiente do processo."""
    cfg = cfg or settings
    base_url = cfg.TMS_BASE_URL or os.environ.get("TMS_BASE_URL") or "https://servidor.norvia.example/tms_api"
    user = cfg.TMS_USER or os.environ.get("TMS_USER") or os.environ.get("TMS_NAME")
    pwd = cfg.TMS_PASSWORD or os.environ.get("TMS_PASSWORD") or os.environ.get("TMS_PASS")
    return base_url, user, pwd


def _host_local(host: str) -> bool:
    """Loopback, rede privada ou nome interno do Docker (HTTP sem TLS aceitável só nesses casos)."""
    host = host.strip("[]").lower()
    if host in ("localhost", "host.docker.internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private


def _urls_candidatas_tms(base_url: str) -> List[str]:
    """Retorna a URL base do TMS configurada, recusando HTTP em hosts públicos (SA-04)."""
    u = (base_url or "").strip().rstrip("/")
    if not u:
        return []
    if u.startswith("http://"):
        if not _host_local(urlparse(u).hostname or ""):
            logger.warning("[SEGURANCA] TMS_BASE_URL pública em HTTP puro recusada para proteger credenciais: %s", u)
            return []
        logger.info("[SEGURANCA] Usando TMS_BASE_URL local em HTTP: %s", u)
        return [u]
    if u.startswith("https://"):
        return [u]
    return []



def obter_token_ml_tms(
    conta_ml: str,
    cfg: Optional[Settings] = None,
    http: Any = None,
    forcar: bool = False,
) -> Optional[str]:
    """
    Obtém token de acesso do Mercado Livre consultando a API do TMS (/auth/login e /tokens?id=3|4).
    Cache em memória de até 2 horas.
    """
    cfg = cfg or settings
    if cfg.MOCK_MODE:
        return f"mock-token-{conta_ml}"

    base_url_orig, user, pwd = obter_credenciais_tms(cfg)
    if not (user and pwd):
        return None

    id_map = {"revesta": 3, "norvia": 4}
    token_id = id_map.get(conta_ml)
    if not token_id:
        return None

    agora_ts = time.time()
    cache_key = f"tms:{conta_ml}"
    if not forcar and cache_key in _TMS_ML_TOKEN_CACHE:
        tok, expira = _TMS_ML_TOKEN_CACHE[cache_key]
        if agora_ts < expira:
            return tok

    sessao = http or requests.Session()
    urls_tentar = _urls_candidatas_tms(base_url_orig)

    for base_url in urls_tentar:
        try:
            # 1. Login no TMS
            login_url = f"{base_url}/auth/login"
            resp_login = sessao.post(
                login_url,
                json={"name": user, "password": pwd},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                timeout=30,
            )
            if resp_login.status_code != 200:
                logger.warning(
                    f"[CONCILIACAO_ML] Falha no login do TMS ({base_url}): HTTP {resp_login.status_code}"
                )
                continue

            login_data = resp_login.json()
            token_tms = None
            if isinstance(login_data, dict):
                for k in ["token", "access_token", "accessToken", "jwt", "id_token"]:
                    if login_data.get(k):
                        token_tms = str(login_data[k]).strip()
                        break
            elif isinstance(login_data, str):
                token_tms = login_data.strip()

            if not token_tms:
                logger.warning(
                    f"[CONCILIACAO_ML] Retorno de login do TMS sem token (chaves={list(login_data.keys()) if isinstance(login_data, dict) else type(login_data).__name__})"
                )
                continue

            # 2. Buscar token ML da filial (id=3 Revesta, id=4 Campinas)
            tokens_url = f"{base_url}/tokens?id={token_id}"
            resp_token = sessao.get(
                tokens_url,
                headers={"Authorization": f"Bearer {token_tms}", "Accept": "application/json"},
                timeout=30,
            )
            if resp_token.status_code != 200:
                logger.warning(
                    f"[CONCILIACAO_ML] Falha ao obter token ML no TMS para {conta_ml} (id={token_id}): "
                    f"HTTP {resp_token.status_code}"
                )
                continue

            tok_data = resp_token.json()
            ml_token = None
            refresh_token = None
            if isinstance(tok_data, str):
                ml_token = tok_data.strip()
            elif isinstance(tok_data, list) and tok_data and isinstance(tok_data[0], dict):
                tok_data = tok_data[0]
            if isinstance(tok_data, dict):
                for k in ["access_token", "accessToken", "token", "ml_token", "access_token_ml", "valor", "value"]:
                    if tok_data.get(k):
                        val = str(tok_data[k]).strip()
                        if not val.startswith("TG-"):
                            ml_token = val
                            break
                for k in ["refresh_token", "refreshToken", "refresh"]:
                    if tok_data.get(k):
                        refresh_token = str(tok_data[k]).strip()
                        break

            if ml_token:
                _TMS_ML_TOKEN_CACHE[cache_key] = (ml_token, agora_ts + 7200)
                logger.info(f"[CONCILIACAO_ML] Token do Mercado Livre para {conta_ml} obtido com sucesso via TMS.")
                # Grava no disco para persistência
                try:
                    payload_disco = {
                        "access_token": ml_token,
                        "renovado_em": datetime.now(timezone.utc).isoformat(),
                        "expires_in": 21600,
                    }
                    if refresh_token:
                        payload_disco["refresh_token"] = refresh_token
                    salvar_ml_tokens_em_disco({conta_ml: payload_disco}, cfg)
                except Exception as e:
                    logger.debug(f"[CONCILIACAO_ML] Não foi possível persistir token no disco: {e}")
                return ml_token

            logger.warning(
                f"[CONCILIACAO_ML] Token ML não encontrado no payload do TMS para {conta_ml} (chaves={list(tok_data.keys()) if isinstance(tok_data, dict) else type(tok_data).__name__})"
            )
        except Exception as e:
            logger.warning(f"[CONCILIACAO_ML] Erro ao consultar tokens ML via TMS ({base_url}, {conta_ml}): {type(e).__name__}")

    return None


def sincronizar_tokens_ml_tms(cfg: Optional[Settings] = None, http: Any = None) -> Dict[str, Dict[str, Any]]:
    """
    Sincroniza os tokens de ambas as filiais (Revesta id=3 e Campinas id=4) via TMS em uma única sessão.
    Grava os dados em disco e atualiza o cache em memória.
    """
    cfg = cfg or settings
    if cfg.MOCK_MODE:
        agora_iso = datetime.now(timezone.utc).isoformat()
        res_mock = {
            "norvia": {
                "access_token": "mock-token-norvia",
                "renovado_em": agora_iso,
                "expires_in": 21600,
            },
            "revesta": {
                "access_token": "mock-token-revesta",
                "renovado_em": agora_iso,
                "expires_in": 21600,
            },
        }
        salvar_ml_tokens_em_disco(res_mock, cfg)
        _TMS_ML_TOKEN_CACHE["tms:norvia"] = ("mock-token-norvia", time.time() + 7200)
        _TMS_ML_TOKEN_CACHE["tms:revesta"] = ("mock-token-revesta", time.time() + 7200)
        return res_mock

    base_url_orig, user, pwd = obter_credenciais_tms(cfg)
    if not (user and pwd):
        return {}

    sessao = http or requests.Session()
    urls_tentar = _urls_candidatas_tms(base_url_orig)
    resultado: Dict[str, Dict[str, Any]] = {}

    for base_url in urls_tentar:
        try:
            resp_login = sessao.post(
                f"{base_url}/auth/login",
                json={"name": user, "password": pwd},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                timeout=30,
            )
            if resp_login.status_code != 200:
                continue

            login_data = resp_login.json()
            token_tms = None
            if isinstance(login_data, dict):
                for k in ["token", "access_token", "accessToken", "jwt", "id_token"]:
                    if login_data.get(k):
                        token_tms = str(login_data[k]).strip()
                        break
            elif isinstance(login_data, str):
                token_tms = login_data.strip()

            if not token_tms:
                continue

            agora_iso = datetime.now(timezone.utc).isoformat()
            agora_ts = time.time()

            for conta, token_id in (("revesta", 3), ("norvia", 4)):
                try:
                    resp_tok = sessao.get(
                        f"{base_url}/tokens?id={token_id}",
                        headers={"Authorization": f"Bearer {token_tms}", "Accept": "application/json"},
                        timeout=30,
                    )
                    if resp_tok.status_code != 200:
                        continue
                    td = resp_tok.json()
                    if isinstance(td, list) and td and isinstance(td[0], dict):
                        td = td[0]
                    acc, ref = None, None
                    if isinstance(td, dict):
                        for k in ["access_token", "accessToken", "token", "ml_token", "access_token_ml", "valor", "value"]:
                            if td.get(k):
                                v = str(td[k]).strip()
                                if not v.startswith("TG-"):
                                    acc = v
                                    break
                        for k in ["refresh_token", "refreshToken", "refresh"]:
                            if td.get(k):
                                ref = str(td[k]).strip()
                                break
                    elif isinstance(td, str):
                        acc = td.strip()

                    if acc:
                        resultado[conta] = {
                            "access_token": acc,
                            "renovado_em": agora_iso,
                            "expires_in": 21600,
                        }
                        if ref:
                            resultado[conta]["refresh_token"] = ref
                        _TMS_ML_TOKEN_CACHE[f"tms:{conta}"] = (acc, agora_ts + 7200)
                except Exception as e:
                    logger.warning(f"[CONCILIACAO_ML] Erro ao buscar token filial {conta} (id={token_id}): {type(e).__name__}")

            if resultado:
                salvar_ml_tokens_em_disco(resultado, cfg)
                logger.info(
                    f"[CONCILIACAO_ML] Tokens sincronizados via TMS com sucesso para: {list(resultado.keys())}."
                )
                return resultado
        except Exception as e:
            logger.warning(f"[CONCILIACAO_ML] Erro na tentativa de sincronizar tokens via TMS ({base_url}): {type(e).__name__}")

    return resultado



def renovar_token_ml_oauth(
    conta_ml: str,
    refresh_token: str,
    cfg: Optional[Settings] = None,
    http: Any = None,
) -> Optional[Dict[str, Any]]:
    """
    Renova access token via OAuth direto do Mercado Livre (POST /oauth/token)
    usando refresh_token e client_id/client_secret se configurados.
    Desligado por padrão (SA-07); só executa se ML_OAUTH_RENOVACAO_PROPRIA=True.
    """
    cfg = cfg or settings
    if not getattr(cfg, "ML_OAUTH_RENOVACAO_PROPRIA", False):
        return None

    if getattr(cfg, "MOCK_MODE", False):
        agora_iso = datetime.now(timezone.utc).isoformat()
        return {
            "access_token": f"mock-token-{conta_ml}",
            "refresh_token": f"mock-refresh-{conta_ml}",
            "expires_in": 21600,
            "user_id": 123456,
            "renovado_em": agora_iso,
        }

    client_id = {
        "norvia": cfg.ML_NORVIA_CLIENT_ID,
        "revesta": cfg.ML_REVESTA_CLIENT_ID,
    }.get(conta_ml) or cfg.ML_CLIENT_ID or os.environ.get("ML_CLIENT_ID")
    client_secret = {
        "norvia": cfg.ML_NORVIA_CLIENT_SECRET,
        "revesta": cfg.ML_REVESTA_CLIENT_SECRET,
    }.get(conta_ml) or cfg.ML_CLIENT_SECRET or os.environ.get("ML_CLIENT_SECRET")

    if not (client_id and client_secret and refresh_token):
        return None

    sessao = http or requests.Session()
    url = f"{cfg.ML_API_URL.rstrip('/')}/oauth/token"
    try:
        resp = sessao.post(
            url,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            },
            timeout=30,
        )
        if resp.status_code == 200:
            dados = resp.json()
            if dados.get("access_token"):
                agora_iso = datetime.now(timezone.utc).isoformat()
                dados_atualizados = {
                    "access_token": str(dados["access_token"]).strip(),
                    "refresh_token": str(dados.get("refresh_token") or refresh_token).strip(),
                    "expires_in": dados.get("expires_in", 21600),
                    "user_id": dados.get("user_id"),
                    "renovado_em": agora_iso,
                }
                salvar_ml_tokens_em_disco({conta_ml: dados_atualizados}, cfg)
                logger.info(f"[CONCILIACAO_ML] Token do Mercado Livre renovado via OAuth direto para {conta_ml}.")
                return dados_atualizados
        logger.warning(
            f"[CONCILIACAO_ML] Falha na renovação OAuth direta do ML para {conta_ml}: "
            f"HTTP {resp.status_code} - {resp.text[:200]}"
        )
    except Exception as e:
        logger.warning(f"[CONCILIACAO_ML] Erro na renovação OAuth direta do ML ({conta_ml}): {e}")
    return None


def renovar_token_ml(conta_ml: str, cfg: Optional[Settings] = None, forcar: bool = True) -> Optional[str]:
    """
    Renova o token da conta do Mercado Livre de forma transparente:
    1. Se MOCK_MODE, devolve mock imediatamente.
    2. Invalida cache em memória se forcar=True
    3. Tenta sincronizar via TMS (atualiza disco)
    4. Se TMS falhar ou indisponível, tenta renovar via OAuth direto caso haja refresh_token e credenciais
    5. Devolve o novo access_token ou None.
    """
    cfg = cfg or settings
    if getattr(cfg, "MOCK_MODE", False):
        return f"mock-token-{conta_ml}"

    with _RENOVA_ML_LOCK:
        if forcar:
            _TMS_ML_TOKEN_CACHE.pop(f"tms:{conta_ml}", None)

        # 1. Tenta via TMS
        try:
            tokens_tms = sincronizar_tokens_ml_tms(cfg)
            if tokens_tms and conta_ml in tokens_tms:
                acc = tokens_tms[conta_ml].get("access_token")
                if acc:
                    return str(acc)
            # Fallback direto unitário
            tok_unitario = obter_token_ml_tms(conta_ml, cfg, forcar=forcar)
            if tok_unitario:
                return tok_unitario
        except Exception as e:
            logger.warning(f"[CONCILIACAO_ML] Falha ao renovar via TMS ({conta_ml}): {e}")

        # 2. Tenta via OAuth direto caso haja refresh_token e flag esteja ligada
        if getattr(cfg, "ML_OAUTH_RENOVACAO_PROPRIA", False):
            ref_token = None
            for arq in _candidatos_ml_tokens_files(cfg):
                if arq.is_file():
                    try:
                        d = json.loads(arq.read_text(encoding="utf-8"))
                        ref_token = ((d or {}).get(conta_ml) or {}).get("refresh_token")
                        if ref_token:
                            break
                    except Exception:
                        pass

            if ref_token:
                dados_oauth = renovar_token_ml_oauth(conta_ml, ref_token, cfg)
                if dados_oauth and dados_oauth.get("access_token"):
                    return str(dados_oauth["access_token"])

    return None


def sincronizar_todos_tokens_ml(cfg: Optional[Settings] = None, forcar: bool = False) -> Dict[str, Dict[str, Any]]:
    """Sincroniza tokens de ambas as filiais via TMS ou OAuth direto."""
    cfg = cfg or settings
    if getattr(cfg, "MOCK_MODE", False):
        return {
            "norvia": {"access_token": "mock-token-norvia"},
            "revesta": {"access_token": "mock-token-revesta"},
        }

    with _RENOVA_ML_LOCK:
        if forcar:
            _TMS_ML_TOKEN_CACHE.clear()

        # Tenta TMS primeiro
        res = sincronizar_tokens_ml_tms(cfg)
        if res:
            return res

        # Tenta OAuth individual por conta se TMS não configurado
        resultado: Dict[str, Dict[str, Any]] = {}
        for conta in ("norvia", "revesta"):
            tok = renovar_token_ml(conta, cfg, forcar=forcar)
            if tok:
                resultado[conta] = {"access_token": tok}

        return resultado


def token_ml(conta_ml: str, cfg: Optional[Settings] = None) -> Optional[str]:
    """
    Access token do Mercado Livre:
    1. Se MOCK_MODE, devolve mock imediatamente.
    2. Lê ml_tokens.json:
       - Se existir e estiver dentro do prazo de validade, devolve.
       - Se existir mas estiver expirado, dispara renovação automática proativa.
    3. Se não existir no disco, tenta consultar o TMS ou renovar via OAuth.
    4. Fallback estático para variáveis de ambiente .env.
    """
    cfg = cfg or settings
    if getattr(cfg, "MOCK_MODE", False):
        return f"mock-token-{conta_ml}"

    vencido_em: Optional[Path] = None
    for arquivo in _candidatos_ml_tokens_files(cfg):
        try:
            if arquivo.is_file():
                dados = json.loads(arquivo.read_text(encoding="utf-8"))
                dados_conta = (dados or {}).get(conta_ml)
                if isinstance(dados_conta, dict) and dados_conta.get("access_token"):
                    if token_esta_valido(dados_conta):
                        return str(dados_conta["access_token"])
                    vencido_em = vencido_em or arquivo
        except Exception as e:
            logger.debug(f"[CONCILIACAO_ML] Erro ao ler {arquivo}: {e}")

    if vencido_em is not None:
        logger.info(f"[CONCILIACAO_ML] Token do Mercado Livre para {conta_ml} expirado ({vencido_em}). Renovando...")
        # SA-08: Nunca devolver token vencido após falha de renovação
        return renovar_token_ml(conta_ml, cfg, forcar=True)

    # Fallback para token estático explicitamente configurado no .env / Settings
    env_tok = {"norvia": cfg.ML_NORVIA_ACCESS_TOKEN, "revesta": cfg.ML_REVESTA_ACCESS_TOKEN}.get(conta_ml)
    if env_tok:
        return env_tok

    # Fallback para consulta dinâmica no TMS se credenciais estiverem configuradas
    if cfg.TMS_USER and cfg.TMS_PASSWORD:
        token_tms = obter_token_ml_tms(conta_ml, cfg)
        if token_tms:
            return token_tms

    # Tenta renovar via qualquer credencial disponível
    novo = renovar_token_ml(conta_ml, cfg, forcar=True)
    if novo:
        return novo

    return None


_MP_OAUTH_TOKEN_CACHE: Dict[str, Tuple[str, float]] = {}


def obter_token_oauth_mp(
    empresa_id: str,
    client_id: str,
    client_secret: str,
    base_url: str = "https://api.mercadopago.com",
    http: Any = None,
) -> Optional[str]:
    """
    Obtém ou renova token de acesso do Mercado Pago usando OAuth2 Client Credentials
    (POST /oauth/token). Mantém cache em memória respeitando expires_in.
    """
    agora_ts = time.time()
    cache_key = f"{empresa_id}:{client_id}"
    if cache_key in _MP_OAUTH_TOKEN_CACHE:
        token, expira_em = _MP_OAUTH_TOKEN_CACHE[cache_key]
        if agora_ts < (expira_em - 300):  # 5 minutos de margem de segurança
            return token

    url = f"{base_url.rstrip('/')}/oauth/token"
    payload = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    sessao = http or requests.Session()
    try:
        resp = sessao.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code == 200:
            dados = resp.json()
            access_token = dados.get("access_token")
            expires_in = dados.get("expires_in", 21600)
            if access_token:
                _MP_OAUTH_TOKEN_CACHE[cache_key] = (str(access_token), agora_ts + float(expires_in))
                logger.info(f"[CONCILIACAO_ML] Token OAuth do Mercado Pago renovado com sucesso para {empresa_id}.")
                return str(access_token)
        logger.warning(
            f"[CONCILIACAO_ML] Falha ao renovar token OAuth do Mercado Pago para {empresa_id}: "
            f"HTTP {resp.status_code} - {resp.text[:200]}"
        )
    except Exception as e:
        logger.warning(f"[CONCILIACAO_ML] Erro de rede ao requisitar token OAuth do Mercado Pago ({empresa_id}): {e}")
    return None


def token_mp(
    empresa_id: str,
    conta_ml: str,
    cfg: Optional[Settings] = None,
    permitir_fallback_ml: bool = True,
) -> Optional[str]:
    """
    Credencial do Mercado Pago:
    1. OAuth via client_id e client_secret (renovação automática via POST /oauth/token);
    2. Fallback para token estático legado de produção (MP_*_ACCESS_TOKEN);
    3. Fallback para token do Mercado Livre da mesma conta (token_ml) se permitir_fallback_ml=True.
    """
    cfg = cfg or settings
    oauth_creds = {
        "norvia_campinas": (cfg.MP_NORVIA_CAMPINAS_CLIENT_ID, cfg.MP_NORVIA_CAMPINAS_CLIENT_SECRET),
        "revesta": (cfg.MP_REVESTA_CLIENT_ID, cfg.MP_REVESTA_CLIENT_SECRET),
    }.get(empresa_id)

    if oauth_creds and oauth_creds[0] and oauth_creds[1]:
        token_oauth = obter_token_oauth_mp(empresa_id, oauth_creds[0], oauth_creds[1], cfg.MP_API_URL)
        if token_oauth:
            return token_oauth

    proprio = {
        "norvia_campinas": cfg.MP_NORVIA_CAMPINAS_ACCESS_TOKEN,
        "revesta": cfg.MP_REVESTA_ACCESS_TOKEN,
    }.get(empresa_id)
    if proprio:
        return proprio

    if permitir_fallback_ml:
        return token_ml(conta_ml, cfg)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# HTTP com retentativa
# ─────────────────────────────────────────────────────────────────────────────


class _ClienteHTTP:
    nome = "API"

    def __init__(
        self,
        base_url: str,
        obter_token: Callable[[], Optional[str]],
        http: Any = None,
        renovar_token: Optional[Callable[[], Optional[str]]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._obter_token = obter_token
        self.http = http or requests.Session()
        self._renovar_token = renovar_token

    def _token(self) -> str:
        token = self._obter_token()
        if not token:
            raise SemCredencial(f"Sem access token do {self.nome}.")
        return token

    def _chamar(self, metodo: str, caminho: str, descricao: str, bruto: bool = False, **kwargs: Any) -> Any:
        renovacao_tentada = False
        for tentativa in (1, 2, 3):
            token_atual = self._token()
            headers = {"Authorization": f"Bearer {token_atual}", "Accept": "application/json"}
            try:
                resp = self.http.request(metodo, f"{self.base_url}{caminho}", headers=headers, timeout=60, **kwargs)
            except requests.RequestException as e:
                if tentativa == 3:
                    raise APIMercadoError(f"{self.nome}: falha de rede ao {descricao}: {e}") from e
                time.sleep(3 * tentativa)
                continue
            if resp.status_code == 401:
                if not renovacao_tentada and self._renovar_token:
                    renovacao_tentada = True
                    logger.warning(
                        f"[CONCILIACAO_ML] {self.nome}: token expirado ou inválido (HTTP 401) ao {descricao}. "
                        "Tentando renovar automaticamente..."
                    )
                    novo_tok = self._renovar_token()
                    if novo_tok and novo_tok != token_atual:
                        logger.info(f"[CONCILIACAO_ML] {self.nome}: token renovado com sucesso! Repetindo requisição...")
                        continue
                raise SemCredencial(
                    f"{self.nome}: token expirado ou inválido (HTTP 401) ao {descricao}.", resp.status_code
                )
            if resp.status_code == 403:
                raise SemCredencial(
                    f"{self.nome}: token sem permissão (HTTP 403) ao {descricao}: {resp.text[:200]}", resp.status_code
                )
            if (resp.status_code == 429 or resp.status_code >= 500) and tentativa < 3:
                time.sleep(5 * tentativa)
                continue
            if not 200 <= resp.status_code < 300:
                raise APIMercadoError(
                    f"{self.nome}: falha ao {descricao}: HTTP {resp.status_code} - {resp.text[:300]}", resp.status_code
                )
            if bruto:
                return resp
            return resp.json() if resp.content else {}
        raise APIMercadoError(f"{self.nome}: sem resposta válida ao {descricao}.")


# ─────────────────────────────────────────────────────────────────────────────
# Mercado Pago — relatório de Liberações
# ─────────────────────────────────────────────────────────────────────────────


def _iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def limites_periodo(de: date, ate: date) -> tuple:
    """Período em datas de São Paulo -> (início, fim) em UTC para a API (fim inclusivo, 23:59:59 SP)."""
    inicio = datetime(de.year, de.month, de.day, tzinfo=FUSO_SP)
    fim = datetime(ate.year, ate.month, ate.day, 23, 59, 59, tzinfo=FUSO_SP)
    return _iso_utc(inicio), _iso_utc(fim)


def ler_csv_liberacoes(conteudo: bytes) -> List[Dict[str, str]]:
    """CSV do relatório -> linhas com as chaves em maiúsculas (separador detectado)."""
    texto = conteudo.decode("utf-8-sig", errors="replace")
    if not texto.strip():
        return []
    try:
        dialeto = csv.Sniffer().sniff(texto[:4096], delimiters=";,\t")
    except csv.Error:
        dialeto = csv.excel
    leitor = csv.reader(io.StringIO(texto), dialeto)
    linhas = [l for l in leitor]
    if not linhas:
        return []
    cabecalho = [c.strip().upper() for c in linhas[0]]
    faltando = [c for c in COLUNAS_OBRIGATORIAS if c not in cabecalho]
    if faltando:
        raise APIMercadoError(
            "Relatório de liberações sem as colunas esperadas "
            f"({', '.join(faltando)}). Cabeçalho recebido: {', '.join(cabecalho[:25])}"
        )
    registros = []
    for valores in linhas[1:]:
        if not any(v.strip() for v in valores):
            continue
        registros.append({col: (valores[i].strip() if i < len(valores) else "") for i, col in enumerate(cabecalho) if col})
    return registros


class ClienteMercadoPago(_ClienteHTTP):
    nome = "Mercado Pago"

    def __init__(self, empresa_id: str, obter_token: Callable[[], Optional[str]], http: Any = None,
                 base_url: Optional[str] = None, cfg: Optional[Settings] = None,
                 dormir: Callable[[float], None] = time.sleep,
                 renovar_token: Optional[Callable[[], Optional[str]]] = None) -> None:
        self.cfg = cfg or settings
        self.empresa_id = empresa_id
        self._dormir = dormir
        renovador = renovar_token or (lambda: self._renovar_oauth())
        super().__init__(base_url or self.cfg.MP_API_URL, obter_token, http, renovar_token=renovador)

    def _renovar_oauth(self) -> Optional[str]:
        for k in list(_MP_OAUTH_TOKEN_CACHE.keys()):
            if k.startswith(f"{self.empresa_id}:"):
                _MP_OAUTH_TOKEN_CACHE.pop(k, None)
        return self._obter_token()

    def garantir_configuracao(self) -> None:
        """
        Configura o relatório de Liberações com as colunas que a conciliação lê. Uma configuração
        que já exista (feita no site, por exemplo) é atualizada só nas colunas e no fuso.
        """
        corpo = {
            "columns": [{"key": c} for c in COLUNAS_LIBERACOES],
            "file_name_prefix": f"conciliacao-ml-{self.empresa_id.replace('_', '-')}",
            "display_timezone": "GMT-03",
            "frequency": {"hour": 0, "type": "monthly", "value": 1},
        }
        try:
            atual = self._chamar("GET", "/v1/account/release_report/config", "ler a configuração do relatório de liberações")
        except APIMercadoError as e:
            if e.status != 404:
                raise
            atual = None
        if not atual:
            self._chamar("POST", "/v1/account/release_report/config", "configurar o relatório de liberações", json=corpo)
            return
        chaves = {str((c or {}).get("key")) for c in (atual.get("columns") or [])}
        if set(COLUNAS_LIBERACOES) <= chaves and atual.get("display_timezone") == "GMT-03":
            return
        atualizado = {**atual, "columns": corpo["columns"], "display_timezone": "GMT-03"}
        self._chamar("PUT", "/v1/account/release_report/config", "atualizar a configuração do relatório de liberações", json=atualizado)

    def _listar(self) -> List[Dict[str, Any]]:
        resposta = self._chamar("GET", "/v1/account/release_report/list", "listar os relatórios de liberações")
        return resposta if isinstance(resposta, list) else (resposta.get("results") or [])

    def liberacoes(self, de: date, ate: date, progresso: Optional[Progresso] = None) -> List[Dict[str, str]]:
        """Gera o relatório do período (datas de São Paulo), espera ficar pronto e devolve as linhas."""
        self.garantir_configuracao()
        inicio, fim = limites_periodo(de, ate)
        pedido_em = datetime.now(timezone.utc) - timedelta(minutes=2)
        criado = self._chamar(
            "POST", "/v1/account/release_report", "pedir o relatório de liberações",
            json={"begin_date": inicio, "end_date": fim},
        ) or {}
        relatorio_id = criado.get("id") if isinstance(criado, dict) else None

        # Se a API já devolveu o arquivo pronto na criação
        if isinstance(criado, dict):
            nome_imediato = criado.get("file_name") or criado.get("fileName")
            status_imediato = str(criado.get("status") or "").lower()
            if nome_imediato and (
                status_imediato in ("processed", "ready", "available", "completed", "done", "finished", "ok", "success")
                or not status_imediato
            ):
                logger.info(f"[CONCILIACAO_ML] [{self.empresa_id}] Relatório devolvido imediatamente no POST: {nome_imediato}")
                resp = self._chamar(
                    "GET", f"/v1/account/release_report/{nome_imediato}", "baixar o relatório de liberações", bruto=True
                )
                return ler_csv_liberacoes(resp.content)

        limite = time.monotonic() + self.cfg.ML_RECONCILIATION_RELATORIO_TIMEOUT_SECONDS
        espera = 10.0
        inicio_espera = time.monotonic()
        while True:
            arquivo = self._achar_arquivo(relatorio_id, inicio, fim, pedido_em)
            if arquivo:
                logger.info(f"[CONCILIACAO_ML] [{self.empresa_id}] Baixando relatório de liberações: {arquivo}")
                resp = self._chamar(
                    "GET", f"/v1/account/release_report/{arquivo}", "baixar o relatório de liberações", bruto=True
                )
                return ler_csv_liberacoes(resp.content)
            if time.monotonic() > limite:
                raise APIMercadoError(
                    f"Mercado Pago: o relatório de liberações de {de:%d/%m/%Y} a {ate:%d/%m/%Y} não ficou pronto em "
                    f"{self.cfg.ML_RECONCILIATION_RELATORIO_TIMEOUT_SECONDS // 60} min."
                )
            decorrido = int(time.monotonic() - inicio_espera)
            logger.info(
                f"[CONCILIACAO_ML] [{self.empresa_id}] Aguardando Mercado Pago processar relatório "
                f"(id={relatorio_id}, decorrido={decorrido}s)..."
            )
            if progresso:
                progresso(f"Aguardando o Mercado Pago gerar o relatório de liberações ({decorrido}s)")
            self._dormir(espera)
            espera = min(espera * 1.5, 60.0)

    def _achar_relatorio_existente(self, inicio: str, fim: str) -> Optional[str]:
        """Busca se já há um relatório concluído para o período gerado nas últimas 24 horas."""
        limite_recente = datetime.now(timezone.utc) - timedelta(hours=24)
        for item in self._listar():
            nome = item.get("file_name") or item.get("fileName") or item.get("name")
            status = str(item.get("status") or item.get("report_status") or "").lower()
            if not nome or (status and status not in ("processed", "ready", "available", "completed", "done", "finished", "ok", "success")):
                continue
            mesmo_periodo = _mesmo_instante(item.get("begin_date"), inicio) and _mesmo_instante(item.get("end_date"), fim)
            criado = _parse_dt(item.get("date_created") or item.get("generation_date"))
            if mesmo_periodo and (criado is None or criado >= limite_recente):
                return str(nome)
        return None

    def _consultar_task(self, task_id: Any) -> Optional[str]:
        """Consulta o status da tarefa no endpoint específico /v1/account/release_report/task/{id}."""
        if not task_id:
            return None
        try:
            task = self._chamar("GET", f"/v1/account/release_report/task/{task_id}", f"consultar status da tarefa {task_id}")
            if isinstance(task, dict):
                status = str(task.get("status") or "").lower()
                nome = task.get("file_name") or task.get("fileName") or task.get("name")
                logger.info(f"[CONCILIACAO_ML] [{self.empresa_id}] Tarefa {task_id}: status='{status}', arquivo={nome}")
                if status in ("error", "failed", "rejected"):
                    raise APIMercadoError(f"Mercado Pago: geração do relatório falhou na tarefa {task_id} (status: {status}).")
                if nome and status in ("processed", "ready", "available", "completed", "done", "finished", "ok", "success", ""):
                    return str(nome)
        except APIMercadoError:
            raise
        except Exception as e:
            logger.debug(f"[CONCILIACAO_ML] [{self.empresa_id}] Consulta de task {task_id} não disponível: {e}")
        return None

    def _achar_arquivo(self, relatorio_id: Any, inicio: str, fim: str, pedido_em: datetime) -> Optional[str]:
        # 1. Busca na listagem de relatórios da conta
        itens = self._listar()
        amostra = [
            f"id={it.get('id')}|st={it.get('status') or it.get('report_status')}|arq={it.get('file_name') or it.get('fileName')}"
            for it in itens[:3]
        ]
        logger.info(
            f"[CONCILIACAO_ML] [{self.empresa_id}] Verificando {len(itens)} relatórios na lista do Mercado Pago. "
            f"Recentes: {amostra}"
        )
        for item in itens:
            nome = item.get("file_name") or item.get("fileName") or item.get("name")
            status = str(item.get("status") or item.get("report_status") or "").lower()
            item_id = item.get("id")

            # Correspondência por ID da tarefa ou do relatório
            if relatorio_id is not None and item_id is not None and str(item_id) == str(relatorio_id):
                if status in ("error", "failed", "rejected"):
                    raise APIMercadoError(f"Mercado Pago: o relatório {relatorio_id} falhou com status '{status}'.")
                if nome and (
                    status in ("processed", "ready", "available", "completed", "done", "finished", "ok", "success")
                    or not status
                ):
                    return str(nome)

            # Correspondência por período
            if not nome:
                continue
            if status and status not in ("processed", "ready", "available", "completed", "done", "finished", "ok", "success"):
                continue
            mesmo_periodo = _mesmo_instante(item.get("begin_date"), inicio) and _mesmo_instante(item.get("end_date"), fim)
            criado = _parse_dt(item.get("date_created") or item.get("generation_date"))
            if mesmo_periodo and (criado is None or criado >= pedido_em - timedelta(minutes=5)):
                return str(nome)

        # 2. Se não achou na listagem, tenta consulta direta da tarefa (se a conta suportar)
        return self._consultar_task(relatorio_id)


def _parse_dt(texto: Any) -> Optional[datetime]:
    if not texto:
        return None
    try:
        dt = datetime.fromisoformat(str(texto).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _mesmo_instante(a: Any, b: str) -> bool:
    da, db = _parse_dt(a), _parse_dt(b)
    if not da or not db:
        return False
    return abs((da - db).total_seconds()) <= 60



# ─────────────────────────────────────────────────────────────────────────────
# Mercado Livre — pedidos
# ─────────────────────────────────────────────────────────────────────────────


class ClienteMercadoLivre(_ClienteHTTP):
    nome = "Mercado Livre"
    LIMITE_PAGINA = 50
    # A busca por offset do ML não passa de ~10 mil registros: o período vai em janelas curtas.
    JANELA_DIAS = 7

    def __init__(self, conta_ml: str, obter_token: Callable[[], Optional[str]], http: Any = None,
                 base_url: Optional[str] = None, cfg: Optional[Settings] = None,
                 renovar_token: Optional[Callable[[], Optional[str]]] = None) -> None:
        self.cfg = cfg or settings
        self.conta_ml = conta_ml
        renovador = renovar_token or (lambda: renovar_token_ml(self.conta_ml, self.cfg, forcar=True))
        super().__init__(base_url or self.cfg.ML_API_URL, obter_token, http, renovar_token=renovador)
        self._user_id: Optional[int] = None

    def user_id(self) -> int:
        if self._user_id is None:
            self._user_id = int(self._chamar("GET", "/users/me", "identificar a conta")["id"])
        return self._user_id

    def pedidos(self, de: date, ate: date, progresso: Optional[Progresso] = None) -> List[Dict[str, Any]]:
        """Pedidos criados no período (datas de São Paulo), de todas as situações."""
        vendedor = self.user_id()
        pedidos: Dict[str, Dict[str, Any]] = {}
        janela_ini = de
        while janela_ini <= ate:
            janela_fim = min(ate, janela_ini + timedelta(days=self.JANELA_DIAS - 1))
            inicio = datetime(janela_ini.year, janela_ini.month, janela_ini.day, tzinfo=FUSO_SP)
            fim = datetime(janela_fim.year, janela_fim.month, janela_fim.day, 23, 59, 59, 999000, tzinfo=FUSO_SP)
            offset = 0
            while True:
                if progresso:
                    progresso(f"Lendo vendas do Mercado Livre de {janela_ini:%d/%m} a {janela_fim:%d/%m} ({len(pedidos)} lidas)")
                pagina = self._chamar(
                    "GET", "/orders/search", "listar os pedidos",
                    params={
                        "seller": vendedor,
                        "order.date_created.from": inicio.isoformat(timespec="milliseconds"),
                        "order.date_created.to": fim.isoformat(timespec="milliseconds"),
                        "sort": "date_asc",
                        "limit": self.LIMITE_PAGINA,
                        "offset": offset,
                    },
                )
                resultados = pagina.get("results") or []
                for p in resultados:
                    pedidos[str(p.get("id"))] = p
                total = int(((pagina.get("paging") or {}).get("total")) or 0)
                offset += self.LIMITE_PAGINA
                if not resultados or offset >= total:
                    break
            janela_ini = janela_fim + timedelta(days=1)
        return list(pedidos.values())

    def pedido(self, pedido_id: str) -> Optional[Dict[str, Any]]:
        try:
            return self._chamar("GET", f"/orders/{pedido_id}", f"buscar o pedido {pedido_id}")
        except APIMercadoError as e:
            if e.status == 404:
                try:
                    pack = self._chamar("GET", f"/packs/{pedido_id}", f"buscar o pacote {pedido_id}")
                    if pack and isinstance(pack, dict):
                        orders = pack.get("orders") or []
                        if orders:
                            primeira = orders[0]
                            if isinstance(primeira, dict):
                                if not primeira.get("pack_id"):
                                    primeira["pack_id"] = pedido_id
                                return primeira
                            elif isinstance(primeira, (str, int)):
                                p_obj = self.pedido(str(primeira))
                                if p_obj:
                                    p_obj["pack_id"] = pedido_id
                                    return p_obj
                except Exception:
                    pass
                return None
            raise
