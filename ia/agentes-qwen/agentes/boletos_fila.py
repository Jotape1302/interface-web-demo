"""Fila do classificador dos boletos DDA sem conta (painel Boletos DDA do interface-web) neste PC.

O coletor da VPS chama POST /financeiro/boletos/sincronizar (receptor.py) a cada minuto com:
  - `pendentes`: boletos sem conta ainda sem classificação (GET /api/v1/dda/qwen/pendentes), cada um
    com `versao` (valor|vencimento|fornecedor) e o histórico do fornecedor na empresa;
  - `categorias`: o catálogo do Tiny de CADA empresa ({empresa: [{id, grupo, nome}]}): as contas
    Tiny têm IDs próprios, então o schema do Qwen sai do catálogo da empresa do boleto;
  - `confirmadas`: uma página do histórico de categoria (saídas do Tiny e escolhas do painel);
  - `resultados`: o que aconteceu ao aplicar na VPS as `prontas` do ciclo anterior.
A resposta traz as `prontas`. Mesmos estados e regras da fila de NF-e (financeiro_fila.py):
pendente → classificada → entregue | descartada; erro depois de MAX_TENTATIVAS.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .banco import Banco, agora

MAX_TENTATIVAS = 3
PRONTAS_POR_CICLO = 20
MAX_PENDENTES = 100
MAX_CONFIRMADAS = 1000
RESULTADOS = ("aplicado", "descartado")


def _texto(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip())


def validar(corpo: Any) -> Optional[str]:
    if not isinstance(corpo, dict):
        return "corpo deve ser um objeto"
    if not isinstance(corpo.get("categorias", {}), dict):
        return "categorias deve ser um objeto {empresa: [categorias]}"
    listas = {c: corpo.get(c, []) for c in ("pendentes", "confirmadas", "resultados")}
    if any(not isinstance(v, list) for v in listas.values()):
        return "pendentes, confirmadas e resultados devem ser listas"
    if len(listas["pendentes"]) > MAX_PENDENTES or len(listas["confirmadas"]) > MAX_CONFIRMADAS:
        return f"no máximo {MAX_PENDENTES} pendentes e {MAX_CONFIRMADAS} confirmadas por chamada"
    for emp, cats in corpo.get("categorias", {}).items():
        if not isinstance(cats, list) or any(not isinstance(c, dict) or not _texto(c.get("id")) for c in cats):
            return f"categoria sem id na empresa {emp}"
    for b in listas["pendentes"]:
        if not isinstance(b, dict) or not all(_texto(b.get(c)) for c in ("id", "versao", "empresa")):
            return "boleto pendente sem id, versao ou empresa"
    for r in listas["confirmadas"]:
        if not isinstance(r, dict) or not all(_texto(r.get(c)) for c in ("chave", "fonte", "empresa", "fornecedor", "categoria_id")):
            return "registro do histórico sem chave, fonte, empresa, fornecedor ou categoria_id"
    for r in listas["resultados"]:
        if not isinstance(r, dict) or not _texto(r.get("boleto_id")) or r.get("status") not in RESULTADOS:
            return "resultado sem boleto_id ou com status fora de aplicado/descartado"
    return None


def sincronizar(banco: Banco, corpo: dict) -> dict:
    with banco.trava:
        banco.db.execute("BEGIN")
        try:
            entregues = _registrar_resultados(banco, corpo.get("resultados", []))
            for emp, cats in (corpo.get("categorias") or {}).items():
                if cats:
                    banco.db.execute(
                        "INSERT INTO boletos_estado VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                        (f"categorias:{emp}", json.dumps(cats, ensure_ascii=False)),
                    )
            novas = sum(_receber_pendente(banco, b) for b in corpo.get("pendentes", []))
            registros = sum(_receber_confirmada(banco, r) for r in corpo.get("confirmadas", []))
            banco.db.execute("COMMIT")
        except BaseException:
            banco.db.execute("ROLLBACK")
            raise
        prontas = [
            {"boleto_id": r["boleto_id"], "versao": r["versao"], "modelo": r["modelo"], **json.loads(r["resultado_json"])}
            for r in banco.db.execute(
                "SELECT * FROM boletos_fila WHERE estado='classificada' ORDER BY classificado_em LIMIT ?", (PRONTAS_POR_CICLO,)
            )
        ]
    return {"ok": True, "pendentes_novas": novas, "registros": registros, "entregues": entregues, "prontas": prontas}


def _registrar_resultados(banco: Banco, resultados: list) -> int:
    n = 0
    for r in resultados:
        estado = "entregue" if r["status"] == "aplicado" else "descartada"
        cur = banco.db.execute(
            "UPDATE boletos_fila SET estado=?, http_vps=?, entregue_em=? WHERE boleto_id=? AND versao=? AND estado='classificada'",
            (estado, r.get("http") if isinstance(r.get("http"), int) else None, agora(), r["boleto_id"], r.get("versao")),
        )
        n += cur.rowcount
    return n


def _receber_pendente(banco: Banco, b: dict) -> int:
    payload = json.dumps(b, ensure_ascii=False)
    linha = banco.db.execute("SELECT versao, estado FROM boletos_fila WHERE boleto_id=?", (b["id"],)).fetchone()
    if linha is None or linha["versao"] != b["versao"]:
        banco.db.execute(
            "INSERT INTO boletos_fila (boleto_id, versao, empresa, payload_json, estado, recebido_em) VALUES (?,?,?,?, 'pendente', ?)"
            " ON CONFLICT(boleto_id) DO UPDATE SET versao=excluded.versao, empresa=excluded.empresa, payload_json=excluded.payload_json,"
            " estado='pendente', resultado_json=NULL, modelo=NULL, tentativas=0, erro=NULL, http_vps=NULL,"
            " recebido_em=excluded.recebido_em, classificado_em=NULL, entregue_em=NULL",
            (b["id"], b["versao"], b["empresa"], payload, agora()),
        )
        return 1
    if linha["estado"] == "pendente":
        banco.db.execute("UPDATE boletos_fila SET payload_json=? WHERE boleto_id=?", (payload, b["id"]))
    elif linha["estado"] == "entregue":
        # A VPS diz que o boleto segue sem classificação: a sugestão aplicada se perdeu. Manda de novo.
        banco.db.execute("UPDATE boletos_fila SET estado='classificada', entregue_em=NULL WHERE boleto_id=?", (b["id"],))
    return 0


def _receber_confirmada(banco: Banco, r: dict) -> int:
    palpite: dict = {}
    modelo_palpite = None
    if r.get("fonte") == "painel" and r.get("boleto_id"):
        linha = banco.db.execute("SELECT * FROM boletos_fila WHERE boleto_id=?", (r["boleto_id"],)).fetchone()
        if linha is not None:
            if linha["resultado_json"]:
                palpite, modelo_palpite = json.loads(linha["resultado_json"]), linha["modelo"]
            if linha["estado"] in ("pendente", "classificada"):
                banco.db.execute(
                    "UPDATE boletos_fila SET estado='descartada', erro='confirmado antes da entrega' WHERE boleto_id=?", (r["boleto_id"],)
                )
    qwen = r.get("qwen") or {}
    sugestao = r.get("sugestao")
    if sugestao is not None or r.get("alternativas") is not None:
        sugestao = {**(sugestao or {}), "alternativas": r.get("alternativas")}
    banco.db.execute(
        "INSERT INTO historico_boletos (chave, seq, fonte, empresa, fornecedor, fornecedor_cnpj, fornecedor_nome, valor, data,"
        " categoria_id, categoria_nome, categoria_grupo, boleto_id, documento, confirmado_em, acao, sugestao_json,"
        " qwen_categoria_id, qwen_confianca, qwen_modelo, palpite_categoria_id, palpite_confianca, palpite_motivo, palpite_modelo,"
        " recebido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(chave) DO UPDATE SET seq=excluded.seq, fornecedor=excluded.fornecedor, fornecedor_cnpj=excluded.fornecedor_cnpj,"
        " fornecedor_nome=excluded.fornecedor_nome, valor=excluded.valor, data=excluded.data, categoria_id=excluded.categoria_id,"
        " categoria_nome=excluded.categoria_nome, categoria_grupo=excluded.categoria_grupo, confirmado_em=excluded.confirmado_em,"
        " acao=excluded.acao, sugestao_json=excluded.sugestao_json, qwen_categoria_id=excluded.qwen_categoria_id,"
        " qwen_confianca=excluded.qwen_confianca, qwen_modelo=excluded.qwen_modelo,"
        " palpite_categoria_id=COALESCE(excluded.palpite_categoria_id, palpite_categoria_id),"
        " palpite_confianca=COALESCE(excluded.palpite_confianca, palpite_confianca),"
        " palpite_motivo=COALESCE(excluded.palpite_motivo, palpite_motivo),"
        " palpite_modelo=COALESCE(excluded.palpite_modelo, palpite_modelo), recebido_em=excluded.recebido_em",
        (
            r["chave"], r.get("seq"), r["fonte"], r["empresa"], r["fornecedor"], r.get("fornecedor_cnpj"), r.get("fornecedor_nome"),
            r.get("valor"), r.get("data"), str(r["categoria_id"]), r.get("categoria_nome"), r.get("categoria_grupo"),
            r.get("boleto_id"), r.get("documento"), r.get("confirmado_em"), r.get("acao"),
            json.dumps(sugestao, ensure_ascii=False) if sugestao is not None else None,
            qwen.get("categoria_id"), qwen.get("confianca"), qwen.get("modelo"),
            palpite.get("categoria_id"), palpite.get("confianca"), palpite.get("motivo"), modelo_palpite, agora(),
        ),
    )
    banco.db.execute(
        "INSERT INTO fornecedores_boletos (empresa, fornecedor, nome) VALUES (?,?,?)"
        " ON CONFLICT(empresa, fornecedor) DO UPDATE SET nome=excluded.nome,"
        " vetor=CASE WHEN fornecedores_boletos.nome IS excluded.nome THEN fornecedores_boletos.vetor END",
        (r["empresa"], r["fornecedor"], r.get("fornecedor_nome") or ""),
    )
    return 1


# --- Para o trabalhador ---------------------------------------------------------------------


def categorias(banco: Banco, empresa: str) -> list[dict]:
    linha = banco.db.execute("SELECT valor FROM boletos_estado WHERE chave=?", (f"categorias:{empresa}",)).fetchone()
    return json.loads(linha["valor"]) if linha else []


def proximo(banco: Banco, exceto: tuple = ()):
    filtro = f" AND boleto_id NOT IN ({','.join('?' * len(exceto))})" if exceto else ""
    return banco.db.execute(
        f"SELECT * FROM boletos_fila WHERE estado='pendente'{filtro} ORDER BY recebido_em, boleto_id LIMIT 1", tuple(exceto)
    ).fetchone()


def gravar_classificacao(banco: Banco, boleto_id: str, versao: str, resultado: dict, modelo: str) -> bool:
    with banco.trava:
        cur = banco.db.execute(
            "UPDATE boletos_fila SET estado='classificada', resultado_json=?, modelo=?, classificado_em=?, erro=NULL"
            " WHERE boleto_id=? AND versao=? AND estado='pendente'",
            (json.dumps(resultado, ensure_ascii=False), modelo, agora(), boleto_id, versao),
        )
    return cur.rowcount == 1


def falhar_classificacao(banco: Banco, boleto_id: str, versao: str, erro: str) -> str:
    with banco.trava:
        banco.db.execute(
            "UPDATE boletos_fila SET tentativas=tentativas+1, erro=?,"
            " estado=CASE WHEN tentativas+1>=? THEN 'erro' ELSE estado END WHERE boleto_id=? AND versao=? AND estado='pendente'",
            (erro[:1000], MAX_TENTATIVAS, boleto_id, versao),
        )
        linha = banco.db.execute("SELECT estado FROM boletos_fila WHERE boleto_id=?", (boleto_id,)).fetchone()
    return linha["estado"] if linha else "descartada"
