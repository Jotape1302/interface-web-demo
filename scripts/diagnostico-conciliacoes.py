"""Diagnóstico (somente leitura): o que as conciliações deixam para a pessoa resolver à mão.

Roda DENTRO do container do financeiro:

  docker compose exec -T automacao-nfe python - < scripts/diagnostico-conciliacoes.py
  docker compose exec -T automacao-nfe python - --listar 40 < scripts/diagnostico-conciliacoes.py
  docker compose exec -T automacao-nfe python - --padrao 10.91 --empresa norvia_campinas < scripts/diagnostico-conciliacoes.py

1. Contas a Pagar (Inter × Tiny, DATA_DIR/contas_pagar/estado.json): casamentos por método/confiança,
   débitos do Inter sem conta no Tiny (por empresa e idade), contas do Tiny sem pagamento e como as
   contas saíram das pendências (baixa pela tela, baixa externa no Tiny...).
2. Conciliação Mercado Livre (DATA_DIR/conciliacao_ml/analises): última análise de cada empresa,
   recebimentos por situação (apto, divergente, não localizado...).
Base para decidir se vale um LLM sugerindo pares nos casos ambíguos (2026-11). Não grava nada.
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, "/app")
from app.config import settings  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--listar", type=int, default=20, help="quantos itens sem par listar")
p.add_argument("--detalhe", action="store_true",
               help="linhas da liberação dos padrões de VALOR DIVERGENTE do ML")
p.add_argument("--padrao", type=float, default=None,
               help="só o ML: todos os VALOR DIVERGENTE com essa diferença (liberado − saldo), com o pagamento "
                    "no Mercado Pago e o pedido no Mercado Livre de 3 amostras (GET, nada é gravado)")
p.add_argument("--empresa", default="", help="com --padrao: id da empresa (ex.: norvia_campinas)")
args = p.parse_args()
hoje = date.today()


def num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def primeiro(d, *campos):
    for c in campos:
        if d.get(c) not in (None, ""):
            return d[c]
    return ""


def idade(texto):
    try:
        return (hoje - date.fromisoformat(str(texto)[:10])).days
    except ValueError:
        return None


def faixa(dias):
    if dias is None:
        return "sem data"
    return "≤ 7 dias" if dias <= 7 else "8–30 dias" if dias <= 30 else "31–90 dias" if dias <= 90 else "> 90 dias"


# 1. Inter × Tiny ----------------------------------------------------------------------------
arq = Path(settings.DATA_DIR) / "contas_pagar" / "estado.json"
print("== Contas a Pagar (Inter × Tiny)")
if args.padrao is not None:
    print("  (pulado: --padrao olha só o Mercado Livre)")
elif not arq.is_file():
    print(f"  sem {arq}")
else:
    est = json.loads(arq.read_text(encoding="utf-8"))
    print(f"  atualizado em: {est.get('atualizado_em') or est.get('ultima_execucao') or '?'}")
    metodos = Counter()
    valor_metodo = defaultdict(float)
    for m in est.get("matches", []):
        chave = f"{m.get('metodo_match', '?')} ({num(m.get('confianca')):.0%})"
        metodos[chave] += 1
        valor_metodo[chave] += num(m.get("valor_pago"))
    print(f"\n  Casamentos pendentes de baixa: {sum(metodos.values())}")
    for k, n in metodos.most_common():
        print(f"    {k:<28} {n:>4}   R$ {valor_metodo[k]:>12,.2f}")

    sem_par = est.get("unmatched_inter", [])
    por_emp = Counter()
    por_faixa = Counter()
    valor_emp = defaultdict(float)
    for i in sem_par:
        emp = i.get("empresa") or "?"
        por_emp[emp] += 1
        valor_emp[emp] += num(primeiro(i, "valor_pago", "valor"))
        por_faixa[faixa(idade(primeiro(i, "data_pagamento", "data", "dataEntrada")))] += 1
    print(f"\n  Débitos do Inter SEM conta no Tiny: {len(sem_par)}")
    for emp, n in por_emp.most_common():
        print(f"    {emp:<20} {n:>4}   R$ {valor_emp[emp]:>12,.2f}")
    print("    por idade: " + ", ".join(f"{k}: {v}" for k, v in sorted(por_faixa.items())))
    if sem_par:
        print(f"    campos de um item: {sorted(sem_par[0].keys())}")
    for i in sorted(sem_par, key=lambda x: str(primeiro(x, "data_pagamento", "data")), reverse=True)[: args.listar]:
        desc = " · ".join(str(i.get(c))[:40] for c in ("nome_favorecido", "descricao") if i.get(c)) or str(i.get("titulo") or "")[:55]
        print(f"      {str(primeiro(i, 'data_pagamento', 'data'))[:10]}  {i.get('empresa', '?'):<18} "
              f"R$ {num(primeiro(i, 'valor_pago', 'valor')):>10,.2f}  {str(primeiro(i, 'tipo_transacao', 'tipo')):<14} {desc}")

    tiny = est.get("unmatched_tiny", [])
    vencidas = [c for c in tiny if (idade(primeiro(c, "data_vencimento", "vencimento")) or -1) > 0]
    print(f"\n  Contas do Tiny em aberto sem pagamento no Inter: {len(tiny)} "
          f"(R$ {sum(num(c.get('valor')) for c in tiny):,.2f}); vencidas: {len(vencidas)}")

    # Cruzamento: o débito sem par tem conta aberta do MESMO fornecedor no Tiny?
    from app.reconciliation import _extract_cnpj_from_tiny, _extract_supplier_name_from_tiny, _normalize_name

    def digitos(v):
        return "".join(ch for ch in str(v or "") if ch.isdigit())

    abertas = defaultdict(list)  # (empresa, cnpj|nome) -> contas
    for c in tiny:
        emp = str(c.get("empresa") or "").lower()
        cnpj = digitos(_extract_cnpj_from_tiny(c))
        nome = _normalize_name(_extract_supplier_name_from_tiny(c))
        for k in filter(None, (cnpj, nome)):
            abertas[(emp, k)].append(c)
    grupos_x = defaultdict(list)
    por_favorecido = defaultdict(lambda: [0, 0.0])
    for i in sem_par:
        emp = str(i.get("empresa") or "").lower()
        cands = {}
        for k in filter(None, (digitos(i.get("cpf_cnpj_favorecido")), _normalize_name(i.get("nome_favorecido")))):
            for c in abertas.get((emp, k), []):
                cands[c.get("id")] = c
        v = num(i.get("valor_pago"))
        valores = [num(c.get("valor") or c.get("saldo")) for c in cands.values()]
        if not cands:
            tipo = "C nada aberto desse fornecedor no Tiny"
            f = por_favorecido[str(i.get("nome_favorecido") or i.get("descricao") or "?")[:40]]
            f[0] += 1
            f[1] += v
        elif any(abs(x - v) <= 0.01 for x in valores):
            tipo = "A mesmo fornecedor e MESMO valor"
        elif abs(sum(valores) - v) <= 0.01:
            tipo = "B soma das contas do fornecedor = pagamento"
        elif any(abs(x - v) <= max(0.1 * x, 5) for x in valores):
            tipo = "D mesmo fornecedor, valor até 10% diferente"
        else:
            tipo = "E mesmo fornecedor, outro valor"
        grupos_x[tipo].append((v, i, valores))
    print("\n  Cruzamento dos débitos sem par com as contas abertas do Tiny (mesma empresa, CNPJ ou nome):")
    for tipo in sorted(grupos_x):
        lista = grupos_x[tipo]
        print(f"    {tipo:<46} {len(lista):>4}   R$ {sum(x[0] for x in lista):>12,.2f}")
    for tipo in sorted(t for t in grupos_x if not t.startswith("C")):
        print(f"\n    {tipo}: exemplos")
        for v, i, valores in sorted(grupos_x[tipo], key=lambda x: -x[0])[:8]:
            print(f"      {str(i.get('data_pagamento'))[:10]} {i.get('empresa', '?'):<18} R$ {v:>10,.2f}  "
                  f"{str(i.get('nome_favorecido'))[:35]:<35} contas no Tiny: {', '.join(f'{x:,.2f}' for x in sorted(valores)[:5])}")
    print("\n    C — favorecidos sem conta aberta no Tiny, por valor (recorrentes = despesa que nunca vira conta?):")
    for nome, (n, v) in sorted(por_favorecido.items(), key=lambda kv: -kv[1][1])[: args.listar]:
        print(f"      {n:>3}x  R$ {v:>12,.2f}  {nome}")

    saidas = est.get("historico_saidas", [])
    motivos = Counter(s.get("motivo") or "?" for s in saidas)
    print(f"\n  Como as contas saíram das pendências (histórico, {len(saidas)}): "
          + ", ".join(f"{k}: {v}" for k, v in motivos.most_common()))


def _venda(m):
    """`id_venda` do Movimento é propriedade e não vai para o JSON: calcula igual (pacote, pedido, op. original)."""
    return m.get("id_pacote") or m.get("id_pedido") or m.get("id_operacao_original") or ""


def detalhar_ml(a):
    """Linhas da liberação dos padrões de divergência (liberado − saldo mais repetidos)."""
    movs = {m.get("indice"): m for m in a.get("movimentos") or []}
    grupos = a.get("grupos") or []
    padroes = defaultdict(list)
    for g in grupos:
        if g.get("situacao") == "VALOR DIVERGENTE" and g.get("conta_saldo") is not None:
            padroes[round(num(g.get("valor_total")) - num(g.get("conta_saldo")), 2)].append(g)
    print("    -- Divergências: diferenças mais repetidas (liberado − saldo) e as linhas do Mercado Pago")
    for dif, gs in sorted(padroes.items(), key=lambda kv: -len(kv[1]))[:6]:
        print(f"    diferença R$ {dif:.2f}: {len(gs)} recebimento(s)")
        for g in gs[:3]:
            print(f"      venda {g.get('id_venda')} {g.get('data_venda') or g.get('data')}  liberado {num(g.get('valor_total')):.2f} "
                  f"(produtos {num(g.get('valor_produtos')):.2f}, frete {num(g.get('valor_frete')):.2f}, parcelamento {num(g.get('valor_parcelamento')):.2f})"
                  f"  | Tiny #{g.get('conta_id')} valor {num(g.get('conta_valor')):.2f} pago {num(g.get('conta_valor_pago')):.2f} "
                  f"saldo {num(g.get('conta_saldo')):.2f} contas={len(g.get('contas_vinculadas') or [])}")
            if g.get("conta_historico"):
                print(f"        histórico Tiny: {str(g.get('conta_historico'))[:110]}")
            linhas = [m for m in movs.values() if g.get("id_venda") and _venda(m) == g.get("id_venda")]
            for m in linhas or [movs.get(i) or {} for i in g.get("indices") or []]:
                print(f"        {m.get('tipo_operacao', '?'):<34} {num(m.get('valor')):>9.2f}  {str(m.get('descricao_mp'))[:45]}")


def _campos(d, *caminhos):
    """Campos aninhados ('a.b') que existem no dicionário, para imprimir só o que interessa."""
    saida = {}
    for c in caminhos:
        v = d
        for parte in c.split("."):
            v = v.get(parte) if isinstance(v, dict) else None
        if v not in (None, "", [], {}):
            saida[c] = v
    return saida


def investigar_padrao(emp, a, alvo):
    """Todos os divergentes com a diferença `alvo` e, em 3 amostras, o pagamento (MP) e o pedido (ML)."""
    movs = {m.get("indice"): m for m in a.get("movimentos") or []}
    gs = [g for g in a.get("grupos") or []
          if g.get("situacao") == "VALOR DIVERGENTE" and g.get("conta_saldo") is not None
          and abs(round(num(g.get("valor_total")) - num(g.get("conta_saldo")), 2) - alvo) < 0.005]
    print(f"\n  {a.get('empresa_nome', emp)}: {len(gs)} divergente(s) com diferença R$ {alvo:.2f}")
    if not gs:
        return
    print(f"    compradores distintos: {len({g.get('nome_cliente') for g in gs})}; "
          f"datas da venda distintas: {len({g.get('data_venda') or g.get('data') for g in gs})}")
    print("    sobra no produto (liberado − frete − saldo) × parcelamento × saldo:")
    sobras = Counter()
    for g in gs:
        sobra = round(num(g.get("valor_total")) - num(g.get("valor_frete")) - num(g.get("conta_saldo")), 2)
        parc = num(g.get("valor_parcelamento"))
        saldo = num(g.get("conta_saldo")) or 1
        sobras[(sobra, round(parc, 2), round(100 * sobra / saldo, 2))] += 1
    for (sobra, parc, pct), n in sobras.most_common(10):
        print(f"      {n:>3}x  sobra {sobra:>8.2f}  parcelamento {parc:>8.2f}  sobra/saldo {pct:>6.2f}%")
    por_cliente = Counter(g.get("nome_cliente") for g in gs)
    print("    por comprador: " + ", ".join(f"{c} ({n})" for c, n in por_cliente.most_common(8)))

    from app import ml_reconciliation as ml
    from app.ml_reconciliation_rotina import RotinaConciliacaoML
    rotina = RotinaConciliacaoML()
    empresa = ml.EMPRESAS_ML.get(emp)
    if empresa is None:
        print(f"    empresa {emp} não encontrada em EMPRESAS_ML: sem consulta às APIs")
        return
    try:
        mp, ml_cli = rotina.fabrica_mp(empresa), rotina.fabrica_ml(empresa)
    except Exception as e:  # sem credencial: fica só o que está na análise
        print(f"    APIs indisponíveis: {e}")
        return
    # 3 amostras, de compradores diferentes quando houver.
    amostras, nomes = [], set()
    for g in gs:
        if g.get("nome_cliente") not in nomes:
            nomes.add(g.get("nome_cliente"))
            amostras.append(g)
    amostras += [g for g in gs if g not in amostras]
    for g in amostras[:3]:
        linhas = [movs.get(i) or {} for i in g.get("indices") or []]
        pag_id = next((m.get("id_pagamento") for m in linhas if m.get("id_pagamento")), g.get("id_operacao"))
        ped_id = next((m.get("id_pedido") for m in linhas if m.get("id_pedido")), "")
        print(f"\n    venda {g.get('id_venda')} ({g.get('nome_cliente')}) — pagamento {pag_id}, pedido {ped_id}, "
              f"Tiny #{g.get('conta_id')} saldo {num(g.get('conta_saldo')):.2f}")
        # Todas as linhas da venda no relatório (tarifas, cupom, diferença...), não só as do grupo.
        for m in [m for m in movs.values() if g.get("id_venda") and _venda(m) == g.get("id_venda")] or linhas:
            print(f"      MP {m.get('tipo_operacao', '?'):<34} {num(m.get('valor')):>9.2f}  {m.get('situacao') or ''}"
                  f"  pagamento {m.get('id_pagamento')}")
        print(f"      análise: cupom {num(g.get('valor_cupom')):.2f} (campo {'presente' if 'valor_cupom' in g else 'AUSENTE: análise anterior a 04/11'})")
        try:
            pag = mp._chamar("GET", f"/v1/payments/{pag_id}", f"diagnóstico: pagamento {pag_id}") or {}
            print("      pagamento: " + json.dumps(_campos(
                pag, "status", "transaction_amount", "transaction_amount_refunded", "coupon_amount",
                "shipping_amount", "installments", "payment_type_id", "payment_method_id",
                "transaction_details.total_paid_amount", "transaction_details.installment_amount",
                "transaction_details.net_received_amount", "fee_details", "charges_details",
                "differential_pricing_id", "taxes_amount", "order.id"), ensure_ascii=False, default=str)[:1500])
        except Exception as e:
            print(f"      pagamento: erro {e}")
        if ped_id:
            try:
                ped = ml_cli.pedido(str(ped_id)) or {}
                itens = [{"titulo": str((i.get("item") or {}).get("title"))[:40], "qtd": i.get("quantity"),
                          "unit_price": i.get("unit_price"), "full_unit_price": i.get("full_unit_price"),
                          "sale_fee": i.get("sale_fee")} for i in ped.get("order_items") or []]
                print("      pedido: " + json.dumps({**_campos(ped, "total_amount", "paid_amount", "coupon",
                                                             "shipping_cost", "pack_id", "status"),
                                                     "itens": itens}, ensure_ascii=False, default=str)[:1200])
            except Exception as e:
                print(f"      pedido: erro {e}")


# 2. Mercado Livre ---------------------------------------------------------------------------
pasta = Path(settings.DATA_DIR) / "conciliacao_ml" / "analises"
print("\n== Conciliação Mercado Livre")
ultimas = {}
for f in pasta.glob("*.json") if pasta.is_dir() else []:
    try:
        a = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    emp = a.get("empresa_id") or "?"
    if emp not in ultimas or str(a.get("criada_em")) > str(ultimas[emp].get("criada_em")):
        ultimas[emp] = a
if not ultimas:
    print(f"  sem análises em {pasta}")
if args.padrao is not None:
    for emp, a in sorted(ultimas.items()):
        if not args.empresa or emp == args.empresa:
            investigar_padrao(emp, a, args.padrao)
    sys.exit(0)
for emp, a in sorted(ultimas.items()):
    grupos = a.get("grupos") or []
    sit = Counter()
    val = defaultdict(float)
    for g in grupos:
        sit[g.get("situacao") or "?"] += 1
        val[g.get("situacao") or "?"] += num(g.get("valor_total"))
    print(f"\n  {a.get('empresa_nome', emp)} — análise de {str(a.get('criada_em'))[:16]} "
          f"({a.get('origem', '?')}, período {a.get('periodo_de')} a {a.get('periodo_ate')}): {len(grupos)} recebimentos")
    for s, n in sit.most_common():
        print(f"    {s:<24} {n:>5}   R$ {val[s]:>12,.2f}")
    difs = Counter()
    for g in grupos:
        if g.get("situacao") == "VALOR DIVERGENTE" and g.get("conta_saldo") is not None:
            d = round(num(g.get("valor_total")) - num(g.get("conta_saldo")), 2)
            difs["liberado > saldo" if d > 0 else "liberado < saldo"] += 1
            difs[f"  diferença {'até R$ 1' if abs(d) <= 1 else 'até R$ 10' if abs(d) <= 10 else 'até R$ 50' if abs(d) <= 50 else 'acima de R$ 50'}"] += 1
    if args.detalhe:
        detalhar_ml(a)
    if difs:
        print("    VALOR DIVERGENTE (liberado − saldo da conta): " + ", ".join(f"{k.strip()}: {v}" for k, v in sorted(difs.items())))
    msgs = Counter(str(g.get("mensagem") or "")[:90] for g in grupos if g.get("situacao") in ("NÃO LOCALIZADO", "VALOR DIVERGENTE"))
    for m, n in msgs.most_common(6):
        print(f"      {n:>4}x  {m}")
    pend = (a.get("lancamentos") or {}).get("pendencias") or []
    if pend:
        print(f"    pendências de lançamento: {len(pend)}")

