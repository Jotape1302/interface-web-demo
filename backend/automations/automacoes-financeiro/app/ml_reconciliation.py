"""
Conciliação Mercado Livre × Tiny ERP (Contas a Receber) — regras, sem chamadas de rede.

Fontes (buscadas por app/ml_reconciliation_rotina.py, todas por API):
- Recebimentos: relatório de Liberações do Mercado Pago. Cada linha é um movimento do saldo
  (liberação de venda, devolução, reclamação, envio, saque...) com o ID do pagamento (SOURCE_ID).
- Vendas: pedidos do Mercado Livre, com o pacote e os IDs dos pagamentos.
- Clientes: pedidos do Tiny (número do pedido no e-commerce -> nome do cliente e CPF/CNPJ).

Etapas:
1. Liberações -> movimentos. A liberação de uma venda vem numa linha só, com tarifas, frete,
   parcelamento e cupom em colunas: vira um "Recebimento" (valor bruto, que baixa a conta a
   receber) mais um movimento por custo, como no extrato que o financeiro conciliava à mão.
   Se as partes não fecham com o líquido liberado, a diferença vira pendência.
2. Vendas × recebimentos: cada movimento é ligado à venda pelo ID do pagamento (payments[].id do
   pedido no ML = SOURCE_ID); sem ele, pelo pedido informado no relatório. O comparativo mostra
   o que casou, o que não casou e onde o pedido do relatório diverge do pedido do pagamento.
3. Recebimentos somados por venda -> conta a receber do cliente no Tiny que cita a venda no
   histórico -> baixa (confirmada pelo usuário na tela).
4. Demais movimentos: pares que se anulam (mesmo pagamento, soma zero) saem; o resto vira a
   planilha de lançamentos de caixa para importação no Tiny, ou pendência para conferir.
5. Saldo por dia (dos recebimentos e de todas as operações).

A conversão das liberações em tipos de operação (`REGRAS_DESCRICAO`) é a regra inicial: o
relatório da API não traz os mesmos tipos do extrato da tela do Mercado Pago. Tipos que não
estão na tabela viram pendência — nunca lançamento com categoria inventada.
"""
from __future__ import annotations

import io
import re
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# Empresas atendidas (as únicas com vendas no Mercado Livre)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EmpresaML:
    id: str  # conta_identificador do Tiny (api_tokens)
    nome: str
    conta_ml: str  # conta do Mercado Livre em ml_tokens.json (mesma chave da automacoes-marketplace)
    # Conta financeira do Tiny onde entra a baixa e onde caem os lançamentos de caixa (pelo nome).
    conta_lancamento: str
    # IDs no Tiny. None = localizar pela API: a conta pelo nome `conta_lancamento` e a categoria
    # pelo nome da categoria de recebimento da empresa `categoria_igual_a`.
    conta_destino_id: Optional[int] = None
    categoria_recebimento_id: Optional[int] = None
    categoria_igual_a: Optional[str] = None
    categoria_frete_id: Optional[int] = None


# IDs da Norvia: do notebook VERSÃO_4 (bloco 8, conciliação na Tiny).
EMPRESAS_ML: Dict[str, EmpresaML] = {
    "norvia_campinas": EmpresaML(
        id="norvia_campinas",
        nome="Norvia Campinas",
        conta_ml="norvia",
        conta_lancamento="Mercado Livre - NORVIA",
        conta_destino_id=702641458,
        categoria_recebimento_id=882461346,
        categoria_frete_id=489820971,
    ),
    "revesta": EmpresaML(
        id="revesta",
        nome="Revesta",
        conta_ml="revesta",
        conta_lancamento="Mercado Livre - REVESTA",
        categoria_igual_a="norvia_campinas",
    ),
}

FUSO_SP = timezone(timedelta(hours=-3))

# ─────────────────────────────────────────────────────────────────────────────
# Tipos de operação
# ─────────────────────────────────────────────────────────────────────────────

TIPO_RECEBIMENTO = "Recebimento"
TIPO_RECEBIMENTO_FRETE = "Recebimento de frete"
TIPOS_RECEBIMENTO = (TIPO_RECEBIMENTO, TIPO_RECEBIMENTO_FRETE)
TIPO_DIFERENCA = "Diferença na liberação"
TIPO_TRANSFERENCIA = "Transferência / saque"
# Linha do relatório com valor que não é número: nunca vira R$ 0 em silêncio (vai para conferência).
TIPO_VALOR_ILEGIVEL = "Valor ilegível no relatório"
# Linha idêntica a outra do mesmo relatório: pode ser duplicata do relatório ou duas operações
# iguais de verdade (ex.: duas tarifas iguais) — a segunda vai para conferência, não é descartada.
TIPO_LINHA_REPETIDA = "Linha repetida no relatório"

# Partes da liberação de uma venda: coluna do relatório -> tipo de operação (sempre débito).
COMPONENTES_VENDA = (
    ("MP_FEE_AMOUNT", "Tarifa de venda"),
    ("FINANCING_FEE_AMOUNT", "Custos de parcelamento"),
    ("SHIPPING_FEE_AMOUNT", "Tarifa de envio"),
    ("TAXES_AMOUNT", "Impostos retidos"),
    ("COUPON_AMOUNT", "Desconto para a sua contraparte"),
)

# DESCRIPTION do relatório de Liberações -> (tipo se crédito, tipo se débito).
REGRAS_DESCRICAO: Dict[str, Tuple[str, str]] = {
    "payment": (TIPO_RECEBIMENTO, "Pagamento"),
    "refund": ("Cancelamento de devolução", "Devolução de recebimento"),
    "refund_cancel": ("Cancelamento de devolução", "Devolução de recebimento"),
    "chargeback": ("Cancelamento de contestação", "Contestação de pagamento"),
    "chargeback_cancel": ("Cancelamento de contestação", "Contestação de pagamento"),
    "mediation": ("Cancelamento de devolução por Compra Garantida", "Devolução por Compra Garantida"),
    "mediation_cancel": ("Cancelamento de devolução por Compra Garantida", "Devolução por Compra Garantida"),
    "dispute": ("Cancelamento de devolução por Compra Garantida", "Devolução por Compra Garantida"),
    "dispute_cancel": ("Cancelamento de devolução por Compra Garantida", "Devolução por Compra Garantida"),
    "shipping": (TIPO_RECEBIMENTO_FRETE, "Tarifa de envio"),
    "shipping_cancel": (TIPO_RECEBIMENTO_FRETE, "Tarifa de envio"),
    "fee-release_in_advance": ("Cancelamento de tarifa de antecipação", "Tarifa de antecipação"),
    "withdrawal": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "withdrawal_cancel": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "payout": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "payout_cancel": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "transfer": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "money_transfer": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "bank_transfer": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "internal_transfer": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "pix_transfer": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "pix": (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA),
    "cashback": ("Entrada de dinheiro extra", "Cancelamento de entrada de dinheiro extra"),
    "bonus": ("Entrada de dinheiro extra", "Cancelamento de entrada de dinheiro extra"),
    "asset_management": ("Rendimento", "Rendimento"),
    "tax_withholding": ("Devolução de impostos retidos", "Impostos retidos"),
}
TIPO_RESERVA = ("Liberação de dinheiro retido", "Dinheiro retido")  # DESCRIPTION reserve_for_*


def tipo_por_descricao(descricao: str, credito: bool) -> str:
    d = (descricao or "").strip().lower()
    if d in REGRAS_DESCRICAO:
        regra = REGRAS_DESCRICAO[d]
    elif d.startswith("reserve_for_") or d.startswith("release_reserve"):
        regra = TIPO_RESERVA
    elif d.startswith("tax_withholding"):
        regra = REGRAS_DESCRICAO["tax_withholding"]
    elif "transfer" in d or "pix" in d:
        regra = (TIPO_TRANSFERENCIA, TIPO_TRANSFERENCIA)
    else:
        nome = f"Outro movimento do Mercado Pago ({d or 'sem descrição'})"
        regra = (nome, nome)
    return regra[0] if credito else regra[1]


# Ficam fora dos lançamentos de caixa: já tratados pela baixa ou transferência entre contas.
TIPOS_IGNORAR_LANCAMENTO = TIPOS_RECEBIMENTO + (TIPO_TRANSFERENCIA,)

# Só entram se tiverem par no mesmo pagamento que zere a soma (anulação); senão, VERIFICAR.
TIPOS_VERIFICAR_ANULACAO = (
    "Pagamento",
    TIPO_RESERVA[0],
    TIPO_RESERVA[1],
)

_HIST_DEVOLUCAO = "Ref a devolução sobre a venda {mlb}, operação {op}"
_HIST_TARIFAS = "Ref as tarifas sobre a venda {mlb}, operação {op}"
_HIST_CANC_TARIFAS = "Ref ao cancelamento das tarifas sobre a venda {mlb}, operação {op}"
_CAT_DEVOLUCAO = "Devolução de mercadorias"
_CAT_INTERMEDIACAO = "Intermediação de Negócios"
_CAT_REEMBOLSO = "Reembolso de Intermediação de Negócios"
_CAT_RECLAMACOES = "Receita Sobre Reclamações"

# Tipo de operação -> (categoria no Tiny, modelo do histórico). Categorias do notebook V3 (célula 9).
MAPEAMENTO_LANCAMENTOS: Dict[str, Tuple[str, str]] = {
    "Tarifa de venda": (_CAT_INTERMEDIACAO, _HIST_TARIFAS),
    "Custos de parcelamento": (_CAT_INTERMEDIACAO, _HIST_TARIFAS),
    "Tarifa de antecipação": (_CAT_INTERMEDIACAO, _HIST_TARIFAS),
    "Cancelamento de tarifa de antecipação": (_CAT_REEMBOLSO, _HIST_CANC_TARIFAS),
    "Desconto para a sua contraparte": (
        _CAT_INTERMEDIACAO,
        "Ref ao desconto concedido sobre a venda {mlb}, operação {op}",
    ),
    "Tarifa de envio": ("Fretes sobre Vendas", "Ref ao frete sobre a venda {mlb}, operação {op}"),
    "Cancelamento do custo de envio": (
        "Receita de Fretes",
        "Ref ao cancelamento do frete sobre a venda {mlb}, operação {op}",
    ),
    TIPO_RECEBIMENTO_FRETE: (
        "Receita de Fretes",
        "Ref ao frete sobre a venda {mlb}, operação {op}",
    ),
    "Devolução de recebimento": (_CAT_DEVOLUCAO, _HIST_DEVOLUCAO),
    "Devolução por Compra Garantida": (_CAT_DEVOLUCAO, _HIST_DEVOLUCAO),
    "Contestação de pagamento": (_CAT_DEVOLUCAO, _HIST_DEVOLUCAO),
    "Cancelamento de devolução": (
        _CAT_RECLAMACOES,
        "Ref ao cancelamento de devolução sobre a venda {mlb}, operação {op}",
    ),
    "Cancelamento de devolução por Compra Garantida": (
        _CAT_RECLAMACOES,
        "Ref ao cancelamento de devolução sobre a venda {mlb}, operação {op}",
    ),
    "Cancelamento de contestação": (
        _CAT_RECLAMACOES,
        "Ref ao cancelamento da contestação sobre a venda {mlb}, operação {op}",
    ),
    "Entrada de dinheiro extra": (
        _CAT_RECLAMACOES,
        "Ref a entrada de dinheiro sobre a reclamação cancelada na venda {mlb}, operação {op}",
    ),
    "Pagamento": ("Propaganda/ Publicidade", "Ref ao pagamento sobre publicidade, operação {op}"),
}

# Lançamento sem cliente é válido para estes tipos (sem venda ligada: tarifas avulsas, cashback...).
TIPOS_SEM_CLIENTE = frozenset(
    {
        "Entrada de dinheiro extra",
        "Tarifa de antecipação",
        "Cancelamento de tarifa de antecipação",
        "Devolução por Compra Garantida",
        "Cancelamento de devolução por Compra Garantida",
        "Devolução de recebimento",
        "Cancelamento do custo de envio",
        TIPO_RECEBIMENTO_FRETE,
        "Tarifa de envio",
    }
)

# Pagamento de publicidade: o fornecedor é sempre o Mercado Livre.
CONTATO_PUBLICIDADE = ("EBAZAR.COM.BR LTDA", "03.007.331/0122-39")

# ─────────────────────────────────────────────────────────────────────────────
# Situações
# ─────────────────────────────────────────────────────────────────────────────

SIT_CONCILIADO = "CONCILIADO"
SIT_APTO_BAIXA = "APTO PARA BAIXA"
SIT_SEM_CLIENTE = "Não conciliado"
SIT_NAO_LOCALIZADO = "NÃO LOCALIZADO"
SIT_VALOR_DIVERGENTE = "VALOR DIVERGENTE"
SIT_ERRO_API = "ERRO API"
SIT_ERRO_PROCESSAR = "ERRO AO PROCESSAR"
SIT_TINY_NAO_CONSULTADO = "TINY NÃO CONSULTADO"
SIT_ANULADA = "ANULADA"
SIT_VERIFICAR = "VERIFICAR"
SIT_LANCAMENTO_CRIADO = "LANÇAMENTO CRIADO"
SIT_SALDO_DESCONHECIDO = "SALDO DESCONHECIDO"
# "Custos de parcelamento" já descontado do valor da baixa (juros pagos pelo comprador, que o
# Mercado Pago repassa e retém): não vira lançamento de caixa, senão a saída entraria duas vezes.
SIT_DESCONTADO_NA_BAIXA = "DESCONTADO NA BAIXA"
TIPO_CUSTO_PARCELAMENTO = "Custos de parcelamento"

SITUACOES_TINY_BAIXAVEIS = ("aberto", "parcial")

# Como a venda de cada pagamento foi localizada (comparativo vendas × recebimentos).
CASOU_PAGAMENTO = "pagamento"  # payments[].id do pedido no ML = SOURCE_ID
CASOU_PEDIDO = "pedido"  # só pelo ORDER_ID do relatório (pagamento não aparece no pedido)
CASOU_NENHUM = "sem_venda"

_CENTAVO = Decimal("0.01")


# ─────────────────────────────────────────────────────────────────────────────
# Normalização de valores
# ─────────────────────────────────────────────────────────────────────────────


def limpar_id(valor: Any) -> str:
    """123.0 -> "123"; texto fica como está; vazio/None/NaN -> ""."""
    if valor is None or isinstance(valor, bool):
        return "" if valor is None else str(valor)
    if isinstance(valor, int):
        return str(valor)
    if isinstance(valor, float):
        return "" if valor != valor else str(int(valor))
    texto = str(valor).strip()
    if texto.lower() in ("nan", "none", "null"):
        return ""
    if re.fullmatch(r"\d+\.0+", texto):
        return texto.split(".", 1)[0]
    m = re.fullmatch(r"\d\.\d+[eE]\+?(\d{1,2})", texto)
    if m and int(m.group(1)) <= 20:
        return str(int(Decimal(texto)))
    return texto


def normalizar_id_final(id_final_raw: Any) -> Tuple[str, Optional[str]]:
    """
    Normaliza o ID_FINAL da planilha/relatório.
    Se possuir o padrão 'cashback_{op}', retorna ('cashback_{op}', op).
    Senão, retorna (id_final_limpo, None).
    """
    texto = limpar_id(id_final_raw)
    if not texto:
        return "", None
    m = re.match(r"^cashback_(\d+)$", texto, re.IGNORECASE)
    if m:
        return f"cashback_{m.group(1)}", m.group(1)
    return texto, None


def valor_estrito(valor: Any) -> Decimal:
    """Texto/número -> Decimal; vazio = 0. Texto que não é número levanta ValueError."""
    if valor is None or valor == "":
        return Decimal("0")
    if isinstance(valor, Decimal):
        return valor
    if isinstance(valor, (int, float)):
        if isinstance(valor, float) and valor != valor:
            raise ValueError("NaN")
        return Decimal(str(valor))
    texto = str(valor).strip().replace("R$", "").replace(" ", "")
    if texto == "":
        return Decimal("0")
    if "," in texto and "." in texto:
        texto = texto.replace(".", "").replace(",", ".")
    elif "," in texto:
        texto = texto.replace(",", ".")
    try:
        numero = Decimal(texto)
    except InvalidOperation:
        raise ValueError(f"valor não numérico: {str(valor)[:40]!r}") from None
    if not numero.is_finite():
        raise ValueError(f"valor não numérico: {str(valor)[:40]!r}")
    return numero


def para_decimal(valor: Any) -> Decimal:
    """Como `valor_estrito`, mas texto inválido vira 0 (só para campos informativos do Tiny)."""
    try:
        return valor_estrito(valor)
    except ValueError:
        return Decimal("0")


def data_sp(valor: Any) -> Optional[date]:
    """
    Data em São Paulo de um instante ISO ("2025-09-01T01:50:29Z" -> 31/08/2025). Sem fuso no
    texto, a data vale como está (o relatório é pedido em GMT-03).
    """
    if valor is None or valor == "":
        return None
    if isinstance(valor, datetime):
        return (valor.astimezone(FUSO_SP) if valor.tzinfo else valor).date()
    if isinstance(valor, date):
        return valor
    texto = str(valor).strip()
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", texto)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    try:
        dt = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", texto)
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None
    return (dt.astimezone(FUSO_SP) if dt.tzinfo else dt).date()


def data_br(d: Optional[date]) -> str:
    return d.strftime("%d/%m/%Y") if d else ""


def _chave_data(data_txt: str) -> Tuple[int, int, int]:
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", data_txt or "")
    if not m:
        return (9999, 99, 99)
    return (int(m.group(3)), int(m.group(2)), int(m.group(1)))


def _texto(valor: Any) -> str:
    if valor is None or (isinstance(valor, float) and valor != valor):
        return ""
    return str(valor).strip().replace("\n", "").replace("\r", "")


def _normalizar_nome(texto: str) -> str:
    import unicodedata

    s = unicodedata.normalize("NFD", texto or "")
    return " ".join("".join(c for c in s if unicodedata.category(c) != "Mn").lower().split())


# ─────────────────────────────────────────────────────────────────────────────
# 1. Liberações -> movimentos
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Movimento:
    indice: int
    data: str  # dd/mm/aaaa (São Paulo) da liberação
    tipo_operacao: str
    descricao_mp: str  # DESCRIPTION do relatório
    id_pagamento: str  # SOURCE_ID: a "operação relacionada" do extrato
    id_pedido: str
    id_pacote: str
    valor: Decimal
    linha_relatorio: int  # linha do relatório de liberações (1 = primeira de dados)
    data_hora: str = ""  # DATE do relatório como veio (com hora): parte da chave estável
    ocorrencia: int = 0  # n-ésimo movimento com a mesma chave base neste relatório
    numero_movimento: str = ""  # Número do movimento no extrato/relatório
    id_operacao_original: str = ""  # Número da operação original quando cashback_{op}
    id_final: str = ""  # ID_FINAL como na planilha concatenada (pack, pedido ou cashback_{op})
    mlb: str = ""  # Código de anúncio MLB no Mercado Livre
    nome_cliente: str = ""
    cpf_cnpj: str = ""
    casou_por: str = CASOU_NENHUM
    id_conta_receber: str = ""
    status_conta_tiny: str = ""
    valor_tiny: Optional[Decimal] = None
    saldo_tiny: Optional[Decimal] = None
    valor_pago_tiny: Optional[Decimal] = None
    situacao: str = ""

    @property
    def id_venda(self) -> str:
        """Número da venda no Tiny (pedido no e-commerce): pacote, pedido ou operação original de cashback."""
        venda = self.id_pacote or self.id_pedido
        if not venda and self.id_operacao_original:
            return self.id_operacao_original
        return venda

    @property
    def chave(self) -> str:
        """
        Identifica o movimento entre execuções (evita baixar duas vezes a mesma liberação).
        Não usa a linha do relatório: ela muda quando o período é reprocessado com outras datas,
        e a mesma liberação parecia nova (baixa dupla em conta parcial — ML-1, 2026-10-07).
        """
        return (
            f"v2|{self.id_pagamento}|{self.data_hora or self.data}|{self.tipo_operacao}"
            f"|{self.valor.quantize(_CENTAVO)}|{self.ocorrencia}"
        )

    @property
    def prefixo_legado(self) -> str:
        """Chave antiga (até 2026-10-07) sem a linha do relatório: reconhece baixas já registradas."""
        return f"{self.id_pagamento}|{self.data}|{self.tipo_operacao}|{self.valor.quantize(_CENTAVO)}|"


def prefixos_legado(baixas: Dict[str, str]) -> Set[str]:
    """Chaves antigas do registro de baixas sem o último campo (a linha do relatório)."""
    return {k.rsplit("|", 1)[0] + "|" for k in baixas if not k.startswith("v2|") and k.count("|") == 4}


def ja_baixado(chave: str, prefixo: str, baixas: Dict[str, str], legado: Optional[Set[str]] = None) -> bool:
    if chave in baixas:
        return True
    if legado is None:
        legado = prefixos_legado(baixas)
    return bool(prefixo) and prefixo in legado


def _registro_chave(reg: Dict[str, Any]) -> Tuple:
    return tuple(sorted((k, str(v)) for k, v in reg.items()))


def expandir_liberacoes(registros: Sequence[Dict[str, Any]]) -> List[Movimento]:
    """
    Linhas do relatório de Liberações -> movimentos. Saldos (initial_available_balance etc.) e
    linhas repetidas saem. A liberação de uma venda vira Recebimento + custos (ver docstring).
    """
    movimentos: List[Movimento] = []
    vistos: Set[Tuple] = set()

    for n, reg in enumerate(registros, start=1):
        tipo_registro = _texto(reg.get("RECORD_TYPE")).lower()
        if tipo_registro and tipo_registro != "release":
            continue
        chave = _registro_chave(reg)
        repetida = chave in vistos
        vistos.add(chave)

        descricao = _texto(reg.get("DESCRIPTION"))
        source_id = limpar_id(reg.get("SOURCE_ID") or reg.get("Operação relacionada"))
        ext_ref = limpar_id(reg.get("EXTERNAL_REFERENCE"))
        order_id = limpar_id(reg.get("ORDER_ID"))
        pack_id = limpar_id(reg.get("PACK_ID"))
        mov_id = limpar_id(reg.get("MOVEMENT_ID") or reg.get("Número do movimento") or reg.get("TRANSACTION_ID"))

        raw_id_final = reg.get("ID_FINAL")
        final_norm, op_cashback = normalizar_id_final(raw_id_final) if raw_id_final else ("", None)

        is_cashback = bool(op_cashback) or "cashback" in descricao.lower()
        if is_cashback:
            op_orig = op_cashback or ext_ref or source_id
            id_final = f"cashback_{op_orig}"
            id_operacao_original = op_orig
        else:
            id_final = final_norm or pack_id or order_id
            id_operacao_original = ""

        base = dict(
            data=data_br(data_sp(reg.get("DATE") or reg.get("Data de pagamento"))),
            data_hora=_texto(reg.get("DATE")),
            descricao_mp=descricao,
            id_pagamento=source_id,
            id_pedido=order_id,
            id_pacote=pack_id,
            numero_movimento=mov_id,
            id_operacao_original=id_operacao_original,
            id_final=id_final,
            linha_relatorio=n,
        )

        def novo(tipo: str, valor: Decimal, descricao_mp: Optional[str] = None) -> None:
            dados = dict(base)
            if descricao_mp is not None:
                dados["descricao_mp"] = descricao_mp
            movimentos.append(Movimento(indice=len(movimentos), tipo_operacao=tipo, valor=valor, **dados))

        try:
            credito = abs(valor_estrito(reg.get("NET_CREDIT_AMOUNT")))
            debito = abs(valor_estrito(reg.get("NET_DEBIT_AMOUNT")))
            bruto = abs(valor_estrito(reg.get("GROSS_AMOUNT")))
            custos = [(tipo, abs(valor_estrito(reg.get(coluna)))) for coluna, tipo in COMPONENTES_VENDA]
        except ValueError as e:
            novo(TIPO_VALOR_ILEGIVEL, Decimal("0"), f"{descricao} ({e})")
            continue
        liquido = credito - debito
        if liquido == 0 and not bruto:
            continue
        if repetida:
            novo(TIPO_LINHA_REPETIDA, liquido)
            continue

        if descricao.lower() == "payment" and liquido > 0 and bruto > 0:
            partes: List[Tuple[str, Decimal]] = [(TIPO_RECEBIMENTO, bruto)]
            partes += [(tipo, -custo) for tipo, custo in custos if custo]
            for tipo, valor in partes:
                novo(tipo, valor)
            diferenca = liquido - sum((v for _, v in partes), Decimal("0"))
            if abs(diferenca) >= _CENTAVO:
                novo(TIPO_DIFERENCA, diferenca)
        else:
            novo(tipo_por_descricao(descricao, liquido > 0), liquido)

    # Ocorrência: desempata movimentos com a mesma chave base (mesmo pagamento, instante, tipo e
    # valor) de forma estável entre reprocessamentos.
    contagem: Dict[Tuple, int] = {}
    for mov in movimentos:
        base_chave = (mov.id_pagamento, mov.data_hora or mov.data, mov.tipo_operacao, mov.valor.quantize(_CENTAVO))
        mov.ocorrencia = contagem.get(base_chave, 0)
        contagem[base_chave] = mov.ocorrencia + 1
    return movimentos


# ─────────────────────────────────────────────────────────────────────────────
# 2. Vendas × recebimentos
# ─────────────────────────────────────────────────────────────────────────────


def extrair_mlb_pedido(pedido: Optional[Dict[str, Any]]) -> str:
    """Extrai os códigos de anúncio MLB dos itens do pedido."""
    if not pedido:
        return ""
    items = pedido.get("order_items") or []
    mlbs: List[str] = []
    for it in items:
        item_obj = (it or {}).get("item") or {}
        mlb_id = str(item_obj.get("id") or "").strip()
        if mlb_id and mlb_id not in mlbs:
            mlbs.append(mlb_id)
    return ", ".join(mlbs)


@dataclass
class ItemComparativo:
    id_pagamento: str
    data: str
    valor_liberado: Decimal
    casou_por: str
    id_pedido: str
    id_pacote: str
    id_pedido_relatorio: str
    nome_cliente: str
    status_venda: str
    observacao: str
    mlb: str = ""


def indice_pedidos_ml(pedidos: Iterable[Dict[str, Any]]) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """(ID do pagamento -> pedido, ID do pedido / pacote -> pedido)."""
    por_pagamento: Dict[str, Dict[str, Any]] = {}
    por_pedido: Dict[str, Dict[str, Any]] = {}
    for p in pedidos:
        pid = limpar_id(p.get("id"))
        if not pid:
            continue
        por_pedido[pid] = p
        pack_id = limpar_id(p.get("pack_id"))
        if pack_id:
            por_pedido[pack_id] = p
        for pg in p.get("payments") or []:
            pgid = limpar_id((pg or {}).get("id"))
            if pgid:
                por_pagamento[pgid] = p
    return por_pagamento, por_pedido


def indice_pedidos_tiny(pedidos: Iterable[Dict[str, Any]]) -> Dict[str, Tuple[str, str]]:
    """Número do pedido no e-commerce (e no canal de venda) -> (nome do cliente, CPF/CNPJ)."""
    indice: Dict[str, Tuple[str, str]] = {}
    for p in pedidos:
        ecommerce = p.get("ecommerce") or {}
        cliente = p.get("cliente") or {}
        nome = _texto(cliente.get("nome") or p.get("nomeCliente"))
        documento = _texto(cliente.get("cpfCnpj") or cliente.get("cpf_cnpj") or p.get("cpfCnpj"))
        if not nome:
            continue
        for numero in (
            ecommerce.get("numeroPedidoEcommerce"),
            ecommerce.get("numeroPedidoCanalVenda"),
            p.get("numeroPedidoEcommerce"),
        ):
            n = limpar_id(numero)
            if n and n not in indice:
                indice[n] = (nome, documento)
        # Se houver pagamentos ou observações citando operações, também indexa
        obs = _texto(p.get("observacoes") or p.get("obs"))
        if obs:
            for op in re.findall(r"\b\d{9,16}\b", obs):
                if op not in indice:
                    indice[op] = (nome, documento)
    return indice


def cruzar_vendas(
    movimentos: List[Movimento],
    pedidos_ml: Iterable[Dict[str, Any]],
    pedidos_tiny: Iterable[Dict[str, Any]],
) -> List[ItemComparativo]:
    """
    Liga cada movimento à venda (pelo ID do pagamento; senão pelo pedido do relatório) e ao
    cliente do Tiny. Devolve o comparativo unificado por venda.
    """
    por_pagamento, por_pedido = indice_pedidos_ml(pedidos_ml)
    clientes = indice_pedidos_tiny(pedidos_tiny)

    agrupados: Dict[str, List[Movimento]] = {}
    pedido_do_relatorio: Dict[int, str] = {}
    status_da_venda: Dict[int, str] = {}
    for mov in movimentos:
        pedido_relatorio = mov.id_pedido
        pacote_relatorio = mov.id_pacote
        pedido = por_pagamento.get(mov.id_pagamento) if mov.id_pagamento else None
        # Se for cashback ou operação com referência original e não achou direto:
        if pedido is None and mov.id_operacao_original and mov.id_operacao_original in por_pagamento:
            pedido = por_pagamento[mov.id_operacao_original]
            mov.casou_por = CASOU_PAGAMENTO
        elif pedido is not None:
            mov.casou_por = CASOU_PAGAMENTO
        elif pedido_relatorio and pedido_relatorio in por_pedido:
            pedido = por_pedido[pedido_relatorio]
            mov.casou_por = CASOU_PEDIDO
        elif pacote_relatorio and pacote_relatorio in por_pedido:
            pedido = por_pedido[pacote_relatorio]
            mov.casou_por = CASOU_PEDIDO
        else:
            mov.casou_por = CASOU_NENHUM

        if pedido is not None:
            mov.id_pedido = limpar_id(pedido.get("id"))
            mov.id_pacote = limpar_id(pedido.get("pack_id")) or mov.id_pacote
            mov.mlb = extrair_mlb_pedido(pedido)
            if not mov.id_final:
                mov.id_final = mov.id_pacote or mov.id_pedido

        for numero in (mov.id_pacote, mov.id_pedido, mov.id_operacao_original, mov.id_pagamento):
            if numero and numero in clientes:
                mov.nome_cliente, mov.cpf_cnpj = clientes[numero]
                break

        componentes_nomes = (
            "Tarifa de venda", "Custos de parcelamento", "Tarifa de envio",
            "Impostos retidos", "Desconto para a sua contraparte",
        )
        if (mov.tipo_operacao in TIPOS_RECEBIMENTO or mov.tipo_operacao in componentes_nomes) and mov.id_venda:
            chave_comp = f"venda_{mov.id_venda}"
        else:
            chave_comp = mov.id_pagamento or f"__linha_{mov.linha_relatorio}"
        agrupados.setdefault(chave_comp, []).append(mov)
        pedido_do_relatorio[mov.indice] = pedido_relatorio
        status_da_venda[mov.indice] = _texto((pedido or {}).get("status"))

    comparativo: List[ItemComparativo] = []
    for _, movs in agrupados.items():
        primeiro = movs[0]
        casou = next((m.casou_por for m in movs if m.casou_por != CASOU_NENHUM), primeiro.casou_por)
        nome_cli = next((m.nome_cliente for m in movs if m.nome_cliente), primeiro.nome_cliente)
        status_v = next((status_da_venda[m.indice] for m in movs if status_da_venda.get(m.indice)), "")
        mlb_v = next((m.mlb for m in movs if m.mlb), primeiro.mlb)
        id_ped = next((m.id_pedido for m in movs if m.id_pedido), primeiro.id_pedido)
        id_pac = next((m.id_pacote for m in movs if m.id_pacote), primeiro.id_pacote)
        relatorio = next((pedido_do_relatorio[m.indice] for m in movs if pedido_do_relatorio.get(m.indice)), "")
        pags = list(dict.fromkeys(m.id_pagamento for m in movs if m.id_pagamento))
        id_pag_txt = ", ".join(pags) if pags else primeiro.id_pagamento

        obs: List[str] = []
        if casou == CASOU_NENHUM:
            obs.append(
                "Pagamento sem venda no Mercado Livre (tarifa avulsa, publicidade, saque ou venda fora do período buscado)."
                if not id_ped
                else "Pedido do relatório não encontrado no Mercado Livre."
            )
        elif casou == CASOU_PEDIDO:
            obs.append("Venda localizada só pelo pedido do relatório: o pagamento não consta no pedido do Mercado Livre.")
        if relatorio and id_ped and relatorio != id_ped:
            obs.append(f"Pedido do relatório ({relatorio}) diferente do pedido do pagamento ({id_ped}).")
        if casou != CASOU_NENHUM and not nome_cli:
            obs.append(f"Venda {primeiro.id_venda} não encontrada nos pedidos do Tiny.")

        comparativo.append(
            ItemComparativo(
                id_pagamento=id_pag_txt,
                data=primeiro.data,
                valor_liberado=sum((m.valor for m in movs), Decimal("0")),
                casou_por=casou,
                id_pedido=id_ped,
                id_pacote=id_pac,
                id_pedido_relatorio=relatorio,
                nome_cliente=nome_cli,
                status_venda=status_v,
                observacao=" ".join(obs),
                mlb=mlb_v,
            )
        )
    return comparativo


def pedidos_a_buscar(movimentos: Sequence[Movimento], pedidos_ml: Iterable[Dict[str, Any]]) -> List[str]:
    """Pedidos citados no relatório que não vieram na busca por período (venda mais antiga)."""
    por_pagamento, por_pedido = indice_pedidos_ml(pedidos_ml)
    faltando: Dict[str, None] = {}
    for mov in movimentos:
        if mov.id_pagamento in por_pagamento:
            continue
        if mov.id_pedido and mov.id_pedido not in por_pedido:
            faltando[mov.id_pedido] = None
        elif mov.id_pacote and mov.id_pacote not in por_pedido:
            faltando[mov.id_pacote] = None
    return list(faltando)


# ─────────────────────────────────────────────────────────────────────────────
# 3. Recebimentos -> baixa no Contas a Receber do Tiny
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class GrupoRecebimento:
    id: str
    id_venda: str
    indices: List[int]
    chaves: List[str]
    valor_total: Decimal
    data: str
    nome_cliente: str
    id_operacao: str = ""
    mlb: str = ""
    situacao: str = ""
    mensagem: str = ""
    conta_id: Optional[int] = None
    conta_situacao: str = ""
    conta_historico: str = ""
    conta_valor: Optional[Decimal] = None
    conta_saldo: Optional[Decimal] = None
    conta_valor_pago: Optional[Decimal] = None
    baixado_em: str = ""
    prefixos_legado: List[str] = field(default_factory=list)
    chaves_produtos: List[str] = field(default_factory=list)
    prefixos_produtos_legado: List[str] = field(default_factory=list)
    contas_vinculadas: List[Dict[str, Any]] = field(default_factory=list)
    valor_produtos: Decimal = Decimal("0")
    valor_frete: Decimal = Decimal("0")
    # Custos de parcelamento da mesma venda (positivo) e as linhas deles. Na venda parcelada COM
    # juros, o bruto liberado inclui os juros pagos pelo comprador e a conta do Tiny tem só o
    # preço: a baixa é o bruto menos esses custos (ver `avaliar_conta`).
    valor_parcelamento: Decimal = Decimal("0")
    indices_parcelamento: List[int] = field(default_factory=list)
    parcelamento_descontado: bool = False

    def ja_baixado(self, baixas: Dict[str, str], legado: Optional[Set[str]] = None) -> bool:
        """Todos os recebimentos do grupo já estão no registro (chave nova ou antiga), ou chaves de produto já baixadas (I2)."""
        if not self.chaves:
            return False
        legado = prefixos_legado(baixas) if legado is None else legado
        prefixos = self.prefixos_legado or [""] * len(self.chaves)
        if all(ja_baixado(c, p, baixas, legado) for c, p in zip(self.chaves, prefixos)):
            return True
        # I2: Se todas as chaves de produtos já foram baixadas em execução anterior sob chaves antigas
        if self.chaves_produtos:
            pref_prod = self.prefixos_produtos_legado or [""] * len(self.chaves_produtos)
            if all(ja_baixado(c, p, baixas, legado) for c, p in zip(self.chaves_produtos, pref_prod)):
                return True
        return False

    @property
    def apto_baixa(self) -> bool:
        return self.situacao == SIT_APTO_BAIXA and self.conta_id is not None


def obter_grupos(
    movimentos: Sequence[Movimento],
    baixas_feitas: Optional[Dict[str, str]] = None,
    exportados: Optional[Dict[str, str]] = None,
) -> List[GrupoRecebimento]:
    """
    Recebimentos somados por venda (uma baixa por venda no período). `baixas_feitas` (chave do
    movimento -> data da baixa) marca o que esta automação já baixou em outra execução.
    `exportados` (I2) exclui valor de frete já exportado em períodos anteriores para não baixar em dobro.
    """
    baixas_feitas = baixas_feitas or {}
    exportados = exportados or {}
    legado = prefixos_legado(baixas_feitas)
    por_venda: Dict[str, List[Movimento]] = {}
    parcelamento_por_venda: Dict[str, List[Movimento]] = {}
    for mov in movimentos:
        if mov.tipo_operacao == TIPO_CUSTO_PARCELAMENTO and mov.id_venda and mov.valor < 0:
            parcelamento_por_venda.setdefault(mov.id_venda, []).append(mov)
        if mov.tipo_operacao not in TIPOS_RECEBIMENTO:
            continue
        chave = mov.id_venda or f"__sem_id_{mov.indice}"
        por_venda.setdefault(chave, []).append(mov)

    grupos: List[GrupoRecebimento] = []
    for chave in sorted(por_venda):
        itens = por_venda[chave]
        primeira = itens[0]
        op_orig = next((m.id_operacao_original for m in itens if m.id_operacao_original), primeira.id_pagamento)
        mlb_item = next((m.mlb for m in itens if m.mlb), "")
        val_produtos = sum((m.valor for m in itens if m.tipo_operacao == TIPO_RECEBIMENTO), Decimal("0"))
        # I2: Linha de frete cuja chave já foi exportada não entra no valor do grupo
        val_frete = sum(
            (
                m.valor
                for m in itens
                if m.tipo_operacao == TIPO_RECEBIMENTO_FRETE
                and m.chave not in exportados
                and not (m.prefixo_legado and any(k.startswith(m.prefixo_legado) for k in exportados))
            ),
            Decimal("0"),
        )
        chaves_prod = [m.chave for m in itens if m.tipo_operacao == TIPO_RECEBIMENTO]
        pref_prod = [m.prefixo_legado for m in itens if m.tipo_operacao == TIPO_RECEBIMENTO]
        grupo = GrupoRecebimento(
            id=f"G-{primeira.indice}",
            id_venda=primeira.id_venda,
            indices=[m.indice for m in itens],
            chaves=[m.chave for m in itens],
            prefixos_legado=[m.prefixo_legado for m in itens],
            chaves_produtos=chaves_prod,
            prefixos_produtos_legado=pref_prod,
            valor_total=val_produtos + val_frete,
            valor_produtos=val_produtos,
            valor_frete=val_frete,
            data=primeira.data,
            nome_cliente=primeira.nome_cliente,
            id_operacao=op_orig,
            mlb=mlb_item,
        )
        if primeira.id_venda:
            parc = parcelamento_por_venda.get(primeira.id_venda, [])
            grupo.valor_parcelamento = -sum((m.valor for m in parc), Decimal("0"))
            grupo.indices_parcelamento = [m.indice for m in parc]
        if grupo.ja_baixado(baixas_feitas, legado):
            datas = [baixas_feitas[c] for c in grupo.chaves if c in baixas_feitas]
            datas += [v for k, v in baixas_feitas.items() if any(k.startswith(p) for p in grupo.prefixos_legado)]
            grupo.situacao = SIT_CONCILIADO
            grupo.baixado_em = max(datas) if datas else ""
            grupo.mensagem = "Já baixado no Tiny por esta automação em outra execução."
        grupos.append(grupo)
    return grupos


_RE_PARCELA = re.compile(r"parcela\s+(\d+)/\d+", re.IGNORECASE)


def numero_parcela(conta: Dict[str, Any]) -> int:
    m = _RE_PARCELA.search(str(conta.get("historico") or ""))
    return int(m.group(1)) if m else 0


def historico_cita_venda(historico: str, id_venda: str, id_operacao: str = "") -> bool:
    """O número da venda ou da operação (ex: cashback) aparece no histórico, sem estar colado a outros dígitos."""
    hist = historico or ""
    if id_venda and re.search(rf"(?<!\d){re.escape(id_venda)}(?!\d)", hist):
        return True
    if id_operacao and re.search(rf"(?<!\d){re.escape(id_operacao)}(?!\d)", hist):
        return True
    return False


def _situacao_conta(conta: Dict[str, Any]) -> str:
    return str(conta.get("situacao") or "").strip().lower()


def selecionar_contas_da_venda(contas: Sequence[Dict[str, Any]], id_venda: str, id_operacao: str = "") -> List[Dict[str, Any]]:
    """
    Retorna todas as contas que citam a venda (ou operação original), ordenadas pelo número da parcela.
    """
    return sorted(
        (c for c in contas if historico_cita_venda(str(c.get("historico") or ""), id_venda, id_operacao)),
        key=numero_parcela,
    )


def selecionar_conta(contas: Sequence[Dict[str, Any]], id_venda: str, id_operacao: str = "") -> Optional[Dict[str, Any]]:
    """
    Entre as contas que citam a venda (ou operação original): a parcela mais baixa ainda em aberto
    (a venda liberada em partes baixa as parcelas em ordem). Nenhuma em aberto: a de parcela mais baixa,
    só para mostrar a situação (já paga, cancelada...).
    """
    candidatas = selecionar_contas_da_venda(contas, id_venda, id_operacao)
    if not candidatas:
        return None
    abertas = [c for c in candidatas if _situacao_conta(c) in SITUACOES_TINY_BAIXAVEIS]
    return (abertas or candidatas)[0]


def _decimal_ou_none(valor: Any) -> Optional[Decimal]:
    if valor is None or valor == "":
        return None
    return para_decimal(valor)


def _formatar_conta_vinculada(c: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(c["id"]),
        "numero": numero_parcela(c),
        "situacao": _situacao_conta(c),
        "valor": _num(_decimal_ou_none(c.get("valor"))),
        "saldo": _num(_decimal_ou_none(c.get("saldo"))),
        "valor_pago": _num(_decimal_ou_none(c.get("valorPago"))),
        "historico": str(c.get("historico") or ""),
        "vencimento": str(c.get("vencimento") or c.get("dataVencimento") or ""),
    }


def aplicar_contas_ao_grupo(grupo: GrupoRecebimento, contas: Sequence[Dict[str, Any]]) -> None:
    if not contas:
        return
    grupo.contas_vinculadas = [_formatar_conta_vinculada(c) for c in contas]
    abertas = [c for c in contas if _situacao_conta(c) in SITUACOES_TINY_BAIXAVEIS]
    primeira = (abertas or contas)[0]
    grupo.conta_id = int(primeira["id"])
    grupo.conta_situacao = _situacao_conta(primeira)

    if len(contas) == 1:
        grupo.conta_historico = str(contas[0].get("historico") or "")
        grupo.conta_valor = _decimal_ou_none(contas[0].get("valor"))
        grupo.conta_saldo = _decimal_ou_none(contas[0].get("saldo"))
        grupo.conta_valor_pago = _decimal_ou_none(contas[0].get("valorPago"))
    else:
        ids_txt = ", ".join(f"#{c.get('id')}" for c in contas)
        grupo.conta_historico = f"{len(contas)} parcelas ({ids_txt})"
        if any(_decimal_ou_none(c.get("valor")) is None for c in contas):
            grupo.conta_valor = None
        else:
            grupo.conta_valor = sum((para_decimal(c.get("valor")) for c in contas), Decimal("0"))
        grupo.conta_valor_pago = sum((para_decimal(c.get("valorPago")) for c in contas), Decimal("0"))
        # S2: Se qualquer parcela em aberto não tiver saldo nem valor informado pelo Tiny, saldo é desconhecido (None)
        if any(_decimal_ou_none(c.get("saldo")) is None and _decimal_ou_none(c.get("valor")) is None for c in abertas):
            grupo.conta_saldo = None
        else:
            saldos = []
            for c in abertas:
                s = _decimal_ou_none(c.get("saldo"))
                if s is None:
                    v = _decimal_ou_none(c.get("valor")) or Decimal("0")
                    vp = _decimal_ou_none(c.get("valorPago")) or Decimal("0")
                    s = v - vp
                saldos.append(s)
            grupo.conta_saldo = sum(saldos, Decimal("0")) if abertas else Decimal("0")


def aplicar_conta_ao_grupo(grupo: GrupoRecebimento, conta: Dict[str, Any]) -> None:
    aplicar_contas_ao_grupo(grupo, [conta])


def _restaurar_parcelamento(grupo: GrupoRecebimento) -> None:
    """Volta o grupo ao valor bruto (a avaliação pode rodar de novo: análise, visão consolidada, baixa)."""
    if grupo.parcelamento_descontado:
        grupo.valor_produtos += grupo.valor_parcelamento
        grupo.valor_total += grupo.valor_parcelamento
        grupo.parcelamento_descontado = False


def avaliar_conta(grupo: GrupoRecebimento) -> None:
    """Situação do grupo pela conta localizada: apta, já baixada no Tiny ou valor acima do saldo."""
    _restaurar_parcelamento(grupo)
    if grupo.conta_situacao not in SITUACOES_TINY_BAIXAVEIS:
        grupo.situacao = f"STATUS: {grupo.conta_situacao.upper() or 'DESCONHECIDO'}"
        grupo.mensagem = "Conta já não está em aberto no Tiny: não requer baixa."
        return
    em_aberto = grupo.conta_saldo
    if em_aberto is None and grupo.conta_valor is not None:
        em_aberto = grupo.conta_valor - (grupo.conta_valor_pago or Decimal("0"))
    if em_aberto is None:
        # Sem saldo nem valor da conta não dá para saber se a baixa cabe (ML-6): não fica apta.
        grupo.situacao = SIT_SALDO_DESCONHECIDO
        grupo.mensagem = "O Tiny não informou o saldo nem o valor da conta: confira antes de baixar à mão."
        return
    tolerancia = Decimal("0.05") if len(grupo.contas_vinculadas) > 1 else _CENTAVO
    parcelamento = grupo.valor_parcelamento or Decimal("0")
    if (
        grupo.valor_total - em_aberto >= tolerancia
        and parcelamento > 0
        and parcelamento <= grupo.valor_produtos
        and abs(grupo.valor_total - parcelamento - em_aberto) < tolerancia
    ):
        # Parcelado com juros: o excedente é exatamente o custo de parcelamento repassado ao MP.
        bruto = grupo.valor_total
        grupo.valor_produtos -= parcelamento
        grupo.valor_total -= parcelamento
        grupo.parcelamento_descontado = True
        grupo.situacao = SIT_APTO_BAIXA
        grupo.mensagem = (
            f"Recebido R$ {bruto.quantize(_CENTAVO)} inclui R$ {parcelamento.quantize(_CENTAVO)} de custos de "
            f"parcelamento (juros do comprador): baixa de R$ {grupo.valor_total.quantize(_CENTAVO)}, igual ao saldo."
        )
        return
    if grupo.valor_total - em_aberto >= tolerancia:
        grupo.situacao = SIT_VALOR_DIVERGENTE
        rotulo = "das parcelas" if len(grupo.contas_vinculadas) > 1 else "da conta"
        grupo.mensagem = (
            f"Recebido R$ {grupo.valor_total.quantize(_CENTAVO)} é maior que o saldo em aberto {rotulo} "
            f"(R$ {em_aberto.quantize(_CENTAVO)}). Confira no Tiny antes de baixar à mão."
        )
        return
    grupo.situacao = SIT_APTO_BAIXA
    if len(grupo.contas_vinculadas) > 1:
        abertas_qtd = len([c for c in grupo.contas_vinculadas if c.get("situacao") in SITUACOES_TINY_BAIXAVEIS])
        if em_aberto - grupo.valor_total >= _CENTAVO:
            grupo.mensagem = f"Baixa parcial em {abertas_qtd} parcelas: ficam R$ {(em_aberto - grupo.valor_total).quantize(_CENTAVO)} em aberto."
        else:
            grupo.mensagem = f"Venda parcelada: baixa agrupará {abertas_qtd} parcelas no Tiny totalizando R$ {grupo.valor_total.quantize(_CENTAVO)}."
    else:
        grupo.mensagem = (
            f"Baixa parcial: ficam R$ {(em_aberto - grupo.valor_total).quantize(_CENTAVO)} em aberto."
            if em_aberto - grupo.valor_total >= _CENTAVO
            else ""
        )


ListarContasCliente = Callable[[str], List[Dict[str, Any]]]


def localizar_contas(
    grupos: Sequence[GrupoRecebimento],
    listar_contas_cliente: Optional[ListarContasCliente],
    progresso: Optional[Callable[[str, int, int], None]] = None,
) -> None:
    """
    Preenche a conta do Tiny e a situação de cada grupo (só leitura, nenhuma baixa).
    `listar_contas_cliente(nome)` devolve as contas a receber do cliente em todas as situações;
    None = Tiny indisponível (sem token).
    """
    cache: Dict[str, List[Dict[str, Any]]] = {}
    erros: Dict[str, str] = {}
    pendentes = [g for g in grupos if g.situacao != SIT_CONCILIADO]
    total_clientes = len({g.nome_cliente for g in pendentes if g.nome_cliente})

    for grupo in pendentes:
        if not grupo.nome_cliente:
            grupo.situacao = SIT_SEM_CLIENTE
            grupo.mensagem = (
                "Recebimento sem venda do Mercado Livre ligada ao pagamento."
                if not grupo.id_venda
                else f"Venda {grupo.id_venda} não encontrada nos pedidos do Tiny."
            )
            continue
        if listar_contas_cliente is None:
            grupo.situacao = SIT_TINY_NAO_CONSULTADO
            grupo.mensagem = "Token do Tiny não configurado: conta a receber não consultada."
            continue

        nome = grupo.nome_cliente
        if nome not in cache and nome not in erros:
            if progresso:
                progresso(f"Consultando contas a receber no Tiny: {nome}", len(cache) + len(erros), total_clientes)
            try:
                cache[nome] = listar_contas_cliente(nome)
            except Exception as e:  # erro de API: o grupo fica marcado e a análise segue
                erros[nome] = str(e)
        if nome in erros:
            grupo.situacao = SIT_ERRO_PROCESSAR
            grupo.mensagem = erros[nome]
            continue

        contas = selecionar_contas_da_venda(cache[nome], grupo.id_venda, grupo.id_operacao)
        if not contas:
            grupo.situacao = SIT_NAO_LOCALIZADO
            ref_txt = f"{grupo.id_venda}" + (f" ou operação {grupo.id_operacao}" if grupo.id_operacao and grupo.id_operacao != grupo.id_venda else "")
            grupo.mensagem = f"Nenhuma conta de {nome} cita a venda {ref_txt} no histórico."
            continue
        aplicar_contas_ao_grupo(grupo, contas)
        avaliar_conta(grupo)


def refletir_grupos_nas_linhas(movimentos: List[Movimento], grupos: Iterable[GrupoRecebimento]) -> None:
    por_indice = {m.indice: m for m in movimentos}
    for grupo in grupos:
        for idx in grupo.indices:
            mov = por_indice.get(idx)
            if mov is None:
                continue
            mov.situacao = grupo.situacao
            mov.id_conta_receber = str(grupo.conta_id) if grupo.conta_id else ""
            mov.status_conta_tiny = grupo.conta_situacao
            mov.valor_tiny = grupo.conta_valor
            mov.saldo_tiny = grupo.conta_saldo
            mov.valor_pago_tiny = grupo.conta_valor_pago
            if grupo.mlb and not mov.mlb:
                mov.mlb = grupo.mlb
        if grupo.parcelamento_descontado:
            for idx in grupo.indices_parcelamento:
                mov = por_indice.get(idx)
                if mov is not None:
                    mov.situacao = SIT_DESCONTADO_NA_BAIXA
                    mov.id_conta_receber = str(grupo.conta_id) if grupo.conta_id else ""


# ─────────────────────────────────────────────────────────────────────────────
# 4. Anulações e lançamentos de caixa (notebook V3, célula 9)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Lancamento:
    indice: int
    data: str
    categoria: str
    historico: str
    tipo: str  # "C" | "D"
    valor: Decimal
    contato: str
    cnpj: str
    conta: str
    numero_documento: str
    tipo_operacao: str
    chave: str = ""  # chave do movimento: registra o que já foi exportado para o Tiny (ML-5)
    fluxo: str = ""  # "RECEBIMENTO" (entrada) ou "PAGAMENTO" (saída)


def chave_lancamento(l: Lancamento) -> str:
    """Identifica o lançamento entre execuções (análises antigas não guardavam a chave)."""
    return l.chave or f"{l.numero_documento}|{l.tipo_operacao}|{l.data}|{l.valor.quantize(_CENTAVO)}"


@dataclass
class Pendencia:
    indice: int
    data: str
    tipo_operacao: str
    operacao_relacionada: str
    id_venda: str
    nome_cliente: str
    valor: Decimal
    motivo: str
    fluxo: str = ""  # "RECEBIMENTO" (entrada) ou "PAGAMENTO" (saída)


@dataclass
class ResultadoLancamentos:
    lancamentos: List[Lancamento] = field(default_factory=list)
    pendencias: List[Pendencia] = field(default_factory=list)
    total_anuladas: int = 0


def verificar_anulacoes(movimentos: Sequence[Movimento]) -> Dict[int, str]:
    """
    Movimentos que se anulam mutuamente saem da conciliação de caixa (viram SIT_ANULADA).
    Pares identificados:
    1. Dinheiro retido (-X) e Liberação de dinheiro retido (+X) dentro do mesmo pagamento
       (mesmo que haja tarifas de venda ou frete no mesmo pagamento).
    2. Pagamentos e estornos/cancelamentos opostos dentro do mesmo pagamento.
    3. Grupos com soma total zero.
    4. Fallback: Dinheiro retido e Liberação de dinheiro retido de mesmo valor na mesma data.
    Movimentos de reserva ou pagamento sem par que os anule viram SIT_VERIFICAR.
    """
    fora = TIPOS_IGNORAR_LANCAMENTO + (TIPO_VALOR_ILEGIVEL, TIPO_LINHA_REPETIDA)
    elegiveis = [m for m in movimentos if m.tipo_operacao not in fora and m.situacao != SIT_DESCONTADO_NA_BAIXA]
    por_operacao: Dict[str, List[Movimento]] = {}
    for mov in elegiveis:
        chave_op = mov.id_pagamento or mov.id_final or f"__linha_{mov.linha_relatorio}"
        por_operacao.setdefault(chave_op, []).append(mov)

    marcas: Dict[int, str] = {}
    for chave_op, grupo in por_operacao.items():
        # 1. Matching de Reservas (Dinheiro retido vs Liberação de dinheiro retido)
        debitos_reserva = [m for m in grupo if m.tipo_operacao == TIPO_RESERVA[1]]
        creditos_reserva = [m for m in grupo if m.tipo_operacao == TIPO_RESERVA[0]]

        usados_crd: Set[int] = set()
        for deb in debitos_reserva:
            if deb.indice in marcas or deb.situacao:
                continue
            for crd in creditos_reserva:
                if crd.indice in marcas or crd.indice in usados_crd or crd.situacao:
                    continue
                if abs(deb.valor + crd.valor).quantize(_CENTAVO) == 0:
                    marcas[deb.indice] = SIT_ANULADA
                    marcas[crd.indice] = SIT_ANULADA
                    usados_crd.add(crd.indice)
                    break

        # 2. Matching de Pagamentos opostos (ex: Pagamento débito vs Pagamento crédito / estorno)
        debitos_pag = [
            m for m in grupo
            if m.tipo_operacao == "Pagamento" and m.valor < 0 and m.indice not in marcas and not m.situacao
        ]
        creditos_pag = [
            m for m in grupo
            if m.tipo_operacao in ("Pagamento", TIPO_RECEBIMENTO, "Cancelamento de devolução")
            and m.valor > 0
            and m.indice not in marcas
            and not m.situacao
        ]
        usados_pag_crd: Set[int] = set()
        for deb in debitos_pag:
            for crd in creditos_pag:
                if crd.indice in marcas or crd.indice in usados_pag_crd:
                    continue
                if abs(deb.valor + crd.valor).quantize(_CENTAVO) == 0:
                    marcas[deb.indice] = SIT_ANULADA
                    marcas[crd.indice] = SIT_ANULADA
                    usados_pag_crd.add(crd.indice)
                    break

        # 3. Se os restantes do grupo (não anulados) somam zero:
        restantes = [m for m in grupo if m.indice not in marcas and not m.situacao]
        if len(restantes) >= 2:
            soma = sum((m.valor for m in restantes), Decimal("0"))
            if soma.quantize(_CENTAVO) == 0:
                for outro in restantes:
                    marcas[outro.indice] = SIT_ANULADA

        # 4. Movimentos de TIPOS_VERIFICAR_ANULACAO que não casaram no grupo:
        for m in grupo:
            if m.indice not in marcas and not m.situacao:
                if m.tipo_operacao in TIPOS_VERIFICAR_ANULACAO:
                    marcas[m.indice] = SIT_VERIFICAR

    # 5. Fallback entre operações diferentes (ex: SOURCE_ID ausente em uma das linhas no relatório)
    reservas_deb_soltas = [
        m for m in elegiveis if m.tipo_operacao == TIPO_RESERVA[1] and marcas.get(m.indice) == SIT_VERIFICAR
    ]
    reservas_crd_soltas = [
        m for m in elegiveis if m.tipo_operacao == TIPO_RESERVA[0] and marcas.get(m.indice) == SIT_VERIFICAR
    ]
    usados_crd_soltas: Set[int] = set()
    for deb in reservas_deb_soltas:
        for crd in reservas_crd_soltas:
            if crd.indice in usados_crd_soltas or marcas.get(crd.indice) == SIT_ANULADA:
                continue
            if deb.data == crd.data and abs(deb.valor + crd.valor).quantize(_CENTAVO) == 0:
                # I3: Só anula quando uma das linhas não tem SOURCE_ID (id_pagamento)
                if not deb.id_pagamento or not crd.id_pagamento:
                    marcas[deb.indice] = SIT_ANULADA
                    marcas[crd.indice] = SIT_ANULADA
                    usados_crd_soltas.add(crd.indice)
                    break

    return marcas


def gerar_lancamentos(movimentos: List[Movimento], conta_lancamento: str) -> ResultadoLancamentos:
    """Atualiza `situacao` dos movimentos processados."""
    resultado = ResultadoLancamentos()
    por_indice = {m.indice: m for m in movimentos}
    marcas = verificar_anulacoes(movimentos)
    for idx, marca in marcas.items():
        por_indice[idx].situacao = marca

    def pendente(mov: Movimento, motivo: str) -> None:
        mov.situacao = SIT_VERIFICAR
        fluxo = "RECEBIMENTO" if mov.valor >= 0 else "PAGAMENTO"
        resultado.pendencias.append(
            Pendencia(
                indice=mov.indice,
                data=mov.data,
                tipo_operacao=mov.tipo_operacao,
                operacao_relacionada=mov.id_pagamento,
                id_venda=mov.id_venda,
                nome_cliente=mov.nome_cliente,
                valor=mov.valor,
                motivo=motivo,
                fluxo=fluxo,
            )
        )

    for mov in movimentos:
        tipo = mov.tipo_operacao
        if tipo in TIPOS_IGNORAR_LANCAMENTO or mov.situacao == SIT_DESCONTADO_NA_BAIXA:
            continue
        if mov.situacao == SIT_ANULADA:
            resultado.total_anuladas += 1
            continue
        if mov.situacao == SIT_VERIFICAR:
            if tipo == TIPO_RESERVA[1]:  # Dinheiro retido
                pendente(
                    mov,
                    "Dinheiro retido pelo Mercado Pago aguardando liberação futura (não encontrado par de liberação neste período).",
                )
            elif tipo == TIPO_RESERVA[0]:  # Liberação de dinheiro retido
                pendente(
                    mov,
                    "Liberação de valor retido pelo Mercado Pago (retenção ocorreu em período anterior).",
                )
            elif tipo == "Pagamento":
                pendente(
                    mov,
                    "Pagamento no Mercado Pago sem par correspondente (verifique no extrato do MP).",
                )
            else:
                pendente(mov, f"Movimento '{tipo}' sem par correspondente que o anule no Mercado Pago.")
            continue
        if mov.situacao:
            continue
        if tipo == TIPO_DIFERENCA:
            pendente(mov, "Bruto menos tarifas, frete, impostos e cupom não fecha com o líquido liberado pelo Mercado Pago.")
            continue
        if tipo == TIPO_VALOR_ILEGIVEL:
            pendente(mov, f"Valor ilegível no relatório do Mercado Pago (linha {mov.linha_relatorio}): {mov.descricao_mp}. Confira no extrato.")
            continue
        if tipo == TIPO_LINHA_REPETIDA:
            pendente(mov, f"Linha {mov.linha_relatorio} idêntica a outra do relatório: confira no extrato se são duas operações ou duplicata.")
            continue
        if tipo not in MAPEAMENTO_LANCAMENTOS:
            pendente(mov, f"Tipo de operação sem categoria definida: '{tipo}' (descrição '{mov.descricao_mp}' no Mercado Pago).")
            continue

        categoria, modelo = MAPEAMENTO_LANCAMENTOS[tipo]
        historico = modelo.format(mlb=mov.id_venda, op=mov.id_pagamento) + f" - {tipo}"
        if tipo == "Pagamento":
            contato, cnpj = CONTATO_PUBLICIDADE
        elif not mov.nome_cliente:
            if tipo not in TIPOS_SEM_CLIENTE:
                if not mov.id_venda:
                    motivo = "Não encontrado par no Mercado Livre (venda/pedido não localizado no ML para obter dados do cliente)."
                else:
                    motivo = f"Não encontrado par no Tiny (pedido da venda {mov.id_venda} não localizado no Tiny para obter cliente e CPF/CNPJ)."
                pendente(mov, motivo)
                continue
            contato, cnpj = "", ""
        elif not mov.cpf_cnpj:
            pendente(mov, f"CPF/CNPJ do cliente '{mov.nome_cliente}' não cadastrado no pedido do Tiny.")
            continue
        else:
            contato, cnpj = mov.nome_cliente, mov.cpf_cnpj

        tipo_cd = "C" if mov.valor >= 0 else "D"
        fluxo = "RECEBIMENTO" if mov.valor >= 0 else "PAGAMENTO"
        resultado.lancamentos.append(
            Lancamento(
                indice=mov.indice,
                data=mov.data,
                categoria=categoria,
                historico=historico,
                tipo=tipo_cd,
                valor=abs(mov.valor),
                contato=contato,
                cnpj=cnpj,
                conta=conta_lancamento,
                numero_documento=mov.id_pagamento,
                tipo_operacao=tipo,
                chave=mov.chave,
                fluxo=fluxo,
            )
        )
        mov.situacao = SIT_LANCAMENTO_CRIADO
    return resultado


# ─────────────────────────────────────────────────────────────────────────────
# 5. Saldo por dia
# ─────────────────────────────────────────────────────────────────────────────


def saldo_por_dia(movimentos: Iterable[Movimento], tipos: Optional[Sequence[str]] = None) -> List[Tuple[str, Decimal]]:
    """Soma do valor por data da liberação (ordem cronológica); `tipos=None` = todas as operações."""
    somas: Dict[str, Decimal] = {}
    for mov in movimentos:
        if tipos is not None and mov.tipo_operacao not in tipos:
            continue
        somas[mov.data] = somas.get(mov.data, Decimal("0")) + mov.valor
    return sorted(somas.items(), key=lambda item: _chave_data(item[0]))


# ─────────────────────────────────────────────────────────────────────────────
# Análise completa
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Analise:
    id: str
    empresa_id: str
    empresa_nome: str
    conta_lancamento: str
    criada_em: str
    periodo_de: str  # AAAA-MM-DD
    periodo_ate: str
    origem: str  # "agendada" | "manual"
    execucao_id: str
    movimentos: List[Movimento]
    grupos: List[GrupoRecebimento]
    lancamentos: ResultadoLancamentos
    comparativo: List[ItemComparativo]
    fontes: Dict[str, int]
    tiny_consultado: bool
    avisos: List[str] = field(default_factory=list)


def analisar(
    analise_id: str,
    empresa: EmpresaML,
    liberacoes: Sequence[Dict[str, Any]],
    pedidos_ml: Sequence[Dict[str, Any]],
    pedidos_tiny: Sequence[Dict[str, Any]],
    listar_contas_cliente: Optional[ListarContasCliente],
    periodo: Tuple[date, date],
    origem: str = "manual",
    execucao_id: str = "",
    baixas_feitas: Optional[Dict[str, str]] = None,
    exportados: Optional[Dict[str, str]] = None,
    progresso: Optional[Callable[[str, int, int], None]] = None,
    avisos: Optional[List[str]] = None,
) -> Analise:
    avisos = list(avisos or [])
    if listar_contas_cliente is None:
        avisos.append("Tiny ERP não consultado (token ausente): recebimentos sem situação da conta a receber.")

    if progresso:
        progresso("Cruzando vendas do Mercado Livre com as liberações do Mercado Pago", 0, 0)
    movimentos = expandir_liberacoes(liberacoes)
    comparativo = cruzar_vendas(movimentos, pedidos_ml, pedidos_tiny)

    grupos = obter_grupos(movimentos, baixas_feitas, exportados=exportados)
    localizar_contas(grupos, listar_contas_cliente, progresso)
    refletir_grupos_nas_linhas(movimentos, grupos)

    if progresso:
        progresso("Gerando lançamentos de caixa", 0, 0)
    lancamentos = gerar_lancamentos(movimentos, empresa.conta_lancamento)

    return Analise(
        id=analise_id,
        empresa_id=empresa.id,
        empresa_nome=empresa.nome,
        conta_lancamento=empresa.conta_lancamento,
        criada_em=datetime.now().astimezone().isoformat(timespec="seconds"),
        periodo_de=periodo[0].isoformat(),
        periodo_ate=periodo[1].isoformat(),
        origem=origem,
        execucao_id=execucao_id,
        movimentos=movimentos,
        grupos=grupos,
        lancamentos=lancamentos,
        comparativo=comparativo,
        fontes={
            "liberacoes": len(liberacoes),
            "pedidos_ml": len(pedidos_ml),
            "pedidos_tiny": len(pedidos_tiny),
        },
        tiny_consultado=listar_contas_cliente is not None,
        avisos=avisos,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Persistência (JSON em disco) — Decimal vai como texto para não perder centavos
# ─────────────────────────────────────────────────────────────────────────────


def _para_json(valor: Any) -> Any:
    if isinstance(valor, Decimal):
        return str(valor)
    if isinstance(valor, dict):
        return {k: _para_json(v) for k, v in valor.items()}
    if isinstance(valor, list):
        return [_para_json(v) for v in valor]
    return valor


def _de_json(cls: Any, dados: Dict[str, Any]) -> Any:
    valores = {}
    for f in fields(cls):
        if f.name not in dados:
            continue
        v = dados[f.name]
        tipo = str(f.type)
        if "Decimal" in tipo and v is not None and not isinstance(v, Decimal):
            v = Decimal(str(v))
        valores[f.name] = v
    return cls(**valores)


def analise_para_dict(analise: Analise) -> Dict[str, Any]:
    return _para_json(asdict(analise))


def analise_de_dict(dados: Dict[str, Any]) -> Analise:
    lanc = dados.get("lancamentos") or {}
    return Analise(
        id=dados["id"],
        empresa_id=dados["empresa_id"],
        empresa_nome=dados["empresa_nome"],
        conta_lancamento=dados["conta_lancamento"],
        criada_em=dados["criada_em"],
        periodo_de=dados["periodo_de"],
        periodo_ate=dados["periodo_ate"],
        origem=dados.get("origem", "manual"),
        execucao_id=dados.get("execucao_id", ""),
        movimentos=[_de_json(Movimento, m) for m in dados.get("movimentos") or []],
        grupos=[_de_json(GrupoRecebimento, g) for g in dados.get("grupos") or []],
        lancamentos=ResultadoLancamentos(
            lancamentos=[_de_json(Lancamento, l) for l in lanc.get("lancamentos") or []],
            pendencias=[_de_json(Pendencia, p) for p in lanc.get("pendencias") or []],
            total_anuladas=int(lanc.get("total_anuladas") or 0),
        ),
        comparativo=[_de_json(ItemComparativo, c) for c in dados.get("comparativo") or []],
        fontes=dict(dados.get("fontes") or {}),
        tiny_consultado=bool(dados.get("tiny_consultado")),
        avisos=list(dados.get("avisos") or []),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Serialização para a API e planilhas para download
# ─────────────────────────────────────────────────────────────────────────────


def _num(valor: Optional[Decimal]) -> Optional[float]:
    return None if valor is None else float(valor.quantize(_CENTAVO))


def grupo_json(g: GrupoRecebimento) -> Dict[str, Any]:
    return {
        "id": g.id,
        "id_venda": g.id_venda,
        "id_operacao": g.id_operacao,
        "mlb": g.mlb,
        "data": g.data,
        "nome_cliente": g.nome_cliente,
        "valor_total": _num(g.valor_total),
        "valor_produtos": _num(g.valor_produtos),
        "valor_frete": _num(g.valor_frete),
        "quantidade_movimentos": len(g.indices),
        "quantidade_parcelas": len(g.contas_vinculadas) if g.contas_vinculadas else 1,
        "contas_vinculadas": g.contas_vinculadas or [],
        "situacao": g.situacao,
        "mensagem": g.mensagem,
        "apto_baixa": g.apto_baixa,
        "conta_id": g.conta_id,
        "conta_situacao": g.conta_situacao,
        "conta_historico": g.conta_historico,
        "conta_valor": _num(g.conta_valor),
        "conta_saldo": _num(g.conta_saldo),
        "conta_valor_pago": _num(g.conta_valor_pago),
        "baixado_em": g.baixado_em,
    }


def lancamento_json(l: Lancamento) -> Dict[str, Any]:
    fluxo = l.fluxo or ("RECEBIMENTO" if l.tipo == "C" else "PAGAMENTO")
    return {**asdict(l), "valor": _num(l.valor), "fluxo": fluxo}


def pendencia_json(p: Pendencia) -> Dict[str, Any]:
    fluxo = p.fluxo or ("RECEBIMENTO" if p.valor >= 0 else "PAGAMENTO")
    return {**asdict(p), "valor": _num(p.valor), "fluxo": fluxo}


def comparativo_json(c: ItemComparativo) -> Dict[str, Any]:
    return {**asdict(c), "valor_liberado": _num(c.valor_liberado)}


def resumo(analise: Analise) -> Dict[str, Any]:
    grupos = analise.grupos
    por_situacao: Dict[str, int] = {}
    for g in grupos:
        por_situacao[g.situacao] = por_situacao.get(g.situacao, 0) + 1
    aptos = [g for g in grupos if g.apto_baixa]
    lanc = analise.lancamentos.lancamentos
    casamentos: Dict[str, int] = {}
    for c in analise.comparativo:
        casamentos[c.casou_por] = casamentos.get(c.casou_por, 0) + 1

    # Separação clara de Entradas (Recebimentos MP) e Saídas (Pagamentos MP)
    recebimentos_movs = [m for m in analise.movimentos if m.valor > 0]
    pagamentos_movs = [m for m in analise.movimentos if m.valor < 0]
    total_recebimentos_mp = len(recebimentos_movs)
    valor_recebimentos_mp = sum((m.valor for m in recebimentos_movs), Decimal("0"))
    total_pagamentos_mp = len(pagamentos_movs)
    valor_pagamentos_mp = sum((abs(m.valor) for m in pagamentos_movs), Decimal("0"))

    return {
        "total_movimentos": len(analise.movimentos),
        "total_grupos": len(grupos),
        "grupos_por_situacao": por_situacao,
        "aptos_baixa": len(aptos),
        "valor_aptos_baixa": _num(sum((g.valor_total for g in aptos), Decimal("0"))),
        "conciliados": por_situacao.get(SIT_CONCILIADO, 0),
        "total_lancamentos": len(lanc),
        "valor_creditos": _num(sum((l.valor for l in lanc if l.tipo == "C"), Decimal("0"))),
        "valor_debitos": _num(sum((l.valor for l in lanc if l.tipo == "D"), Decimal("0"))),
        "total_anuladas": analise.lancamentos.total_anuladas,
        "total_pendencias": len(analise.lancamentos.pendencias),
        "valor_recebimentos": _num(
            sum((m.valor for m in analise.movimentos if m.tipo_operacao in TIPOS_RECEBIMENTO), Decimal("0"))
        ),
        "valor_liquido": _num(sum((m.valor for m in analise.movimentos), Decimal("0"))),
        "total_recebimentos_mp": total_recebimentos_mp,
        "valor_recebimentos_mp": _num(valor_recebimentos_mp),
        "total_pagamentos_mp": total_pagamentos_mp,
        "valor_pagamentos_mp": _num(valor_pagamentos_mp),
        "pagamentos": len(analise.comparativo),
        "pagamentos_por_casamento": casamentos,
        "pagamentos_com_observacao": sum(1 for c in analise.comparativo if c.observacao),
    }


def analise_resumo_json(analise: Analise) -> Dict[str, Any]:
    """Cabeçalho da análise (listagens), sem as linhas."""
    return {
        "analise_id": analise.id,
        "empresa": analise.empresa_id,
        "empresa_nome": analise.empresa_nome,
        "criada_em": analise.criada_em,
        "periodo_de": analise.periodo_de,
        "periodo_ate": analise.periodo_ate,
        "origem": analise.origem,
        "execucao_id": analise.execucao_id,
        "fontes": analise.fontes,
        "tiny_consultado": analise.tiny_consultado,
        "avisos": analise.avisos,
        "resumo": resumo(analise),
    }


def analise_json(analise: Analise) -> Dict[str, Any]:
    return {
        **analise_resumo_json(analise),
        "grupos": [grupo_json(g) for g in analise.grupos],
        "lancamentos": [lancamento_json(l) for l in analise.lancamentos.lancamentos],
        "pendencias": [pendencia_json(p) for p in analise.lancamentos.pendencias],
        "comparativo": [comparativo_json(c) for c in analise.comparativo],
        "saldo_recebimentos_dia": [
            {"data": d, "valor": _num(v)} for d, v in saldo_por_dia(analise.movimentos, TIPOS_RECEBIMENTO)
        ],
        "saldo_total_dia": [{"data": d, "valor": _num(v)} for d, v in saldo_por_dia(analise.movimentos)],
    }


TIPOS_ARQUIVO = {
    "relatorio": "RELATÓRIO CONCILIAÇÃO ML",
    "lancamentos": "LANÇAMENTOS DE CAIXA ML",
    "vendas-recebimentos": "VENDAS X RECEBIMENTOS ML",
    "saldo-recebimentos": "SALDO POR DIA RECEBIMENTOS ML",
    "saldo-total": "SALDO TOTAL POR DIA ML",
}

_ROTULO_CASAMENTO = {
    CASOU_PAGAMENTO: "Pelo ID do pagamento",
    CASOU_PEDIDO: "Pelo pedido do relatório",
    CASOU_NENHUM: "Sem venda",
}


def _planilha(cabecalho: Sequence[str], linhas: Iterable[Sequence[Any]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Planilha1"
    ws.append(list(cabecalho))
    for linha in linhas:
        ws.append([float(v) if isinstance(v, Decimal) else v for v in linha])
        # SEC-03: o openpyxl grava como fórmula todo texto que começa com "=". Nomes de cliente e
        # descrições vêm do Mercado Livre/Tiny (preenchidos por terceiros): força tipo texto, que
        # o Excel nunca avalia, sem mudar o que aparece na célula.
        for celula in ws[ws.max_row]:
            if celula.data_type == "f":
                celula.data_type = "s"
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def gerar_arquivo(analise: Analise, tipo: str, excluir_lancamentos: Optional[Set[str]] = None) -> Tuple[str, bytes]:
    """(nome do arquivo, conteúdo xlsx). `excluir_lancamentos`: chaves já exportadas (só "lancamentos")."""
    if tipo not in TIPOS_ARQUIVO:
        raise KeyError(tipo)
    periodo = analise.periodo_de if analise.periodo_de == analise.periodo_ate else f"{analise.periodo_de} a {analise.periodo_ate}"
    nome = f"{TIPOS_ARQUIVO[tipo]} {analise.empresa_nome.upper()} {periodo}.xlsx"

    if tipo == "relatorio":
        # Reflete as colunas da planilha concatenada e campos de auditoria
        conteudo = _planilha(
            [
                "Data de pagamento", "Tipo de operação", "Número do movimento", "Operação relacionada",
                "ID_FINAL", "Nome do cliente", "Valor", "Situação", "MLB",
                "Descrição Mercado Pago", "ID do pedido", "ID do pacote", "Venda localizada", "CPF/CNPJ",
                "ID_CONTA_RECEBER", "STATUS_CONTA_TINY", "VALOR_TINY", "SALDO_TINY", "VALOR_PAGO_TINY",
            ],
            (
                [
                    m.data, m.tipo_operacao, m.numero_movimento or m.linha_relatorio, m.id_pagamento,
                    m.id_final or m.id_venda, m.nome_cliente, m.valor, m.situacao, m.mlb,
                    m.descricao_mp, m.id_pedido, m.id_pacote,
                    _ROTULO_CASAMENTO.get(m.casou_por, m.casou_por), m.cpf_cnpj,
                    m.id_conta_receber, m.status_conta_tiny, m.valor_tiny, m.saldo_tiny, m.valor_pago_tiny,
                ]
                for m in analise.movimentos
            ),
        )
    elif tipo == "lancamentos":
        # Layout de importação de lançamentos de caixa do Tiny (colunas do notebook V3).
        conteudo = _planilha(
            ["Data", "Categoria", "Histórico", "Tipo", "Valor", "Id", "Contato", "CNPJ", "Marcadores", "Conta", "Nº do documento"],
            (
                [l.data, l.categoria, l.historico, l.tipo, l.valor, "", l.contato, l.cnpj, "", l.conta, l.numero_documento]
                for l in analise.lancamentos.lancamentos
                if not excluir_lancamentos or chave_lancamento(l) not in excluir_lancamentos
            ),
        )
    elif tipo == "vendas-recebimentos":
        conteudo = _planilha(
            [
                "Data da liberação", "ID do pagamento", "Valor liberado (líquido)", "Venda localizada", "ID do pedido",
                "ID do pacote", "MLB", "Pedido no relatório MP", "Situação da venda no ML", "Cliente (Tiny)", "Observação",
            ],
            (
                [
                    c.data, c.id_pagamento, c.valor_liberado, _ROTULO_CASAMENTO.get(c.casou_por, c.casou_por),
                    c.id_pedido, c.id_pacote, c.mlb, c.id_pedido_relatorio, c.status_venda, c.nome_cliente, c.observacao,
                ]
                for c in analise.comparativo
            ),
        )
    elif tipo == "saldo-recebimentos":
        conteudo = _planilha(["Data da liberação", "Saldo do Dia"], saldo_por_dia(analise.movimentos, TIPOS_RECEBIMENTO))
    else:
        conteudo = _planilha(["Data da liberação", "Saldo do Dia"], saldo_por_dia(analise.movimentos))
    return nome, conteudo
