"""Diagnóstico (somente leitura): recebimentos "sem venda" da conciliação ML.

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - 2453.64 2000036158838540 < scripts/diagnostico-ml-sem-venda.py

Argumentos opcionais: o valor de um recebimento a detalhar e o número da venda no Mercado Livre.
Para cada empresa: quantos grupos da consolidada estão sem venda; para o valor pedido (ou os 8
primeiros), o que o Mercado Pago diz do pagamento (pedido ligado, descrição, comprador). Com o
número da venda, os pagamentos que o pedido do Mercado Livre traz. Não grava nada.
"""

import sys
from decimal import Decimal

sys.path.insert(0, "/app")
from app import ml_reconciliation as ml  # noqa: E402
from app.ml_reconciliation_rotina import rotina  # noqa: E402

valor = Decimal(sys.argv[1]) if len(sys.argv) > 1 else None
venda = sys.argv[2] if len(sys.argv) > 2 else ""

for empresa in ml.EMPRESAS_ML.values():
    print(f"\n===== {empresa.nome} ({empresa.id})")
    cons = rotina.estado.analise(f"consolidado_{empresa.id}")
    if cons is None:
        print("  sem consolidada")
        continue
    sem = [g for g in cons.grupos if not g.id_venda and g.situacao != ml.SIT_CONCILIADO]
    total = sum((g.valor_total for g in sem), Decimal("0"))
    print(f"  {len(sem)} recebimento(s) sem venda, R$ {total:.2f}")
    alvo = [g for g in sem if valor is not None and abs(g.valor_total - valor) < Decimal("0.01")] or sem[:8]
    mp = rotina.fabrica_mp(empresa)
    for g in alvo:
        print(f"  - grupo {g.id}: liberação {g.data}, venda {g.data_venda or '?'}, R$ {g.valor_total:.2f}, "
              f"pagamento(s) {g.ids_pagamento}, operação {g.id_operacao or '-'}, situação {g.situacao}")
        for pid in g.ids_pagamento[:3]:
            try:
                p = mp._chamar("GET", f"/v1/payments/{pid}", f"buscar o pagamento {pid}") or {}
            except Exception as e:
                print(f"      pagamento {pid}: erro {e}")
                continue
            ordem = p.get("order") or {}
            print(f"      pagamento {pid}: pedido {ordem.get('id')} ({ordem.get('type')}), "
                  f"external_reference={p.get('external_reference')}, operação={p.get('operation_type')}, "
                  f"status={p.get('status')}, aprovado={p.get('date_approved')}, valor={p.get('transaction_amount')}, "
                  f"descrição={str(p.get('description') or '')[:60]!r}")
    if venda:
        try:
            pedido = rotina.fabrica_ml(empresa).pedido(venda)
        except Exception as e:
            print(f"  venda {venda} no ML desta conta: erro {e}")
            continue
        if not pedido:
            print(f"  venda {venda}: não é desta conta do ML")
            continue
        pags = [(x.get("id"), x.get("status"), x.get("transaction_amount")) for x in pedido.get("payments") or []]
        print(f"  venda {venda}: data {pedido.get('date_created')}, pack {pedido.get('pack_id')}, "
              f"status {pedido.get('status')}, pagamentos {pags}")
