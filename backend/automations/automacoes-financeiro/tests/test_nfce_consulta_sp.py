"""
NFC-e enviada como PDF da consulta pública da SEFAZ-SP (incidente 2026-10-07): o fornecedor
virava "CLIENTE NAO IDENTIFICADO Data" (Razão Social do consumidor), a empresa caía no 1º
certificado do pool, a data no dia 01, o item no genérico e a forma "Cartão Clara" se perdia.
Fornecedor fictício; layout igual ao do pdftotext do PDF real.
"""
from datetime import date
from decimal import Decimal
from pathlib import Path

from app.nfe_client import (
    MultiSefazA1Provider,
    build_nfce_from_key,
    enrich_nfe_data_from_file_context,
    meio_pagamento_do_texto,
    nome_antes_do_cnpj,
)
from app.nfe_items import resolve_itens

CHAVE = "35260811222333000181650010000005411376356009"  # modelo 65, emitente 11.222.333/0001-81, ago/2026

TEXTO_CONSULTA_SP = """07/10/2026, 15:25

Consulta Resumida NFC-e - Secretaria da Fazenda - Governo do Estado de São Paulo

LOJA EXEMPLO MATERIAIS LTDA
CNPJ: 11.222.333/0001-81
RUA EXEMPLO , 100 , , CENTRO ,
CAMPINAS , SP
CORDA 10,00MM - METRO (DIVEOS) (Código: 01950 )
Qtde.:3
UN: UN
Vl. Unit.: 2

PARAFUSO 6MM (Código: 00077 )
Qtde.:10
UN: UN
Vl. Unit.: 0,35

Vl. Total

6,00

3,50

Qtd. total de itens:

2

Valor a pagar R$:

9,50

Forma de pagamento:

Valor pago R$:

Cartão de Crédito

9,50

Troco

NaN

Informações gerais da Nota
EMISSÃO NORMAL
Número: 541 Série: 1 Emissão: 03/08/2026 10:07:00 - Via Consumidor
Protocolo de Autorização: 13526005245962300 03/08/2026 10:07:58

Chave de acesso:
3526 0811 2223 3300 0181 6500 1000 0005 4113 7635 6009

Consumidor
CNPJ: 27.184.930/0001-07
Razão Social: CLIENTE NAO IDENTIFICADO
Data/Hora: 07/10/2026 15:19
"""

ARQUIVO = Path("NFC-e Norvia - Cartão Clara - LOJA EXEMPLO - R$9,50.pdf")  # não precisa existir


def _processar(fallback=None):
    nfe = build_nfce_from_key(CHAVE, fallback_dest_cnpj=fallback)
    return enrich_nfe_data_from_file_context(nfe, ARQUIVO, raw_ocr_text=TEXTO_CONSULTA_SP)


def test_fornecedor_e_o_emitente_nao_o_consumidor():
    nfe = _processar()
    assert nfe.emitente_nome == "LOJA EXEMPLO MATERIAIS LTDA"
    assert nfe.emitente_cnpj == "11222333000181"


def test_empresa_sai_do_cnpj_do_consumidor_mesmo_com_palpite_errado():
    nfe = _processar(fallback="36592814000100")  # palpite antigo: 1º certificado (Revesta)
    assert nfe.destinatario_cnpj == "27184930000107"
    assert "CAMPINAS" in nfe.destinatario_nome.upper()


def test_data_e_a_emissao_do_cupom_nao_o_dia_1_nem_a_impressao():
    assert _processar().data_emissao == date(2026, 8, 3)


def test_meio_e_forma_de_pagamento():
    nfe = _processar()
    assert nfe.meio_pagamento_nfe == "03"  # Cartão de Crédito
    assert nfe.marcador_caixa == "Cartão Clara"  # "Cartão Clara" no nome do arquivo
    assert nfe.duplicatas[0].vencimento == date(2026, 9, 9)  # ciclo Clara: 03/08 -> 09/09


def test_itens_do_layout_da_consulta_sp():
    nfe = _processar()
    itens = resolve_itens([], TEXTO_CONSULTA_SP, nfe.numero_nota, nfe.emitente_nome, Decimal("9.50"))
    assert [(i.descricao, i.codigo, i.quantidade, i.valor_unitario, i.valor_total) for i in itens] == [
        ("CORDA 10,00MM - METRO (DIVEOS)", "01950", Decimal("3"), Decimal("2"), Decimal("6.00")),
        ("PARAFUSO 6MM", "00077", Decimal("10"), Decimal("0.35"), Decimal("3.50")),
    ]


def test_itens_que_nao_fecham_com_o_total_caem_no_fallback():
    itens = resolve_itens([], TEXTO_CONSULTA_SP, "541", "LOJA EXEMPLO", Decimal("50.00"))
    assert len(itens) == 1 and itens[0].descricao.startswith("NF-e 541")


def test_auxiliares():
    assert nome_antes_do_cnpj(TEXTO_CONSULTA_SP, "27184930000107") is None  # só rótulos acima
    assert meio_pagamento_do_texto("Forma de pagamento:\nPIX\n10,00") == "17"
    assert meio_pagamento_do_texto("sem forma") is None


def test_pool_de_certificados_nao_chuta_empresa_para_nfce():
    class _Prov:
        cnpj = "36592814000100"

    nfe = MultiSefazA1Provider([_Prov()]).get_nfe_data(CHAVE)
    assert nfe.destinatario_cnpj is None
