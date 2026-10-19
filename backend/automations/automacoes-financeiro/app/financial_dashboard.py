"""
Dashboard Financeiro: agrega dados reais do Tiny ERP v3 (fluxo de caixa por categoria,
contas a pagar/receber em aberto, forma de pagamento) para as 4 empresas monitoradas
(Fabrilux, Revesta, Norvia Campinas, Norvia Curitiba).

Diferente da automação de NF-e (que lança contas em tempo real), este módulo é
só-leitura: nunca cria, altera ou baixa nenhuma conta no Tiny. Ele só lê.

Como a API v3 do Tiny não devolve a categoria no item de `/caixa` (só permite
filtrar por `idCategoria`, confirmado no swagger oficial), a sincronização itera a
lista fechada de categorias (`TINY_CATEGORIES`) uma a uma por empresa — por isso ela
roda em background (agendada 1x/dia + botão manual), nunca on-demand a cada
carregamento de página. O resultado agregado fica em cache num JSON local
(mesmo padrão de `sefaz_scan.py`) e é o que a API serve instantaneamente ao frontend;
a conta de KPIs (variação vs. período anterior, ranking de categorias etc.) é feita
em cima desse cache, sem nova chamada ao Tiny.
"""
import json
import logging
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import Settings, settings
from app.json_store import erro_gravacao, save_json_state
from app.tiny_categories import CATEGORY_BY_ID, TINY_CATEGORIES, TinyCategory
from app.tiny_client import TinyAPIError, TinyClient

logger = logging.getLogger("automacao_nfe.financial_dashboard")

# Identificador de empresa (account_id) -> rótulo curto de exibição nos gráficos.
# Mantido separado de COMPANY_DISPLAY_NAME_BY_CNPJ (sefaz_scan.py), que usa a razão
# social completa — grande demais para eixos de gráfico.
COMPANY_LABELS: Dict[str, str] = {
    "fabrilux": "Fabrilux",
    "revesta": "Revesta",
    "norvia_campinas": "Norvia Campinas",
    "norvia_curitiba": "Norvia Curitiba",
}

# Marcadores de forma de pagamento com whitelist fechada (ver PAYMENT_METHOD_MARCADOR em
# tiny_client.py) que de fato aparecem no campo `marcadores` de /contas-pagar. Pix e
# Boleto não usam marcador no Tiny, então contas com esses meios de pagamento (ou
# lançadas manualmente sem marcador) caem no bucket "Outros / Pix / Boleto".
KNOWN_PAYMENT_MARCADORES = ("Cartão Clara", "Caixa Visa", "Caixa Visa Norvia", "Caixa Elo")
# Nomes antigos do mesmo marcador: contas lançadas antes de 2026-10-07 com "Clara" somam em "Cartão Clara".
PAYMENT_MARCADOR_ALIASES = {"Clara": "Cartão Clara"}
OTHER_PAYMENT_BUCKET = "Outros / Pix / Boleto"

# Bucket dos lançamentos de /caixa sem categoria vinculada no Tiny (ver sync). Tem rótulo
# próprio no ranking — não pode se misturar com a categoria real "Outros" do Tiny.
SEM_CATEGORIA_ID = "sem_categoria"

_sync_lock = threading.Lock()


def _cache_path(cfg: Settings) -> Path:
    return cfg.DATA_DIR / "financial_dashboard_cache.json"


def _status_path(cfg: Settings) -> Path:
    return cfg.DATA_DIR / "financial_dashboard_status.json"


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"[FINANCIAL_DASHBOARD] Falha ao ler {path.name}: {e}")
        return default


def _save_json(path: Path, data: Any, cfg: Settings) -> None:
    # Atômico e com erro exposto no status (ver app/json_store.py).
    save_json_state(path, data, "FINANCIAL_DASHBOARD")


def is_sync_running() -> bool:
    """Retorna True se houver uma sincronização do Dashboard Financeiro ativa neste processo."""
    return _sync_lock.locked()


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    return date(year, month, 1)


def _day_key(value: Optional[str]) -> Optional[str]:
    """
    Extrai 'YYYY-MM-DD' do início de uma data ISO ('2026-09-21' ou '2026-09-21T00:00:00').
    O cache é agregado por DIA (não por mês) para que o filtro de calendário da interface
    funcione com qualquer intervalo — agregando por mês, "01/09 a 10/09" somava setembro
    inteiro.
    """
    if not value or len(value) < 10:
        return None
    return value[:10]


def _e_transferencia_entre_empresas(nome: str) -> bool:
    """
    Identifica categorias de transferência de caixa entre as 4 empresas do grupo
    (ex.: "Transferência de entrada entre empresas", "Transferência de saída entre
    empresas") — não são receita/despesa real, só caixa se movendo dentro do grupo, e
    devem ficar fora de receita_total/despesa_total/resultado_liquido (ver comentário em
    `_sync_one_company`).
    """
    nome_lower = (nome or "").lower()
    return "transfer" in nome_lower and "entre empresas" in nome_lower


def _e_transferencia_entre_contas(historico: str) -> bool:
    """
    Identifica lançamentos de /caixa que são transferência entre as CONTAS/gateways de
    pagamento da MESMA empresa (ex.: "Transferência entre contas\nConta de origem:
    Mercado Livre - Conta de destino: Banco Inter") — dinheiro de uma venda "andando"
    entre as contas até o banco principal, não é receita/despesa real. Diferente de
    `_e_transferencia_entre_empresas` (entre empresas do grupo, identificável por
    categoria): esses lançamentos nunca têm categoria no Tiny, só dá pra identificar pelo
    texto do histórico. Confirmado em 2026-09-22 (Norvia Campinas): eram praticamente
    100% do bucket "sem categoria" do lado despesa (R$114,8k em um único mês) e boa parte
    do lado receita — mas cuidado, a maioria do restante do "sem categoria" (entradas
    "Conta importada automaticamente do banco - OC nº ...", cada uma com um número de
    pedido distinto) são vendas reais sem categoria, e devem CONTINUAR sendo contadas.
    """
    return "transfer" in (historico or "").lower() and "entre contas" in (historico or "").lower()


@dataclass
class CompanySyncResult:
    account_id: str
    cnpj: str
    ok: bool
    erro: Optional[str] = None
    caixa_lancamentos: int = 0
    contas_pagar_abertas: int = 0
    contas_receber_abertas: int = 0


@dataclass
class FinancialDashboardSyncSummary:
    started_at: str
    finished_at: str
    lookback_months: int
    resultados: List[CompanySyncResult] = field(default_factory=list)


def _sync_one_company(
    client: TinyClient,
    cnpj: str,
    account_id: str,
    data_inicial: str,
    data_final: str,
) -> Dict[str, Any]:
    """Busca e agrega os dados do Tiny ERP v3 para UMA empresa. Só leitura."""
    # Reseta o circuito de proteção contra bloqueio (ver _fetch_paginated_v3_itens) no
    # início de cada empresa: um bloqueio específico de uma empresa/token não deve
    # queimar imediatamente a tentativa das outras 3 antes mesmo da primeira chamada.
    client._consecutive_block_failures = {}
    token, resolved_account = client.resolve_token_for_cnpj(cnpj=cnpj, account_id=account_id)
    if not token:
        return {
            "result": CompanySyncResult(
                account_id=account_id, cnpj=cnpj, ok=False, erro="Token do Tiny ERP não configurado para esta empresa."
            ),
            "data": None,
        }

    # Cada empresa é uma conta Tiny separada, com seu PRÓPRIO cadastro de categorias —
    # os IDs numéricos não são compartilhados entre contas (confirmado 2026-09-22: os IDs
    # de "Vendas Loja"/"Vendas Online" da Fabrilux, Norvia Campinas e Norvia Curitiba são
    # todos diferentes dos da Revesta, de onde TINY_CATEGORIES foi extraído). Usar a lista
    # fixa para as outras contas faz o /caixa não bater em NENHUMA categoria dessas empresas
    # (a API responde 200 com lista vazia para um idCategoria que não existe na conta — não
    # gera erro, os valores só ficam silenciosamente zerados). Por isso a lista de categorias
    # usada no loop abaixo é resolvida dinamicamente por empresa; TINY_CATEGORIES só entra
    # como fallback se a consulta dinâmica falhar (ex.: Tiny fora do ar).
    account_categories = client.list_categorias_receita_despesa_v3(token)
    if account_categories:
        categorias = [
            TinyCategory(id=str(c["id"]), nome=c.get("descricao", ""), grupo=c.get("grupo") or "4.Despesas Operacionais")
            for c in account_categories
            if c.get("id") and c.get("descricao")
        ]
    else:
        logger.warning(
            f"[FINANCIAL_DASHBOARD] '{account_id}': não foi possível obter o cadastro de categorias "
            f"desta conta no Tiny — usando catálogo fixo (extraído da Revesta) como fallback, pode "
            f"não bater com os IDs reais desta empresa."
        )
        categorias = TINY_CATEGORIES

    despesas_por_dia: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    receitas_por_dia: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    # Transferências entre as próprias 4 empresas (ex.: Campinas bancando outras filiais)
    # não são receita/despesa real — é caixa se movendo dentro do grupo. Rastreadas à
    # parte (não entram em despesas_por_dia/receitas_por_dia, logo ficam fora de
    # receita_total/despesa_total/resultado_liquido) porque, incluídas, distorcem o
    # resultado de cada empresa: confirmado em 2026-09-22 que Norvia Curitiba aparentava
    # ~R$1.700 de lucro em agosto só por ter recebido R$200.800 de transferência interna —
    # sem ela, o resultado real da operação da Curitiba era de ~R$199 mil de PREJUÍZO.
    despesas_transferencia_por_dia: Dict[str, float] = defaultdict(float)
    receitas_transferencia_por_dia: Dict[str, float] = defaultdict(float)
    caixa_lancamentos = 0
    contas_pagar_abertas: List[Dict[str, Any]] = []
    contas_receber_abertas: List[Dict[str, Any]] = []
    # Forma de pagamento agregada por dia de vencimento, para respeitar o período filtrado
    # (antes era um total único da janela inteira de 13 meses, independente do filtro).
    marcador_por_dia: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    erros: List[str] = []
    # Fontes que falharam nesta sincronização: `sync_financial_dashboard` reaproveita o
    # último dado bom do cache anterior para elas, em vez de gravar zeros por cima
    # (ver `_merge_with_previous`).
    fontes_com_falha: List[str] = []

    # Cada fonte de dados abaixo (caixa, contas a pagar/receber, forma de pagamento) é
    # isolada no seu próprio try/except: um problema específico de UM endpoint (bloqueio
    # ou falta de escopo OAuth de leitura, ex.: incidente real 2026-09-21 com /caixa — ver
    # [[project_tiny_dashboard_sync_incident]]) não deve descartar os dados das outras
    # fontes, que usam endpoints e permissões independentes.

    # Fonte da verdade pros TOTAIS de receita/despesa: uma chamada sem filtro de
    # categoria. Confirmado em 2026-09-22 (investigação da Revesta) que lançamentos de
    # /caixa SEM categoria vinculada no Tiny nunca aparecem em NENHUMA chamada filtrada
    # por idCategoria — a iteração por categoria abaixo, usada isoladamente, subestimava
    # receita/despesa reais (~R$37k de receita perdida num único mês na Revesta) porque
    # esses lançamentos ficavam invisíveis. A chamada geral captura todo mundo.
    despesas_geral_por_dia: Dict[str, float] = defaultdict(float)
    receitas_geral_por_dia: Dict[str, float] = defaultdict(float)
    try:
        # max_pages maior que o padrão da função: esta chamada soma TODAS as categorias
        # de até 13 meses (lookback), bem mais volume que uma categoria isolada — confirmado
        # em 2026-09-22 que Revesta/Curitiba estouravam o teto padrão (1.000 itens) e
        # travavam caixa_lancamentos exatamente em 1000.
        itens_geral = client.list_caixa_v3(token, data_inicial=data_inicial, data_final=data_final, max_pages=500)
        for item in itens_geral:
            tipo = item.get("tipo")
            dia = _day_key(item.get("data"))
            if not dia or tipo not in ("D", "C"):
                continue
            if _e_transferencia_entre_contas(item.get("historico")):
                continue
            valor = float(item.get("valor") or 0)
            caixa_lancamentos += 1
            if tipo == "D":
                despesas_geral_por_dia[dia] += valor
            else:
                receitas_geral_por_dia[dia] += valor
    except TinyAPIError as e:
        erros.append(f"/caixa (total geral) indisponível: {e}")
        fontes_com_falha.append("caixa")
        logger.error(f"[FINANCIAL_DASHBOARD] '{account_id}': /caixa (sem filtro) falhou. Detalhe: {e}")

    # Detalhamento por categoria (usado só no ranking "despesas/receitas por categoria")
    # — cada categoria tem seu próprio try/except: rede instável pode esgotar as
    # retentativas numa categoria isolada sem que isso seja um problema sistêmico
    # (permissão/bloqueio), nesse caso só aquela categoria fica de fora do ranking, sem
    # afetar os totais (que já vêm da chamada geral acima).
    categorias_com_falha: List[str] = []
    falha_e_permissao = False
    for categoria in categorias:
        if falha_e_permissao:
            # O circuito de proteção já confirmou bloqueio persistente (não é blip de rede
            # isolado) nesta MESMA sincronização — continuar batendo em /caixa categoria por
            # categoria só desperdiça chamadas contra uma conta já bloqueada, e pode agravar
            # o bloqueio. Marca o restante como falho sem tentar de novo.
            categorias_com_falha.append(categoria.nome)
            continue
        try:
            itens = client.list_caixa_v3(
                token,
                id_categoria=categoria.id,
                data_inicial=data_inicial,
                data_final=data_final,
            )
        except TinyAPIError as e:
            categorias_com_falha.append(categoria.nome)
            if "permiss" in str(e).lower():
                falha_e_permissao = True
            logger.warning(f"[FINANCIAL_DASHBOARD] '{account_id}': /caixa (categoria '{categoria.nome}') falhou. Detalhe: {e}")
            continue
        e_transferencia = _e_transferencia_entre_empresas(categoria.nome)
        for item in itens:
            tipo = item.get("tipo")
            dia = _day_key(item.get("data"))
            if not dia or tipo not in ("D", "C"):
                continue
            valor = float(item.get("valor") or 0)
            if e_transferencia:
                if tipo == "D":
                    despesas_transferencia_por_dia[dia] += valor
                else:
                    receitas_transferencia_por_dia[dia] += valor
                continue
            if tipo == "D":
                despesas_por_dia[dia][categoria.id] += valor
            else:
                receitas_por_dia[dia][categoria.id] += valor
    if categorias_com_falha:
        motivo = "falta de permissão/escopo OAuth" if falha_e_permissao else "rede instável ou limite de taxa"
        erros.append(
            f"{len(categorias_com_falha)}/{len(categorias)} categoria(s) de caixa indisponível(is) "
            f"({motivo}): {', '.join(categorias_com_falha[:5])}{'...' if len(categorias_com_falha) > 5 else ''}"
        )
        logger.error(
            f"[FINANCIAL_DASHBOARD] '{account_id}': {len(categorias_com_falha)}/{len(categorias)} "
            f"categorias de /caixa falharam ({motivo})."
        )

    # Reconcilia o detalhamento por categoria com o total real: a diferença (lançamentos
    # sem categoria no Tiny, ou categorias que falharam acima) cai no bucket SEM_CATEGORIA_ID
    # (exibido como "Sem categoria" por _categoria_label),
    # garantindo que a soma do ranking sempre bata com o total exibido nos KPIs — descontada
    # a parcela de transferência entre empresas (que fica de fora de propósito, não é
    # "sem categoria", ver `_e_transferencia_entre_empresas`).
    for dia, total_geral in despesas_geral_por_dia.items():
        total_geral_sem_transferencia = total_geral - despesas_transferencia_por_dia.get(dia, 0.0)
        total_categorizado = sum(despesas_por_dia.get(dia, {}).values())
        residual = total_geral_sem_transferencia - total_categorizado
        if residual > 0.01:
            despesas_por_dia[dia][SEM_CATEGORIA_ID] += residual
    for dia, total_geral in receitas_geral_por_dia.items():
        total_geral_sem_transferencia = total_geral - receitas_transferencia_por_dia.get(dia, 0.0)
        total_categorizado = sum(receitas_por_dia.get(dia, {}).values())
        residual = total_geral_sem_transferencia - total_categorizado
        if residual > 0.01:
            receitas_por_dia[dia][SEM_CATEGORIA_ID] += residual

    # Compromissos em aberto (visão de "contas a pagar/receber futuras") — situações
    # "aberto" e "atrasadas" são consultadas separadamente e mescladas por id, pois a API
    # não aceita múltiplos valores de `situacao` numa única chamada.
    try:
        contas_pagar_por_id: Dict[int, Dict[str, Any]] = {}
        for situacao in ("aberto", "atrasadas"):
            for item in client.list_contas_pagar_v3(token, situacao=situacao):
                contas_pagar_por_id[int(item["id"])] = item
        contas_pagar_abertas = list(contas_pagar_por_id.values())
    except TinyAPIError as e:
        erros.append(f"Contas a pagar em aberto indisponíveis: {e}")
        fontes_com_falha.append("contas_pagar")
        logger.error(f"[FINANCIAL_DASHBOARD] '{account_id}': /contas-pagar (aberto/atrasadas) falhou. Detalhe: {e}")

    try:
        contas_receber_por_id: Dict[int, Dict[str, Any]] = {}
        for situacao in ("aberto", "atrasadas"):
            for item in client.list_contas_receber_v3(token, situacao=situacao):
                contas_receber_por_id[int(item["id"])] = item
        contas_receber_abertas = list(contas_receber_por_id.values())
    except TinyAPIError as e:
        erros.append(f"Contas a receber em aberto indisponíveis: {e}")
        fontes_com_falha.append("contas_receber")
        logger.error(f"[FINANCIAL_DASHBOARD] '{account_id}': /contas-receber (aberto/atrasadas) falhou. Detalhe: {e}")

    # Distribuição por forma de pagamento (marcador), sobre despesas PAGAS no período
    # analisado (vencimento dentro da janela) — usa o mesmo whitelist fechado de
    # marcadores já usado no lançamento (PAYMENT_METHOD_MARCADOR).
    try:
        contas_pagas = client.list_contas_pagar_v3(
            token,
            situacao="pago",
            data_inicial_vencimento=data_inicial,
            data_final_vencimento=data_final,
        )
        for conta in contas_pagas:
            valor = float(conta.get("valor") or 0)
            # Sem vencimento (não deveria acontecer no Tiny) cai no fim da janela, para o
            # valor não sumir do total.
            dia = _day_key(conta.get("dataVencimento")) or data_final
            marcadores = conta.get("marcadores") or []
            marcadores_nomes = [
                (m.get("descricao") or m.get("nome") or m) if isinstance(m, dict) else m for m in marcadores
            ]
            normalizados = [PAYMENT_MARCADOR_ALIASES.get(m, m) for m in marcadores_nomes if isinstance(m, str)]
            matched = [m for m in dict.fromkeys(normalizados) if m in KNOWN_PAYMENT_MARCADORES]
            if matched:
                for m in matched:
                    marcador_por_dia[dia][m] += valor
            else:
                marcador_por_dia[dia][OTHER_PAYMENT_BUCKET] += valor
    except TinyAPIError as e:
        erros.append(f"Despesas por forma de pagamento indisponíveis: {e}")
        fontes_com_falha.append("forma_pagamento")
        logger.error(f"[FINANCIAL_DASHBOARD] '{account_id}': /contas-pagar (pago) falhou. Detalhe: {e}")

    def _slim_conta(item: Dict[str, Any]) -> Dict[str, Any]:
        cliente = item.get("cliente") or {}
        return {
            "id": item.get("id"),
            "valor": float(item.get("valor") or 0),
            "saldo": float(item.get("saldo") if item.get("saldo") is not None else item.get("valor") or 0),
            "data_vencimento": item.get("dataVencimento"),
            "situacao": item.get("situacao"),
            "nome": cliente.get("nome") if isinstance(cliente, dict) else None,
            "numero_documento": item.get("numeroDocumento"),
        }

    data = {
        "despesas_por_dia": {dia: dict(cats) for dia, cats in despesas_por_dia.items()},
        "receitas_por_dia": {dia: dict(cats) for dia, cats in receitas_por_dia.items()},
        "contas_pagar_abertas": [_slim_conta(c) for c in contas_pagar_abertas],
        "contas_receber_abertas": [_slim_conta(c) for c in contas_receber_abertas],
        "forma_pagamento_por_dia": {dia: dict(m) for dia, m in marcador_por_dia.items()},
    }

    result = CompanySyncResult(
        account_id=resolved_account or account_id,
        cnpj=cnpj,
        ok=True,
        erro=" | ".join(erros) if erros else None,
        caixa_lancamentos=caixa_lancamentos,
        contas_pagar_abertas=len(contas_pagar_abertas),
        contas_receber_abertas=len(contas_receber_abertas),
    )
    return {"result": result, "data": data, "categorias": categorias, "fontes_com_falha": fontes_com_falha}


# Campos do cache de cada empresa agrupados pela fonte do Tiny que os produz — quando
# uma fonte falha, todos os campos dela são reaproveitados juntos do cache anterior.
# Inclui os nomes legados (por mês / total único) para caches gravados antes da
# agregação por dia.
_SOURCE_FIELDS: Dict[str, tuple] = {
    "caixa": ("despesas_por_dia", "receitas_por_dia", "despesas_por_mes", "receitas_por_mes"),
    "contas_pagar": ("contas_pagar_abertas",),
    "contas_receber": ("contas_receber_abertas",),
    "forma_pagamento": ("forma_pagamento_por_dia", "forma_pagamento_despesas"),
}


def _merge_with_previous(
    new_data: Optional[Dict[str, Any]],
    previous: Optional[Dict[str, Any]],
    failed_sources: List[str],
    now_iso: str,
) -> Optional[Dict[str, Any]]:
    """
    Combina o resultado da sincronização de UMA empresa com o que já estava no cache.

    Sem isso, uma falha pontual (ex.: Tiny bloqueando /caixa de uma empresa) gravava
    zeros por cima do histórico bom, e o dashboard mostrava a empresa "sem movimento"
    como se fosse dado real. Agora cada fonte que falhou mantém o último dado bom, e
    `synced_at` (por fonte) registra de quando ele é — o frontend avisa quando está velho.
    """
    previous = previous or {}
    prev_synced = previous.get("synced_at") or {}
    if new_data is None:
        # Empresa inteira falhou (token ausente, exceção): mantém tudo do cache anterior.
        return previous or None

    merged = dict(new_data)
    synced_at: Dict[str, Optional[str]] = {}
    for source, fields in _SOURCE_FIELDS.items():
        if source in failed_sources:
            for f in fields:
                merged.pop(f, None)
                if f in previous:
                    merged[f] = previous[f]
            synced_at[source] = prev_synced.get(source) or previous.get("_legacy_synced_at")
        else:
            synced_at[source] = now_iso
    merged["synced_at"] = synced_at
    return merged


def sync_financial_dashboard(cfg: Optional[Settings] = None, client: Optional[TinyClient] = None) -> FinancialDashboardSyncSummary:
    """
    Sincroniza o Dashboard Financeiro para todas as empresas monitoradas. Bloqueante —
    deve ser chamada em background (thread/task), nunca direto numa requisição HTTP.
    """
    cfg = cfg or settings
    cfg.ensure_directories()

    if not _sync_lock.acquire(blocking=False):
        logger.info("[FINANCIAL_DASHBOARD] Sincronização já em andamento, ignorando novo disparo.")
        return FinancialDashboardSyncSummary(
            started_at=datetime.now().isoformat(),
            finished_at=datetime.now().isoformat(),
            lookback_months=cfg.FINANCIAL_DASHBOARD_LOOKBACK_MONTHS,
        )

    started_at = datetime.now().isoformat()
    client = client or TinyClient()

    try:
        today = date.today()
        lookback = max(1, cfg.FINANCIAL_DASHBOARD_LOOKBACK_MONTHS)
        data_inicial = _add_months(_month_start(today), -(lookback - 1)).isoformat()
        data_final = today.isoformat()

        previous_cache = _load_json(_cache_path(cfg), None) or {}
        previous_companies: Dict[str, Dict[str, Any]] = {}
        for acc, prev in (previous_cache.get("companies") or {}).items():
            # Caches antigos não têm `synced_at` por fonte — a data da geração serve de proxy.
            previous_companies[acc] = {**prev, "_legacy_synced_at": previous_cache.get("generated_at")}

        companies: Dict[str, Dict[str, Any]] = {}
        resultados: List[CompanySyncResult] = []
        # Cada empresa é uma conta Tiny separada com seu próprio cadastro de categorias
        # (IDs não compartilhados entre contas — ver comentário em `_sync_one_company`),
        # então o cache guarda a UNIÃO das categorias realmente usadas por todas as
        # empresas, não mais só o catálogo fixo de uma única conta.
        categories_by_id: Dict[str, Dict[str, str]] = {}

        for cnpj, account_id in cfg.get_cnpj_company_map().items():
            try:
                outcome = _sync_one_company(client, cnpj, account_id, data_inicial, data_final)
            except Exception as e:
                logger.error(f"[FINANCIAL_DASHBOARD] Erro ao sincronizar '{account_id}': {e}", exc_info=True)
                outcome = {
                    "result": CompanySyncResult(account_id=account_id, cnpj=cnpj, ok=False, erro=str(e)),
                    "data": None,
                    "categorias": [],
                }
            resultados.append(outcome["result"])
            merged = _merge_with_previous(
                outcome["data"],
                previous_companies.get(account_id),
                outcome.get("fontes_com_falha", []),
                datetime.now().isoformat(),
            )
            if merged is not None:
                if "synced_at" not in merged:
                    legacy = merged.get("_legacy_synced_at")
                    merged["synced_at"] = {source: legacy for source in _SOURCE_FIELDS}
                merged.pop("_legacy_synced_at", None)
                companies[account_id] = merged
            for c in outcome.get("categorias") or []:
                categories_by_id[c.id] = {"id": c.id, "nome": c.nome, "grupo": c.grupo}

        finished_at = datetime.now().isoformat()

        cache = {
            "generated_at": finished_at,
            "sync_started_at": started_at,
            "lookback_months": lookback,
            "data_inicial": data_inicial,
            "data_final": data_final,
            "companies": companies,
            "categories": list(categories_by_id.values()) or [
                {"id": c.id, "nome": c.nome, "grupo": c.grupo} for c in TINY_CATEGORIES
            ],
        }
        _save_json(_cache_path(cfg), cache, cfg)

        summary = FinancialDashboardSyncSummary(
            started_at=started_at,
            finished_at=finished_at,
            lookback_months=lookback,
            resultados=resultados,
        )
        _save_json(
            _status_path(cfg),
            {
                "last_sync_started_at": summary.started_at,
                "last_sync_finished_at": summary.finished_at,
                "companies": [
                    {
                        "account_id": r.account_id,
                        "cnpj": r.cnpj,
                        "ok": r.ok,
                        "erro": r.erro,
                        "caixa_lancamentos": r.caixa_lancamentos,
                        "contas_pagar_abertas": r.contas_pagar_abertas,
                        "contas_receber_abertas": r.contas_receber_abertas,
                    }
                    for r in resultados
                ],
            },
            cfg,
        )
        return summary
    finally:
        _sync_lock.release()


def next_sync_at(cfg: Optional[Settings] = None) -> str:
    cfg = cfg or settings
    now = datetime.now()
    next_run = now.replace(hour=cfg.FINANCIAL_DASHBOARD_SYNC_HOUR, minute=0, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    return next_run.isoformat()


def sync_cooldown_remaining_seconds(cfg: Optional[Settings] = None) -> int:
    cfg = cfg or settings
    status = _load_json(_status_path(cfg), {})
    finished_at = status.get("last_sync_finished_at")
    if not finished_at:
        return 0
    try:
        elapsed = (datetime.now() - datetime.fromisoformat(finished_at)).total_seconds()
    except ValueError:
        return 0
    remaining = cfg.FINANCIAL_DASHBOARD_SYNC_COOLDOWN_SECONDS - elapsed
    return max(0, int(remaining))


def get_sync_status(cfg: Optional[Settings] = None) -> Dict[str, Any]:
    cfg = cfg or settings
    status = _load_json(_status_path(cfg), {})
    return {
        "last_sync_started_at": status.get("last_sync_started_at"),
        "last_sync_finished_at": status.get("last_sync_finished_at"),
        "next_sync_at": next_sync_at(cfg),
        "companies": status.get("companies", []),
        "is_running": is_sync_running(),
        "cooldown_seconds_remaining": sync_cooldown_remaining_seconds(cfg),
        # Não nulo = a sincronização rodou mas não conseguiu gravar cache/status (dados na tela velhos).
        "erro_gravacao": erro_gravacao(_status_path(cfg), _cache_path(cfg)),
    }


# ---------------------------------------------------------------------------
# Cálculo de KPIs a partir do cache (nenhuma chamada ao Tiny acontece aqui) --
# ---------------------------------------------------------------------------

_MONTH_NAMES_PT = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
]

# Grupo oficial (tiny_categories.py) das categorias de venda — usado para separar
# "faturamento bruto" (só vendas) de "receita total" (vendas + receitas financeiras
# como juros/aplicações), métrica que o financeiro acompanha separadamente.
FATURAMENTO_BRUTO_GRUPO = "1.Receitas"


def _period_bounds(date_from: str, date_to: str) -> Dict[str, Any]:
    """
    Calcula o período anterior de COMPARAÇÃO com a mesma duração (em dias) do
    período selecionado, terminando no dia anterior ao início — funciona para
    qualquer intervalo arbitrário vindo do filtro de calendário padrão da
    interface (não só para presets fixos como "mês atual").
    """
    start = date.fromisoformat(date_from)
    end = date.fromisoformat(date_to)
    length_days = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=length_days - 1)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "previous_from": prev_start.isoformat(),
        "previous_to": prev_end.isoformat(),
    }


def _sum_categorias_no_intervalo(
    por_chave: Dict[str, Dict[str, float]],
    date_from: str,
    date_to: str,
) -> Dict[str, float]:
    """
    Soma por categoria dentro do intervalo [date_from, date_to]. As chaves são dias
    ('YYYY-MM-DD'); chaves de mês ('YYYY-MM', caches gravados antes da agregação diária)
    continuam aceitas — nesse caso o mês de borda entra inteiro, até a próxima sincronização
    regravar o cache por dia.
    """
    totals: Dict[str, float] = defaultdict(float)
    for chave, categorias in por_chave.items():
        n = len(chave)
        if date_from[:n] <= chave <= date_to[:n]:
            for cat_id, valor in categorias.items():
                totals[cat_id] += valor
    return dict(totals)


def _company_series(company_data: Dict[str, Any], kind: str) -> Dict[str, Dict[str, float]]:
    """Série de caixa ('despesas'/'receitas') da empresa — por dia, ou por mês em cache legado."""
    return company_data.get(f"{kind}_por_dia") or company_data.get(f"{kind}_por_mes") or {}


def _company_forma_pagamento(company_data: Dict[str, Any]) -> Dict[str, Dict[str, float]]:
    """
    Forma de pagamento por dia de vencimento. Cache legado só tem o total da janela inteira
    (`forma_pagamento_despesas`) — devolvido sob uma chave vazia, que casa com qualquer
    intervalo em `_sum_categorias_no_intervalo` (comportamento antigo, até a próxima sync).
    """
    if "forma_pagamento_por_dia" in company_data:
        return company_data["forma_pagamento_por_dia"]
    legacy = company_data.get("forma_pagamento_despesas") or {}
    return {"": legacy} if legacy else {}


# Máximo de dias do período selecionado para o gráfico de fluxo de caixa diário — acima
# disso a série diária fica ilegível e o frontend usa só a mensal.
FLUXO_DIARIO_MAX_DIAS = 92

# Faixas do aging de contas em aberto, em dias relativos a hoje (negativo = vencido).
_AGING_FAIXAS = [
    ("vencido_90_mais", "Vencido há +90 dias", None, -91),
    ("vencido_61_90", "Vencido 61–90 dias", -90, -61),
    ("vencido_31_60", "Vencido 31–60 dias", -60, -31),
    ("vencido_1_30", "Vencido 1–30 dias", -30, -1),
    ("a_vencer_0_30", "A vencer em 0–30 dias", 0, 30),
    ("a_vencer_31_60", "A vencer em 31–60 dias", 31, 60),
    ("a_vencer_61_90", "A vencer em 61–90 dias", 61, 90),
    ("a_vencer_90_mais", "A vencer em +90 dias", 91, None),
]

# Horizontes da projeção de compromissos (a receber − a pagar) a partir de hoje.
PROJECAO_HORIZONTES_DIAS = (30, 60, 90)


def _saldo_conta(conta: Dict[str, Any]) -> float:
    saldo = conta.get("saldo") if conta.get("saldo") is not None else conta.get("valor", 0)
    return float(saldo or 0)


def _dias_ate_vencimento(conta: Dict[str, Any], today: date) -> Optional[int]:
    venc_str = conta.get("data_vencimento")
    if not venc_str:
        return None
    try:
        return (date.fromisoformat(str(venc_str)[:10]) - today).days
    except ValueError:
        return None


def _variacao_pct(atual: float, anterior: float) -> Optional[float]:
    if anterior == 0:
        return None if atual == 0 else 100.0
    return round(((atual - anterior) / abs(anterior)) * 100, 1)


def build_dashboard_response(
    cache: Dict[str, Any],
    date_from: str,
    date_to: str,
    company: Optional[str] = None,
    today: Optional[date] = None,
) -> Dict[str, Any]:
    """Deriva os KPIs do Dashboard Financeiro a partir do cache já sincronizado."""
    today = today or date.today()
    bounds = _period_bounds(date_from, date_to)
    companies_data: Dict[str, Dict[str, Any]] = cache.get("companies", {})
    categories_meta = {c["id"]: c for c in cache.get("categories", [])}

    selected_ids = [company] if company and company in companies_data else list(companies_data.keys())

    def merge_series(kind: str, account_ids: List[str]) -> Dict[str, Dict[str, float]]:
        merged: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for acc in account_ids:
            for chave, cats in _company_series(companies_data.get(acc, {}), kind).items():
                for cat_id, valor in cats.items():
                    merged[chave][cat_id] += valor
        return merged

    despesas_series = merge_series("despesas", selected_ids)
    receitas_series = merge_series("receitas", selected_ids)

    despesas_periodo = _sum_categorias_no_intervalo(despesas_series, bounds["from"], bounds["to"])
    despesas_anterior = _sum_categorias_no_intervalo(despesas_series, bounds["previous_from"], bounds["previous_to"])
    receitas_periodo = _sum_categorias_no_intervalo(receitas_series, bounds["from"], bounds["to"])
    receitas_anterior = _sum_categorias_no_intervalo(receitas_series, bounds["previous_from"], bounds["previous_to"])

    despesa_total = sum(despesas_periodo.values())
    despesa_total_anterior = sum(despesas_anterior.values())
    receita_total = sum(receitas_periodo.values())
    receita_total_anterior = sum(receitas_anterior.values())
    resultado_liquido = receita_total - despesa_total
    resultado_liquido_anterior = receita_total_anterior - despesa_total_anterior
    margem_liquida_pct = round((resultado_liquido / receita_total) * 100, 1) if receita_total else None
    margem_liquida_pct_anterior = (
        round((resultado_liquido_anterior / receita_total_anterior) * 100, 1) if receita_total_anterior else None
    )

    def _categoria_label(cat_id: str) -> Dict[str, str]:
        if cat_id == SEM_CATEGORIA_ID:
            return {"nome": "Sem categoria", "grupo": "Sem categoria"}
        meta = categories_meta.get(cat_id) or CATEGORY_BY_ID.get(cat_id)
        if meta is None:
            return {"nome": "Categoria não identificada", "grupo": "Sem categoria"}
        if isinstance(meta, dict):
            return {"nome": meta.get("nome", cat_id), "grupo": meta.get("grupo", "")}
        return {"nome": meta.nome, "grupo": meta.grupo}

    def build_ranking(atual: Dict[str, float], anterior: Dict[str, float], total: float) -> List[Dict[str, Any]]:
        ranking = []
        for cat_id, valor in atual.items():
            if valor <= 0:
                continue
            label = _categoria_label(cat_id)
            valor_anterior = anterior.get(cat_id, 0.0)
            ranking.append({
                "categoria_id": cat_id,
                "categoria_nome": label["nome"],
                "grupo": label["grupo"],
                "valor": round(valor, 2),
                "valor_anterior": round(valor_anterior, 2),
                "variacao_pct": _variacao_pct(valor, valor_anterior),
                "percentual_do_total": round((valor / total) * 100, 1) if total else 0.0,
            })
        ranking.sort(key=lambda r: r["valor"], reverse=True)
        return ranking

    despesas_ranking = build_ranking(despesas_periodo, despesas_anterior, despesa_total)
    receitas_ranking = build_ranking(receitas_periodo, receitas_anterior, receita_total)

    # Faturamento bruto = só categorias de venda (grupo "1.Receitas"), separado de
    # receita_total (que inclui receitas financeiras como juros/aplicações).
    faturamento_bruto = sum(r["valor"] for r in receitas_ranking if r["grupo"] == FATURAMENTO_BRUTO_GRUPO)
    faturamento_bruto_anterior = sum(r["valor_anterior"] for r in receitas_ranking if r["grupo"] == FATURAMENTO_BRUTO_GRUPO)

    concentracao_top3_pct = round(sum(r["percentual_do_total"] for r in despesas_ranking[:3]), 1) if despesas_ranking else 0.0
    categoria_maior_alta = None
    candidatos_alta = [r for r in despesas_ranking if r["variacao_pct"] is not None and r["valor_anterior"] > 0]
    if candidatos_alta:
        maior = max(candidatos_alta, key=lambda r: r["variacao_pct"])
        if maior["variacao_pct"] and maior["variacao_pct"] > 0:
            categoria_maior_alta = {"categoria_nome": maior["categoria_nome"], "variacao_pct": maior["variacao_pct"]}

    # Fluxo de caixa mensal (últimos N meses do cache, independente do período selecionado).
    receitas_por_mes: Dict[str, float] = defaultdict(float)
    despesas_por_mes: Dict[str, float] = defaultdict(float)
    for chave, cats in receitas_series.items():
        receitas_por_mes[chave[:7]] += sum(cats.values())
    for chave, cats in despesas_series.items():
        despesas_por_mes[chave[:7]] += sum(cats.values())
    todos_meses = sorted(set(despesas_por_mes.keys()) | set(receitas_por_mes.keys()))
    fluxo_caixa_mensal = []
    for mes in todos_meses:
        receita_mes = receitas_por_mes.get(mes, 0.0)
        despesa_mes = despesas_por_mes.get(mes, 0.0)
        ano, num_mes = mes.split("-")
        fluxo_caixa_mensal.append({
            "mes": mes,
            "label": f"{_MONTH_NAMES_PT[int(num_mes) - 1][:3]}/{ano[2:]}",
            "receita": round(receita_mes, 2),
            "despesa": round(despesa_mes, 2),
            "saldo": round(receita_mes - despesa_mes, 2),
        })

    # Fluxo de caixa diário dentro do período selecionado (só quando o cache é diário e o
    # período é curto o bastante para o gráfico ser legível).
    fluxo_caixa_diario: Optional[List[Dict[str, Any]]] = None
    inicio = date.fromisoformat(bounds["from"])
    fim = date.fromisoformat(bounds["to"])
    tem_serie_diaria = any(len(k) == 10 for k in list(receitas_series) + list(despesas_series))
    if tem_serie_diaria and (fim - inicio).days + 1 <= FLUXO_DIARIO_MAX_DIAS:
        fluxo_caixa_diario = []
        dia = inicio
        while dia <= fim:
            chave = dia.isoformat()
            receita_dia = sum(receitas_series.get(chave, {}).values())
            despesa_dia = sum(despesas_series.get(chave, {}).values())
            fluxo_caixa_diario.append({
                "dia": chave,
                "label": dia.strftime("%d/%m"),
                "receita": round(receita_dia, 2),
                "despesa": round(despesa_dia, 2),
                "saldo": round(receita_dia - despesa_dia, 2),
            })
            dia += timedelta(days=1)

    # Contas a pagar/receber: sempre "foto de agora" (independente do período selecionado).
    def aging_summary(key: str) -> Dict[str, Any]:
        contas: List[Dict[str, Any]] = []
        for acc in selected_ids:
            contas.extend(companies_data.get(acc, {}).get(key, []))
        vencido_valor = vencido_qtd = 0.0
        prox_7_valor = prox_7_qtd = 0.0
        prox_30_valor = prox_30_qtd = 0.0
        por_nome: Dict[str, Dict[str, float]] = defaultdict(lambda: {"valor": 0.0, "qtd": 0})
        faixas = {key: {"valor": 0.0, "qtd": 0} for key, _, _, _ in _AGING_FAIXAS}
        for conta in contas:
            saldo = _saldo_conta(conta)
            dias = _dias_ate_vencimento(conta, today)
            if dias is None or saldo <= 0:
                continue
            for key, _, minimo, maximo in _AGING_FAIXAS:
                if (minimo is None or dias >= minimo) and (maximo is None or dias <= maximo):
                    faixas[key]["valor"] += saldo
                    faixas[key]["qtd"] += 1
                    break
            if dias < 0:
                vencido_valor += saldo
                vencido_qtd += 1
            elif dias <= 7:
                prox_7_valor += saldo
                prox_7_qtd += 1
            if 0 <= dias <= 30:
                prox_30_valor += saldo
                prox_30_qtd += 1
            nome = conta.get("nome") or "Não identificado"
            por_nome[nome]["valor"] += saldo
            por_nome[nome]["qtd"] += 1
        ranking_nomes = sorted(
            ({"nome": n, **v} for n, v in por_nome.items()),
            key=lambda x: x["valor"],
            reverse=True,
        )[:5]
        return {
            "vencido_valor": round(vencido_valor, 2),
            "vencido_qtd": int(vencido_qtd),
            "proximos_7_dias_valor": round(prox_7_valor, 2),
            "proximos_7_dias_qtd": int(prox_7_qtd),
            "proximos_30_dias_valor": round(prox_30_valor, 2),
            "proximos_30_dias_qtd": int(prox_30_qtd),
            "top": [{"nome": r["nome"], "valor": round(r["valor"], 2), "qtd": int(r["qtd"])} for r in ranking_nomes],
            "faixas": [
                {"faixa": key, "label": label, "valor": round(faixas[key]["valor"], 2), "qtd": faixas[key]["qtd"]}
                for key, label, _, _ in _AGING_FAIXAS
            ],
        }

    contas_a_pagar = aging_summary("contas_pagar_abertas")
    contas_a_receber_base = aging_summary("contas_receber_abertas")
    total_receber_aberto = sum(
        _saldo_conta(c)
        for acc in selected_ids
        for c in companies_data.get(acc, {}).get("contas_receber_abertas", [])
    )
    taxa_inadimplencia_pct = (
        round((contas_a_receber_base["vencido_valor"] / total_receber_aberto) * 100, 1) if total_receber_aberto else 0.0
    )
    contas_a_receber = {**contas_a_receber_base, "taxa_inadimplencia_pct": taxa_inadimplencia_pct}

    # Projeção de compromissos: o que entra (a receber) menos o que sai (a pagar) pelos
    # vencimentos dos próximos 30/60/90 dias. Não inclui saldo bancário (o Tiny não expõe),
    # nem os títulos já vencidos (incertos — aparecem à parte no aging).
    def _vencimentos_futuros(key: str) -> List[tuple]:
        itens = []
        for acc in selected_ids:
            for conta in companies_data.get(acc, {}).get(key, []):
                dias = _dias_ate_vencimento(conta, today)
                saldo = _saldo_conta(conta)
                if dias is not None and dias >= 0 and saldo > 0:
                    itens.append((dias, saldo))
        return itens

    receber_futuro = _vencimentos_futuros("contas_receber_abertas")
    pagar_futuro = _vencimentos_futuros("contas_pagar_abertas")
    horizonte_max = max(PROJECAO_HORIZONTES_DIAS)
    projecao_semanal = []
    acumulado = 0.0
    for semana_inicio in range(0, horizonte_max + 1, 7):
        semana_fim = min(semana_inicio + 6, horizonte_max)
        entra = sum(v for d, v in receber_futuro if semana_inicio <= d <= semana_fim)
        sai = sum(v for d, v in pagar_futuro if semana_inicio <= d <= semana_fim)
        acumulado += entra - sai
        projecao_semanal.append({
            "inicio": (today + timedelta(days=semana_inicio)).isoformat(),
            "label": (today + timedelta(days=semana_inicio)).strftime("%d/%m"),
            "a_receber": round(entra, 2),
            "a_pagar": round(sai, 2),
            "saldo_acumulado": round(acumulado, 2),
        })
    projecao_caixa = {
        "horizontes": [
            {
                "dias": h,
                "a_receber": round(sum(v for d, v in receber_futuro if d <= h), 2),
                "a_pagar": round(sum(v for d, v in pagar_futuro if d <= h), 2),
                "saldo": round(
                    sum(v for d, v in receber_futuro if d <= h) - sum(v for d, v in pagar_futuro if d <= h), 2
                ),
            }
            for h in PROJECAO_HORIZONTES_DIAS
        ],
        "semanal": projecao_semanal,
    }

    # Forma de pagamento (marcadores), somada dentro do período selecionado (por vencimento).
    forma_pagamento_totais: Dict[str, float] = defaultdict(float)
    for acc in selected_ids:
        periodo = _sum_categorias_no_intervalo(
            _company_forma_pagamento(companies_data.get(acc, {})), bounds["from"], bounds["to"]
        )
        for marcador, valor in periodo.items():
            forma_pagamento_totais[marcador] += valor
    total_forma_pagamento = sum(forma_pagamento_totais.values())
    forma_pagamento = sorted(
        (
            {
                "marcador": m,
                "valor": round(v, 2),
                "percentual": round((v / total_forma_pagamento) * 100, 1) if total_forma_pagamento else 0.0,
            }
            for m, v in forma_pagamento_totais.items()
        ),
        key=lambda x: x["valor"],
        reverse=True,
    )

    por_empresa = None
    if not company:
        por_empresa = []
        for acc in selected_ids:
            acc_data = companies_data.get(acc, {})
            desp_acc = sum(_sum_categorias_no_intervalo(
                _company_series(acc_data, "despesas"), bounds["from"], bounds["to"],
            ).values())
            rec_acc = sum(_sum_categorias_no_intervalo(
                _company_series(acc_data, "receitas"), bounds["from"], bounds["to"],
            ).values())

            def _vencido(key: str) -> float:
                return sum(
                    _saldo_conta(c)
                    for c in acc_data.get(key, [])
                    if (_dias_ate_vencimento(c, today) or 0) < 0 and _saldo_conta(c) > 0
                )

            por_empresa.append({
                "account_id": acc,
                "label": COMPANY_LABELS.get(acc, acc),
                "receita": round(rec_acc, 2),
                "despesa": round(desp_acc, 2),
                "resultado_liquido": round(rec_acc - desp_acc, 2),
                "margem_liquida_pct": round(((rec_acc - desp_acc) / rec_acc) * 100, 1) if rec_acc else None,
                "a_pagar_vencido": round(_vencido("contas_pagar_abertas"), 2),
                "a_receber_vencido": round(_vencido("contas_receber_abertas"), 2),
            })
        por_empresa.sort(key=lambda x: x["resultado_liquido"], reverse=True)

    # Fontes cujo dado exibido não veio da última sincronização (falhou e o cache manteve
    # o último dado bom) — o frontend mostra um aviso com a data real de cada uma.
    # Só dá pra saber em caches gravados já com `sync_started_at`/`synced_at`.
    generated_at = cache.get("generated_at")
    sync_started_at = cache.get("sync_started_at")
    dados_desatualizados = []
    for acc in selected_ids if sync_started_at else []:
        synced_at = companies_data.get(acc, {}).get("synced_at") or {}
        for fonte in _SOURCE_FIELDS:
            quando = synced_at.get(fonte)
            if not quando or quando < sync_started_at:
                dados_desatualizados.append({
                    "account_id": acc,
                    "label": COMPANY_LABELS.get(acc, acc),
                    "fonte": fonte,
                    "synced_at": quando,
                })

    return {
        "generated_at": generated_at,
        "dados_desatualizados": dados_desatualizados,
        "period": {
            "from": bounds["from"],
            "to": bounds["to"],
            "previous_from": bounds["previous_from"],
            "previous_to": bounds["previous_to"],
        },
        "companies_available": [
            {"account_id": acc, "label": COMPANY_LABELS.get(acc, acc)} for acc in companies_data.keys()
        ],
        "company_selected": company,
        "summary": {
            "receita_total": round(receita_total, 2),
            "receita_total_anterior": round(receita_total_anterior, 2),
            "receita_variacao_pct": _variacao_pct(receita_total, receita_total_anterior),
            "faturamento_bruto": round(faturamento_bruto, 2),
            "faturamento_bruto_anterior": round(faturamento_bruto_anterior, 2),
            "faturamento_bruto_variacao_pct": _variacao_pct(faturamento_bruto, faturamento_bruto_anterior),
            "despesa_total": round(despesa_total, 2),
            "despesa_total_anterior": round(despesa_total_anterior, 2),
            "despesa_variacao_pct": _variacao_pct(despesa_total, despesa_total_anterior),
            "resultado_liquido": round(resultado_liquido, 2),
            "resultado_liquido_anterior": round(resultado_liquido_anterior, 2),
            "resultado_liquido_variacao_pct": _variacao_pct(resultado_liquido, resultado_liquido_anterior),
            "margem_liquida_pct": margem_liquida_pct,
            "margem_liquida_pct_anterior": margem_liquida_pct_anterior,
        },
        "fluxo_caixa_mensal": fluxo_caixa_mensal,
        "fluxo_caixa_diario": fluxo_caixa_diario,
        "projecao_caixa": projecao_caixa,
        "despesas_por_categoria": despesas_ranking,
        "receitas_por_categoria": receitas_ranking,
        "concentracao_despesas_top3_pct": concentracao_top3_pct,
        "categoria_maior_alta": categoria_maior_alta,
        "contas_a_pagar": contas_a_pagar,
        "contas_a_receber": contas_a_receber,
        "forma_pagamento": forma_pagamento,
        "por_empresa": por_empresa,
    }


def get_dashboard_response(
    date_from: str,
    date_to: str,
    cfg: Optional[Settings] = None,
    company: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Lê o cache do disco e monta a resposta de KPIs. Retorna None se nunca sincronizado."""
    cfg = cfg or settings
    cache = _load_json(_cache_path(cfg), None)
    if not cache:
        return None
    return build_dashboard_response(cache, date_from=date_from, date_to=date_to, company=company)
