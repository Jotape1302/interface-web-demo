from datetime import date

from app.financial_dashboard import _merge_with_previous, _sync_one_company, build_dashboard_response
from app.tiny_client import TinyAPIError


def _somar_mes(por_dia, mes):
    """Soma por categoria todos os dias de `mes` ('YYYY-MM') de uma série diária do cache."""
    total = {}
    for dia, cats in por_dia.items():
        if dia.startswith(mes):
            for cat_id, valor in cats.items():
                total[cat_id] = total.get(cat_id, 0.0) + valor
    return total


def _sample_cache(today: date) -> dict:
    cur = today.strftime("%Y-%m")
    prev_month = date(today.year, today.month, 1)
    prev_month = date(prev_month.year - 1, 12, 1) if prev_month.month == 1 else date(prev_month.year, prev_month.month - 1, 1)
    prev = prev_month.strftime("%Y-%m")
    return {
        "generated_at": today.isoformat(),
        "lookback_months": 13,
        "companies": {
            "fabrilux": {
                "despesas_por_mes": {
                    cur: {"480897321": 1000.0, "484437383": 500.0},  # Compras, Aluguel
                    prev: {"480897321": 800.0, "484437383": 500.0},
                },
                "receitas_por_mes": {
                    cur: {"484450322": 3000.0},  # Vendas Loja
                    prev: {"484450322": 2000.0},
                },
                "contas_pagar_abertas": [
                    {
                        "id": 1,
                        "valor": 200.0,
                        "saldo": 200.0,
                        "data_vencimento": (today.fromordinal(today.toordinal() - 5)).isoformat(),
                        "situacao": "atrasadas",
                        "nome": "Fornecedor Vencido",
                        "numero_documento": "1",
                    },
                    {
                        "id": 2,
                        "valor": 300.0,
                        "saldo": 300.0,
                        "data_vencimento": (today.fromordinal(today.toordinal() + 3)).isoformat(),
                        "situacao": "aberto",
                        "nome": "Fornecedor Futuro",
                        "numero_documento": "2",
                    },
                ],
                "contas_receber_abertas": [
                    {
                        "id": 10,
                        "valor": 400.0,
                        "saldo": 400.0,
                        "data_vencimento": (today.fromordinal(today.toordinal() - 2)).isoformat(),
                        "situacao": "atrasadas",
                        "nome": "Cliente Inadimplente",
                        "numero_documento": "10",
                    },
                    {
                        "id": 11,
                        "valor": 600.0,
                        "saldo": 600.0,
                        "data_vencimento": (today.fromordinal(today.toordinal() + 10)).isoformat(),
                        "situacao": "aberto",
                        "nome": "Cliente em dia",
                        "numero_documento": "11",
                    },
                ],
                "forma_pagamento_despesas": {"Clara": 700.0, "Outros / Pix / Boleto": 800.0},
            },
            "revesta": {
                "despesas_por_mes": {cur: {"480897321": 200.0}},
                "receitas_por_mes": {cur: {"484450322": 500.0}},
                "contas_pagar_abertas": [],
                "contas_receber_abertas": [],
                "forma_pagamento_despesas": {},
            },
        },
        "categories": [
            {"id": "480897321", "nome": "Compras", "grupo": "3.Custos"},
            {"id": "484437383", "nome": "Aluguel", "grupo": "4.Despesas Operacionais"},
            {"id": "484450322", "nome": "Vendas Loja", "grupo": "1.Receitas"},
        ],
    }


def test_summary_aggregates_across_all_companies():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", today=today)

    assert resp["summary"]["despesa_total"] == 1000.0 + 500.0 + 200.0
    assert resp["summary"]["receita_total"] == 3000.0 + 500.0
    assert resp["summary"]["resultado_liquido"] == resp["summary"]["receita_total"] - resp["summary"]["despesa_total"]


def test_single_company_filter_excludes_others():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="revesta", today=today)

    assert resp["summary"]["despesa_total"] == 200.0
    assert resp["summary"]["receita_total"] == 500.0
    assert resp["por_empresa"] is None


def test_despesas_por_categoria_ranking_and_variacao():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="fabrilux", today=today)

    ranking = resp["despesas_por_categoria"]
    assert ranking[0]["categoria_nome"] == "Compras"
    assert ranking[0]["valor"] == 1000.0
    assert ranking[0]["variacao_pct"] == 25.0  # (1000-800)/800
    assert ranking[1]["categoria_nome"] == "Aluguel"
    assert ranking[1]["variacao_pct"] == 0.0


def test_sem_categoria_nao_se_mistura_com_categoria_outros():
    """Lançamentos sem categoria no Tiny aparecem como "Sem categoria", nunca como "Outros"."""
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    cur = today.strftime("%Y-%m")
    cache["companies"]["fabrilux"]["despesas_por_mes"][cur]["sem_categoria"] = 300.0
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="fabrilux", today=today)

    nomes = {r["categoria_id"]: r["categoria_nome"] for r in resp["despesas_por_categoria"]}
    assert nomes["sem_categoria"] == "Sem categoria"
    assert "Outros" not in nomes.values()


def test_faturamento_bruto_excludes_receitas_financeiras():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    # Adiciona uma receita financeira (grupo "5.Receitas Financeiras") pra garantir
    # que ela entra em receita_total mas NÃO em faturamento_bruto (só vendas).
    cache["companies"]["fabrilux"]["receitas_por_mes"]["2026-09"]["484438533"] = 100.0
    cache["categories"].append({"id": "484438533", "nome": "Receita de Aplicações", "grupo": "5.Receitas Financeiras"})

    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="fabrilux", today=today)

    assert resp["summary"]["receita_total"] == 3100.0
    assert resp["summary"]["faturamento_bruto"] == 3000.0


def test_previous_period_matches_selected_range_length():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    # Um intervalo de 10 dias (2026-09-12 a 2026-09-21) deve comparar contra os
    # 10 dias imediatamente anteriores (2026-09-02 a 2026-09-11), não contra o mês
    # anterior fixo — a comparação segue o filtro de calendário arbitrário do usuário.
    resp = build_dashboard_response(cache, date_from="2026-09-12", date_to="2026-09-21", company="fabrilux", today=today)

    assert resp["period"]["previous_from"] == "2026-09-02"
    assert resp["period"]["previous_to"] == "2026-09-11"


def test_contas_a_pagar_aging_buckets():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="fabrilux", today=today)

    cap = resp["contas_a_pagar"]
    assert cap["vencido_valor"] == 200.0
    assert cap["vencido_qtd"] == 1
    assert cap["proximos_7_dias_valor"] == 300.0
    assert cap["proximos_30_dias_valor"] == 300.0


def test_contas_a_receber_inadimplencia_rate():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="fabrilux", today=today)

    car = resp["contas_a_receber"]
    assert car["vencido_valor"] == 400.0
    # 400 vencido sobre 1000 total em aberto (400 + 600) = 40%
    assert car["taxa_inadimplencia_pct"] == 40.0


def test_forma_pagamento_percentuais():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", company="fabrilux", today=today)

    formas = {f["marcador"]: f for f in resp["forma_pagamento"]}
    assert formas["Clara"]["valor"] == 700.0
    assert formas["Clara"]["percentual"] == round(700 / 1500 * 100, 1)


def test_por_empresa_ranking_present_when_no_company_filter():
    today = date(2026, 9, 21)
    cache = _sample_cache(today)
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-21", today=today)

    assert resp["por_empresa"] is not None
    labels = [e["label"] for e in resp["por_empresa"]]
    assert "Fabrilux" in labels
    assert "Revesta" in labels


def test_empty_cache_company_returns_zeroed_summary():
    today = date(2026, 9, 21)
    resp = build_dashboard_response({"companies": {}, "categories": []}, date_from="2026-09-01", date_to="2026-09-21", today=today)

    assert resp["summary"]["despesa_total"] == 0
    assert resp["summary"]["receita_total"] == 0
    assert resp["fluxo_caixa_mensal"] == []
    assert resp["despesas_por_categoria"] == []


class _StubClientCaixaBlocked:
    """
    Reproduz o incidente real de 2026-09-21: /caixa sem permissão (TinyAPIError), mas
    /contas-pagar e /contas-receber funcionam normalmente (endpoints/permissões
    independentes). _sync_one_company deve devolver os dados desses dois mesmo assim,
    em vez de descartar a empresa inteira por causa só do /caixa.
    """

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return []  # sem cadastro dinâmico no stub: cai no fallback do catálogo fixo

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        raise TinyAPIError("Sem permissão para ler /caixa (HTTP 403 persistente, sem corpo de erro).")

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        if situacao == "pago":
            return [{"id": 1, "valor": 500.0, "dataVencimento": "2026-09-15", "marcadores": ["Clara"]}]
        return [
            {"id": 2, "valor": 300.0, "saldo": 300.0, "dataVencimento": "2026-10-01", "situacao": situacao, "cliente": {"nome": "Fornecedor X"}},
        ]

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return [
            {"id": 3, "valor": 700.0, "saldo": 700.0, "dataVencimento": "2026-10-05", "situacao": situacao, "cliente": {"nome": "Cliente Y"}},
        ]


def test_sync_one_company_survives_caixa_permission_failure():
    outcome = _sync_one_company(_StubClientCaixaBlocked(), "43820617000166", "fabrilux", "2026-09-01", "2026-09-21")

    assert outcome["result"].ok is True
    assert outcome["result"].erro is not None and "permiss" in outcome["result"].erro.lower()
    assert outcome["result"].caixa_lancamentos == 0
    assert outcome["data"]["despesas_por_dia"] == {}
    assert outcome["data"]["receitas_por_dia"] == {}
    assert outcome["fontes_com_falha"] == ["caixa"]
    # Contas a pagar/receber e forma de pagamento vieram normalmente, apesar do /caixa falhar.
    assert len(outcome["data"]["contas_pagar_abertas"]) == 1
    assert len(outcome["data"]["contas_receber_abertas"]) == 1
    assert outcome["data"]["forma_pagamento_por_dia"] == {"2026-09-15": {"Cartão Clara": 500.0}}  # "Clara" antigo soma em "Cartão Clara"


class _StubClientOneCategoriaFlaky:
    """
    Reproduz o incidente real de 2026-09-21 (rodada de rede instável): só UMA categoria
    de /caixa falha (rede esgotou as retentativas), as outras ~64 funcionam normalmente.
    _sync_one_company deve manter os dados das categorias que funcionaram, não descartar
    tudo por causa de uma categoria isolada.
    """

    FALHA_CATEGORIA_ID = "480897321"  # Compras

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return []  # sem cadastro dinâmico no stub: cai no fallback do catálogo fixo

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        if id_categoria == self.FALHA_CATEGORIA_ID:
            raise TinyAPIError(
                f"Falha de rede persistente ao chamar /caixa mesmo após 3 tentativas: timeout"
            )
        if id_categoria is None or id_categoria == "483351497":  # Salários
            return [{"tipo": "D", "data": "2026-09-10", "valor": 2000.0}]
        return []

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []


def test_sync_one_company_survives_single_category_network_failure():
    outcome = _sync_one_company(_StubClientOneCategoriaFlaky(), "43820617000166", "fabrilux", "2026-09-01", "2026-09-21")

    assert outcome["result"].ok is True
    # Erro reportado, mas como falha de rede (não permissão) e só 1 categoria.
    assert outcome["result"].erro is not None
    assert "1/" in outcome["result"].erro
    assert "rede" in outcome["result"].erro.lower()
    # A categoria "Salários" (que não falhou) foi coletada normalmente.
    assert outcome["result"].caixa_lancamentos == 1
    assert outcome["data"]["despesas_por_dia"]["2026-09-10"]["483351497"] == 2000.0


class _StubClientOwnCategoryCatalog:
    """
    Reproduz o incidente real de 2026-09-22: uma empresa cuja conta Tiny tem um
    cadastro de categorias PRÓPRIO, com IDs diferentes do catálogo fixo (TINY_CATEGORIES,
    extraído só da conta da Revesta). Antes da correção, _sync_one_company sempre
    filtrava /caixa pelos IDs fixos — que não existem nesta conta — e a API respondia
    200 com lista vazia para todos eles, zerando entrada/saída silenciosamente, sem erro.
    Com a resolução dinâmica de categorias, a "Venda Marketplace" desta conta (id
    "999000111", fora do catálogo fixo) deve ser encontrada e contabilizada.
    """

    OWN_VENDA_ID = "999000111"

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return [{"id": self.OWN_VENDA_ID, "descricao": "Venda Marketplace", "grupo": "1.Receitas"}]

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        if id_categoria is None or id_categoria == self.OWN_VENDA_ID:
            return [{"tipo": "C", "data": "2026-09-10", "valor": 42000.0}]
        return []

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []


def test_sync_one_company_uses_own_tiny_category_catalog_not_fixed_list():
    outcome = _sync_one_company(_StubClientOwnCategoryCatalog(), "43820617000166", "norvia_campinas", "2026-09-01", "2026-09-21")

    assert outcome["result"].ok is True
    assert outcome["result"].erro is None
    assert outcome["result"].caixa_lancamentos == 1
    assert outcome["data"]["receitas_por_dia"]["2026-09-10"]["999000111"] == 42000.0
    assert [c.id for c in outcome["categorias"]] == ["999000111"]


class _StubClientTransferenciaEntreEmpresas:
    """
    Reproduz o incidente real de 2026-09-22 (consolidado das 4 empresas): "Transferência
    de entrada/saída entre empresas" é caixa se movendo dentro do próprio grupo, não
    receita/despesa real. Confirmado que a Norvia Curitiba aparentava ~R$1.700 de lucro
    em agosto só por ter recebido uma transferência interna de R$200.800 — sem ela, o
    resultado real da operação era de ~R$199 mil de PREJUÍZO. despesas_por_mes/
    receitas_por_mes não devem incluir essas categorias, e a reconciliação com "sem
    categoria" não deve as engolir de volta.
    """

    VENDA_ID = "1"
    TRANSFERENCIA_ENTRADA_ID = "2"
    ALUGUEL_ID = "3"

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return [
            {"id": self.VENDA_ID, "descricao": "Vendas Online", "grupo": "1.Receitas"},
            {"id": self.TRANSFERENCIA_ENTRADA_ID, "descricao": "Transferência de entrada entre empresas", "grupo": "9. Outros"},
            {"id": self.ALUGUEL_ID, "descricao": "Aluguel", "grupo": "4.Despesas Operacionais"},
        ]

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        if id_categoria is None:
            # Total real: R$1.000 de venda + R$200.800 de transferência recebida (entrada).
            return [
                {"tipo": "C", "data": "2026-09-10", "valor": 1000.0},
                {"tipo": "C", "data": "2026-09-11", "valor": 200800.0},
            ]
        if id_categoria == self.VENDA_ID:
            return [{"tipo": "C", "data": "2026-09-10", "valor": 1000.0}]
        if id_categoria == self.TRANSFERENCIA_ENTRADA_ID:
            return [{"tipo": "C", "data": "2026-09-11", "valor": 200800.0}]
        return []

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []


def test_sync_one_company_excludes_intercompany_transfers_from_receita():
    outcome = _sync_one_company(
        _StubClientTransferenciaEntreEmpresas(), "43820617000166", "norvia_curitiba", "2026-09-01", "2026-09-21"
    )

    assert outcome["result"].ok is True
    assert outcome["result"].erro is None
    # caixa_lancamentos continua contando TODOS os lançamentos (métrica operacional).
    assert outcome["result"].caixa_lancamentos == 2
    receitas_mes = _somar_mes(outcome["data"]["receitas_por_dia"], "2026-09")
    # Só a venda real entra na receita — a transferência fica de fora inteiramente,
    # não vira "sem_categoria" nem nenhuma outra categoria.
    assert receitas_mes == {"1": 1000.0}
    assert sum(receitas_mes.values()) == 1000.0


class _StubClientTransferenciaEntreContas:
    """
    Reproduz o incidente real de 2026-09-22 (Norvia Campinas): lançamentos de /caixa
    "Transferência entre contas" (dinheiro de uma venda migrando entre as contas/gateways
    de pagamento da MESMA empresa, ex.: Mercado Livre -> Banco Inter) nunca têm categoria
    no Tiny, então caíam no bucket "sem_categoria" como se fossem receita/despesa real —
    eram praticamente 100% do "sem categoria" nesse caso real. Misturado com vendas
    genuinamente sem categoria ("Conta importada automaticamente do banco - OC nº..."),
    que devem continuar contando.
    """

    VENDA_ID = "1"

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return [{"id": self.VENDA_ID, "descricao": "Vendas Online", "grupo": "1.Receitas"}]

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        if id_categoria is None:
            return [
                {"tipo": "C", "data": "2026-09-10", "valor": 1000.0},
                {
                    "tipo": "C",
                    "data": "2026-09-11",
                    "valor": 300.0,
                    "historico": "Conta importada automaticamente do banco - OC nº ABC123",
                },
                {
                    "tipo": "C",
                    "data": "2026-09-12",
                    "valor": 5000.0,
                    "historico": "Transferência entre contas\nConta de origem: Mercado Livre - Conta de destino: Banco Inter",
                },
            ]
        if id_categoria == self.VENDA_ID:
            return [{"tipo": "C", "data": "2026-09-10", "valor": 1000.0}]
        return []

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []


def test_sync_one_company_excludes_transferencia_entre_contas_but_keeps_uncategorized_sale():
    outcome = _sync_one_company(
        _StubClientTransferenciaEntreContas(), "43820617000166", "norvia_campinas", "2026-09-01", "2026-09-21"
    )

    assert outcome["result"].ok is True
    # A transferência entre contas (5000) não conta nem pro caixa_lancamentos.
    assert outcome["result"].caixa_lancamentos == 2
    receitas_mes = _somar_mes(outcome["data"]["receitas_por_dia"], "2026-09")
    assert receitas_mes["1"] == 1000.0
    # A venda sem categoria (OC nº ABC123) continua contando, só a transferência some.
    assert receitas_mes["sem_categoria"] == 300.0
    assert sum(receitas_mes.values()) == 1300.0


class _StubClientContasPagarBlocked:
    """Espelha o stub acima, mas com /caixa e /contas-receber saudáveis e /contas-pagar
    (aberto/atrasadas/pago) falhando — confirma que a isolação funciona nos dois sentidos."""

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return []  # sem cadastro dinâmico no stub: cai no fallback do catálogo fixo

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        if id_categoria is None or id_categoria == "484450322":
            return [{"tipo": "C", "data": "2026-09-10", "valor": 1000.0}]
        return []

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        raise TinyAPIError("Sem permissão para ler /contas-pagar (HTTP 403 persistente, sem corpo de erro).")

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return [
            {"id": 3, "valor": 700.0, "saldo": 700.0, "dataVencimento": "2026-10-05", "situacao": situacao, "cliente": {"nome": "Cliente Y"}},
        ]


class _StubClientCaixaSemCategoria:
    """
    Reproduz o incidente real de 2026-09-22 (Revesta): lançamentos de /caixa SEM
    categoria vinculada no Tiny nunca aparecem em nenhuma chamada filtrada por
    idCategoria, então a iteração por categoria sozinha subestimava receita/despesa
    reais (~R$37k de receita perdida num único mês). A chamada geral (sem filtro) deve
    ser a fonte da verdade pros totais, e a diferença cai num bucket "sem_categoria".
    """

    def resolve_token_for_cnpj(self, cnpj, account_id):
        return "fake-token", account_id

    def list_categorias_receita_despesa_v3(self, token):
        return [{"id": "484450322", "descricao": "Vendas Loja", "grupo": "1.Receitas"}]

    def list_caixa_v3(self, token, id_categoria=None, data_inicial=None, data_final=None, max_pages=None):
        if id_categoria is None:
            # Total real: uma venda categorizada + uma receita SEM categoria vinculada.
            return [
                {"tipo": "C", "data": "2026-09-10", "valor": 3000.0},
                {"tipo": "C", "data": "2026-09-11", "valor": 9431.25},
            ]
        if id_categoria == "484450322":  # Vendas Loja
            return [{"tipo": "C", "data": "2026-09-10", "valor": 3000.0}]
        return []

    def list_contas_pagar_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []

    def list_contas_receber_v3(self, token, situacao=None, data_inicial_vencimento=None, data_final_vencimento=None):
        return []


def test_sync_one_company_reconciles_uncategorized_caixa_entries():
    outcome = _sync_one_company(_StubClientCaixaSemCategoria(), "43820617000166", "fabrilux", "2026-09-01", "2026-09-21")

    assert outcome["result"].ok is True
    assert outcome["result"].erro is None
    # Total real (fonte da verdade = chamada geral), não só o que bateu por categoria.
    assert outcome["result"].caixa_lancamentos == 2
    receitas_mes = _somar_mes(outcome["data"]["receitas_por_dia"], "2026-09")
    assert receitas_mes["484450322"] == 3000.0
    assert receitas_mes["sem_categoria"] == 9431.25
    assert sum(receitas_mes.values()) == 12431.25


def test_sync_one_company_survives_contas_pagar_permission_failure():
    outcome = _sync_one_company(_StubClientContasPagarBlocked(), "43820617000166", "fabrilux", "2026-09-01", "2026-09-21")

    assert outcome["result"].ok is True
    assert outcome["result"].erro is not None
    assert outcome["result"].erro.count("indisponíveis") == 2  # aging de contas a pagar + forma de pagamento
    # /caixa e /contas-receber vieram normalmente.
    assert outcome["result"].caixa_lancamentos == 1
    assert len(outcome["data"]["contas_receber_abertas"]) == 1
    assert outcome["data"]["contas_pagar_abertas"] == []
    assert outcome["data"]["forma_pagamento_por_dia"] == {}
    assert set(outcome["fontes_com_falha"]) == {"contas_pagar", "forma_pagamento"}


def _daily_cache(today: date) -> dict:
    """Cache no formato atual (agregado por dia), com lançamentos espalhados pelo mês."""
    return {
        "generated_at": "2026-09-21T06:10:00",
        "sync_started_at": "2026-09-21T06:00:00",
        "companies": {
            "fabrilux": {
                "despesas_por_dia": {
                    "2026-09-02": {"480897321": 100.0},
                    "2026-09-15": {"480897321": 400.0},
                    "2026-08-25": {"480897321": 50.0},
                },
                "receitas_por_dia": {
                    "2026-09-03": {"484450322": 1000.0},
                    "2026-09-18": {"484450322": 2000.0},
                },
                "contas_pagar_abertas": [],
                "contas_receber_abertas": [],
                "forma_pagamento_por_dia": {
                    "2026-09-05": {"Clara": 300.0},
                    "2026-09-20": {"Caixa Elo": 700.0},
                },
                "synced_at": {
                    "caixa": "2026-09-21T06:05:00",
                    "contas_pagar": "2026-09-21T06:05:00",
                    "contas_receber": "2026-09-21T06:05:00",
                    "forma_pagamento": "2026-09-21T06:05:00",
                },
            },
        },
        "categories": [
            {"id": "480897321", "nome": "Compras", "grupo": "3.Custos"},
            {"id": "484450322", "nome": "Vendas Loja", "grupo": "1.Receitas"},
        ],
    }


def test_filtro_por_dia_soma_so_os_dias_do_intervalo():
    """Com cache diário, "01/09 a 10/09" não pode somar o mês inteiro (bug antigo)."""
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_daily_cache(today), date_from="2026-09-01", date_to="2026-09-10", today=today)

    assert resp["summary"]["despesa_total"] == 100.0
    assert resp["summary"]["receita_total"] == 1000.0
    # Período anterior de mesma duração (22/08 a 31/08).
    assert resp["summary"]["despesa_total_anterior"] == 50.0


def test_filtro_de_um_unico_dia():
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_daily_cache(today), date_from="2026-09-15", date_to="2026-09-15", today=today)

    assert resp["summary"]["despesa_total"] == 400.0
    assert resp["summary"]["receita_total"] == 0.0


def test_forma_pagamento_respeita_o_periodo():
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_daily_cache(today), date_from="2026-09-01", date_to="2026-09-10", today=today)

    assert resp["forma_pagamento"] == [{"marcador": "Clara", "valor": 300.0, "percentual": 100.0}]


def test_fluxo_diario_cobre_cada_dia_do_periodo_e_mensal_agrega_dias():
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_daily_cache(today), date_from="2026-09-01", date_to="2026-09-10", today=today)

    diario = resp["fluxo_caixa_diario"]
    assert len(diario) == 10
    assert diario[1] == {"dia": "2026-09-02", "label": "02/09", "receita": 0.0, "despesa": 100.0, "saldo": -100.0}
    mensal = {m["mes"]: m for m in resp["fluxo_caixa_mensal"]}
    assert mensal["2026-09"]["despesa"] == 500.0
    assert mensal["2026-08"]["despesa"] == 50.0


def test_fluxo_diario_ausente_em_cache_legado_por_mes():
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_sample_cache(today), date_from="2026-09-01", date_to="2026-09-21", today=today)

    assert resp["fluxo_caixa_diario"] is None
    assert resp["dados_desatualizados"] == []


def test_aging_faixas_e_projecao_de_compromissos():
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_sample_cache(today), date_from="2026-09-01", date_to="2026-09-21", today=today)

    faixas_pagar = {f["faixa"]: f for f in resp["contas_a_pagar"]["faixas"]}
    assert faixas_pagar["vencido_1_30"]["valor"] == 200.0
    assert faixas_pagar["a_vencer_0_30"]["valor"] == 300.0
    assert sum(f["qtd"] for f in faixas_pagar.values()) == 2

    horizontes = {h["dias"]: h for h in resp["projecao_caixa"]["horizontes"]}
    # Vencidos ficam de fora da projeção: só o receber de +10d (600) e o pagar de +3d (300).
    assert horizontes[30] == {"dias": 30, "a_receber": 600.0, "a_pagar": 300.0, "saldo": 300.0}
    assert resp["projecao_caixa"]["semanal"][-1]["saldo_acumulado"] == 300.0


def test_por_empresa_traz_margem_e_vencidos():
    today = date(2026, 9, 21)
    resp = build_dashboard_response(_sample_cache(today), date_from="2026-09-01", date_to="2026-09-21", today=today)

    fabrilux = next(e for e in resp["por_empresa"] if e["account_id"] == "fabrilux")
    assert fabrilux["margem_liquida_pct"] == 50.0  # (3000-1500)/3000
    assert fabrilux["a_pagar_vencido"] == 200.0
    assert fabrilux["a_receber_vencido"] == 400.0


def test_merge_mantem_ultimo_dado_bom_da_fonte_que_falhou():
    previous = {
        "despesas_por_dia": {"2026-09-01": {"1": 999.0}},
        "receitas_por_dia": {"2026-09-01": {"2": 50.0}},
        "contas_pagar_abertas": [{"id": 1}],
        "synced_at": {"caixa": "2026-09-20T06:00:00", "contas_pagar": "2026-09-20T06:00:00"},
    }
    new = {
        "despesas_por_dia": {},
        "receitas_por_dia": {},
        "contas_pagar_abertas": [{"id": 2}],
        "contas_receber_abertas": [],
        "forma_pagamento_por_dia": {},
    }
    merged = _merge_with_previous(new, previous, ["caixa"], "2026-09-21T06:00:00")

    assert merged["despesas_por_dia"] == {"2026-09-01": {"1": 999.0}}
    assert merged["contas_pagar_abertas"] == [{"id": 2}]
    assert merged["synced_at"]["caixa"] == "2026-09-20T06:00:00"
    assert merged["synced_at"]["contas_pagar"] == "2026-09-21T06:00:00"


def test_dados_desatualizados_aponta_fonte_com_dado_velho():
    today = date(2026, 9, 21)
    cache = _daily_cache(today)
    cache["companies"]["fabrilux"]["synced_at"]["caixa"] = "2026-09-19T06:05:00"
    resp = build_dashboard_response(cache, date_from="2026-09-01", date_to="2026-09-10", today=today)

    assert resp["dados_desatualizados"] == [
        {"account_id": "fabrilux", "label": "Fabrilux", "fonte": "caixa", "synced_at": "2026-09-19T06:05:00"}
    ]
