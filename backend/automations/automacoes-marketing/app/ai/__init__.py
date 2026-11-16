"""Roteador FinOps de IA (Groq primary, Gemini fallback)."""
from .finops_router import (
    gerar_copy_edicao_norvia,
    selecionar_melhores_pautas_da_semana,
    triar_e_conectar_produto_norvia,
)

__all__ = [
    "gerar_copy_edicao_norvia",
    "selecionar_melhores_pautas_da_semana",
    "triar_e_conectar_produto_norvia",
]
