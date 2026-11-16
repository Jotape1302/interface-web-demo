"""Fuso de negócio (America/Sao_Paulo) compartilhado pelas rotinas.

O container roda em UTC; datas com significado de negócio (hoje, vencimento,
data da baixa) devem ser calculadas no fuso de São Paulo, não no do host.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

FUSO_SP = ZoneInfo("America/Sao_Paulo")


def agora_sp() -> datetime:
    """Instante atual com fuso de São Paulo."""
    return datetime.now(FUSO_SP)


def hoje_sp() -> date:
    """Data de hoje em São Paulo."""
    return agora_sp().date()


def agora_sp_naive() -> datetime:
    """Horário de parede de São Paulo sem tzinfo (agendadores que gravam ISO sem fuso)."""
    return agora_sp().replace(tzinfo=None)
