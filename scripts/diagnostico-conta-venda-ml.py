"""Diagnóstico (somente leitura) de "Conta não localizada" na conciliação ML: consulta o Tiny e mostra
por que nenhuma conta a receber foi ligada à venda.

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - 2000082629008667 < scripts/diagnostico-conta-venda-ml.py
  docker compose exec -T automacao-nfe python - 2000082629008667 revesta < scripts/diagnostico-conta-venda-ml.py

  ... python - 2000057678923331 pag=172584645148 pag=171685744887 < scripts/diagnostico-conta-venda-ml.py

Empresa padrão: norvia_campinas. "pag=<pagamento>" mostra o pedido e o pack_id do pagamento no ML. Mostra o pedido do Tiny (pelo número da venda no ML), a nota
fiscal, as contas da nota e TODAS as contas do cliente pelo nome (histórico, valor, vencimento e
situação), marcando as que citam a venda. Só faz GETs no Tiny; não grava nada.
"""

import sys

sys.path.insert(0, "/app")
from app import ml_reconciliation as ml  # noqa: E402
from app.ml_reconciliation_rotina import RotinaConciliacaoML  # noqa: E402

if len(sys.argv) < 2:
    sys.exit("Uso: ... python - <número da venda> [empresa] < scripts/diagnostico-conta-venda-ml.py")
venda = "".join(c for c in sys.argv[1] if c.isdigit())
empresa_id = next((a for a in sys.argv[2:] if not a.startswith("pag=")), "norvia_campinas")
if empresa_id not in ml.EMPRESAS_ML:
    sys.exit(f"Empresa '{empresa_id}' desconhecida: {', '.join(ml.EMPRESAS_ML)}")

rotina = RotinaConciliacaoML()
token = rotina.obter_token_tiny(empresa_id)
if not token:
    sys.exit(f"Sem token do Tiny para {empresa_id}.")
tiny = rotina.tiny


def linha_conta(c):
    cita = "CITA A VENDA" if ml.historico_cita_venda(str(c.get("historico") or ""), venda) else "não cita"
    cli = (c.get("cliente") or {}).get("nome", "") if isinstance(c.get("cliente"), dict) else ""
    return (
        f"   #{c.get('id')} | {c.get('situacao')} | R$ {c.get('valor')} | venc {c.get('vencimento') or c.get('dataVencimento')}"
        f" | emissão {c.get('data') or c.get('dataEmissao') or '-'} | {cli} | {cita}\n"
        f"      histórico: {str(c.get('historico') or '')[:200]!r}"
    )


achados = tiny.list_pedidos_v3(token, numero_pedido_ecommerce=venda, max_pages=1)
print(f"== Pedidos do Tiny ({empresa_id}) com numeroPedidoEcommerce={venda}: {len(achados)}")
nome = ""
datas, cliente_id, total = set(), None, None
for p in achados:
    pedido = tiny.obter_pedido_v3(token, int(p["id"]))
    cliente = pedido.get("cliente") or {}
    nota = pedido.get("notaFiscal") if isinstance(pedido.get("notaFiscal"), dict) else {}
    nota_id = (nota or {}).get("id") or pedido.get("idNotaFiscal")
    nome = nome or str(cliente.get("nome") or "")
    cliente_id = cliente_id or cliente.get("id")
    total = total or pedido.get("valorTotalPedido")
    for parc in (pedido.get("pagamento") or {}).get("parcelas") or []:
        if parc.get("data"):
            datas.add(str(parc["data"])[:10])
    print(f"  pedido id {pedido.get('id')} nº {pedido.get('numeroPedido') or pedido.get('numero')} | situação {pedido.get('situacao')}"
          f" | data {pedido.get('data') or pedido.get('dataPedido')} | total {pedido.get('valorTotalPedido') or pedido.get('valor')}")
    print(f"  cliente: {cliente.get('nome')!r} | doc {cliente.get('cpfCnpj')} | id {cliente.get('id')}")
    print(f"  ecommerce: {pedido.get('ecommerce')} | numeroPedidoEcommerce: {pedido.get('numeroPedidoEcommerce')}")
    print(f"  observações: {str(pedido.get('observacoes') or pedido.get('obs') or '')[:300]!r}")
    print(f"  nota fiscal: {nota_id or 'NENHUMA'} | pagamento: {pedido.get('pagamento') or pedido.get('parcelas')}")
    if nota_id:
        contas_nota = tiny.list_contas_receber_v3(token, id_nota=int(nota_id), max_pages=2, estrito=True)
        print(f"  contas da nota {nota_id}: {len(contas_nota)}")
        for c in contas_nota:
            print(linha_conta(c))

if nome:
    contas = tiny.list_contas_receber_v3(token, nome_cliente=nome, max_pages=5, estrito=True)
    print(f"\n== Contas a receber pelo nome {nome!r}: {len(contas)}")
    for c in contas:
        print(linha_conta(c))
    sem_doc = " ".join(w for w in nome.split() if not w.isdigit())
    if sem_doc != nome:
        contas2 = tiny.list_contas_receber_v3(token, nome_cliente=sem_doc, max_pages=5, estrito=True)
        print(f"\n== Contas pelo nome sem os dígitos {sem_doc!r}: {len(contas2)}")
        for c in contas2:
            print(linha_conta(c))

# Números do lado do ML: argumento "pag=<pagamento>" (um ou mais) mostra o pedido do pagamento no
# Mercado Pago e o pedido no Mercado Livre (id e pack_id).
for arg in sys.argv[2:]:
    if not arg.startswith("pag="):
        continue
    pid = arg[4:]
    try:
        emp = ml.EMPRESAS_ML[empresa_id]
        oid = rotina.fabrica_mp(emp).pedido_do_pagamento(pid)
        pml = rotina.fabrica_ml(emp).pedido(oid) if oid else None
        print(f"\n== ML: pagamento {pid} -> pedido {oid or '-'} | pack_id {(pml or {}).get('pack_id')}"
              f" | pagamentos do pedido {[p.get('id') for p in (pml or {}).get('payments') or []]}")
    except Exception as e:
        print(f"\n== ML: pagamento {pid}: consulta falhou: {e}")

# Busca sem o nome: contas com vencimento nas datas das parcelas do pedido; mostra as do mesmo
# cliente (id), as que citam a venda e as de mesmo valor.
for d in sorted(datas):
    contas3 = tiny.list_contas_receber_v3(token, data_inicial_vencimento=d, data_final_vencimento=d, max_pages=20, estrito=True)
    alvo = [
        c for c in contas3
        if (isinstance(c.get("cliente"), dict) and cliente_id and str(c["cliente"].get("id")) == str(cliente_id))
        or ml.historico_cita_venda(str(c.get("historico") or ""), venda)
        or (total is not None and abs(float(c.get("valor") or 0) - float(total)) < 0.01)
    ]
    print(f"\n== Contas com vencimento {d}: {len(contas3)} no dia; do cliente/citando a venda/mesmo valor: {len(alvo)}")
    for c in alvo:
        print(linha_conta(c))
