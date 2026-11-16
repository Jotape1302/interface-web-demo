"""
Geração gráfica dos slides de carrossel do Instagram para a Norvia Acabamentos.

Formato: JPEG 1080x1350 (4:5), qualidade 90.
Identidade: Marinho #0f1b2d, texto branco e #D6DFEB, detalhes em âmbar #f59e0b.
Tipografia: Inter (com fallbacks para DejaVu e default Pillow escalável).
Imagens: Foto oficial do produto Norvia em 'capa' e 'produto' (nunca da matéria).
"""
from __future__ import annotations

import glob
import io
import logging
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

from app.config import DATA_DIR, PASTA_AMBIENTES_PUBLICO

logger = logging.getLogger("marketing.carrossel")

LARGURA = 1080
ALTURA = 1350

COR_FUNDO = (15, 27, 45)       # #0f1b2d (Navy Norvia)
COR_CARD = (24, 40, 63)        # #18283f
COR_AMBAR = (245, 158, 11)     # #f59e0b
COR_TEXTO_BRANCO = (255, 255, 255)
COR_TEXTO_CORPO = (214, 223, 235)  # #D6DFEB
COR_TEXTO_MUTED = (139, 155, 180)  # #8B9BB4

PASTA_CARROSSEL = DATA_DIR / "carrossel"

_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/inter/Inter-Regular.ttf",
    "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
    "/usr/share/fonts/inter/Inter-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/abattis-cantarell-fonts/Cantarell-Regular.otf",
]

_FONT_BOLD_CANDIDATES = [
    "/usr/share/fonts/truetype/inter/Inter-Bold.ttf",
    "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
    "/usr/share/fonts/inter/Inter-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/abattis-cantarell-fonts/Cantarell-Bold.otf",
]


def _obter_fonte(tamanho: int, bold: bool = False) -> ImageFont.ImageFont:
    # 1. Procura dinamicamente por fontes Inter instaladas no sistema via glob
    padroes_inter = [
        "/usr/share/fonts/**/Inter*Bold*.otf",
        "/usr/share/fonts/**/Inter*Bold*.ttf",
        "/usr/share/fonts/**/Inter-Bold*.otf",
        "/usr/share/fonts/**/Inter-Bold*.ttf",
    ] if bold else [
        "/usr/share/fonts/**/Inter*Regular*.otf",
        "/usr/share/fonts/**/Inter*Regular*.ttf",
        "/usr/share/fonts/**/Inter*.otf",
        "/usr/share/fonts/**/Inter*.ttf",
    ]
    for padrao in padroes_inter:
        for p in glob.glob(padrao, recursive=True):
            if bold and ("bold" not in p.lower()):
                continue
            try:
                return ImageFont.truetype(p, tamanho)
            except Exception:
                continue

    # 2. Fallbacks em caminhos conhecidos
    candidatos = _FONT_BOLD_CANDIDATES if bold else _FONT_CANDIDATES
    for p in candidatos:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, tamanho)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=tamanho)
    except Exception:
        return ImageFont.load_default()



def _redimensionar_cover(img: Image.Image, alvo_l: int, alvo_a: int) -> Image.Image:
    """Redimensiona e recorta a imagem para preencher exatamente o alvo (object-fit: cover)."""
    orig_l, orig_a = img.size
    ratio = max(alvo_l / orig_l, alvo_a / orig_a)
    novo_l = int(orig_l * ratio)
    novo_a = int(orig_a * ratio)
    redim = img.resize((novo_l, novo_a), Image.Resampling.LANCZOS)
    left = (novo_l - alvo_l) // 2
    top = (novo_a - alvo_a) // 2
    return redim.crop((left, top, left + alvo_l, top + alvo_a))


def _quebrar_linhas(texto: str, draw: ImageDraw.ImageDraw, fonte: ImageFont.ImageFont, max_w: int) -> List[str]:
    """Quebra palavras em linhas respeitando a largura em pixels."""
    palavras = (texto or "").split()
    if not palavras:
        return []
    linhas: List[str] = []
    linha_atual = palavras[0]
    for p in palavras[1:]:
        candidata = f"{linha_atual} {p}"
        bbox = draw.textbbox((0, 0), candidata, font=fonte)
        if (bbox[2] - bbox[0]) <= max_w:
            linha_atual = candidata
        else:
            linhas.append(linha_atual)
            linha_atual = p
    if linha_atual:
        linhas.append(linha_atual)
    return linhas


def _desenhar_bloco_texto_na_caixa(
    draw: ImageDraw.ImageDraw,
    texto: str,
    x: int,
    y: int,
    max_w: int,
    max_h: int,
    tam_fonte_inicial: int,
    tam_fonte_minimo: int,
    bold: bool,
    cor: Tuple[int, int, int],
    espacamento_linha_relativo: float = 1.3,
) -> int:
    """
    Renderiza todas as palavras do texto dentro de uma caixa delimitada (max_w, max_h).
    Reduz o tamanho da fonte até tam_fonte_minimo caso não caiba.
    Levanta ValueError se mesmo com tam_fonte_minimo as linhas não couberem na caixa,
    garantindo que NENHUMA linha ou palavra seja cortada em silêncio e nada fique abaixo de y=1240.
    Retorna a coordenada Y final após a renderização do bloco.
    """
    palavras = (texto or "").split()
    if not palavras:
        return y

    tam_atual = tam_fonte_inicial
    linhas_finais: Optional[List[str]] = None
    fonte_final: Optional[ImageFont.ImageFont] = None

    while tam_atual >= tam_fonte_minimo:
        fonte = _obter_fonte(tam_atual, bold=bold)
        linhas = _quebrar_linhas(texto, draw, fonte, max_w)
        alt_linha = int(tam_atual * espacamento_linha_relativo)
        alt_total = len(linhas) * alt_linha
        if alt_total <= max_h and (y + alt_total) <= 1240:
            linhas_finais = linhas
            fonte_final = fonte
            break
        tam_atual -= 2

    if not fonte_final or not linhas_finais:
        raise ValueError(
            f"Texto com {len(texto)} caracteres não coube na área ({max_w}x{max_h}px) "
            f"mesmo com fonte mínima {tam_fonte_minimo}px."
        )

    alt_linha = int(tam_atual * espacamento_linha_relativo)
    y_cursor = y
    for linha in linhas_finais:
        draw.text((x, y_cursor), linha, font=fonte_final, fill=cor)
        y_cursor += alt_linha

    return y_cursor


def _desenhar_cabecalho_e_rodape(draw: ImageDraw.ImageDraw, idx: int, total: int) -> None:
    # Barra superior âmbar decorativa
    draw.rectangle([(80, 50), (1000, 54)], fill=COR_AMBAR)

    # Identificador Norvia
    fonte_hdr = _obter_fonte(22, bold=True)
    draw.text((80, 75), "NORVIA / SOLUÇÕES EM ACABAMENTOS", font=fonte_hdr, fill=COR_AMBAR)

    # Contador de slide
    fonte_cnt = _obter_fonte(22, bold=False)
    texto_cnt = f"{idx}/{total}"
    bbox_cnt = draw.textbbox((0, 0), texto_cnt, font=fonte_cnt)
    w_cnt = bbox_cnt[2] - bbox_cnt[0]
    draw.text((1000 - w_cnt, 75), texto_cnt, font=fonte_cnt, fill=COR_TEXTO_MUTED)

    # Rodapé
    draw.rectangle([(80, 1260), (1000, 1262)], fill=COR_CARD)
    fonte_ftr = _obter_fonte(20, bold=False)
    draw.text((80, 1280), "norvia.example", font=fonte_ftr, fill=COR_TEXTO_MUTED)
    draw.text((680, 1280), "Centros de Distribuição SP e PR", font=fonte_ftr, fill=COR_TEXTO_MUTED)


def _renderizar_slide(
    slide: Dict[str, Any],
    idx: int,
    total: int,
    caminho_foto_produto: Optional[Path],
    produto: Dict[str, Any],
) -> Image.Image:
    img = Image.new("RGB", (LARGURA, ALTURA), COR_FUNDO)
    draw = ImageDraw.Draw(img)
    _desenhar_cabecalho_e_rodape(draw, idx, total)

    tipo = slide.get("tipo", "texto").lower()
    titulo = slide.get("titulo", "")
    texto = slide.get("texto", "")

    if tipo == "capa":
        # Badge editorial
        fonte_badge = _obter_fonte(20, bold=True)
        draw.rectangle([(80, 150), (360, 186)], fill=COR_CARD)
        draw.text((95, 158), "EDITORIAL DE ARQUITETURA", font=fonte_badge, fill=COR_AMBAR)

        # Título da capa (escalável até caber)
        y_cursor = _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=titulo,
            x=80,
            y=215,
            max_w=920,
            max_h=180,
            tam_fonte_inicial=52,
            tam_fonte_minimo=32,
            bold=True,
            cor=COR_TEXTO_BRANCO,
        )

        # Subtítulo da capa
        y_cursor = _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=texto,
            x=80,
            y=y_cursor + 15,
            max_w=920,
            max_h=160,
            tam_fonte_inicial=28,
            tam_fonte_minimo=24,
            bold=False,
            cor=COR_TEXTO_CORPO,
        )

        # Imagem do produto em cover
        box_y1 = max(y_cursor + 25, 480)
        box_y2 = 1220
        box_h = box_y2 - box_y1
        box_w = 920

        draw.rectangle([(80, box_y1), (1000, box_y2)], fill=COR_CARD)
        draw.rectangle([(78, box_y1 - 2), (1002, box_y2 + 2)], outline=COR_AMBAR, width=2)

        if caminho_foto_produto and caminho_foto_produto.exists():
            try:
                with Image.open(caminho_foto_produto) as p_img:
                    rgb_p = p_img.convert("RGB")
                    cover = _redimensionar_cover(rgb_p, box_w, box_h)
                    img.paste(cover, (80, box_y1))
            except Exception as e:
                logger.warning("Falha ao abrir imagem do produto para slide capa: %s", e)

    elif tipo == "produto":
        # Bloco superior com a foto do produto
        box_y1 = 150
        box_y2 = 660
        box_h = box_y2 - box_y1
        box_w = 920

        draw.rectangle([(80, box_y1), (1000, box_y2)], fill=COR_CARD)
        draw.rectangle([(78, box_y1 - 2), (1002, box_y2 + 2)], outline=COR_AMBAR, width=2)

        if caminho_foto_produto and caminho_foto_produto.exists():
            try:
                with Image.open(caminho_foto_produto) as p_img:
                    rgb_p = p_img.convert("RGB")
                    cover = _redimensionar_cover(rgb_p, box_w, box_h)
                    img.paste(cover, (80, box_y1))
            except Exception as e:
                logger.warning("Falha ao abrir imagem do produto para slide produto: %s", e)

        # Card inferior com especificações técnicas
        draw.rectangle([(80, 700), (1000, 1220)], fill=COR_CARD)
        draw.rectangle([(80, 700), (1000, 704)], fill=COR_AMBAR)

        fonte_chapeu = _obter_fonte(20, bold=True)
        draw.text((110, 735), "SOLUÇÃO NORVIA EM DESTAQUE", font=fonte_chapeu, fill=COR_AMBAR)

        y_cursor = _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=titulo,
            x=110,
            y=775,
            max_w=860,
            max_h=110,
            tam_fonte_inicial=40,
            tam_fonte_minimo=32,
            bold=True,
            cor=COR_TEXTO_BRANCO,
        )

        _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=texto,
            x=110,
            y=y_cursor + 15,
            max_w=860,
            max_h=max(60, 1220 - (y_cursor + 15)),
            tam_fonte_inicial=28,
            tam_fonte_minimo=24,
            bold=False,
            cor=COR_TEXTO_CORPO,
        )

    elif tipo == "cta":
        # Card centralizado de chamada para ação
        draw.rectangle([(80, 200), (1000, 1220)], fill=COR_CARD)
        draw.rectangle([(78, 198), (1002, 1222)], outline=COR_AMBAR, width=2)

        fonte_badge = _obter_fonte(22, bold=True)
        draw.text((130, 260), "ESPECIFICAÇÕES TÉCNICAS & ORÇAMENTOS", font=fonte_badge, fill=COR_AMBAR)

        y_cursor = _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=titulo,
            x=130,
            y=310,
            max_w=820,
            max_h=190,
            tam_fonte_inicial=48,
            tam_fonte_minimo=32,
            bold=True,
            cor=COR_TEXTO_BRANCO,
        )

        y_cursor = _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=texto,
            x=130,
            y=y_cursor + 25,
            max_w=820,
            max_h=max(60, 890 - (y_cursor + 25)),
            tam_fonte_inicial=30,
            tam_fonte_minimo=24,
            bold=False,
            cor=COR_TEXTO_CORPO,
        )

        # Botão retangular cantos retos #f59e0b
        btn_y1 = max(y_cursor + 40, 960)
        btn_y2 = btn_y1 + 80
        draw.rectangle([(130, btn_y1), (950, btn_y2)], fill=COR_AMBAR)

        fonte_btn = _obter_fonte(28, bold=True)
        texto_btn = "ACESSE NORVIA.COM.BR"
        bbox_btn = draw.textbbox((0, 0), texto_btn, font=fonte_btn)
        w_btn = bbox_btn[2] - bbox_btn[0]
        h_btn = bbox_btn[3] - bbox_btn[1]
        draw.text(
            (130 + (820 - w_btn) // 2, btn_y1 + (80 - h_btn) // 2),
            texto_btn,
            font=fonte_btn,
            fill=COR_FUNDO,
        )

    else:
        # Slide de texto / narrativa do projeto e desafio
        draw.rectangle([(80, 180), (1000, 1220)], fill=COR_CARD)
        draw.rectangle([(80, 180), (1000, 186)], fill=COR_AMBAR)

        fonte_badge = _obter_fonte(22, bold=True)
        badge_txt = "PROJETO & DESAFIO CONSTRUTIVO" if idx <= 3 else "DETALHAMENTO TÉCNICO"
        draw.text((130, 240), badge_txt, font=fonte_badge, fill=COR_AMBAR)

        y_cursor = _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=titulo,
            x=130,
            y=290,
            max_w=820,
            max_h=190,
            tam_fonte_inicial=48,
            tam_fonte_minimo=32,
            bold=True,
            cor=COR_TEXTO_BRANCO,
        )

        draw.rectangle([(130, y_cursor + 20), (250, y_cursor + 23)], fill=COR_AMBAR)

        _desenhar_bloco_texto_na_caixa(
            draw=draw,
            texto=texto,
            x=130,
            y=y_cursor + 40,
            max_w=820,
            max_h=max(60, 1220 - (y_cursor + 40)),
            tam_fonte_inicial=34,
            tam_fonte_minimo=24,
            bold=False,
            cor=COR_TEXTO_CORPO,
        )

    return img


def gerar_slides_carrossel(
    rascunho_id: str,
    carrossel: List[Dict[str, Any]],
    produto: Dict[str, Any],
    imagem_id: Optional[str] = None,
) -> List[Path]:
    """
    Gera todos os slides JPEG 1080x1350 na pasta DATA_DIR/carrossel/<rascunho_id>/slide-01.jpg...
    com escrita atômica via tempfile + os.replace e permissões 0644.
    """
    if not re.match(r"^[A-Za-z0-9-]{1,64}$", rascunho_id):
        raise ValueError(f"ID de rascunho inválido para carrossel: '{rascunho_id}'")

    from app.ambientes.gerenciador import obter_caminho_imagem, obter_registro_imagem

    slug = produto.get("slug") or "produto"
    caminho_foto: Optional[Path] = None
    if imagem_id:
        reg = obter_registro_imagem(imagem_id)
        if not reg or reg.get("status") != "aprovada":
            raise ValueError(f"Imagem '{imagem_id}' do carrossel não está aprovada.")
        cand_4x5 = PASTA_AMBIENTES_PUBLICO / slug / f"{imagem_id}_4x5.jpg"
        if cand_4x5.exists():
            caminho_foto = cand_4x5
        else:
            cand_data = obter_caminho_imagem(f"{imagem_id}_4x5")
            if cand_data and cand_data.exists():
                caminho_foto = cand_data
    else:
        pasta_amb = PASTA_AMBIENTES_PUBLICO / slug
        if pasta_amb.exists():
            aprovadas_4x5 = sorted(list(pasta_amb.glob("*_4x5.jpg")))
            if aprovadas_4x5:
                caminho_foto = aprovadas_4x5[0]

    if not caminho_foto or not caminho_foto.exists():
        raise ValueError(f"Nenhuma imagem de ambiente 4:5 aprovada disponível para '{slug}'.")

    pasta_destino = PASTA_CARROSSEL / rascunho_id
    pasta_destino.mkdir(parents=True, exist_ok=True)

    # Limpa imagens antigas antes de regerar
    for arq in pasta_destino.glob("slide-*.jpg"):
        try:
            arq.unlink()
        except OSError as err:
            logger.debug("Falha ao remover slide antigo %s: %s", arq, err)

    total = len(carrossel)
    arquivos_gerados: List[Path] = []

    for i, slide in enumerate(carrossel):
        num = i + 1
        img = _renderizar_slide(slide, num, total, caminho_foto, produto)
        nome_arquivo = f"slide-{num:02d}.jpg"
        destino_final = pasta_destino / nome_arquivo

        # Gravação atômica via tempfile
        fd, tmp_caminho = tempfile.mkstemp(dir=pasta_destino, prefix="tmp_slide_", suffix=".jpg")
        os.close(fd)
        try:
            img.save(tmp_caminho, format="JPEG", quality=90, optimize=True)
            os.chmod(tmp_caminho, 0o644)
            os.replace(tmp_caminho, destino_final)
            arquivos_gerados.append(destino_final)
        finally:
            if os.path.exists(tmp_caminho):
                try:
                    os.unlink(tmp_caminho)
                except OSError as err:
                    logger.debug("Falha ao limpar temporário %s: %s", tmp_caminho, err)

    return arquivos_gerados


def obter_caminho_slide(rascunho_id: str, n: int) -> Optional[Path]:
    """Resolve e valida o caminho seguro do slide para evitar path traversal."""
    if not re.match(r"^[A-Za-z0-9-]{1,64}$", rascunho_id):
        return None
    if n < 1 or n > 20:
        return None
    caminho = (PASTA_CARROSSEL / rascunho_id / f"slide-{n:02d}.jpg").resolve()
    try:
        if not caminho.is_relative_to(PASTA_CARROSSEL.resolve()):
            return None
    except AttributeError:
        # Python < 3.9 fallback
        if str(PASTA_CARROSSEL.resolve()) not in str(caminho):
            return None
    if caminho.exists() and caminho.is_file():
        return caminho
    return None


def gerar_zip_carrossel(rascunho_id: str, legenda: str = "") -> Optional[bytes]:
    """Compacta todos os slides gerados e a legenda em um arquivo ZIP em memória."""
    if not re.match(r"^[A-Za-z0-9-]{1,64}$", rascunho_id):
        return None
    pasta = (PASTA_CARROSSEL / rascunho_id).resolve()
    if not pasta.exists() or not pasta.is_dir():
        return None

    slides = sorted(list(pasta.glob("slide-*.jpg")))
    if not slides:
        return None

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for s in slides:
            zf.write(s, arcname=s.name)
        if legenda:
            zf.writestr("legenda.txt", legenda.strip())

    buffer.seek(0)
    return buffer.getvalue()
