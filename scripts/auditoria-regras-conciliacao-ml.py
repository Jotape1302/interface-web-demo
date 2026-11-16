"""Auditoria (somente leitura): as regras de valor da conciliação ML conferidas com o Mercado Pago.

Roda DENTRO do container do financeiro:

  docker compose exec -T automacao-nfe python - < scripts/auditoria-regras-conciliacao-ml.py
  docker compose exec -T automacao-nfe python - --empresa revesta --max 300 < scripts/auditoria-regras-conciliacao-ml.py

Lê TODAS as análises salvas (DATA_DIR/conciliacao_ml/analises, inclusive a consolidada e as já
baixadas) e, para cada venda em que uma regra mexeu no valor ou na data da baixa, busca o pagamento
em GET /v1/payments/{id} e confere a regra com o que o Mercado Pago registrou:

  PARCELAMENTO  custo de parcelamento descontado da baixa  = acréscimo pago pelo comprador
                (charges_details financing_transfer, do comprador para o vendedor)
  CUPOM         cupom descontado da baixa                  = coupon_fee pago pelo vendedor
  FRETE         frete fora da conta, lançado no caixa      = frete pago pelo comprador
  BAIXA         valor da baixa                             = valor da transação (transaction_amount)
                                                             menos frete e cupom do vendedor
  DATA          data da venda usada na baixa               = date_approved (fuso de São Paulo)
  DIVERGENTE    (hipótese nova) recebido − saldo            = acréscimo pago pelo comprador

Também lista os VALOR DIVERGENTE da análise mais recente de cada empresa. Sem dados do comprador.
Não grava nada.
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, "/app")
from app.config import settings  # noqa: E402
from app.ml_apis import ClienteMercadoPago, token_mp  # noqa: E402
from app.ml_reconciliation import EMPRESAS_ML  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--empresa", help="só esta empresa (norvia_campinas ou revesta)")
p.add_argument("--max", type=int, default=400, help="máximo de pagamentos consultados por empresa")
args = p.parse_args()

CENTAVO = Decimal("0.01")
SP = ZoneInfo("America/Sao_Paulo")


def d(valor) -> Decimal:
    try:
        return Decimal(str(valor if valor not in (None, "") else 0))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def igual(a: Decimal, b: Decimal) -> bool:
    return abs(a - b) < CENTAVO


def data_br(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone(SP).strftime("%d/%m/%Y")
    except Exception:
        return ""


def resumo_pagamento(pg: dict) -> dict:
    acrescimo = Decimal("0")
    tarifa_parcelamento = Decimal("0")
    for c in pg.get("charges_details") or []:
        contas = c.get("accounts") or {}
        valores = c.get("amounts") or {}
        liquido = d(valores.get("original")) - d(valores.get("refunded"))
        if c.get("name") == "financing_transfer" and contas.get("from") == "payer":
            acrescimo += liquido
        if c.get("name") == "mp_financing_fee":
            tarifa_parcelamento += liquido
    cupom = sum(
        (abs(d(f.get("amount"))) for f in pg.get("fee_details") or []
         if f.get("type") == "coupon_fee" and f.get("fee_payer") == "collector"),
        Decimal("0"),
    )
    det = pg.get("transaction_details") or {}
    return {
        "transacao": d(pg.get("transaction_amount")),
        "total_pago": d(det.get("total_paid_amount")),
        "frete": d(pg.get("shipping_amount")),
        "acrescimo": acrescimo,
        "tarifa_parcelamento": tarifa_parcelamento,
        "cupom": cupom,
        "data": data_br(pg.get("date_approved") or ""),
        "status": pg.get("status"),
    }


def somar(resumos):
    total = defaultdict(lambda: Decimal("0"))
    datas = set()
    for r in resumos:
        for k, v in r.items():
            if isinstance(v, Decimal):
                total[k] += v
        datas.add(r["data"])
    total["datas"] = datas
    return total


pasta = Path(settings.DATA_DIR) / "conciliacao_ml" / "analises"
arquivos = sorted(pasta.glob("*.json"), key=lambda a: a.stat().st_mtime, reverse=True)
por_empresa = defaultdict(list)  # empresa -> [(arquivo, dados)] do mais novo ao mais antigo
for arq in arquivos:
    try:
        dados = json.loads(arq.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[aviso] {arq.name} ilegível: {e}")
        continue
    if args.empresa and dados.get("empresa_id") != args.empresa:
        continue
    por_empresa[dados.get("empresa_id")].append((arq.name, dados))

for empresa_id, analises in por_empresa.items():
    empresa = EMPRESAS_ML.get(empresa_id)
    if not empresa:
        continue
    print(f"\n################ {empresa_id}: {len(analises)} análise(s) salva(s)")
    mp = ClienteMercadoPago(empresa.id, lambda: token_mp(empresa.id, empresa.conta_ml, permitir_fallback_ml=False))
    cache = {}
    consultas = [0]

    def pagamento(pid):
        if pid in cache:
            return cache[pid]
        if consultas[0] >= args.max:
            return None
        consultas[0] += 1
        try:
            cache[pid] = resumo_pagamento(mp._chamar("GET", f"/v1/payments/{pid}", f"buscar o pagamento {pid}"))
        except Exception as e:
            cache[pid] = {"erro": str(e)[:160]}
        return cache[pid]

    # Uma ocorrência por venda+pagamentos: a análise mais nova (a que tem o estado mais recente).
    vistos = set()
    casos = []
    for nome, dados in analises:
        for g in dados.get("grupos") or []:
            usa_regra = (
                g.get("parcelamento_descontado") or g.get("cupom_descontado") or d(g.get("frete_no_caixa")) > 0
            )
            divergente = g.get("situacao") == "VALOR DIVERGENTE" and nome == analises[0][0]
            ids = [str(x) for x in g.get("ids_pagamento") or [] if x] or ([str(g["id_operacao"])] if g.get("id_operacao") else [])
            chave = (g.get("id_venda"), tuple(sorted(ids)))
            if not (usa_regra or divergente) or chave in vistos:
                continue
            vistos.add(chave)
            casos.append((nome, g, ids))

    contagem = defaultdict(lambda: [0, 0, 0])  # regra -> [ok, errado, sem dado]
    problemas = []
    for nome, g, ids in casos:
        resumos = [pagamento(pid) for pid in ids]
        if not ids or any(r is None or "erro" in r for r in resumos):
            motivo = "sem id de pagamento" if not ids else "; ".join(
                r["erro"] if r and "erro" in r else "limite de consultas" for r in resumos if r is None or "erro" in r
            )
            for regra in ("PARCELAMENTO", "CUPOM", "FRETE", "BAIXA", "DATA", "DIVERGENTE"):
                contagem[regra][2] += 1
            problemas.append(("SEM DADO", nome, g, ids, motivo))
            continue
        mp_ = somar(resumos)
        parc = d(g.get("valor_parcelamento"))
        cupom = d(g.get("valor_cupom"))
        frete_caixa = d(g.get("frete_no_caixa"))
        baixa = d(g.get("valor_total"))
        checagens = []
        if g.get("parcelamento_descontado"):
            checagens.append(("PARCELAMENTO", igual(parc, mp_["acrescimo"]),
                              f"descontado {parc} | acréscimo do comprador {mp_['acrescimo']} | parte da tarifa {mp_['tarifa_parcelamento']}"))
        if g.get("cupom_descontado"):
            checagens.append(("CUPOM", igual(cupom, mp_["cupom"]), f"descontado {cupom} | cupom do vendedor no MP {mp_['cupom']}"))
        if frete_caixa > 0:
            checagens.append(("FRETE", igual(frete_caixa, mp_["frete"]),
                              f"no caixa {frete_caixa} | frete no pagamento {mp_['frete']} | total pago − transação − acréscimo "
                              f"{mp_['total_pago'] - mp_['transacao'] - mp_['acrescimo']}"))
        if g.get("situacao") != "VALOR DIVERGENTE":
            esperado = mp_["transacao"] - mp_["frete"] - (mp_["cupom"] if g.get("cupom_descontado") else 0)
            checagens.append(("BAIXA", igual(baixa, esperado),
                              f"baixa {baixa} | transação {mp_['transacao']} − frete {mp_['frete']}"
                              f"{' − cupom ' + str(mp_['cupom']) if g.get('cupom_descontado') else ''} = {esperado} | conta Tiny {g.get('conta_valor')}"))
        if g.get("data_venda"):
            checagens.append(("DATA", g.get("data_venda") in mp_["datas"], f"data da venda {g.get('data_venda')} | aprovação MP {sorted(mp_['datas'])}"))
        if g.get("situacao") == "VALOR DIVERGENTE":
            saldo = d(g.get("conta_saldo") if g.get("conta_saldo") is not None else g.get("conta_valor"))
            exced = baixa - saldo
            checagens.append(("DIVERGENTE", igual(exced, mp_["acrescimo"]) and mp_["acrescimo"] > 0,
                              f"recebido {baixa} − saldo {saldo} = {exced} | acréscimo do comprador {mp_['acrescimo']} | "
                              f"parcelamento no relatório {parc} | cupom MP {mp_['cupom']} | frete MP {mp_['frete']}"))
        for regra, ok, texto in checagens:
            contagem[regra][0 if ok else 1] += 1
            if not ok:
                problemas.append((regra, nome, g, ids, texto))

    print(f"{len(casos)} venda(s) com regra aplicada ou divergente; {consultas[0]} pagamento(s) consultado(s).")
    print("regra          ok  não bate  sem dado")
    for regra in ("PARCELAMENTO", "CUPOM", "FRETE", "BAIXA", "DATA", "DIVERGENTE"):
        ok, errado, sem = contagem[regra]
        print(f"{regra:<13} {ok:>4} {errado:>9} {sem:>9}")
    for regra, nome, g, ids, texto in problemas[:80]:
        print(f"- [{regra}] venda {g.get('id_venda')} pag {','.join(ids)} | {g.get('situacao')} | {nome}\n    {texto}")
    if len(problemas) > 80:
        print(f"... e mais {len(problemas) - 80}")
