"""
Agrupamento de itens categorizados em lançamentos por categoria para o Tiny ERP.

Regra de negócio (não-negociável): itens da mesma categoria geram exatamente 1
lançamento com o valor somado; categorias diferentes geram lançamentos separados.
Eventual diferença entre a soma dos itens e o valor total da nota (frete, seguro,
outras despesas, desconto) é rateada proporcionalmente entre os grupos, de forma
que a soma dos lançamentos feche exatamente com o valor total da nota.
"""
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import List

from app.nfe_items import NFeItem
from app.tiny_categories import CATEGORY_BY_ID, DEFAULT_CATEGORY_ID

CENTS = Decimal("0.01")


@dataclass
class CategorizedItem:
    item: NFeItem
    categoria_id: str


@dataclass
class GroupedLancamento:
    categoria_id: str
    categoria_nome: str
    valor_total: Decimal
    item_ids: List[str] = field(default_factory=list)
    historico_detalhe: str = ""


def _categoria_nome(categoria_id: str) -> str:
    cat = CATEGORY_BY_ID.get(categoria_id)
    return cat.nome if cat else CATEGORY_BY_ID[DEFAULT_CATEGORY_ID].nome


def _historico_detalhe(itens: List[NFeItem], max_len: int = 200) -> str:
    partes = [f"{i.descricao} (R$ {i.valor_total})" for i in itens]
    detalhe = "; ".join(partes)
    if len(detalhe) > max_len:
        detalhe = detalhe[: max_len - 1] + "…"
    return detalhe


def group_items_by_category(
    itens: List[CategorizedItem],
    valor_total_nota: Decimal,
) -> List[GroupedLancamento]:
    """
    Agrupa itens categorizados por categoria_id, somando seus valores e rateando
    proporcionalmente a diferença entre a soma dos itens e o valor total da nota
    (frete/seguro/outras despesas/desconto), para que a soma dos grupos feche
    exatamente com valor_total_nota.
    """
    if not itens:
        return []

    grupos_ordem: List[str] = []
    itens_por_grupo: dict[str, List[NFeItem]] = {}
    for citem in itens:
        cid = citem.categoria_id or DEFAULT_CATEGORY_ID
        if cid not in itens_por_grupo:
            itens_por_grupo[cid] = []
            grupos_ordem.append(cid)
        itens_por_grupo[cid].append(citem.item)

    subtotais = {
        cid: sum((i.valor_total for i in grupo_itens), Decimal("0.00"))
        for cid, grupo_itens in itens_por_grupo.items()
    }
    soma_itens = sum(subtotais.values(), Decimal("0.00"))
    diferenca = (valor_total_nota or soma_itens) - soma_itens

    grupos: List[GroupedLancamento] = []
    valores_finais: dict[str, Decimal] = {}

    if soma_itens == 0:
        # Sem valores nos itens (não deveria ocorrer em uso normal): joga tudo no
        # primeiro grupo para não perder o valor total da nota.
        for idx, cid in enumerate(grupos_ordem):
            valores_finais[cid] = valor_total_nota if idx == 0 else Decimal("0.00")
    else:
        acumulado = Decimal("0.00")
        # Ordena para que o maior subtotal absorva o resíduo de arredondamento por último.
        ordem_rateio = sorted(grupos_ordem, key=lambda cid: subtotais[cid])
        for idx, cid in enumerate(ordem_rateio):
            is_last = idx == len(ordem_rateio) - 1
            if is_last:
                valor = valor_total_nota - acumulado
            else:
                proporcao = subtotais[cid] / soma_itens
                rateio = (diferenca * proporcao).quantize(CENTS, rounding=ROUND_HALF_UP)
                valor = (subtotais[cid] + rateio).quantize(CENTS, rounding=ROUND_HALF_UP)
            valores_finais[cid] = valor
            acumulado += valor

    for cid in grupos_ordem:
        grupo_itens = itens_por_grupo[cid]
        grupos.append(GroupedLancamento(
            categoria_id=cid,
            categoria_nome=_categoria_nome(cid),
            valor_total=valores_finais[cid],
            item_ids=[i.item_id for i in grupo_itens],
            historico_detalhe=_historico_detalhe(grupo_itens),
        ))

    return grupos
