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

Os níveis 1 e 2 são correspondência forte (o mesmo produto/NCM já foi confirmado); o 3 é
fraco — um fornecedor que vende de tudo (papelaria, marketplace) erra aqui. Por isso
`suggest_detalhado` devolve o nível, e a tela põe a sugestão do Qwen entre os dois
(ver `_sugestao_item` em routers/danfe.py).

Guarda também a última forma de pagamento confirmada por (empresa, fornecedor), usada na
pré-seleção da revisão (forma_pagamento.py).
"""
import json
import logging
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Literal, Optional, Tuple

from app.review_store import ReviewItem, ReviewRecord, list_confirmed
from app.tiny_client import PAYMENT_METHOD_MARCADOR

logger = logging.getLogger("automacao_nfe.category_history")

NivelHistorico = Literal["codigo", "ncm", "fornecedor"]
_Key = Tuple[str, str, str]  # (destinatario_cnpj, emitente_cnpj, codigo|ncm)


@dataclass
class CategoryHistoryIndex:
    by_codigo: Dict[_Key, str]
    by_ncm: Dict[_Key, str]
    by_fornecedor: Dict[Tuple[str, str], str]
    forma_pagamento_por_fornecedor: Dict[Tuple[str, str], str] = field(default_factory=dict)
    # Último "Meio de pagamento da NFe" (código tPag) lançado com o fornecedor: na confirmação o
    # escolhido na revisão sobrescreve o do XML em nfe_data.meio_pagamento_nfe.
    meio_nfe_por_fornecedor: Dict[Tuple[str, str], str] = field(default_factory=dict)

    def suggest_detalhado(
        self, destinatario_cnpj: Optional[str], emitente_cnpj: Optional[str], item: ReviewItem
    ) -> Optional[Tuple[str, NivelHistorico]]:
        if not destinatario_cnpj or not emitente_cnpj:
            return None
        if item.codigo:
            cat = self.by_codigo.get((destinatario_cnpj, emitente_cnpj, item.codigo))
            if cat:
                return cat, "codigo"
        if item.ncm:
            cat = self.by_ncm.get((destinatario_cnpj, emitente_cnpj, item.ncm))
            if cat:
                return cat, "ncm"
        cat = self.by_fornecedor.get((destinatario_cnpj, emitente_cnpj))
        return (cat, "fornecedor") if cat else None

    def suggest(self, destinatario_cnpj: Optional[str], emitente_cnpj: Optional[str], item: ReviewItem) -> Optional[str]:
        achado = self.suggest_detalhado(destinatario_cnpj, emitente_cnpj, item)
        return achado[0] if achado else None

    def forma_pagamento(self, destinatario_cnpj: Optional[str], emitente_cnpj: Optional[str]) -> Optional[str]:
        if not destinatario_cnpj or not emitente_cnpj:
            return None
        return self.forma_pagamento_por_fornecedor.get((destinatario_cnpj, emitente_cnpj))

    def meio_pagamento_nfe(self, destinatario_cnpj: Optional[str], emitente_cnpj: Optional[str]) -> Optional[str]:
        if not destinatario_cnpj or not emitente_cnpj:
            return None
        return self.meio_nfe_por_fornecedor.get((destinatario_cnpj, emitente_cnpj))


def forma_pagamento_confirmada(record: ReviewRecord) -> Optional[str]:
    """A do `.review.json` (desde 11/2026) ou, nas notas mais antigas, a do `.meta.json` ao lado."""
    forma = record.forma_pagamento
    if not forma:
        meta = record.file_path.with_suffix(record.file_path.suffix + ".meta.json")
        try:
            forma = json.loads(meta.read_text(encoding="utf-8")).get("forma_pagamento")
        except (OSError, ValueError, AttributeError):
            return None
    return forma if forma in PAYMENT_METHOD_MARCADOR else None


def build_index(records: List[ReviewRecord]) -> CategoryHistoryIndex:
    """
    Para código/NCM vale a escolha MAIS RECENTE (o funcionário pode ter corrigido a
    categoria com o tempo); para o fornecedor como um todo, a categoria de maior valor.
    """
    ordered = sorted(records, key=lambda r: r.staged_at or "")
    by_codigo: Dict[_Key, str] = {}
    by_ncm: Dict[_Key, str] = {}
    valor_por_fornecedor: Dict[Tuple[str, str], Dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    forma_por_fornecedor: Dict[Tuple[str, str], str] = {}
    meio_por_fornecedor: Dict[Tuple[str, str], str] = {}

    for record in ordered:
        dest = record.nfe_data.destinatario_cnpj
        emit = record.nfe_data.emitente_cnpj
        if not dest or not emit:
            continue
        forma = forma_pagamento_confirmada(record)
        if forma:
            forma_por_fornecedor[(dest, emit)] = forma
        meio = getattr(record.nfe_data, "meio_pagamento_nfe", None)
        if meio:
            meio_por_fornecedor[(dest, emit)] = meio
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
    return CategoryHistoryIndex(
        by_codigo=by_codigo, by_ncm=by_ncm, by_fornecedor=by_fornecedor, forma_pagamento_por_fornecedor=forma_por_fornecedor,
        meio_nfe_por_fornecedor=meio_por_fornecedor,
    )


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
