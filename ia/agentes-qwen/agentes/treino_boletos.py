"""Dataset de fine-tuning (SFT e DPO), métricas e portão de promoção do classificador dos boletos DDA.

Fonte: historico_boletos (a VPS manda pelo coletor, dda_categoria.py):
  - fonte tiny: saídas de caixa já lançadas no Tiny de cada empresa (fornecedor → categoria).
    São milhares e repetitivas (o mesmo fornecedor todo mês): entram como exemplo só
      1. a primeira vez de cada fornecedor na empresa (o caso do fornecedor novo, sem histórico);
      2. as vezes em que a categoria fugiu da mais usada até ali (o caso difícil, desempate por valor);
      3. até REPETIDOS outras, espalhadas no tempo (ensina a seguir o histórico quando ele é claro).
  - fonte painel: a escolha de quem criou ou ligou a conta do boleto, com o que a tela sugeria.
    Sempre entram. Sugestão (tela, Qwen na tela ou palpite deste PC) diferente da escolha =
    corrigido_pelo_humano: entra 2× no SFT (OVERSAMPLE) e gera um par DPO.

Cada exemplo é o prompt da fila (boletos.montar_prompt) com as pistas só do que aconteceu ANTES
dele (`antes_de` = a data do registro). Validação: os registros mais recentes (PROPORCAO_VALIDACAO)
e, para cada categoria frequente ausente, o mais recente com ela; eles nunca aparecem como pista
nos prompts do treino.

Arquivos (dados/treino/): boletos_sft.jsonl, boletos_validacao.jsonl (contexto com o gabarito e a
categoria que o histórico sozinho daria) e boletos_dpo.jsonl.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable, Optional

from . import boletos, financeiro
from .banco import Banco
from .treino_financeiro import Dataset, Placar, _taxa, promover  # noqa: F401 — promover reexportado para o CLI

PROPORCAO_VALIDACAO = 0.10
FREQUENTE = 5
OVERSAMPLE = 2
REPETIDOS = 2
MAX_EXEMPLOS = 6000


def _registros(banco: Banco) -> list[dict]:
    with banco.trava:
        linhas = [dict(r) for r in banco.db.execute("SELECT * FROM historico_boletos ORDER BY data, chave")]
    for r in linhas:
        r["sugestao"] = json.loads(r["sugestao_json"]) if r.get("sugestao_json") else None
    return linhas


def selecionar(registros: list[dict], repetidos: int = REPETIDOS) -> list[dict]:
    """Os registros que viram exemplo (regras no docstring), em ordem de data, com o motivo da escolha."""
    escolhidos: list[dict] = []
    contagem: dict[tuple, Counter] = defaultdict(Counter)
    por_fornecedor: dict[tuple, list[dict]] = defaultdict(list)
    for r in registros:
        k = (r["empresa"], r["fornecedor"])
        anteriores = contagem[k]
        if r["fonte"] == "painel":
            escolhidos.append({**r, "por": "painel"})
        elif not anteriores:
            escolhidos.append({**r, "por": "novo"})
        elif r["categoria_id"] != anteriores.most_common(1)[0][0]:
            escolhidos.append({**r, "por": "mudou"})
        else:
            por_fornecedor[k].append(r)
        if r["fonte"] == "tiny":
            anteriores[r["categoria_id"]] += 1
    for k, resto in por_fornecedor.items():
        if not resto or repetidos <= 0:
            continue
        passo = max(1, len(resto) // repetidos)
        escolhidos.extend({**r, "por": "repetido"} for r in resto[passo - 1 :: passo][:repetidos])
    escolhidos.sort(key=lambda r: (r["data"] or "", r["chave"]))
    return escolhidos[-MAX_EXEMPLOS:]


def separar(exemplos: list[dict], proporcao: float = PROPORCAO_VALIDACAO, frequente: int = FREQUENTE) -> set[str]:
    if len(exemplos) < 2:
        return set()
    validacao = {r["chave"] for r in exemplos[-max(1, round(len(exemplos) * proporcao)):]}
    uso = Counter(r["categoria_id"] for r in exemplos)
    for categoria, total in uso.most_common():
        if total < frequente:
            break
        if any(r["categoria_id"] == categoria and r["chave"] in validacao for r in exemplos):
            continue
        candidata = next((r for r in reversed(exemplos) if r["chave"] not in validacao and r["categoria_id"] == categoria), None)
        if candidata and len(validacao) < len(exemplos) - 1:
            validacao.add(candidata["chave"])
    return validacao


def _boleto_do_registro(r: dict, empresa_nome: Optional[str] = None) -> dict:
    """O registro no formato do boleto pendente que a fila recebe."""
    doc = r.get("fornecedor_cnpj") or ""
    return {
        "id": boletos.ITEM_ID, "empresa": r["empresa"], "empresa_nome": empresa_nome or r["empresa"],
        "beneficiario_nome": r.get("fornecedor_nome") or "", "beneficiario_cnpj": doc, "sacador_cnpj": "",
        "valor": r.get("valor"), "vencimento": r.get("data"), "documento": r.get("documento") or "",
    }


def _alvo(r: dict, hist: dict, semelhantes: list[dict], nomes: dict) -> tuple[str, str]:
    """(motivo, confianca) da resposta-alvo, citando só pistas que estão no prompt."""
    final = r["categoria_id"]
    if r.get("palpite_categoria_id") == final and r.get("palpite_motivo"):
        return r["palpite_motivo"], r.get("palpite_confianca") or "media"
    dist = hist["distribuicao"]
    if hist["painel"] == final:
        return "É a última categoria escolhida no painel para este fornecedor.", "alta"
    if dist and dist[0]["categoria_id"] == final and dist[0]["vezes"] / max(1, hist["total"]) >= 0.8:
        return f"O fornecedor já foi lançado {dist[0]['vezes']} vez(es) nesta categoria nesta empresa.", "alta"
    proxima = next((d for d in dist if d["categoria_id"] == final), None)
    if proxima:
        return (f"O fornecedor tem lançamentos em mais de uma categoria; o valor ({boletos._reais(r.get('valor'))}) se parece com os "
                f"desta (média {boletos._reais(proxima['valor_medio'])})."), "media"
    parecido = next((p for p in semelhantes if p["categoria_id"] == final), None)
    if parecido:
        return f"Fornecedor parecido ({financeiro._dado(parecido['nome'])[:60]}) é lançado nesta categoria.", "media"
    return "Classificado pelo nome e pelo tipo do fornecedor; não há lançamento parecido nesta empresa.", "media"


def _rejeitado(r: dict) -> Optional[tuple[str, str, str]]:
    """(categoria_id, motivo, confianca) da sugestão que a pessoa corrigiu no painel, ou None."""
    if r["fonte"] != "painel":
        return None
    final, tela = r["categoria_id"], r.get("sugestao") or {}
    candidatos = [
        (r.get("palpite_categoria_id"), r.get("palpite_motivo"), r.get("palpite_confianca")),
        (r.get("qwen_categoria_id"), None, r.get("qwen_confianca")),
        (tela.get("categoria_id"), tela.get("motivo"), tela.get("confianca")),
    ]
    for categoria, motivo, confianca in candidatos:
        if categoria and categoria != final:
            return categoria, motivo or f"Sugestão anterior do painel ({tela.get('origem') or 'qwen'}).", confianca or "media"
    return None


def montar(banco: Banco) -> Dataset:
    registros = _registros(banco)
    exemplos = selecionar(registros)
    validacao = separar(exemplos)
    catalogos: dict[str, list[dict]] = {}
    ds = Dataset()
    ds.contagem.update(registros=len(registros), exemplos=len(exemplos), validacao=len(validacao))
    ds.contagem.update({f"por_{k}": v for k, v in Counter(e["por"] for e in exemplos).items()})
    for r in exemplos:
        if r["empresa"] not in catalogos:
            catalogos[r["empresa"]] = boletos.catalogo_do_historico(banco, r["empresa"])
        categorias = catalogos[r["empresa"]]
        nomes = {i: rot for rot, i in financeiro.rotulos(categorias).items()}
        if r["categoria_id"] not in nomes:
            ds.contagem["fora_do_catalogo"] += 1
            continue
        na_validacao = r["chave"] in validacao
        excluir = frozenset({r["chave"]}) | (frozenset() if na_validacao else frozenset(validacao))
        boleto = _boleto_do_registro(r)
        hist, semelhantes = boletos.pistas(banco, boleto, antes_de=r["data"], excluir=excluir)
        motivo, confianca = _alvo(r, hist, semelhantes, nomes)
        rejeitado = _rejeitado(r)
        rotulo = "corrigido_pelo_humano" if rejeitado else "confirmado"
        alvo = {"itens": [{"item_id": boletos.ITEM_ID, "motivo": motivo, "categoria": nomes[r["categoria_id"]], "confianca": confianca}]}
        ex = {
            "messages": [
                {"role": "system", "content": boletos.SISTEMA},
                {"role": "user", "content": boletos.montar_prompt(boleto, hist, semelhantes, categorias)},
                {"role": "assistant", "content": json.dumps(alvo, ensure_ascii=False)},
            ],
            "rotulo": rotulo,
            "contexto": {
                "chave": r["chave"], "fonte": r["fonte"], "por": r["por"], "empresa": r["empresa"], "data": r["data"],
                "fornecedor": r["fornecedor"], "fornecedor_nome": r.get("fornecedor_nome"),
                "itens": [{"item_id": boletos.ITEM_ID, "categoria_id": r["categoria_id"], "valor_total": r.get("valor") or 0.0,
                           "historico_categoria_id": hist["painel"] or (hist["distribuicao"][0]["categoria_id"] if hist["distribuicao"] else None),
                           "rejeitado": rejeitado}],
            },
        }
        ds.contagem["corrigidos"] += rejeitado is not None
        if na_validacao:
            ds.validacao.append(ex)
            continue
        ds.treino.append(ex)
        if rejeitado and rejeitado[0] in nomes:
            errado = {"itens": [{"item_id": boletos.ITEM_ID, "motivo": rejeitado[1], "categoria": nomes[rejeitado[0]], "confianca": rejeitado[2]}]}
            ds.dpo.append({
                "prompt": ex["messages"][:2], "chosen": [ex["messages"][2]],
                "rejected": [{"role": "assistant", "content": json.dumps(errado, ensure_ascii=False)}],
                "contexto": {"chave": r["chave"]},
            })
    return ds


def exportar(banco: Banco, pasta: Path) -> Counter:
    boletos.atualizar_vetores(banco)
    ds = montar(banco)
    pasta.mkdir(parents=True, exist_ok=True)

    def gravar(nome: str, linhas: Iterable[dict]) -> int:
        n = 0
        with (pasta / nome).open("w", encoding="utf-8") as f:
            for linha in linhas:
                f.write(json.dumps(linha, ensure_ascii=False) + "\n")
                n += 1
        return n

    sft = [ex for ex in ds.treino for _ in range(OVERSAMPLE if ex["rotulo"] == "corrigido_pelo_humano" else 1)]
    ds.contagem["linhas_sft"] = gravar("boletos_sft.jsonl", sft)
    ds.contagem["linhas_validacao"] = gravar("boletos_validacao.jsonl", ds.validacao)
    ds.contagem["pares_dpo"] = gravar("boletos_dpo.jsonl", ds.dpo)
    return ds.contagem


# --- métricas (python -m agentes avaliar-boletos) ---------------------------------------------


def avaliar(banco: Banco, top: int = 10) -> str:
    registros = _registros(banco)
    tiny = [r for r in registros if r["fonte"] == "tiny"]
    painel = [r for r in registros if r["fonte"] == "painel"]
    saida = [
        f"Histórico: {len(tiny)} saída(s) do Tiny e {len(painel)} escolha(s) no painel, "
        f"{len({r['empresa'] for r in registros})} empresa(s), {len({(r['empresa'], r['fornecedor']) for r in registros})} fornecedor(es)",
        "",
    ]
    # O que o histórico sozinho acertaria: categoria mais usada com o fornecedor ATÉ ali.
    contagem: dict[tuple, Counter] = defaultdict(Counter)
    novos = acertos = com_hist = 0
    for r in tiny:
        anteriores = contagem[(r["empresa"], r["fornecedor"])]
        if anteriores:
            com_hist += 1
            acertos += anteriores.most_common(1)[0][0] == r["categoria_id"]
        else:
            novos += 1
        anteriores[r["categoria_id"]] += 1
    saida.append(f"Saídas do Tiny com fornecedor já visto: histórico sozinho acerta {_taxa(acertos, com_hist)}")
    saida.append(f"Saídas do Tiny de fornecedor novo na empresa (só o Qwen decide): {novos}")

    def bloco(titulo: str, pares: list[tuple[str, Optional[str], str]]) -> None:
        saida.append(f"{titulo}: concordância {_taxa(sum(s == f for s, _, f in pares), len(pares))}")
        for conf in ("alta", "media", "baixa"):
            sub = [(s, f) for s, c, f in pares if c == conf]
            if sub:
                saida.append(f"    confiança {conf:<5} {_taxa(sum(s == f for s, f in sub), len(sub))}")

    saida.append("")
    bloco("Qwen na tela", [(r["qwen_categoria_id"], r["qwen_confianca"], r["categoria_id"]) for r in painel if r["qwen_categoria_id"]])
    bloco("Qwen deste PC (palpite)", [(r["palpite_categoria_id"], r["palpite_confianca"], r["categoria_id"]) for r in painel if r["palpite_categoria_id"]])
    origens: dict[str, list] = defaultdict(list)
    for r in painel:
        t = r["sugestao"] or {}
        if t.get("categoria_id"):
            origens[f"{t.get('origem')}{'/' + t['nivel'] if t.get('nivel') else ''}"].append(t["categoria_id"] == r["categoria_id"])
        else:
            origens["sem sugestão"].append(False)
    if origens:
        saida.append("Sugestão da tela por origem (escolhas no painel):")
        for origem, lista in sorted(origens.items(), key=lambda kv: -len(kv[1])):
            saida.append(f"    {origem:<22} {_taxa(sum(lista), len(lista))}")
    corrigidos = Counter(f"{r.get('fornecedor_nome') or '-'} ({r['fornecedor']})" for r in painel if _rejeitado(r))
    saida.append(f"\nTop {top} fornecedores onde a pessoa mais corrige a sugestão:")
    saida.extend(f"    {n:>4}  {k}" for k, n in corrigidos.most_common(top))
    if not corrigidos:
        saida.append("    (nenhuma correção registrada)")
    return "\n".join(saida)


# --- portão do fine-tuning (python -m agentes comparar-boletos) ---------------------------------


def ler_validacao(pasta: Path) -> list[dict]:
    arquivo = pasta / "boletos_validacao.jsonl"
    validacao = [json.loads(l) for l in arquivo.read_text(encoding="utf-8").splitlines() if l.strip()] if arquivo.is_file() else []
    if not validacao:
        raise ValueError("validação vazia: rode `python -m agentes treino-boletos` antes")
    return validacao


def _catalogo_do_prompt(usuario: str) -> list[dict]:
    """Rótulos do catálogo de volta do prompt (cada exemplo tem o catálogo da sua empresa)."""
    bloco = usuario.split("## Catálogo de categorias desta empresa (grupo → nome)\n", 1)[1].split("\n\n", 1)[0]
    return [{"rotulo": l} for l in bloco.splitlines() if l.strip()]


def medir(gerar, modelo: str, validacao: list[dict]) -> tuple[Placar, Placar]:
    """(placar do modelo, placar do histórico sozinho) na validação, com o schema da fila."""
    import time

    from . import llm

    placar, base = Placar(modelo), Placar("histórico sozinho (sem Qwen)")
    for ex in validacao:
        g = ex["contexto"]["itens"][0]
        resposta = json.loads(ex["messages"][2]["content"])["itens"][0]["categoria"]
        rotulos = [c["rotulo"] for c in _catalogo_do_prompt(ex["messages"][1]["content"])]
        esquema = financeiro.esquema(rotulos, [boletos.ITEM_ID])
        inicio = time.monotonic()
        try:
            saida = gerar(modelo, ex["messages"][0]["content"], ex["messages"][1]["content"], esquema)
            escolha = next((i.categoria for i in saida.itens), None)
        except llm.SaidaInvalida:
            placar.invalidas += 1
            escolha = None
        placar.segundos += time.monotonic() - inicio
        for p, certo in ((placar, escolha == resposta), (base, g["historico_categoria_id"] == g["categoria_id"])):
            p.notas += 1
            p.itens += 1
            p.acertos += certo
            p.valor += g["valor_total"] or 0.0
            p.valor_certo += (g["valor_total"] or 0.0) if certo else 0.0
    return placar, base


def comparar(candidato: Path, pasta: Path, promovido: Optional[Path] = None) -> tuple[Placar, Placar, Placar]:
    """(atual, candidato, histórico sozinho) no MESMO llama-server; atual = o promovido ou a base pura."""
    from . import llama_server

    validacao = ler_validacao(pasta)
    adaptadores = ([promovido] if promovido else []) + [candidato]
    with llama_server.Servidor(adaptadores) as srv:
        def com(lora):
            return lambda m, sis, usu, esq: srv.gerar(m, sis, usu, esq, lora=lora)

        atual, base = medir(com(0 if promovido else None), llama_server.rotulo_modelo(promovido), validacao)
        novo, _ = medir(com(len(adaptadores) - 1), llama_server.rotulo_modelo(candidato), validacao)
    return atual, novo, base
