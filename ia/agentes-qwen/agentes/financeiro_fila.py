"""Fila do classificador de NF-e (revisão de Contas a Pagar do interface-web) neste PC.

O coletor da VPS chama POST /financeiro/sincronizar (receptor.py) a cada minuto com:
  - `pendentes`: notas da revisão ainda sem classificação (GET /api/v1/danfe/qwen/pendentes);
  - `categorias`: o catálogo fechado do Tiny que veio junto (o schema do Qwen sai dele);
  - `confirmadas`: uma página das notas confirmadas por uma pessoa (gabarito e exemplos);
  - `resultados`: o que aconteceu ao aplicar na VPS as `prontas` do ciclo anterior.
A resposta traz as `prontas` (classificadas e ainda não confirmadas pelo coletor). Só um
resultado "aplicado" ou "descartado" encerra a nota: se a VPS estava fora, ela volta no ciclo
seguinte (aplicar de novo é idempotente na VPS).

Estados de notas_financeiro: pendente → classificada → entregue | descartada; erro quando a
classificação falhou MAX_TENTATIVAS vezes.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .banco import Banco, agora

MAX_TENTATIVAS = 3
PRONTAS_POR_CICLO = 20
MAX_PENDENTES = 100
MAX_CONFIRMADAS = 500
RESULTADOS = ("aplicado", "descartado")


def _texto(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip())


def validar(corpo: Any) -> Optional[str]:
    """Mensagem do erro de formato, ou None se o corpo serve."""
    if not isinstance(corpo, dict):
        return "corpo deve ser um objeto"
    listas = {c: corpo.get(c, []) for c in ("categorias", "pendentes", "confirmadas", "resultados")}
    if any(not isinstance(v, list) for v in listas.values()):
        return "categorias, pendentes, confirmadas e resultados devem ser listas"
    if len(listas["pendentes"]) > MAX_PENDENTES or len(listas["confirmadas"]) > MAX_CONFIRMADAS:
        return f"no máximo {MAX_PENDENTES} pendentes e {MAX_CONFIRMADAS} confirmadas por chamada"
    if any(not isinstance(c, dict) or not _texto(c.get("id")) for c in listas["categorias"]):
        return "categoria sem id"
    for nota in listas["pendentes"] + listas["confirmadas"]:
        if not isinstance(nota, dict) or not _texto(nota.get("chave")) or not isinstance(nota.get("itens"), list):
            return "nota sem chave ou itens"
        if any(not isinstance(i, dict) or not _texto(i.get("item_id")) for i in nota["itens"]):
            return f"item sem item_id na nota {nota['chave']}"
    if any(not _texto(n.get("staged_at")) for n in listas["pendentes"]):
        return "pendente sem staged_at"
    for r in listas["resultados"]:
        if not isinstance(r, dict) or not _texto(r.get("chave")) or r.get("status") not in RESULTADOS:
            return "resultado sem chave ou com status fora de aplicado/descartado"
    return None


def sincronizar(banco: Banco, corpo: dict) -> dict:
    """Aplica um POST /financeiro/sincronizar já validado e devolve a resposta (com as prontas)."""
    with banco.trava:
        banco.db.execute("BEGIN")
        try:
            entregues = _registrar_resultados(banco, corpo.get("resultados", []))
            if corpo.get("categorias"):
                banco.db.execute(
                    "INSERT INTO financeiro_estado VALUES ('categorias', ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                    (json.dumps(corpo["categorias"], ensure_ascii=False),),
                )
            novas = sum(_receber_pendente(banco, n) for n in corpo.get("pendentes", []))
            itens = sum(_receber_confirmada(banco, n) for n in corpo.get("confirmadas", []))
            banco.db.execute("COMMIT")
        except BaseException:
            banco.db.execute("ROLLBACK")
            raise
        prontas = [
            {"chave": r["chave"], "staged_at": r["staged_at"], "modelo": r["modelo"], "itens": json.loads(r["resultado_json"])["itens"]}
            for r in banco.db.execute(
                "SELECT * FROM notas_financeiro WHERE estado='classificada' ORDER BY classificado_em LIMIT ?", (PRONTAS_POR_CICLO,)
            )
        ]
    return {"ok": True, "pendentes_novas": novas, "itens_confirmados": itens, "entregues": entregues, "prontas": prontas}


def _registrar_resultados(banco: Banco, resultados: list) -> int:
    n = 0
    for r in resultados:
        estado = "entregue" if r["status"] == "aplicado" else "descartada"
        cur = banco.db.execute(
            "UPDATE notas_financeiro SET estado=?, http_vps=?, entregue_em=? WHERE chave=? AND staged_at=? AND estado='classificada'",
            (estado, r.get("http") if isinstance(r.get("http"), int) else None, agora(), r["chave"], r.get("staged_at")),
        )
        n += cur.rowcount
    return n


def _receber_pendente(banco: Banco, nota: dict) -> int:
    """1 se a nota (ou uma versão nova dela) entrou na fila para classificar."""
    payload = json.dumps(nota, ensure_ascii=False)
    linha = banco.db.execute("SELECT staged_at, estado FROM notas_financeiro WHERE chave=?", (nota["chave"],)).fetchone()
    if linha is None or linha["staged_at"] != nota["staged_at"]:
        # Nota nova, ou estagiada de novo na VPS (outros itens): classifica do zero.
        banco.db.execute(
            "INSERT INTO notas_financeiro (chave, staged_at, payload_json, estado, recebido_em) VALUES (?, ?, ?, 'pendente', ?)"
            " ON CONFLICT(chave) DO UPDATE SET staged_at=excluded.staged_at, payload_json=excluded.payload_json, estado='pendente',"
            " resultado_json=NULL, modelo=NULL, tentativas=0, erro=NULL, http_vps=NULL, recebido_em=excluded.recebido_em,"
            " classificado_em=NULL, entregue_em=NULL",
            (nota["chave"], nota["staged_at"], payload, agora()),
        )
        return 1
    if linha["estado"] == "pendente":
        # O histórico de cada item pode ter mudado com uma confirmação nova.
        banco.db.execute("UPDATE notas_financeiro SET payload_json=? WHERE chave=?", (payload, nota["chave"]))
    elif linha["estado"] == "entregue":
        # A VPS diz que a nota segue sem classificação: a sugestão aplicada se perdeu (ex.: o
        # .review.json foi regravado por uma confirmação com erro parcial). Manda de novo.
        banco.db.execute("UPDATE notas_financeiro SET estado='classificada', entregue_em=NULL WHERE chave=?", (nota["chave"],))
    return 0


def _receber_confirmada(banco: Banco, nota: dict) -> int:
    linha = banco.db.execute("SELECT * FROM notas_financeiro WHERE chave=?", (nota["chave"],)).fetchone()
    palpites: dict = {}
    if linha is not None and linha["resultado_json"] and linha["staged_at"] == nota.get("staged_at"):
        palpites = {i["item_id"]: i for i in json.loads(linha["resultado_json"]).get("itens", [])}
    if linha is not None and linha["estado"] in ("pendente", "classificada"):
        # Confirmada antes de a sugestão chegar à tela: não há mais o que entregar.
        banco.db.execute(
            "UPDATE notas_financeiro SET estado='descartada', erro='confirmada antes da entrega' WHERE chave=?", (nota["chave"],)
        )
    banco.db.execute(
        "INSERT INTO notas_confirmadas_financeiro (chave, destinatario_nome, valor_total, meio_pagamento_nfe, recebido_em)"
        " VALUES (?,?,?,?,?) ON CONFLICT(chave) DO UPDATE SET"
        " destinatario_nome=excluded.destinatario_nome, valor_total=excluded.valor_total,"
        " meio_pagamento_nfe=excluded.meio_pagamento_nfe, recebido_em=excluded.recebido_em",
        (nota["chave"], nota.get("destinatario_nome"), nota.get("valor_total"), nota.get("meio_pagamento_nfe"), agora()),
    )
    for item in nota["itens"]:
        palpite = palpites.get(item["item_id"]) or {}
        banco.db.execute(
            "INSERT INTO historico_itens_financeiro (chave_nfe, item_id, confirmado_em, staged_at, destinatario_cnpj, emitente_cnpj,"
            " emitente_nome, codigo, ncm, descricao, quantidade, valor_total, categoria_id, forma_pagamento, qwen_categoria_id,"
            " qwen_confianca, qwen_modelo, palpite_categoria_id, palpite_confianca, palpite_modelo, recebido_em)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(chave_nfe, item_id) DO UPDATE SET confirmado_em=excluded.confirmado_em, categoria_id=excluded.categoria_id,"
            " forma_pagamento=excluded.forma_pagamento, qwen_categoria_id=excluded.qwen_categoria_id,"
            " qwen_confianca=excluded.qwen_confianca, qwen_modelo=excluded.qwen_modelo,"
            " palpite_categoria_id=COALESCE(excluded.palpite_categoria_id, palpite_categoria_id),"
            " palpite_confianca=COALESCE(excluded.palpite_confianca, palpite_confianca),"
            " palpite_modelo=COALESCE(excluded.palpite_modelo, palpite_modelo), recebido_em=excluded.recebido_em",
            (
                nota["chave"], item["item_id"], nota.get("confirmado_em"), nota.get("staged_at"), nota.get("destinatario_cnpj"),
                nota.get("emitente_cnpj"), nota.get("emitente_nome"), item.get("codigo"), item.get("ncm"), item.get("descricao"),
                item.get("quantidade"), item.get("valor_total"), item.get("categoria_id") or "", nota.get("forma_pagamento"),
                item.get("qwen_categoria_id"), item.get("qwen_confianca"), nota.get("qwen_modelo"),
                palpite.get("categoria_id"), palpite.get("confianca"), linha["modelo"] if palpite else None, agora(),
            ),
        )
    return len(nota["itens"])


# --- Para o trabalhador (etapa 3) -------------------------------------------------------


def categorias(banco: Banco) -> list[dict]:
    linha = banco.db.execute("SELECT valor FROM financeiro_estado WHERE chave='categorias'").fetchone()
    return json.loads(linha["valor"]) if linha else []


def proxima_nota(banco: Banco, exceto: tuple = ()):
    """A nota pendente mais antiga fora de `exceto` (as que já falharam nesta passada), ou None."""
    filtro = f" AND chave NOT IN ({','.join('?' * len(exceto))})" if exceto else ""
    return banco.db.execute(
        f"SELECT * FROM notas_financeiro WHERE estado='pendente'{filtro} ORDER BY recebido_em, chave LIMIT 1", tuple(exceto)
    ).fetchone()


def gravar_classificacao(banco: Banco, chave: str, staged_at: str, itens: list[dict], modelo: str) -> bool:
    """Guarda o resultado; False se a nota mudou (outra versão chegou) enquanto o Qwen trabalhava."""
    with banco.trava:
        cur = banco.db.execute(
            "UPDATE notas_financeiro SET estado='classificada', resultado_json=?, modelo=?, classificado_em=?, erro=NULL"
            " WHERE chave=? AND staged_at=? AND estado='pendente'",
            (json.dumps({"itens": itens}, ensure_ascii=False), modelo, agora(), chave, staged_at),
        )
    return cur.rowcount == 1


def falhar_classificacao(banco: Banco, chave: str, staged_at: str, erro: str) -> str:
    """Conta a tentativa; na MAX_TENTATIVAS-ésima a nota vai para 'erro'. Devolve o estado."""
    with banco.trava:
        banco.db.execute(
            "UPDATE notas_financeiro SET tentativas=tentativas+1, erro=?,"
            " estado=CASE WHEN tentativas+1>=? THEN 'erro' ELSE estado END WHERE chave=? AND staged_at=? AND estado='pendente'",
            (erro[:1000], MAX_TENTATIVAS, chave, staged_at),
        )
        linha = banco.db.execute("SELECT estado FROM notas_financeiro WHERE chave=?", (chave,)).fetchone()
    return linha["estado"] if linha else "descartada"
