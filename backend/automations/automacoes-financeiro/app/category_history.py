"""
Sugestão de categoria a partir do histórico de notas já lançadas no Tiny.

A sugestão por regra (`suggest_category_id`, por descrição/NCM) erra bastante para
fornecedores recorrentes cujo produto não diz nada pela descrição. Mas a categoria que o
funcionário escolheu nas notas anteriores do MESMO fornecedor fica gravada no
`.review.json` de `processed/` (confirm-lancamento sobrescreve `categoria_sugerida_id`
com a escolha final) — então dá pra reaproveitá-la.

O índice é sempre por empresa destinatária: cada empresa é uma conta Tiny separada, com
IDs de categoria próprios (ver `financial_dashboard._sync_one_company`), então a categoria
usada pela Fabrilux para um fornecedor não vale como ID para a Revesta.

Ordem de precedência (do mais específico ao mais genérico):
1. mesmo fornecedor + mesmo código de produto;
2. mesmo fornecedor + mesmo NCM;
3. categoria mais usada (por valor) com aquele fornecedor.
"""
import threading
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.review_store import ReviewItem, ReviewRecord, list_confirmed

_Key = Tuple[str, str, str]  # (destinatario_cnpj, emitente_cnpj, codigo|ncm)


@dataclass
class CategoryHistoryIndex:
    by_codigo: Dict[_Key, str]
    by_ncm: Dict[_Key, str]
    by_fornecedor: Dict[Tuple[str, str], str]

    def suggest(self, destinatario_cnpj: Optional[str], emitente_cnpj: Optional[str], item: ReviewItem) -> Optional[str]:
        if not destinatario_cnpj or not emitente_cnpj:
            return None
        if item.codigo:
            cat = self.by_codigo.get((destinatario_cnpj, emitente_cnpj, item.codigo))
            if cat:
                return cat
        if item.ncm:
            cat = self.by_ncm.get((destinatario_cnpj, emitente_cnpj, item.ncm))
            if cat:
                return cat
        return self.by_fornecedor.get((destinatario_cnpj, emitente_cnpj))


def build_index(records: List[ReviewRecord]) -> CategoryHistoryIndex:
    """
    Para código/NCM vale a escolha MAIS RECENTE (o funcionário pode ter corrigido a
    categoria com o tempo); para o fornecedor como um todo, a categoria de maior valor.
    """
    ordered = sorted(records, key=lambda r: r.staged_at or "")
    by_codigo: Dict[_Key, str] = {}
    by_ncm: Dict[_Key, str] = {}
    valor_por_fornecedor: Dict[Tuple[str, str], Dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))

    for record in ordered:
        dest = record.nfe_data.destinatario_cnpj
        emit = record.nfe_data.emitente_cnpj
        if not dest or not emit:
            continue
        for item in record.itens:
            cat = item.categoria_sugerida_id
            if not cat:
                continue
            if item.codigo:
                by_codigo[(dest, emit, item.codigo)] = cat
            if item.ncm:
                by_ncm[(dest, emit, item.ncm)] = cat
            valor_por_fornecedor[(dest, emit)][cat] += item.valor_total or Decimal(0)

    by_fornecedor = {
        key: max(valores.items(), key=lambda kv: kv[1])[0]
        for key, valores in valor_por_fornecedor.items()
        if valores
    }
    return CategoryHistoryIndex(by_codigo=by_codigo, by_ncm=by_ncm, by_fornecedor=by_fornecedor)


_cache_lock = threading.Lock()
_cache: Dict[str, object] = {"signature": None, "index": None}


def _processed_signature(directory: Path) -> Tuple[int, float]:
    files = list(directory.glob("*.review.json"))
    return len(files), max((f.stat().st_mtime for f in files), default=0.0)


def get_index(processed_dir: Path) -> CategoryHistoryIndex:
    """Índice em cache, reconstruído só quando `processed/` muda (nova nota confirmada)."""
    signature = _processed_signature(processed_dir)
    with _cache_lock:
        if _cache["signature"] != signature or _cache["index"] is None:
            _cache["index"] = build_index(list_confirmed())
            _cache["signature"] = signature
        return _cache["index"]  # type: ignore[return-value]
