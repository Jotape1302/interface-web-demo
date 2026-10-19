"""
Script de backfill pontual (2026-09-17): preenche retroativamente o campo
"Meio de pagamento da NFe" nas notas que já estavam em pending_review/ antes dessa
extração existir no código (o lote de 24 recuperado em NF-e & DANFE, notas com
"Não informado" no dropdown). Não mexe em mais nada — categoria, forma de pagamento
(marcador/vencimento) e qualquer escolha já feita pelo funcionário continuam intactas.

Reprocessa só a tag <pag><detPag><tPag> do XML que já está salvo em pending_review/
(mesmo arquivo usado pela revisão) e regrava só esse campo no .review.json. Não chama
a SEFAZ nem o Tiny.

Uso (dentro do container, via docker exec):
    python3 /app/backfill_meio_pagamento_nfe.py

Este arquivo é temporário/uso único e deve ser removido do repositório depois que o
backfill na VPS for confirmado.
"""
import json
import sys
import defusedxml.ElementTree as ET  # XML vindo da SEFAZ/arquivos: sem entidades externas nem "billion laughs"

sys.path.insert(0, "/app")

from app.config import settings
from app.review_store import _json_path_for, list_pending  # noqa: SLF001 (script pontual)


def _extract_meio_pagamento(xml_content: str) -> str | None:
    try:
        root = ET.fromstring(xml_content)
    except Exception:
        return None

    def find_first(element, tag_name):
        for el in element.iter():
            if el.tag.split("}")[-1] == tag_name:
                return el
        return None

    det_pag_el = find_first(root, "detPag")
    t_pag_el = find_first(det_pag_el, "tPag") if det_pag_el is not None else None
    return t_pag_el.text.strip() if (t_pag_el is not None and t_pag_el.text) else None


def main() -> None:
    settings.ensure_directories()
    records = list_pending()
    print(f"{len(records)} nota(s) pendente(s) em pending_review/. Verificando meio de pagamento no XML...\n")

    atualizadas = 0
    ja_preenchidas = 0
    sem_valor_no_xml = 0

    for record in records:
        if record.nfe_data.meio_pagamento_nfe:
            ja_preenchidas += 1
            continue

        if not record.file_path.exists():
            print(f"  AVISO  chave={record.chave}: arquivo staged não encontrado ({record.file_path}). Pulando.")
            continue

        try:
            xml_content = record.file_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  AVISO  chave={record.chave}: falha ao ler XML: {e}. Pulando.")
            continue

        meio_pagamento = _extract_meio_pagamento(xml_content)
        if not meio_pagamento:
            sem_valor_no_xml += 1
            print(f"  SEM DADO  chave={record.chave} nota={record.nfe_data.numero_nota}: XML não declara <tPag>.")
            continue

        json_path = _json_path_for(record.chave)
        if not json_path:
            print(f"  AVISO  chave={record.chave}: .review.json não encontrado. Pulando.")
            continue

        with open(json_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        payload["nfe_data"]["meio_pagamento_nfe"] = meio_pagamento
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        atualizadas += 1
        print(f"  OK  chave={record.chave} nota={record.nfe_data.numero_nota} -> meio_pagamento_nfe={meio_pagamento}")

    print(
        f"\nTotal: {atualizadas} atualizada(s), {ja_preenchidas} já preenchida(s), "
        f"{sem_valor_no_xml} sem <tPag> no XML (fornecedor não declarou), de {len(records)} pendente(s)."
    )


if __name__ == "__main__":
    main()
