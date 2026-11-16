"""Diagnóstico (somente leitura): o pagamento do Mercado Pago de vendas da conciliação ML.

Roda DENTRO do container do financeiro, com as vendas como empresa:id_venda:

  docker compose exec -T automacao-nfe python - norvia_campinas:2000027262486935 \\
      revesta:2000030852303929 < scripts/diagnostico-pagamento-ml.py

Acha a venda na análise salva mais recente da empresa (DATA_DIR/conciliacao_ml/analises), mostra
o grupo (recebido × conta do Tiny), as linhas da liberação e, para cada id de pagamento, os valores
de GET /v1/payments/{id}: transaction_details, fee_details e charges_details. Sem dados do
comprador. Feito para os divergentes com diferença menor que o custo de parcelamento (2026-11).
Não grava nada.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/app")
from app.config import settings  # noqa: E402
from app.ml_apis import ClienteMercadoPago, token_mp  # noqa: E402
from app.ml_reconciliation import EMPRESAS_ML  # noqa: E402

CAMPOS_PAGAMENTO = (
    "id", "status", "status_detail", "date_approved", "transaction_amount", "transaction_amount_refunded",
    "coupon_amount", "shipping_amount", "taxes_amount", "installments", "payment_type_id", "payment_method_id",
)
CAMPOS_GRUPO = (
    "situacao", "mensagem", "valor_total", "valor_produtos", "valor_frete", "valor_parcelamento", "valor_cupom",
    "conta_id", "conta_valor", "conta_saldo", "conta_valor_pago", "data", "data_venda", "ids_pagamento",
)
CAMPOS_MOV = ("id_pagamento", "tipo_operacao", "descricao", "valor", "data", "data_venda")


def analises_da_empresa(empresa_id):
    pasta = Path(settings.DATA_DIR) / "conciliacao_ml" / "analises"
    for arq in sorted(pasta.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            dados = json.loads(arq.read_text(encoding="utf-8"))
        except Exception:
            continue
        if dados.get("empresa_id") == empresa_id:
            yield arq.name, dados


def mostrar(empresa_id, venda):
    print(f"\n===== {empresa_id} venda {venda}")
    empresa = EMPRESAS_ML.get(empresa_id)
    if not empresa:
        print("  empresa desconhecida:", empresa_id, "| opções:", ", ".join(EMPRESAS_ML))
        return
    for nome, dados in analises_da_empresa(empresa_id):
        grupos = [g for g in dados.get("grupos") or [] if str(g.get("id_venda")) == venda]
        if grupos:
            break
    else:
        print("  venda não achada nas análises salvas da empresa")
        return
    print("  análise:", nome)
    # Na consolidada os índices do grupo apontam para a análise de origem, não para estas linhas:
    # só vale a linha da mesma venda.
    movimentos = dados.get("movimentos") or []
    ids = []
    for g in grupos:
        print("  grupo:", json.dumps({k: g.get(k) for k in CAMPOS_GRUPO}, ensure_ascii=False))
        for i in g.get("indices") or []:
            m = movimentos[i] if 0 <= i < len(movimentos) else {}
            if str(m.get("id_venda") or "") != venda:
                continue
            print("    mov:", json.dumps({k: m.get(k) for k in CAMPOS_MOV}, ensure_ascii=False))
            ids.append(str(m.get("id_pagamento") or ""))
        ids += [str(x) for x in g.get("ids_pagamento") or []]
        if not ids and g.get("id_operacao"):
            ids.append(str(g["id_operacao"]))
    mp = ClienteMercadoPago(empresa.id, lambda: token_mp(empresa.id, empresa.conta_ml, permitir_fallback_ml=False))
    for pid in sorted({x for x in ids if x}):
        try:
            pg = mp._chamar("GET", f"/v1/payments/{pid}", f"buscar o pagamento {pid}")
        except Exception as ex:
            print("  pagamento", pid, "não lido:", ex)
            continue
        print("  MP:", json.dumps({k: pg.get(k) for k in CAMPOS_PAGAMENTO}, ensure_ascii=False))
        print("    transaction_details:", json.dumps(pg.get("transaction_details"), ensure_ascii=False))
        print("    fee_details:", json.dumps(pg.get("fee_details"), ensure_ascii=False))
        cobrancas = [{k: c.get(k) for k in ("name", "type", "accounts", "amounts")} for c in pg.get("charges_details") or []]
        print("    charges_details:", json.dumps(cobrancas, ensure_ascii=False))


vendas = sys.argv[1:]
if not vendas:
    sys.exit("informe as vendas como empresa:id_venda (ex.: norvia_campinas:2000027262486935)")
for arg in vendas:
    empresa_id, _, venda = arg.partition(":")
    mostrar(empresa_id.strip(), venda.strip())
