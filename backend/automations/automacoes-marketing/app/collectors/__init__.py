"""Coletores de notícias e tendências de arquitetura e design."""
from .rss_collector import (
    coletar_artigos_rss,
    extrair_texto_limpo_artigo,
    pontuar_relevancia_interiores,
)

coletar_todas_noticias = coletar_artigos_rss

__all__ = [
    "coletar_artigos_rss",
    "coletar_todas_noticias",
    "extrair_texto_limpo_artigo",
    "pontuar_relevancia_interiores",
]
