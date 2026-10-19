"""
Motor de conciliação fiscal e bancária: Banco Inter x Tiny ERP (Contas a Pagar).

Compara pagamentos efetuados no extrato do Banco Inter com as contas em aberto no Tiny ERP v3:
1. Casamento por Código de Barras / Linha Digitável (100% de confiança);
2. Casamento por CNPJ/CPF + Valor Nominal + Vencimento próximo (95% de confiança);
3. Casamento por CNPJ/CPF + Valor com Juros/Multa/Desconto (85% de confiança);
4. Casamento por Nome do Fornecedor + Valor Nominal (75% de confiança).

Gera previsões estruturadas para revisão humana e orquestra a baixa assistida no Tiny.
"""
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import Enum
import logging
import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

from app.boleto import parse_boleto
from app.inter_client import INTER_EMPRESAS, InterClient, InterTransacao, _clean_digits, _parse_date, _to_decimal
from app.tiny_client import TinyClient

logger = logging.getLogger("automacao_nfe.reconciliation")

EMPRESA_LABELS: Dict[str, str] = {
    "fabrilux": "Fabrilux",
    "revesta": "Revesta",
    "norvia_campinas": "Norvia Campinas",
    "norvia_curitiba": "Norvia Curitiba",
}


class MatchMethod(str, Enum):
    CODIGO_BARRAS = "CODIGO_BARRAS"           # 100% confiança
    CNPJ_VALOR_DATA = "CNPJ_VALOR_DATA"       # 95% confiança
    DOCUMENTO_VALOR = "DOCUMENTO_VALOR"       # 90% confiança
    CNPJ_VALOR = "CNPJ_VALOR"                 # 85% confiança
    NOME_VALOR = "NOME_VALOR"                 # 80% confiança
    VALOR_DATA_UNICO = "VALOR_DATA_UNICO"     # 70% confiança


@dataclass
class ReconciliationMatch:
    """Representa um casamento confirmado entre um pagamento do Inter e uma conta do Tiny."""
    id: str
    empresa: str
    empresa_nome: str
    conta_pagar_id: int
    numero_documento: str
    fornecedor_nome: str
    fornecedor_cnpj: Optional[str]
    data_vencimento: date
    valor_tiny: Decimal

    inter_transacao_id: str
    tipo_transacao_inter: str
    data_pagamento: date
    valor_pago: Decimal
    valor_original_inter: Optional[Decimal]
    juros: Decimal = Decimal("0.00")
    multa: Decimal = Decimal("0.00")
    desconto: Decimal = Decimal("0.00")

    codigo_barras: Optional[str] = None
    metodo_match: MatchMethod = MatchMethod.CODIGO_BARRAS
    confianca: float = 1.0
    motivo: str = ""
    status_tiny: str = "aberto"
    conta_origem_id: Optional[int] = None
    historico_sugerido: str = ""


@dataclass
class ReconciliationSummary:
    total_casados: int
    valor_total_casados: Decimal
    total_inter_sem_par: int
    valor_inter_sem_par: Decimal
    total_tiny_sem_par: int
    valor_tiny_sem_par: Decimal


@dataclass
class ReconciliationResult:
    empresa: str
    data_inicio: date
    data_fim: date
    matches: List[ReconciliationMatch]
    unmatched_inter: List[InterTransacao]
    unmatched_tiny: List[Dict[str, Any]]
    summary: ReconciliationSummary


def _normalize_name(name: Optional[str]) -> str:
    """Normaliza nome de fornecedor/favorecido para comparação tolerante."""
    if not name:
        return ""
    # Remove acentos
    n = unicodedata.normalize("NFD", str(name)).encode("ascii", "ignore").decode("utf-8")
    # Apenas alfanuméricos e espaços
    n = re.sub(r"[^a-zA-Z0-9\s]", " ", n.upper())
    # Remove sufixos societários comuns
    stopwords = {
        "LTDA", "ME", "EPP", "EIRELI", "S", "A", "SA", "CIA",
        "COMERCIO", "DISTRIBUIDORA", "DISTRIBUICAO", "DE", "E", "DO", "DA",
        "SERVICOS", "INDUSTRIA", "MATERIAIS", "TRANSPORTES", "SOLUCOES"
    }
    words = [w for w in n.split() if w and w not in stopwords]
    return " ".join(words)


def _names_are_similar(name1: Optional[str], name2: Optional[str]) -> bool:
    """Verifica se dois nomes de fornecedor/favorecido correspondem à mesma entidade."""
    if not name1 or not name2:
        return False
    n1 = _normalize_name(name1)
    n2 = _normalize_name(name2)
    if not n1 or not n2:
        return False
    if n1 == n2 or n1 in n2 or n2 in n1:
        return True

    words1 = [w for w in n1.split() if len(w) >= 3]
    words2 = [w for w in n2.split() if len(w) >= 3]
    if not words1 or not words2:
        return False

    common = set(words1).intersection(set(words2))
    if len(common) >= 2:
        return True

    # Se a primeira palavra for forte (>= 4 letras) e coincidir (ex: ALUMIX, QUIMIPOX, COMMAND, SERASA, TELEFONICA)
    if words1[0] == words2[0] and len(words1[0]) >= 4:
        return True

    # Se uma palavra única de 5 ou mais letras coincidir
    if any(len(w) >= 5 and w in words2 for w in words1):
        return True

    return False


def _extract_cnpj_from_tiny(conta: Dict[str, Any]) -> Optional[str]:
    """Extrai CNPJ/CPF do contato ou cliente da conta do Tiny."""
    contato = conta.get("cliente") or conta.get("contato") or {}
    if isinstance(contato, dict):
        cnpj = contato.get("cpfCnpj") or contato.get("cnpj") or contato.get("cpf")
        if cnpj:
            return _clean_digits(cnpj)

    raw_cnpj = conta.get("cpfCnpj") or conta.get("cnpj") or conta.get("cpf")
    if raw_cnpj:
        return _clean_digits(raw_cnpj)

    # Tenta extrair do histórico se houver "CNPJ: XX.XXX..."
    hist = str(conta.get("historico") or "")
    m = re.search(r"\b(\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b", hist)
    if m:
        return _clean_digits(m.group(1))

    return None


def _extract_supplier_name_from_tiny(conta: Dict[str, Any]) -> str:
    contato = conta.get("cliente") or conta.get("contato") or {}
    if isinstance(contato, dict):
        nome = contato.get("nome") or contato.get("nomeFantasia") or contato.get("razaoSocial")
        if nome:
            return str(nome).strip()
    nome = conta.get("nomeCliente") or conta.get("nomeFavorecido") or conta.get("fornecedor")
    if nome:
        return str(nome).strip()
    return "FORNECEDOR NÃO INFORMADO"


# Janela (dias entre vencimento e pagamento) para reconhecer um débito como conta já paga.
JA_BAIXADAS_TOLERANCIA_DIAS = 15


def destino_transferencia_interna(itx: InterTransacao) -> Optional[str]:
    """
    Nome da empresa do grupo que recebeu o débito (mesma raiz de CNPJ de uma das contas Inter,
    ex.: Fabrilux -> Revesta "transferência de saldo para pagamento das contas do dia"), ou None
    se o favorecido é terceiro.
    """
    doc = itx.cpf_cnpj_favorecido or ""
    if len(doc) != 14:
        return None
    por_cnpj = {info["cnpj"]: info["nome"] for info in INTER_EMPRESAS.values()}
    if doc in por_cnpj:
        return por_cnpj[doc]
    for info in INTER_EMPRESAS.values():
        if info["cnpj"][:8] == doc[:8]:
            return itx.nome_favorecido or info["nome"]
    return None


def split_transferencias_internas(
    inter_transacoes: List[InterTransacao],
) -> Tuple[List[InterTransacao], List[Tuple[InterTransacao, str]]]:
    """
    Separa, entre os débitos que NÃO casaram com nenhuma conta do Tiny, os que são transferências
    para empresas do próprio grupo. Aplicar só depois do cruzamento: a transferência pode ter
    conta lançada no Tiny e, nesse caso, precisa ser baixada como qualquer outra.
    Retorna (demais débitos, [(transferência, nome da empresa de destino)]).
    """
    restantes: List[InterTransacao] = []
    transferencias: List[Tuple[InterTransacao, str]] = []
    for itx in inter_transacoes:
        destino = destino_transferencia_interna(itx)
        if destino:
            transferencias.append((itx, destino))
        else:
            restantes.append(itx)
    return restantes, transferencias


def match_transactions_ja_baixadas(
    empresa: str,
    inter_transacoes: List[InterTransacao],
    tiny_contas_pagas: List[Dict[str, Any]],
    tolerance_days: int = JA_BAIXADAS_TOLERANCIA_DIAS,
) -> Tuple[List[ReconciliationMatch], List[InterTransacao]]:
    """
    Cruza os débitos que sobraram sem par com contas JÁ PAGAS no Tiny, para tirá-los da lista
    de pendências. Mais conservador que o cruzamento de baixa: janela curta de vencimento
    (uma conta paga no mês passado não pode "absorver" o pagamento recorrente deste mês) e sem
    o critério de valor único, que com centenas de contas pagas casaria por coincidência.
    Retorna (débitos identificados como já baixados, débitos que continuam sem par).
    """
    res = match_transactions(empresa, inter_transacoes, tiny_contas_pagas, tolerance_days=tolerance_days)
    confiaveis = [m for m in res.matches if m.metodo_match != MatchMethod.VALOR_DATA_UNICO]
    ids_confiaveis = {m.inter_transacao_id for m in confiaveis}
    sem_par = [itx for itx in inter_transacoes if itx.transacao_id not in ids_confiaveis]
    return confiaveis, sem_par


def match_transactions(
    empresa: str,
    inter_transacoes: List[InterTransacao],
    tiny_contas: List[Dict[str, Any]],
    tolerance_days: int = 60,
) -> ReconciliationResult:
    """
    Executa o cruzamento completo multicritério entre pagamentos do Inter e contas em aberto do Tiny:
    1. Código de Barras / Linha Digitável (100% confiança)
    2. CNPJ/CPF + Valor Exato + Vencimento próximo (95% confiança)
    3. Documento / NF-e na descrição do Inter + Valor Exato (90% confiança)
    4. CNPJ/CPF + Valor com Juros/Multa/Desconto (85% confiança)
    5. Nome do Fornecedor + Valor Exato (80% confiança)
    6. Valor Único no Período (70% confiança)
    """
    empresa_label = EMPRESA_LABELS.get(empresa, empresa.title())
    used_tiny_ids: Set[int] = set()
    used_inter_ids: Set[str] = set()
    matches: List[ReconciliationMatch] = []

    # Mapeia contas do Tiny válidas
    parsed_tiny: List[Dict[str, Any]] = []
    for c in tiny_contas:
        c_id = c.get("id")
        if not c_id:
            continue
        try:
            cid_int = int(c_id)
        except Exception:
            continue

        valor_t = _to_decimal(c.get("valor") or c.get("saldo") or c.get("valorNominal"))
        venc_t = _parse_date(c.get("dataVencimento") or c.get("vencimento"))
        cnpj_t = _extract_cnpj_from_tiny(c)
        nome_t = _extract_supplier_name_from_tiny(c)
        doc_t = str(c.get("numeroDocumento") or c.get("documento") or c_id).strip()
        hist_t = str(c.get("historico") or "")
        cod_barras_t = _clean_digits(c.get("codigoBarras") or c.get("codBarras") or "")
        c_emp = str(c.get("empresa") or empresa).lower().strip()

        parsed_tiny.append({
            "id": cid_int,
            "empresa": c_emp,
            "empresa_nome": EMPRESA_LABELS.get(c_emp, c_emp.title()),
            "valor": valor_t,
            "vencimento": venc_t,
            "cnpj": cnpj_t,
            "nome": nome_t,
            "documento": doc_t,
            "historico": hist_t,
            "codigo_barras": cod_barras_t,
            "raw": c,
        })

    def record_match(
        tc: Dict[str, Any],
        itx: InterTransacao,
        metodo: MatchMethod,
        confianca: float,
        motivo: str,
    ) -> None:
        used_tiny_ids.add(tc["id"])
        used_inter_ids.add(itx.transacao_id)
        diff = itx.valor_pago - tc["valor"]
        juros = itx.juros if itx.juros > 0 else max(Decimal("0.00"), diff)
        desconto = itx.desconto if itx.desconto > 0 else max(Decimal("0.00"), -diff)

        # Se for cruzamento entre filiais distintas, sinaliza expressamente
        nota_intercompany = ""
        if tc["empresa"] != itx.empresa:
            tc_lbl = EMPRESA_LABELS.get(tc["empresa"], tc["empresa"])
            itx_lbl = EMPRESA_LABELS.get(itx.empresa, itx.empresa)
            nota_intercompany = f" [Pago por {itx_lbl} para conta da {tc_lbl}]"

        matches.append(ReconciliationMatch(
            id=f"MATCH-{tc['empresa'].upper()}-{tc['id']}-{len(matches)+1:03d}",
            empresa=tc["empresa"],
            empresa_nome=tc["empresa_nome"],
            conta_pagar_id=tc["id"],
            numero_documento=tc["documento"],
            fornecedor_nome=tc["nome"],
            fornecedor_cnpj=tc["cnpj"],
            data_vencimento=tc["vencimento"] or itx.data_pagamento,
            valor_tiny=tc["valor"],
            inter_transacao_id=itx.transacao_id,
            tipo_transacao_inter=itx.tipo_transacao,
            data_pagamento=itx.data_pagamento,
            valor_pago=itx.valor_pago,
            valor_original_inter=itx.valor_original or tc["valor"],
            juros=juros,
            multa=itx.multa,
            desconto=desconto,
            codigo_barras=itx.codigo_barras,
            metodo_match=metodo,
            confianca=confianca,
            motivo=f"{motivo}{nota_intercompany}",
            historico_sugerido=f"Baixa conciliada Banco Inter - {itx.titulo} {itx.transacao_id}{nota_intercompany}",
        ))

    # =========================================================================
    # PASSO 1: Código de barras / Linha digitável (100% de confiança)
    # =========================================================================
    for itx in inter_transacoes:
        if itx.transacao_id in used_inter_ids or not itx.codigo_barras:
            continue

        barras_inter = itx.codigo_barras

        for tc in parsed_tiny:
            if tc["id"] in used_tiny_ids:
                continue

            matched = False
            if tc["codigo_barras"] and tc["codigo_barras"] == barras_inter:
                matched = True
            elif barras_inter in tc["historico"] or (len(barras_inter) == 44 and barras_inter[0:20] in tc["historico"]):
                matched = True
            else:
                pb = parse_boleto(barras_inter, referencia=itx.data_pagamento)
                if pb and pb.valor and tc["vencimento"]:
                    if abs(tc["valor"] - pb.valor) < Decimal("0.05") and tc["vencimento"] == pb.vencimento:
                        if (tc["cnpj"] and itx.cpf_cnpj_favorecido and tc["cnpj"] == itx.cpf_cnpj_favorecido) or (
                            _names_are_similar(tc["nome"], itx.nome_favorecido)
                        ):
                            matched = True

            if matched:
                record_match(
                    tc,
                    itx,
                    MatchMethod.CODIGO_BARRAS,
                    1.0,
                    f"Código de barras idêntico ({barras_inter[:10]}...)",
                )
                break

    # =========================================================================
    # PASSO 2: CNPJ/CPF + Valor Exato + Vencimento próximo (95% de confiança)
    # =========================================================================
    for itx in inter_transacoes:
        if itx.transacao_id in used_inter_ids or not itx.cpf_cnpj_favorecido:
            continue

        for tc in parsed_tiny:
            if tc["id"] in used_tiny_ids or not tc["cnpj"]:
                continue

            if tc["cnpj"] == itx.cpf_cnpj_favorecido:
                val_exact = (
                    abs(tc["valor"] - itx.valor_pago) < Decimal("0.05")
                    or (itx.valor_original and abs(tc["valor"] - itx.valor_original) < Decimal("0.05"))
                )
                if val_exact:
                    days_diff = abs((itx.data_pagamento - tc["vencimento"]).days) if tc["vencimento"] else 0
                    if days_diff <= tolerance_days:
                        record_match(
                            tc,
                            itx,
                            MatchMethod.CNPJ_VALOR_DATA,
                            0.95,
                            f"CNPJ idêntico ({tc['cnpj']}), valor exato R$ {tc['valor']:.2f} e data compatível ({days_diff}d)",
                        )
                        break

    # =========================================================================
    # PASSO 3: Número de Documento/NF-e na Descrição do Inter + Valor Exato (90%)
    # =========================================================================
    for itx in inter_transacoes:
        if itx.transacao_id in used_inter_ids:
            continue

        inter_texto = f"{itx.descricao} {itx.titulo}".upper()

        for tc in parsed_tiny:
            if tc["id"] in used_tiny_ids:
                continue

            doc_str = tc["documento"].strip()
            # Extrai apenas dígitos do documento se tiver ao menos 3 dígitos
            doc_digits = re.sub(r"\D", "", doc_str)
            doc_matched = False

            if doc_str and len(doc_str) >= 3 and doc_str.upper() in inter_texto:
                doc_matched = True
            elif doc_digits and len(doc_digits) >= 3 and doc_digits in inter_texto:
                doc_matched = True

            if doc_matched and abs(tc["valor"] - itx.valor_pago) < Decimal("0.05"):
                days_diff = abs((itx.data_pagamento - tc["vencimento"]).days) if tc["vencimento"] else 0
                if days_diff <= tolerance_days:
                    record_match(
                        tc,
                        itx,
                        MatchMethod.DOCUMENTO_VALOR,
                        0.90,
                        f"Doc/NF-e '{doc_str}' localizado na descrição do pagamento e valor exato R$ {tc['valor']:.2f}",
                    )
                    break

    # =========================================================================
    # PASSO 4: CNPJ/CPF + Valor com Juros/Multa/Desconto (85% de confiança)
    # =========================================================================
    for itx in inter_transacoes:
        if itx.transacao_id in used_inter_ids or not itx.cpf_cnpj_favorecido:
            continue

        for tc in parsed_tiny:
            if tc["id"] in used_tiny_ids or not tc["cnpj"]:
                continue

            if tc["cnpj"] == itx.cpf_cnpj_favorecido:
                diff = abs(itx.valor_pago - tc["valor"])
                max_tolerance = max(Decimal("80.00"), tc["valor"] * Decimal("0.10"))
                if Decimal("0.05") < diff <= max_tolerance:
                    days_diff = abs((itx.data_pagamento - tc["vencimento"]).days) if tc["vencimento"] else 0
                    if days_diff <= tolerance_days:
                        record_match(
                            tc,
                            itx,
                            MatchMethod.CNPJ_VALOR,
                            0.85,
                            f"CNPJ idêntico ({tc['cnpj']}), valor pago R$ {itx.valor_pago:.2f} com variação de R$ {diff:.2f}",
                        )
                        break

    # =========================================================================
    # PASSO 5: Nome do Fornecedor + Valor Nominal (80% de confiança)
    # =========================================================================
    for itx in inter_transacoes:
        if itx.transacao_id in used_inter_ids:
            continue

        fav_name = itx.nome_favorecido or itx.descricao

        for tc in parsed_tiny:
            if tc["id"] in used_tiny_ids:
                continue

            if _names_are_similar(tc["nome"], fav_name) and abs(tc["valor"] - itx.valor_pago) < Decimal("0.05"):
                days_diff = abs((itx.data_pagamento - tc["vencimento"]).days) if tc["vencimento"] else 0
                if days_diff <= tolerance_days:
                    record_match(
                        tc,
                        itx,
                        MatchMethod.NOME_VALOR,
                        0.80,
                        f"Fornecedor '{tc['nome']}' similar a '{fav_name}' e valor exato R$ {tc['valor']:.2f}",
                    )
                    break

    # =========================================================================
    # PASSO 6: Valor Exato Único no Período (70% de confiança)
    # =========================================================================
    for itx in inter_transacoes:
        if itx.transacao_id in used_inter_ids:
            continue

        # Procura contas no Tiny ainda não casadas com o valor exato no raio de até 15 dias
        cand_list = [
            tc for tc in parsed_tiny
            if tc["id"] not in used_tiny_ids
            and abs(tc["valor"] - itx.valor_pago) < Decimal("0.05")
            and (abs((itx.data_pagamento - tc["vencimento"]).days) <= 15 if tc["vencimento"] else True)
        ]

        if len(cand_list) == 1:
            cand = cand_list[0]
            record_match(
                cand,
                itx,
                MatchMethod.VALOR_DATA_UNICO,
                0.70,
                f"Valor único de R$ {itx.valor_pago:.2f} no período para o fornecedor '{cand['nome']}'",
            )

    unmatched_inter = [itx for itx in inter_transacoes if itx.transacao_id not in used_inter_ids]
    unmatched_tiny = [tc["raw"] for tc in parsed_tiny if tc["id"] not in used_tiny_ids]

    summary = ReconciliationSummary(
        total_casados=len(matches),
        valor_total_casados=sum((m.valor_pago for m in matches), Decimal("0.00")),
        total_inter_sem_par=len(unmatched_inter),
        valor_inter_sem_par=sum((t.valor_pago for t in unmatched_inter), Decimal("0.00")),
        total_tiny_sem_par=len(unmatched_tiny),
        valor_tiny_sem_par=sum((_to_decimal(c.get("valor") or c.get("saldo")) for c in unmatched_tiny), Decimal("0.00")),
    )

    return ReconciliationResult(
        empresa=empresa,
        data_inicio=inter_transacoes[0].data_pagamento if inter_transacoes else date.today(),
        data_fim=inter_transacoes[-1].data_pagamento if inter_transacoes else date.today(),
        matches=matches,
        unmatched_inter=unmatched_inter,
        unmatched_tiny=unmatched_tiny,
        summary=summary,
    )
