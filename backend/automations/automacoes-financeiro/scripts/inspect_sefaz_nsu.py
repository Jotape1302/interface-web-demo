#!/usr/bin/env python3
"""
Utilitário de Diagnóstico e Gestão de NSU / Cooldown SEFAZ
Permite visualizar os checkpoints de NSU, status de cooldown e, se necessário,
resetar o cooldown de 1h ou ajustar o NSU de um CNPJ travado.

Uso no servidor:
  python3 /app/scripts/inspect_sefaz_nsu.py
  python3 /app/scripts/inspect_sefaz_nsu.py --reset-cooldown
  python3 /app/scripts/inspect_sefaz_nsu.py --reset-cooldown --cnpj 27184930000280
  python3 /app/scripts/inspect_sefaz_nsu.py --set-nsu 000000000000100 --cnpj 36592814000100
"""
import argparse
import json
import sys
from pathlib import Path
from datetime import datetime, timezone

# Adiciona o diretório app ao path caso executado de scripts/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.sefaz_scan import (
    load_nsu_state,
    save_nsu_checkpoint,
    load_cooldown_state,
    clear_cnpj_cooldown,
    get_cnpj_cooldown_remaining_seconds,
    get_scan_status,
    COMPANY_DISPLAY_NAME_BY_CNPJ,
)


def main():
    parser = argparse.ArgumentParser(description="Inspecionar e ajustar checkpoints de NSU e Cooldown SEFAZ")
    parser.add_argument("--cnpj", type=str, help="CNPJ específico (apenas dígitos)")
    parser.add_argument("--reset-cooldown", action="store_true", help="Limpa o cooldown de 1h (para o CNPJ informado ou todos)")
    parser.add_argument("--set-nsu", type=str, help="Define manualmente o ultNSU de um CNPJ (requer --cnpj)")
    parser.add_argument("--reset-nsu", action="store_true", help="Reseta o NSU para '0' (requer --cnpj)")

    args = parser.parse_args()
    settings.ensure_directories()

    cnpj_clean = "".join(c for c in args.cnpj if c.isdigit()) if args.cnpj else None

    if args.reset_cooldown:
        clear_cnpj_cooldown(cnpj_clean, settings)
        print(f"✅ Cooldown limpo para: {cnpj_clean or 'TODOS os CNPJs'}")

    if args.set_nsu:
        if not cnpj_clean:
            print("❌ Erro: --set-nsu exige --cnpj")
            sys.exit(1)
        save_nsu_checkpoint(cnpj_clean, args.set_nsu, settings)
        print(f"✅ NSU do CNPJ {cnpj_clean} atualizado para: {args.set_nsu}")

    if args.reset_nsu:
        if not cnpj_clean:
            print("❌ Erro: --reset-nsu exige --cnpj")
            sys.exit(1)
        save_nsu_checkpoint(cnpj_clean, "0", settings)
        print(f"✅ NSU do CNPJ {cnpj_clean} resetado para '0'")

    print("\n" + "=" * 70)
    print("  ESTADO ATUAL DA VARREDURA SEFAZ (NFeDistribuicaoDFe)")
    print("=" * 70)

    nsu_state = load_nsu_state(settings)
    cooldown_state = load_cooldown_state(settings)
    scan_status = get_scan_status(settings)

    print(f"\n📁 Diretório de dados: {settings.DATA_DIR}")
    print(f"⏱  Última varredura iniciada em: {scan_status.get('last_scan_started_at') or 'Nunca'}")
    print(f"🏁  Última varredura finalizada em: {scan_status.get('last_scan_finished_at') or 'Nunca'}")
    print(f"🔄  Varredura em execução agora: {'SIM' if scan_status.get('is_running') else 'NÃO'}")

    all_cnpjs = sorted(set(list(COMPANY_DISPLAY_NAME_BY_CNPJ.keys()) + list(nsu_state.keys()) + list(cooldown_state.keys())))

    cnpjs_status_list = {c.get("cnpj"): c for c in scan_status.get("cnpjs", []) if isinstance(c, dict)}

    print("\n--- CNPJs MONITORADOS ---")
    for cnpj in all_cnpjs:
        name = COMPANY_DISPLAY_NAME_BY_CNPJ.get(cnpj, "CNPJ Desconhecido")
        nsu = nsu_state.get(cnpj, "0 (não iniciado)")
        rem_cd = get_cnpj_cooldown_remaining_seconds(cnpj, settings)
        cd_until = cooldown_state.get(cnpj)
        c_stat = cnpjs_status_list.get(cnpj, {})

        cd_desc = "Liberado para consulta"
        if rem_cd > 0:
            cd_desc = f"BLOQUEADO (Cooldown preventivo: {rem_cd // 60}m {rem_cd % 60}s restantes até {cd_until})"

        print(f"\n🏢 {name} ({cnpj})")
        print(f"   • ultNSU salvo: {nsu}")
        print(f"   • Status Cooldown: {cd_desc}")
        if c_stat.get("status"):
            st = c_stat.get("status").upper()
            novas = c_stat.get("novas_notas", 0)
            if st == "OK" and novas == 0:
                print(f"   • Status Última Varredura: {st} (100% SINCRONIZADO - Todos os documentos da SEFAZ já foram capturados)")
            else:
                print(f"   • Status Última Varredura: {st}")
        if "novas_notas" in c_stat:
            print(f"   • Novas notas baixadas nesta rodada: {c_stat.get('novas_notas', 0)}")
            print(f"   • Notas repetidas/já em fila ignoradas: {c_stat.get('duplicadas_ignoradas', 0)}")
            print(f"   • Eventos fiscais (CC-e/cancelamentos): {c_stat.get('eventos_ignorados', 0)}")
            divergentes = c_stat.get('destinatario_divergente_ignorado', 0)
            if divergentes:
                print(f"   ⚠️  Notas com destinatário divergente ignoradas: {divergentes} "
                      "(possível CNPJ errado no XML do fornecedor — recuperação é manual, por chave)")
        if c_stat.get("erro"):
            print(f"   • Erro retornado: {c_stat.get('erro')}")
            if "656" in str(c_stat.get("erro")):
                print("   ⚠️  AVISO SEFAZ: O WebService impõe bloqueio de 1 hora. Evite disparar novas consultas")
                print("       antes do término do cooldown acima para que o tempo de bloqueio não seja reiniciado.")

    print("\n" + "=" * 70 + "\n")


if __name__ == "__main__":
    main()
