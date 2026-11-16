"""Base HTTP do cliente Tiny v3: timeouts, throttles por processo/conta, cabeçalhos e conversão de valores.

Extraída de `app/tiny_client.py` (a fachada reexporta tudo). O estado dos throttles
(`_tiny_api_last_call`, `_tiny_dashboard_last_call`) vive aqui.
"""

from __future__ import annotations

import threading
import time
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, List, Optional, Tuple, Union

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
# O intervalo vale POR CONTA do Tiny (chave = cabeçalho Authorization): o limite é da conta e
# cada empresa tem a sua. Com uma fila única para o processo, a conciliação ML de duas empresas
# em paralelo esperaria uma pela outra (06/11/2026). Chamadas da MESMA conta continuam em fila.
_tiny_api_lock = threading.Lock()
_tiny_api_key_locks: Dict[str, threading.Lock] = {}
_tiny_api_last_call: Dict[str, float] = {}


def _throttle_tiny_api_call(chave: str = "") -> None:
    with _tiny_api_lock:
        lock = _tiny_api_key_locks.setdefault(chave, threading.Lock())
    with lock:
        elapsed = time.monotonic() - _tiny_api_last_call.get(chave, 0.0)
        if elapsed < _TINY_API_MIN_INTERVAL_SECONDS:
            time.sleep(_TINY_API_MIN_INTERVAL_SECONDS - elapsed)
        _tiny_api_last_call[chave] = time.monotonic()


def _valor_para_tiny(valor: Union[Decimal, float, int, str]) -> float:
    """
    Único ponto de conversão de dinheiro para o formato do Tiny: a API v3 exige número JSON, então
    o Decimal (quantizado a 2 casas, ROUND_HALF_UP) só vira float na serialização do payload.
    """
    return float(Decimal(str(valor)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


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


class TinyAPIError(Exception):
    """Exceção levantada em caso de erro retornado pela API do Tiny ERP."""

    def __init__(self, message: str, errors: Optional[List[str]] = None, is_duplicate: bool = False) -> None:
        super().__init__(message)
        self.errors = errors or []
        self.is_duplicate = is_duplicate


class TinyCadastroError(TinyAPIError):
    """Recusa por cadastro (fornecedor ausente, CNPJ divergente, contato ambíguo): a ação é no Tiny,
    não no código. Vai para o card da revisão e para a auditoria, em WARNING (não vira incidente)."""
