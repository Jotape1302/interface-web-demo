"""Diagnóstico (somente leitura) dos recebimentos PENDENTES da conciliação ML, como a aba "Pendentes"
da tela (não aptos, não cancelados, não baixados): todos de uma vez, separados por situação.

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - < scripts/diagnostico-pendentes-ml.py
  docker compose exec -T automacao-nfe python - mp < scripts/diagnostico-pendentes-ml.py

Lê a visão consolidada das duas empresas. Com "mp", consulta (só GET) no Mercado Pago o pagamento de
cada VALOR DIVERGENTE: status, quanto foi estornado e o acréscimo do comprador — para separar venda
estornada/devolvida depois da liberação de diferença de preço ou parcelamento. Não grava nada.
"""
import sys
from collections import defaultdict
from decimal import Decimal

sys.path.insert(0, "/app")

from app import ml_reconciliation as ml  # noqa: E402
from app.ml_reconciliation_rotina import EstadoML, RotinaConciliacaoML  # noqa: E402

consultar_mp = "mp" in sys.argv[1:]
estado = EstadoML()
rotina = RotinaConciliacaoML() if consultar_mp else None


def pendente(g: ml.GrupoRecebimento) -> bool:
    return (not g.pode_baixar and g.situacao != ml.SIT_VENDA_CANCELADA
            and g.situacao != ml.SIT_CONCILIADO and not g.situacao.upper().startswith("STATUS:"))


for empresa_id, empresa in ml.EMPRESAS_ML.items():
    cons = estado.analise(f"consolidado_{empresa_id}")
    if cons is None:
        print(f"\n##### {empresa.nome}: sem visão consolidada")
        continue
    por_sit = defaultdict(list)
    for g in cons.grupos:
        if pendente(g):
            por_sit[g.situacao].append(g)
    total = sum(len(v) for v in por_sit.values())
    print(f"\n##### {empresa.nome}: {total} pendente(s) (consolidada {cons.id})")
    cliente = rotina.fabrica_mp(empresa) if rotina else None
    for sit, grupos in sorted(por_sit.items(), key=lambda x: -len(x[1])):
        print(f"\n=== {sit}: {len(grupos)}")
        for g in sorted(grupos, key=lambda x: ml._chave_data(x.data)):
            saldo = g.conta_saldo if g.conta_saldo is not None else "-"
            dif = (g.valor_total - g.conta_saldo) if g.conta_saldo is not None else None
            print(f"- {g.data} venda {g.id_venda or 'sem venda'} | {g.nome_cliente or '-'} | recebido {g.valor_total}"
                  f" | conta #{g.conta_id or '-'} saldo {saldo}" + (f" | diferença {dif}" if dif is not None else "")
                  + f" | parcelamento {g.valor_parcelamento} | pagamentos {ml.pagamentos_do_grupo(g)}")
            if g.mensagem:
                print(f"    {g.mensagem[:220]}")
            if cliente is not None and sit == ml.SIT_VALOR_DIVERGENTE:
                for pid in ml.pagamentos_do_grupo(g):
                    try:
                        pg = cliente._chamar("GET", f"/v1/payments/{pid}", f"diagnóstico do pagamento {pid}") or {}
                    except Exception as e:
                        print(f"    MP {pid}: consulta falhou: {e}")
                        continue
                    estornos = Decimal(str(pg.get("transaction_amount_refunded") or 0))
                    det = pg.get("transaction_details") or {}
                    acr = sum(
                        (Decimal(str((c.get("amounts") or {}).get("original") or 0)) for c in pg.get("charges_details") or []
                         if c.get("name") == "financing_transfer" and (c.get("accounts") or {}).get("from") == "payer"),
                        Decimal("0"),
                    )
                    print(f"    MP {pid}: status {pg.get('status')}/{pg.get('status_detail')} | bruto {pg.get('transaction_amount')}"
                          f" | pago pelo comprador {det.get('total_paid_amount')} | estornado {estornos}"
                          f" | estornos {len(pg.get('refunds') or [])} | acréscimo (original) {acr}")
