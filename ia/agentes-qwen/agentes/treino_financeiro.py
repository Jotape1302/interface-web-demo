"""Dataset de fine-tuning (SFT e DPO) e métricas do classificador de NF-e (etapa 4).

Fontes:
  1. historico_itens_financeiro: os itens que uma pessoa confirmou na revisão (vêm da VPS pelo coletor,
     a partir de processed/*.review.json). A categoria final é sempre a resposta-alvo.
  2. sugestoes_financeiro: o que a tela sugeria em cada item na confirmação (origem histórico, Qwen ou
     regra), importado do dump de atividades_treino da VPS:
       scripts/exportar-atividades.sh --permissao revisao_nfe:lancar > nfe.jsonl   (na VPS)
       python -m agentes importar-atividades nfe.jsonl                              (aqui)
     O dump só enriquece as notas que a VPS já mandou; não cria nota nova no histórico.

Rótulo de cada item:
  confirmado             nenhuma sugestão conhecida (tela, Qwen na tela, palpite deste PC) diferia da escolha
  corrigido_pelo_humano  alguma diferia: caso de borda. A nota inteira entra 2× no SFT de treino
                         (OVERSAMPLE) e gera um par DPO {prompt, chosen: escolha humana, rejected: o palpite errado}

Um exemplo por chamada ao modelo, montado como a fila monta (financeiro.montar_prompt): só os itens que
iriam ao Qwen (sem histórico pelo código), em lotes de ITENS_POR_CHAMADA, pista de histórico e exemplos
(few-shot) tirados SÓ de notas estagiadas antes da nota N. A validação são as notas mais recentes
(PROPORCAO_VALIDACAO), mais a mais recente de cada categoria frequente que não tivesse caído nela; as
notas da validação nunca aparecem como exemplo nem como pista nos prompts do treino.

Arquivos (em dados/treino/):
  financeiro_sft.jsonl        treino, formato chat {messages}, com o oversample
  financeiro_validacao.jsonl  validação, sem repetição; `contexto.itens` traz o gabarito (etapa 5)
  financeiro_dpo.jsonl        pares do treino: {prompt: [system, user], chosen: [assistant], rejected: [assistant]}
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from . import financeiro, financeiro_fila
from .banco import Banco

PROPORCAO_VALIDACAO = 0.10
FREQUENTE = 5  # itens confirmados para a categoria contar como frequente no split
OVERSAMPLE = 2
ROTA_CONFIRMACAO = "confirm-lancamento"


# --- importação do dump de atividades -------------------------------------------------------


def importar_atividades(banco: Banco, linhas: Iterable[str]) -> Counter:
    """Grava a sugestão da tela de cada item confirmado. A atividade mais nova de cada item vence."""
    contagem: Counter = Counter()
    with banco.trava:
        for linha in linhas:
            if not linha.strip():
                continue
            contagem["linhas"] += 1
            try:
                atv = json.loads(linha)
            except ValueError:
                contagem["json_invalido"] += 1
                continue
            if not isinstance(atv, dict) or ROTA_CONFIRMACAO not in str(atv.get("rota") or ""):
                continue
            entrada, sugestao, contexto = atv.get("entrada"), atv.get("sugestao"), atv.get("contexto")
            if atv.get("truncado") or not all(isinstance(x, dict) for x in (entrada, sugestao, contexto)):
                contagem["incompletas"] += 1
                continue
            if not isinstance(atv.get("status"), int) or not 200 <= atv["status"] < 300:
                contagem["recusadas_pela_vps"] += 1
                continue
            chave = entrada.get("chave") or contexto.get("chave")
            if not chave or not isinstance(entrada.get("itens"), list):
                contagem["incompletas"] += 1
                continue
            contagem["confirmacoes"] += 1
            for escolhido in entrada["itens"]:
                if not isinstance(escolhido, dict) or not escolhido.get("item_id"):
                    continue
                sug = sugestao.get(str(escolhido["item_id"])) or {}
                alt = sug.get("alternativas") or {}
                hist, qwen = alt.get("historico") or {}, alt.get("qwen") or {}
                cur = banco.db.execute(
                    "INSERT INTO sugestoes_financeiro VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(chave_nfe, item_id) DO UPDATE SET atividade_id=excluded.atividade_id,"
                    " criado_em=excluded.criado_em, categoria_id=excluded.categoria_id, origem=excluded.origem,"
                    " nivel=excluded.nivel, confianca=excluded.confianca, motivo=excluded.motivo,"
                    " historico_categoria_id=excluded.historico_categoria_id, qwen_categoria_id=excluded.qwen_categoria_id,"
                    " qwen_confianca=excluded.qwen_confianca, regra_categoria_id=excluded.regra_categoria_id,"
                    " escolha_categoria_id=excluded.escolha_categoria_id"
                    " WHERE excluded.atividade_id >= sugestoes_financeiro.atividade_id",
                    (
                        chave, str(escolhido["item_id"]), int(atv.get("id") or 0), atv.get("criado_em"),
                        sug.get("categoria_id"), sug.get("origem"), sug.get("nivel"), sug.get("confianca"), sug.get("motivo"),
                        hist.get("categoria_id"), qwen.get("categoria_id"), qwen.get("confianca"), alt.get("regra"),
                        escolhido.get("categoria_id"),
                    ),
                )
                contagem["itens"] += cur.rowcount
    return contagem


# --- montagem do dataset -------------------------------------------------------------------


@dataclass
class Dataset:
    treino: list[dict] = field(default_factory=list)  # sem o oversample (exportar repete os corrigidos)
    validacao: list[dict] = field(default_factory=list)
    dpo: list[dict] = field(default_factory=list)
    contagem: Counter = field(default_factory=Counter)


def _notas(banco: Banco) -> list[dict]:
    """Notas confirmadas em ordem de staged_at, com cabeçalho, itens, sugestão da tela e motivo do palpite."""
    with banco.trava:
        itens = banco.db.execute("SELECT * FROM historico_itens_financeiro").fetchall()
        cabecalhos = {r["chave"]: dict(r) for r in banco.db.execute("SELECT * FROM notas_confirmadas_financeiro")}
        sugestoes = {(r["chave_nfe"], r["item_id"]): dict(r) for r in banco.db.execute("SELECT * FROM sugestoes_financeiro")}
        estagiada = {it["chave_nfe"]: it["staged_at"] for it in itens}
        # O palpite só vale para a versão da nota que foi confirmada (mesmo staged_at).
        motivos = {
            (r["chave"], i["item_id"]): i
            for r in banco.db.execute("SELECT chave, staged_at, resultado_json FROM notas_financeiro WHERE resultado_json IS NOT NULL")
            if estagiada.get(r["chave"]) == r["staged_at"]
            for i in json.loads(r["resultado_json"]).get("itens", [])
        }
    por_chave: dict[str, dict] = {}
    for it in itens:
        nota = por_chave.setdefault(it["chave_nfe"], {"chave": it["chave_nfe"], "staged_at": it["staged_at"] or "", "linhas": []})
        nota["linhas"].append(dict(it) | {"sugestao_tela": sugestoes.get((it["chave_nfe"], it["item_id"])),
                                          "palpite_motivo": motivos.get((it["chave_nfe"], it["item_id"]))})
    for nota in por_chave.values():
        nota["linhas"].sort(key=lambda r: (len(r["item_id"]), r["item_id"]))
        primeira, cab = nota["linhas"][0], cabecalhos.get(nota["chave"]) or {}
        nfe = {
            "emitente_nome": primeira["emitente_nome"], "emitente_cnpj": primeira["emitente_cnpj"],
            "destinatario_cnpj": primeira["destinatario_cnpj"], "destinatario_nome": cab.get("destinatario_nome"),
            "valor_total": cab.get("valor_total"), "meio_pagamento_nfe": cab.get("meio_pagamento_nfe"),
        }
        # A VPS lança toda nota em 1 parcela (nfe_client.get_effective_duplicatas): a fila sempre vê "Parcelas: 1".
        nota["nfe_data"] = nfe | {"duplicatas": [{}]}
    return sorted(por_chave.values(), key=lambda n: (n["staged_at"], n["chave"]))


def separar(notas: list[dict], proporcao: float = PROPORCAO_VALIDACAO, frequente: int = FREQUENTE) -> set[str]:
    """Chaves da validação: as mais recentes e, para cada categoria frequente ausente, a nota mais recente com ela."""
    if len(notas) < 2:
        return set()
    validacao = {n["chave"] for n in notas[-max(1, round(len(notas) * proporcao)):]}
    uso = Counter(r["categoria_id"] for n in notas for r in n["linhas"])
    for categoria, total in uso.most_common():
        if total < frequente:
            break
        if any(r["categoria_id"] == categoria for n in notas if n["chave"] in validacao for r in n["linhas"]):
            continue
        candidata = next((n for n in reversed(notas) if n["chave"] not in validacao
                          and any(r["categoria_id"] == categoria for r in n["linhas"])), None)
        if candidata and len(validacao) < len(notas) - 1:
            validacao.add(candidata["chave"])
    return validacao


def _pista(banco: Banco, nota: dict, excluir: frozenset) -> dict:
    """Índice de histórico da VPS (category_history.build_index) com só as notas anteriores a esta."""
    nfe = nota["nfe_data"]
    with banco.trava:
        anteriores = banco.db.execute(
            "SELECT chave_nfe, codigo, ncm, valor_total, categoria_id FROM historico_itens_financeiro"
            " WHERE destinatario_cnpj=? AND emitente_cnpj=? AND staged_at < ? ORDER BY staged_at",
            (nfe["destinatario_cnpj"], nfe["emitente_cnpj"], nota["staged_at"]),
        ).fetchall()
    codigo, ncm, valor = {}, {}, defaultdict(float)
    for r in anteriores:
        if r["chave_nfe"] in excluir or not r["categoria_id"]:
            continue
        if r["codigo"]:
            codigo[r["codigo"]] = r["categoria_id"]
        if r["ncm"]:
            ncm[r["ncm"]] = r["categoria_id"]
        valor[r["categoria_id"]] += r["valor_total"] or 0.0
    return {"codigo": codigo, "ncm": ncm, "fornecedor": max(valor, key=valor.get) if valor else None}


def _historico_do_item(pista: dict, linha: dict) -> Optional[dict]:
    if linha["codigo"] and linha["codigo"] in pista["codigo"]:
        return {"categoria_id": pista["codigo"][linha["codigo"]], "nivel": "codigo"}
    if linha["ncm"] and linha["ncm"] in pista["ncm"]:
        return {"categoria_id": pista["ncm"][linha["ncm"]], "nivel": "ncm"}
    return {"categoria_id": pista["fornecedor"], "nivel": "fornecedor"} if pista["fornecedor"] else None


def _alvo(linha: dict, historico: Optional[dict], exemplos: list) -> tuple[str, str]:
    """(motivo, confianca) da resposta-alvo, citando só pistas que estão no prompt."""
    final = linha["categoria_id"]
    palpite = linha["palpite_motivo"] or {}
    apoio = [e for e in exemplos if e["categoria_id"] == final]
    do_fornecedor = [e for e in apoio if e["emitente_cnpj"] == linha["emitente_cnpj"]]
    forte = bool(do_fornecedor) or ((historico or {}).get("nivel") == "ncm" and historico["categoria_id"] == final)
    if palpite.get("categoria_id") == final and palpite.get("motivo"):
        return palpite["motivo"], "alta" if forte else palpite.get("confianca") or "media"
    if do_fornecedor:
        return f"Item parecido do mesmo fornecedor ({financeiro._dado(do_fornecedor[0]['descricao'])[:60]}) já foi confirmado nesta categoria.", "alta"
    if historico and historico["categoria_id"] == final and historico["nivel"] == "ncm":
        return "O histórico com este fornecedor para o mesmo NCM aponta esta categoria.", "alta"
    mesmo_ncm = [e for e in apoio if linha["ncm"] and e["ncm"] == linha["ncm"]]
    if mesmo_ncm:
        return "Item com o mesmo NCM de outro fornecedor foi confirmado nesta categoria.", "media"
    if historico and historico["categoria_id"] == final:
        return "É a categoria mais usada com este fornecedor.", "media"
    if apoio:
        return f"Item semelhante ({financeiro._dado(apoio[0]['descricao'])[:60]}) foi confirmado nesta categoria.", "media"
    return "Classificado pela descrição do item; não há exemplo parecido nesta empresa.", "media"


def _rejeitado(linha: dict) -> Optional[tuple[str, str, str]]:
    """(categoria_id, motivo, confianca) da sugestão que a pessoa corrigiu, ou None se nenhuma diferia."""
    final, tela, palpite = linha["categoria_id"], linha["sugestao_tela"] or {}, linha["palpite_motivo"] or {}
    candidatos = [
        (linha["qwen_categoria_id"], palpite.get("motivo"), linha["qwen_confianca"]),
        (linha["palpite_categoria_id"], palpite.get("motivo"), linha["palpite_confianca"]),
        (tela.get("qwen_categoria_id"), tela.get("motivo") if tela.get("origem") == "qwen" else None, tela.get("qwen_confianca")),
        (tela.get("categoria_id"), tela.get("motivo"), tela.get("confianca")),
    ]
    for categoria, motivo, confianca in candidatos:
        if categoria and categoria != final:
            if palpite.get("categoria_id") != categoria and not (tela.get("categoria_id") == categoria and tela.get("motivo")):
                motivo = None
            origem = tela.get("origem") if tela.get("categoria_id") == categoria else "qwen"
            return categoria, motivo or f"Sugestão anterior da revisão ({origem}).", confianca or "media"
    return None


def montar(banco: Banco, categorias: Optional[list[dict]] = None) -> Dataset:
    categorias = categorias or financeiro_fila.categorias(banco) or financeiro.catalogo_do_repo()
    nomes = {i: r for r, i in financeiro.rotulos(categorias).items()}
    notas = _notas(banco)
    validacao = separar(notas)
    ds = Dataset()
    ds.contagem.update(notas=len(notas), notas_validacao=len(validacao))
    for nota in notas:
        na_validacao = nota["chave"] in validacao
        excluir = frozenset() if na_validacao else frozenset(validacao)
        pista = _pista(banco, nota, excluir)
        itens = []
        for linha in nota["linhas"]:
            hist = _historico_do_item(pista, linha)
            if hist and hist["nivel"] == "codigo":
                ds.contagem["itens_pelo_codigo"] += 1  # a VPS resolve sem o Qwen
            elif linha["categoria_id"] not in nomes:
                ds.contagem["itens_fora_do_catalogo"] += 1
            else:
                itens.append((linha, hist))
        for inicio in range(0, len(itens), financeiro.ITENS_POR_CHAMADA):
            lote = itens[inicio : inicio + financeiro.ITENS_POR_CHAMADA]
            ex = _exemplo(banco, nota, lote, categorias, nomes, excluir)
            ds.contagem["itens"] += len(lote)
            ds.contagem["itens_corrigidos"] += sum(i["rotulo"] == "corrigido_pelo_humano" for i in ex["contexto"]["itens"])
            if na_validacao:
                ds.validacao.append(ex)
                continue
            ds.treino.append(ex)
            par = _par_dpo(ex, nomes)
            if par:
                ds.dpo.append(par)
    return ds


def _exemplo(banco: Banco, nota: dict, lote: list, categorias: list[dict], nomes: dict, excluir: frozenset) -> dict:
    itens_prompt = [
        {"item_id": l["item_id"], "codigo": l["codigo"], "ncm": l["ncm"], "descricao": l["descricao"],
         "valor_total": l["valor_total"], "historico": h, "classificar": True}
        for l, h in lote
    ]
    consulta = {"chave": nota["chave"], "nfe_data": nota["nfe_data"]}
    exemplos, vistos, por_item = [], set(), {}
    for it in itens_prompt:
        proprios = financeiro.exemplos_do_item(banco, consulta, it, antes_de=nota["staged_at"], excluir=excluir)
        por_item[it["item_id"]] = proprios
        for e in proprios:
            if (e["chave_nfe"], e["item_id"]) not in vistos and len(exemplos) < financeiro.EXEMPLOS_POR_CHAMADA:
                vistos.add((e["chave_nfe"], e["item_id"]))
                exemplos.append(e)
    no_prompt = {(e["chave_nfe"], e["item_id"]) for e in exemplos if e["categoria_id"] in nomes}
    alvo, gabarito = [], []
    for linha, hist in lote:
        citaveis = [e for e in por_item[linha["item_id"]] if (e["chave_nfe"], e["item_id"]) in no_prompt]
        motivo, confianca = _alvo(linha, hist, citaveis)
        alvo.append({"item_id": linha["item_id"], "motivo": motivo, "categoria": nomes[linha["categoria_id"]], "confianca": confianca})
        rejeitado = _rejeitado(linha)
        gabarito.append({
            "item_id": linha["item_id"], "categoria_id": linha["categoria_id"], "valor_total": linha["valor_total"],
            "rotulo": "corrigido_pelo_humano" if rejeitado else "confirmado",
            "sugestao_tela": (linha["sugestao_tela"] or {}).get("categoria_id"),
            "sugestao_origem": (linha["sugestao_tela"] or {}).get("origem"),
            "qwen_categoria_id": linha["qwen_categoria_id"] or linha["palpite_categoria_id"],
            "rejeitado": rejeitado,
        })
    user = financeiro.montar_prompt(consulta, itens_prompt, exemplos, categorias)
    return {
        "messages": [
            {"role": "system", "content": financeiro.SISTEMA},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps({"itens": alvo}, ensure_ascii=False)},
        ],
        "rotulo": "corrigido_pelo_humano" if any(g["rejeitado"] for g in gabarito) else "confirmado",
        "contexto": {
            "chave": nota["chave"], "staged_at": nota["staged_at"], "destinatario_cnpj": nota["nfe_data"]["destinatario_cnpj"],
            "emitente_cnpj": nota["nfe_data"]["emitente_cnpj"], "emitente_nome": nota["nfe_data"]["emitente_nome"],
            "itens": gabarito,
        },
    }


def _par_dpo(ex: dict, nomes: dict) -> Optional[dict]:
    """O mesmo JSON da escolha humana com os itens corrigidos trocados pelo palpite errado."""
    escolhido = json.loads(ex["messages"][2]["content"])
    trocou = False
    for item, g in zip(escolhido["itens"], ex["contexto"]["itens"]):
        if g["rejeitado"] and g["rejeitado"][0] in nomes:
            categoria, motivo, confianca = g["rejeitado"]
            item.update(motivo=motivo, categoria=nomes[categoria], confianca=confianca)
            trocou = True
    if not trocou:
        return None
    return {
        "prompt": ex["messages"][:2],
        "chosen": [ex["messages"][2]],
        "rejected": [{"role": "assistant", "content": json.dumps(escolhido, ensure_ascii=False)}],
        "contexto": {"chave": ex["contexto"]["chave"], "itens": [g["item_id"] for g in ex["contexto"]["itens"] if g["rejeitado"]]},
    }


def exportar(banco: Banco, pasta: Path, categorias: Optional[list[dict]] = None) -> Counter:
    ds = montar(banco, categorias)
    pasta.mkdir(parents=True, exist_ok=True)

    def gravar(nome: str, linhas: Iterable[dict]) -> int:
        n = 0
        with (pasta / nome).open("w", encoding="utf-8") as f:
            for linha in linhas:
                f.write(json.dumps(linha, ensure_ascii=False) + "\n")
                n += 1
        return n

    sft = [ex for ex in ds.treino for _ in range(OVERSAMPLE if ex["rotulo"] == "corrigido_pelo_humano" else 1)]
    ds.contagem["linhas_sft"] = gravar("financeiro_sft.jsonl", sft)
    ds.contagem["linhas_validacao"] = gravar("financeiro_validacao.jsonl", ds.validacao)
    ds.contagem["pares_dpo"] = gravar("financeiro_dpo.jsonl", ds.dpo)
    return ds.contagem


# --- métricas (python -m agentes avaliar-financeiro) ---------------------------------------


def _taxa(acertos: int, total: int) -> str:
    return f"{acertos}/{total} ({100 * acertos / total:.1f}%)" if total else "0/0 (-)"


def avaliar(banco: Banco, top: int = 10) -> str:
    categorias = financeiro_fila.categorias(banco) or financeiro.catalogo_do_repo()
    nomes = {c["id"]: f"{c['grupo']} → {c['nome']}" for c in categorias}
    notas = _notas(banco)
    linhas = [l for n in notas for l in n["linhas"]]
    saida = [
        f"Histórico confirmado: {len(notas)} nota(s), {len(linhas)} item(ns), "
        f"{len({l['destinatario_cnpj'] for l in linhas})} empresa(s), {len({l['emitente_cnpj'] for l in linhas})} fornecedor(es)",
        f"Com a sugestão da tela importada (importar-atividades): {sum(1 for l in linhas if l['sugestao_tela'])} item(ns)",
        "",
    ]

    def bloco(titulo: str, pares: list[tuple[str, Optional[str], str]]) -> None:
        """pares: (sugerido, confianca, final)."""
        acertos = sum(s == f for s, _, f in pares)
        saida.append(f"{titulo}: concordância {_taxa(acertos, len(pares))}")
        for conf in ("alta", "media", "baixa"):
            sub = [(s, f) for s, c, f in pares if c == conf]
            if sub:
                saida.append(f"    confiança {conf:<5} {_taxa(sum(s == f for s, f in sub), len(sub))}")

    bloco("Qwen na tela", [(l["qwen_categoria_id"], l["qwen_confianca"], l["categoria_id"]) for l in linhas if l["qwen_categoria_id"]])
    bloco("Qwen deste PC (palpite, chegando ou não à tela)",
          [(l["palpite_categoria_id"], l["palpite_confianca"], l["categoria_id"]) for l in linhas if l["palpite_categoria_id"]])
    origens: dict[str, list] = defaultdict(list)
    for l in linhas:
        if l["sugestao_tela"] and l["sugestao_tela"]["categoria_id"]:
            t = l["sugestao_tela"]
            origens[f"{t['origem']}{'/' + t['nivel'] if t['nivel'] else ''}"].append(t["categoria_id"] == l["categoria_id"])
    if origens:
        saida.append("Sugestão da tela por origem:")
        for origem, acertos in sorted(origens.items(), key=lambda kv: -len(kv[1])):
            saida.append(f"    {origem:<22} {_taxa(sum(acertos), len(acertos))}")

    sugeridos = [l for l in linhas if _rejeitado(l) is not None or (l["sugestao_tela"] or {}).get("categoria_id")
                 or l["qwen_categoria_id"] or l["palpite_categoria_id"]]
    for titulo, chave_de in (("categorias (escolha final)", lambda l: nomes.get(l["categoria_id"], l["categoria_id"])),
                             ("fornecedores", lambda l: f"{l['emitente_nome'] or '-'} ({l['emitente_cnpj']})")):
        corrigidos, total = Counter(), Counter()
        for l in sugeridos:
            total[chave_de(l)] += 1
            corrigidos[chave_de(l)] += _rejeitado(l) is not None
        piores = [(k, n) for k, n in corrigidos.most_common(top) if n]
        saida.append(f"\nTop {top} {titulo} onde a pessoa mais corrige a sugestão:")
        saida.extend(f"    {n:>4}/{total[k]:<4} {k}" for k, n in piores)
        if not piores:
            saida.append("    (nenhuma correção registrada)")
    return "\n".join(saida)


# --- gate de qualidade do fine-tuning (python -m agentes comparar-financeiro) ----------------------


@dataclass
class Placar:
    modelo: str
    itens: int = 0
    acertos: int = 0
    valor: float = 0.0
    valor_certo: float = 0.0
    notas: int = 0
    segundos: float = 0.0
    invalidas: int = 0

    @property
    def acuracia(self) -> float:
        return self.acertos / self.itens if self.itens else 0.0

    @property
    def acuracia_valor(self) -> float:
        return self.valor_certo / self.valor if self.valor else 0.0

    def linha(self) -> str:
        media = self.segundos / self.notas if self.notas else 0.0
        return (f"{self.modelo:<34} {100 * self.acuracia:6.1f}% ({self.acertos}/{self.itens})"
                f"  {100 * self.acuracia_valor:6.1f}%  {media:6.1f} s  {self.invalidas}")


def medir(gerar, modelo: str, validacao: list[dict], categorias: list[dict]) -> Placar:
    """Classifica cada exemplo da validação com o mesmo schema da fila e confere o gabarito.

    gerar(modelo, sistema, usuario, esquema): llm.gerar (Ollama) ou o llama-server com um adaptador.
    """
    import time

    from . import llm

    por_rotulo = financeiro.rotulos(categorias)
    placar = Placar(modelo)
    for ex in validacao:
        gabarito = ex["contexto"]["itens"]
        esquema = financeiro.esquema(list(por_rotulo), [g["item_id"] for g in gabarito])
        inicio = time.monotonic()
        try:
            saida = gerar(modelo, ex["messages"][0]["content"], ex["messages"][1]["content"], esquema)
            escolhas = {i.item_id: por_rotulo[i.categoria] for i in saida.itens}
        except llm.SaidaInvalida:
            placar.invalidas += 1
            escolhas = {}
        placar.segundos += time.monotonic() - inicio
        placar.notas += 1
        for g in gabarito:
            certo = escolhas.get(g["item_id"]) == g["categoria_id"]
            placar.itens += 1
            placar.acertos += certo
            placar.valor += g["valor_total"] or 0.0
            placar.valor_certo += (g["valor_total"] or 0.0) if certo else 0.0
    return placar


def ler_validacao(pasta: Path) -> list[dict]:
    arquivo = pasta / "financeiro_validacao.jsonl"
    validacao = [json.loads(l) for l in arquivo.read_text(encoding="utf-8").splitlines() if l.strip()] if arquivo.is_file() else []
    if not validacao:
        raise ValueError("validação vazia: rode `python -m agentes treino-financeiro` antes")
    return validacao


def comparar(banco: Banco, candidato: Path, pasta: Path, promovido: Optional[Path] = None) -> tuple[Placar, Placar]:
    """
    Atual × candidato no MESMO llama-server (mesma base e motor; só o adaptador muda por requisição).
    Atual = o adaptador promovido, ou a base pura se ainda não houver um.
    """
    from . import llama_server

    validacao = ler_validacao(pasta)
    categorias = financeiro_fila.categorias(banco) or financeiro.catalogo_do_repo()
    adaptadores = ([promovido] if promovido else []) + [candidato]
    with llama_server.Servidor(adaptadores) as srv:
        def com(lora):
            return lambda m, sis, usu, esq: srv.gerar(m, sis, usu, esq, lora=lora)

        atual = medir(com(0 if promovido else None), llama_server.rotulo_modelo(promovido), validacao, categorias)
        novo = medir(com(len(adaptadores) - 1), llama_server.rotulo_modelo(candidato), validacao, categorias)
    return atual, novo


def promover(candidato: Path, destino: Path) -> Optional[Path]:
    """Copia o candidato para o adaptador promovido; o anterior fica em anterior.gguf. Devolve o anterior."""
    import shutil

    destino.parent.mkdir(parents=True, exist_ok=True)
    anterior = None
    if destino.is_file():
        anterior = destino.with_name("anterior.gguf")
        shutil.copy2(destino, anterior)
    temporario = destino.with_suffix(".tmp")
    shutil.copy2(candidato, temporario)
    temporario.replace(destino)  # troca atômica: o classificador nunca lê meio arquivo
    return anterior
