"""Diagnóstico (somente leitura): "Conta não localizada" da conciliação ML.

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - < scripts/diagnostico-ml-nao-localizado.py
  docker compose exec -T automacao-nfe python - 2000052386766494 2000063285832329 < scripts/diagnostico-ml-nao-localizado.py

Sem argumentos: as 6 primeiras vendas não localizadas de cada empresa. Com "resumo": conta a
situação do pedido no Tiny (2 = cancelado) de TODAS as não localizadas, sem detalhar. Para cada venda mostra o
caminho todo no Tiny: pedido pelo número do ML (situação, nota fiscal), contas pela nota e contas
pelo nome do cliente (histórico de cada uma), para ver por que nenhuma "cita a venda". Não grava nada.
"""

import sys

sys.path.insert(0, "/app")
from app import ml_reconciliation as ml  # noqa: E402
from app.ml_reconciliation_rotina import rotina  # noqa: E402

RESUMO = "resumo" in sys.argv[1:]
vendas = [a.strip() for a in sys.argv[1:] if a.strip() and a.strip() != "resumo"]
SITUACOES = {"0": "aberto", "1": "faturado", "2": "cancelado", "3": "aprovado", "4": "preparando envio",
             "5": "enviado", "6": "entregue", "7": "pronto p/ envio", "8": "dados incompletos", "9": "não entregue"}
tiny = rotina.tiny


def conta_txt(c):
    return (f"#{c.get('id')} {c.get('situacao')} valor={c.get('valor')} saldo={c.get('saldo')} "
            f"venc={c.get('dataVencimento') or c.get('vencimento')} hist={str(c.get('historico') or '')[:140]!r}")


for empresa in ml.EMPRESAS_ML.values():
    print(f"\n===== {empresa.nome} ({empresa.id})")
    cons = rotina.estado.analise(f"consolidado_{empresa.id}")
    token = rotina.obter_token_tiny(empresa.id)
    if cons is None or not token:
        print("  sem consolidada ou sem token do Tiny")
        continue
    nao = [g for g in cons.grupos if g.situacao == ml.SIT_NAO_LOCALIZADO]
    print(f"  {len(nao)} não localizado(s); com pacote/operação diferente da venda: "
          f"{sum(1 for g in nao if g.id_operacao and g.id_operacao != g.id_venda)}")
    if RESUMO:
        from collections import Counter
        cont, nota = Counter(), Counter()
        for g in nao:
            try:
                ps = tiny.list_pedidos_v3(token, numero_pedido_ecommerce=g.id_venda, max_pages=1)
            except Exception as e:
                cont[f"erro {str(e)[:40]}"] += 1
                continue
            if not ps:
                cont["sem pedido no Tiny"] += 1
                continue
            sit = SITUACOES.get(str(ps[0].get("situacao")), str(ps[0].get("situacao")))
            cont[sit] += 1
            if sit != "cancelado" and len(nota) < 15:
                nota[f"{g.id_venda} {g.data} R$ {g.valor_total:.2f} pedido #{ps[0].get('id')} {sit}"] += 1
        print("  situação do pedido no Tiny:", dict(cont))
        for k in nota:
            print("    não cancelado:", k)
        continue
    alvo = [g for g in nao if g.id_venda in vendas] if vendas else nao[:6]
    for g in alvo:
        print(f"\n  - venda {g.id_venda} (operação {g.id_operacao or '-'}), cliente {g.nome_cliente!r}, "
              f"liberação {g.data}, venda {g.data_venda}, R$ {g.valor_total:.2f}")
        try:
            pedidos = tiny.list_pedidos_v3(token, numero_pedido_ecommerce=g.id_venda, max_pages=1)
        except Exception as e:
            print(f"      pedidos do Tiny: erro {e}")
            pedidos = []
        print(f"      pedidos do Tiny com esse número: {len(pedidos)}")
        for p in pedidos[:3]:
            try:
                full = tiny.obter_pedido_v3(token, int(p["id"]))
            except Exception as e:
                print(f"      pedido {p.get('id')}: erro {e}")
                continue
            eco = full.get("ecommerce") or {}
            nota = full.get("notaFiscal") if isinstance(full.get("notaFiscal"), dict) else {}
            nota_id = (nota or {}).get("id") or full.get("idNotaFiscal")
            print(f"      pedido #{full.get('id')} nº {full.get('numeroPedido')} situação={full.get('situacao')} "
                  f"data={full.get('data')} total={full.get('valorTotalPedido') or full.get('valorTotal')} "
                  f"eco={eco.get('numeroPedidoEcommerce')}/{eco.get('numeroPedidoCanalVenda')} "
                  f"cliente={(full.get('cliente') or {}).get('nome')!r} nota={nota_id} "
                  f"parcelas={len(full.get('parcelas') or [])}")
            if nota_id:
                try:
                    cs = tiny.list_contas_receber_v3(token, id_nota=int(nota_id), max_pages=2, estrito=True)
                except Exception as e:
                    print(f"        contas pela nota: erro {e}")
                    cs = []
                print(f"        contas pela nota {nota_id}: {len(cs)}")
                for c in cs[:4]:
                    print(f"          {conta_txt(c)}  cita a venda? "
                          f"{ml.historico_cita_venda(str(c.get('historico') or ''), g.id_venda, g.id_operacao)}")
        try:
            cs = tiny.list_contas_receber_v3(token, nome_cliente=g.nome_cliente, max_pages=3, estrito=True)
        except Exception as e:
            print(f"      contas pelo nome: erro {e}")
            cs = []
        print(f"      contas pelo nome do cliente: {len(cs)}")
        for c in cs[:6]:
            print(f"        {conta_txt(c)}  cita a venda? "
                  f"{ml.historico_cita_venda(str(c.get('historico') or ''), g.id_venda, g.id_operacao)}")
