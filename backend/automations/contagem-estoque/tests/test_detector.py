from pathlib import Path

import cv2
import numpy as np
import pytest
from pydantic import ValidationError

from app.config import DetectorSettings
from app.detector import COR_ROSA, COR_VERDE, analyze, detect_markers, load_image

GREEN = (34, 144, 85)  # BGR do verde medido nos prendedores: HSV ≈ (46, 195, 144)
MARKER_W, MARKER_H = 30, 18


def shelf(width: int = 1200, height: int = 800, seed: int = 0) -> np.ndarray:
    """Fundo de prateleira: marrom acinzentado com ruído."""
    rng = np.random.default_rng(seed)
    base = np.full((height, width, 3), (90, 110, 125), dtype=np.int16)
    noise = rng.integers(-18, 18, size=base.shape)
    return np.clip(base + noise, 0, 255).astype(np.uint8)


PINK = (147, 20, 255)  # BGR do rosa choque (#FF1493): HSV ≈ (164, 235, 255). Estimado, sem foto real.


def marker(img: np.ndarray, x: int, y: int, scale: float = 1.0, color: tuple[int, int, int] = GREEN) -> None:
    w, h = round(MARKER_W * scale), round(MARKER_H * scale)
    cv2.rectangle(img, (x, y), (x + w, y + h), color, cv2.FILLED)


def settings(**overrides) -> DetectorSettings:
    # _env_file=None: os testes não dependem de um .env local. Largura de
    # processamento = largura da imagem de teste, para os limites não serem escalados.
    return DetectorSettings(_env_file=None, **{"MAX_PROCESSING_WIDTH": 1200, **overrides})


def test_conta_marcadores_e_ignora_ruido_outras_cores_e_formas():
    img = shelf()
    for x, y in [(100, 100), (300, 120), (500, 90), (150, 400), (420, 420)]:
        marker(img, x, y)
    for x, y in [(700, 100), (720, 300), (900, 500)]:  # pontinhos verdes (reflexo/compressão)
        cv2.circle(img, (x, y), 2, GREEN, cv2.FILLED)
    cv2.rectangle(img, (800, 600), (840, 625), (160, 40, 130), cv2.FILLED)  # roxo
    cv2.rectangle(img, (950, 100), (990, 125), (30, 30, 200), cv2.FILLED)  # vermelho
    cv2.rectangle(img, (1050, 300), (1090, 325), (43, 174, 200), cv2.FILLED)  # amarelo (fita/etiqueta)
    cv2.rectangle(img, (100, 700), (400, 712), GREEN, cv2.FILLED)  # faixa verde comprida
    cv2.rectangle(img, (600, 450), (1100, 790), GREEN, cv2.FILLED)  # área verde enorme

    analysis = analyze(img, settings(MAX_MARKER_AREA=5000))

    assert len(analysis.detections) == 5
    reasons = sorted(c.rejection for c in analysis.candidates if c.rejection)
    assert reasons == ["area_grande", "forma"]


def test_marcador_partido_pela_mascara_conta_uma_vez():
    # Um prendedor partido em dois pedaços (cada um menor que um prendedor inteiro).
    img = shelf()
    cv2.rectangle(img, (200, 200), (212, 218), GREEN, cv2.FILLED)
    cv2.rectangle(img, (226, 200), (238, 218), GREEN, cv2.FILLED)  # 14 px de vão
    for x in (500, 600, 700, 800):
        marker(img, x, 200)

    assert len(analyze(img, settings(MERGE_DISTANCE=16)).detections) == 5
    assert len(analyze(img, settings(MERGE_DISTANCE=0)).detections) == 6


def test_dois_marcadores_inteiros_proximos_nunca_sao_unidos():
    # Prendedores de pacotes vizinhos a 6 px: dentro da distância de junção, mas cada um
    # já é um marcador inteiro — continuam dois (antes viravam um só).
    img = shelf()
    marker(img, 200, 200)
    marker(img, 236, 200)
    for x in (500, 600, 700):
        marker(img, x, 200)

    assert len(analyze(img, settings(MERGE_DISTANCE=10)).detections) == 5


def test_prendedores_encostados_que_o_fechamento_uniu_sao_separados():
    # Dois prendedores paralelos a 4 px (um em cima do outro): o MORPH_CLOSE fecha o vão e
    # forma um "H"; a máscara antes do fechamento mostra os dois inteiros.
    img = shelf()
    cv2.rectangle(img, (200, 200), (240, 209), GREEN, cv2.FILLED)
    cv2.rectangle(img, (200, 214), (240, 223), GREEN, cv2.FILLED)
    for x in (500, 600, 700):
        cv2.rectangle(img, (x, 200), (x + 40, 209), GREEN, cv2.FILLED)

    analysis = analyze(img, settings())

    assert cv2.connectedComponents(analysis.mask[195:230, 195:245])[0] - 1 == 1  # unidos na máscara
    assert len(analysis.detections) == 5


def test_marcador_parcial_menor_que_o_minimo_absoluto_conta_pela_area_tipica():
    # Prendedor atrás do plástico: só um pedaço aparece, abaixo de MIN_MARKER_AREA (400 aqui),
    # mas acima de 20% da área típica da foto. Pontinho de ruído continua fora.
    img = shelf()
    for x in (100, 250, 400, 550):
        marker(img, x, 200, scale=1.5)  # ~1200 px
    cv2.rectangle(img, (800, 200), (809, 219), GREEN, cv2.FILLED)  # ~200 px: 17% da típica → fora
    cv2.rectangle(img, (900, 200), (915, 219), GREEN, cv2.FILLED)  # ~320 px: 27% → conta

    analysis = analyze(img, settings(MIN_MARKER_AREA=400))

    assert len(analysis.detections) == 5
    assert analysis.min_area < 400


def test_marcador_grande_partido_por_listras_conta_uma_vez_e_vizinhos_continuam_separados():
    # Foto de perto: marcadores com ~120 px. Um deles é cortado por duas listras
    # claras de 20 px (vão bem maior que MERGE_DISTANCE fixo de 10 px).
    img = shelf()
    for x in (100, 400, 700):
        cv2.circle(img, (x, 200), 60, GREEN, cv2.FILLED)
    cv2.circle(img, (400, 500), 60, GREEN, cv2.FILLED)
    for stripe_x in (375, 415):
        cv2.rectangle(img, (stripe_x, 430), (stripe_x + 20, 570), (220, 220, 220), cv2.FILLED)
    # Vizinho a 40 px de vão (1/3 do tamanho): pacote diferente, não pode ser unido.
    cv2.circle(img, (620, 500), 60, GREEN, cv2.FILLED)

    analysis = analyze(img, settings(MAX_MARKER_AREA=20000))

    assert len(analysis.detections) == 5
    assert 25 <= analysis.merge_gap <= 35  # 0,25 x ~120 px


def test_numeracao_de_cima_para_baixo_e_da_esquerda_para_a_direita():
    img = shelf()
    # Mesma linha com pequeno desnível; inseridos fora de ordem.
    positions = [(700, 108), (100, 100), (400, 95), (650, 400), (120, 410), (380, 402)]
    for x, y in positions:
        marker(img, x, y)

    dets = analyze(img, settings()).detections

    assert [d.number for d in dets] == [1, 2, 3, 4, 5, 6]
    assert [d.center_x for d in dets[:3]] == sorted(d.center_x for d in dets[:3])
    assert [d.center_x for d in dets[3:]] == sorted(d.center_x for d in dets[3:])
    assert max(d.center_y for d in dets[:3]) < min(d.center_y for d in dets[3:])


def test_foto_grande_e_reduzida_e_limites_acompanham_a_escala(tmp_path: Path):
    big = shelf(width=4000, height=3000)
    for i in range(4):
        marker(big, 300 + i * 900, 1200, scale=4000 / 1600)
    photo = tmp_path / "foto.jpg"
    cv2.imwrite(str(photo), big, [cv2.IMWRITE_JPEG_QUALITY, 85])

    small = cv2.resize(big, (1000, 750), interpolation=cv2.INTER_AREA)  # menor que a largura máxima
    small_photo = tmp_path / "pequena.jpg"
    cv2.imwrite(str(small_photo), small, [cv2.IMWRITE_JPEG_QUALITY, 85])

    result = detect_markers(photo, tmp_path / "out", "abc123", settings(MAX_PROCESSING_WIDTH=1600))
    assert result.count == 4
    annotated = load_image(result.annotated_image_path)
    assert annotated.shape[1] == 1600  # anotação na resolução de processamento

    assert detect_markers(small_photo, tmp_path / "out", "def456", settings()).count == 4


def test_imagem_anotada_tem_um_circulo_por_marcador_e_nome_unico(tmp_path: Path):
    img = shelf()
    marker(img, 100, 100)
    marker(img, 500, 500)
    photo = tmp_path / "foto.png"
    cv2.imwrite(str(photo), img)

    result = detect_markers(photo, tmp_path, "id-unico", settings())

    assert result.count == len(result.detections) == 2
    assert result.annotated_image_path.name == "id-unico_processada.jpg"
    annotated = load_image(result.annotated_image_path)
    for det in result.detections:
        # O traço magenta do círculo passa logo acima do marcador.
        ring = annotated[det.center_y - det.radius - 12 : det.center_y - det.radius + 2, det.center_x]
        assert any(px[0] > 200 and px[2] > 200 and px[1] < 80 for px in ring)


def test_sem_marcadores_retorna_zero(tmp_path: Path):
    photo = tmp_path / "vazia.png"
    cv2.imwrite(str(photo), shelf())
    assert detect_markers(photo, tmp_path, "x", settings()).count == 0


def test_arquivo_que_nao_e_imagem_gera_erro_claro(tmp_path: Path):
    bad = tmp_path / "nao_e_imagem.jpg"
    bad.write_text("texto")
    with pytest.raises(ValueError):
        detect_markers(bad, tmp_path, "x", settings())


def test_faixas_invertidas_sao_recusadas():
    with pytest.raises(ValidationError):
        settings(MARKER_HUE_MIN=160, MARKER_HUE_MAX=120)
    with pytest.raises(ValidationError):
        settings(MIN_MARKER_AREA=500, MAX_MARKER_AREA=100)


def test_prendedor_rosa_e_fardo_de_10_e_verde_de_5(tmp_path: Path):
    img = shelf()
    for x, y in [(100, 100), (300, 120), (500, 90)]:
        marker(img, x, y, color=PINK)
    photo = tmp_path / "rosa.png"
    cv2.imwrite(str(photo), img)
    rosa = detect_markers(photo, tmp_path, "r", settings())
    assert rosa.cor == COR_ROSA and rosa.count == 3 and rosa.unidades_por_fardo == 10
    assert rosa.alertas == ()

    verde_img = shelf()
    marker(verde_img, 100, 100)
    cv2.imwrite(str(photo), verde_img)
    verde = detect_markers(photo, tmp_path, "v", settings())
    assert verde.cor == COR_VERDE and verde.count == 1 and verde.unidades_por_fardo == 5


def test_foto_com_as_duas_cores_fica_com_a_maioria_e_avisa(tmp_path: Path):
    img = shelf()
    for x, y in [(100, 100), (300, 120), (500, 90)]:
        marker(img, x, y)
    marker(img, 700, 400, color=PINK)
    photo = tmp_path / "mista.png"
    cv2.imwrite(str(photo), img)
    res = detect_markers(photo, tmp_path, "m", settings())
    assert res.cor == COR_VERDE and res.count == 3
    assert any("1 prendedor(es) rosa choque" in a for a in res.alertas)
