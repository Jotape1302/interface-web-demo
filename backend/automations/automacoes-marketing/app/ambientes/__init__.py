"""Módulo de gestão de imagens de ambiente geradas por IA."""
from app.ambientes.gerenciador import (
    aprovar_ambiente,
    contar_geracoes_hoje,
    escolher_imagem_aprovada,
    estado_geracao_imagens,
    inicializar_estoque_inicial,
    iniciar_geracao_ambientes,
    listar_ambientes,
    listar_produtos_elegiveis,
    obter_caminho_imagem,
    obter_registro_imagem,
    recusar_ambiente,
    registrar_hero_usado,
)

__all__ = [
    "aprovar_ambiente",
    "contar_geracoes_hoje",
    "escolher_imagem_aprovada",
    "estado_geracao_imagens",
    "inicializar_estoque_inicial",
    "iniciar_geracao_ambientes",
    "listar_ambientes",
    "listar_produtos_elegiveis",
    "obter_caminho_imagem",
    "obter_registro_imagem",
    "recusar_ambiente",
    "registrar_hero_usado",
]
