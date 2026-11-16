"""
Tiny ERP (API v3) para a padronização de dimensões: lista os produtos de uma conta e lê o
cadastro (nome, dimensões, peso bruto). Só leitura: a automação não grava no Tiny.

O token vem da tabela api_tokens do MariaDB (renovado fora daqui, como na automacoes-financeiro).
Unidades do Tiny: largura/altura/comprimento em cm, pesoLiquido/pesoBruto em kg.
"""
import logging
import threading
import time
from typing import Any, Callable, Dict, Iterator, Optional

import requests

from app import retry
from app.config import settings
from app.retry import TENTATIVAS, deve_repetir, espera

logger = logging.getLogger("marketplace.tiny")

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; NorviaAutomacao/1.0; +https://norvia.example)",
}

_throttle_lock = threading.Lock()
_ultima_chamada = 0.0


class TinyAPIError(RuntimeError):
    def __init__(self, mensagem: str, status: Optional[int] = None) -> None:
        super().__init__(mensagem)
        self.status = status


class ClienteTiny:
    def __init__(
        self,
        conta: str,
        token: Callable[[], Optional[str]],
        http: Any = None,
        base_url: Optional[str] = None,
        pausa: Optional[float] = None,
    ) -> None:
        self.conta = conta
        self._token = token
        self.http = http or requests.Session()
        self.base_url = (base_url or settings.TINY_API_URL).rstrip("/")
        self.pausa = settings.TINY_PAUSA_S if pausa is None else pausa

    def _throttle(self) -> None:
        global _ultima_chamada
        with _throttle_lock:
            espera = self.pausa - (time.monotonic() - _ultima_chamada)
            if espera > 0:
                time.sleep(espera)
            _ultima_chamada = time.monotonic()

    def _chamar(self, metodo: str, caminho: str, descricao: str, **kwargs: Any) -> Any:
        token = self._token()
        if not token:
            raise TinyAPIError(f"Sem token do Tiny para a conta {self.conta} (tabela api_tokens).")
        for tentativa in range(1, TENTATIVAS + 1):
            self._throttle()
            try:
                resp = self.http.request(
                    metodo, f"{self.base_url}{caminho}", headers={**HEADERS, "Authorization": f"Bearer {token}"},
                    timeout=30, **kwargs,
                )
            except requests.RequestException as e:
                if tentativa == TENTATIVAS or not deve_repetir(metodo, None):
                    raise TinyAPIError(f"Falha de rede ao {descricao}: {e}") from e
                retry.dormir(espera(tentativa))
                continue
            if (resp.status_code == 429 or resp.status_code >= 500) and deve_repetir(metodo, resp.status_code):
                if tentativa < TENTATIVAS:
                    retry.dormir(espera(tentativa, resp))
                    continue
            if not 200 <= resp.status_code < 300:
                raise TinyAPIError(f"Falha ao {descricao} no Tiny ({self.conta}): HTTP {resp.status_code} - {resp.text[:400]}", resp.status_code)
            return resp.json() if resp.content else {}
        raise TinyAPIError(f"Falha ao {descricao}: sem resposta válida do Tiny")

    def produtos(self) -> Iterator[Dict[str, Any]]:
        """Produtos ativos da conta (id, sku, descricao, dataAlteracao), paginados."""
        offset = 0
        while True:
            pagina = self._chamar(
                "GET", "/produtos", "listar os produtos", params={"situacao": "A", "limit": 100, "offset": offset}
            )
            itens = pagina.get("itens") or []
            yield from itens
            total = int((pagina.get("paginacao") or {}).get("total") or 0)
            offset += len(itens)
            if not itens or offset >= total:
                break

    def produto(self, produto_id: int) -> Dict[str, Any]:
        return self._chamar("GET", f"/produtos/{produto_id}", f"ler o produto {produto_id}")
