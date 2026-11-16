"""
Forma de pagamento pré-selecionada na revisão (o seletor Pix/Boleto/Clara/Caixa de
`ConfirmLancamentoRequest.forma_pagamento`), resolvida sem LLM, nesta ordem:

1. o que o XML da NF-e crava (`pag/detPag`): tPag 17 → pix; 15 → boleto; cartão (03/04)
   com bandeira (tBand) 02 Mastercard → clara, 06 Elo → caixa_elo, 01 Visa →
   caixa_visa_norvia nas Norvia (raiz 27184930) ou caixa_visa nas demais;
2. a última forma confirmada para o mesmo fornecedor naquela empresa (category_history);
3. nada: o painel usa a regra de sempre (marcador do nome do arquivo, senão o padrão da empresa).

No painel o marcador do nome do arquivo continua acima de tudo: é a escolha que uma pessoa
escreveu ao subir a nota. Preparado para um passo futuro com os boletos DDA (Polp).
"""
from typing import Optional, Tuple

RAIZ_CNPJ_NORVIA = "27184930"

_POR_TPAG = {"17": "pix", "15": "boleto"}
_POR_BANDEIRA = {"02": "clara", "06": "caixa_elo"}
_CARTAO = ("03", "04")


def forma_do_xml(t_pag: Optional[str], t_band: Optional[str], destinatario_cnpj: Optional[str]) -> Optional[str]:
    """A forma que o XML crava, ou None quando ele não diz o meio específico."""
    if t_pag in _POR_TPAG:
        return _POR_TPAG[t_pag]
    if t_pag not in _CARTAO or not t_band:
        return None
    if t_band == "01":
        return "caixa_visa_norvia" if (destinatario_cnpj or "").startswith(RAIZ_CNPJ_NORVIA) else "caixa_visa"
    return _POR_BANDEIRA.get(t_band)


def sugerir(
    t_pag: Optional[str],
    t_band: Optional[str],
    destinatario_cnpj: Optional[str],
    do_historico: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    """(forma, origem) com origem "xml" ou "historico"; (None, None) deixa a regra do painel valer."""
    forma = forma_do_xml(t_pag, t_band, destinatario_cnpj)
    if forma:
        return forma, "xml"
    if do_historico:
        return do_historico, "historico"
    return None, None
