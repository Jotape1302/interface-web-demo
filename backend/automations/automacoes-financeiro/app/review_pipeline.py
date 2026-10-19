"""
Ponto único de estagiamento de uma nota fiscal para revisão/categorização humana
(`pending_review/`), reaproveitado tanto pelo upload manual de DANFE (`api.py`,
`process-batch`) quanto pela varredura direta na SEFAZ (`sefaz_scan.py`). Os dois
caminhos produzem exatamente o mesmo formato de registro de revisão.
"""
import logging
from pathlib import Path
from typing import List, Optional

from app.nfe_client import COMPANY_DISPLAY_NAME_BY_CNPJ, NFeData
from app.nfe_items import NFeItem, resolve_itens
from app.review_store import ReviewRecord, stage_for_review
from app.tiny_categories import suggest_category_id

logger = logging.getLogger("automacao_nfe.review_pipeline")

MARCADOR_BY_CNPJ = {
    "27184930000280": "NorviaLDA",
    "27184930000107": "Norvia",
    "43820617000166": "Fabrilux",
    "36592814000100": "Revesta",
}


def already_launched_in_tiny(nfe_data: NFeData) -> bool:
    """
    Verifica no Tiny ERP (leitura, sem side-effects) se essa NF-e já foi lançada —
    seja por uma execução anterior desta automação, seja por lançamento manual de
    alguém do time antes da nota chegar por aqui — para não estagiar em
    pending_review/ algo que só voltaria como "duplicada" ao confirmar. Usa a mesma
    lógica de detecção (chave no histórico, soma de parcelas, fornecedor+documento+
    valor) empregada em TinyClient.check_duplicate_conta_v3 no momento do lançamento
    real. Compartilhada pelos dois caminhos que estagiam uma nota (varredura SEFAZ e
    upload manual) via stage_note_for_review, abaixo.

    Falha aberta: qualquer erro de rede/token apenas loga e deixa a nota seguir para
    revisão humana normalmente (nunca esconde uma nota por causa de uma falha aqui).
    """
    try:
        from app.tiny_client import TinyClient  # import tardio: evita ciclo no boot da API

        client = TinyClient()
        token, _account_id = client.resolve_token_for_nfe(nfe_data)
        if not token:
            return False
        contato_id = None
        try:
            contato_id = client.resolve_contato_id_v3(token, nfe_data)
        except Exception as e:
            logger.debug(f"[already_launched_in_tiny] Fornecedor '{nfe_data.emitente_nome}' não localizado via API: {e}")

        existing_id = client.check_duplicate_conta_v3(
            token=token,
            nro_documento=nfe_data.numero_documento_custom or str(nfe_data.numero_nota),
            contato_id=contato_id,
            chave=nfe_data.chave,
            valor=nfe_data.valor_total,
        )
        return existing_id is not None
    except Exception as e:
        logger.warning(f"Falha ao checar duplicidade no Tiny para chave {nfe_data.chave}: {e}")
        return False


def stage_note_for_review(
    nfe_data: NFeData,
    file_path: Path,
    raw_ocr_text: Optional[str] = None,
) -> ReviewRecord:
    """
    Extrai itens (do XML, do texto OCR ou do fallback de valor único), sugere uma
    categoria por item e move `file_path` para `pending_review/`, gravando o
    `.review.json` correspondente. Não lança nada no Tiny — isso só acontece depois
    da confirmação humana via `POST /api/v1/danfe/confirm-lancamento`.
    """
    if nfe_data.destinatario_cnpj:
        if nfe_data.destinatario_cnpj in COMPANY_DISPLAY_NAME_BY_CNPJ:
            nfe_data.destinatario_nome = COMPANY_DISPLAY_NAME_BY_CNPJ[nfe_data.destinatario_cnpj]
        if not nfe_data.marcador_empresa and nfe_data.destinatario_cnpj in MARCADOR_BY_CNPJ:
            nfe_data.marcador_empresa = MARCADOR_BY_CNPJ[nfe_data.destinatario_cnpj]

    itens_finais: List[NFeItem] = resolve_itens(
        itens_xml=nfe_data.itens,
        raw_ocr_text=raw_ocr_text,
        numero_nota=nfe_data.numero_nota,
        emitente_nome=nfe_data.emitente_nome,
        valor_total=nfe_data.valor_total,
    )
    categoria_por_item = {
        item.item_id: suggest_category_id(item.descricao, item.ncm) for item in itens_finais
    }
    return stage_for_review(file_path, nfe_data, itens_finais, categoria_por_item)
