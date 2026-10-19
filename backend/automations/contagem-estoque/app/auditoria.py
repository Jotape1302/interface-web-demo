"""
Cabeçalho das observações lançadas no Tiny (pedido do usuário em 2026-10-15): toda observação
começa com "Auditoria {data} lançamento {ID} - ...". ID e data são os da contagem no painel: o
número sequencial da contagem (000001, 000002..., dado pelo registro do bot) e o dia em que a
foto foi contada, para achar o lançamento no Tiny a partir do card e vice-versa.
"""
from __future__ import annotations

from datetime import datetime

from app.registro import FUSO_SP

DIGITOS = 6


def formatar_numero(numero: int) -> str:
    return str(numero).zfill(DIGITOS)


def cabecalho(numero: int, criado_em: str) -> str:
    data = datetime.fromisoformat(criado_em).astimezone(FUSO_SP).strftime("%d/%m/%Y")
    return f"Auditoria {data} lançamento {formatar_numero(numero)}"
