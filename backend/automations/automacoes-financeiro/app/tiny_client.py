import argparse
import json
import logging
import re
import sys
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import requests

from app.categorization import GroupedLancamento
from app.config import settings
from app.http_errors import sufixo_erro
from app.json_store import SECRET_FILE_MODE, write_json_atomic
from app.nfe_client import NFeData, NFeDuplicate, calculate_marker_vencimento
from app.tiny_categories import CATEGORY_BY_ID, TINY_CATEGORIES, _normalize
from app.token_repository import TokenRepository


logger = logging.getLogger(__name__)

# Configurações padronizadas de timeout para o Tiny ERP v3 (connect_timeout, read_timeout)
DEFAULT_TINY_TIMEOUT: Tuple[float, float] = (5.0, 25.0)
DEFAULT_TINY_QUERY_TIMEOUT: Tuple[float, float] = (5.0, 15.0)

# Intervalo mínimo entre chamadas consecutivas à API REST do Tiny v3 (/public-api/v3/...),
# em TODO o processo — não só dentro de uma instância de TinyClient (que é criada nova a
# cada chamada em vários pontos, ex.: already_launched_in_tiny). Protege contra bloqueio
# por volume de requisições quando muitas notas são processadas em sequência: varredura
# SEFAZ (uma checagem de duplicidade por nota nova) e "Confirmar e Enviar" em lote (um
# lançamento por nota, sem pausa nenhuma entre elas). Incidente real 2026-09-18: HTTP 403
# SEM corpo de erro do Tiny (típico de bloqueio de infraestrutura/rate-limit, não de
# validação de payload) em notas completamente diferentes — uma duplicata de verdade e
# duas que não eram — na mesma sessão de lançamento em lote.
_TINY_API_MIN_INTERVAL_SECONDS = 0.5
_tiny_api_lock = threading.Lock()
_tiny_api_last_call_at = 0.0


def _throttle_tiny_api_call() -> None:
    global _tiny_api_last_call_at
    with _tiny_api_lock:
        now = time.monotonic()
        elapsed = now - _tiny_api_last_call_at
        if elapsed < _TINY_API_MIN_INTERVAL_SECONDS:
            time.sleep(_TINY_API_MIN_INTERVAL_SECONDS - elapsed)
        _tiny_api_last_call_at = time.monotonic()


# Intervalo mínimo próprio (bem mais folgado que o de cima) para a varredura em massa do
# dashboard financeiro (_fetch_paginated_v3_itens): ~260 chamadas (65 categorias x 4
# empresas) em sequência. Incidente real em produção (2026-09-21): com 1,5s (0,67 req/s),
# uma sincronização real fez ~38 chamadas bem-sucedidas em 58s antes do Tiny começar a
# devolver HTTP 429 — sugere um "estoque" de rajada de ~40 requisições e um limite
# sustentado abaixo de 0,67 req/s. 2,0s (0,5 req/s) dá mais margem; o retry com backoff
# em HTTP 429 (abaixo) é a rede de segurança de verdade caso ainda assim esbarre no
# limite. Mantido separado do throttle de lançamento de NF-e acima para não deixar aquele
# fluxo (que já funciona bem) mais lento por causa de um problema específico deste sync.
_TINY_DASHBOARD_MIN_INTERVAL_SECONDS = 2.0
# O intervalo vale POR CONTA do Tiny (chave = token): o limite do Tiny é da conta, e cada
# filial tem a sua. Com uma fila única para o processo, a prévia de Contas a Pagar esperava
# 2s por página somando todas as filiais, uma depois da outra (2026-09-28).
_tiny_dashboard_lock = threading.Lock()
_tiny_dashboard_key_locks: Dict[str, threading.Lock] = {}
_tiny_dashboard_last_call: Dict[str, float] = {}

# HTTP 429 é rate-limit de verdade (diferente do 403 vazio, que é permissão — ver
# comentário mais abaixo): se resolve sozinho com tempo, então vale a pena esperar e
# tentar de novo (backoff crescente) em vez de desistir na primeira falha.
_TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES = 4
_TINY_DASHBOARD_RATE_LIMIT_BASE_WAIT_SECONDS = 20.0

# Depois de N respostas seguidas de HTTP 403 sem corpo (assinatura de permissão/escopo
# OAuth ausente, não bloqueio temporário — backoff não ajuda), para de insistir: é um
# problema que só se resolve ajustando o escopo do aplicativo no Tiny ERP.
_TINY_DASHBOARD_MAX_CONSECUTIVE_BLOCK_FAILURES = 5

# Falha de rede/DNS (não é resposta HTTP nenhuma — requests levanta exceção antes disso)
# durante o sync do dashboard: incidente real 2026-09-21, a VPS ficou alguns segundos sem
# conseguir resolver api.tiny.com.br (rede/DNS do host, não o Tiny) no meio de uma
# sincronização real. Costuma ser um blip curto, então vale tentar de novo com backoff
# curto antes de desistir daquela página.
_TINY_DASHBOARD_MAX_NETWORK_RETRIES = 3
_TINY_DASHBOARD_NETWORK_RETRY_BASE_WAIT_SECONDS = 5.0


def _throttle_tiny_dashboard_call(conta: str = "") -> None:
    """Espera o intervalo mínimo desde a última chamada da mesma conta (`conta` = token)."""
    with _tiny_dashboard_lock:
        lock = _tiny_dashboard_key_locks.setdefault(conta, threading.Lock())
    with lock:
        elapsed = time.monotonic() - _tiny_dashboard_last_call.get(conta, float("-inf"))
        if elapsed < _TINY_DASHBOARD_MIN_INTERVAL_SECONDS:
            time.sleep(_TINY_DASHBOARD_MIN_INTERVAL_SECONDS - elapsed)
        _tiny_dashboard_last_call[conta] = time.monotonic()


TINY_V3_DEFAULT_HEADERS: Dict[str, str] = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; NorviaAutomacao/1.0; +https://norvia.example)",
}

# Tamanho máximo do filtro nomeCliente em GET /contas-receber da API v3 do Tiny.
NOME_CLIENTE_MAX_TINY = 50


class TinyAPIError(Exception):
    """Exceção levantada em caso de erro retornado pela API do Tiny ERP."""

    def __init__(self, message: str, errors: Optional[List[str]] = None, is_duplicate: bool = False) -> None:
        super().__init__(message)
        self.errors = errors or []
        self.is_duplicate = is_duplicate


@dataclass
class TinyContaResult:
    """Resultado do lançamento de uma conta a pagar no Tiny."""
    conta_id: int
    nro_documento: str
    valor: Decimal
    vencimento: date
    situacao: str
    is_duplicate: bool = False
    marcador: Optional[str] = None
    marcadores: List[str] = field(default_factory=list)


HISTORICO_MAX = 300

# Situações em que a conta a pagar ainda aceita baixa (enum do GET /contas-pagar/{id} no swagger v3).
SITUACOES_CONTA_PAGAR_BAIXAVEIS = ("aberto", "parcial", "atrasadas", "atrasada", "atrasado")
_CENTAVO_F = 0.005


def _num(valor: Any) -> Optional[float]:
    try:
        return None if valor is None or valor == "" else float(valor)
    except (TypeError, ValueError):
        return None


def baixa_entrou(antes: Optional[Dict[str, Any]], depois: Dict[str, Any]) -> Optional[bool]:
    """
    Compara a conta antes e depois de um POST /baixar com resposta ambígua.
    True = o pagamento consta (não repetir); False = conta intocada (pode repetir);
    None = mudou de um jeito que não dá para afirmar (conferir no Tiny).
    """
    sit_depois = str(depois.get("situacao") or "").strip().lower()
    pago_depois = _num(depois.get("valorPago")) or 0.0
    saldo_depois = _num(depois.get("saldo"))
    if antes is not None:
        pago_antes = _num(antes.get("valorPago")) or 0.0
        saldo_antes = _num(antes.get("saldo"))
        sit_antes = str(antes.get("situacao") or "").strip().lower()
        if pago_depois > pago_antes + _CENTAVO_F:
            return True
        if saldo_antes is not None and saldo_depois is not None and saldo_depois < saldo_antes - _CENTAVO_F:
            return True
        if sit_depois in ("pago", "liquidado") and sit_antes not in ("pago", "liquidado"):
            return True
        if sit_depois == sit_antes and abs(pago_depois - pago_antes) <= _CENTAVO_F:
            return False
        return None
    if sit_depois in ("pago", "liquidado"):
        return True
    if sit_depois in SITUACOES_CONTA_PAGAR_BAIXAVEIS and pago_depois <= _CENTAVO_F:
        return False
    if sit_depois in ("aberto", "aberta", "previsto") and pago_depois <= _CENTAVO_F:
        return False
    return None


# Limite do campo numeroDocumento no Tiny v3 ("Deve ter 20 caracteres ou menos").
NUMERO_DOCUMENTO_MAX = 20


def juntar_historico_baixa(atual: str, baixa: str, max_len: int = HISTORICO_MAX) -> str:
    """
    Histórico enviado na baixa: o que a conta já tinha + " | " + o texto da baixa. Se passar
    do limite, o texto da baixa é que é cortado — a referência original é o que importa manter.
    Idempotente: reenviar a mesma baixa não repete o texto.
    """
    atual = (atual or "").strip()
    baixa = (baixa or "").strip()
    if not atual or atual == baixa:
        return baixa[:max_len]
    if baixa and baixa in atual:
        return atual[:max_len]
    return f"{atual} | {baixa}"[:max_len] if baixa else atual[:max_len]


# Whitelist estrita de marcadores pré-existentes autorizados no Tiny ERP para as empresas e formas de pagamento/caixa
# Regra inegociável: a automação JAMAIS deve criar novos marcadores no ERP.
EXISTING_COMPANY_MARCADORES: Dict[str, str] = {
    "revesta": "Revesta",
    "fabrilux": "Fabrilux",
    "norvia_campinas": "Norvia",
    "norvia_curitiba": "NorviaLDA",
    "norvia": "Norvia",
}

# Conta financeira (no Tiny de cada empresa) em que a conciliação baixa as contas a pagar. Nome exato,
# como cadastrado: nada de "qualquer conta com inter no nome", que já baixou em "Inter Resgate 24h".
CONTA_INTER_POR_EMPRESA: Dict[str, str] = {
    "norvia_curitiba": "Inter Norvia Curitiba",
    "norvia_campinas": "Banco Inter - Norvia",
    "revesta": "Banco Inter Revesta",
    "fabrilux": "Banco Inter - Fabrilux",
}

AUTHORIZED_PAYMENT_MARCADORES: Dict[str, str] = {
    # Norvia
    "caixa visa norvia": "Caixa Visa Norvia",
    # Nome do marcador no Tiny: "Cartão Clara" (2026-10-07). "clara" segue aceito como entrada.
    "clara": "Cartão Clara",
    "cartão clara": "Cartão Clara",
    "cartao clara": "Cartão Clara",
    # Revesta
    "caixa visa": "Caixa Visa",
    "caixa elo": "Caixa Elo",
}

ALL_ALLOWED_MARCADORES: Dict[str, str] = {
    **EXISTING_COMPANY_MARCADORES,
    **AUTHORIZED_PAYMENT_MARCADORES,
}

# Formas de pagamento selecionáveis na revisão humana (painel de NF-e & DANFE). Pix e
# Boleto não usam marcador no Tiny (não fazem parte da whitelist acima) — só mudam a
# regra de vencimento. As demais reaproveitam os marcadores pré-existentes já validados
# em AUTHORIZED_PAYMENT_MARCADORES; nenhum marcador novo é criado por este mapeamento.
PAYMENT_METHOD_MARCADOR: Dict[str, Optional[str]] = {
    "pix": None,
    "boleto": None,
    "sem_marcador": None,
    "clara": "Cartão Clara",
    "caixa_visa": "Caixa Visa",
    "caixa_visa_norvia": "Caixa Visa Norvia",
    "caixa_elo": "Caixa Elo",
}

# "Meio de Pagamento da NFe" — campo nativo do Tiny (tela Contas a Pagar > Pagamento),
# distinto do marcador acima. As chaves e rótulos aqui seguem o código padrão SEFAZ do
# layout da NF-e (tag <tPag> dentro de <pag><detPag>) — é o que o dropdown mostra e o
# que o XML da nota já declara. Mas o campo real da API v3 do Tiny (`formaPagamento`,
# confirmado em 2026-09-17 contra o swagger oficial em
# https://erp.tiny.com.br/public-api/v3/swagger/swagger.json) usa uma tabela de códigos
# PRÓPRIA do Tiny, diferente da tabela SEFAZ — por isso a tradução em
# SEFAZ_TPAG_TO_TINY_FORMA_PAGAMENTO logo abaixo. Não confundir com PAYMENT_METHOD_MARCADOR
# acima (marcador interno de caixa/cartão) nem com o campo Python "forma_pagamento" usado
# em ConfirmLancamentoRequest (esse é o seletor Pix/Boleto/Clara/Caixa) — o Tiny por
# coincidência usa o mesmo nome "formaPagamento" para um conceito totalmente diferente.
PAYMENT_METHOD_NFE_LABELS: Dict[str, str] = {
    "01": "Dinheiro",
    "02": "Cheque",
    "03": "Cartão de Crédito",
    "04": "Cartão de Débito",
    "05": "Crédito Loja",
    "10": "Vale Alimentação",
    "11": "Vale Refeição",
    "12": "Vale Presente",
    "13": "Vale Combustível",
    "15": "Boleto Bancário",
    "16": "Depósito Bancário",
    "17": "Pagamento Instantâneo (PIX)",
    "18": "Transferência bancária, Carteira Digital",
    "19": "Programa de fidelidade, Cashback, Crédito Virtual",
    "90": "Sem pagamento",
    "99": "Outros",
}

# Tradução do código SEFAZ (tPag, acima) para o código inteiro real aceito pelo campo
# `formaPagamento` da API v3 do Tiny (POST /contas-pagar). Confirmado contra o swagger
# oficial — único item sem correspondência exata é "05 Crédito Loja", mapeado para
# "Crediario" (8) por ser o termo mais próximo no comércio brasileiro.
SEFAZ_TPAG_TO_TINY_FORMA_PAGAMENTO: Dict[str, int] = {
    "01": 2,   # Dinheiro
    "02": 7,   # Cheque
    "03": 3,   # Credito
    "04": 4,   # Debito
    "05": 8,   # Crediario (sem correspondência exata pra "Crédito Loja")
    "10": 16,  # Vale Alimentacao
    "11": 17,  # Vale Refeicao
    "12": 18,  # Vale Presente
    "13": 19,  # Vale Combustivel
    "15": 5,   # Boleto
    "16": 20,  # Deposito Bancario
    "17": 15,  # Pix
    "18": 21,  # Transferencia Bancaria Carteira Digital
    "19": 22,  # Fidelidade Cashback Credito Virtual
    "90": 0,   # Nao Definida (Tiny não tem opção literal "sem pagamento")
    "99": 10,  # Outra
}


def format_cpf_cnpj(digits: str) -> str:
    """Formata sequência numérica em CNPJ ou CPF para compatibilidade com o Tiny."""
    clean = re.sub(r"\D", "", digits or "")
    if len(clean) == 14:
        return f"{clean[:2]}.{clean[2:5]}.{clean[5:8]}/{clean[8:12]}-{clean[12:]}"
    elif len(clean) == 11:
        return f"{clean[:3]}.{clean[3:6]}.{clean[6:9]}-{clean[9:]}"
    return clean


def format_date_br(d: date) -> str:
    """Converte date para string no padrão brasileiro DD/MM/YYYY."""
    return d.strftime("%d/%m/%Y")


def _token_ausente(token: Optional[str]) -> bool:
    return not token or token.lower() in ("mock", "seu_token_aqui", "") or "COLOQUE" in token


def is_v3_token(token: Optional[str]) -> bool:
    """Identifica se o token é JWT OAuth2 (Tiny API v3) ou chave estática legada (Tiny API v2)."""
    if not token:
        return False
    t = token.strip()
    return t.startswith("eyJh") or len(t) > 100


class TinyOAuthManager:
    """
    Gerenciador do ciclo de vida dos tokens OAuth2 do Tiny ERP (Olist).
    - Renova automaticamente o Access Token a cada 4 horas (com margem de segurança de 5 minutos).
    - Persiste os tokens em arquivo JSON seguro para manter a sessão ativa após reinicializações.
    - Suporta renovação via refresh_token, troca de code inicial e client_credentials.
    """

    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        refresh_token: Optional[str] = None,
        cache_file: Optional[Path] = None,
        token_url: Optional[str] = None,
        auth_url: Optional[str] = None,
        redirect_uri: Optional[str] = None
    ) -> None:
        self.client_id = client_id or settings.TINY_CLIENT_ID
        self.client_secret = client_secret or settings.TINY_CLIENT_SECRET
        self.initial_refresh_token = refresh_token or settings.TINY_REFRESH_TOKEN
        self.cache_file = cache_file or settings.TINY_TOKEN_CACHE_FILE
        self.token_url = token_url or settings.TINY_TOKEN_URL
        self.auth_url = auth_url or settings.TINY_AUTH_URL
        self.redirect_uri = redirect_uri or settings.TINY_REDIRECT_URI

        self.access_token: Optional[str] = None
        self.current_refresh_token: Optional[str] = self.initial_refresh_token
        self.expires_at: float = 0.0

        self._load_cache()

    def is_configured(self) -> bool:
        """Indica se as credenciais OAuth2 do Tiny estão preenchidas."""
        return bool(
            self.client_id
            and self.client_secret
            and "COLOQUE" not in self.client_id
            and "COLOQUE" not in self.client_secret
        )

    def _load_cache(self) -> None:
        """Carrega tokens salvos no arquivo de cache persistente."""
        if self.cache_file.exists():
            try:
                with open(self.cache_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.access_token = data.get("access_token")
                    self.current_refresh_token = data.get("refresh_token") or self.current_refresh_token
                    self.expires_at = float(data.get("expires_at", 0.0))
            except Exception as e:
                logger.warning(f"Não foi possível ler cache de token do Tiny ({self.cache_file}): {e}")

    def _save_cache(self, token_data: Dict[str, Any]) -> None:
        """Salva o par de tokens e o tempo de expiração no cache persistente."""
        self.access_token = token_data.get("access_token")
        if token_data.get("refresh_token"):
            self.current_refresh_token = token_data.get("refresh_token")

        expires_in = token_data.get("expires_in", 14400)
        self.expires_at = time.time() + float(expires_in)

        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "access_token": self.access_token,
                "refresh_token": self.current_refresh_token,
                "expires_at": self.expires_at,
                "expires_in": expires_in,
                "updated_at": datetime.now().isoformat()
            }
            # Atômico: funciona mesmo se o arquivo antigo ficou com outro dono (ver app/json_store.py).
            # Segredo (access/refresh token): 0600. O backup do host lê via `nsenter -U` no userns
            # do Docker rootless, então não precisa ser legível por outros.
            write_json_atomic(self.cache_file, payload, mode=SECRET_FILE_MODE)
            logger.info(f"Access Token do Tiny atualizado com sucesso (expira em ~{int(expires_in/3600)}h).")
        except Exception as e:
            logger.error(f"Falha ao salvar cache de token do Tiny em {self.cache_file}: {e}")

    def get_authorization_url(self, state: str = "auth_tiny") -> str:
        """Gera a URL para autorização manual inicial no navegador."""
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": "openid",
            "response_type": "code",
            "state": state
        }
        return f"{self.auth_url}?{urlencode(params)}"

    def exchange_code(self, code: str) -> str:
        """Troca o 'code' gerado pelo navegador pelo primeiro Access Token e Refresh Token."""
        if not self.is_configured():
            raise TinyAPIError("Client ID e Client Secret não configurados para OAuth2.")

        logger.info("Trocando código de autorização por tokens OAuth2 no Tiny...")
        try:
            resp = requests.post(
                self.token_url,
                data={
                    "grant_type": "authorization_code",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "redirect_uri": self.redirect_uri,
                    "code": code.strip()
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=DEFAULT_TINY_TIMEOUT
            )
            resp.raise_for_status()
            data = resp.json()
            self._save_cache(data)
            return self.access_token
        except Exception as e:
            raise TinyAPIError(f"Falha ao trocar código de autorização por token no Tiny: {e}") from e

    def refresh_access_token(self) -> str:
        """
        Renova o Access Token expirado (4h) automaticamente utilizando:
        1. refresh_token (fluxo padrão OpenID Connect do Tiny)
        2. client_credentials (fallback caso a aplicação possua permissão direta)
        """
        if not self.is_configured():
            raise TinyAPIError("Credenciais OAuth2 do Tiny (Client ID e Secret) não configuradas.")

        refresh_tok = self.current_refresh_token or self.initial_refresh_token

        # 1. Tentativa via refresh_token
        if refresh_tok and "COLOQUE" not in refresh_tok:
            logger.debug("Solicitando renovação de Access Token via refresh_token...")
            try:
                resp = requests.post(
                    self.token_url,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": self.client_id,
                        "client_secret": self.client_secret,
                        "refresh_token": refresh_tok
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=DEFAULT_TINY_TIMEOUT
                )
                if resp.status_code == 200:
                    data = resp.json()
                    self._save_cache(data)
                    return self.access_token
                else:
                    logger.warning(f"Renovação via refresh_token retornou status {resp.status_code}: {resp.text}")
            except Exception as e:
                logger.warning(f"Falha na tentativa de renovação por refresh_token: {e}")

        # 2. Tentativa via client_credentials
        logger.debug("Tentando obter Access Token via client_credentials...")
        try:
            resp = requests.post(
                self.token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=DEFAULT_TINY_TIMEOUT
            )
            resp.raise_for_status()
            data = resp.json()
            self._save_cache(data)
            return self.access_token
        except Exception as e:
            raise TinyAPIError(
                f"Não foi possível obter Access Token do Tiny automaticamente. "
                f"Gere o primeiro token autorizando seu aplicativo ou forneça o refresh_token inicial: {e}"
            ) from e

    def get_access_token(self) -> Optional[str]:
        """
        Retorna o Access Token válido.
        Se faltarem menos de 300 segundos (5 minutos) para as 4h expirarem,
        renova automaticamente de forma transparente.
        """
        if not self.is_configured():
            return settings.TINY_API_TOKEN

        # Token em cache ainda válido (com margem de 5 minutos)
        if self.access_token and (self.expires_at - 300) > time.time():
            return self.access_token

        logger.info("Access Token do Tiny expirado ou ausente. Renovando automaticamente...")
        return self.refresh_access_token()



_CHAVE_NO_HISTORICO = re.compile(r"(?<!\d)\d{44}(?!\d)")


def _referencia_da_nota(nro_documento: str, numero_nota: Optional[str]) -> Tuple[str, bool]:
    """
    (número que identifica a nota, N° documento é genérico?). "3280/1" -> ("3280", False);
    "NF-e Norvia" com numero_nota "282" -> ("282", True): o documento é o mesmo para todas as
    notas da empresa e só o número da NF distingue uma da outra.
    """
    first_part = nro_documento.split("/")[0].split("-")[0].strip()
    if first_part.isdigit():
        return first_part, False
    numero = re.sub(r"\D", "", str(numero_nota or "")).lstrip("0")
    return (numero or nro_documento), True


def _somar_meses(d: date, meses: int) -> date:
    total = d.year * 12 + (d.month - 1) + meses
    ano, mes = divmod(total, 12)
    mes += 1
    ultimo_dia = (date(ano + (mes == 12), mes % 12 + 1, 1) - date(ano, mes, 1)).days
    return date(ano, mes, min(d.day, ultimo_dia))


def vencimento_da_parcela(nfe_data: NFeData, parcela: int = 1, total_parcelas: int = 1) -> date:
    """
    Vencimento da parcela `parcela` (1..total) de uma nota lançada em `total_parcelas`:
    - cartão/caixa (marcador_caixa): ciclo do marcador, uma fatura por mês;
    - senão, se o XML trouxe exatamente essa quantidade de duplicatas, a data de cada uma;
    - senão, o 1º vencimento da nota (ou a emissão) + 1 mês por parcela.
    """
    marcador = getattr(nfe_data, "marcador_caixa", None)
    if marcador:
        venc = calculate_marker_vencimento(nfe_data.data_emissao, marcador, offset_months=parcela - 1)
        if venc:
            return venc
    datas = sorted(d.vencimento for d in nfe_data.duplicatas if d.vencimento)
    if total_parcelas > 1 and len(datas) == total_parcelas:
        return datas[parcela - 1]
    primeiro = datas[0] if datas else nfe_data.data_emissao
    return _somar_meses(primeiro, parcela - 1)


def dividir_em_parcelas(valor: Decimal, total_parcelas: int) -> List[Decimal]:
    """Valor em N parcelas iguais (centavos); a diferença do arredondamento vai na última."""
    base = (Decimal(valor) / total_parcelas).quantize(Decimal("0.01"), rounding="ROUND_DOWN")
    return [base] * (total_parcelas - 1) + [Decimal(valor) - base * (total_parcelas - 1)]


class TinyClient:
    """
    Cliente de integração com o ERP Tiny v2 para inclusão de Contas a Pagar.
    Suporta Token estático legado, OAuth2 com renovação automática a cada 4h,
    e resolução dinâmica multi-tenant via MariaDB (api_tokens).
    """

    def __init__(
        self,
        token: Optional[str] = None,
        oauth_manager: Optional[TinyOAuthManager] = None,
        token_repository: Optional[TokenRepository] = None,
        api_url: Optional[str] = None,
        default_category: Optional[str] = None,
        ocorrencia: Optional[str] = None
    ) -> None:
        self.static_token = token or settings.TINY_API_TOKEN
        self.oauth_manager = oauth_manager or TinyOAuthManager()
        self.token_repository = token_repository or TokenRepository()
        self.api_url = api_url or settings.TINY_API_URL
        self.default_category = default_category or settings.TINY_DEFAULT_CATEGORY
        self.ocorrencia = ocorrencia or settings.TINY_OCORRENCIA
        self._contato_cache: Dict[str, int] = {}
        self._categories_cache: Dict[str, Tuple[List[Dict[str, Any]], float]] = {}
        # Circuito de proteção do dashboard financeiro (ver _fetch_paginated_v3_itens):
        # conta falhas consecutivas de bloqueio (403 vazio / 429) entre chamadas, pra
        # abortar cedo em vez de insistir em centenas de chamadas fadadas ao fracasso.
        # Por endpoint (chave = URL): um problema específico de /caixa (ex.: escopo OAuth
        # sem permissão de leitura) não deve contaminar o circuito de /contas-pagar ou
        # /contas-receber, que são chamados na mesma sincronização mas são endpoints
        # (e possivelmente permissões) independentes.
        self._consecutive_block_failures: Dict[str, int] = {}
        self._conta_origem_inter_cache: Dict[str, Optional[int]] = {}

    def resolve_token_for_cnpj(
        self,
        cnpj: Optional[str] = None,
        account_id: Optional[str] = None
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Resolve o access_token e a identificação da empresa (account_id) a partir de CNPJ ou account_id.
        1. Consulta MariaDB por CNPJ ou account_id
        2. Fallback para token estático local ou OAuth2 único configurado no .env
        Retorna (access_token, conta_identificador).
        """
        clean_cnpj = "".join(c for c in (cnpj or "") if c.isdigit())
        resolved_account = account_id
        if not resolved_account and clean_cnpj:
            cnpj_map = settings.get_cnpj_company_map()
            resolved_account = cnpj_map.get(clean_cnpj)

        if self.token_repository.is_configured():
            db_res = self.token_repository.get_token_by_cnpj_or_account(
                cnpj=clean_cnpj,
                account_id=resolved_account
            )
            if db_res:
                return db_res

        fallback_token = self.get_active_token()
        return fallback_token, resolved_account

    def resolve_token_for_nfe(self, nfe_data: Optional[NFeData] = None) -> Tuple[Optional[str], Optional[str]]:
        """
        Resolve o access_token e a identificação da empresa destinatária da NF-e.
        1. Consulta MariaDB por nfe_data.destinatario_cnpj ou destinatario_nome
        2. Fallback para token estático local ou OAuth2 único configurado no .env
        Retorna (access_token, conta_identificador).
        """
        account_id = None
        clean_cnpj = ""
        if nfe_data:
            clean_cnpj = "".join(c for c in (nfe_data.destinatario_cnpj or "") if c.isdigit())
            if clean_cnpj == "27184930000280":
                account_id = "norvia_curitiba"
            elif clean_cnpj == "27184930000107":
                account_id = "norvia_campinas"
            elif clean_cnpj == "43820617000166":
                account_id = "fabrilux"
            elif clean_cnpj == "36592814000100":
                account_id = "revesta"
            elif nfe_data.destinatario_nome:
                nome_low = nfe_data.destinatario_nome.lower()
                if "revesta" in nome_low:
                    account_id = "revesta"
                elif "fabrilux" in nome_low:
                    account_id = "fabrilux"
                elif "campinas" in nome_low:
                    account_id = "norvia_campinas"
                elif "curitiba" in nome_low:
                    account_id = "norvia_curitiba"

        if nfe_data and self.token_repository.is_configured():
            db_res = self.token_repository.get_token_by_cnpj_or_account(
                cnpj=clean_cnpj,
                account_id=account_id
            )
            if db_res:
                return db_res
            if clean_cnpj:
                raise TinyAPIError(
                    f"CNPJ destinatário '{clean_cnpj}' não coincide com nenhuma "
                    f"das empresas cadastradas no Tiny ERP (Fabrilux, Revesta, Norvia). "
                    f"A automação não permite lançamentos em filiais não cadastradas."
                )

        fallback_token = self.get_active_token()
        return fallback_token, account_id

    def get_active_token(self) -> Optional[str]:
        """Obtém o token ativo (OAuth2 renovado ou estático)."""
        if self.static_token:
            return self.static_token
        if self.oauth_manager.is_configured():
            return self.oauth_manager.get_access_token()
        return None

    def lancar_contas_nfe(self, nfe_data: NFeData) -> List[TinyContaResult]:
        """
        Gera e envia o lançamento no Contas a Pagar do Tiny para cada parcela/duplicata da NF-e.
        Suporta automaticamente Tiny API v3 (OAuth2 Bearer) e Tiny API v2 (token legado).
        """
        token, account_id = self.resolve_token_for_nfe(nfe_data)
        duplicatas = nfe_data.get_effective_duplicatas()
        total_parcelas = len(duplicatas)
        results: List[TinyContaResult] = []

        is_v3 = is_v3_token(token)
        empresa_info = f"filial '{account_id}' (CNPJ: {nfe_data.destinatario_cnpj})" if account_id else f"CNPJ {nfe_data.destinatario_cnpj or 'padrão'}"
        versao_info = "API v3 (OAuth2)" if is_v3 else "API v2 (legada)"
        logger.info(
            f"Iniciando lançamento de {total_parcelas} parcela(s) no Tiny ({versao_info}) para {empresa_info} | "
            f"NF-e {nfe_data.numero_nota} (Emitente: {nfe_data.emitente_nome})"
        )

        self._resolve_and_validate_marcadores(nfe_data, account_id)

        # Resolução do número base do documento (prefixo do arquivo no Drive, "Nota fiscal
        # - {Empresa}" pra notas da SEFAZ, ou o número cru da nota como último fallback).
        doc_base = self._resolve_doc_base(nfe_data, account_id)

        for idx, dup in enumerate(duplicatas, start=1):
            if total_parcelas > 1:
                nro_documento = f"{doc_base}/{dup.numero}"
                desc_parcela = f" (Parc {dup.numero}/{total_parcelas})"
            else:
                nro_documento = doc_base
                desc_parcela = ""

            # Chave logo no início (não no final): o campo "historico" do Tiny tem limite de
            # tamanho e pode truncar — se a chave ficasse só no final, seria a primeira coisa
            # cortada, quebrando a checagem de duplicidade por chave (check_duplicate_conta_v3).
            historico = (
                f"NF-e {nfe_data.numero_nota}{desc_parcela} (Chave: {nfe_data.chave}) - "
                f"{nfe_data.emitente_nome}"
            )

            # Simulação só com MOCK_MODE=true explícito (dev local). Em produção, sem token a nota
            # NÃO é dada como lançada: o erro sobe e ela fica em revisão pendente.
            if _token_ausente(token):
                if not settings.MOCK_MODE:
                    raise TinyAPIError(
                        f"Token do Tiny não configurado para {empresa_info}: conta '{nro_documento}' NÃO foi lançada "
                        "(a nota continua em revisão pendente)."
                    )
                logger.warning(
                    f"[SIMULAÇÃO ERP TINY] Token não configurado ou em modo mock. "
                    f"Simulando lançamento da conta '{nro_documento}' (R$ {dup.valor})."
                )
                marcadores_alvo = (
                    list(nfe_data.marcadores)
                    if nfe_data.marcadores
                    else [m for m in (getattr(nfe_data, "marcador_caixa", None), nfe_data.marcador_empresa) if m]
                )
                marcador_str = ", ".join(marcadores_alvo) if marcadores_alvo else (getattr(nfe_data, "marcador_caixa", None) or nfe_data.marcador_empresa)
                results.append(TinyContaResult(
                    conta_id=999999,
                    nro_documento=nro_documento,
                    valor=dup.valor,
                    vencimento=dup.vencimento,
                    situacao="aberto (simulado)",
                    marcador=marcador_str,
                    marcadores=marcadores_alvo
                ))
                continue

            if is_v3:
                result = self._send_conta_pagar_v3(
                    nfe_data=nfe_data,
                    duplicata=dup,
                    nro_documento=nro_documento,
                    historico=historico,
                    token=token
                )
            else:
                payload = self._build_payload(
                    nfe_data=nfe_data,
                    duplicata=dup,
                    nro_documento=nro_documento,
                    historico=historico
                )
                result = self._send_conta_pagar(payload, nro_documento=nro_documento, duplicata=dup, active_token=token)

            results.append(result)

        return results

    def _resolve_doc_base(self, nfe_data: NFeData, account_id: Optional[str]) -> str:
        """
        Resolve o valor do campo "N° documento" do Tiny. Notas escaneadas direto da SEFAZ
        (sem prefixo customizado do nome de arquivo do Drive) usam "NF-e {Empresa}" — mesmo
        estilo do "NFC-e Revesta" já usado no Tiny —, em vez do número cru da NF-e.
        Até 2026-09-28 era "Nota fiscal - {Empresa}", mas o Tiny limita o campo a
        `NUMERO_DOCUMENTO_MAX` caracteres e isso passava do limite em todas as empresas
        ("Nota fiscal - NorviaLDA" = 24), recusando o lançamento.

        Isso deixa "N° documento" compartilhado entre TODAS as notas da mesma empresa, então
        a detecção de duplicidade (`check_duplicate_conta_v3`) passa a depender
        principalmente da Chave de Acesso (44 dígitos) gravada no início do `historico` de
        cada lançamento — não mais de um número de documento único por nota. Decisão
        consciente do usuário, ciente do trade-off frente ao fallback por valor+vencimento
        (mais fraco com N° documento genérico compartilhado).
        """
        if nfe_data.numero_documento_custom:
            return nfe_data.numero_documento_custom
        empresa = nfe_data.marcador_empresa or EXISTING_COMPANY_MARCADORES.get(account_id or "")
        if empresa:
            return f"NF-e {empresa}"
        return str(nfe_data.numero_nota)

    def _resolve_and_validate_marcadores(self, nfe_data: NFeData, account_id: Optional[str]) -> List[str]:
        """
        Resolve o marcador pré-existente da empresa (se ainda não preenchido) e valida
        estritamente a whitelist de marcadores autorizados no Tiny ERP. Retorna a lista
        de marcadores-alvo (empresa + caixa/pagamento) já validada.
        """
        if not nfe_data.marcador_empresa:
            if account_id and account_id in EXISTING_COMPANY_MARCADORES:
                nfe_data.marcador_empresa = EXISTING_COMPANY_MARCADORES[account_id]

        all_markers = (
            list(nfe_data.marcadores)
            if nfe_data.marcadores
            else [m for m in (getattr(nfe_data, "marcador_caixa", None), nfe_data.marcador_empresa) if m]
        )
        for m in all_markers:
            if not m:
                continue
            cleaned = m.strip().lower()
            if not any(cleaned == k.lower() or cleaned == v.lower() for k, v in ALL_ALLOWED_MARCADORES.items()):
                raise TinyAPIError(
                    f"Marcador '{m}' não cadastrado/autorizado no Tiny ERP. "
                    f"Marcadores pré-cadastrados autorizados: {sorted(list(set(ALL_ALLOWED_MARCADORES.values())))}. "
                    f"A automação não cria nem utiliza marcadores não cadastrados."
                )

        return all_markers

    def lancar_grupo_categorizado(
        self,
        nfe_data: NFeData,
        grupo: GroupedLancamento,
        group_index: int,
        total_grupos: int,
        parcela: int = 1,
        total_parcelas: int = 1,
        valor_parcela: Optional[Decimal] = None,
    ) -> TinyContaResult:
        """
        Lança no Contas a Pagar do Tiny um único grupo de itens já categorizados e
        confirmados pelo usuário (revisão humana). Um grupo = 1 categoria_id, com o
        valor somado (já rateado) dos itens que a compõem.

        Nota parcelada (escolha na revisão): cada parcela do grupo é uma conta separada,
        N° documento '<doc>/<parcela>' e vencimento mês a mês (cartão/caixa seguem o ciclo
        do marcador; sem marcador, as datas das duplicatas do XML quando a quantidade bate).
        Suporta apenas Tiny API v3 (OAuth2), que é o modo usado em produção; para
        token estático legado (v2) o `categoria` é enviado como texto no payload.
        """
        token, account_id = self.resolve_token_for_nfe(nfe_data)
        self._resolve_and_validate_marcadores(nfe_data, account_id)

        doc_base = self._resolve_doc_base(nfe_data, account_id)
        sufixo = ("" if total_grupos == 1 else f"-{group_index}") + ("" if total_parcelas == 1 else f"/{parcela}")
        # Tiny recusa N° documento acima do limite; um prefixo custom longo do Drive é cortado,
        # preservando o sufixo do grupo.
        nro_documento = doc_base[: NUMERO_DOCUMENTO_MAX - len(sufixo)] + sufixo
        # Chave logo no início (não no final): o campo "historico" do Tiny tem um limite de
        # tamanho e pode truncar o texto (nome do fornecedor + itens podem passar de 300+
        # caracteres) — se a chave ficasse só no final, ela seria a primeira coisa cortada,
        # quebrando a checagem de duplicidade por chave (check_duplicate_conta_v3) mesmo para
        # notas lançadas pela própria automação.
        historico = (
            f"NF-e {nfe_data.numero_nota} (Chave: {nfe_data.chave}) - {nfe_data.emitente_nome} "
            f"[{grupo.categoria_nome}]"
            + (f" (Parc {parcela}/{total_parcelas})" if total_parcelas > 1 else "")
            + f": {grupo.historico_detalhe}"
        )
        valor_conta = grupo.valor_total if valor_parcela is None else valor_parcela

        vencimento_efetivo = vencimento_da_parcela(nfe_data, parcela, total_parcelas)

        is_v3 = is_v3_token(token)

        if _token_ausente(token):
            if not settings.MOCK_MODE:
                raise TinyAPIError(
                    f"Token do Tiny não configurado: lançamento '{nro_documento}' ({grupo.categoria_nome}) NÃO foi feito "
                    "(a nota continua em revisão pendente)."
                )
            logger.warning(
                f"[SIMULAÇÃO ERP TINY] MOCK_MODE=true e token não configurado. "
                f"Simulando lançamento categorizado '{nro_documento}' ({grupo.categoria_nome}, R$ {valor_conta})."
            )
            return TinyContaResult(
                conta_id=999999,
                nro_documento=nro_documento,
                valor=valor_conta,
                vencimento=vencimento_efetivo,
                situacao="aberto (simulado)",
            )

        grupo_duplicata = NFeDuplicate(numero=f"{parcela:03d}", vencimento=vencimento_efetivo, valor=valor_conta)

        if is_v3:
            return self._send_conta_pagar_v3(
                nfe_data=nfe_data,
                duplicata=grupo_duplicata,
                nro_documento=nro_documento,
                historico=historico,
                token=token,
                categoria_id=grupo.categoria_id,
                categoria_nome=grupo.categoria_nome,
                vencimento_fixo=True,
                # Nota dividida (categorias e/ou parcelas): as outras contas da mesma nota têm a
                # mesma chave no histórico e documento parecido; só a própria conta é duplicata.
                duplicidade_estrita=total_grupos > 1 or total_parcelas > 1,
            )

        payload = self._build_payload(
            nfe_data=nfe_data,
            duplicata=grupo_duplicata,
            nro_documento=nro_documento,
            historico=historico,
            categoria_nome=grupo.categoria_nome,
        )
        return self._send_conta_pagar(payload, nro_documento=nro_documento, duplicata=grupo_duplicata, active_token=token)

    def resolve_contato_id_v3(self, token: str, nfe_data: NFeData) -> Optional[int]:
        """
        Localiza o idContato no Tiny ERP v3 para o fornecedor/emitente da NF-e.
        Regra estrita: A automação JAMAIS deve criar novos contatos/fornecedores no Tiny ERP.
        - Se CNPJ estiver presente na nota, ele DEVE existir e coincidir estritamente com o cadastro do Tiny.
        - Se o fornecedor ou CNPJ não coincidir ou não for localizado, levanta TinyAPIError com o motivo detalhado.
        """
        raw_cnpj = nfe_data.emitente_cnpj or ""
        cnpj_digits = re.sub(r"\D", "", raw_cnpj)

        # Considera CNPJ/CPF válido apenas se tiver 11 ou 14 dígitos e não for sequência repetida (ex.: '00000000000000')
        # Em cupons fiscais (NFC-e) ou recibos manuais ('REC-...'), o CNPJ pode vir como 14 zeros ou ausente.
        is_real_cnpj = len(cnpj_digits) in (11, 14) and len(set(cnpj_digits)) > 1
        if not is_real_cnpj:
            cnpj_digits = ""

        cache_key = cnpj_digits or (nfe_data.emitente_nome or "").strip().lower()

        if cache_key and cache_key in self._contato_cache:
            return self._contato_cache[cache_key]

        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }
        url = "https://api.tiny.com.br/public-api/v3/contatos"

        itens: List[Dict[str, Any]] = []

        # 1. Busca por CNPJ formatado (apenas se for um CNPJ real)
        if cnpj_digits:
            cnpj_formatted = format_cpf_cnpj(cnpj_digits)
            if cnpj_formatted:
                try:
                    _throttle_tiny_api_call()
                    resp = requests.get(url, headers=headers, params={"cpfCnpj": cnpj_formatted}, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
                    if resp.status_code == 200:
                        itens = resp.json().get("itens", [])
                except Exception as e:
                    logger.warning(f"[TINY_V3] Falha na consulta de contato por CNPJ formatado: {e}")

        # 2. Busca por CNPJ somente dígitos (se não encontrou formatado)
        if not itens and cnpj_digits:
            try:
                _throttle_tiny_api_call()
                resp = requests.get(url, headers=headers, params={"cpfCnpj": cnpj_digits}, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
                if resp.status_code == 200:
                    itens = resp.json().get("itens", [])
            except Exception as e:
                logger.warning(f"[TINY_V3] Falha na consulta de contato por dígitos de CNPJ: {e}")

        # Se encontrou por CNPJ, valida correspondência
        if itens and itens[0].get("id"):
            contato = itens[0]
            contato_id = int(contato["id"])
            contato_nome = contato.get("nome") or ""
            contato_doc = re.sub(r"\D", "", contato.get("cpfCnpj") or contato.get("cpf_cnpj") or "")

            if cnpj_digits and contato_doc and cnpj_digits != contato_doc:
                raise TinyAPIError(
                    f"Divergência de CNPJ no Tiny ERP: A nota fiscal do emitente '{nfe_data.emitente_nome}' "
                    f"possui CNPJ '{nfe_data.emitente_cnpj}', mas o contato retornado no Tiny (ID {contato_id}, '{contato_nome}') "
                    f"possui CNPJ divergente '{contato.get('cpfCnpj')}'. A automação não cria nem altera cadastros."
                )

            logger.info(f"[TINY_V3] Fornecedor '{nfe_data.emitente_nome}' localizado via CNPJ: ID {contato_id} ({contato_nome})")
            self._contato_cache[cache_key] = contato_id
            return contato_id

        # 3. Se NÃO encontrou por CNPJ, mas o nome do emitente está preenchido:
        # Busca por nome exato para verificar se o fornecedor existe no Tiny
        if nfe_data.emitente_nome:
            nome_clean = nfe_data.emitente_nome.strip()
            try:
                _throttle_tiny_api_call()
                resp = requests.get(url, headers=headers, params={"nome": nome_clean}, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
                if resp.status_code == 200:
                    itens = resp.json().get("itens", [])
            except Exception as e:
                logger.warning(f"[TINY_V3] Falha na consulta de contato por nome: {e}")

            if itens and itens[0].get("id"):
                contato = itens[0]
                contato_id = int(contato["id"])
                contato_nome = contato.get("nome") or ""
                contato_doc = re.sub(r"\D", "", contato.get("cpfCnpj") or contato.get("cpf_cnpj") or "")

                if cnpj_digits and contato_doc and cnpj_digits != contato_doc:
                    raise TinyAPIError(
                        f"Divergência cadastral no Tiny ERP: O fornecedor '{nome_clean}' possui CNPJ '{nfe_data.emitente_cnpj}' "
                        f"na nota fiscal, mas o contato localizado no Tiny ERP (ID {contato_id}, '{contato_nome}') "
                        f"possui CNPJ divergente '{contato.get('cpfCnpj')}'. Cadastre o fornecedor com o CNPJ correto no Tiny."
                    )
                if cnpj_digits and not contato_doc:
                    raise TinyAPIError(
                        f"Cadastro incompleto no Tiny ERP: O fornecedor '{nome_clean}' foi localizado no Tiny ERP (ID {contato_id}), "
                        f"mas não possui CNPJ preenchido, enquanto a nota fiscal possui CNPJ '{nfe_data.emitente_cnpj}'. "
                        f"Preencha o CNPJ no cadastro do fornecedor no Tiny ERP para autorizar o lançamento."
                    )

                logger.info(f"[TINY_V3] Fornecedor '{nome_clean}' localizado via nome: ID {contato_id} ({contato_nome})")

                # Se a nota fiscal não possuía documento válido (ex.: cupom NFC-e ou recibo manual com '00000000000000'),
                # enriquece os dados da nota com o documento e razão social do contato cadastrado no Tiny
                if not is_real_cnpj and contato_doc:
                    nfe_data.emitente_cnpj = contato.get("cpfCnpj") or contato.get("cpf_cnpj")
                    nfe_data.emitente_nome = contato_nome

                self._contato_cache[cache_key] = contato_id
                return contato_id

        # Se não encontrou nem por CNPJ nem por nome:
        msg_doc = f" (CNPJ: {nfe_data.emitente_cnpj})" if nfe_data.emitente_cnpj else ""
        raise TinyAPIError(
            f"Fornecedor '{nfe_data.emitente_nome}'{msg_doc} não encontrado nos contatos do Tiny ERP. "
            f"A automação está configurada para não criar novos fornecedores ou cadastros automaticamente. "
            f"Cadastre previamente o fornecedor e seu CNPJ no Tiny ERP para permitir o lançamento."
        )

    def _fetch_contas_pagar_itens(
        self,
        url: str,
        headers: Dict[str, str],
        params: Dict[str, Any],
        max_pages: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Busca TODOS os itens de /contas-pagar para os `params` dados, paginando (a API
        pagina de verdade: `limit`/`offset`/`total`, confirmado no swagger oficial —
        https://erp.tiny.com.br/public-api/v3/swagger/swagger.json). Sem isso, um
        fornecedor com mais de 100 contas sob o mesmo `numeroDocumento` (comum no caso de
        prefixo compartilhado, ex.: "NFC-e Revesta") teria itens mais antigos silenciosamente
        fora da checagem de duplicidade, já que só a 1ª página (padrão da API) era buscada.
        Limitado a `max_pages` (500 registros) como teto de segurança.
        """
        limit = 100
        all_itens: List[Dict[str, Any]] = []
        for page in range(max_pages):
            page_params = {**params, "limit": limit, "offset": page * limit}
            _throttle_tiny_api_call()
            resp = requests.get(url, headers=headers, params=page_params, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
            if resp.status_code != 200:
                break
            data = resp.json()
            itens = data.get("itens", [])
            all_itens.extend(itens)
            total = data.get("total")
            if not itens or len(itens) < limit or (total is not None and len(all_itens) >= total):
                break
        return all_itens

    def _find_duplicate_in_itens(
        self,
        itens: List[Dict[str, Any]],
        nro_documento: str,
        chave: Optional[str],
        valor: Optional[Decimal],
        vencimento: Optional[date],
        numero_nota: Optional[str] = None,
    ) -> Optional[int]:
        """
        Aplica os critérios de duplicidade sobre uma lista de itens já retornada pelo Tiny.

        Com N° documento genérico ("NF-e Norvia", compartilhado por todas as notas da empresa)
        ele não identifica a nota: quem identifica é o número da NF (`numero_nota`) no documento
        ou no histórico. E conta com OUTRA chave de acesso no histórico é de outra nota, nunca
        duplicata. Incidente 2026-09-29: notas diferentes do mesmo fornecedor, mesmo valor e
        mesmo vencimento do cartão (VELTRIX3D 276/280/282) viraram "Já existia no Tiny" e não
        foram lançadas.
        """
        if not itens:
            return None

        nro_doc_str = str(nro_documento).strip()
        nro_base, generico = _referencia_da_nota(nro_doc_str, numero_nota)

        hist_ref_regex = None
        if nro_base.isdigit():
            # Casa com 'Ref. a NF nº 3280', 'Ref. a NF 3280', 'NF-e 3280', 'NF nº 3280', 'NF 3280', 'Nº 3280'
            hist_ref_regex = re.compile(
                rf"\b(?:ref\.?\s*(?:a\s*)?)?(?:nf-?e?|nota\s*fiscal|n[º°o]?)\s*{re.escape(nro_base)}\b",
                re.IGNORECASE,
            )

        itens_mesmo_documento: List[Dict[str, Any]] = []
        for item in itens:
            item_id = int(item["id"])
            historico_item = str(item.get("historico") or "")
            doc_item = str(item.get("numeroDocumento") or "").strip()
            doc_base_item = doc_item.split("/")[0].split("-")[0].strip() if doc_item else ""

            # 1. Checagem por Chave de Acesso no histórico
            if chave and len(chave) == 44 and chave in historico_item:
                logger.info(f"[TINY_V3] Conta duplicada identificada pela Chave de Acesso no histórico (ID {item_id}).")
                return item_id
            if chave and len(chave) == 44 and _CHAVE_NO_HISTORICO.search(historico_item):
                continue  # conta de outra nota (tem a chave dela)

            # Verifica se o item pertence a este documento/nota
            match_doc = (
                (not generico and doc_item and doc_item == nro_doc_str)
                or (doc_item and doc_item == nro_base)
                or (nro_base.isdigit() and doc_base_item and doc_base_item == nro_base)
                or (nro_base.isdigit() and doc_item and (
                    doc_item.startswith(f"{nro_base}/")
                    or doc_item.startswith(f"{nro_base}-")
                    or doc_item.startswith(f"{nro_base}.")
                ))
            )

            match_hist = bool(hist_ref_regex and hist_ref_regex.search(historico_item))

            if match_doc or match_hist:
                itens_mesmo_documento.append(item)

                # 2. Checagem por Valor + Vencimento de um único item, para o mesmo fornecedor
                if valor is not None:
                    item_val = float(item.get("valor", 0))
                    item_venc = str(item.get("dataVencimento", "")).split("T")[0]
                    venc_str = vencimento.strftime("%Y-%m-%d") if vencimento else ""
                    if abs(item_val - float(valor)) < 0.05 and (not venc_str or not item_venc or item_venc == venc_str):
                        logger.info(
                            f"[TINY_V3] Conta duplicada identificada por Documento/Valor/Vencimento (ID {item_id}, R$ {item_val:.2f})."
                        )
                        return item_id

        # 3. Checagem pela SOMA das parcelas já lançadas com o mesmo nro_documento —
        # cada parcela isolada não bate com o valor total, mas a soma delas sim.
        if valor is not None and itens_mesmo_documento:
            soma_parcelas = sum(float(item.get("valor", 0)) for item in itens_mesmo_documento)
            if abs(soma_parcelas - float(valor)) < 0.05:
                item_id = int(itens_mesmo_documento[0]["id"])
                logger.info(
                    f"[TINY_V3] Conta duplicada identificada pela soma de {len(itens_mesmo_documento)} "
                    f"parcela(s) já lançada(s) para o documento '{nro_documento}' "
                    f"(R$ {soma_parcelas:.2f}, ID de referência {item_id})."
                )
                return item_id

            # Se há histórico explícito da nota ('Ref. a NF nº X') e há parcelas lançadas,
            # tolera pequenas variações de centavos/arredondamento (< R$ 2.00)
            if len(itens_mesmo_documento) >= 1 and abs(soma_parcelas - float(valor)) < 2.00:
                item_id = int(itens_mesmo_documento[0]["id"])
                logger.info(
                    f"[TINY_V3] Conta duplicada identificada por referência explícita no histórico/parcelas "
                    f"para o documento '{nro_documento}' (ID {item_id}, soma R$ {soma_parcelas:.2f} ~ R$ {float(valor):.2f})."
                )
                return item_id

        # 4. Se chave e valor não foram fornecidos (ex: chamadas diretas legadas)
        if not chave and valor is None and itens_mesmo_documento:
            return int(itens_mesmo_documento[0]["id"])

        return None

    def check_duplicate_conta_v3(
        self,
        token: str,
        nro_documento: str,
        contato_id: Optional[int] = None,
        chave: Optional[str] = None,
        valor: Optional[Decimal] = None,
        vencimento: Optional[date] = None,
        estrita: bool = False,
        numero_nota: Optional[str] = None,
    ) -> Optional[int]:
        """
        Verifica se a conta a pagar já existe no Tiny ERP v3 para evitar duplicidade.

        `estrita=True` (nota dividida em várias contas pela automação — categorias e/ou
        parcelas): só conta como duplicata a conta com o MESMO N° documento e a chave no
        histórico. Os critérios abaixo confundiriam as contas irmãs da mesma nota (mesma
        chave no histórico; parcelas de mesmo valor; soma das parcelas já lançadas) e
        pulariam parcelas que ainda não existem. Serve para o reenvio após falha parcial.
        Como o 'nro_documento' pode ser um prefixo compartilhado por várias notas
        (ex.: 'NFC-e Revesta', 'NFC-e Fabrilux'), a verificação confere, nesta ordem:
        1. Se a Chave de Acesso fiscal (44 dígitos) já está registrada no histórico da conta;
        2. Ou se coincidem fornecedor (idContato), valor e data de vencimento de UM item;
        3. Ou se a SOMA de todos os itens com o mesmo nro_documento exato bate com o valor
           informado — cobre o caso de a conta já ter sido lançada manualmente no Tiny
           parcelada (ex.: "parcela 1/2", "parcela 2/2"): cada parcela individual nunca bate
           com o valor total da nota, só a soma delas. Incidente real 2026-09-18: notas da
           BOXEN EMBALAGENS e ITA EMBALAGENS já lançadas manualmente (parceladas) continuaram
           aparecendo como pendentes porque só a checagem por item único era feita.
        4. Fallback: se nenhum critério de chave/valor for informado, compara o nro_documento exato.
        Retorna o ID da conta existente se encontrada, ou None.

        A busca inicial é filtrada por idContato quando disponível (mais rápida/específica),
        mas se não encontrar nada e um idContato tiver sido usado, repete a busca SEM esse
        filtro antes de desistir. Motivo: o idContato que a automação resolve (por CNPJ) pode
        divergir do contato usado num lançamento manual feito por um humano no Tiny (cadastros
        duplicados/mesclados são comuns) — nesse caso o filtro por idContato, sozinho, faz a
        busca voltar vazia e a duplicidade passa despercebida. Incidente real 2026-09-18: NF-e
        61817 (HELLEN TAVOLONI), parcela única, valor batendo exato, mesmo assim não detectada.
        A precisão continua garantida pela combinação de nro_documento exato + valor (+ chave).
        """
        url = "https://api.tiny.com.br/public-api/v3/contas-pagar"
        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }

        nro_doc_str = str(nro_documento).strip()
        nro_base, _generico = _referencia_da_nota(nro_doc_str, numero_nota)

        def achar(itens_tiny: List[Dict[str, Any]]) -> Optional[int]:
            return self._find_duplicate_in_itens(itens_tiny, nro_documento, chave, valor, vencimento, numero_nota)

        if estrita:
            try:
                for item in self._fetch_contas_pagar_itens(url, headers, {"numeroDocumento": nro_doc_str}):
                    if (
                        str(item.get("numeroDocumento") or "").strip() == nro_doc_str
                        and chave
                        and chave in str(item.get("historico") or "")
                    ):
                        logger.info(f"[TINY_V3] Conta '{nro_doc_str}' desta nota já lançada (ID {item['id']}).")
                        return int(item["id"])
            except Exception as e:
                logger.warning(f"[TINY_V3] Falha ao verificar duplicidade de conta {nro_documento}: {e}")
            return None

        try:
            # 1. Busca por idContato quando disponível (mais abrangente para capturar parcelas 3280/1, 3280/2...)
            if contato_id:
                itens_contato = self._fetch_contas_pagar_itens(url, headers, {"idContato": contato_id}, max_pages=3)
                found = achar(itens_contato)
                if found:
                    return found

            # 2. Busca por numeroDocumento exato (com ou sem idContato)
            params: Dict[str, Any] = {"numeroDocumento": nro_doc_str}
            itens_doc = self._fetch_contas_pagar_itens(url, headers, params)
            found = achar(itens_doc)
            if found:
                return found

            # 3. Se nro_base for número e diferente do nro_documento buscado (ex.: '46789-1' -> '46789')
            if nro_base != nro_doc_str:
                itens_base = self._fetch_contas_pagar_itens(url, headers, {"numeroDocumento": nro_base})
                found = achar(itens_base)
                if found:
                    return found

            # 4. Busca por formato de primeira parcela ('{nro_base}/1') caso a busca exata tenha vindo vazia
            if nro_base.isdigit() and "/" not in nro_doc_str:
                itens_parc1 = self._fetch_contas_pagar_itens(url, headers, {"numeroDocumento": f"{nro_base}/1"})
                found = achar(itens_parc1)
                if found:
                    return found

            # 5. Se idContato foi usado no passo 1 e nada foi encontrado, tenta buscar por numeroDocumento
            # SEM filtro de idContato (caso o fornecedor cadastrado manualmente no Tiny tenha id diferente)
            if contato_id and not itens_doc:
                itens_sem_contato = self._fetch_contas_pagar_itens(url, headers, {"numeroDocumento": nro_doc_str})
                found = achar(itens_sem_contato)
                if found:
                    logger.info(
                        f"[TINY_V3] Duplicata para '{nro_documento}' só encontrada sem o filtro de "
                        f"idContato ({contato_id}) — cadastro divergente do lançamento original."
                    )
                    return found
        except Exception as e:
            logger.warning(f"[TINY_V3] Falha ao verificar duplicidade de conta {nro_documento}: {e}")

        return None

    def attach_marcadores_v3(
        self,
        conta_id: int,
        marcadores: List[str],
        token: str
    ) -> List[str]:
        """
        Vincula marcadores pré-existentes autorizados à conta a pagar criada no Tiny ERP v3
        através de PUT /public-api/v3/contas-pagar/{conta_id}/marcadores.
        Segurança: Valida contra lista de marcadores pré-existentes autorizados (empresa e caixa/pagamento),
        garantindo que NENHUM novo marcador seja criado indevidamente no ERP.
        """
        if not marcadores or not conta_id:
            return []

        valid_marcadores: List[str] = []
        for m in marcadores:
            if not m:
                continue
            cleaned = m.strip().lower()
            matched = None
            for key, val in ALL_ALLOWED_MARCADORES.items():
                if cleaned == key.lower() or cleaned == val.lower():
                    matched = val
                    break
            if matched and matched not in valid_marcadores:
                valid_marcadores.append(matched)
            elif not matched:
                raise TinyAPIError(
                    f"Marcador '{m}' não cadastrado/autorizado no Tiny ERP. "
                    f"Marcadores autorizados: {sorted(list(set(ALL_ALLOWED_MARCADORES.values())))}. "
                    f"A automação está configurada para não criar novos marcadores no ERP."
                )

        if not valid_marcadores:
            return []

        url = f"https://api.tiny.com.br/public-api/v3/contas-pagar/{conta_id}/marcadores"
        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }
        payload = [{"descricao": m} for m in valid_marcadores]

        try:
            _throttle_tiny_api_call()
            resp = requests.put(url, headers=headers, json=payload, timeout=DEFAULT_TINY_TIMEOUT)
            if resp.status_code in (200, 204):
                logger.info(f"[TINY_V3] Marcador(es) {valid_marcadores} vinculado(s) com sucesso à conta {conta_id}.")
                return valid_marcadores
            raise TinyAPIError(
                f"Erro da API Tiny v3 ao vincular marcador(es) {valid_marcadores} à conta {conta_id}: "
                f"HTTP {resp.status_code}{sufixo_erro(resp)}. "
                f"Verifique se o marcador já existe e está cadastrado no Tiny ERP."
            )
        except requests.RequestException as e:
            raise TinyAPIError(f"Erro de rede ao vincular marcadores à conta {conta_id} no Tiny ERP: {e}")

    def attach_marcador_v3(
        self,
        conta_id: int,
        marcador: Optional[str],
        token: str
    ) -> bool:
        """
        Vincula um único marcador pré-existente à conta a pagar criada no Tiny ERP v3.
        """
        if not marcador:
            return False
        res = self.attach_marcadores_v3(conta_id, [marcador], token)
        return len(res) > 0

    def _fetch_paginated_v3_itens(
        self,
        url: str,
        headers: Dict[str, str],
        params: Dict[str, Any],
        max_pages: int = 10,
        estrito: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        `estrito=True` (conciliação): qualquer resposta diferente de 200 (fora o 429, que é
        re-tentado) vira TinyAPIError na hora. Sem isso, um 401/403/400 encerra a listagem
        com o que já foi lido — lista vazia na 1ª página — e a conciliação mostrava "0 contas
        no Tiny" sem aviso nenhum (o circuito de 403 abaixo só dispara depois de várias
        falhas no MESMO cliente, o que acontece no dashboard, não na prévia).

        Busca TODOS os itens de um endpoint de listagem v3 (`/contas-pagar`, `/contas-receber`,
        `/caixa`, etc.) para os `params` dados, paginando via `limit`/`offset`/`total` — mesmo
        mecanismo de paginação já confirmado contra o swagger oficial e usado por
        `_fetch_contas_pagar_itens` (checagem de duplicidade). Mantido como método próprio (em
        vez de reaproveitar aquele) para não arriscar alterar o fluxo de duplicidade fiscal por
        uma necessidade de leitura só de relatório (dashboard financeiro).
        Limitado a `max_pages` (padrão 1000 registros) como teto de segurança.

        Usa um throttle próprio, mais folgado (`_throttle_tiny_dashboard_call`). Dois tipos
        de falha são tratados de forma BEM diferente, com base no incidente real de
        2026-09-21 (ver [[project_tiny_dashboard_sync_incident]]):
        - HTTP 429 (rate limit de verdade — Tiny parece liberar um "estoque" de ~40
          requisições e depois exigir desacelerar): espera com backoff crescente e TENTA
          DE NOVO a mesma página, porque isso se resolve sozinho com tempo. Só desiste
          depois de `_TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES` tentativas.
        - HTTP 403 sem corpo, persistente mesmo após retentativas (mesmo critério já usado
          em `_send_conta_pagar_v3`): é falta de escopo/permissão OAuth, não bloqueio
          temporário — backoff não ajuda, aborta cedo com `TinyAPIError` informativo após
          `_TINY_DASHBOARD_MAX_CONSECUTIVE_BLOCK_FAILURES` respostas seguidas.
        """
        limit = 100
        all_itens: List[Dict[str, Any]] = []
        page = 0
        rate_limit_attempt = 0
        network_attempt = 0
        while page < max_pages:
            page_params = {**params, "limit": limit, "offset": page * limit}
            _throttle_tiny_dashboard_call(headers.get("Authorization", ""))
            try:
                resp = requests.get(url, headers=headers, params=page_params, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
                if resp.status_code == 401 and self.oauth_manager.is_configured():
                    new_token = self.oauth_manager.refresh_access_token()
                    headers = {**headers, "Authorization": f"Bearer {new_token}"}
                    _throttle_tiny_dashboard_call(headers.get("Authorization", ""))
                    resp = requests.get(url, headers=headers, params=page_params, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
            except requests.exceptions.RequestException as e:
                # Falha de rede/DNS, não uma resposta HTTP — ver comentário da constante
                # acima. Tenta de novo (backoff curto) antes de desistir daquela página.
                network_attempt += 1
                if network_attempt <= _TINY_DASHBOARD_MAX_NETWORK_RETRIES:
                    wait_seconds = _TINY_DASHBOARD_NETWORK_RETRY_BASE_WAIT_SECONDS * network_attempt
                    logger.warning(
                        f"[TINY_V3] Falha de rede ao chamar {url}: {e} — aguardando {wait_seconds:.0f}s "
                        f"antes de tentar de novo (tentativa {network_attempt}/{_TINY_DASHBOARD_MAX_NETWORK_RETRIES})..."
                    )
                    time.sleep(wait_seconds)
                    continue  # tenta a MESMA página de novo, sem avançar
                raise TinyAPIError(
                    f"Falha de rede persistente ao chamar {url} mesmo após "
                    f"{_TINY_DASHBOARD_MAX_NETWORK_RETRIES} tentativas: {e}"
                )
            network_attempt = 0

            if resp.status_code == 429:
                rate_limit_attempt += 1
                if rate_limit_attempt <= _TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES:
                    retry_after = resp.headers.get("Retry-After") if hasattr(resp, "headers") else None
                    wait_seconds = (
                        float(retry_after)
                        if retry_after and str(retry_after).isdigit()
                        else _TINY_DASHBOARD_RATE_LIMIT_BASE_WAIT_SECONDS * rate_limit_attempt
                    )
                    logger.warning(
                        f"[TINY_V3] HTTP 429 (rate limit) em {url} — aguardando {wait_seconds:.0f}s "
                        f"antes de tentar de novo (tentativa {rate_limit_attempt}/{_TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES})..."
                    )
                    time.sleep(wait_seconds)
                    continue  # tenta a MESMA página de novo, sem avançar
                raise TinyAPIError(
                    f"Tiny ERP manteve o limite de requisições em {url} (HTTP 429) mesmo após "
                    f"{_TINY_DASHBOARD_MAX_RATE_LIMIT_RETRIES} tentativas com espera crescente — "
                    "sincronização abortada. Tente novamente mais tarde."
                )
            rate_limit_attempt = 0

            if resp.status_code != 200 and estrito:
                raise TinyAPIError(
                    f"Tiny ERP respondeu HTTP {resp.status_code} ao listar {url.rsplit('/', 1)[-1]}"
                    + (" (token expirado ou sem permissão de leitura)" if resp.status_code in (401, 403) else "")
                    + (f": {(resp.text or '').strip()[:200]}" if (resp.text or "").strip() else "")
                )
            if resp.status_code == 403:
                fail_count = self._consecutive_block_failures.get(url, 0) + 1
                self._consecutive_block_failures[url] = fail_count
                logger.warning(
                    f"[TINY_V3] Falha ao listar {url} (HTTP 403): {resp.text[:200]} "
                    f"[{fail_count}/{_TINY_DASHBOARD_MAX_CONSECUTIVE_BLOCK_FAILURES} falhas seguidas]"
                )
                if fail_count >= _TINY_DASHBOARD_MAX_CONSECUTIVE_BLOCK_FAILURES:
                    body_text = (resp.text or "").strip()
                    if not body_text.startswith("{"):
                        # 403 SEM corpo que NÃO se resolve após várias tentativas — mesmo
                        # critério já usado em _send_conta_pagar_v3: um 403 vazio isolado
                        # pode ser blip de infraestrutura, mas persistente é sinal de que o
                        # token/aplicação OAuth não tem escopo de leitura pra este endpoint
                        # (diferente de um 403 com corpo JSON, que já cai no ramo genérico
                        # abaixo com a mensagem de erro real do Tiny).
                        raise TinyAPIError(
                            f"Sem permissão para ler {url} (HTTP 403 persistente, sem corpo de erro). "
                            "Verifique se a aplicação OAuth do Tiny ERP tem o escopo de leitura para "
                            "este recurso (Caixa/Contas a Pagar/Contas a Receber) habilitado — pode "
                            "ser preciso reautorizar a conexão após ajustar o escopo."
                        )
                    raise TinyAPIError(
                        f"Erro persistente (HTTP 403) ao listar {url}: {body_text[:200]}"
                    )
                break
            if resp.status_code != 200:
                logger.warning(
                    f"[TINY_V3] Falha ao listar {url} (HTTP {resp.status_code}): {resp.text[:200]}"
                )
                break
            self._consecutive_block_failures[url] = 0
            data = resp.json()
            itens = data.get("itens", [])
            all_itens.extend(itens)
            total = data.get("total") or (data.get("paginacao") or {}).get("total")
            if not itens or len(itens) < limit or (total is not None and len(all_itens) >= total):
                break
            page += 1
        return all_itens

    def list_contas_pagar_v3(
        self,
        token: str,
        situacao: Optional[str] = None,
        data_inicial_vencimento: Optional[str] = None,
        data_final_vencimento: Optional[str] = None,
        max_pages: int = 300,
        estrito: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Lista contas a pagar (GET /contas-pagar) filtradas por situação/vencimento, para fins de
        relatório (ex.: dashboard financeiro) — não confundir com a busca de duplicidade em
        `check_duplicate_conta_v3`, que tem critérios próprios de correspondência.

        `max_pages=300` (30.000 itens, limit=100/página): confirmado em 2026-09-22 que contas
        com volume alto (Revesta: 10.120 em aberto só em contas a receber) estouravam o teto
        antigo de 10 páginas (1.000 itens), descartando silenciosamente até 90% das contas reais
        do "vencido"/aging do dashboard financeiro — única consumidora desta função no código.
        """
        url = "https://api.tiny.com.br/public-api/v3/contas-pagar"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        params: Dict[str, Any] = {}
        if situacao:
            params["situacao"] = situacao
        if data_inicial_vencimento:
            params["dataInicialVencimento"] = data_inicial_vencimento
        if data_final_vencimento:
            params["dataFinalVencimento"] = data_final_vencimento
        return self._fetch_paginated_v3_itens(url, headers, params, max_pages=max_pages, estrito=estrito)

    def list_contas_pagar_abertas(
        self,
        token: str,
        data_inicial_vencimento: Optional[str] = None,
        data_final_vencimento: Optional[str] = None,
        max_pages: int = 300,
    ) -> List[Dict[str, Any]]:
        """Lista todas as contas a pagar em aberto no Tiny v3."""
        return self.list_contas_pagar_v3(
            token=token,
            situacao="aberto",
            data_inicial_vencimento=data_inicial_vencimento,
            data_final_vencimento=data_final_vencimento,
            max_pages=max_pages,
        )

    def obter_conta_pagar_v3(
        self, token: str, conta_id: int, max_retries: int = 3
    ) -> Tuple[Dict[str, Any], str]:
        """
        GET /contas-pagar/{id}: situação, valor, saldo, valor pago e histórico atuais da conta.
        Devolve (conta, token), com o token renovado se houve 401. Levanta RuntimeError se não
        conseguir ler (quem chama decide: não baixar às cegas).
        """
        url = f"https://api.tiny.com.br/public-api/v3/contas-pagar/{conta_id}"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        erro = ""
        for attempt in range(1, max_retries + 1):
            try:
                _throttle_tiny_api_call()
                resp = requests.get(url, headers=headers, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
            except requests.RequestException as e:
                erro = str(e)
                if attempt < max_retries:
                    time.sleep(attempt * 2)
                continue
            if resp.status_code == 401 and self.oauth_manager.is_configured():
                token = self.oauth_manager.refresh_access_token()
                headers["Authorization"] = f"Bearer {token}"
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                erro = f"HTTP {resp.status_code}"
                if attempt < max_retries:
                    time.sleep(attempt * 2)
                continue
            if resp.status_code == 200:
                return dict(resp.json() or {}), token
            erro = f"HTTP {resp.status_code}{sufixo_erro(resp)}"
            break
        raise RuntimeError(f"Não foi possível ler a conta a pagar #{conta_id} no Tiny ({erro}).")

    def obter_contas_financeiras_v3(
        self,
        token: str,
        situacao: str = "A",
        max_retries: int = 3,
        max_paginas: int = 20,
    ) -> List[Dict[str, Any]]:
        """
        Consulta as contas financeiras no Tiny ERP v3 (GET /public-api/v3/contas-financeiras),
        página a página (100 por página, até `paginacao.total`). Retorna a lista de contas.

        O token é o da filial (api_tokens): num 401 não adianta renovar pelo OAuth global —
        seria o token de outra conta —, então a listagem para ali.
        """
        url = "https://api.tiny.com.br/public-api/v3/contas-financeiras"
        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }
        limite = 100
        contas: List[Dict[str, Any]] = []

        for pagina in range(max_paginas):
            params = {"situacao": situacao, "limit": limite, "offset": pagina * limite}
            data: Optional[Dict[str, Any]] = None
            for attempt in range(1, max_retries + 1):
                try:
                    _throttle_tiny_api_call()
                    logger.info(
                        f"[TINY_V3] Consultando contas financeiras, página {pagina + 1} "
                        f"(tentativa {attempt}/{max_retries})..."
                    )
                    response = requests.get(url, headers=headers, params=params, timeout=DEFAULT_TINY_TIMEOUT)
                    if response.status_code == 401:
                        logger.warning("[TINY_V3] HTTP 401 ao listar contas financeiras: token da filial sem acesso.")
                        self.token_repository.invalidate_cache()
                        return contas
                    if response.status_code in (200, 204):
                        data = response.json() if response.status_code == 200 else {}
                        break
                    logger.warning(
                        f"[TINY_V3] Falha ao obter contas financeiras: HTTP {response.status_code} - {response.text[:200]}"
                    )
                except Exception as e:
                    logger.warning(
                        f"[TINY_V3] Erro de rede ao consultar contas financeiras (tentativa {attempt}/{max_retries}): {e}"
                    )
                    if attempt == max_retries and not contas:
                        raise
                time.sleep(1.0)
            if data is None:
                # Página falhou mesmo com as retentativas: fica com o que já foi lido.
                return contas

            itens = data.get("itens") or []
            contas.extend(itens)
            total = (data.get("paginacao") or {}).get("total")
            if len(itens) < limite or (isinstance(total, int) and len(contas) >= total):
                return contas

        logger.warning(f"[TINY_V3] Contas financeiras: parou no limite de {max_paginas} páginas ({len(contas)} lidas).")
        return contas

    def resolve_conta_origem_inter(
        self,
        token: str,
        account_id: str = "",
    ) -> Optional[int]:
        """
        Localiza o ID da conta financeira correspondente ao Banco Inter para a empresa.
        Prioridade:
        1. Cache em memória.
        2. TINY_CONTA_ORIGEM_MAP configurado no settings.
        3. Consulta à API v3 do Tiny (/public-api/v3/contas-financeiras?situacao=A) pelo nome exato
           (TINY_CONTA_ORIGEM_MAP ou CONTA_INTER_POR_EMPRESA). Sem ela, ou com mais de uma, None.
        """
        cache_key = f"{account_id}:{token}"
        if cache_key in self._conta_origem_inter_cache:
            return self._conta_origem_inter_cache[cache_key]

        # 1. Checa override em settings (ex.: TINY_CONTA_ORIGEM_MAP="norvia_curitiba:12345")
        origem_map = settings.get_tiny_conta_origem_map()
        override_val = origem_map.get(account_id) or origem_map.get(account_id.lower())
        if override_val:
            try:
                # Se for número inteiro direto
                conta_id = int(override_val)
                self._conta_origem_inter_cache[cache_key] = conta_id
                logger.info(f"[TINY_V3] Conta de origem configurada estaticamente para '{account_id}': ID {conta_id}")
                return conta_id
            except ValueError:
                pass

        if not token or token in ("mock", "seu_token_aqui"):
            return None

        # Falha também fica no cache (o TinyClient vive um lote de baixas): sem isso, cada item
        # do lote repetia a listagem, com retentativas, gastando o limite de requisições do Tiny.
        self._conta_origem_inter_cache[cache_key] = None
        try:
            contas = self.obter_contas_financeiras_v3(token)
        except Exception as e:
            logger.warning(f"[TINY_V3] Falha ao listar contas financeiras para resolver conta Inter de '{account_id}': {e}")
            return None

        if not contas:
            logger.warning(f"[TINY_V3] Nenhuma conta financeira retornada do Tiny para '{account_id}'.")
            return None

        def _achou(c: Dict[str, Any], motivo: str) -> int:
            cid = int(c["id"])
            self._conta_origem_inter_cache[cache_key] = cid
            logger.info(f"[TINY_V3] {motivo} para '{account_id}': '{c.get('descricao')}' (ID {cid})")
            return cid

        # Nome exato (sem diferenciar maiúsculas/acentos/espaços): ou acha essa conta, ou não baixa com outra.
        nome = override_val or CONTA_INTER_POR_EMPRESA.get(account_id.lower())
        if nome:
            alvo = _normalize(nome)
            candidatas = [c for c in contas if _normalize(c.get("descricao") or "") == alvo]
            if len(candidatas) == 1:
                return _achou(candidatas[0], "Conta de origem localizada")
            motivo = "mais de uma conta" if candidatas else "nenhuma conta"
        else:
            motivo = "nenhum nome de conta configurado"
        logger.warning(
            f"[TINY_V3] {motivo} '{nome}' para '{account_id}' — baixa não será feita. "
            f"Contas disponíveis no Tiny: {[c.get('descricao') for c in contas]}"
        )
        return None

    def baixar_conta_pagar_v3(
        self,
        token: str,
        conta_id: int,
        valor_pago: float,
        data_pagamento: Optional[str] = None,
        conta_origem_id: Optional[int] = None,
        categoria_id: Optional[int] = None,
        juros: float = 0.0,
        multa: float = 0.0,
        desconto: float = 0.0,
        historico: Optional[str] = None,
        max_retries: int = 3,
        conta_atual: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Executa a baixa de uma conta a pagar no Tiny ERP v3.
        POST /public-api/v3/contas-pagar/{idContaPagar}/baixar
        Retorna True em caso de sucesso (HTTP 204 ou 200), ou levanta exceção com detalhes.

        Idempotência (AUT-03): o POST só é repetido quando o pedido certamente não foi gravado
        (401 renovado, 429, falha ao conectar). Em erro ambíguo — timeout de leitura, conexão
        caída no meio, HTTP 5xx — a baixa pode ter entrado: a conta é relida e, se já consta o
        pagamento, devolve True sem repetir; se continua intocada, tenta de novo; se não dá para
        saber, levanta pedindo conferência no Tiny. `conta_atual` (GET feito por quem chama logo
        antes) é a referência de "antes"; sem ela, a decisão usa só a situação relida.
        """
        url = f"https://api.tiny.com.br/public-api/v3/contas-pagar/{conta_id}/baixar"
        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }

        # Formata data caso esteja em date ou YYYY-MM-DD
        data_str = str(data_pagamento or date.today().isoformat())
        if len(data_str) == 10 and data_str[4] == "-" and data_str[7] == "-":
            y, m, d = data_str.split("-")
            data_formatada = f"{d}/{m}/{y}"  # Tiny aceita formato dd/mm/yyyy
        else:
            data_formatada = data_str

        payload: Dict[str, Any] = {
            "valorPago": round(float(valor_pago), 2),
            "data": data_formatada,
            "juros": round(float(juros), 2),
            "desconto": round(float(desconto), 2),
            "acrescimo": round(float(multa), 2),
            "taxa": 0.0,
        }
        if conta_origem_id:
            payload["contaOrigem"] = {"id": int(conta_origem_id)}
        if categoria_id:
            payload["categoria"] = {"id": int(categoria_id)}
        antes: Optional[Dict[str, Any]] = conta_atual
        if historico:
            # O "historico" da baixa substitui o da conta no Tiny: sem juntar com o atual, a
            # referência original (ex.: "Ref. as Notas Fiscais - 635; 646") se perdia.
            if antes is not None and "historico" in antes:
                atual = str(antes.get("historico") or "")
            else:
                # A mesma leitura serve de referência de "antes" para a checagem de idempotência.
                try:
                    antes, token = self.obter_conta_pagar_v3(token, conta_id, max_retries)
                except RuntimeError as e:
                    raise RuntimeError(
                        f"Conta #{conta_id} não baixada: não foi possível ler o histórico atual no Tiny ({e})."
                    ) from e
                headers["Authorization"] = f"Bearer {token}"
                atual = str(antes.get("historico") or "")
            payload["historico"] = juntar_historico_baixa(atual, str(historico))

        def _resolver_ambiguo(motivo: str, attempt: int) -> Optional[bool]:
            """True = a baixa entrou; None = não entrou (pode repetir). Levanta se incerto."""
            nonlocal token
            logger.warning(
                f"[TINY_V3] Resposta ambígua ao baixar conta #{conta_id} ({motivo}, tentativa {attempt}/{max_retries}): "
                "relendo a conta antes de decidir."
            )
            try:
                depois, token = self.obter_conta_pagar_v3(token, conta_id, max_retries)
                headers["Authorization"] = f"Bearer {token}"
            except Exception as e_ler:
                raise RuntimeError(
                    f"Baixa da conta #{conta_id} em estado incerto ({motivo}) e a releitura falhou ({e_ler}). "
                    "Confira no Tiny antes de repetir."
                )
            situacao = baixa_entrou(antes, depois)
            if situacao is True:
                logger.info(f"[TINY_V3] Conta #{conta_id}: a baixa entrou apesar do erro ({motivo}); não repete.")
                return True
            if situacao is None:
                raise RuntimeError(
                    f"Baixa da conta #{conta_id} em estado incerto ({motivo}): a conta mudou "
                    f"(situação '{depois.get('situacao')}'). Confira no Tiny antes de repetir."
                )
            if attempt >= max_retries:
                raise RuntimeError(
                    f"Erro de comunicação com Tiny ERP ao baixar conta #{conta_id} ({motivo}); "
                    "a conta segue sem a baixa. Tente de novo."
                )
            return None

        for attempt in range(1, max_retries + 1):
            try:
                _throttle_tiny_api_call()
                logger.info(f"[TINY_V3] Baixando conta #{conta_id} (R$ {valor_pago:.2f}, tentativa {attempt}/{max_retries})...")
                response = requests.post(url, headers=headers, json=payload, timeout=DEFAULT_TINY_TIMEOUT)
            except requests.ConnectTimeout as e:
                # Não chegou a conectar: o pedido não foi enviado, repetir é seguro.
                logger.warning(f"[TINY_V3] Sem conexão ao baixar conta #{conta_id} (tentativa {attempt}/{max_retries}): {e}")
                if attempt >= max_retries:
                    raise RuntimeError(f"Erro de comunicação com Tiny ERP ao baixar conta #{conta_id}: {e}")
                time.sleep(attempt * 2)
                continue
            except requests.RequestException as e:
                if _resolver_ambiguo(type(e).__name__, attempt):
                    return True
                time.sleep(attempt * 2)
                continue

            if response.status_code == 401:
                self.token_repository.invalidate_cache()
                if self.oauth_manager.is_configured():
                    logger.warning("[TINY_V3] HTTP 401 ao baixar conta. Renovando token...")
                    token = self.oauth_manager.refresh_access_token()
                    headers["Authorization"] = f"Bearer {token}"
                    continue

            if response.status_code == 429:
                wait_time = attempt * 2
                logger.warning(f"[TINY_V3] Rate limit atingido (429). Aguardando {wait_time}s...")
                time.sleep(wait_time)
                continue

            if response.status_code in (200, 204):
                logger.info(f"[TINY_V3] Conta #{conta_id} baixada com sucesso no Tiny ERP.")
                return True

            if response.status_code >= 500:
                if _resolver_ambiguo(f"HTTP {response.status_code}", attempt):
                    return True
                time.sleep(attempt * 2)
                continue

            error_msg = f"HTTP {response.status_code}"
            try:
                err_json = response.json()
                msg = err_json.get("mensagem") or err_json.get("error")
                detalhes = err_json.get("detalhes")
                if detalhes and isinstance(detalhes, list):
                    msg_detalhes = "; ".join(
                        f"{d.get('campo')}: {d.get('mensagem')}"
                        for d in detalhes
                        if isinstance(d, dict)
                    )
                    error_msg = f"{msg} ({msg_detalhes})"
                elif msg:
                    error_msg = str(msg)
            except Exception:
                logger.error(f"[TINY_V3] Resposta não-JSON ao baixar conta #{conta_id}: {(response.text or '')[:500]}")

            logger.error(f"[TINY_V3] Falha ao baixar conta #{conta_id}: {error_msg}")
            raise RuntimeError(f"Erro ao baixar conta #{conta_id} no Tiny: {error_msg}")

        return False

    def list_contas_receber_v3(
        self,
        token: str,
        situacao: Optional[str] = None,
        data_inicial_vencimento: Optional[str] = None,
        data_final_vencimento: Optional[str] = None,
        max_pages: int = 300,
        nome_cliente: Optional[str] = None,
        estrito: bool = False,
    ) -> List[Dict[str, Any]]:
        """Lista contas a receber (GET /contas-receber), espelhando `list_contas_pagar_v3`.
        `nome_cliente` filtra pelo cliente (conciliação Mercado Livre)."""
        url = "https://api.tiny.com.br/public-api/v3/contas-receber"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        params: Dict[str, Any] = {}
        if situacao:
            params["situacao"] = situacao
        if data_inicial_vencimento:
            params["dataInicialVencimento"] = data_inicial_vencimento
        if data_final_vencimento:
            params["dataFinalVencimento"] = data_final_vencimento
        if nome_cliente:
            # A API recusa nomeCliente com mais de 50 caracteres (HTTP 400 "Este valor é muito
            # longo"). Vão os 50 primeiros; a conciliação escolhe a conta pelo número da venda no
            # histórico, então outro cliente com o mesmo começo de nome não atrapalha.
            params["nomeCliente"] = nome_cliente.strip()[:NOME_CLIENTE_MAX_TINY].rstrip()
        return self._fetch_paginated_v3_itens(url, headers, params, max_pages=max_pages, estrito=estrito)

    def list_pedidos_v3(
        self,
        token: str,
        data_inicial: Optional[str] = None,
        data_final: Optional[str] = None,
        numero_pedido_ecommerce: Optional[str] = None,
        max_pages: int = 300,
    ) -> List[Dict[str, Any]]:
        """
        Pedidos de venda (GET /pedidos), com cliente (nome, CPF/CNPJ) e o número do pedido no
        e-commerce — a ligação da venda do Mercado Livre com o cliente do Contas a Receber.
        Datas em AAAA-MM-DD (data do pedido).
        """
        url = "https://api.tiny.com.br/public-api/v3/pedidos"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        params: Dict[str, Any] = {}
        if data_inicial:
            params["dataInicial"] = data_inicial
        if data_final:
            params["dataFinal"] = data_final
        if numero_pedido_ecommerce:
            params["numeroPedidoEcommerce"] = numero_pedido_ecommerce
        return self._fetch_paginated_v3_itens(url, headers, params, max_pages=max_pages, estrito=True)

    def obter_conta_receber_v3(self, token: str, conta_id: int) -> Dict[str, Any]:
        """GET /contas-receber/{id}: situação, valor, saldo e valor pago atuais da conta."""
        url = f"https://api.tiny.com.br/public-api/v3/contas-receber/{conta_id}"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        _throttle_tiny_api_call()
        response = requests.get(url, headers=headers, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
        if response.status_code != 200:
            raise TinyAPIError(
                f"Tiny ERP respondeu HTTP {response.status_code} ao ler a conta a receber #{conta_id}"
                + sufixo_erro(response)
            )
        return response.json()

    def baixar_conta_receber_v3(
        self,
        token: str,
        conta_id: int,
        valor_pago: float,
        data_pagamento: str,
        conta_destino_id: int,
        categoria_id: int,
        max_retries: int = 3,
        conta_atual: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        POST /contas-receber/{id}/baixar (payload do notebook de conciliação ML).
        Idempotência (B1): só repete sem reler quando o pedido certamente não foi gravado
        (ConnectTimeout ou falha comprovada de DNS/conexão recusada). Em erro ambíguo — timeout de
        leitura (ReadTimeout), conexão caída no meio, HTTP 5xx — a baixa pode ter entrado: a conta
        é relida e, se já consta o pagamento, retorna sucesso sem repetir; se continua intocada,
        tenta de novo; se não dá para saber ou a releitura falhar, levanta RuntimeError pedindo
        conferência no Tiny. Repete em HTTP 429.
        """
        url = f"https://api.tiny.com.br/public-api/v3/contas-receber/{conta_id}/baixar"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        payload = {
            "contaDestino": {"id": int(conta_destino_id)},
            "data": data_pagamento,
            "categoria": {"id": int(categoria_id)},
            "valorPago": round(float(valor_pago), 2),
        }
        antes: Optional[Dict[str, Any]] = conta_atual

        def _resolver_ambiguo(motivo: str, attempt: int) -> Optional[bool]:
            """True = a baixa entrou; None = não entrou (pode repetir). Levanta se incerto."""
            logger.warning(
                f"[TINY_V3] Resposta ambígua ao baixar conta a receber #{conta_id} ({motivo}, tentativa {attempt}/{max_retries}): "
                "relendo a conta antes de decidir."
            )
            try:
                depois = self.obter_conta_receber_v3(token, conta_id)
            except Exception as e_ler:
                raise RuntimeError(
                    f"Baixa da conta a receber #{conta_id} em estado incerto ({motivo}) e a releitura falhou ({e_ler}). "
                    "Confira no Tiny antes de repetir."
                ) from e_ler
            situacao = baixa_entrou(antes, depois)
            if situacao is True:
                logger.info(f"[TINY_V3] Conta a receber #{conta_id}: a baixa entrou apesar do erro ({motivo}); não repete.")
                return True
            if situacao is None:
                raise RuntimeError(
                    f"Baixa da conta a receber #{conta_id} em estado incerto ({motivo}): a conta mudou "
                    f"(situação '{depois.get('situacao')}'). Confira no Tiny antes de repetir."
                )
            if attempt >= max_retries:
                raise RuntimeError(
                    f"Erro de comunicação com Tiny ERP ao baixar conta a receber #{conta_id} ({motivo}); "
                    "a conta segue sem a baixa. Tente de novo."
                )
            return None

        for attempt in range(1, max_retries + 1):
            _throttle_tiny_api_call()
            try:
                response = requests.post(url, headers=headers, json=payload, timeout=DEFAULT_TINY_TIMEOUT)
            except requests.ConnectTimeout as e:
                # Não chegou a conectar: o pedido não foi enviado, repetir é seguro.
                logger.warning(
                    f"[TINY_V3] Falha de conexão ao baixar conta a receber #{conta_id} (tentativa {attempt}/{max_retries}): {e}"
                )
                if attempt >= max_retries:
                    raise RuntimeError(
                        f"Erro de comunicação com o Tiny ao baixar a conta a receber #{conta_id}: {e}. "
                        "Confira no Tiny antes de repetir."
                    )
                time.sleep(attempt * 2)
                continue
            except requests.RequestException as e:
                # Falha de DNS comprovada antes do envio
                erro_txt = str(e)
                eh_dns = "NameResolutionError" in erro_txt or "Temporary failure in name resolution" in erro_txt
                if eh_dns:
                    if attempt >= max_retries:
                        raise RuntimeError(
                            f"Erro de comunicação com o Tiny ao baixar a conta a receber #{conta_id}: {e}. "
                            "Confira no Tiny antes de repetir."
                        )
                    time.sleep(attempt * 2)
                    continue
                # Qualquer outro erro de rede (ReadTimeout, conexão interrompida durante o envio, etc.):
                if _resolver_ambiguo(type(e).__name__, attempt):
                    return
                time.sleep(attempt * 2)
                continue

            if response.status_code == 429:
                wait_time = attempt * 5
                if attempt < max_retries:
                    time.sleep(wait_time)
                    continue

            if response.status_code in (200, 204):
                logger.info(f"[TINY_V3] Conta a receber #{conta_id} baixada (R$ {valor_pago:.2f}).")
                return

            if response.status_code >= 500:
                if _resolver_ambiguo(f"HTTP {response.status_code}", attempt):
                    return
                time.sleep(attempt * 2)
                continue

            if response.status_code == 401:
                self.token_repository.invalidate_cache()
            mensagem = f"HTTP {response.status_code}"
            try:
                corpo = response.json()
                mensagem = str(corpo.get("mensagem") or corpo.get("error") or mensagem)
                detalhes = corpo.get("detalhes")
                if isinstance(detalhes, list) and detalhes:
                    mensagem += " (" + "; ".join(
                        f"{d.get('campo')}: {d.get('mensagem')}" for d in detalhes if isinstance(d, dict)
                    ) + ")"
            except Exception:
                logger.error(f"[TINY_V3] Resposta não-JSON ao baixar conta a receber #{conta_id}: {(response.text or '')[:500]}")
            if response.status_code == 403:
                mensagem += " (Permissão negada no Tiny ERP: verifique no painel do Tiny se o token da API v3 possui a permissão 'Baixar' em Contas a Receber habilitada)"
            raise RuntimeError(f"Erro ao baixar a conta a receber #{conta_id} no Tiny: {mensagem}")

    def list_caixa_v3(
        self,
        token: str,
        id_categoria: Optional[str] = None,
        data_inicial: Optional[str] = None,
        data_final: Optional[str] = None,
        tipo: Optional[str] = None,
        max_pages: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Lista lançamentos de caixa já efetivados (GET /caixa) — movimentação real de entrada
        (tipo='C') e saída (tipo='D'), diferente de `/contas-pagar`/`/contas-receber` que também
        incluem compromissos em aberto. A API não devolve o campo `categoria` no item da lista
        (confirmado no swagger oficial), só permite FILTRAR por `idCategoria` — por isso o
        dashboard financeiro também itera uma categoria por vez pra montar o detalhamento por
        categoria (além de uma chamada geral sem filtro, que é a fonte de verdade dos totais —
        ver `_sync_one_company`). `max_pages=10` (1.000 itens) é o padrão, suficiente por
        categoria isolada; a chamada geral (soma de todas as categorias, período de até 13
        meses) passa um `max_pages` maior explicitamente, senão estoura o teto silenciosamente
        (confirmado em 2026-09-22: Revesta e Curitiba batendo exatos 1.000 lançamentos).
        """
        url = "https://api.tiny.com.br/public-api/v3/caixa"
        headers = {**TINY_V3_DEFAULT_HEADERS, "Authorization": f"Bearer {token}"}
        params: Dict[str, Any] = {}
        if id_categoria:
            params["idCategoria"] = id_categoria
        if data_inicial:
            params["dataInicial"] = data_inicial
        if data_final:
            params["dataFinal"] = data_final
        if tipo:
            params["tipo"] = tipo
        return self._fetch_paginated_v3_itens(url, headers, params, max_pages=max_pages)

    def list_categorias_receita_despesa_v3(self, token: str, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """
        Consulta as categorias de receita e despesa cadastradas no Tiny ERP v3 para a conta autenticada.
        GET /public-api/v3/categorias-receita-despesa
        Resultados são mantidos em cache de memória (TTL de 30 minutos por token).
        """
        if not token or token.lower() in ("mock", "seu_token_aqui", "") or "COLOQUE" in token:
            return []

        now = time.time()
        cached = self._categories_cache.get(token)
        if cached and not force_refresh:
            cats, exp = cached
            if now < exp:
                return cats

        url = "https://api.tiny.com.br/public-api/v3/categorias-receita-despesa"
        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }

        all_categories: List[Dict[str, Any]] = []
        offset = 0
        limit = 100
        max_pages = 5

        for _ in range(max_pages):
            try:
                _throttle_tiny_api_call()
                params = {"limit": limit, "offset": offset}
                resp = requests.get(url, headers=headers, params=params, timeout=DEFAULT_TINY_QUERY_TIMEOUT)
                if resp.status_code == 401:
                    self.token_repository.invalidate_cache()
                    if self.oauth_manager.is_configured():
                        logger.warning("[TINY_V3] Token expirado ao buscar categorias (401). Renovando...")
                        new_token = self.oauth_manager.refresh_access_token()
                        headers["Authorization"] = f"Bearer {new_token}"
                        resp = requests.get(url, headers=headers, params=params, timeout=DEFAULT_TINY_QUERY_TIMEOUT)

                if resp.status_code != 200:
                    logger.warning(
                        f"[TINY_V3] Falha ao consultar categorias de receita/despesa "
                        f"(HTTP {resp.status_code}): {resp.text[:200]}"
                    )
                    break

                data = resp.json()
                itens = data.get("itens") or []
                if not itens:
                    break

                all_categories.extend(itens)
                if len(itens) < limit:
                    break
                offset += limit
            except Exception as e:
                logger.warning(f"[TINY_V3] Erro de conexão ao buscar categorias no Tiny: {e}")
                break

        if all_categories:
            self._categories_cache[token] = (all_categories, now + 1800)
            logger.info(f"[TINY_V3] Carregadas {len(all_categories)} categorias do Tiny ERP v3 para a conta.")

        return all_categories

    def resolve_categoria_id_v3(
        self,
        token: str,
        categoria_id: Optional[str] = None,
        categoria_nome: Optional[str] = None,
    ) -> Optional[int]:
        """
        Valida e resolve o ID numérico da categoria na conta específica do Tiny ERP v3.
        1. Se categoria_id for válido e pertencer ao cadastro da conta Tiny, retorna int(categoria_id).
        2. Se não pertencer ou não informado, tenta localizar a categoria pelo nome (descrição) exato ou normalizado.
        3. Se categoria_id for um ID estático do catálogo antigo (tiny_categories), descobre o nome original
           e busca pelo nome no cadastro real do Tiny.
        4. Se o cadastro de categorias não puder ser obtido (ex: offline ou erro temporário na API) e categoria_id
           for numérico, retorna int(categoria_id) para fallback retrocompatível.
        5. Se o cadastro foi obtido e nenhuma correspondência for encontrada na conta Tiny, retorna None
           (para que o lançamento ocorra sem a tag 'categoria' e NÃO seja rejeitado com 400 'Categoria não encontrada').
        """
        if not token or (not categoria_id and not categoria_nome):
            return None

        account_cats = self.list_categorias_receita_despesa_v3(token)
        if not account_cats:
            if categoria_id and str(categoria_id).isdigit():
                return int(categoria_id)
            return None

        # Mapeamento de IDs existentes na conta
        cats_by_id = {int(c["id"]): c for c in account_cats if c.get("id") is not None}

        # 1. Se categoria_id já é um ID real existente nesta conta Tiny
        if categoria_id and str(categoria_id).isdigit():
            cid_int = int(categoria_id)
            if cid_int in cats_by_id:
                return cid_int

        # 2. Descobre o nome a buscar
        nome_alvo = categoria_nome
        if not nome_alvo and categoria_id:
            static_cat = CATEGORY_BY_ID.get(str(categoria_id))
            if static_cat:
                nome_alvo = static_cat.nome

        if not nome_alvo:
            return None

        target_clean = _normalize(nome_alvo)

        def _stem_pt(w: str) -> str:
            if w.endswith("ais") or w.endswith("eis") or w.endswith("ois"):
                return w[:-3]
            if w.endswith("al") or w.endswith("el") or w.endswith("ol"):
                return w[:-2]
            if w.endswith("es") and len(w) > 4:
                return w[:-2]
            if w.endswith("s") and len(w) > 3:
                return w[:-1]
            return w

        stopwords = {"de", "do", "da", "dos", "das", "com", "para", "e", "em", "um", "uma"}
        target_words = [_stem_pt(w) for w in target_clean.split() if w not in stopwords]
        target_stemmed = " ".join(target_words)

        # 3. Match exato normalizado
        for c in account_cats:
            desc = c.get("descricao") or ""
            if _normalize(desc) == target_clean:
                logger.info(
                    f"[TINY_V3] Categoria '{nome_alvo}' resolvida para ID {c['id']} "
                    f"('{desc}') na conta Tiny."
                )
                return int(c["id"])

        # 4. Match parcial / continência de termos e raízes (stemming)
        for c in account_cats:
            desc = c.get("descricao") or ""
            desc_clean = _normalize(desc)
            if target_clean and (target_clean in desc_clean or desc_clean in target_clean):
                logger.info(
                    f"[TINY_V3] Categoria '{nome_alvo}' mapeada por aproximação para ID {c['id']} "
                    f"('{desc}') na conta Tiny."
                )
                return int(c["id"])

            desc_words = [_stem_pt(w) for w in desc_clean.split() if w not in stopwords]
            desc_stemmed = " ".join(desc_words)
            if target_stemmed and desc_stemmed and (
                target_stemmed == desc_stemmed
                or target_stemmed in desc_stemmed
                or desc_stemmed in target_stemmed
                or (set(target_words) and set(target_words).issubset(set(desc_words)))
                or (set(desc_words) and set(desc_words).issubset(set(target_words)))
            ):
                logger.info(
                    f"[TINY_V3] Categoria '{nome_alvo}' mapeada por raiz das palavras para ID {c['id']} "
                    f"('{desc}') na conta Tiny."
                )
                return int(c["id"])

        # 5. Não encontrada na conta Tiny vinculada
        logger.warning(
            f"[TINY_V3] Categoria '{nome_alvo}' (id={categoria_id}) NÃO encontrada no cadastro "
            f"da conta Tiny ERP vinculada ({len(account_cats)} categorias cadastradas na conta). "
            f"O lançamento será realizado sem a tag 'categoria' para evitar rejeição da API."
        )
        return None

    def _handle_conta_success_v3(
        self,
        response: requests.Response,
        nro_documento: str,
        duplicata: NFeDuplicate,
        vencimento_efetivo: date,
        nfe_data: NFeData,
        token: str
    ) -> TinyContaResult:
        res_data = response.json() if response.content else {}
        conta_id = int(res_data.get("id", 0))
        logger.info(
            f"Conta a pagar lançada com SUCESSO no Tiny ERP v3! "
            f"ID: {conta_id} | Documento: {nro_documento} | Valor: R$ {duplicata.valor}"
        )

        # Vincula os marcadores pré-existentes autorizados (empresa e caixa/pagamento).
        # A conta a pagar JÁ FOI criada com sucesso neste ponto (é o lançamento
        # financeiro que importa) — uma falha aqui (ex.: bloqueio passageiro do lado do
        # Tiny) não pode derrubar o lançamento inteiro, senão a nota fica travada pra
        # sempre em pending_review mesmo com a conta já existindo de verdade no Tiny
        # (incidente real 2026-09-22, Norvia Campinas, NF-e 46798/46789: conta criada,
        # PUT /marcadores retornou 403, e _finalize_confirmed nunca era chamado).
        marcadores_alvo = (
            list(nfe_data.marcadores)
            if nfe_data.marcadores
            else [m for m in (getattr(nfe_data, "marcador_caixa", None), nfe_data.marcador_empresa) if m]
        )
        marcadores_aplicados = []
        try:
            if len(marcadores_alvo) == 1:
                ok = self.attach_marcador_v3(conta_id, marcadores_alvo[0], token)
                if ok:
                    marcadores_aplicados = [marcadores_alvo[0]]
            elif len(marcadores_alvo) > 1:
                marcadores_aplicados = self.attach_marcadores_v3(conta_id, marcadores_alvo, token)
        except TinyAPIError as e:
            logger.error(
                f"[TINY_V3] Conta {conta_id} (Documento: {nro_documento}) criada com sucesso, mas "
                f"falha ao vincular marcador(es) {marcadores_alvo}: {e}. Lançamento confirmado mesmo "
                f"assim — os marcadores podem precisar ser adicionados manualmente no Tiny ERP."
            )

        marcador_str = ", ".join(marcadores_aplicados) if marcadores_aplicados else (getattr(nfe_data, "marcador_caixa", None) or nfe_data.marcador_empresa)

        return TinyContaResult(
            conta_id=conta_id,
            nro_documento=nro_documento,
            valor=duplicata.valor,
            vencimento=vencimento_efetivo,
            situacao="aberto",
            marcador=marcador_str,
            marcadores=marcadores_aplicados
        )

    def _send_conta_pagar_v3(
        self,
        nfe_data: NFeData,
        duplicata: NFeDuplicate,
        nro_documento: str,
        historico: str,
        token: str,
        max_retries: int = 3,
        categoria_id: Optional[str] = None,
        categoria_nome: Optional[str] = None,
        vencimento_fixo: bool = False,
        duplicidade_estrita: bool = False,
    ) -> TinyContaResult:
        """
        Executa a requisição HTTP POST para a API v3 do Tiny ERP (/public-api/v3/contas-pagar).
        `vencimento_fixo`: usa o vencimento da duplicata como veio (parcelas já calculadas),
        sem reaplicar a regra do marcador de cartão/caixa.
        Suporta Bearer token OAuth2, identificação de contato, detecção de duplicidade,
        resolução dinâmica de categoria e retry resiliente.
        """
        # 1. Resolução do fornecedor/contato
        contato_id = self.resolve_contato_id_v3(token, nfe_data)
        if not contato_id:
            raise TinyAPIError(
                f"Fornecedor '{nfe_data.emitente_nome}' (CNPJ: {nfe_data.emitente_cnpj}) "
                f"não encontrado nos contatos do Tiny ERP para a conta '{nro_documento}'. "
                f"Cadastre o fornecedor no Tiny ou vincule seu CNPJ."
            )

        # 2. Verificação de Duplicidade prévia (chave, fornecedor e valores)
        vencimento_efetivo = duplicata.vencimento
        if getattr(nfe_data, "marcador_caixa", None) and not vencimento_fixo:
            rule_venc = calculate_marker_vencimento(nfe_data.data_emissao, nfe_data.marcador_caixa)
            if rule_venc:
                vencimento_efetivo = rule_venc

        existing_id = self.check_duplicate_conta_v3(
            token=token,
            nro_documento=nro_documento,
            contato_id=contato_id,
            chave=nfe_data.chave,
            valor=duplicata.valor,
            vencimento=vencimento_efetivo,
            estrita=duplicidade_estrita,
            numero_nota=nfe_data.numero_nota,
        )
        if existing_id:
            logger.warning(
                f"[TINY_V3] Conta a pagar '{nro_documento}' já cadastrada no Tiny ERP v3 (ID: {existing_id}). "
                f"Ignorando novo lançamento para evitar duplicidade."
            )
            marcadores_alvo = (
                list(nfe_data.marcadores)
                if nfe_data.marcadores
                else [m for m in (getattr(nfe_data, "marcador_caixa", None), nfe_data.marcador_empresa) if m]
            )
            marcador_str = ", ".join(marcadores_alvo) if marcadores_alvo else (getattr(nfe_data, "marcador_caixa", None) or nfe_data.marcador_empresa)
            return TinyContaResult(
                conta_id=existing_id,
                nro_documento=nro_documento,
                valor=duplicata.valor,
                vencimento=vencimento_efetivo,
                situacao="duplicada",
                is_duplicate=True,
                marcador=marcador_str,
                marcadores=marcadores_alvo
            )

        # 3. Montagem do payload v3
        data_emissao_str = nfe_data.data_emissao.strftime("%Y-%m-%d") if nfe_data.data_emissao else None
        data_venc_str = vencimento_efetivo.strftime("%Y-%m-%d")
        competencia_str = nfe_data.data_emissao.strftime("%Y-%m") if nfe_data.data_emissao else None

        payload: Dict[str, Any] = {
            "data": data_emissao_str,
            "dataVencimento": data_venc_str,
            "valor": float(duplicata.valor),
            "numeroDocumento": str(nro_documento),
            "historico": historico,
            "contato": {
                "id": contato_id
            },
            "dataCompetencia": competencia_str,
            "ocorrencia": "U"
        }
        if categoria_id or categoria_nome:
            resolved_cat_id = self.resolve_categoria_id_v3(
                token=token,
                categoria_id=categoria_id,
                categoria_nome=categoria_nome
            )
            if resolved_cat_id:
                payload["categoria"] = {"id": resolved_cat_id}
            else:
                logger.info(
                    f"[TINY_V3] Documento '{nro_documento}' será lançado sem tag 'categoria' "
                    f"(categoria '{categoria_nome or categoria_id}' não resolvida no Tiny ERP)."
                )

        meio_pagamento_nfe = getattr(nfe_data, "meio_pagamento_nfe", None)
        if meio_pagamento_nfe and meio_pagamento_nfe in SEFAZ_TPAG_TO_TINY_FORMA_PAGAMENTO:
            payload["formaPagamento"] = SEFAZ_TPAG_TO_TINY_FORMA_PAGAMENTO[meio_pagamento_nfe]

        url = "https://api.tiny.com.br/public-api/v3/contas-pagar"
        headers = {
            **TINY_V3_DEFAULT_HEADERS,
            "Authorization": f"Bearer {token}",
        }

        last_exception: Optional[Exception] = None

        for attempt in range(1, max_retries + 1):
            try:
                logger.debug(f"[TINY_V3] Enviando conta '{nro_documento}' (Tentativa {attempt}/{max_retries})...")
                _throttle_tiny_api_call()
                response = requests.post(url, headers=headers, json=payload, timeout=DEFAULT_TINY_TIMEOUT)

                # Tratamento de token expirado prematuramente (401)
                if response.status_code == 401:
                    self.token_repository.invalidate_cache()
                    if self.oauth_manager.is_configured():
                        logger.warning("[TINY_V3] Recebido HTTP 401 do Tiny v3. Forçando renovação imediata do token...")
                        new_token = self.oauth_manager.refresh_access_token()
                        headers["Authorization"] = f"Bearer {new_token}"
                        token = new_token
                        continue

                if response.status_code == 429:
                    wait_time = attempt * 2
                    logger.warning(f"[TINY_V3] Rate limit atingido (429). Aguardando {wait_time}s...")
                    time.sleep(wait_time)
                    continue

                if response.status_code == 403:
                    # HTTP 403 SEM corpo de erro do Tiny (não começa com "{") não é uma rejeição
                    # de validação de payload — essas sempre vêm com JSON e "mensagem". É mais
                    # parecido com bloqueio de infraestrutura/rate-limit por volume de requisições
                    # (mesma família do 429). Incidente real 2026-09-18: 403 vazio em notas
                    # completamente diferentes (uma duplicata de verdade e duas que não eram) na
                    # mesma sessão de lançamento em lote. Vale re-tentar com backoff; se vier com
                    # corpo JSON, é erro de permissão de verdade e cai no tratamento genérico abaixo.
                    body_text = (response.text or "").strip()
                    resp_headers = dict(response.headers) if hasattr(response, "headers") else {}
                    server_name = resp_headers.get("server", "").lower()
                    if not body_text.startswith("{") and attempt < max_retries:
                        wait_time = attempt * 3
                        logger.warning(
                            f"[TINY_V3] HTTP 403 sem corpo de erro para '{nro_documento}' "
                            f"(Tentativa {attempt}/{max_retries}, server={server_name}). Aguardando {wait_time}s..."
                        )
                        time.sleep(wait_time)
                        continue

                if response.status_code in (200, 201):
                    return self._handle_conta_success_v3(
                        response=response,
                        nro_documento=nro_documento,
                        duplicata=duplicata,
                        vencimento_efetivo=vencimento_efetivo,
                        nfe_data=nfe_data,
                        token=token
                    )

                # Tratamento específico de erro HTTP 403
                if response.status_code == 403:
                    body_text = (response.text or "").strip()
                    resp_headers = dict(response.headers) if hasattr(response, "headers") else {}
                    server_name = resp_headers.get("server", "").lower()
                    logger.error(
                        f"[TINY_V3] HTTP 403 Forbidden ao incluir conta '{nro_documento}'. "
                        f"Server: {server_name}, Body: {body_text!r}, Headers: {resp_headers}"
                    )
                    detalhe_corpo = f" - Detalhes: {body_text}" if body_text.startswith("{") else ""
                    raise TinyAPIError(
                        message=(
                            f"Erro da API Tiny v3 ao incluir conta {nro_documento}: HTTP 403 (Proibido). "
                            f"O token da API não possui permissão de escrita para Contas a Pagar. "
                            f"Verifique no Tiny ERP se o usuário possui permissão para 'Incluir' em "
                            f"'Finanças > Contas a Pagar' e se a aplicação OAuth possui o escopo "
                            f"'olist_contas_pagar_create'.{detalhe_corpo}"
                        ),
                        is_duplicate=False
                    )

                # Erros retornados pelo Tiny v3
                try:
                    err_json = response.json()
                    msg = err_json.get("mensagem") or f"HTTP {response.status_code}"
                    detalhes = err_json.get("detalhes", [])
                    detalhes_str = "; ".join(
                        f"{d.get('campo', '')}: {d.get('mensagem', '')}" if isinstance(d, dict) else str(d)
                        for d in detalhes
                    )
                    err_msg = f"{msg} ({detalhes_str})" if detalhes_str else msg
                except Exception:
                    logger.error(f"[TINY_V3] Resposta não-JSON ao incluir '{nro_documento}': {(response.text or '')[:500]}")
                    err_msg = f"HTTP {response.status_code}"

                # Recuperação automática de erro de categoria inválida no Tiny ERP:
                # Se o Tiny rejeitar com "categoria.id: Categoria não encontrada" (400),
                # remove imediatamente a categoria do payload e tenta novamente sem categoria.
                is_cat_error = any(
                    term in err_msg.lower()
                    for term in ("categoria.id", "categoria não encontrada", "categoria nao encontrada")
                )
                if is_cat_error and "categoria" in payload:
                    logger.warning(
                        f"[TINY_V3] Tiny ERP v3 rejeitou a categoria para '{nro_documento}': {err_msg}. "
                        f"Removendo categoria do payload e reenviando imediatamente sem categoria..."
                    )
                    payload_without_cat = dict(payload)
                    payload_without_cat.pop("categoria", None)
                    _throttle_tiny_api_call()
                    retry_resp = requests.post(url, headers=headers, json=payload_without_cat, timeout=DEFAULT_TINY_TIMEOUT)
                    if retry_resp.status_code in (200, 201):
                        return self._handle_conta_success_v3(
                            response=retry_resp,
                            nro_documento=nro_documento,
                            duplicata=duplicata,
                            vencimento_efetivo=vencimento_efetivo,
                            nfe_data=nfe_data,
                            token=token
                        )
                    # Se falhou novamente, atualiza err_msg para o novo erro retornado
                    try:
                        err_json = retry_resp.json()
                        msg = err_json.get("mensagem") or f"HTTP {retry_resp.status_code}"
                        detalhes = err_json.get("detalhes", [])
                        detalhes_str = "; ".join(
                            f"{d.get('campo', '')}: {d.get('mensagem', '')}" if isinstance(d, dict) else str(d)
                            for d in detalhes
                        )
                        err_msg = f"{msg} ({detalhes_str})" if detalhes_str else msg
                    except Exception:
                        err_msg = f"HTTP {retry_resp.status_code}"

                # Detecção de duplicidade em mensagens de erro
                is_duplicate = any(
                    term in err_msg.lower()
                    for term in ("já cadastrada", "já existe", "duplicid", "duplicad")
                )
                if is_duplicate:
                    logger.warning(f"[TINY_V3] Aviso de duplicidade para documento {nro_documento}: {err_msg}")
                    return TinyContaResult(
                        conta_id=0,
                        nro_documento=nro_documento,
                        valor=duplicata.valor,
                        vencimento=vencimento_efetivo,
                        situacao="duplicada",
                        is_duplicate=True,
                        marcador=nfe_data.marcador_empresa
                    )

                raise TinyAPIError(
                    message=f"Erro da API Tiny v3 ao incluir conta {nro_documento}: {err_msg}",
                    is_duplicate=is_duplicate
                )

            except TinyAPIError:
                raise
            except requests.RequestException as e:
                last_exception = e
                wait_time = attempt * 2
                logger.warning(f"[TINY_V3] Erro de rede com a API Tiny: {e}. Aguardando {wait_time}s...")
                time.sleep(wait_time)

        raise TinyAPIError(f"Falha de comunicação persistente com a API Tiny v3: {last_exception}")

    def _build_payload(
        self,
        nfe_data: NFeData,
        duplicata: NFeDuplicate,
        nro_documento: str,
        historico: str,
        categoria_nome: Optional[str] = None
    ) -> Dict[str, Any]:
        """Monta o payload JSON estruturado conforme especificação do Tiny v2."""
        conta_dict: Dict[str, Any] = {
            "data_emissao": format_date_br(nfe_data.data_emissao),
            "vencimento": format_date_br(duplicata.vencimento),
            "competencia": format_date_br(nfe_data.data_emissao),
            "valor": float(duplicata.valor),
            "nro_documento": nro_documento,
            "historico": historico,
            "categoria": categoria_nome or self.default_category,
            "ocorrencia": self.ocorrencia,
            "cliente": {
                "nome": nfe_data.emitente_nome,
                "cpf_cnpj": format_cpf_cnpj(nfe_data.emitente_cnpj)
            }
        }
        if nfe_data.marcador_empresa:
            conta_dict["marcador"] = nfe_data.marcador_empresa

        return {"conta": conta_dict}

    def _send_conta_pagar(
        self,
        payload: Dict[str, Any],
        nro_documento: str,
        duplicata: NFeDuplicate,
        max_retries: int = 3,
        active_token: Optional[str] = None
    ) -> TinyContaResult:
        """
        Executa a requisição HTTP POST para o Tiny com suporte a renovação OAuth2 automática,
        retry exponencial e detecção de duplicidade.
        """
        token = active_token or self.get_active_token()


        # Modo simulação/mock caso o token não esteja configurado
        if not token or token.lower() in ("mock", "seu_token_aqui", "") or "COLOQUE" in token:
            logger.warning(
                f"[SIMULAÇÃO ERP TINY] Token não configurado ou em modo mock. "
                f"Simulando lançamento da conta '{nro_documento}' (R$ {duplicata.valor})."
            )
            return TinyContaResult(
                conta_id=999999,
                nro_documento=nro_documento,
                valor=duplicata.valor,
                vencimento=duplicata.vencimento,
                situacao="aberto (simulado)"
            )

        post_data = {
            "token": token,
            "formato": "json",
            "conta": json.dumps(payload, ensure_ascii=False)
        }
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Bearer {token}"
        }

        last_exception: Optional[Exception] = None

        for attempt in range(1, max_retries + 1):
            try:
                logger.debug(f"Enviando conta '{nro_documento}' ao Tiny (Tentativa {attempt}/{max_retries})...")
                _throttle_tiny_api_call()
                response = requests.post(
                    self.api_url,
                    data=post_data,
                    headers=headers,
                    timeout=DEFAULT_TINY_TIMEOUT
                )

                # Tratamento de token expirado prematuramente (401)
                if response.status_code == 401 and self.oauth_manager.is_configured():
                    logger.warning("Recebido HTTP 401 do Tiny. Forçando renovação imediata do token OAuth2...")
                    new_token = self.oauth_manager.refresh_access_token()
                    post_data["token"] = new_token
                    headers["Authorization"] = f"Bearer {new_token}"
                    continue

                if response.status_code == 429:
                    wait_time = attempt * 2
                    logger.warning(f"Rate limit atingido na API do Tiny (429). Aguardando {wait_time}s...")
                    time.sleep(wait_time)
                    continue

                response.raise_for_status()
                response_json = response.json()

                return self._parse_tiny_response(response_json, nro_documento, duplicata)

            except TinyAPIError as e:
                raise e
            except requests.RequestException as e:
                last_exception = e
                wait_time = attempt * 2
                logger.warning(f"Erro de rede com a API do Tiny: {e}. Tentando novamente em {wait_time}s...")
                time.sleep(wait_time)

        raise TinyAPIError(f"Falha de comunicação persistente com a API do Tiny: {last_exception}")

    def _parse_tiny_response(
        self,
        response_json: Dict[str, Any],
        nro_documento: str,
        duplicata: NFeDuplicate
    ) -> TinyContaResult:
        """Interpreta a resposta do Tiny e trata status de sucesso, aviso e erro."""
        retorno = response_json.get("retorno", {})
        status = retorno.get("status", "").upper()

        if status == "OK":
            registros = retorno.get("registros", {})
            registro = registros.get("registro", {}) if isinstance(registros, dict) else {}
            conta_id = int(registro.get("id", 0))
            situacao = registro.get("situacao", "aberto")

            logger.info(
                f"Conta a pagar lançada com SUCESSO no Tiny! "
                f"ID: {conta_id} | Documento: {nro_documento} | Valor: R$ {duplicata.valor}"
            )
            return TinyContaResult(
                conta_id=conta_id,
                nro_documento=nro_documento,
                valor=duplicata.valor,
                vencimento=duplicata.vencimento,
                situacao=situacao
            )

        # Tratar Erros retornados pelo Tiny
        erros_raw = retorno.get("erros", [])
        error_messages: List[str] = []
        is_duplicate = False

        if isinstance(erros_raw, list):
            for err in erros_raw:
                msg = err.get("erro", "") if isinstance(err, dict) else str(err)
                error_messages.append(msg)
                if any(term in msg.lower() for term in ("já cadastrada", "já existe", "duplicid", "duplicad")):
                    is_duplicate = True

        combined_error = "; ".join(error_messages) or "Erro não especificado retornado pela API do Tiny."

        if is_duplicate:
            logger.warning(
                f"Aviso de duplicidade no Tiny para documento {nro_documento}: {combined_error}"
            )
            return TinyContaResult(
                conta_id=0,
                nro_documento=nro_documento,
                valor=duplicata.valor,
                vencimento=duplicata.vencimento,
                situacao="duplicada",
                is_duplicate=True
            )

        raise TinyAPIError(
            message=f"Erro da API Tiny ao incluir conta {nro_documento}: {combined_error}",
            errors=error_messages,
            is_duplicate=is_duplicate
        )


def main() -> None:
    """CLI utilitário para gerenciamento e autenticação OAuth2 do Tiny ERP."""
    parser = argparse.ArgumentParser(description="Gerenciador OAuth2 do Tiny ERP")
    parser.add_argument("--auth-url", action="store_true", help="Gera a URL de autorização para abrir no navegador")
    parser.add_argument("--exchange", type=str, help="Troca o código de autorização obtido no navegador por tokens")
    parser.add_argument("--set-refresh-token", type=str, help="Define um refresh token manualmente e gera o par de tokens")
    parser.add_argument("--refresh", action="store_true", help="Força a renovação do Access Token agora")
    parser.add_argument("--status", action="store_true", help="Exibe o status do token atual e tempo restante")
    args = parser.parse_args()

    oauth = TinyOAuthManager()

    if not oauth.is_configured():
        print("[ERRO] TINY_CLIENT_ID e TINY_CLIENT_SECRET precisam estar configurados no .env")
        sys.exit(1)

    if args.auth_url:
        print("\n=== AUTORIZAÇÃO OAUTH2 TINY ERP ===")
        print("1. Abra a URL abaixo no seu navegador:")
        print(oauth.get_authorization_url())
        print("\n2. Clique em Autorizar.")
        print("3. Você será redirecionado para uma URL contendo '?code=SEU_CODIGO'.")
        print("4. Copie esse código e execute:")
        print("   python -m app.tiny_client --exchange SEU_CODIGO\n")

    elif args.exchange:
        try:
            token = oauth.exchange_code(args.exchange)
            print("[SUCESSO] Tokens obtidos e salvos no cache!")
            print(f"Access Token ativo: {token[:15]}...")
        except Exception as e:
            print(f"[ERRO] {e}")
            sys.exit(1)

    elif args.set_refresh_token:
        try:
            oauth.current_refresh_token = args.set_refresh_token.strip()
            token = oauth.refresh_access_token()
            print("[SUCESSO] Refresh token configurado e novo Access Token gerado com sucesso!")
            print(f"Access Token ativo: {token[:15]}...")
        except Exception as e:
            print(f"[ERRO] {e}")
            sys.exit(1)

    elif args.refresh:
        try:
            token = oauth.refresh_access_token()
            print("[SUCESSO] Token renovado com sucesso!")
            print(f"Novo Access Token: {token[:15]}...")
        except Exception as e:
            print(f"[ERRO] {e}")
            sys.exit(1)

    elif args.status:
        if oauth.access_token:
            remaining = int(oauth.expires_at - time.time())
            if remaining > 0:
                print(f"[STATUS] Token VÁLIDO! Expira em {remaining} segundos ({int(remaining/60)} minutos).")
            else:
                print("[STATUS] Token EXPIRADO. A aplicação irá renová-lo automaticamente na próxima execução.")
        else:
            print("[STATUS] Nenhum Access Token em cache. Execute com --auth-url para autenticar pela primeira vez.")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
