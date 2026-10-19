"""
Script de backfill pontual (2026-09-17): corrige retroativamente o nome da empresa
destinatária (destinatario_nome) nas notas que já estavam em pending_review/ antes do
"motor" passar a identificar a empresa pelo CNPJ monitorado em vez de confiar no texto
livre que cada fornecedor declarou em <dest><xNome> (ex.: "NORVIA ACABAMENTOS LTDA
14708" em vez de indicar a filial). Usa a mesma tabela canônica de
app.sefaz_scan.COMPANY_DISPLAY_NAME_BY_CNPJ que a varredura já aplica em notas novas.

Não mexe em mais nada — categoria, forma de pagamento, meio de pagamento da NFe e
qualquer outra escolha já feita pelo funcionário continuam intactas. Não chama a SEFAZ
nem o Tiny.

Uso (dentro do container, via docker exec):
    python3 /app/backfill_destinatario_nome.py

Este arquivo é temporário/uso único e deve ser removido do repositório depois que o
backfill na VPS for confirmado.
"""
import json
import sys

sys.path.insert(0, "/app")

from app.config import settings
from app.review_store import _json_path_for, list_pending  # noqa: SLF001 (script pontual)
from app.sefaz_scan import COMPANY_DISPLAY_NAME_BY_CNPJ


def main() -> None:
    settings.ensure_directories()
    records = list_pending()
    print(f"{len(records)} nota(s) pendente(s) em pending_review/. Verificando nome da empresa por CNPJ...\n")

    atualizadas = 0
    ja_corretas = 0
    cnpj_desconhecido = 0

    for record in records:
        cnpj = record.nfe_data.destinatario_cnpj
        nome_atual = record.nfe_data.destinatario_nome

        if not cnpj or cnpj not in COMPANY_DISPLAY_NAME_BY_CNPJ:
            cnpj_desconhecido += 1
            print(f"  SEM MAPA  chave={record.chave} destinatario_cnpj={cnpj!r} (fora da lista de empresas conhecidas).")
            continue

        nome_canonico = COMPANY_DISPLAY_NAME_BY_CNPJ[cnpj]
        if nome_atual == nome_canonico:
            ja_corretas += 1
            continue

        json_path = _json_path_for(record.chave)
        if not json_path:
            print(f"  AVISO  chave={record.chave}: .review.json não encontrado. Pulando.")
            continue

        with open(json_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        payload["nfe_data"]["destinatario_nome"] = nome_canonico
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        atualizadas += 1
        print(f"  OK  chave={record.chave}: '{nome_atual}' -> '{nome_canonico}'")

    print(
        f"\nTotal: {atualizadas} atualizada(s), {ja_corretas} já correta(s), "
        f"{cnpj_desconhecido} com CNPJ fora da lista conhecida, de {len(records)} pendente(s)."
    )


if __name__ == "__main__":
    main()
