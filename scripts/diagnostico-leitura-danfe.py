"""Diagnóstico (somente leitura) da leitura de DANFE: onde o código de barras/OCR falha hoje.

Roda DENTRO do container do financeiro, que tem os diretórios e o app.config:

  docker compose exec -T automacao-nfe python - --dias 90 < scripts/diagnostico-leitura-danfe.py

Mostra:
  1. Falhas da etapa "scan" (chave não localizada por código de barras nem OCR) nos últimos N dias.
     O arquivo original dessas falhas NÃO fica guardado (só o .error.json): para a prova do modelo de
     visão, os originais precisam vir do Drive.
  2. Notas que passaram (pending_review/, processed/, archived/) por tipo de arquivo, modelo (55 NF-e,
     65 NFC-e) e origem dos itens: XML do arquivo, XML da SEFAZ (itens com NCM), OCR (sem NCM) ou
     item único de reserva ("NF-e N - fornecedor"). OCR e reserva são onde a leitura por visão ajudaria.
Com --detalhar ETAPA (ex.: tiny_erp), só agrupa as falhas daquela etapa pelo texto do erro.
Não grava nada.
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, "/app")
from app.config import settings  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--dias", type=int, default=90)
p.add_argument("--listar", type=int, default=30, help="quantas falhas/reservas listar por nome")
p.add_argument("--detalhar", metavar="ETAPA", help="só agrupa as falhas desta etapa (ex.: tiny_erp) pelo texto do erro")
args = p.parse_args()
corte = datetime.now(timezone.utc) - timedelta(days=args.dias)


def data(texto):
    try:
        d = datetime.fromisoformat(str(texto).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# 1. Falhas
resolvidas = {}
try:
    resolvidas = json.loads((settings.FAILED_DIR / "_resolved.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    pass
passos = Counter()
detalhe = defaultdict(list)
scan = []
for f in sorted(settings.FAILED_DIR.glob("*.error.json")):
    if "SEFAZ-SCAN" in f.name:
        continue
    try:
        e = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    quando = data(e.get("processed_at"))
    if not quando or quando < corte:
        continue
    passos[e.get("step") or "?"] += 1
    if args.detalhar and e.get("step") == args.detalhar:
        texto = e.get("details") or ""
        molde = re.sub(r"\d+", "#", texto)[:160]  # mesmo erro com chave/valor diferentes cai junto
        emit = (e.get("emitente") or {}).get("razao_social") or "?"
        detalhe[molde].append((quando, f.name in resolvidas, emit[:30], e.get("valor_total"), texto[:400]))
    if e.get("step") == "scan":
        scan.append((quando, e.get("original_filename") or "?", (e.get("details") or "")[:90]))

if args.detalhar:
    print(f"== Falhas da etapa {args.detalhar} nos últimos {args.dias} dias, agrupadas pelo texto")
    for molde, casos in sorted(detalhe.items(), key=lambda kv: -len(kv[1])):
        casos.sort()
        abertas = sum(1 for c in casos if not c[1])
        print(f"\n[{len(casos)}x, {abertas} sem resolver] {casos[0][0]:%Y-%m-%d} a {casos[-1][0]:%Y-%m-%d}")
        print(f"  exemplo: {casos[-1][4]}")
        for quando, resolvida, emit, valor, _ in casos[-5:]:
            print(f"    {quando:%Y-%m-%d %H:%M}  {'resolvida' if resolvida else 'aberta   '}  {emit:<30} R$ {valor}")
    sys.exit(0)

print(f"== Falhas nos últimos {args.dias} dias, por etapa")
for passo, n in passos.most_common():
    print(f"  {passo:<18} {n}")
print(f"\n== Chave não localizada (etapa scan): {len(scan)}")
for quando, nome, det in scan[-args.listar:]:
    print(f"  {quando:%Y-%m-%d}  {nome}  | {det}")


# 2. Notas que passaram
def origem(reg, ext):
    itens = reg.get("itens") or []
    if ext == ".xml":
        return "xml_arquivo"
    if any(i.get("ncm") for i in itens):
        return "xml_sefaz"
    if len(itens) == 1 and str(itens[0].get("descricao", "")).startswith("NF-e"):
        return "reserva_1_item"
    return "ocr" if itens else "sem_itens"


tabela = defaultdict(Counter)
reservas = []
total = 0
for pasta in (settings.PENDING_REVIEW_DIR, settings.PROCESSED_DIR, settings.ARCHIVED_DIR):
    for f in pasta.rglob("*.review.json"):
        try:
            reg = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        quando = data(reg.get("staged_at"))
        if not quando or quando < corte:
            continue
        nome = reg.get("staged_filename") or f.name[: -len(".review.json")]
        ext = Path(nome).suffix.lower() or "?"
        ext = ".imagem" if ext in (".jpg", ".jpeg", ".png", ".webp", ".heic") else ext
        chave = str(reg.get("chave") or "")
        modelo = {"55": "NF-e", "65": "NFC-e"}.get(chave[20:22], "?")
        o = origem(reg, ext)
        tabela[(ext, modelo)][o] += 1
        total += 1
        if o in ("ocr", "reserva_1_item"):
            reservas.append((quando, pasta.name, nome, o, len(reg.get("itens") or [])))

colunas = ["xml_arquivo", "xml_sefaz", "ocr", "reserva_1_item", "sem_itens"]
print(f"\n== Notas que passaram nos últimos {args.dias} dias: {total}")
print(f"  {'arquivo':<8} {'modelo':<6} " + " ".join(f"{c:>14}" for c in colunas))
for (ext, modelo), cont in sorted(tabela.items()):
    print(f"  {ext:<8} {modelo:<6} " + " ".join(f"{cont[c]:>14}" for c in colunas))
print(f"\n== Itens por OCR ou item único de reserva (candidatos à leitura por visão): {len(reservas)}")
for quando, pasta, nome, o, n in sorted(reservas)[-args.listar:]:
    print(f"  {quando:%Y-%m-%d}  {pasta:<14} {o:<14} {n:>3} item(ns)  {nome}")
