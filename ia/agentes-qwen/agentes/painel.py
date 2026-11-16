"""Estado dos agentes para a aba "Agentes Qwen" do painel interface-web.

O coletor da VPS lê GET /painel (receptor.py) pelo túnel e repassa ao gateway, que guarda o último
estado e avisa quem tem `agentes_qwen:ver`. Vai só o resumo de cada incidente (sem a amostra do
log, sem prompts): estado, PR, aprovação, deploy e o acompanhamento das 5 execuções depois do deploy.
"""

from __future__ import annotations

import json
import re
from typing import Optional

import logging
import threading

from . import rag, repo
from .banco import Banco, agora
from .monitor import EXECUCOES_OK

logger = logging.getLogger("agentes.painel")

LIMITE = 60  # o gateway aceita corpo de até 1 MB
DESFECHOS_MAX = 20
TEXTO_MAX = 600

# Grupo de cada estado na tela (e no aviso do gateway).
GRUPO = {
    "novo": "em_andamento",
    "em_andamento": "em_andamento",
    "pr_aberto": "pr_pendente",
    "pronto_para_pr": "pr_pendente",
    "aguardando_deploy": "aguardando_deploy",
    "monitorando": "monitorando",
    "aguardando_ti": "precisa_ti",
    "escalado": "precisa_ti",
    "pr_fechado": "precisa_ti",
    "resolvido": "resolvido",
    "relatorio_pronto": "precisa_ti",
}


def _texto(valor: Optional[str]) -> Optional[str]:
    if not valor:
        return None
    return valor if len(valor) <= TEXTO_MAX else valor[:TEXTO_MAX] + "…"


def _saida(banco: Banco, inc_id: int, agente: str) -> dict:
    return next((json.loads(e["saida"]) for e in reversed(banco.etapas(inc_id)) if e["agente"] == agente), {})


def _deploy(banco: Banco, inc_id: int) -> list[str]:
    """Comandos da VPS (sem as cercas ``` do Markdown), das pastas que o PR muda."""
    edicoes = _saida(banco, inc_id, "executor").get("edicoes") or []
    arquivos = sorted({e["arquivo"].strip().lstrip("./") for e in edicoes if isinstance(e, dict) and e.get("arquivo")})
    return [linha for linha in repo.comandos_deploy(arquivos) if not linha.startswith("```")] if arquivos else []


def _acompanhamento(banco: Banco, inc) -> Optional[dict]:
    if not inc["deploy_em"]:
        return None
    if inc["rota"]:
        acompanhadas, sucessos = banco.acompanhamento(inc["rota"], inc["deploy_em"], inc["servico"], EXECUCOES_OK)
        return {"modo": "rota", "rota": inc["rota"], "alvo": EXECUCOES_OK, "acompanhadas": acompanhadas, "sucessos": sucessos}
    return {"modo": "janela", "ate": inc["monitor_ate"]}


def incidente(banco: Banco, inc) -> dict:
    desfechos = banco.desfechos(inc["id"])
    quando = {d["evento"]: d for d in desfechos}
    aprovou = quando.get("ti_aprovou")
    pr = re.search(r"/pull/(\d+)", inc["pr_url"] or "")
    return {
        "id": inc["id"],
        "servico": inc["servico"],
        "evento": inc["evento"],
        "rota": inc["rota"],
        "mensagem": _texto(inc["mensagem"]),
        "estado": inc["estado"],
        "grupo": GRUPO.get(inc["estado"], "em_andamento"),
        "volta": inc["volta"],
        "ocorrencias": inc["ocorrencias"],
        "primeiroEm": inc["primeiro_em"],
        "ultimoEm": inc["ultimo_em"],
        "atualizadoEm": inc["atualizado_em"],
        "diagnostico": _texto(_saida(banco, inc["id"], "diagnostico").get("resumo")),
        "nota": _texto(inc["nota_ti"]),
        "pr": {
            "url": inc["pr_url"],
            "numero": int(pr.group(1)) if pr else None,
            "aprovadoPor": aprovou["detalhe"] if aprovou else None,
            "aprovadoEm": aprovou["criado_em"] if aprovou else None,
            "mergeadoEm": quando["pr_mergeado"]["criado_em"] if "pr_mergeado" in quando else None,
            "mergeSha": inc["merge_sha"],
        } if inc["pr_url"] else None,
        "deployEm": inc["deploy_em"],
        "deploy": _deploy(banco, inc["id"]) if inc["estado"] == "aguardando_deploy" else [],
        "acompanhamento": _acompanhamento(banco, inc),
        # Reportes do botão "Reportar erro" ligados a este incidente (o gateway tira da fila os que vê aqui).
        "reportes": [
            {"id": r["id"], "automacao": r["automacao"], "referencia": r["referencia"], "por": r["por"], "em": r["criado_em"]}
            for r in banco.reportes(inc["id"])
        ],
        "historico": [
            {"evento": d["evento"], "volta": d["volta"], "detalhe": _texto(d["detalhe"]), "em": d["criado_em"]}
            for d in desfechos[-DESFECHOS_MAX:]
        ],
    }


def estado(banco: Banco, limite: int = LIMITE) -> dict:
    prod = banco.producao()
    return {
        "geradoEm": agora(),
        "commitProducao": prod["commit_prod"] if prod else None,
        "incidentes": [incidente(banco, inc) for inc in banco.recentes(limite)],
    }


def resolver_pelo_ti(banco: Banco, inc_id: int, nota: str, em_segundo_plano: bool = False) -> bool:
    """O TI marcou como resolvido (CLI `resolver` ou botão da aba). False se o incidente não existe.

    A nota entra na RAG da resolução. Pelo botão (receptor), a RAG é atualizada numa thread para não
    segurar a resposta ao coletor.
    """
    inc = banco.incidente(inc_id)
    if not inc:
        return False
    if inc["estado"] == "resolvido":
        return True
    banco.gravar_desfecho(inc_id, inc["volta"], "ti_resolveu", detalhe=nota)
    banco.mudar_estado(inc_id, "resolvido", nota_ti=nota)
    inc = banco.incidente(inc_id)

    def _rag() -> None:
        try:
            rag.adicionar("resolucao", f"incidentes › #{inc['id']} {inc['servico']}", rag.texto_resolvido(banco, inc))
        except Exception:  # noqa: BLE001 — a RAG atrasada não desfaz a resolução
            logger.exception("Incidente %s: não entrou na RAG da resolução", inc_id)

    if em_segundo_plano:
        threading.Thread(target=_rag, daemon=True).start()
    else:
        _rag()
    return True
