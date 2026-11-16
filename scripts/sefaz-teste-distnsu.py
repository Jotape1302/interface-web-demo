"""Teste (não grava documentos): a SEFAZ aceita distNSU com ultNSU ANTIGO (atrás do cursor)?

Se aceitar, a recuperação do histórico pode trazer 50 documentos por consulta (como a varredura
do primeiro dia) em vez de 1 por consNSU. Faz UMA consulta por CNPJ informado, a partir do ponto
atual do histórico, e mostra o que veio. Respeita o cooldown e grava um novo depois da consulta
(a varredura agendada não consulta esse CNPJ na próxima hora). Nada vai para a revisão: os
documentos continuam na recuperação normal.

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - < scripts/sefaz-teste-distnsu.py               # Curitiba
  docker compose exec -T automacao-nfe python - 27184930000107 < scripts/sefaz-teste-distnsu.py  # Campinas

Com "esperar": se o CNPJ estiver em cooldown, espera ele acabar e consulta na hora (a rodada
agendada só sai 2 min depois do fim do cooldown, então o teste vai antes dela).
"""

import sys
import time

sys.path.insert(0, "/app")
from app import sefaz_scan  # noqa: E402
from app.config import settings  # noqa: E402

ESPERAR = "esperar" in sys.argv[1:]
alvos = [a.strip() for a in sys.argv[1:] if a.strip() and a.strip() != "esperar"] or ["27184930000280"]
providers = {p.cnpj: p for p in sefaz_scan._resolve_providers(settings)}

for cnpj in alvos:
    nome = sefaz_scan.COMPANY_DISPLAY_NAME_BY_CNPJ.get(cnpj, "?")
    provider = providers.get(cnpj)
    if provider is None:
        print(f"{cnpj}: não monitorado")
        continue
    resta = sefaz_scan.get_cnpj_cooldown_remaining_seconds(cnpj, settings)
    if resta > 0 and ESPERAR:
        print(f"{cnpj} {nome}: em cooldown, esperando {resta // 60} min {resta % 60} s...", flush=True)
        time.sleep(resta + 3)
        resta = sefaz_scan.get_cnpj_cooldown_remaining_seconds(cnpj, settings)
    if resta > 0:
        print(f"{cnpj} {nome}: em cooldown por mais {resta // 60} min, tente depois.")
        continue
    h = sefaz_scan.load_historico(cnpj, settings)
    cursor = int(sefaz_scan.load_nsu_state(settings).get(cnpj) or 0)
    if h and h.get("fase") == "avanco":
        inicio = int(h["proximo"]) - 1
    else:
        inicio = max(0, cursor - 300)
    ult = f"{inicio:015d}"
    print(f"{cnpj} {nome}: cursor {cursor}; distNSU com ultNSU {inicio} ({cursor - inicio} atrás do cursor)...")
    try:
        r = provider.consultar_distribuicao_nsu(ult_nsu=ult)
    except Exception as e:
        print(f"  erro: {e}")
        continue
    finally:
        sefaz_scan.save_cnpj_cooldown(cnpj, sefaz_scan.SCAN_COOLDOWN_SECONDS, settings)
    datas = sorted(d for d in (sefaz_scan._data_do_documento(doc.xml_content) for doc in r.docs) if d)
    nsus = [int(doc.nsu) for doc in r.docs if str(doc.nsu).isdigit()]
    print(f"  cStat {r.c_stat} - {r.x_motivo}")
    print(f"  ultNSU devolvido {r.ult_nsu}, maxNSU {r.max_nsu}, {len(r.docs)} documento(s)"
          + (f" (NSU {min(nsus)} a {max(nsus)})" if nsus else "")
          + (f", datas {datas[0]} a {datas[-1]}" if datas else ""))
    print("  => ACEITA consulta antiga" if r.c_stat == "138" and r.docs else "  => não trouxe documentos")
