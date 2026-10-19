"""
Chave interna gateway → automação (contrato C1 das correções de segurança de 2026-10-06).

O gateway é o único cliente desta API e envia `X-Internal-Key: <AUTOMATIONS_INTERNAL_KEY>` em
toda chamada; aqui ela é exigida em todas as rotas, menos `/health` e `/api/v1/health`. A porta
8001 não está publicada no host hoje, mas a chave protege também contra qualquer outro container
ou processo na mesma rede docker.

- `AUTOMATIONS_INTERNAL_KEY` ausente → rotas protegidas respondem 503, a não ser que
  `INTERNAL_AUTH_DISABLED=true` (só para dev local e testes).
- Chave ausente ou diferente → 401. Comparação em tempo constante (`secrets.compare_digest`).

As rotinas agendadas (coleta de dimensões, tipo de frete, conferências) rodam dentro do processo
e não passam por HTTP: não dependem da chave.

Autoria (AUT-12): o gateway manda `X-Usuario` (login da sessão, URL-encoded se tiver acento).
Quando presente, é ele o autor gravado no histórico; o campo `usuario` do corpo só vale quando
o header falta (compatibilidade).
"""
import logging
import os
import secrets
from typing import Optional
from urllib.parse import unquote

from fastapi import HTTPException, Request

from app.config import settings

logger = logging.getLogger("marketplace.internal_auth")

HEADER_CHAVE = "X-Internal-Key"
HEADER_USUARIO = "X-Usuario"
ROTAS_PUBLICAS = frozenset({"/health", "/api/v1/health"})
TAMANHO_MINIMO_CHAVE = 32
_USUARIO_MAX = 120


def _config(nome: str) -> str:
    """Variável de ambiente (lida a cada requisição) ou, sem ela, o valor do .env via Settings."""
    valor = os.getenv(nome)
    if valor is None:
        valor = getattr(settings, nome, None)
    return "" if valor is None else str(valor).strip()


def _chave_configurada() -> str:
    return _config("AUTOMATIONS_INTERNAL_KEY")


def autenticacao_desligada() -> bool:
    return _config("INTERNAL_AUTH_DISABLED").lower() in ("1", "true", "yes", "sim")


def chave_valida(request: Request) -> bool:
    """True se a requisição traz a chave interna correta (ou a checagem está desligada)."""
    if autenticacao_desligada():
        return True
    esperada = _chave_configurada()
    recebida = request.headers.get(HEADER_CHAVE) or ""
    if not esperada or not recebida:
        return False
    return secrets.compare_digest(recebida.encode("utf-8"), esperada.encode("utf-8"))


async def exigir_chave_interna(request: Request) -> None:
    """Dependência global do app: protege todas as rotas, menos as de health."""
    if request.url.path in ROTAS_PUBLICAS or autenticacao_desligada():
        return
    if not _chave_configurada():
        raise HTTPException(status_code=503, detail="Chave interna não configurada (AUTOMATIONS_INTERNAL_KEY).")
    if not chave_valida(request):
        raise HTTPException(status_code=401, detail="Chave interna ausente ou inválida.")


def avisar_configuracao() -> None:
    """Log no startup: deixa claro quando o serviço está aberto ou travado por falta de chave."""
    if autenticacao_desligada():
        logger.warning("[AUTH] INTERNAL_AUTH_DISABLED=true: rotas SEM chave interna. Use só em dev/testes.")
        return
    chave = _chave_configurada()
    if not chave:
        logger.warning("[AUTH] AUTOMATIONS_INTERNAL_KEY não definida: as rotas protegidas vão responder 503.")
    elif len(chave) < TAMANHO_MINIMO_CHAVE:
        logger.warning(f"[AUTH] AUTOMATIONS_INTERNAL_KEY tem menos de {TAMANHO_MINIMO_CHAVE} caracteres: gere uma mais longa.")


def usuario_da_requisicao(request: Optional[Request], usuario_corpo: Optional[str] = None) -> str:
    """Autor da ação: header `X-Usuario` (definido pelo gateway a partir da sessão) ou, sem ele, o corpo."""
    if request is not None:
        bruto = request.headers.get(HEADER_USUARIO)
        if bruto and bruto.strip():
            try:
                valor = unquote(bruto.strip())
            except Exception:
                valor = bruto.strip()
            valor = "".join(c for c in valor if c.isprintable()).strip()
            if valor:
                return valor[:_USUARIO_MAX]
    return (usuario_corpo or "").strip()[:_USUARIO_MAX]
