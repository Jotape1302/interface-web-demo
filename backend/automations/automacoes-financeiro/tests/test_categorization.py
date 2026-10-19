from decimal import Decimal

from app.categorization import CategorizedItem, group_items_by_category
from app.nfe_items import NFeItem


def _citem(item_id, descricao, valor, categoria_id):
    return CategorizedItem(
        item=NFeItem(item_id=item_id, descricao=descricao, valor_total=Decimal(valor)),
        categoria_id=categoria_id,
    )


def test_single_category_generates_one_group_with_full_note_total():
    itens = [_citem(str(i), f"Item {i}", "10.00", "480897321") for i in range(1, 11)]
    grupos = group_items_by_category(itens, Decimal("100.00"))

    assert len(grupos) == 1
    assert grupos[0].categoria_id == "480897321"
    assert grupos[0].valor_total == Decimal("100.00")
    assert len(grupos[0].item_ids) == 10


def test_multiple_categories_generate_separate_groups():
    itens = (
        [_citem(str(i), f"Limpeza {i}", "10.00", "701885961") for i in range(1, 6)]
        + [_citem(str(i), f"Escritorio {i}", "10.00", "484437483") for i in range(6, 11)]
    )
    grupos = group_items_by_category(itens, Decimal("100.00"))

    assert len(grupos) == 2
    by_id = {g.categoria_id: g for g in grupos}
    assert by_id["701885961"].valor_total == Decimal("50.00")
    assert by_id["484437483"].valor_total == Decimal("50.00")
    assert len(by_id["701885961"].item_ids) == 5
    assert len(by_id["484437483"].item_ids) == 5


def test_each_item_own_category_generates_n_groups():
    ids = [
        "480897321", "484437789", "701885961", "484437483", "484437787",
        "817609805", "484437642", "484437781", "484437474", "484437478",
    ]
    itens = [_citem(str(i + 1), f"Item {i + 1}", "10.00", cid) for i, cid in enumerate(ids)]
    grupos = group_items_by_category(itens, Decimal("100.00"))
    assert len(grupos) == 10


def test_rateio_of_freight_closes_exactly_to_note_total():
    # Itens somam 90.00, mas a nota tem frete de +10.00 embutido no total -> 100.00
    itens = [
        _citem("1", "Item Limpeza", "60.00", "701885961"),
        _citem("2", "Item Escritorio", "30.00", "484437483"),
    ]
    grupos = group_items_by_category(itens, Decimal("100.00"))

    soma = sum((g.valor_total for g in grupos), Decimal("0.00"))
    assert soma == Decimal("100.00")

    by_id = {g.categoria_id: g for g in grupos}
    # Rateio proporcional: 60/90 e 30/90 dos 10.00 de diferença
    assert by_id["701885961"].valor_total == Decimal("66.67")
    assert by_id["484437483"].valor_total == Decimal("33.33")


def test_rateio_of_discount_closes_exactly_to_note_total():
    # Itens somam 100.00, mas a nota tem desconto de -5.00 -> total 95.00
    itens = [
        _citem("1", "Item A", "50.00", "480897321"),
        _citem("2", "Item B", "50.00", "484437789"),
    ]
    grupos = group_items_by_category(itens, Decimal("95.00"))
    soma = sum((g.valor_total for g in grupos), Decimal("0.00"))
    assert soma == Decimal("95.00")


def test_empty_itens_returns_empty_list():
    assert group_items_by_category([], Decimal("100.00")) == []
