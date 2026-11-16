import html
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any, Dict, List

import requests

from app.config import FONTES_ARQUITETURA, FUSO_SP, settings

logger = logging.getLogger("marketing.rss")

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 NorviaEditorialBot/1.0"
)

TERMOS_DESCARTADOS = (
    "pavilhao",
    "pavilion",
    "instalacao artistica",
    "art installation",
    "exposicao",
    "exhibition",
    "bienal",
    "biennale",
    "museu",
    "museum",
    "memorial",
    "estadio",
    "stadium",
    "passarela",
    "ponte",
    "bridge",
    "parque publico",
    "urbanismo",
    "cemiterio",
    "capela",
    "igreja",
    "escola",
    "universidade",
)

TERMOS_PRIORITARIOS = (
    "casa",
    "house",
    "residencia",
    "residence",
    "apartamento",
    "apartment",
    "interiores",
    "interior",
    "reforma",
    "renovation",
    "piso",
    "floor",
    "madeira",
    "porcelanato",
    "iluminacao",
    "lighting",
    "cozinha",
    "banheiro",
    "sala",
    "minimalista",
)

ARTIGOS_MOCK_ARQUITETURA: List[Dict[str, Any]] = [
    {
        "fonte_id": "archdaily_br",
        "fonte_nome": "ArchDaily Brasil",
        "titulo": "Arquitetura Minimalista e o Efeito de Parede Flutuante: Como a Iluminação Linear no Piso Redefine Residências",
        "link": "https://www.archdaily.com.br/br/efeito-parede-flutuante-iluminacao-linear",
        "resumo_rss": (
            "Escritórios brasileiros de arquitetura substituem rodapés salientes convencionais por perfis "
            "metálicos invertidos em alumínio com aba para fita de LED, criando sensação de amplitude, "
            "luz indireta acolhedora e proteção duradoura na base da alvenaria ou drywall."
        ),
        "imagem_url": "/marketing/produto-rodape-invertido-led.jpg",
        "publicado_em": datetime.now(FUSO_SP).isoformat(),
        "idioma": "pt-BR",
        "produto_sugerido": "rodape_invertido",
    },
    {
        "fonte_id": "dezeen_interiors",
        "fonte_nome": "Dezeen Interiors",
        "titulo": "Integração de Ambientes no Mesmo Nível: Soluções em Alumínio para a Transição entre Piso Laminado e Porcelanato",
        "link": "https://www.dezeen.com/interiors/seamless-floor-transitions-luxury-homes",
        "resumo_rss": (
            "Na integração entre salas com piso laminado ou vinílico e cozinhas em porcelanato no mesmo nível, "
            "o Perfil T de acabamento em alumínio garante união discreta, proteção das bordas contra lascas e "
            "espaço técnico adequado para a dilatação natural do piso."
        ),
        "imagem_url": "/marketing/produto-perfil-t.jpg",
        "publicado_em": datetime.now(FUSO_SP).isoformat(),
        "idioma": "pt-BR",
        "produto_sugerido": "perfil_t",
    },
    {
        "fonte_id": "archdaily_br",
        "fonte_nome": "ArchDaily Brasil",
        "titulo": "Acabamento e Proteção de Quinas em Paredes: O Uso de Cantoneiras em Alumínio na Arquitetura Contemporânea",
        "link": "https://www.archdaily.com.br/br/detalhamento-quinas-cantoneiras-aluminio",
        "resumo_rss": (
            "Cantoneiras em alumínio aplicadas nas quinas e cantos das paredes protegem contra impactos, "
            "cobrem pequenas irregularidades e proporcionam acabamento uniforme em revestimentos de cerâmica "
            "e porcelanato, reduzindo custos de manutenção."
        ),
        "imagem_url": "/marketing/produto-cantoneira.jpg",
        "publicado_em": datetime.now(FUSO_SP).isoformat(),
        "idioma": "pt-BR",
        "produto_sugerido": "cantoneira",
    },
]


def limpar_tags_html(texto: str) -> str:
    if not texto:
        return ""
    sem_tags = re.sub(r"<[^>]+>", " ", texto)
    decodificado = html.unescape(sem_tags)
    return re.sub(r"\s+", " ", decodificado).strip()


def extrair_primeira_imagem_html(html_bruto: str) -> str:
    if not html_bruto:
        return ""
    match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html_bruto, re.IGNORECASE)
    if match:
        url = match.group(1).strip()
        if url.startswith("http"):
            return url
    return ""


def _normalizar_sem_acento(texto: str) -> str:
    import unicodedata

    nfkd = unicodedata.normalize("NFKD", (texto or "").lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def pontuar_relevancia_interiores(titulo: str, resumo: str) -> int:
    combinado = _normalizar_sem_acento(f"{titulo} {resumo}")
    for proibido in TERMOS_DESCARTADOS:
        if proibido in combinado:
            return -100
    pontos = 0
    for prioritario in TERMOS_PRIORITARIOS:
        if prioritario in combinado:
            pontos += 10
    return pontos


def coletar_artigos_rss(limite_por_fonte: int = 8) -> List[Dict[str, Any]]:
    if settings.MOCK_MODE:
        return list(ARTIGOS_MOCK_ARQUITETURA)

    artigos_coletados: List[Dict[str, Any]] = []
    headers = {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/xml"}

    for fonte in FONTES_ARQUITETURA:
        try:
            resp = requests.get(fonte["rss_url"], headers=headers, timeout=(5, 10))
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
            items = root.findall(".//item")[:limite_por_fonte]

            for item in items:
                titulo = limpar_tags_html(item.findtext("title") or "")
                link = (item.findtext("link") or "").strip()
                descricao_bruta = item.findtext("description") or ""
                conteudo_encoded = ""
                for child in item:
                    if child.tag.endswith("encoded") and child.text:
                        conteudo_encoded = child.text
                        break

                html_referencia = conteudo_encoded or descricao_bruta
                resumo = limpar_tags_html(descricao_bruta)[:520]
                imagem = extrair_primeira_imagem_html(html_referencia)
                pub_date = (item.findtext("pubDate") or datetime.now(FUSO_SP).isoformat()).strip()

                score = pontuar_relevancia_interiores(titulo, resumo)
                if titulo and link and score >= 0:
                    artigos_coletados.append(
                        {
                            "fonte_id": fonte["id"],
                            "fonte_nome": fonte["nome"],
                            "titulo": titulo,
                            "link": link,
                            "resumo_rss": resumo,
                            "imagem_url": imagem,
                            "publicado_em": pub_date,
                            "idioma": fonte["idioma"],
                            "_score_interiores": score,
                        }
                    )
        except Exception as exc:
            logger.warning("Falha ao ler RSS de %s (%s): %s", fonte["nome"], fonte["rss_url"], exc)

    # Sem matéria de verdade, nada de exemplo: a edição citaria uma fonte que não existe.
    # A rotina recusa o lote com menos de 2 matérias (erro claro no painel).

    artigos_coletados.sort(key=lambda x: x.get("_score_interiores", 0), reverse=True)
    return artigos_coletados


coletar_todas_noticias = coletar_artigos_rss


def extrair_texto_limpo_artigo(url: str, fallback_resumo: str = "") -> str:
    if settings.MOCK_MODE or not url.startswith("http"):
        return fallback_resumo

    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=(5, 10))
        resp.raise_for_status()
        html_doc = resp.text
        html_doc = re.sub(r"<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?</\1>", " ", html_doc, flags=re.IGNORECASE)
        paragrafos = re.findall(r"<p[^>]*>([\s\S]*?)</p>", html_doc, flags=re.IGNORECASE)
        textos_uteis = [limpar_tags_html(p) for p in paragrafos if len(limpar_tags_html(p)) > 60]
        texto_final = "\n\n".join(textos_uteis[:10])
        return texto_final if len(texto_final) > 180 else fallback_resumo
    except Exception:
        return fallback_resumo
