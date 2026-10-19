"""
Detecção e contagem dos marcadores (prendedores) com OpenCV — sem nenhuma dependência do Telegram.

Padronização de 2026-10-15: prendedor VERDE = fardo de 5 unidades, ROSA CHOQUE = fardo de 10.
Cada foto tem uma cor só: as duas cores são procuradas e vale a que aparece; se aparecerem as
duas, a contagem sai com alerta para conferir.

Pipeline: redimensiona → HSV → máscara da cor do marcador → morfologia → contornos →
separa marcadores que o fechamento uniu → agrupa pedaços do mesmo marcador → filtros de
área/forma → ordena → anota.
Cada marcador válido conta como 1 pacote.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median

import cv2
import numpy as np

from app.config import DetectorSettings

# Aparência da anotação (não influencia a contagem).
_CIRCLE_COLOR = (255, 0, 255)  # magenta (BGR): cor oposta ao verde, contrasta com o marcador e o papelão
_CIRCLE_COLOR_ROSA = (0, 255, 0)  # verde (BGR): oposto do rosa, para o círculo não sumir no prendedor
_ALERT_COLOR = (0, 215, 255)  # amarelo (BGR): marcador contado, mas que o operador deve conferir
_OUTLINE_COLOR = (0, 0, 0)  # contorno preto: garante leitura sobre fundos claros
_LABEL_TEXT_COLOR = (255, 0, 255)
_JPEG_QUALITY = 90


COR_VERDE = "verde"
COR_ROSA = "rosa"
# Unidades por fardo de cada cor de prendedor (padrão da empresa, não é configuração).
UNIDADES_POR_COR = {COR_VERDE: 5, COR_ROSA: 10}
NOME_COR = {COR_VERDE: "verde", COR_ROSA: "rosa choque"}


def settings_da_cor(settings: DetectorSettings, cor: str) -> DetectorSettings:
    """Mesmos parâmetros de forma/área, com a faixa de cor do prendedor pedido."""
    if cor == COR_VERDE:
        return settings
    return settings.model_copy(
        update={
            "MARKER_HUE_MIN": settings.ROSA_HUE_MIN,
            "MARKER_HUE_MAX": settings.ROSA_HUE_MAX,
            "MARKER_SATURATION_MIN": settings.ROSA_SATURATION_MIN,
            "MARKER_VALUE_MIN": settings.ROSA_VALUE_MIN,
        }
    )


@dataclass(frozen=True)
class Detection:
    """Um marcador encontrado. Coordenadas na imagem processada (a mesma da anotação)."""

    number: int
    center_x: int
    center_y: int
    radius: int
    area: float
    bbox: tuple[int, int, int, int]  # x, y, largura, altura
    aspect_ratio: float
    # Motivo para o operador conferir este marcador (None = contagem segura): ver ALERTA_*.
    alerta: str | None = None


ALERTA_PEQUENO = "pequeno"  # parcialmente coberto (plástico) ou de outra prateleira, ao fundo
ALERTA_SEPARADO = "separado"  # veio de dois prendedores encostados que a máscara tinha unido


@dataclass(frozen=True)
class Candidate:
    """Região da cor do marcador (já agrupada) e a decisão do filtro — base da calibração."""

    bbox: tuple[int, int, int, int]
    area: float
    aspect_ratio: float
    rejection: str | None  # None = aceita como marcador


@dataclass(frozen=True)
class Analysis:
    """Resultado em memória: usado pela contagem, pela CLI e pela calibração."""

    image: np.ndarray  # imagem já redimensionada para processamento
    mask: np.ndarray  # máscara da cor do marcador após a morfologia
    detections: list[Detection]
    candidates: list[Candidate]
    scale: float  # tamanho processado / tamanho original
    area_scale: float  # fator aplicado a MIN/MAX_MARKER_AREA nesta imagem
    merge_gap: float  # distância (px) usada para juntar pedaços nesta imagem
    min_area: float = 0.0  # área mínima efetiva nesta imagem (absoluta ou relativa à típica)

    @property
    def alertas(self) -> list[str]:
        """Resumo para o operador: o que conferir na imagem antes de confirmar a contagem."""
        pequenos = sum(1 for d in self.detections if d.alerta == ALERTA_PEQUENO)
        separados = sum(1 for d in self.detections if d.alerta == ALERTA_SEPARADO)
        avisos = []
        if pequenos:
            avisos.append(f"{pequenos} marcador(es) pequeno(s): parcialmente coberto(s) ou de outra prateleira ao fundo")
        if separados:
            avisos.append(f"{separados} marcador(es) que estavam encostados em outro e foram separados")
        return avisos


@dataclass(frozen=True)
class DetectionResult:
    image_id: str
    detections: list[Detection]
    annotated_image_path: Path
    alertas: tuple[str, ...] = ()
    cor: str = COR_VERDE

    @property
    def unidades_por_fardo(self) -> int:
        return UNIDADES_POR_COR[self.cor]

    @property
    def count(self) -> int:
        # Derivado das detecções: a quantidade informada é sempre a de marcadores numerados.
        return len(self.detections)


@dataclass
class _Region:
    points: np.ndarray
    area: float
    bbox: tuple[int, int, int, int]
    separada: bool = False  # veio de split_joined_markers


def load_image(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Arquivo não é uma imagem legível: {path}")
    return image


def resize_for_processing(image: np.ndarray, max_width: int) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    if width <= max_width:
        return image, 1.0
    scale = max_width / width
    resized = cv2.resize(image, (max_width, round(height * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def _odd_kernel(size: int) -> np.ndarray:
    size = size if size % 2 == 1 else size + 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def build_opened_mask(image: np.ndarray, settings: DetectorSettings) -> np.ndarray:
    """Máscara da cor do marcador só com o OPEN (sem ruído, mas sem fechar falhas)."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    lower = np.array([settings.MARKER_HUE_MIN, settings.MARKER_SATURATION_MIN, settings.MARKER_VALUE_MIN])
    upper = np.array([settings.MARKER_HUE_MAX, settings.MARKER_SATURATION_MAX, settings.MARKER_VALUE_MAX])
    mask = cv2.inRange(hsv, lower, upper)
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, _odd_kernel(settings.MORPH_KERNEL_SIZE))


def close_mask(opened: np.ndarray, settings: DetectorSettings) -> np.ndarray:
    return cv2.morphologyEx(opened, cv2.MORPH_CLOSE, _odd_kernel(settings.MORPH_CLOSE_KERNEL_SIZE))


def build_marker_mask(image: np.ndarray, settings: DetectorSettings) -> np.ndarray:
    return close_mask(build_opened_mask(image, settings), settings)


def _regions_from_mask(mask: np.ndarray) -> list[_Region]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [
        _Region(points=c.reshape(-1, 2), area=float(cv2.contourArea(c)), bbox=cv2.boundingRect(c))
        for c in contours
    ]


def _bbox_gap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    dx = max(0, max(ax, bx) - min(ax + aw, bx + bw))
    dy = max(0, max(ay, by) - min(ay + ah, by + bh))
    return math.hypot(dx, dy)


def merge_nearby_regions(regions: list[_Region], max_gap: float, whole_area: float | None = None) -> list[_Region]:
    """
    Une regiões cujas bordas estão a até `max_gap` px (união transitiva). Com `whole_area`,
    um grupo nunca reúne dois marcadores inteiros (área >= whole_area): só pedaços se juntam
    entre si ou a um marcador — dois prendedores encostados continuam sendo dois.
    """
    parent = list(range(len(regions)))
    wholes = [1 if whole_area is not None and r.area >= whole_area else 0 for r in regions]

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(regions)):
        for j in range(i + 1, len(regions)):
            if _bbox_gap(regions[i].bbox, regions[j].bbox) > max_gap:
                continue
            ri, rj = find(i), find(j)
            if ri == rj or wholes[ri] + wholes[rj] > 1:
                continue
            parent[ri] = rj
            wholes[rj] += wholes[ri]

    groups: dict[int, list[_Region]] = {}
    for i, region in enumerate(regions):
        groups.setdefault(find(i), []).append(region)

    merged = []
    for members in groups.values():
        points = np.vstack([m.points for m in members])
        merged.append(
            _Region(
                points=points,
                area=sum(m.area for m in members),
                bbox=cv2.boundingRect(points),
                separada=any(m.separada for m in members),
            )
        )
    return merged


def _aspect_ratio(points: np.ndarray) -> float:
    (_, _), (w, h), _ = cv2.minAreaRect(points.astype(np.float32))
    short, long = sorted((w, h))
    return long / short if short > 0 else math.inf


def split_joined_markers(
    region: _Region, opened: np.ndarray, whole_area: float
) -> list[_Region]:
    """
    Separa uma região que o MORPH_CLOSE formou unindo marcadores inteiros (prendedores
    encostados, em "H"): se dentro dela a máscara só com OPEN tem 2+ componentes do tamanho
    de um marcador inteiro, cada pixel da região vai para o componente mais próximo.
    """
    x, y, w, h = region.bbox
    local = np.zeros((h, w), np.uint8)
    cv2.fillPoly(local, [(region.points - (x, y)).reshape(-1, 1, 2).astype(np.int32)], 255)
    inner = cv2.bitwise_and(opened[y : y + h, x : x + w], local)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(inner)
    seeds = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= whole_area]
    if len(seeds) < 2:
        return [region]
    distances = np.stack([cv2.distanceTransform(np.uint8(labels != i) * 255, cv2.DIST_L2, 3) for i in seeds])
    owner = np.argmin(distances, axis=0)
    parts = []
    for k in range(len(seeds)):
        part = np.uint8((owner == k) & (local > 0)) * 255
        contours, _ = cv2.findContours(part, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        points = max(contours, key=cv2.contourArea).reshape(-1, 2) + (x, y)
        parts.append(
            _Region(points=points, area=float(cv2.countNonZero(part)), bbox=cv2.boundingRect(points), separada=True)
        )
    return parts or [region]


def effective_min_area(settings: DetectorSettings, area_scale: float, typical_area: float | None) -> float:
    """MIN_MARKER_AREA, ou menos quando a foto mostra que o marcador típico é maior (ver config)."""
    absolute = settings.MIN_MARKER_AREA * area_scale
    if typical_area is None:
        return absolute
    relative = max(settings.MARKER_NOISE_AREA * area_scale, settings.MIN_MARKER_AREA_RATIO * typical_area)
    return min(absolute, relative)


def _rejection_reason(
    area: float, aspect: float, settings: DetectorSettings, area_scale: float, min_area: float | None = None
) -> str | None:
    if area < (settings.MIN_MARKER_AREA * area_scale if min_area is None else min_area):
        return "area_pequena"
    if area > settings.MAX_MARKER_AREA * area_scale:
        return "area_grande"
    if not settings.MIN_ASPECT_RATIO <= aspect <= settings.MAX_ASPECT_RATIO:
        return "forma"
    return None


def typical_marker_diameter(
    regions: list[_Region], settings: DetectorSettings, area_scale: float
) -> float | None:
    """Diâmetro equivalente mediano das regiões com área de marcador (ignora ruído e manchas)."""
    areas = [
        r.area
        for r in regions
        if settings.MIN_MARKER_AREA * area_scale <= r.area <= settings.MAX_MARKER_AREA * area_scale
    ]
    if not areas:
        return None
    return 2 * math.sqrt(median(areas) / math.pi)


def order_detections(detections: list[Detection], row_tolerance_ratio: float) -> list[Detection]:
    """Numera de cima para baixo e, na mesma linha, da esquerda para a direita."""
    if not detections:
        return []
    tolerance = row_tolerance_ratio * median(d.bbox[3] for d in detections)
    rows: list[list[Detection]] = []
    for det in sorted(detections, key=lambda d: d.center_y):
        if rows and det.center_y - rows[-1][0].center_y <= tolerance:
            rows[-1].append(det)
        else:
            rows.append([det])
    ordered = [det for row in rows for det in sorted(row, key=lambda d: d.center_x)]
    return [
        Detection(i, d.center_x, d.center_y, d.radius, d.area, d.bbox, d.aspect_ratio, d.alerta)
        for i, d in enumerate(ordered, start=1)
    ]


def analyze(image: np.ndarray, settings: DetectorSettings) -> Analysis:
    processed, scale = resize_for_processing(image, settings.MAX_PROCESSING_WIDTH)
    # Área e distância são definidas para a largura MAX_PROCESSING_WIDTH; imagens
    # menores (não ampliadas) usam limites proporcionais.
    linear_scale = processed.shape[1] / settings.MAX_PROCESSING_WIDTH
    area_scale = linear_scale**2
    opened = build_opened_mask(processed, settings)
    mask = close_mask(opened, settings)
    raw_regions = _regions_from_mask(mask)
    typical = typical_marker_diameter(raw_regions, settings, area_scale)
    typical_area = math.pi * (typical / 2) ** 2 if typical else None
    whole_area = settings.WHOLE_MARKER_AREA_RATIO * typical_area if typical_area else None
    if whole_area:
        raw_regions = [part for r in raw_regions for part in split_joined_markers(r, opened, whole_area)]
    merge_gap = max(
        settings.MERGE_DISTANCE * linear_scale,
        settings.MERGE_DISTANCE_RATIO * typical if typical else 0.0,
    )
    regions = merge_nearby_regions(raw_regions, merge_gap, whole_area)
    min_area = effective_min_area(settings, area_scale, typical_area)

    detections = []
    candidates = []
    for region in regions:
        aspect = _aspect_ratio(region.points)
        rejection = _rejection_reason(region.area, aspect, settings, area_scale, min_area)
        candidates.append(Candidate(region.bbox, region.area, round(aspect, 2), rejection))
        if rejection:
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(region.points.astype(np.float32))
        alerta = None
        if typical_area and region.area < settings.ALERTA_AREA_RATIO * typical_area:
            alerta = ALERTA_PEQUENO
        elif region.separada:
            alerta = ALERTA_SEPARADO
        detections.append(
            Detection(0, round(cx), round(cy), max(1, round(radius)), region.area, region.bbox, round(aspect, 2), alerta)
        )
    ordered = order_detections(detections, settings.ROW_TOLERANCE_RATIO)
    return Analysis(processed, mask, ordered, candidates, scale, area_scale, merge_gap, min_area)


def annotate(image: np.ndarray, detections: list[Detection], cor: str = COR_VERDE) -> np.ndarray:
    """Circula e numera cada marcador; traços e fonte acompanham o tamanho da imagem."""
    out = image.copy()
    width = out.shape[1]
    thickness = max(2, round(width / 500))
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.6, width / 1600)
    radii = [det.radius + max(6, round(det.radius * 0.25)) for det in detections]
    for det, radius in zip(detections, radii):
        center = (det.center_x, det.center_y)
        cv2.circle(out, center, radius, _OUTLINE_COLOR, thickness + 2, cv2.LINE_AA)
        circulo = _CIRCLE_COLOR_ROSA if cor == COR_ROSA else _CIRCLE_COLOR
        cv2.circle(out, center, radius, _ALERT_COLOR if det.alerta else circulo, thickness, cv2.LINE_AA)
    # Números depois de todos os círculos, cada um num canto livre: marcadores encostados
    # não podem ter um número escondendo o outro.
    taken: list[tuple[int, int, int, int]] = []
    for det, radius in zip(detections, radii):
        taken.append(
            _draw_label(
                out, str(det.number), (det.center_x, det.center_y), radius, font, font_scale, thickness, taken,
                _ALERT_COLOR if det.alerta else (_CIRCLE_COLOR_ROSA if cor == COR_ROSA else _LABEL_TEXT_COLOR),
            )
        )
    return out


def _overlaps(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _draw_label(
    image: np.ndarray,
    text: str,
    center: tuple[int, int],
    radius: int,
    font: int,
    scale: float,
    thickness: int,
    taken: list[tuple[int, int, int, int]] = (),
    color: tuple[int, int, int] = _LABEL_TEXT_COLOR,
) -> tuple[int, int, int, int]:
    """Desenha o número num canto do círculo que não cubra outro número; devolve a caixa usada."""
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thickness)
    pad = thickness + 2
    box_w, box_h = tw + 2 * pad, th + 2 * pad + baseline
    height, width = image.shape[:2]
    offset = round(radius * 0.7)
    # Canto superior direito (padrão), depois superior esquerdo, inferior direito e inferior esquerdo.
    corners = [(offset, -offset), (-offset - box_w, -offset), (offset, offset + box_h), (-offset - box_w, offset + box_h)]
    boxes = []
    for dx, dy in corners:
        x = min(max(0, center[0] + dx), width - box_w)
        y = min(max(th + 2 * pad, center[1] + dy), height - baseline - pad)
        boxes.append((x, y - th - 2 * pad, x + box_w, y + baseline))
    box = next((b for b in boxes if not any(_overlaps(b, t) for t in taken)), boxes[0])
    x0, y0, x1, y1 = box
    cv2.rectangle(image, (x0, y0), (x1, y1), _OUTLINE_COLOR, cv2.FILLED)
    cv2.putText(image, text, (x0 + pad, y1 - baseline - pad), font, scale, color, thickness, cv2.LINE_AA)
    return box


def save_jpeg(image: np.ndarray, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY]):
        raise OSError(f"Não foi possível gravar a imagem em {path}")
    return path


def detect_markers(
    image_path: Path, output_dir: Path, image_id: str, settings: DetectorSettings
) -> DetectionResult:
    """Ponto de entrada usado pelo bot e pela CLI: conta e grava a imagem anotada."""
    return detect_in_image(load_image(image_path), output_dir, image_id, settings)


def detect_in_image(image: np.ndarray, output_dir: Path, image_id: str, settings: DetectorSettings) -> DetectionResult:
    """Como `detect_markers`, para uma imagem já carregada (o bot também lê o código de barras nela)."""
    cor, analysis, alertas = analyze_cores(image, settings)
    annotated_path = save_jpeg(annotate(analysis.image, analysis.detections, cor), output_dir / f"{image_id}_processada.jpg")
    return DetectionResult(
        image_id=image_id,
        detections=analysis.detections,
        annotated_image_path=annotated_path,
        alertas=tuple(alertas),
        cor=cor,
    )


def analyze_cores(image: np.ndarray, settings: DetectorSettings) -> tuple[str, Analysis, list[str]]:
    """
    Conta os prendedores verdes e os rosa e fica com a cor que tem mais (empate ou nada: verde).
    A foto deveria ter uma cor só: se a outra também aparece, vira alerta para o operador conferir.
    """
    analises = {cor: analyze(image, settings_da_cor(settings, cor)) for cor in (COR_VERDE, COR_ROSA)}
    cor = COR_ROSA if len(analises[COR_ROSA].detections) > len(analises[COR_VERDE].detections) else COR_VERDE
    outra = COR_VERDE if cor == COR_ROSA else COR_ROSA
    alertas = list(analises[cor].alertas)
    if analises[outra].detections:
        alertas.append(
            f"também apareceram {len(analises[outra].detections)} prendedor(es) {NOME_COR[outra]} na foto: "
            f"a contagem considerou só os {NOME_COR[cor]} ({UNIDADES_POR_COR[cor]} un. por fardo)"
        )
    return cor, analises[cor], alertas
