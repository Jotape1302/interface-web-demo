"""Consulta (somente leitura): as categorias da planilha de lançamentos da conciliação ML no Tiny.

Roda DENTRO do container do financeiro:

  docker compose exec -T automacao-nfe python - < scripts/categorias-tiny-conciliacao-ml.py

Para cada empresa: cada categoria que a conciliação usa (MAPEAMENTO_LANCAMENTOS) e se existe no Tiny
com o nome exato (o lançamento pela API só aceita nome exato e único); depois, todas as categorias de
receita/despesa cadastradas no Tiny, para montar o de-para das que não batem; e o contato do Mercado
Livre (EBAZAR.COM.BR LTDA) que os lançamentos de caixa usam. Não grava nada.
"""

import sys

sys.path.insert(0, "/app")
from app import ml_reconciliation as ml  # noqa: E402
from app.ml_reconciliation_rotina import ResolvedorTiny, token_tiny  # noqa: E402
from app.tiny_client import TinyClient  # noqa: E402

usadas = sorted({cat for cat, _ in ml.MAPEAMENTO_LANCAMENTOS.values()})
tiny = TinyClient()
resolvedor = ResolvedorTiny(tiny, token_tiny)
for empresa in ml.EMPRESAS_ML.values():
    print(f"\n===== {empresa.nome} ({empresa.id})")
    token = token_tiny(empresa.id)
    if not token:
        print("  sem token do Tiny")
        continue
    try:
        cats = tiny.list_categorias_receita_despesa_v3(token, force_refresh=True)
    except Exception as e:
        print("  categorias não lidas:", e)
        continue
    por_nome = {}
    for c in cats:
        nome = str(c.get("descricao") or c.get("nome") or "")
        por_nome.setdefault(ml._normalizar_nome(nome), []).append((c.get("id"), nome))
    try:
        print(f"  Contato {ml.CONTATO_PUBLICIDADE[0]}: #{resolvedor.contato_mercado_livre(empresa)}")
    except Exception as e:
        print(f"  Contato {ml.CONTATO_PUBLICIDADE[0]}: PROBLEMA — {e}")
        for c in tiny.buscar_contatos_v3(token, nome="EBAZAR"):
            print(f"    parecido: #{c.get('id')}  {c.get('nome')}  {c.get('cpfCnpj')}")
    print("  Categorias da planilha:")
    for cat in usadas:
        achadas = por_nome.get(ml._normalizar_nome(cat), [])
        situacao = "OK" if len(achadas) == 1 else ("REPETIDA" if achadas else "NÃO EXISTE")
        print(f"    [{situacao:>10}] {cat}" + (f"  -> #{achadas[0][0]}" if len(achadas) == 1 else ""))
    print(f"  Todas as categorias do Tiny ({len(cats)}):")
    for c in sorted(cats, key=lambda c: str(c.get("descricao") or c.get("nome") or "").lower()):
        print(f"    #{c.get('id')}  {c.get('descricao') or c.get('nome')}  ({c.get('grupo') or c.get('tipo') or ''})")
