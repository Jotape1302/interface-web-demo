import pytest

from app.dimensoes import (
    Dimensoes,
    dimensoes_de_texto_ml,
    embalagem_no_ml,
    embalagem_para,
    envio_indicado,
    ficha_ml,
    medidas_tiny,
    peso_liquido_tiny,
    valores_ficha,
)


def test_ficha_ml_e_do_produto_nao_da_embalagem():
    item = {
        "attributes": [
            {"id": "SELLER_PACKAGE_HEIGHT", "value_name": "5 cm"},
            {"id": "THICKNESS", "value_name": "2 mm"},
            {"id": "WEIGHT", "value_name": "1,2 kg"},
        ],
        "variations": [{"attributes": [{"id": "WIDTH", "value_name": "1,4 cm"}, {"id": "LENGTH", "value_name": "1 m"}]}],
    }
    d = ficha_ml(item)
    assert (d.altura, d.largura, d.comprimento, d.peso) == (0.2, 1.4, 100, 1200)
    emb = embalagem_no_ml({"shipping": {"dimensions": "10x20x30,500"}, "attributes": [{"id": "SELLER_PACKAGE_WEIGHT", "value_name": "700 g"}]})
    assert emb == Dimensoes(10, 20, 30, 700)
    assert dimensoes_de_texto_ml(None).vazias()


def test_medidas_do_tiny_com_peso_bruto():
    produto = {"dimensoes": {"altura": 1.6, "largura": 1.6, "comprimento": 300, "pesoLiquido": 0.8, "pesoBruto": 0.9}}
    d = medidas_tiny(produto)
    assert (d.lados, d.peso) == ([1.6, 1.6, 300], 900), "vale o peso bruto"
    assert peso_liquido_tiny(produto) == 800
    assert medidas_tiny({"dimensoes": {"pesoLiquido": 0.8}}).peso is None, "sem peso bruto não usa o líquido"
    assert medidas_tiny({}).vazias()


def test_valores_da_ficha_por_atributo():
    item = {"attributes": [{"id": "LENGTH", "value_name": "3 m"}, {"id": "WEIGHT", "value_name": "1,2 kg"}]}
    assert valores_ficha(item, ["LENGTH", "WEIGHT", "HEIGHT"]) == {"LENGTH": 300.0, "WEIGHT": 1200.0, "HEIGHT": None}


@pytest.mark.parametrize("produto", [(1.6, 1.6, 98), (5, 5, 300), (8, 1, 100), (1, 1, 310)])
def test_embalagem_e_a_do_tiny(produto):
    emb = embalagem_para(Dimensoes(*produto, 400))
    assert (emb.altura, emb.largura, emb.comprimento, emb.peso) == (*produto, 400)


def test_sem_os_tres_lados_nao_ha_embalagem():
    assert embalagem_para(Dimensoes(None, 1, 100)) is None


def test_envio_indicado_pelo_comprimento_da_embalagem():
    assert envio_indicado(Dimensoes(5, 7, 100)) == "me2"
    assert envio_indicado(Dimensoes(5, 7, 200)) == "me2", "2 m é ME2"
    assert envio_indicado(Dimensoes(5, 7, 300)) == "me1", "3 m é ME1"
    assert envio_indicado(None) is None


def test_ml_so_aceita_inteiros_e_lado_com_fracao_sobe():
    assert Dimensoes(3.4, 1.4, 100, 350).para_ml() == Dimensoes(4, 2, 100, 350)
    assert Dimensoes(5.0, 2.5, 200, 500).texto_ml() == "5x3x200,500"
    assert Dimensoes(5, 2, 200).texto_ml() is None, "sem peso o ML recusa shipping.dimensions"
