"""Diagnóstico (somente leitura) de UMA venda na conciliação ML: onde está, como foi baixada e o que
aconteceu com cada lançamento de caixa dela (tarifas, frete, extras).

Roda DENTRO do container do financeiro, da raiz do projeto:

  docker compose exec -T automacao-nfe python - 2000014116776461 < scripts/diagnostico-venda-ml.py
  docker compose exec -T automacao-nfe python - 2000014116776461 mp < scripts/diagnostico-venda-ml.py

Com "mp", consulta também (só GET) o pagamento no Mercado Pago: cobranças (charges_details) e o
acréscimo do comprador que a regra do parcelamento lê.

Mostra, para cada análise que tem a venda (inclusive a consolidada): situação, conta do Tiny, data
da baixa, frete no caixa, se as tarifas da venda antiga foram lidas e cada lançamento candidato com
o destino (lançado pela API, incerto, saiu numa planilha ou ainda pendente). Depois, as linhas do
estado e do log das execuções que citam a venda. Não grava nada e não consulta Tiny nem ML (o MP só com "mp").
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/app")
from app import ml_reconciliation as ml  # noqa: E402
from app.ml_reconciliation_rotina import EstadoML, RotinaConciliacaoML  # noqa: E402

if len(sys.argv) < 2:
    sys.exit("Uso: ... python - <número da venda> < scripts/diagnostico-venda-ml.py")
venda = "".join(c for c in sys.argv[1] if c.isdigit())
consultar_mp = "mp" in sys.argv[2:]

estado = EstadoML()
dados = estado.ler()
tiny = dados.get("lancamentos_tiny") or {}
incertos = dados.get("lancamentos_tiny_incertos") or {}
exportados = dados.get("lancamentos_exportados") or {}


def destino(chave: str) -> str:
    if chave in tiny:
        i = tiny[chave]
        return f"LANÇADO pela API (id {i.get('id')}, {i.get('em', '')[:16]})"
    if chave in incertos:
        return f"INCERTO ({incertos[chave].get('erro', '')[:80]})"
    if chave in exportados:
        return f"saiu numa planilha em {exportados[chave]}"
    return "PENDENTE (nem lançado nem exportado)"


achou = False
for arq in sorted((estado.pasta / "analises").glob("*.json")):
    analise = estado.analise(arq.stem)
    if analise is None:
        continue
    for g in analise.grupos:
        if g.id_venda != venda and venda not in (g.id_operacao or ""):
            continue
        achou = True
        print(f"\n== {arq.stem}: grupo {g.id}")
        print(f"  situação: {g.situacao} | conta #{g.conta_id} | baixado em {g.baixado_em or '-'} | venda em {g.data_venda} | liberação {g.data}")
        print(f"  recebido R$ {g.valor_total} (produtos {g.valor_produtos}, frete {g.valor_frete}) | frete no caixa R$ {g.frete_no_caixa}")
        print(f"  tarifas da venda antiga lidas: {getattr(g, 'caixa_lido', '-')} | cópia no grupo: {len(g.lancamentos_caixa)} lançamento(s)")
        print(f"  mensagem: {g.mensagem}")
        print(f"  conta: valor {g.conta_valor} | saldo {g.conta_saldo} | pago {g.conta_valor_pago} | pagamentos {g.ids_pagamento}")
        print(f"  pedidos do pacote {g.ids_pedido} (lidos: {g.ids_pedido_lidos}) | números procurados {ml.numeros_da_venda(g)}"
              f" | pagamentos pelas chaves {ml.pagamentos_do_grupo(g)} | venda procurada {g.venda_procurada}")
        print(f"  chaves: {g.chaves[:4]}{' …' if len(g.chaves) > 4 else ''}")
        print(f"  parcelamento no relatório R$ {g.valor_parcelamento} (descontado: {g.parcelamento_descontado})"
              f" | acréscimo do comprador R$ {g.valor_acrescimo} (consultado: {g.acrescimo_consultado},"
              f" descontado: {g.acrescimo_descontado}, linha bloqueada: {g.acrescimo_bloqueado})"
              f" | cupom R$ {g.valor_cupom} (descontado: {g.cupom_descontado})")
        if consultar_mp:
            try:
                cli = RotinaConciliacaoML().fabrica_mp(ml.EMPRESAS_ML[analise.empresa_id])
                for pid in g.ids_pagamento or ([g.id_operacao] if g.id_operacao else []):
                    pg = cli._chamar("GET", f"/v1/payments/{pid}", f"diagnóstico do pagamento {pid}")
                    print(f"  MP pagamento {pid}: bruto {pg.get('transaction_amount')} | parcelas {pg.get('installments')}"
                          f" | líquido {(pg.get('transaction_details') or {}).get('net_received_amount')}"
                          f" | pago pelo comprador {(pg.get('transaction_details') or {}).get('total_paid_amount')}")
                    for c in pg.get("charges_details") or []:
                        print(f"     cobrança {c.get('name')} | {c.get('type')} | de {(c.get('accounts') or {}).get('from')}"
                              f" para {(c.get('accounts') or {}).get('to')} | {c.get('amounts')}")
                    print(f"     acréscimo lido pela regra: R$ {cli.acrescimo_comprador(pid)}")
            except Exception as e:
                print(f"  MP: consulta falhou: {e}")
        lancs, na_planilha = RotinaConciliacaoML._lancamentos_do_grupo(analise, g)
        if not lancs:
            print("  nenhum lançamento de caixa candidato para esta venda")
        for l in lancs:
            ch = ml.chave_lancamento(l)
            print(f"   - {l.tipo_operacao} | {l.categoria} | {l.tipo} R$ {l.valor} | {'na planilha' if ch in na_planilha else 'cópia do grupo'} | {destino(ch)}")
        fretes = [m for m in analise.movimentos if m.id_venda == venda and m.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE]
        for m in fretes:
            print(f"   * linha de frete R$ {m.valor} ({m.chave}): {destino(m.chave)}")

if not achou:
    print(f"Venda {venda} não está em nenhuma análise salva.")

print("\n== estado.json (chaves que citam a venda)")
for campo, valor in dados.items():
    if isinstance(valor, dict):
        for k, v in valor.items():
            if venda in k or venda in json.dumps(v, ensure_ascii=False):
                print(f"  {campo}[{k[:70]}]: {json.dumps(v, ensure_ascii=False)[:220]}")

print("\n== logs das execuções que citam a venda")
for arq in sorted(estado.pasta.rglob("*.json")):
    if arq.parent.name == "analises" or arq == estado.arquivo:
        continue
    try:
        texto = arq.read_text(encoding="utf-8")
    except OSError:
        continue
    if venda in texto:
        for linha in texto.replace("\\n", "\n").splitlines():
            if venda in linha:
                print(f"  {arq.name}: {linha.strip()[:240]}")
