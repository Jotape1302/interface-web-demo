"""Põe NSUs pulados na fila de recuperação da varredura SEFAZ (consNSU). Não consulta a SEFAZ.

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - 36592814000100 157996 158014 < scripts/sefaz-recuperar-nsu.py
  docker compose exec -T automacao-nfe python - < scripts/sefaz-recuperar-nsu.py      (só mostra a fila)

  docker compose exec -T automacao-nfe python - historico 90 < scripts/sefaz-recuperar-nsu.py

"historico N" (dias) ou "historico AAAA-MM-DD": liga, nos 4 CNPJs, a recuperação do mais antigo
para o mais recente: acha por busca binária o primeiro documento da data de corte e anda para
frente (desde 11/11 por distNSU, 50 por consulta, em sequência até o fim da fila da SEFAZ,
levando o cursor junto; se a SEFAZ recusar a página antiga, a rodada vai por consNSU). A SEFAZ só distribui 90 dias. Argumentos da fila: CNPJ, primeiro NSU e
último NSU (inclusive). A fila e a busca binária vão por consNSU, até 15 por rodada e por CNPJ;
nota já vista ou já lançada no Tiny é ignorada.
"""

import sys

sys.path.insert(0, "/app")
from app.config import settings  # noqa: E402
from app import sefaz_scan  # noqa: E402

args = sys.argv[1:]
if len(args) == 3:
    cnpj, inicio, fim = "".join(c for c in args[0] if c.isdigit()), int(args[1]), int(args[2])
    if cnpj not in sefaz_scan.COMPANY_DISPLAY_NAME_BY_CNPJ:
        sys.exit(f"CNPJ {cnpj} não é monitorado.")
    print(f"{sefaz_scan.enfileirar_nsu_pendentes(cnpj, inicio, fim, settings)} NSU(s) novos na fila de {cnpj}.")
elif len(args) == 2 and args[0] == "historico":
    from datetime import timedelta
    from app.fuso import hoje_sp
    corte = (hoje_sp() - timedelta(days=int(args[1]))).isoformat() if args[1].isdigit() else args[1]
    for cnpj in sefaz_scan.COMPANY_DISPLAY_NAME_BY_CNPJ:
        fim = sefaz_scan.iniciar_historico(cnpj, corte, settings)
        print(f"{cnpj}: histórico ligado de {corte} até o cursor {fim} (busca o início nas primeiras rodadas).")
elif args:
    sys.exit("Uso: CNPJ PRIMEIRO_NSU ULTIMO_NSU")

for cnpj, nome in sefaz_scan.COMPANY_DISPLAY_NAME_BY_CNPJ.items():
    fila = sefaz_scan.load_nsu_pendentes(cnpj, settings)
    faixa = f" ({fila[0]} a {fila[-1]})" if fila else ""
    h = sefaz_scan.load_historico(cnpj, settings)
    if not h:
        hist = "; sem histórico em andamento"
    elif h["fase"] == "busca":
        hist = f"; histórico procurando o início de {h['corte']} entre os NSUs {h['lo']} e {h['hi']}"
    else:
        hist = f"; histórico de {h['corte']} no NSU {h['proximo']}, faltam {max(0, sefaz_scan.fim_historico(cnpj, h, settings) - int(h['proximo']) + 1)} até o NSU {sefaz_scan.fim_historico(cnpj, h, settings)} (o resto a varredura normal já baixou)"
    print(f"{cnpj} {nome}: {len(fila)} na fila{faixa}; cursor {sefaz_scan.load_nsu_state(settings).get(cnpj)}{hist}")
