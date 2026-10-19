"""
Persistência em disco das notas fiscais aguardando revisão/categorização humana,
entre o momento em que são escaneadas/consultadas e a confirmação do lançamento
no Tiny ERP. Segue o mesmo padrão de `processed/` e `failed/`: o arquivo original
(PDF/imagem/XML) fica em `pending_review/`, acompanhado de um `.review.json` com
os dados extraídos e as sugestões de categoria por item.

Sobrevive a restart do processo/container — a revisão humana pode levar horas.

O status de uma nota (pendente/confirmada/arquivada) é implícito no diretório onde
seu `.review.json` está: `pending_review/`, `processed/` ou `archived/`. Arquivar ou
confirmar uma nota nunca apaga o `.review.json` — só move para o diretório do novo
estado — para permitir consultar o histórico completo (itens, categorias sugeridas)
mais tarde, sem depender só do `.meta.json` de auditoria (que não guarda os itens).
"""
import json
import logging
import shutil
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings
from app.nfe_client import NFeData, NFeDuplicate
from app.nfe_items import NFeItem

logger = logging.getLogger(__name__)


@dataclass
class ReviewItem:
    item_id: str
    descricao: str
    valor_total: Decimal
    codigo: Optional[str]
    ncm: Optional[str]
    quantidade: Decimal
    valor_unitario: Optional[Decimal]
    categoria_sugerida_id: str


@dataclass
class ReviewRecord:
    chave: str
    filename: str
    staged_at: str
    file_path: Path
    nfe_data: NFeData
    itens: List[ReviewItem] = field(default_factory=list)
    last_error: Optional[str] = None
    last_error_at: Optional[str] = None


def _decimal_or_none(v: Optional[str]) -> Optional[Decimal]:
    return Decimal(v) if v is not None else None


def _nfe_data_to_dict(nfe_data: NFeData) -> Dict[str, Any]:
    return {
        "chave": nfe_data.chave,
        "numero_nota": nfe_data.numero_nota,
        "data_emissao": nfe_data.data_emissao.isoformat(),
        "emitente_nome": nfe_data.emitente_nome,
        "emitente_cnpj": nfe_data.emitente_cnpj,
        "valor_total": str(nfe_data.valor_total),
        "duplicatas": [
            {"numero": d.numero, "vencimento": d.vencimento.isoformat(), "valor": str(d.valor)}
            for d in nfe_data.duplicatas
        ],
        "destinatario_cnpj": nfe_data.destinatario_cnpj,
        "destinatario_nome": nfe_data.destinatario_nome,
        "meio_pagamento_nfe": nfe_data.meio_pagamento_nfe,
        "numero_documento_custom": nfe_data.numero_documento_custom,
        "marcador_empresa": nfe_data.marcador_empresa,
        "marcador_caixa": nfe_data.marcador_caixa,
        "marcadores": list(nfe_data.marcadores),
    }


def _nfe_data_from_dict(data: Dict[str, Any]) -> NFeData:
    return NFeData(
        chave=data["chave"],
        numero_nota=data["numero_nota"],
        data_emissao=date.fromisoformat(data["data_emissao"]),
        emitente_nome=data["emitente_nome"],
        emitente_cnpj=data["emitente_cnpj"],
        valor_total=Decimal(data["valor_total"]),
        duplicatas=[
            NFeDuplicate(numero=d["numero"], vencimento=date.fromisoformat(d["vencimento"]), valor=Decimal(d["valor"]))
            for d in data.get("duplicatas", [])
        ],
        destinatario_cnpj=data.get("destinatario_cnpj"),
        destinatario_nome=data.get("destinatario_nome"),
        meio_pagamento_nfe=data.get("meio_pagamento_nfe"),
        numero_documento_custom=data.get("numero_documento_custom"),
        marcador_empresa=data.get("marcador_empresa"),
        marcador_caixa=data.get("marcador_caixa"),
        marcadores=data.get("marcadores", []),
    )


def _review_json_path_for(file_path: Path) -> Path:
    return file_path.with_suffix(file_path.suffix + ".review.json")


def _staging_path(chave: str, filename: str) -> Path:
    stem_safe = "".join(c for c in chave if c.isalnum()) or "nota"
    return settings.PENDING_REVIEW_DIR / f"{stem_safe}__{filename}"


def _record_payload(record: ReviewRecord) -> Dict[str, Any]:
    return {
        "chave": record.chave,
        "filename": record.filename,
        "staged_at": record.staged_at,
        "staged_filename": record.file_path.name,
        "last_error": record.last_error,
        "last_error_at": record.last_error_at,
        "nfe_data": _nfe_data_to_dict(record.nfe_data),
        "itens": [
            {
                "item_id": ri.item_id,
                "descricao": ri.descricao,
                "valor_total": str(ri.valor_total),
                "codigo": ri.codigo,
                "ncm": ri.ncm,
                "quantidade": str(ri.quantidade),
                "valor_unitario": str(ri.valor_unitario) if ri.valor_unitario is not None else None,
                "categoria_sugerida_id": ri.categoria_sugerida_id,
            }
            for ri in record.itens
        ],
    }


def write_record_json(record: ReviewRecord) -> Path:
    """
    Grava/atualiza o `.review.json` ao lado de `record.file_path`, refletindo o estado
    atual de `record.nfe_data`/`record.itens`. Usado tanto ao estagiar quanto ao mover
    uma nota entre diretórios (arquivar, restaurar, confirmar), para que o histórico
    reflita os dados efetivamente usados (ex: forma de pagamento escolhida na confirmação).
    """
    settings.ensure_directories()
    json_path = _review_json_path_for(record.file_path)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(_record_payload(record), f, indent=2, ensure_ascii=False)
    return json_path


def stage_for_review(file_path: Path, nfe_data: NFeData, itens_sugeridos: List[NFeItem], categoria_por_item: Dict[str, str]) -> ReviewRecord:
    """Move o arquivo original para pending_review/ e grava os metadados de revisão."""
    settings.ensure_directories()
    # Uma nota por chave na fila: a tela seleciona, arquiva e confirma pela chave. Reenviar a
    # mesma nota (ex.: XML subido depois de a varredura SEFAZ já tê-la trazido) substitui a
    # entrada anterior em vez de criar cards duplicados que marcam/desmarcam juntos.
    for anterior in _json_paths_da_chave(settings.PENDING_REVIEW_DIR, nfe_data.chave):
        _apagar_entrada(anterior, preservar=file_path)
    staged_file = _staging_path(nfe_data.chave, file_path.name)

    counter = 1
    while staged_file.exists():
        staged_file = staged_file.with_name(f"{staged_file.stem}_{counter}{staged_file.suffix}")
        counter += 1

    shutil.move(str(file_path), str(staged_file))

    review_items = [
        ReviewItem(
            item_id=item.item_id,
            descricao=item.descricao,
            valor_total=item.valor_total,
            codigo=item.codigo,
            ncm=item.ncm,
            quantidade=item.quantidade,
            valor_unitario=item.valor_unitario,
            categoria_sugerida_id=categoria_por_item.get(item.item_id, ""),
        )
        for item in itens_sugeridos
    ]

    record = ReviewRecord(
        chave=nfe_data.chave,
        filename=file_path.name,
        staged_at=datetime.now().isoformat(),
        file_path=staged_file,
        nfe_data=nfe_data,
        itens=review_items,
    )

    write_record_json(record)
    return record


def _load_record(json_path: Path) -> Optional[ReviewRecord]:
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as e:
        logger.warning(f"Falha ao ler registro de revisão pendente '{json_path.name}': {e}")
        return None

    staged_file = json_path.parent / payload["staged_filename"]
    itens = [
        ReviewItem(
            item_id=it["item_id"],
            descricao=it["descricao"],
            valor_total=Decimal(it["valor_total"]),
            codigo=it.get("codigo"),
            ncm=it.get("ncm"),
            quantidade=Decimal(it["quantidade"]),
            valor_unitario=_decimal_or_none(it.get("valor_unitario")),
            categoria_sugerida_id=it.get("categoria_sugerida_id", ""),
        )
        for it in payload.get("itens", [])
    ]

    return ReviewRecord(
        chave=payload["chave"],
        filename=payload["filename"],
        staged_at=payload["staged_at"],
        file_path=staged_file,
        nfe_data=_nfe_data_from_dict(payload["nfe_data"]),
        itens=itens,
        last_error=payload.get("last_error"),
        last_error_at=payload.get("last_error_at"),
    )


def _list_records(directory: Path) -> List[ReviewRecord]:
    settings.ensure_directories()
    records = []
    for json_path in sorted(directory.glob("*.review.json")):
        record = _load_record(json_path)
        if record:
            records.append(record)
    return records


def _get_record(directory: Path, chave: str) -> Optional[ReviewRecord]:
    for record in _list_records(directory):
        if record.chave == chave:
            return record
    return None


def _json_path_for_dir(directory: Path, chave: str) -> Optional[Path]:
    for json_path in directory.glob("*.review.json"):
        record = _load_record(json_path)
        if record and record.chave == chave:
            return json_path
    return None


def _json_paths_da_chave(directory: Path, chave: str) -> List[Path]:
    caminhos = []
    for json_path in directory.glob("*.review.json"):
        record = _load_record(json_path)
        if record and record.chave == chave:
            caminhos.append(json_path)
    return caminhos


def _apagar_entrada(json_path: Path, preservar: Optional[Path] = None) -> None:
    """Remove o `.review.json` e o arquivo da nota a que ele se refere (exceto `preservar`)."""
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            staged = json_path.parent / json.load(f).get("staged_filename", "")
    except Exception:
        staged = None
    for alvo in (json_path, staged):
        if alvo and alvo.is_file() and not (preservar and alvo.resolve() == Path(preservar).resolve()):
            try:
                alvo.unlink()
            except OSError as e:
                logger.warning(f"Falha ao remover '{alvo.name}' da fila de revisão: {e}")


def list_pending() -> List[ReviewRecord]:
    """
    Notas aguardando revisão, uma por chave. Entradas repetidas da mesma chave (criadas antes
    de `stage_for_review` substituir a anterior — ex.: varredura SEFAZ que reprocessava as
    mesmas notas enquanto não conseguia gravar o NSU) são removidas, ficando a mais recente.
    """
    settings.ensure_directories()
    por_chave: Dict[str, Tuple[ReviewRecord, Path]] = {}
    for json_path in sorted(settings.PENDING_REVIEW_DIR.glob("*.review.json")):
        record = _load_record(json_path)
        if not record:
            continue
        atual = por_chave.get(record.chave)
        if atual is None:
            por_chave[record.chave] = (record, json_path)
            continue
        manter, descartar = (record, json_path), atual
        if (atual[0].staged_at or "") > (record.staged_at or ""):
            manter, descartar = atual, (record, json_path)
        logger.info(f"[REVISAO] Removendo entrada duplicada da chave {record.chave}: {descartar[1].name}")
        _apagar_entrada(descartar[1])
        por_chave[record.chave] = manter
    return sorted((r for r, _ in por_chave.values()), key=lambda r: r.file_path.name)


def get_pending(chave: str) -> Optional[ReviewRecord]:
    return _get_record(settings.PENDING_REVIEW_DIR, chave)


def _json_path_for(chave: str) -> Optional[Path]:
    return _json_path_for_dir(settings.PENDING_REVIEW_DIR, chave)


def remove_pending(chave: str) -> None:
    json_path = _json_path_for(chave)
    if not json_path:
        return
    try:
        json_path.unlink()
    except Exception as e:
        logger.warning(f"Falha ao remover registro de revisão pendente para chave {chave}: {e}")


def list_archived() -> List[ReviewRecord]:
    return _list_records(settings.ARCHIVED_DIR)


def get_archived(chave: str) -> Optional[ReviewRecord]:
    return _get_record(settings.ARCHIVED_DIR, chave)


def list_confirmed() -> List[ReviewRecord]:
    """
    Notas já lançadas no Tiny. Só existem aqui a partir desta funcionalidade — notas
    confirmadas antes dela não têm `.review.json` em `processed/` e não aparecem.
    """
    return _list_records(settings.PROCESSED_DIR)


def _move_record(chave: str, src_dir: Path, dest_dir: Path) -> Optional[ReviewRecord]:
    """Move o arquivo original + `.review.json` de src_dir para dest_dir (arquivar/restaurar)."""
    record = _get_record(src_dir, chave)
    if not record:
        return None

    settings.ensure_directories()
    old_json_path = _review_json_path_for(record.file_path)

    dest_file = dest_dir / record.file_path.name
    counter = 1
    while dest_file.exists():
        dest_file = dest_file.with_name(f"{record.file_path.stem}_{counter}{record.file_path.suffix}")
        counter += 1
    shutil.move(str(record.file_path), str(dest_file))

    record.file_path = dest_file
    write_record_json(record)
    if old_json_path.exists():
        old_json_path.unlink()

    return record


def archive_pending(chave: str) -> Optional[ReviewRecord]:
    return _move_record(chave, settings.PENDING_REVIEW_DIR, settings.ARCHIVED_DIR)


def restore_archived(chave: str) -> Optional[ReviewRecord]:
    return _move_record(chave, settings.ARCHIVED_DIR, settings.PENDING_REVIEW_DIR)
