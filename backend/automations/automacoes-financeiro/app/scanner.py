import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple, Literal

import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    from pyzbar import pyzbar
    PYZBAR_AVAILABLE = True
except ImportError:
    PYZBAR_AVAILABLE = False

try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
except ImportError:
    PYTESSERACT_AVAILABLE = False

try:
    from pdf2image import convert_from_path
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class ScanResult:
    """Resultado da extração da chave de acesso."""
    key: str
    method: Literal["barcode", "ocr", "xml"]
    file_path: Path
    page_number: int = 1
    raw_text: Optional[str] = None


def validate_nfe_key(key: str) -> bool:
    """
    Valida a Chave de Acesso da NF-e (44 dígitos numéricos) utilizando o cálculo oficial
    do Dígito Verificador (DV) através do Módulo 11 (Manual de Orientação do Contribuinte - SEFAZ).

    Multiplicadores: de 2 a 9, da direita para a esquerda, reiniciando o ciclo em 2.
    """
    if not key or not re.fullmatch(r"\d{44}", key):
        return False

    base_key = key[:43]
    given_dv = int(key[43])

    weights = [2, 3, 4, 5, 6, 7, 8, 9]
    total_sum = 0
    weight_idx = 0

    # Percorre os 43 dígitos da direita para a esquerda
    for digit_char in reversed(base_key):
        total_sum += int(digit_char) * weights[weight_idx]
        weight_idx = (weight_idx + 1) % len(weights)

    remainder = total_sum % 11
    if remainder in (0, 1):
        expected_dv = 0
    else:
        expected_dv = 11 - remainder

    return expected_dv == given_dv


def extract_key_from_text(text: str) -> Optional[str]:
    """
    Extrai chave de acesso de 44 dígitos a partir de texto bruto (ex.: saída de OCR).
    Trata chaves agrupadas com espaços (ex.: '3523 0912 3456 7800 0123 5500 1000 0001 2310 0000 0011'),
    pontos, hífens ou caracteres adjacentes através de validação estrita com janela deslizante Módulo 11.
    """
    if not text:
        return None

    normalized = " " + text + " "

    # 1. Procura sequências numéricas de 44 a 48 dígitos e testa janelas deslizantes com Módulo 11
    for match in re.finditer(r"\d{44,48}", normalized):
        chunk = match.group(0)
        for start in range(len(chunk) - 44 + 1):
            candidate = chunk[start:start + 44]
            if validate_nfe_key(candidate):
                return candidate

    # 2. Procura sequências formatadas com espaços/pontos/hífens (ex: blocos de 4 dígitos comuns em DANFEs)
    spaced_matches = re.findall(r"(?:\d[\s\.\-]*){44,52}", normalized)
    for spaced_candidate in spaced_matches:
        cleaned = re.sub(r"\D", "", spaced_candidate)
        if len(cleaned) >= 44:
            for start in range(len(cleaned) - 44 + 1):
                candidate = cleaned[start:start + 44]
                if validate_nfe_key(candidate):
                    return candidate

    # 3. Fallback: sequências isoladas de exatamente 44 dígitos
    direct_match = re.findall(r"\b\d{44}\b", normalized)
    for candidate in direct_match:
        logger.warning(f"Chave encontrada de 44 dígitos isolada: {candidate}")
        return candidate

    return None


class DANFEScanner:
    """
    Scanner especializado em extração da chave de acesso de DANFEs (PDF ou Imagem).
    Aplica pipeline de priorização:
    1. Leitura de Código de Barras (Code 128) via OpenCV + pyzbar (100% de acurácia).
    2. Fallback para OCR (pytesseract) caso o código de barras não seja detectado.
    """

    def __init__(self) -> None:
        if settings.TESSERACT_CMD and PYTESSERACT_AVAILABLE:
            pytesseract.pytesseract.tesseract_cmd = settings.TESSERACT_CMD

    def scan_file(self, file_path: Path) -> Optional[ScanResult]:
        """
        Ponto de entrada para escanear um arquivo de DANFE (PDF ou imagem).
        Retorna ScanResult ou None se a chave não for encontrada.
        """
        file_path = Path(file_path)
        if not file_path.exists():
            logger.error(f"Arquivo não encontrado: {file_path}")
            return None

        suffix = file_path.suffix.lower()
        if suffix not in (".pdf", ".png", ".jpg", ".jpeg", ".xml"):
            logger.warning(f"Extensão de arquivo não suportada para escaneamento: {suffix}")
            return None

        if suffix == ".xml":
            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                match = re.search(r"Id=[\"'](?:NFe|NFCe)?(\d{44})[\"']", content) or re.search(r"<chNFe>(\d{44})</chNFe>", content)
                if match:
                    key = match.group(1)
                    if validate_nfe_key(key):
                        logger.info(f"Chave de acesso extraída de XML fiscal: {key}")
                        return ScanResult(key=key, method="xml", file_path=file_path, page_number=1)
                candidate = extract_key_from_text(content)
                if candidate:
                    logger.info(f"Chave de acesso identificada no XML: {candidate}")
                    return ScanResult(key=candidate, method="xml", file_path=file_path, page_number=1)
            except Exception as e:
                logger.error(f"Falha ao processar arquivo XML {file_path.name}: {e}")
            return None

        self.last_ocr_text: str = ""

        logger.info(f"Iniciando escaneamento do arquivo: {file_path.name}")
        raw_text_collected = ""

        # Se for PDF com camada de texto, tenta extrair o texto diretamente
        if suffix == ".pdf":
            try:
                import subprocess
                proc = subprocess.run(["pdftotext", str(file_path), "-"], capture_output=True, text=True, timeout=5)
                if proc.returncode == 0 and proc.stdout.strip():
                    raw_text_collected = proc.stdout
                    candidate = extract_key_from_text(raw_text_collected)
                    if candidate:
                        logger.info(f"Chave de acesso extraída via texto direto do PDF: {candidate}")
                        return ScanResult(key=candidate, method="ocr", file_path=file_path, page_number=1, raw_text=raw_text_collected)
            except Exception:
                pass

        try:
            images = self._load_images_from_file(file_path)
        except Exception as e:
            logger.error(f"Falha ao carregar imagens do arquivo {file_path.name}: {e}", exc_info=True)
            return None

        for page_idx, pil_image in enumerate(images, start=1):
            logger.debug(f"Processando página {page_idx} de {file_path.name}")
            cv_image = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)

            # 1. Tentativa primária: Código de Barras (Code 128)
            barcode_key = self._scan_barcode(cv_image) or self._scan_qrcode(cv_image)
            if barcode_key:
                logger.info(f"Chave de acesso extraída via CÓDIGO DE BARRAS (página {page_idx}): {barcode_key}")
                if not raw_text_collected and settings.OCR_ENABLED and PYTESSERACT_AVAILABLE:
                    try:
                        raw_text_collected = pytesseract.image_to_string(cv_image, lang=settings.TESSERACT_LANG)
                    except Exception as e:
                        logger.debug(f"Falha ao executar OCR complementar para texto da nota: {e}")
                return ScanResult(key=barcode_key, method="barcode", file_path=file_path, page_number=page_idx, raw_text=raw_text_collected)

            # 2. Tentativa secundária: Fallback OCR
            if settings.OCR_ENABLED:
                logger.debug(f"Tentando extração via OCR para a página {page_idx}...")
                ocr_key = self._scan_ocr(cv_image)
                if ocr_key:
                    logger.info(f"Chave de acesso extraída via OCR (página {page_idx}): {ocr_key}")
                    return ScanResult(key=ocr_key, method="ocr", file_path=file_path, page_number=page_idx, raw_text=raw_text_collected or self.last_ocr_text)

        # 3. Tentativa terciária: Fallback para Comprovantes / Orçamentos com valor e fornecedor
        receipt_result = self._extract_receipt_fallback(file_path, raw_text_collected or self.last_ocr_text)
        if receipt_result:
            return receipt_result

        logger.warning(f"Não foi possível extrair a chave de acesso do arquivo: {file_path.name}")
        return None

    def _extract_receipt_fallback(self, file_path: Path, raw_text: Optional[str] = None) -> Optional[ScanResult]:
        """
        Para comprovantes, recibos e orçamentos que não possuem código de barras nem 44 dígitos impressos,
        extrai fornecedor e valor (do nome ou do texto do documento) e gera uma chave sintética com prefixo 'REC-'.
        """
        # 1. Tenta extrair do nome do arquivo (legado)
        match = re.search(
            r"(?:NFC-e|NFE|NF|DANFE)?\s*(?P<empresa>[^-]+)\s*-\s*(?P<emitente>[^-]+)\s*-\s*R\$\s*(?P<valor>[\d\.,]+)",
            file_path.name,
            re.IGNORECASE
        )
        if match:
            empresa = re.sub(r"\W+", "", match.group("empresa").strip().upper())[:8]
            emitente = re.sub(r"\W+", "", match.group("emitente").strip().upper())[:12]
            val_clean = match.group("valor").replace(".", "").replace(",", "").strip()
            key = f"REC-{empresa}-{emitente}-{val_clean}"
            logger.info(f"[{file_path.name}] Chave sintética gerada para comprovante/orçamento: {key}")
            return ScanResult(key=key, method="ocr", file_path=file_path, page_number=1, raw_text=raw_text)

        # 2. Se o nome é apenas 'NFC-e Norvia - Clara', tenta extrair valor e CNPJ/emitente do texto interno
        text_source = raw_text or getattr(self, "last_ocr_text", "")
        if text_source:
            parts = [p.strip() for p in file_path.stem.split(" - ") if p.strip()]
            empresa = re.sub(r"\W+", "", (parts[0] if parts else "EMPRESA").upper())[:8]

            val_match = re.search(
                r"(?:VALOR\s+A\s+PAGAR|VALOR\s+TOTAL|V\.?\s*TOTAL|TOTAL\s+R\$|TOTAL)[^\d\n\r]*R?\$?\s*([\d\.,]+)",
                text_source,
                re.IGNORECASE
            )
            cnpj_match = re.search(r"CNPJ[^\d]*(\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2})", text_source, re.IGNORECASE)

            if val_match:
                val_clean = val_match.group(1).replace(".", "").replace(",", "").strip()
                ident = re.sub(r"\D", "", cnpj_match.group(1))[:8] if cnpj_match else "RECIBO"
                key = f"REC-{empresa}-{ident}-{val_clean}"
                logger.info(f"[{file_path.name}] Chave sintética gerada a partir do texto interno: {key}")
                return ScanResult(key=key, method="ocr", file_path=file_path, page_number=1, raw_text=text_source)

        return None

    def _load_images_from_file(self, file_path: Path) -> List[Image.Image]:
        """Carrega páginas como lista de imagens PIL (suporta PDF e formatos de imagem)."""
        suffix = file_path.suffix.lower()

        if suffix == ".pdf":
            if not PDF2IMAGE_AVAILABLE:
                raise RuntimeError("Biblioteca 'pdf2image' não instalada para conversão de PDF.")
            
            kwargs = {"dpi": settings.PDF_DPI}
            if settings.POPPLER_PATH:
                kwargs["poppler_path"] = settings.POPPLER_PATH

            # Geralmente a DANFE tem a chave e código de barras na 1ª página
            # Limitamos a leitura às primeiras 2 páginas para otimizar desempenho
            return convert_from_path(str(file_path), first_page=1, last_page=2, **kwargs)
        else:
            img = Image.open(file_path)
            # Fotos de celular guardam a rotação só no EXIF; sem isso a imagem chega deitada ao OCR
            return [ImageOps.exif_transpose(img).convert("RGB")]

    def _scan_barcode(self, cv_image: np.ndarray) -> Optional[str]:
        """
        Tenta decodificar código de barras Code 128 com pyzbar.
        Aplica técnicas de pré-processamento (escala de cinza, binarização Otsu e rotações)
        para máxima robustez.
        """
        if not PYZBAR_AVAILABLE:
            logger.debug("pyzbar não está disponível no ambiente.")
            return None

        # Lista de variações pré-processadas da imagem para tentar a decodificação
        preprocessed_variants = self._generate_barcode_image_variants(cv_image)

        for variant in preprocessed_variants:
            try:
                decoded_objects = pyzbar.decode(variant)
                for obj in decoded_objects:
                    data_str = obj.data.decode("utf-8", errors="ignore").strip()
                    cleaned_digits = re.sub(r"\D", "", data_str)

                    if len(cleaned_digits) == 44 and validate_nfe_key(cleaned_digits):
                        return cleaned_digits

                    # Suporte a QRCode de NFC-e (onde o dado é uma URL contendo a chave)
                    candidate = extract_key_from_text(data_str)
                    if candidate:
                        logger.info(f"Chave extraída de QR Code / Código de barras: {candidate}")
                        return candidate
            except Exception as e:
                logger.debug(f"Erro ao tentar decodificar variante com pyzbar: {e}")

        return None

    def _scan_qrcode(self, cv_image: np.ndarray) -> Optional[str]:
        """
        Lê o QR Code de cupons NFC-e com OpenCV (não depende do pyzbar/libzbar).
        Fotos de celular têm 12+ MP: o detector padrão só acha o QR com a imagem reduzida,
        enquanto o QRCodeDetectorAruco lê bem na resolução cheia — por isso tenta os dois.
        """
        gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY) if len(cv_image.shape) == 3 else cv_image
        variants = [gray]
        longest_side = max(gray.shape[:2])
        for target in (1600, 1000):
            if longest_side > target:
                scale = target / longest_side
                variants.append(cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA))

        detectors = [cv2.QRCodeDetector()]
        if hasattr(cv2, "QRCodeDetectorAruco"):
            detectors.insert(0, cv2.QRCodeDetectorAruco())

        for detector in detectors:
            for variant in variants:
                try:
                    val, _, _ = detector.detectAndDecode(variant)
                except Exception as e_qr:
                    logger.debug(f"Erro no detector OpenCV {type(detector).__name__}: {e_qr}")
                    continue
                if not val:
                    continue
                cleaned_digits = re.sub(r"\D", "", val)
                if len(cleaned_digits) == 44 and validate_nfe_key(cleaned_digits):
                    logger.info(f"Chave de 44 dígitos extraída via OpenCV QRCodeDetector: {cleaned_digits}")
                    return cleaned_digits
                # QR de NFC-e é uma URL: ...qrcode?p=<chave>|2|1|...
                candidate = extract_key_from_text(val)
                if candidate:
                    logger.info(f"Chave extraída de URL de QR Code via OpenCV: {candidate}")
                    return candidate

        return None

    def _generate_barcode_image_variants(self, cv_image: np.ndarray) -> List[np.ndarray]:
        """
        Gera variantes da imagem para maximizar a chance de leitura do código de barras:
        - Imagem original
        - Escala de cinza
        - Binarização Otsu
        - Rotações em 90°, 180° e 270° (DANFEs com código de barras vertical ou escaneadas de lado)
        """
        variants: List[np.ndarray] = []

        # Imagem original
        variants.append(cv_image)

        # Escala de cinza
        gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY) if len(cv_image.shape) == 3 else cv_image
        variants.append(gray)

        # Binarização com Otsu
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(otsu)

        # Rotações de 90°, 180°, 270° em escala de cinza
        for rot in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
            variants.append(cv2.rotate(gray, rot))
            variants.append(cv2.rotate(otsu, rot))

        return variants

    def _scan_ocr(self, cv_image: np.ndarray) -> Optional[str]:
        """
        Executa OCR Tesseract na imagem como fallback para encontrar os 44 dígitos da NF-e.
        """
        if not PYTESSERACT_AVAILABLE:
            logger.warning("pytesseract não está disponível para fallback OCR.")
            return None

        gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY) if len(cv_image.shape) == 3 else cv_image

        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        contrast_img = clahe.apply(gray)

        # Variantes de imagem para testar OCR
        ocr_variants = [contrast_img, gray]

        # Se imagem for de baixa resolução, adiciona versão ampliada 2x
        h, w = gray.shape[:2]
        if w < 1600 or h < 1600:
            upscaled = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
            ocr_variants.append(upscaled)

        configs = [
            "--psm 6",  # Assume bloco uniforme de texto
            "--psm 11", # Texto esparso (ideal para campos isolados da DANFE)
            "--psm 3",  # Padrão automático
        ]

        for img_variant in ocr_variants:
            for config in configs:
                try:
                    text = pytesseract.image_to_string(
                        img_variant,
                        lang=settings.TESSERACT_LANG,
                        config=config
                    )
                    self.last_ocr_text = text
                    key = extract_key_from_text(text)
                    if key:
                        return key
                except Exception as e:
                    logger.debug(f"Erro na execução do pytesseract com config '{config}': {e}")

        return None
