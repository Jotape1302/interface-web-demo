"""
Leitura do código de barras / linha digitável de boletos (Febraban), para a conciliação
Inter × Tiny: o extrato do Inter traz o `codBarras` do boleto pago, e dele sai o valor
ORIGINAL e o vencimento — o que permite casar um boleto pago com juros/multa com a conta
a pagar do Tiny (lançada pelo valor original).

Formatos aceitos (só dígitos, pontuação é ignorada):
- boleto bancário: código de barras (44) ou linha digitável (47);
- arrecadação/convênio (começa com 8): código de barras (44) ou linha digitável (48).
  Convênio não tem vencimento no código; o valor só existe quando o identificador de
  valor (3º dígito) é 6 ou 8 (valor em reais).
"""
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

# Fator de vencimento: dias desde 07/10/1997. Chegou a 9999 em 21/02/2025 e reiniciou em
# 1000 no dia 22/02/2025 — o mesmo fator volta a valer outra data a cada ~25 anos, então
# a data certa é a mais próxima de uma referência (a data do pagamento).
_FATOR_BASE_ANTIGA = date(1997, 10, 7)
_FATOR_BASE_NOVA = date(2025, 2, 22)


@dataclass(frozen=True)
class BoletoInfo:
    codigo_barras: str  # sempre os 44 dígitos do código de barras
    convenio: bool
    valor: Optional[Decimal]
    vencimento: Optional[date]


def _digits(value: str) -> str:
    return "".join(c for c in str(value or "") if c.isdigit())


def _linha_bancaria_para_barras(linha: str) -> str:
    # Linha digitável: AAABC.CCCCX DDDDD.DDDDDY EEEEE.EEEEEZ K UUUUVVVVVVVVVV
    return linha[0:4] + linha[32] + linha[33:47] + linha[4:9] + linha[10:20] + linha[21:31]


def _linha_convenio_para_barras(linha: str) -> str:
    # 4 blocos de 11 dígitos, cada um seguido do seu dígito verificador.
    return linha[0:11] + linha[12:23] + linha[24:35] + linha[36:47]


def vencimento_do_fator(fator: int, referencia: Optional[date] = None) -> Optional[date]:
    """Data do fator de vencimento (0 = boleto sem vencimento)."""
    if fator <= 0:
        return None
    antiga = _FATOR_BASE_ANTIGA + timedelta(days=fator)
    if fator < 1000:
        return antiga
    nova = _FATOR_BASE_NOVA + timedelta(days=fator - 1000)
    ref = referencia or date.today()
    return min((antiga, nova), key=lambda d: abs((d - ref).days))


def parse_boleto(codigo: str, referencia: Optional[date] = None) -> Optional[BoletoInfo]:
    """Interpreta código de barras ou linha digitável; None se o formato não for reconhecido."""
    d = _digits(codigo)
    if len(d) == 47 and not d.startswith("8"):
        d = _linha_bancaria_para_barras(d)
    elif len(d) == 48 and d.startswith("8"):
        d = _linha_convenio_para_barras(d)
    if len(d) != 44:
        return None

    if d.startswith("8"):
        valor = Decimal(int(d[4:15])) / 100 if d[2] in ("6", "8") else None
        return BoletoInfo(codigo_barras=d, convenio=True, valor=valor or None, vencimento=None)

    valor_centavos = int(d[9:19])
    return BoletoInfo(
        codigo_barras=d,
        convenio=False,
        valor=Decimal(valor_centavos) / 100 if valor_centavos else None,
        vencimento=vencimento_do_fator(int(d[5:9]), referencia),
    )
