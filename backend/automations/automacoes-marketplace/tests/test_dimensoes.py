import pytest

from app.dimensoes import (
    Dimensoes,
    comparar_fontes,
    dimensoes_de_texto,
    dimensoes_de_texto_ml,
    dimensoes_do_titulo,
    embalagem_no_ml,
    embalagem_para,
    envio_indicado,
    ficha_ml,
    ficha_tiny,
    normalizada,
)


@pytest.mark.parametrize(
    "titulo, esperado",
    [
        ("Painel Ripado 60x40x15cm Madeira", (60, 40, 15)),
        ("Tapete Sala 2,00 x 1,50 x 0,01 m", (200, 150, 1)),
        ("Prateleira 80 x 25 x 3 cm Branca", (80, 25, 3)),
        ("Nicho 30x30x15 Mdf", (30, 30, 15)),  # sem unidade: cm
        ("Rodapé 1200mm x 100mm x 15mm", (120, 10, 1.5)),
        ("PAINEL 3D 60X40X2CM BRANCO", (60, 40, 2)),
    ],
)
def test_tres_medidas_no_titulo(titulo, esperado):
    d = dimensoes_do_titulo(titulo)
    assert (d.altura, d.largura, d.comprimento) == esperado


def test_duas_medidas_deixam_altura_vazia_e_kit_nao_vira_medida():
    d = dimensoes_do_titulo("Quadro Decorativo 60x40cm")
    assert (d.altura, d.largura, d.comprimento) == (None, 60, 40)
    assert dimensoes_do_titulo("Kit 2x1 Adesivo Parede").vazias()


@pytest.mark.parametrize(
    "titulo, esperado",
    [
        ("Canto L Alumínio Para Quina De Parede Dourada 16mmx16mmx3m Dourado Brilho", (1.6, 1.6, 300)),
        ("Perfil Junta Dilatação Preto Alumínio 15mmx1,2mmx2,5m Preto", (1.5, 0.12, 250)),
        ("Cantoneira Siena 16x16mm 3m Viscardi", (1.6, 1.6, 300)),
        ("Perfil T 18mm Em Alumínio 2 Metros", (None, None, None)),
    ],
)
def test_titulo_com_unidade_colada_e_comprimento_em_metros(titulo, esperado):
    d = dimensoes_do_titulo(titulo)
    assert (d.altura, d.largura, d.comprimento) == esperado


def test_peso_no_titulo_e_descricao_rotulada():
    assert dimensoes_do_titulo("Cola Gart Fix 5kg").peso == 5000
    d = dimensoes_de_texto("Medidas: Altura: 2 cm Largura 1,4cm Comprimento: 1 m. Peso: 350 g")
    assert (d.altura, d.largura, d.comprimento, d.peso) == (2, 1.4, 100, 350)
    d = dimensoes_de_texto("<b>Espessura</b>: 2mm | Largura: 16 mm | Comprimento: 3m | Peso líquido: 0,8 kg")
    assert (d.altura, d.largura, d.comprimento, d.peso) == (0.2, 1.6, 300, 800)
    d = dimensoes_de_texto("Perfil 16mmx16mmx3m, ótimo acabamento")
    assert d.lados == [1.6, 1.6, 300]


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


def test_ficha_tiny_em_cm_e_kg():
    d = ficha_tiny({"dimensoes": {"altura": 1.6, "largura": 1.6, "comprimento": 300, "pesoLiquido": 0.8, "pesoBruto": 0.9}})
    assert (d.lados, d.peso) == ([1.6, 1.6, 300], 800)
    assert ficha_tiny({"dimensoes": {"pesoBruto": 0.9}}).peso == 900
    assert ficha_tiny({}).vazias()


def _f(fonte, a=None, l=None, c=None, peso=None, local="x"):
    return {"fonte": fonte, "local": local, "dims": {"altura": a, "largura": l, "comprimento": c, "peso": peso}}


def test_confiabilidade_alta_media_baixa():
    alta = comparar_fontes([_f("tiny_ficha", 300, 1.6, 1.6, 800), _f("ml_titulo", 1.6, 1.6, 298), _f("ml_ficha", peso=790)])
    assert alta["confiabilidade"] == "alta"
    assert alta["sugestao"] == {"altura": 1.6, "largura": 1.6, "comprimento": 300, "peso": 800}

    media = comparar_fontes([_f("tiny_ficha", 1, 1, 100, 300), _f("ml_titulo", 1, 1, 100), _f("ml_descricao", 5, 5, 100), _f("ml_ficha", peso=300)])
    assert media["confiabilidade"] == "media"

    baixa = comparar_fontes([_f("tiny_ficha", 1, 1, 100, 300), _f("ml_titulo", 5, 29, 300), _f("ml_ficha", peso=300)])
    assert baixa["confiabilidade"] == "baixa"
    assert baixa["sugestao"]["comprimento"] == 100, "empate: vale a ficha do Tiny"

    sem_nada = comparar_fontes([_f("ml_titulo", l=1.6, c=300)])
    assert sem_nada["confiabilidade"] == "baixa" and sem_nada["sugestao"]["comprimento"] == 300

    sem_peso = comparar_fontes([_f("tiny_ficha", 1, 1, 100), _f("ml_titulo", 1, 1, 100)])
    assert (sem_peso["confiabilidade_tamanho"], sem_peso["confiabilidade"]) == ("alta", "baixa"), "peso é obrigatório no ML"


def test_normalizada_comprimento_e_o_maior_lado():
    assert normalizada(Dimensoes(300, 1.6, 2, 5)) == Dimensoes(1.6, 2, 300, 5)


@pytest.mark.parametrize(
    "produto, comprimento",
    [((1.6, 1.6, 98), 100), ((1.6, 1.6, 100), 100), ((1, 1.2, 200), 200), ((1, 1.2, 298), 300), ((4.5, 6.5, 300), 300)],
)
def test_embalagem_padrao_pelo_comprimento(produto, comprimento):
    emb = embalagem_para(Dimensoes(*produto, 400))
    assert (emb.altura, emb.largura, emb.comprimento, emb.peso) == (5, 7, comprimento, 400)


def test_produto_que_nao_cabe_na_embalagem():
    assert embalagem_para(Dimensoes(8, 1, 100)) is None, "8 cm não cabe na seção 5 x 7"
    assert embalagem_para(Dimensoes(1, 1, 310)) is None, "maior que 300 cm"
    assert embalagem_para(Dimensoes(None, 1, 100)) is None


def test_envio_indicado_pela_embalagem_e_pela_tag_do_ml():
    assert envio_indicado(Dimensoes(5, 7, 100)) == "me2"
    assert envio_indicado(Dimensoes(5, 7, 200)) == "me1"
    assert envio_indicado(Dimensoes(5, 7, 300), ["me2_available", "self_service_available"]) == "me2"
    assert envio_indicado(None) is None


def test_ml_so_aceita_inteiros_e_lado_com_fracao_sobe():
    assert Dimensoes(3.4, 1.4, 100, 350).para_ml() == Dimensoes(4, 2, 100, 350)
    assert Dimensoes(5.0, 2.5, 200, 500).texto_ml() == "5x3x200,500"
    assert Dimensoes(5, 2, 200).texto_ml() is None, "sem peso o ML recusa shipping.dimensions"
