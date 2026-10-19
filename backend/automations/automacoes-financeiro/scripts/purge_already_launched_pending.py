"""
Script operacional para verificar as notas que estão na pasta pending_review/
contra o Tiny ERP (utilizando a nova lógica de detecção de parcelas, idContato e histórico)
e arquivar automaticamente as notas que já constam lançadas no Tiny.

Uso no servidor (dentro do container):
    docker compose exec automacao-nfe python3 /app/scripts/purge_already_launched_pending.py
"""
import sys

sys.path.insert(0, "/app")

from app.config import settings
from app.review_pipeline import already_launched_in_tiny
from app.review_store import archive_pending, list_pending


def main() -> None:
    settings.ensure_directories()
    records = list_pending()
    print(f"Iniciando verificação de {len(records)} nota(s) em pending_review/ contra o Tiny ERP...\n")

    arquivadas = 0
    mantidas = 0

    for rec in records:
        numero = rec.nfe_data.numero_nota
        emitente = rec.nfe_data.emitente_nome
        chave = rec.chave
        valor = rec.nfe_data.valor_total

        print(f"Verificando NF {numero} - {emitente} (R$ {valor})...", end=" ", flush=True)

        try:
            if already_launched_in_tiny(rec.nfe_data):
                archive_pending(chave)
                arquivadas += 1
                print("[JÁ NO TINY -> ARQUIVADA]")
            else:
                mantidas += 1
                print("[OK - Permanece na revisão]")
        except Exception as e:
            mantidas += 1
            print(f"[ERRO ao verificar: {e}]")

    print(f"\nConcluído! Total verificadas: {len(records)} | Já no Tiny (arquivadas): {arquivadas} | Mantidas na revisão: {mantidas}")


if __name__ == "__main__":
    main()
