"""
Provedores reais de geração de imagens de ambiente (Gemini e OpenAI) com referências 3D e de estilo.
"""

from __future__ import annotations

import base64
import io
import logging
import mimetypes
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from PIL import Image

from app.ai.finops_router import _obter_segundos_espera_429
from app.config import PASTA_REFERENCIAS, settings

logger = logging.getLogger("marketing.ambientes.provedores")

LIMITE_BYTES_JPEG = 250 * 1024

RENDER_POR_LINHA: Dict[str, str] = {
    "rodape_invertido": "rodape-invertido-veles-led.png",
    "rodape_invertido_aquila": "rodape-invertido-aquila-led.png",
    "rodape_orion_led": "rodape-orion-autocolante-led.png",
    "perfil_t": "perfil-t-45mm-aluminio.png",
    "redutor_piso": "perfil-redutor-flex-aluminio.png",
    "cantoneira": "cantoneira-aluminio-parede-25x25.jpg",
    "listelo_velino": "listelo-fino-velino-aluminio.png",
    "perfil_led_embutir": "perfil-led-embutir-22mm.jpg",
}


EXEMPLOS_POR_LINHA: Dict[str, List[str]] = {
    "rodape_invertido": ["produto-rodape-invertido-led.jpg", "exemplo-rodape-sala.jpg"],
    "rodape_invertido_aquila": ["exemplo-rodape-close.jpg", "exemplo-rodape-sala.jpg"],
    "rodape_orion_led": ["exemplo-rodape-sala.jpg", "exemplo-led-corredor.jpg"],
    "perfil_t": ["produto-perfil-t.jpg"],
    "redutor_piso": ["produto-perfil-t.jpg", "exemplo-rodape-close.jpg"],
    "cantoneira": ["produto-cantoneira.jpg"],
    "listelo_velino": ["exemplo-filete-ripado.jpg"],
    "perfil_led_embutir": ["exemplo-led-corredor.jpg"],
}


def validar_provedor_configurado() -> Tuple[bool, str]:
    """Verifica se o provedor de imagem configurado tem chave de API (fora de MOCK_MODE)."""
    if settings.MOCK_MODE:
        return True, ""
    prov = (settings.MARKETING_IMAGEM_PROVEDOR or "gemini").strip().lower()
    if prov == "gemini":
        if not settings.GEMINI_API_KEY:
            return False, "Provedor de imagem Gemini sem chave configurada"
        return True, ""
    if prov == "openai":
        if not settings.OPENAI_API_KEY:
            return False, "Provedor de imagem OpenAI sem chave configurada"
        return True, ""
    return False, f"Provedor de imagem desconhecido: '{prov}'"


def _carregar_inline_data(caminho: Path) -> Dict[str, str]:
    mime, _ = mimetypes.guess_type(str(caminho))
    mime = mime or "image/jpeg"
    b64 = base64.b64encode(caminho.read_bytes()).decode("ascii")
    return {"mime_type": mime, "data": b64}


def obter_referencias_linha(produto_slug: str) -> Tuple[Path, List[Path]]:
    """Retorna (caminho_render_3d, lista_caminhos_exemplos)."""
    nome_render = RENDER_POR_LINHA.get(produto_slug)
    if not nome_render:
        raise ValueError(f"Linha '{produto_slug}' sem render 3D mapeado em RENDER_POR_LINHA.")
    caminho_render = PASTA_REFERENCIAS / "renders" / nome_render
    if not caminho_render.exists():
        raise FileNotFoundError(f"Arquivo de render 3D não encontrado: {caminho_render}")

    nomes_exemplos = EXEMPLOS_POR_LINHA.get(produto_slug)
    if not nomes_exemplos:
        raise ValueError(f"Linha '{produto_slug}' sem exemplos mapeados em EXEMPLOS_POR_LINHA.")
    pasta_exemplos = PASTA_REFERENCIAS / "exemplos"
    exemplos: List[Path] = []
    for nome_ex in nomes_exemplos:
        p = pasta_exemplos / nome_ex
        if not p.exists():
            raise FileNotFoundError(f"Arquivo de exemplo não encontrado: {p}")
        exemplos.append(p)

    return caminho_render, exemplos


def _chamar_gemini_imagem(
    prompt: str,
    render_path: Path,
    exemplos_paths: List[Path],
    aspect_ratio: str = "3:2",
    imagem_base_bytes: Optional[bytes] = None,
) -> bytes:
    modelo = settings.GEMINI_IMAGE_MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.GEMINI_API_KEY or "",
    }

    parts: List[Dict[str, Any]] = [{"text": prompt}]
    if imagem_base_bytes is not None:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(imagem_base_bytes).decode("ascii"),
            }
        })
    parts.append({"inline_data": _carregar_inline_data(render_path)})
    for ex in exemplos_paths:
        parts.append({"inline_data": _carregar_inline_data(ex)})

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {
                "aspectRatio": aspect_ratio,
            },
        },
    }

    ultimo_erro = "erro desconhecido"
    for tentativa in range(1, 4):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=90)
        except requests.exceptions.Timeout:
            ultimo_erro = "timeout após 90s na geração de imagem Gemini"
            logger.warning("Gemini Imagem (%s) %s (tentativa %d/3)", modelo, ultimo_erro, tentativa)
            continue
        except requests.exceptions.RequestException as exc:
            ultimo_erro = f"erro de rede Gemini Imagem: {exc}"
            logger.warning("Gemini Imagem (%s) %s (tentativa %d/3)", modelo, ultimo_erro, tentativa)
            continue

        if resp.status_code == 429:
            espera = _obter_segundos_espera_429(resp)
            ultimo_erro = "HTTP 429 após 3 tentativas"
            logger.warning("Gemini Imagem (%s) HTTP 429 (tentativa %d/3). Aguardando %.1fs...", modelo, tentativa, espera)
            if tentativa < 3:
                time.sleep(espera)
            continue

        if resp.status_code == 404:
            msg = f"HTTP 404: modelo {modelo} indisponível — ajuste GEMINI_IMAGE_MODEL"
            logger.error(msg)
            raise RuntimeError(msg)

        if not resp.ok:
            msg = f"HTTP {resp.status_code}: {resp.text[:300]}"
            logger.error("Gemini Imagem (%s) falhou: %s", modelo, msg)
            raise RuntimeError(msg)

        dados = resp.json()
        candidates = dados.get("candidates") or []
        if not candidates:
            feedback = dados.get("promptFeedback") or {}
            block_reason = feedback.get("blockReason") or "sem candidatos"
            raise RuntimeError(f"Gemini não retornou imagem ({block_reason})")

        cand = candidates[0]
        finish_reason = cand.get("finishReason", "")
        content_parts = (cand.get("content") or {}).get("parts") or []
        for p in content_parts:
            inline = p.get("inlineData") or p.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])

        raise RuntimeError(f"Gemini retornou resposta sem imagem (finishReason: {finish_reason or 'desconhecido'})")

    raise RuntimeError(f"Gemini Imagem falhou: {ultimo_erro}")


def _chamar_openai_imagem(prompt: str, render_path: Path, exemplos_paths: List[Path]) -> bytes:
    modelo = settings.OPENAI_IMAGE_MODEL
    url = "https://api.openai.com/v1/images/edits"
    headers = {
        "Authorization": f"Bearer {settings.OPENAI_API_KEY or ''}",
    }

    render_mime = mimetypes.guess_type(render_path.name)[0] or "image/png"
    arquivos = [("image[]", (render_path.name, render_path.read_bytes(), render_mime))]
    for ex in exemplos_paths:
        ex_mime = mimetypes.guess_type(ex.name)[0] or "image/jpeg"
        arquivos.append(("image[]", (ex.name, ex.read_bytes(), ex_mime)))

    data = {
        "model": modelo,
        "prompt": prompt,
        "size": "1536x1024",
    }

    ultimo_erro = "erro desconhecido"
    for tentativa in range(1, 4):
        try:
            resp = requests.post(url, headers=headers, data=data, files=arquivos, timeout=90)
        except requests.exceptions.Timeout:
            ultimo_erro = "timeout após 90s na geração de imagem OpenAI"
            continue
        except requests.exceptions.RequestException as exc:
            ultimo_erro = f"erro de rede OpenAI Imagem: {exc}"
            continue

        if resp.status_code == 429:
            espera = _obter_segundos_espera_429(resp)
            ultimo_erro = "HTTP 429 após 3 tentativas"
            if tentativa < 3:
                time.sleep(espera)
            continue

        if resp.status_code == 404:
            msg = f"HTTP 404: modelo {modelo} indisponível — ajuste OPENAI_IMAGE_MODEL"
            logger.error(msg)
            raise RuntimeError(msg)

        if not resp.ok:
            msg = f"HTTP {resp.status_code}: {resp.text[:300]}"
            logger.error("OpenAI Imagem (%s) falhou: %s", modelo, msg)
            raise RuntimeError(msg)

        res = resp.json()
        item = (res.get("data") or [{}])[0]
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        if item.get("url"):
            dl = requests.get(item["url"], timeout=30)
            dl.raise_for_status()
            return dl.content
        raise RuntimeError("OpenAI retornou resposta sem imagem")

    raise RuntimeError(f"OpenAI Imagem falhou: {ultimo_erro}")


def processar_e_recortar_jpeg(raw_bytes: bytes, proporcao: str) -> Tuple[bytes, int, int]:
    """
    Recorta ao centro (cover) para 3:2 ou 4:5, redimensiona para 1200px no lado maior,
    e comprime em JPEG com qualidade 82 (reduzindo de 4 em 4 até 60 se > 250 KB).
    """
    with Image.open(io.BytesIO(raw_bytes)) as img_orig:
        img = img_orig.convert("RGB")
        orig_w, orig_h = img.size

        if proporcao == "3:2":
            target_ratio = 3 / 2
            alvo_w, alvo_h = 1200, 800
        elif proporcao == "4:5":
            target_ratio = 4 / 5
            alvo_w, alvo_h = 960, 1200
        else:
            raise ValueError(f"Proporção não suportada: {proporcao}")

        curr_ratio = orig_w / orig_h
        if abs(curr_ratio - target_ratio) > 0.01:
            if curr_ratio > target_ratio:
                # Mais larga que o alvo -> corta laterais
                new_w = int(round(orig_h * target_ratio))
                left = (orig_w - new_w) // 2
                img = img.crop((left, 0, left + new_w, orig_h))
            else:
                # Mais alta que o alvo -> corta topo/base
                new_h = int(round(orig_w / target_ratio))
                top = (orig_h - new_h) // 2
                img = img.crop((0, top, orig_w, top + new_h))

        curr_w, curr_h = img.size
        if curr_w > alvo_w or curr_h > alvo_h:
            img = img.resize((alvo_w, alvo_h), Image.Resampling.LANCZOS)
        final_w, final_h = img.size

        for qual in range(82, 58, -4):
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=qual, optimize=True)
            dados = buf.getvalue()
            if len(dados) <= LIMITE_BYTES_JPEG:
                return dados, final_w, final_h

        raise ValueError(
            f"Imagem {proporcao} excedeu o limite de 250 KB mesmo na qualidade mínima 60."
        )


def gerar_composicao_ambiente(
    produto_slug: str,
    prompt: str,
    aspect_ratio: str = "3:2",
    imagem_base_bytes: Optional[bytes] = None,
) -> Tuple[bytes, List[str]]:
    """
    Gera a composição da imagem de ambiente em 3:2 ou 4:5 usando o provedor configurado (ou mock).
    Retorna (raw_bytes, lista_nomes_referencias_usadas).
    """
    render_path, exemplos_paths = obter_referencias_linha(produto_slug)
    refs_usadas = [render_path.name] + [p.name for p in exemplos_paths]

    if settings.MOCK_MODE:
        # Em MOCK_MODE gera imagem sintética válida para testes de fluxo
        dim = (960, 1200) if aspect_ratio == "4:5" else (1200, 800)
        img = Image.new("RGB", dim, (28, 45, 72))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=82, optimize=True)
        return buf.getvalue(), refs_usadas

    prov = (settings.MARKETING_IMAGEM_PROVEDOR or "gemini").strip().lower()
    if prov == "gemini":
        return (
            _chamar_gemini_imagem(
                prompt,
                render_path,
                exemplos_paths,
                aspect_ratio=aspect_ratio,
                imagem_base_bytes=imagem_base_bytes,
            ),
            refs_usadas,
        )
    if prov == "openai":
        if aspect_ratio != "3:2":
            raise RuntimeError("OpenAI images/edits gera apenas 3:2; usar recorte para 4:5.")
        return _chamar_openai_imagem(prompt, render_path, exemplos_paths), refs_usadas

    raise RuntimeError(f"Provedor de imagem não suportado: {prov}")
