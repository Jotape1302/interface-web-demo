"""
Etiqueta de produto em EPL2 (PPLB), a linguagem que a Elgin L42-DT da Produção entende de fábrica.
Ela recebe ZPL sem erro, mas imprime tudo em branco; em EPL sai texto, Code 128 e EAN-13 (teste de
campo com o driver "4BARCODE 4B-2074B", envio RAW).

Mesmo layout do gerar_zpl (app/etiquetas_zpl.py) e da prévia da interface:

    ┌──────────────────────────────────────────┐
    │ Nome do produto (até 4 linhas)           │
    │ Localização          ║║║ EAN-13 ║║║      │
    │ SKU                  7 908737 101294     │
    │ ║║║║║║║║║ Code 128 do SKU ║║║║║║║║║║║║║  │
    └──────────────────────────────────────────┘

Diferenças do EPL: não há caixa de texto com quebra automática (^FB do ZPL), então a quebra por
palavras é feita aqui, com as fontes residentes de largura fixa; e o texto vai em Windows-1252
(`I8,A,055`), por isso o comando deve ser codificado com CODIFICACAO_EPL antes de ir à impressora.
"""
from typing import Any, Dict, List, Tuple

from app.etiqueta_comum import dots, ean13, limitar_copias, modulos_code128, sem_acentos, sku_cabe_no_code128

CODIFICACAO_EPL = "cp1252"

# Fontes residentes do EPL2 (manual, comando A), em pontos: (avanço por caractere, altura).
# Matriz a 203 dpi: 1=8x12, 2=10x16, 3=12x20, 4=14x24, 5=32x48; a 300 dpi: 1=12x20, 2=16x28,
# 3=20x36, 4=24x44, 5=48x80. O avanço soma os 2 pontos de espaço entre caracteres, para a
# quebra de linha nunca passar da largura.
FONTES_EPL = {
    203: {1: (10, 12), 2: (12, 16), 3: (14, 20), 4: (16, 24), 5: (34, 48)},
    300: {1: (14, 20), 2: (18, 28), 3: (22, 36), 4: (26, 44), 5: (50, 80)},
}
ENTRELINHA = 2  # pontos entre linhas de texto
RETICENCIAS = "..."


def escapar(texto: str) -> str:
    """Texto seguro entre aspas no EPL: `\\` → `\\\\` e `"` → `\\"`; quebras de linha viram espaço."""
    texto = " ".join(texto.replace("\r", " ").replace("\n", " ").split())
    return texto.replace("\\", "\\\\").replace('"', '\\"')


def quebrar_linhas(texto: str, max_chars: int, max_linhas: int) -> List[str]:
    """
    Quebra por palavras em linhas de até `max_chars` (fonte de largura fixa). Palavra maior que a
    linha é cortada. Se não couber em `max_linhas`, a última linha termina com reticências.
    """
    max_chars = max(1, max_chars)
    linhas: List[str] = []
    atual = ""
    for palavra in texto.split():
        while len(palavra) > max_chars:
            if atual:
                linhas.append(atual)
                atual = ""
            linhas.append(palavra[:max_chars])
            palavra = palavra[max_chars:]
        if not atual:
            atual = palavra
        elif len(atual) + 1 + len(palavra) <= max_chars:
            atual = f"{atual} {palavra}"
        else:
            linhas.append(atual)
            atual = palavra
    if atual:
        linhas.append(atual)
    if len(linhas) <= max_linhas:
        return linhas
    corte = linhas[: max_linhas]
    ultima = corte[-1]
    if len(ultima) + len(RETICENCIAS) > max_chars:
        ultima = ultima[: max(0, max_chars - len(RETICENCIAS))].rstrip()
    corte[-1] = f"{ultima}{RETICENCIAS}"
    return corte


def _escolher_fonte_nome(descricao: str, util: int, dpi: int) -> Tuple[int, int, int, List[str]]:
    """
    Escolhe a melhor fonte residente do nome para aproveitar o espaço sem truncar a descrição.
    Tenta a fonte 3 primeiro (~32 caracteres/linha a 203 dpi, matriz 14x20).
    Se não couber em 4 linhas sem reticências, tenta a fonte 2 (~37 caracteres/linha a 203 dpi, matriz 12x16).
    Se nem na fonte 2 couber, usa a fonte 2 e corta a 4ª linha com reticências.
    """
    fontes = FONTES_EPL[dpi]
    for num in (3, 2):
        larg, alt = fontes[num]
        max_chars = max(1, util // larg)
        linhas = quebrar_linhas(descricao, max_chars, 4)
        if not any(l.endswith(RETICENCIAS) for l in linhas):
            return num, larg, alt, linhas
    larg, alt = fontes[2]
    return 2, larg, alt, quebrar_linhas(descricao, max(1, util // larg), 4)


def _fonte_para(altura_alvo: int, dpi: int) -> Tuple[int, int, int]:
    """Maior fonte residente cuja altura não passa do alvo (mínimo a fonte 1): (número, largura, altura)."""
    fontes = FONTES_EPL[dpi]
    escolhida = 1
    for numero, (_, alt) in sorted(fontes.items()):
        if numero != 5 and alt <= altura_alvo:
            escolhida = numero
    largura, altura = fontes[escolhida]
    return escolhida, largura, altura


def _texto(x: int, y: int, fonte: int, conteudo: str) -> str:
    return f'A{x},{y},0,{fonte},1,1,N,"{escapar(conteudo)}"'


def gerar_epl(
    produto: Dict[str, Any],
    copias: int = 1,
    dpi: int = 203,
    largura_mm: float = 60,
    altura_mm: float = 40,
    remover_acentos: bool = False,
    densidade: int = 10,
    gap_dots: int = 24,
) -> str:
    if dpi not in (203, 300):
        raise ValueError("dpi deve ser 203 ou 300.")
    if not 0 <= int(densidade) <= 15:
        raise ValueError("densidade deve ficar entre 0 e 15.")
    copias = limitar_copias(copias)
    dpmm = dpi / 25.4
    W, H = dots(largura_mm, dpmm), dots(altura_mm, dpmm)
    k = min(largura_mm / 60, altura_mm / 40)  # layout desenhado para 60 x 40 mm (igual ao ZPL)
    mx, my = dots(2.0 * k, dpmm), dots(1.6 * k, dpmm)
    util = W - 2 * mx

    descricao = (produto.get("descricao") or "").strip()
    sku = (produto.get("sku") or "").strip()
    localizacao = (produto.get("localizacao") or "").strip() or "-"
    if remover_acentos:
        descricao, localizacao = sem_acentos(descricao), sem_acentos(localizacao)
    ean = ean13(produto)
    tem_code128 = sku_cabe_no_code128(sku)

    linhas = [
        "",  # linha vazia: descarta qualquer comando incompleto que tenha ficado no buffer
        "N",
        "I8,A,055",  # 8 bits, Windows-1252 (Latin 1), Brasil
        f"q{W}",
        f"Q{H},{int(gap_dots)}",
        f"D{int(densidade)}",
    ]

    # Nome: até 4 linhas no topo com escolha dinâmica de fonte para evitar truncar a descrição.
    fonte_nome, larg_nome, alt_nome, linhas_nome = _escolher_fonte_nome(descricao, util, dpi)
    for i, linha in enumerate(linhas_nome):
        linhas.append(_texto(mx, my + i * (alt_nome + ENTRELINHA), fonte_nome, linha))

    # Code 128 do SKU na base, largura toda (módulo inteiro em pontos, o maior que couber).
    altura_c128 = dots(max(4.5, 7 * k), dpmm)
    y_c128 = H - my - altura_c128
    if tem_code128:
        modulos = modulos_code128(sku) + 20  # + zona de silêncio (10 de cada lado)
        modulo = max(1, min(4, util // modulos))
        x_c128 = mx + max(0, (util - modulos * modulo) // 2) + 10 * modulo
        # Tipo 1 = Code 128 automático (A/B/C); a barra larga é ignorada no Code 128.
        linhas.append(f'B{x_c128},{y_c128},0,1,{modulo},{modulo * 3},{altura_c128},N,"{escapar(sku)}"')

    # Faixa do meio: EAN-13 à direita (com barras altas de ~10mm e dígitos embaixo) e localização + SKU à esquerda.
    fonte_meio, larg_meio, alt_meio = _fonte_para(dots(2.1 * k, dpmm), dpi)
    altura_ean = dots(10.0 * k, dpmm)
    alt_digitos_ean = dots(2.8 * k, dpmm)
    respiro_c128 = dots(1.5 * k, dpmm)
    y_meio = y_c128 - respiro_c128 - altura_ean - alt_digitos_ean
    largura_ean = 0
    if ean:
        modulo_ean = max(1, min(3, dots(27 * k, dpmm) // 102))
        largura_ean = 102 * modulo_ean  # 95 módulos + o 1º dígito à esquerda
        recuo_seguranca = dots(1.0 * k, dpmm)  # margem extra à direita para evitar corte mecânico
        x_ean = W - mx - largura_ean + 7 * modulo_ean - recuo_seguranca
        linhas.append(f'B{x_ean},{y_meio},0,E30,{modulo_ean},{modulo_ean},{altura_ean},B,"{ean[:12]}"')
    largura_texto = util - (largura_ean + dots(1.2 * k, dpmm) if ean else 0)
    max_meio = max(1, largura_texto // larg_meio)
    # Até 3 linhas, como no ZPL; o SKU tem prioridade (até 2), a localização fica com o resto.
    linhas_sku = quebrar_linhas(sku or "SEM SKU", max_meio, 2)
    linhas_loc = quebrar_linhas(localizacao, max_meio, 3 - len(linhas_sku))
    for i, linha in enumerate(linhas_loc + linhas_sku):
        linhas.append(_texto(mx, y_meio + i * (alt_meio + ENTRELINHA), fonte_meio, linha))

    linhas.append(f"P{copias}")
    return "\r\n".join(linhas) + "\r\n"


def codificar_epl(comando: str) -> bytes:
    """Bytes para a impressora: Windows-1252 (o que o I8,A,055 declara); fora dele vira '?'."""
    return comando.encode(CODIFICACAO_EPL, errors="replace")
