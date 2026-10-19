from decimal import Decimal
from pathlib import Path

from app.category_history import build_index
from types import SimpleNamespace
from app.review_store import ReviewItem, ReviewRecord

FABRILUX = "43820617000166"
REVESTA = "36592814000100"
FORNECEDOR = "11111111000111"


def _item(item_id, cat, codigo=None, ncm=None, valor="100"):
    return ReviewItem(
        item_id=item_id,
        descricao="Produto",
        valor_total=Decimal(valor),
        codigo=codigo,
        ncm=ncm,
        quantidade=Decimal("1"),
        valor_unitario=None,
        categoria_sugerida_id=cat,
    )


def _record(chave, staged_at, dest, itens, emit=FORNECEDOR):
    # build_index só lê os CNPJs de nfe_data.
    nfe = SimpleNamespace(destinatario_cnpj=dest, emitente_cnpj=emit)
    return ReviewRecord(chave=chave, filename=f"{chave}.xml", staged_at=staged_at, file_path=Path(f"/tmp/{chave}.xml"), nfe_data=nfe, itens=itens)


def test_codigo_tem_precedencia_e_vale_a_escolha_mais_recente():
    index = build_index([
        _record("B", "2026-09-10", FABRILUX, [_item("1", "cat_nova", codigo="P1")]),
        _record("A", "2026-09-01", FABRILUX, [_item("1", "cat_antiga", codigo="P1")]),
    ])
    novo = _item("x", "regra", codigo="P1", ncm="999")
    assert index.suggest(FABRILUX, FORNECEDOR, novo) == "cat_nova"


def test_cai_para_ncm_e_depois_para_categoria_dominante_do_fornecedor():
    index = build_index([
        _record("A", "2026-09-01", FABRILUX, [
            _item("1", "cat_ncm", ncm="4418", valor="50"),
            _item("2", "cat_dominante", valor="900"),
        ]),
    ])
    assert index.suggest(FABRILUX, FORNECEDOR, _item("x", "regra", codigo="OUTRO", ncm="4418")) == "cat_ncm"
    assert index.suggest(FABRILUX, FORNECEDOR, _item("y", "regra", ncm="0000")) == "cat_dominante"


def test_historico_e_isolado_por_empresa_destinataria():
    index = build_index([_record("A", "2026-09-01", FABRILUX, [_item("1", "cat_fabrilux", codigo="P1")])])
    assert index.suggest(REVESTA, FORNECEDOR, _item("x", "regra", codigo="P1")) is None
    assert index.suggest(FABRILUX, "99999999000199", _item("x", "regra", codigo="P1")) is None
