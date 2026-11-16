"""Exporta as conversas dos agentes com o modelo, rotuladas pelo que aconteceu depois, para fine-tuning.

Cada linha do JSONL é uma chamada ao modelo no formato de chat (system, user, assistant e, quando o
JSON saiu inválido, as voltas de correção) mais o rótulo:

  certo       a resposta levou a uma correção confirmada (produção ou TI depois do PR)
  errado      JSON inválido; edição que não aplicou; testes falharam; qualidade aprovou o que falhou
              depois (PR fechado, TI pediu ajuste com /refazer, erro reapareceu) ou aprovou com testes vermelhos
  incerto     a volta parou sem dizer quem errou (ex.: qualidade reprovou com testes verdes)
  pendente    a correção ainda não foi confirmada nem desmentida
  descartado  a volta foi refeita pelo TI (reprocessar): fica fora por padrão

Os desfechos (tabela desfechos) e a nota do TI vão junto em `contexto`, para quem quiser montar
pares de preferência (DPO) ou refazer os rótulos com outra regra.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

from .banco import Banco

BOM = {"confirmado_em_producao"}
RUIM = {"pr_fechado", "reapareceu", "falhou_no_acompanhamento", "ti_pediu_ajuste"}


def _final(eventos: set[str]) -> Optional[str]:
    if eventos & RUIM:
        return "errado"
    if eventos & BOM or ("ti_resolveu" in eventos and "pr_mergeado" in eventos):
        return "certo"
    return None


def rotular(agente: str, eventos: set[str], qualidade_aprovou: Optional[bool]) -> tuple[str, str]:
    """(rótulo, motivo) de uma resposta válida, a última do agente na volta."""
    final = _final(eventos)
    if agente == "executor":
        if "edicao_nao_aplicou" in eventos:
            return "errado", "edição não aplicou no código"
        if "testes_falharam" in eventos:
            return "errado", "testes falharam"
    if agente == "qualidade":
        if qualidade_aprovou and "testes_falharam" in eventos:
            return "errado", "aprovou com testes falhando"
        if qualidade_aprovou is False and "testes_falharam" in eventos:
            return "certo", "reprovou e os testes também falharam"
        if final == "errado" and qualidade_aprovou:
            return "errado", "aprovou e a correção falhou depois"
    if final:
        return final, ", ".join(sorted(eventos & (BOM | RUIM | {"ti_resolveu"})))
    if eventos & {"volta_reprovada", "escalado", "sem_arquivo_editavel", "falha_de_infra"}:
        return "incerto", ", ".join(sorted(eventos & {"volta_reprovada", "escalado", "sem_arquivo_editavel", "falha_de_infra"}))
    return "pendente", ""


def exemplos(banco: Banco) -> list[dict]:
    desfechos: dict[tuple, list] = defaultdict(list)
    for d in banco.db.execute("SELECT * FROM desfechos ORDER BY id"):
        desfechos[(d["incidente_id"], d["volta"])].append(dict(d))
    reprocessos = {k: max(d["criado_em"] for d in ds if d["evento"] == "ti_reprocessou")
                   for k, ds in desfechos.items() if any(d["evento"] == "ti_reprocessou" for d in ds)}
    chamadas = banco.db.execute("SELECT * FROM chamadas ORDER BY id").fetchall()
    # Última chamada válida de cada agente em cada volta (as anteriores foram recusadas pelo próprio executor).
    ultima = {}
    for c in chamadas:
        if c["valida"]:
            ultima[(c["incidente_id"], c["volta"], c["agente"])] = c["id"]
    notas = {i["id"]: i["nota_ti"] for i in banco.db.execute("SELECT id, nota_ti FROM incidentes")}

    saida = []
    for c in chamadas:
        chave = (c["incidente_id"], c["volta"])
        lista = desfechos.get(chave, [])
        if chave in reprocessos and c["criado_em"] <= reprocessos[chave]:
            rotulo, motivo = "descartado", "volta refeita pelo TI"
            lista = [d for d in lista if d["criado_em"] <= reprocessos[chave]]
        elif not c["valida"]:
            rotulo, motivo = "errado", f"JSON fora do esquema: {c['erro']}"
        elif ultima.get((*chave, c["agente"])) != c["id"]:
            rotulo, motivo = "errado", "tentativa recusada (edição não aplicou ou sem edições)"
        else:
            if chave in reprocessos:
                lista = [d for d in lista if d["criado_em"] > reprocessos[chave]]
            eventos = {d["evento"] for d in lista}
            aprovou = True if "qualidade_aprovou" in eventos else False if "qualidade_reprovou" in eventos else None
            rotulo, motivo = rotular(c["agente"], eventos, aprovou)
        saida.append({
            "messages": json.loads(c["mensagens"]) + [{"role": "assistant", "content": c["resposta"] or ""}],
            "rotulo": rotulo,
            "motivo": motivo,
            "agente": c["agente"],
            "modelo": c["modelo"],
            "contexto": {
                "incidente": c["incidente_id"], "volta": c["volta"], "chamada": c["id"], "em": c["criado_em"],
                "desfechos": [{k: d[k] for k in ("evento", "agente", "detalhe")} for d in lista],
                "nota_ti": notas.get(c["incidente_id"]),
            },
        })
    return saida


def exportar(banco: Banco, destino: Path, agente: Optional[str] = None, rotulos: Optional[set[str]] = None) -> Counter:
    contagem: Counter = Counter()
    destino.parent.mkdir(parents=True, exist_ok=True)
    with destino.open("w", encoding="utf-8") as f:
        for ex in exemplos(banco):
            if (agente and ex["agente"] != agente) or (rotulos and ex["rotulo"] not in rotulos):
                continue
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
            contagem[(ex["agente"], ex["rotulo"])] += 1
    return contagem
