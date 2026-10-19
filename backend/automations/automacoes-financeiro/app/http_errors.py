"""
Resumo seguro de respostas de erro de APIs externas (Tiny, Inter) para mensagens que chegam à tela.

O corpo cru (`resp.text`) pode trazer HTML de proxy, stack traces, ids internos e, na
autenticação do Inter, até eco de parâmetros. Ele vai para o log; para o cliente vai só a
mensagem de negócio que a API declarou em JSON (campos usuais), curta.
"""
from typing import Any

_CAMPOS_MENSAGEM = ("mensagem", "message", "title", "detail", "error_description", "error")


def resumo_resposta_erro(resp: Any, limite: int = 160) -> str:
    """Mensagem declarada pela API (JSON) ou "" quando não há uma — nunca o corpo cru."""
    try:
        corpo = resp.json()
    except Exception:
        return ""
    if not isinstance(corpo, dict):
        return ""
    partes = []
    for campo in _CAMPOS_MENSAGEM:
        valor = corpo.get(campo)
        if isinstance(valor, str) and valor.strip() and valor.strip() not in partes:
            partes.append(valor.strip())
    detalhes = corpo.get("detalhes")
    if isinstance(detalhes, list):
        itens = [
            f"{d.get('campo', '')}: {d.get('mensagem', '')}".strip(": ")
            for d in detalhes
            if isinstance(d, dict) and (d.get("mensagem") or d.get("campo"))
        ]
        if itens:
            partes.append("; ".join(itens))
    texto = " - ".join(partes)
    return texto[:limite]


def sufixo_erro(resp: Any, limite: int = 160) -> str:
    """`": <mensagem>"` quando a API declarou uma, senão vazio — para anexar a "HTTP 4xx"."""
    resumo = resumo_resposta_erro(resp, limite)
    return f": {resumo}" if resumo else ""
