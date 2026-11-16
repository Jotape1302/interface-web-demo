"""
Cliente da API Super DDA da Polp (https://polp.com.br/docs/dda): cadastros DDA dos CNPJs e os
boletos registrados na CIP contra eles.

- Autenticação: headers x-api-client / x-api-secret (Dashboard → API Credentials).
- Paginação por cursor (15 itens), seguindo meta.next_cursor.
- Valores em centavos (cost, cost_updated, reduction).
- Consultas funcionam o dia todo; criar/desativar cadastro só das 06h às 22h (não usado aqui:
  o cadastro dos CNPJs e o aceite do Termo de Adesão são feitos no painel da Polp).
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Iterator, List, Optional

import requests

from app.config import Settings, settings
from app.http_errors import sufixo_erro

logger = logging.getLogger("automacao_nfe.polp")

TIMEOUT = (5.0, 30.0)
MAX_PAGINAS = 400  # 6.000 boletos por consulta

# BoletoStatus da Polp
BOLETO_ABERTO = 0
BOLETO_VENCIDO = 1
BOLETO_PAGO = 2
BOLETO_CANCELADO = 3
BOLETO_BAIXADO = 4
BOLETO_BLOQUEADO = 5


class PolpNaoConfigurada(RuntimeError):
    pass


class PolpClient:
    def __init__(self, cfg: Optional[Settings] = None, sessao: Optional[requests.Session] = None) -> None:
        self.cfg = cfg or settings
        self.sessao = sessao or requests.Session()

    def configurada(self) -> bool:
        return bool(self.cfg.POLP_CLIENT_ID and self.cfg.POLP_CLIENT_SECRET)

    def _get(self, caminho_ou_url: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.configurada():
            raise PolpNaoConfigurada("Credenciais da Polp ausentes: defina POLP_CLIENT_ID e POLP_CLIENT_SECRET no .env.")
        url = caminho_ou_url if caminho_ou_url.startswith("http") else f"{self.cfg.POLP_API_URL.rstrip('/')}{caminho_ou_url}"
        headers = {
            "x-api-client": str(self.cfg.POLP_CLIENT_ID),
            "x-api-secret": str(self.cfg.POLP_CLIENT_SECRET),
            "Accept": "application/json",
        }
        ultimo = ""
        for tentativa in range(1, 4):
            try:
                resp = self.sessao.get(url, headers=headers, params=params, timeout=TIMEOUT)
            except requests.RequestException as e:
                ultimo = str(e)
                time.sleep(tentativa * 2)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                ultimo = f"HTTP {resp.status_code}"
                time.sleep(tentativa * 3)
                continue
            if resp.status_code == 402:
                raise RuntimeError("Polp respondeu 402: o add-on DDA não está ativo na assinatura.")
            if not resp.ok:
                raise RuntimeError(f"Polp recusou a consulta (HTTP {resp.status_code}){sufixo_erro(resp)}")
            dados = resp.json()
            return dados if isinstance(dados, dict) else {"data": dados}
        raise RuntimeError(f"Polp indisponível depois de 3 tentativas ({ultimo}).")

    def _paginar(self, caminho: str, params: Optional[Dict[str, Any]] = None) -> Iterator[Dict[str, Any]]:
        params = dict(params or {})
        for _ in range(MAX_PAGINAS):
            dados = self._get(caminho, params)
            for item in dados.get("data") or []:
                if isinstance(item, dict):
                    yield item
            cursor = (dados.get("meta") or {}).get("next_cursor")
            if not cursor:
                return
            params["cursor"] = cursor
        logger.warning(f"[DDA] Polp: paginação de {caminho} parou em {MAX_PAGINAS} páginas.")

    def listar_ddas(self) -> List[Dict[str, Any]]:
        """Cadastros DDA da conta (um por CPF/CNPJ)."""
        return list(self._paginar("/ddas"))

    def listar_boletos(self, dda_id: str, desde: Optional[str] = None) -> List[Dict[str, Any]]:
        """Boletos do cadastro; com `desde` (ISO 8601), só os criados OU atualizados a partir dele."""
        params: Dict[str, Any] = {}
        if desde:
            params["fromCreatedAt"] = desde
            params["fromUpdatedAt"] = desde
        return list(self._paginar(f"/ddas/{dda_id}/boletos", params))
