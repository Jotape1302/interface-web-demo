"""
Conciliação bancária: extrato do Banco Inter × Contas a Pagar do Tiny (prévia, baixa e tarefas).

Separado de app/api.py (que monta o FastAPI, as rotinas de fundo e inclui os routers).
"""
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.dinheiro import dinheiro_json
from app.fuso import FUSO_SP, agora_sp, hoje_sp
from app.internal_auth import usuario_da_requisicao
from app.config import settings
from app.json_store import save_json_state
from app.tiny_client import (
    SITUACOES_CONTA_PAGAR_BAIXAVEIS,
    TinyClient,
)
from app.token_repository import TokenRepository
from app.inter_client import InterClient, InterTransacao, INTER_EMPRESAS, _parse_date
from app.contas_pagar_rotina import (
    store_contas_pagar,
)
from app.reconciliation import (
    match_transactions,
    match_transactions_ja_baixadas,
    JA_BAIXADAS_TOLERANCIA_DIAS,
    split_transferencias_internas,
    destino_transferencia_interna,
    MatchMethod,
    EMPRESA_LABELS,
    _to_decimal,
    _extract_cnpj_from_tiny,
    _extract_supplier_name_from_tiny,
)
from app.routers.jobs import _Progresso, _consultar_job, _iniciar_job

logger = logging.getLogger("automacao_nfe.api")

router = APIRouter()


# =============================================================================
# CONCILIAÇÃO BANCÁRIA: BANCO INTER × CONTAS A PAGAR TINY ERP
# =============================================================================

class ReconciliacaoPreviewRequest(BaseModel):
    empresa: Optional[str] = "todas"
    data_inicio: Optional[str] = None
    data_fim: Optional[str] = None
    tolerance_days: int = 60
    # True = ignora o cache e consulta Inter/Tiny de novo (botão "Comparar"/"Atualizar").
    forcar_atualizacao: bool = False


class BaixaItemRequest(BaseModel):
    """
    O que o cliente escolhe: QUAL casamento da prévia baixar (empresa + conta + débito do Inter).
    valor_pago, data_pagamento, juros, multa, desconto e conta_origem_id continuam aceitos por
    compatibilidade com a tela, mas são IGNORADOS: a baixa usa os valores do extrato guardados
    na prévia do servidor (AUT-02). `historico` é só texto (até 200 caracteres).
    """
    empresa: str
    conta_pagar_id: int
    inter_transacao_id: Optional[str] = None
    valor_pago: Optional[float] = None
    data_pagamento: Optional[str] = None
    juros: float = 0.0
    multa: float = 0.0
    desconto: float = 0.0
    historico: Optional[str] = None
    conta_origem_id: Optional[int] = None


class ReconciliacaoBaixarRequest(BaseModel):
    itens: List[BaixaItemRequest]


@router.get("/api/v1/reconciliacao/status")
def get_reconciliacao_status():
    """Retorna o status de configuração do Banco Inter e do Tiny ERP para cada filial."""
    token_repo = TokenRepository(settings)
    inter_client = InterClient(certs_dir=settings.INTER_CERTS_DIR, base_url=settings.INTER_BASE_URL)

    empresas_status = []
    for emp_id, emp_label in EMPRESA_LABELS.items():
        creds = INTER_EMPRESAS.get(emp_id, {})
        cnpj = creds.get("cnpj")

        # Verifica Tiny
        tiny_ok = False
        if token_repo.is_configured():
            t_res = token_repo.get_token_by_cnpj_or_account(cnpj=cnpj, account_id=emp_id)
            tiny_ok = bool(t_res and t_res[0])
        if not tiny_ok and settings.TINY_API_TOKEN:
            tiny_ok = True

        # Verifica Inter com detalhamento de saúde
        inter_diag = inter_client.check_credentials_status(emp_id)
        inter_ok = (inter_diag.get("status") == "conectado")

        empresas_status.append({
            "id": emp_id,
            "nome": emp_label,
            "cnpj": cnpj,
            "inter_configurado": inter_ok,
            "inter_status": inter_diag.get("status"),
            "inter_mensagem": inter_diag.get("mensagem"),
            "tiny_configurado": tiny_ok,
        })

    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "empresas": empresas_status,
    }


def _inter_tx_json(itx: InterTransacao) -> Dict[str, Any]:
    return {
        "empresa": itx.empresa,
        "empresa_nome": EMPRESA_LABELS.get(itx.empresa, itx.empresa.title()),
        "transacao_id": itx.transacao_id,
        "data_pagamento": itx.data_pagamento.isoformat(),
        "valor_pago": dinheiro_json(itx.valor_pago),
        "tipo_transacao": itx.tipo_transacao,
        "titulo": itx.titulo,
        "descricao": itx.descricao,
        "nome_favorecido": itx.nome_favorecido,
        "cpf_cnpj_favorecido": itx.cpf_cnpj_favorecido,
        "codigo_barras": itx.codigo_barras,
    }


# =============================================================================
# Cache dos dados de origem da conciliação (por filial e período)
# =============================================================================
# Buscar é o caro: extrato do Inter + 3 listagens paginadas do Tiny por filial, com throttle de
# 2s por página (minutos). Cruzar é barato. Por isso o cache guarda os dados brutos de cada
# filial: abrir a página de novo, trocar "Todas" por uma filial (ou o contrário) ou filtrar
# texto não consulta Inter/Tiny outra vez. Consulta com falha não é guardada. A baixa descarta
# o cache das filiais que tiveram conta baixada; "Comparar" força uma consulta nova.
# Em memória: a API roda num único processo uvicorn (app/main.py).

RECONCILIACAO_CACHE_TTL_SECONDS = 15 * 60


@dataclass
class _DadosEmpresa:
    inter_txs: List[InterTransacao]
    tiny_pendentes: List[Dict[str, Any]]
    tiny_pagas: List[Dict[str, Any]]
    avisos: List[str]
    buscado_em: float
    falhou: bool


_dados_cache: Dict[Tuple[str, date, date, int], _DadosEmpresa] = {}
_dados_cache_lock = threading.Lock()


def invalidar_cache_conciliacao(empresas: Optional[List[str]] = None) -> None:
    """Descarta os dados em cache das filiais dadas (todas, se None)."""
    with _dados_cache_lock:
        for chave in [k for k in _dados_cache if empresas is None or k[0] in empresas]:
            del _dados_cache[chave]


def marcar_baixadas_no_cache(baixadas: List[Tuple[str, int]]) -> None:
    """
    Depois de uma baixa com sucesso, move as contas de "em aberto" para "pagas" nos dados em
    cache da filial, em vez de descartar tudo: a prévia seguinte fica instantânea e a conta
    passa a aparecer como já baixada, como apareceria consultando o Tiny de novo.
    """
    por_empresa: Dict[str, set] = {}
    for emp, conta_id in baixadas:
        por_empresa.setdefault(emp, set()).add(int(conta_id))
    with _dados_cache_lock:
        for (emp, *_), dados in _dados_cache.items():
            ids = por_empresa.get(emp)
            if not ids:
                continue
            movidas = [c for c in dados.tiny_pendentes if int(c.get("id") or 0) in ids]
            if not movidas:
                continue
            dados.tiny_pendentes = [c for c in dados.tiny_pendentes if int(c.get("id") or 0) not in ids]
            dados.tiny_pagas = dados.tiny_pagas + [{**c, "situacao": "pago"} for c in movidas]


def _periodo_preview(payload: "ReconciliacaoPreviewRequest") -> Tuple[date, date]:
    hoje = hoje_sp()
    try:
        dt_inicio = date.fromisoformat(payload.data_inicio) if payload.data_inicio else hoje - timedelta(days=30)
    except Exception:
        dt_inicio = hoje - timedelta(days=30)
    try:
        dt_fim = date.fromisoformat(payload.data_fim) if payload.data_fim else hoje
    except Exception:
        dt_fim = hoje
    return dt_inicio, dt_fim


def _empresas_preview(payload: "ReconciliacaoPreviewRequest") -> List[str]:
    alvo = (payload.empresa or "todas").lower().strip()
    if alvo == "todas":
        return list(EMPRESA_LABELS.keys())
    if alvo in EMPRESA_LABELS:
        return [alvo]
    raise HTTPException(
        status_code=400,
        detail=f"Empresa '{payload.empresa}' inválida. Escolha entre: {', '.join(EMPRESA_LABELS.keys())} ou 'todas'.",
    )


def _cache_valido(chave: Tuple[str, date, date, int]) -> Optional[_DadosEmpresa]:
    with _dados_cache_lock:
        dados = _dados_cache.get(chave)
        if dados and time.time() - dados.buscado_em < RECONCILIACAO_CACHE_TTL_SECONDS:
            return dados
        _dados_cache.pop(chave, None)
        return None


def _preview_todo_em_cache(payload: "ReconciliacaoPreviewRequest") -> bool:
    if payload.forcar_atualizacao:
        return False
    dt_inicio, dt_fim = _periodo_preview(payload)
    tolerance_days = payload.tolerance_days or 60
    return all(_cache_valido((emp, dt_inicio, dt_fim, tolerance_days)) for emp in _empresas_preview(payload))


def _dados_empresa(
    emp: str,
    dt_inicio: date,
    dt_fim: date,
    tolerance_days: int,
    forcar: bool = False,
    progresso: Optional[Callable[[str], None]] = None,
) -> Tuple[_DadosEmpresa, bool]:
    """Extrato do Inter + contas do Tiny de uma filial, do cache quando possível. Retorna (dados, do_cache)."""
    chave = (emp, dt_inicio, dt_fim, tolerance_days)
    if not forcar:
        em_cache = _cache_valido(chave)
        if em_cache:
            return em_cache, True

    emp_label = EMPRESA_LABELS.get(emp, emp.title())
    emp_cnpj = INTER_EMPRESAS.get(emp, {}).get("cnpj")
    inter_client = InterClient(certs_dir=settings.INTER_CERTS_DIR, base_url=settings.INTER_BASE_URL)
    tiny_client = TinyClient()
    token_repo = TokenRepository(settings)

    pendentes: List[Dict[str, Any]] = []
    pagas: List[Dict[str, Any]] = []
    avisos: List[str] = []
    falhou = False

    # Janela de vencimento mais larga que a do extrato: pagamentos do período quitam contas
    # vencidas antes dele (em atraso) ou que só vencem depois (pagas adiantadas).
    venc_inicio = dt_inicio - timedelta(days=tolerance_days)
    venc_fim = dt_fim + timedelta(days=30)

    # 1. Extrato do Inter — em paralelo com o Tiny (APIs independentes).
    def _extrato_inter() -> Tuple[List[InterTransacao], List[str], bool]:
        if progresso:
            progresso(f"{emp_label}: extrato do Banco Inter")
        inter_diag = inter_client.check_credentials_status(emp)
        if inter_diag.get("status") != "conectado":
            # Sem conexão o extrato falharia com o mesmo erro; um aviso por empresa basta.
            return [], [f"{emp_label} (Inter): {inter_diag.get('mensagem')}"], True
        try:
            txs = inter_client.get_extrato(emp, dt_inicio, dt_fim, allow_demo=False)
            logger.info(f"[RECONCILIACAO] {emp_label}: {len(txs)} débito(s) no extrato do Inter.")
            if not txs:
                return txs, [f"{emp_label}: o extrato não trouxe nenhum débito no período — confira as datas."], False
            return txs, [], False
        except Exception as e_inter:
            msg = f"{emp_label}: Falha ao consultar extrato no Banco Inter: {e_inter}"
            logger.warning(f"[RECONCILIACAO] {msg}")
            return [], [msg], True

    inter_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"inter-{emp}")
    inter_futuro = inter_pool.submit(_extrato_inter)
    inter_pool.shutdown(wait=False)

    # 2. Contas a pagar no Tiny
    tiny_token = None
    if token_repo.is_configured():
        res = token_repo.get_token_by_cnpj_or_account(cnpj=emp_cnpj, account_id=emp)
        if res:
            tiny_token = res[0]
    if not tiny_token:
        tiny_token = settings.TINY_API_TOKEN or "mock"

    if progresso:
        progresso(f"{emp_label}: contas a pagar no Tiny")
    if not tiny_token or tiny_token in ("mock", "seu_token_aqui"):
        # Sem token a filial vinha com "0 contas no Tiny" e nenhum aviso.
        avisos.append(f"{emp_label}: token do Tiny não encontrado (api_tokens) — contas do Tiny não consultadas.")
        falhou = True
    else:
        try:
            # "aberto" no Tiny v3 NÃO inclui as vencidas ("atrasadas"): sem elas, uma conta paga
            # no vencimento e não baixada vira atrasada no dia seguinte e o débito aparece
            # como "sem par". A API não aceita duas situações na mesma chamada.
            pendentes_por_id: Dict[int, Dict[str, Any]] = {}
            for situacao in ("aberto", "atrasadas"):
                for c in tiny_client.list_contas_pagar_v3(
                    token=tiny_token,
                    situacao=situacao,
                    data_inicial_vencimento=venc_inicio.isoformat(),
                    data_final_vencimento=venc_fim.isoformat(),
                    estrito=True,
                ):
                    c["empresa"] = emp
                    pendentes_por_id[int(c["id"])] = c
            pendentes = list(pendentes_por_id.values())
        except Exception as e_tiny:
            msg = f"{emp_label}: Falha ao consultar contas no Tiny: {e_tiny}"
            logger.warning(f"[RECONCILIACAO] {msg}")
            avisos.append(msg)
            falhou = True

        try:
            # Contas pagas só casam com vencimento a até JA_BAIXADAS_TOLERANCIA_DIAS do
            # pagamento (fora o código de barras): janela curta, porque cada página do Tiny
            # custa 2s de throttle e filiais grandes têm milhares de contas pagas.
            for c in tiny_client.list_contas_pagar_v3(
                token=tiny_token,
                situacao="pago",
                data_inicial_vencimento=(dt_inicio - timedelta(days=JA_BAIXADAS_TOLERANCIA_DIAS)).isoformat(),
                data_final_vencimento=(dt_fim + timedelta(days=JA_BAIXADAS_TOLERANCIA_DIAS)).isoformat(),
                estrito=True,
            ):
                c["empresa"] = emp
                pagas.append(c)
        except Exception as e_tiny:
            msg = f"{emp_label}: Falha ao consultar contas já pagas no Tiny (débitos já baixados podem aparecer sem par): {e_tiny}"
            logger.warning(f"[RECONCILIACAO] {msg}")
            avisos.append(msg)
            falhou = True

    inter_txs, avisos_inter, falhou_inter = inter_futuro.result()
    avisos = avisos_inter + avisos
    falhou = falhou or falhou_inter

    dados = _DadosEmpresa(inter_txs, pendentes, pagas, avisos, time.time(), falhou)
    if not falhou:
        with _dados_cache_lock:
            _dados_cache[chave] = dados
    return dados, False


@router.get("/api/v1/reconciliacao/estado")
def obter_estado_reconciliacao():
    """Retorna o estado persistido das pendências de Contas a Pagar (Inter × Tiny)."""
    return store_contas_pagar.carregar()


@router.post("/api/v1/reconciliacao/preview")
def preview_reconciliacao(payload: ReconciliacaoPreviewRequest):
    """Versão síncrona (testes/uso interno). A tela usa POST /reconciliacao/jobs/preview."""
    return _run_preview(payload)


def _run_preview(payload: ReconciliacaoPreviewRequest, progresso: Optional["_Progresso"] = None):
    """
    Executa o cruzamento entre o extrato do Banco Inter e as contas em aberto do Tiny.
    Retorna uma lista estruturada de casamentos e itens pendentes para revisão humana.
    """
    target_empresa = (payload.empresa or "todas").lower().strip()
    empresas = _empresas_preview(payload)
    dt_inicio, dt_fim = _periodo_preview(payload)

    tolerance_days = payload.tolerance_days or 60

    all_inter_txs: List[InterTransacao] = []
    all_tiny_contas: List[Dict[str, Any]] = []
    all_tiny_pagas: List[Dict[str, Any]] = []
    avisos: List[str] = []
    buscados_em: List[float] = []
    todos_do_cache = True

    # Filiais em paralelo: cada uma tem sua conta no Tiny (limite e throttle próprios, ver
    # _throttle_tiny_dashboard_call) e seu certificado no Inter. Em sequência, a prévia de
    # "todas" somava a espera de todas as filiais.
    concluidas = [0]
    concluidas_lock = threading.Lock()

    def _buscar(emp: str) -> Tuple[_DadosEmpresa, bool]:
        def _etapa(etapa: str) -> None:
            if progresso:
                with concluidas_lock:
                    feitas = concluidas[0]
                progresso(etapa, feitas, len(empresas))

        try:
            return _dados_empresa(
                emp, dt_inicio, dt_fim, tolerance_days,
                forcar=payload.forcar_atualizacao,
                progresso=_etapa if progresso else None,
            )
        finally:
            with concluidas_lock:
                concluidas[0] += 1

    with ThreadPoolExecutor(max_workers=max(1, len(empresas)), thread_name_prefix="preview-filial") as pool:
        por_empresa = list(pool.map(_buscar, empresas))

    for dados, do_cache in por_empresa:
        todos_do_cache = todos_do_cache and do_cache
        buscados_em.append(dados.buscado_em)
        all_inter_txs.extend(dados.inter_txs)
        all_tiny_contas.extend(dados.tiny_pendentes)
        all_tiny_pagas.extend(dados.tiny_pagas)
        avisos.extend(dados.avisos)

    if progresso:
        progresso("Cruzando extrato e contas", len(empresas), len(empresas))

    # 3. Cruzamento completo com as contas em aberto (transferências entre empresas do grupo
    # entram também: se houver conta lançada no Tiny para elas, precisam ser baixadas)
    res = match_transactions(
        empresa=target_empresa,
        inter_transacoes=all_inter_txs,
        tiny_contas=all_tiny_contas,
        tolerance_days=tolerance_days,
    )

    # Transferência interna casada só por "valor único no período" é coincidência provável
    # (ex.: R$ 32.000 para a Revesta x uma conta qualquer de R$ 32.000): desfaz.
    inter_por_id = {itx.transacao_id: itx for itx in all_inter_txs}
    conta_por_id = {int(c["id"]): c for c in all_tiny_contas if c.get("id")}
    all_matches = []
    for m in res.matches:
        if m.metodo_match == MatchMethod.VALOR_DATA_UNICO and destino_transferencia_interna(inter_por_id[m.inter_transacao_id]):
            if m.conta_pagar_id in conta_por_id:
                res.unmatched_tiny.append(conta_por_id[m.conta_pagar_id])
            continue
        all_matches.append(m)
    casados = {m.inter_transacao_id for m in all_matches}
    sem_conta_aberta = [itx for itx in all_inter_txs if itx.transacao_id not in casados]

    # 4. Débitos sem conta em aberto que correspondem a contas já pagas no Tiny
    ja_baixadas, restantes = match_transactions_ja_baixadas(
        empresa=target_empresa,
        inter_transacoes=sem_conta_aberta,
        tiny_contas_pagas=all_tiny_pagas,
        tolerance_days=JA_BAIXADAS_TOLERANCIA_DIAS,
    )

    # 5. Transferências entre empresas do grupo ficam na aba própria, já conciliadas: casadas
    # com conta em aberto (aptas para baixa ali mesmo), casadas com conta já paga, ou sem conta.
    def _eh_transferencia(inter_id: str) -> bool:
        return destino_transferencia_interna(inter_por_id[inter_id]) is not None

    transf_casadas = {m.inter_transacao_id: m for m in all_matches if _eh_transferencia(m.inter_transacao_id)}
    transf_ja_baixadas = {m.inter_transacao_id: m for m in ja_baixadas if _eh_transferencia(m.inter_transacao_id)}
    all_matches = [m for m in all_matches if m.inter_transacao_id not in transf_casadas]
    ja_baixadas = [m for m in ja_baixadas if m.inter_transacao_id not in transf_ja_baixadas]
    all_unmatched_inter, transf_sem_conta = split_transferencias_internas(restantes)
    transferencias_internas = [
        (itx, destino, transf_casadas.get(itx.transacao_id), transf_ja_baixadas.get(itx.transacao_id))
        for itx in all_inter_txs
        if (destino := destino_transferencia_interna(itx))
    ]
    # Contas vencidas antes do período só entram para o cruzamento; na lista de pendências
    # ficam as do período, como antes.
    all_unmatched_tiny = [
        c for c in res.unmatched_tiny
        if (venc := _parse_date(c.get("dataVencimento") or c.get("vencimento"))) is None
        or dt_inicio <= venc <= dt_fim
    ]

    total_casados = len(all_matches)
    valor_total_casados = sum((m.valor_pago for m in all_matches), Decimal("0.00"))
    total_inter_sem_par = len(all_unmatched_inter)
    valor_inter_sem_par = sum((t.valor_pago for t in all_unmatched_inter), Decimal("0.00"))
    total_tiny_sem_par = len(all_unmatched_tiny)
    valor_tiny_sem_par = sum((_to_decimal(c.get("valor") or c.get("saldo")) for c in all_unmatched_tiny), Decimal("0.00"))

    def _match_json(m) -> Dict[str, Any]:
        return {
            "id": m.id,
            "empresa": m.empresa,
            "empresa_nome": m.empresa_nome,
            "conta_pagar_id": m.conta_pagar_id,
            "numero_documento": m.numero_documento,
            "fornecedor_nome": m.fornecedor_nome,
            "fornecedor_cnpj": m.fornecedor_cnpj,
            "data_vencimento": m.data_vencimento.isoformat(),
            "valor_tiny": dinheiro_json(m.valor_tiny),
            "inter_transacao_id": m.inter_transacao_id,
            "tipo_transacao_inter": m.tipo_transacao_inter,
            "data_pagamento": m.data_pagamento.isoformat(),
            "valor_pago": dinheiro_json(m.valor_pago),
            "valor_original_inter": dinheiro_json(m.valor_original_inter) if m.valor_original_inter else None,
            "juros": dinheiro_json(m.juros),
            "multa": dinheiro_json(m.multa),
            "desconto": dinheiro_json(m.desconto),
            "codigo_barras": m.codigo_barras,
            "metodo_match": m.metodo_match.value,
            "confianca": m.confianca,
            "motivo": m.motivo,
            "status_tiny": m.status_tiny,
            "historico_sugerido": m.historico_sugerido,
        }

    def _ja_baixada_json(m) -> Dict[str, Any]:
        return {
            "empresa": m.empresa,
            "empresa_nome": m.empresa_nome,
            "inter_transacao_id": m.inter_transacao_id,
            "data_pagamento": m.data_pagamento.isoformat(),
            "valor_pago": dinheiro_json(m.valor_pago),
            "tipo_transacao": m.tipo_transacao_inter,
            "nome_favorecido": inter_por_id[m.inter_transacao_id].nome_favorecido,
            "cpf_cnpj_favorecido": inter_por_id[m.inter_transacao_id].cpf_cnpj_favorecido,
            "conta_pagar_id": m.conta_pagar_id,
            "numero_documento": m.numero_documento,
            "fornecedor_nome": m.fornecedor_nome,
            "data_vencimento": m.data_vencimento.isoformat(),
            "valor_tiny": dinheiro_json(m.valor_tiny),
            "metodo_match": m.metodo_match.value,
            "confianca": m.confianca,
            "motivo": m.motivo,
        }

    matches_json = [_match_json(m) for m in all_matches]
    unmatched_inter_json = [_inter_tx_json(itx) for itx in all_unmatched_inter]
    ja_baixadas_json = [_ja_baixada_json(m) for m in ja_baixadas]
    transferencias_json = [
        {
            **_inter_tx_json(itx),
            "empresa_destino_nome": destino,
            "situacao": "apta_baixa" if casada else ("ja_baixada" if ja_baixada else "sem_conta"),
            "conciliacao": _match_json(casada) if casada else None,
            "conta_ja_baixada": _ja_baixada_json(ja_baixada) if ja_baixada else None,
        }
        for itx, destino, casada, ja_baixada in transferencias_internas
    ]
    transferencias_aptas = [casada for _, _, casada, _ in transferencias_internas if casada]
    # O que a baixa vai aceitar depois (AUT-02): só estes pares conta × débito, com estes valores.
    _registrar_aptos(all_matches + transferencias_aptas, tela=_match_json)

    unmatched_tiny_json = []
    for c in all_unmatched_tiny:
        c_emp = str(c.get("empresa") or target_empresa).lower()
        unmatched_tiny_json.append({
            "id": int(c.get("id") or 0),
            "empresa": c_emp,
            "empresa_nome": EMPRESA_LABELS.get(c_emp, c_emp.title()),
            "numero_documento": str(c.get("numeroDocumento") or c.get("documento") or c.get("id") or "-"),
            "fornecedor_nome": _extract_supplier_name_from_tiny(c),
            "fornecedor_cnpj": _extract_cnpj_from_tiny(c),
            "data_vencimento": str(c.get("dataVencimento") or c.get("vencimento") or "").split("T")[0],
            "valor": dinheiro_json(_to_decimal(c.get("valor") or c.get("saldo"))),
            "historico": str(c.get("historico") or ""),
        })

    resultado_preview = {
        "status": "ok",
        "data_inicio": dt_inicio.isoformat(),
        "data_fim": dt_fim.isoformat(),
        # Momento da consulta mais antiga ao Inter/Tiny entre as filiais (dados em cache ficam
        # até RECONCILIACAO_CACHE_TTL_SECONDS); do_cache = nenhuma filial foi consultada agora.
        "dados_de": datetime.fromtimestamp(min(buscados_em), FUSO_SP).isoformat() if buscados_em else agora_sp().isoformat(),
        "do_cache": todos_do_cache,
        "summary": {
            "total_casados": total_casados,
            "valor_total_casados": dinheiro_json(valor_total_casados),
            "total_inter_sem_par": total_inter_sem_par,
            "valor_inter_sem_par": dinheiro_json(valor_inter_sem_par),
            "total_tiny_sem_par": total_tiny_sem_par,
            "valor_tiny_sem_par": dinheiro_json(valor_tiny_sem_par),
            "total_ja_baixadas": len(ja_baixadas),
            "valor_ja_baixadas": dinheiro_json(sum((m.valor_pago for m in ja_baixadas), Decimal("0.00"))),
            "total_transferencias_internas": len(transferencias_internas),
            "valor_transferencias_internas": dinheiro_json(sum((t.valor_pago for t, _, _, _ in transferencias_internas), Decimal("0.00"))),
            "total_transferencias_aptas": len(transferencias_aptas),
            "valor_transferencias_aptas": dinheiro_json(sum((m.valor_pago for m in transferencias_aptas), Decimal("0.00"))),
        },
        "matches": matches_json,
        "unmatched_inter": unmatched_inter_json,
        "unmatched_tiny": unmatched_tiny_json,
        "ja_baixadas": ja_baixadas_json,
        "transferencias_internas": transferencias_json,
        "avisos": avisos,
    }
    try:
        store_contas_pagar.mesclar_preview(
            resultado_preview,
            tipo_execucao="preview_manual" if progresso else "preview_sincrono",
            sucesso=True,
            mensagem="Prévia executada com sucesso.",
        )
    except Exception as e_mesclar:
        logger.warning(f"[CONTAS_PAGAR_ROTINA] Erro ao mesclar prévia no estado persistente: {e_mesclar}")

    return resultado_preview


# =============================================================================
# Baixa: só o que a prévia do servidor deu como apto (AUT-02) e sem repetir (AUT-03)
# =============================================================================
# O cliente escolhe QUAIS casamentos baixar (empresa + conta_pagar_id + inter_transacao_id);
# valor, data, juros, multa, desconto e conta de origem vêm do extrato do Inter guardado na
# prévia, nunca do corpo da requisição. Antes de baixar, a conta é relida no Tiny (tem de
# estar em aberto e com o valor da prévia). Cada débito do Inter baixa uma conta só: o registro
# persistente das baixas feitas impede reaproveitar o mesmo débito, e a trava por
# (empresa, conta) impede duas baixas simultâneas da mesma conta.

APTOS_BAIXA_TTL_SECONDS = 3600  # igual ao TTL das tarefas: prévia de mais de 1h exige "Comparar" de novo
REGISTRO_BAIXAS_MAX = 20000
_TOLERANCIA_VALOR = Decimal("0.05")  # mesma tolerância do cruzamento por valor (reconciliation.py)


@dataclass
class _AptoBaixa:
    empresa: str
    conta_pagar_id: int
    inter_transacao_id: str
    valor_pago: Decimal
    data_pagamento: date
    juros: Decimal
    multa: Decimal
    desconto: Decimal
    valor_tiny: Decimal
    historico_sugerido: str
    registrado_em: float
    # O casamento como a prévia mostrou (_match_json), para o registro de treino da baixa.
    tela: Dict[str, Any] = field(default_factory=dict)


_aptos_baixa: Dict[Tuple[str, int, str], _AptoBaixa] = {}
_aptos_lock = threading.Lock()
_baixas_em_andamento: set = set()  # {(empresa, conta_pagar_id)}
_baixas_em_andamento_lock = threading.Lock()
_registro_baixas_lock = threading.Lock()


def _registrar_aptos(casamentos: List[Any], tela: Optional[Callable[[Any], Dict[str, Any]]] = None) -> None:
    """Guarda os casamentos aptos de uma prévia (contas casadas + transferências aptas)."""
    agora_ts = time.time()
    with _aptos_lock:
        for chave in [k for k, a in _aptos_baixa.items() if agora_ts - a.registrado_em >= APTOS_BAIXA_TTL_SECONDS]:
            del _aptos_baixa[chave]
        for m in casamentos:
            chave = (str(m.empresa), int(m.conta_pagar_id), str(m.inter_transacao_id))
            _aptos_baixa[chave] = _AptoBaixa(
                empresa=str(m.empresa),
                conta_pagar_id=int(m.conta_pagar_id),
                inter_transacao_id=str(m.inter_transacao_id),
                valor_pago=Decimal(m.valor_pago),
                data_pagamento=m.data_pagamento,
                juros=Decimal(m.juros or 0),
                multa=Decimal(m.multa or 0),
                desconto=Decimal(m.desconto or 0),
                valor_tiny=Decimal(m.valor_tiny),
                historico_sugerido=str(m.historico_sugerido or ""),
                registrado_em=agora_ts,
                tela=tela(m) if tela else {},
            )


def _apto_para(empresa: str, conta_pagar_id: int, inter_transacao_id: str) -> Optional[_AptoBaixa]:
    with _aptos_lock:
        apto = _aptos_baixa.get((empresa, int(conta_pagar_id), inter_transacao_id))
        if apto and time.time() - apto.registrado_em < APTOS_BAIXA_TTL_SECONDS:
            return apto
        return None


def limpar_aptos_baixa() -> None:
    with _aptos_lock:
        _aptos_baixa.clear()


def _arquivo_registro_baixas() -> Path:
    return settings.DATA_DIR / "reconciliacao_inter_baixas.json"


def _ler_registro_baixas() -> Dict[str, Any]:
    try:
        with open(_arquivo_registro_baixas(), "r", encoding="utf-8") as f:
            dados = json.load(f)
        if isinstance(dados, dict) and isinstance(dados.get("transacoes"), dict):
            return dados
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.error(f"[RECONCILIACAO_BAIXA] Registro de baixas ilegível ({_arquivo_registro_baixas()}): {e}")
        raise RuntimeError("Registro de baixas ilegível: baixa suspensa para não repetir pagamentos. Veja os logs.")
    return {"transacoes": {}}


def _baixa_registrada(inter_transacao_id: str) -> Optional[Dict[str, Any]]:
    with _registro_baixas_lock:
        return _ler_registro_baixas()["transacoes"].get(inter_transacao_id)


def _registrar_baixa_feita(apto: _AptoBaixa, usuario: str) -> None:
    with _registro_baixas_lock:
        dados = _ler_registro_baixas()
        transacoes: Dict[str, Any] = dados["transacoes"]
        transacoes[apto.inter_transacao_id] = {
            "empresa": apto.empresa,
            "conta_pagar_id": apto.conta_pagar_id,
            "valor_pago": dinheiro_json(apto.valor_pago),
            "data_pagamento": apto.data_pagamento.isoformat(),
            "baixado_em": datetime.now().isoformat(timespec="seconds"),
            "usuario": usuario,
        }
        if len(transacoes) > REGISTRO_BAIXAS_MAX:
            for chave in list(transacoes)[: len(transacoes) - REGISTRO_BAIXAS_MAX]:
                del transacoes[chave]
        save_json_state(_arquivo_registro_baixas(), dados, "RECONCILIACAO_BAIXA")


def _reservar_baixas(payload: "ReconciliacaoBaixarRequest") -> set:
    """Trava (empresa, conta) do pedido; 409 se alguma já está numa baixa em andamento."""
    chaves = {(i.empresa, int(i.conta_pagar_id)) for i in payload.itens}
    with _baixas_em_andamento_lock:
        conflito = sorted(chaves & _baixas_em_andamento)
        if conflito:
            contas = ", ".join(f"#{cid} ({EMPRESA_LABELS.get(emp, emp)})" for emp, cid in conflito)
            raise HTTPException(status_code=409, detail=f"Já existe uma baixa em andamento para a(s) conta(s) {contas}. Aguarde terminar.")
        _baixas_em_andamento.update(chaves)
    return chaves


def _liberar_baixas(chaves: set) -> None:
    with _baixas_em_andamento_lock:
        _baixas_em_andamento.difference_update(chaves)


def _num_conta(valor: Any) -> Optional[Decimal]:
    try:
        return None if valor is None or valor == "" else Decimal(str(valor))
    except Exception:
        return None


def _conferir_conta_para_baixa(conta: Dict[str, Any], apto: _AptoBaixa) -> Optional[str]:
    """Motivo para NÃO baixar a conta relida no Tiny (None = pode baixar)."""
    cid = apto.conta_pagar_id
    situacao = str(conta.get("situacao") or "").strip().lower()
    if situacao not in SITUACOES_CONTA_PAGAR_BAIXAVEIS:
        return f"Conta #{cid} já não está em aberto no Tiny (situação '{situacao or 'desconhecida'}'): não baixada."
    valor = _num_conta(conta.get("valor"))
    if valor is not None and abs(valor - apto.valor_tiny) > _TOLERANCIA_VALOR:
        return (
            f"Valor da conta #{cid} mudou no Tiny desde a comparação (R$ {apto.valor_tiny:.2f} → R$ {valor:.2f}): "
            "não baixada. Compare de novo."
        )
    em_aberto = _num_conta(conta.get("saldo"))
    if em_aberto is None and valor is not None:
        em_aberto = valor - (_num_conta(conta.get("valorPago")) or Decimal("0"))
    principal = apto.valor_pago - apto.juros - apto.multa + apto.desconto
    if em_aberto is not None and principal - em_aberto > _TOLERANCIA_VALOR:
        return (
            f"Pagamento de R$ {principal:.2f} (sem juros/multa/desconto) é maior que o saldo em aberto da conta #{cid} "
            f"(R$ {em_aberto:.2f}): não baixada. Confira no Tiny."
        )
    return None


def _treino_baixa(payload: "ReconciliacaoBaixarRequest") -> Dict[str, Any]:
    """Para o registro de treino do gateway (atividades.ts): todos os casamentos que a prévia
    sugeriu baixar nas filiais do pedido, como a tela mostrou. A decisão humana é o subconjunto
    escolhido (`itens` do pedido); o que ficou de fora foi recusado."""
    empresas = {i.empresa for i in payload.itens}
    agora_ts = time.time()
    with _aptos_lock:
        aptos = [a for a in _aptos_baixa.values() if a.empresa in empresas and agora_ts - a.registrado_em < APTOS_BAIXA_TTL_SECONDS]
    return {
        "contexto": {"casamentos": [a.tela or {"empresa": a.empresa, "conta_pagar_id": a.conta_pagar_id} for a in aptos]},
        "sugestao": {"baixar": [{"empresa": a.empresa, "conta_pagar_id": a.conta_pagar_id, "inter_transacao_id": a.inter_transacao_id} for a in aptos]},
    }


@router.post("/api/v1/reconciliacao/baixar")
def executar_baixa_reconciliacao(payload: ReconciliacaoBaixarRequest, request: Request):
    """Versão síncrona (testes/uso interno). A tela usa POST /reconciliacao/jobs/baixar."""
    if not payload.itens:
        raise HTTPException(status_code=400, detail="Nenhum item informado para baixa.")
    usuario = usuario_da_requisicao(request)
    treino = _treino_baixa(payload)
    chaves = _reservar_baixas(payload)
    try:
        return {**_run_baixa(payload, usuario=usuario), "treino": treino}
    finally:
        _liberar_baixas(chaves)


def _resultado(item: "BaixaItemRequest", status_item: str, mensagem: str, apto: Optional[_AptoBaixa] = None) -> Dict[str, Any]:
    res: Dict[str, Any] = {
        "conta_pagar_id": item.conta_pagar_id,
        "empresa": item.empresa,
        "inter_transacao_id": item.inter_transacao_id,
        "status": status_item,
        "mensagem": mensagem,
    }
    if apto is not None:
        # Valores efetivamente usados (do extrato guardado na prévia), para o histórico do gateway.
        res.update(
            valor_pago=float(apto.valor_pago),
            data_pagamento=apto.data_pagamento.isoformat(),
            juros=float(apto.juros),
            multa=float(apto.multa),
            desconto=float(apto.desconto),
        )
    return res


def _run_baixa(payload: ReconciliacaoBaixarRequest, progresso: Optional["_Progresso"] = None, usuario: str = ""):
    """
    Executa a baixa no Tiny ERP das contas selecionadas e confirmadas pelo usuário.
    Gera relatório detalhado de sucesso/erro por conta. Quem chama já reservou as contas
    (_reservar_baixas).
    """
    if not payload.itens:
        raise HTTPException(status_code=400, detail="Nenhum item informado para baixa.")

    token_repo = TokenRepository(settings)
    tiny_client = TinyClient()

    resultados = []
    sucessos = 0
    falhas = 0
    vistos_contas: set = set()
    vistos_transacoes: set = set()
    if usuario:
        logger.info(f"[RECONCILIACAO_BAIXA] Baixa de {len(payload.itens)} conta(s) solicitada por {usuario}.")

    for idx_item, item in enumerate(payload.itens):
        emp = item.empresa
        cid = item.conta_pagar_id
        itx_id = (item.inter_transacao_id or "").strip()
        if progresso:
            progresso(f"Baixando conta #{cid} ({EMPRESA_LABELS.get(emp, emp)})", idx_item, len(payload.itens))

        def _falha(mensagem: str, apto: Optional[_AptoBaixa] = None) -> None:
            nonlocal falhas
            resultados.append(_resultado(item, "erro", mensagem, apto))
            falhas += 1

        if not itx_id:
            _falha(f"Conta #{cid} NÃO foi baixada: falta o débito do Inter (inter_transacao_id). Compare de novo e selecione.")
            continue
        if (emp, cid) in vistos_contas or itx_id in vistos_transacoes:
            _falha(f"Conta #{cid} NÃO foi baixada: repetida no mesmo pedido (conta ou débito do Inter já incluídos).")
            continue
        vistos_contas.add((emp, cid))
        vistos_transacoes.add(itx_id)

        apto = _apto_para(emp, cid, itx_id)
        if apto is None:
            _falha(
                f"Conta #{cid} NÃO foi baixada: não consta como apta com este débito do Inter na última comparação "
                "(ou a comparação expirou). Clique em Comparar e selecione de novo."
            )
            continue

        try:
            ja_feita = _baixa_registrada(itx_id)
        except RuntimeError as e:
            _falha(str(e), apto)
            continue
        if ja_feita:
            _falha(
                f"Débito do Inter já usado na baixa da conta #{ja_feita.get('conta_pagar_id')} em "
                f"{ja_feita.get('baixado_em')}: conta #{cid} NÃO foi baixada de novo.",
                apto,
            )
            continue

        tiny_token = None
        if token_repo.is_configured():
            res = token_repo.get_token_by_cnpj_or_account(account_id=emp)
            if res:
                tiny_token = res[0]
        if not tiny_token:
            tiny_token = settings.TINY_API_TOKEN or "mock"

        if tiny_token in ("mock", "seu_token_aqui"):
            # Antes isto respondia "baixada com sucesso (Simulado)" sem tocar no Tiny — em produção,
            # com o token da filial ausente, o usuário via sucesso e a conta continuava em aberto.
            logger.error(f"[RECONCILIACAO_BAIXA] Conta #{cid} ({emp}) não baixada: token do Tiny não configurado.")
            _falha(f"Token do Tiny não configurado para '{emp}': conta #{cid} NÃO foi baixada.", apto)
            continue

        try:
            try:
                conta_atual, tiny_token = tiny_client.obter_conta_pagar_v3(token=tiny_token, conta_id=cid)
            except Exception as e_ler:
                raise RuntimeError(f"Conta #{cid} NÃO foi baixada: não foi possível relê-la no Tiny ({e_ler}).")
            motivo = _conferir_conta_para_baixa(conta_atual, apto)
            if motivo:
                logger.warning(f"[RECONCILIACAO_BAIXA] {motivo}")
                _falha(motivo, apto)
                continue

            # Conta de origem sempre resolvida aqui (a "Banco Inter" da filial), nunca do cliente.
            conta_origem_id = tiny_client.resolve_conta_origem_inter(token=tiny_token, account_id=emp)
            if not conta_origem_id:
                # Sem contaOrigem o Tiny baixa na conta padrão dele, que pode ser qualquer uma.
                raise RuntimeError(
                    f"Conta 'Banco Inter' de {EMPRESA_LABELS.get(emp, emp)} não encontrada no Tiny "
                    f"(ou há mais de uma): conta #{cid} NÃO foi baixada."
                )

            historico = (item.historico or "").strip()[:200] or apto.historico_sugerido or f"Baixa conciliada Banco Inter {itx_id}"
            tiny_client.baixar_conta_pagar_v3(
                token=tiny_token,
                conta_id=cid,
                valor_pago=float(apto.valor_pago),
                data_pagamento=apto.data_pagamento.isoformat(),
                conta_origem_id=conta_origem_id,
                juros=float(apto.juros),
                multa=float(apto.multa),
                desconto=float(apto.desconto),
                historico=historico,
                conta_atual=conta_atual,
            )
            try:
                _registrar_baixa_feita(apto, usuario)
            except Exception as e_reg:  # a baixa entrou; só o registro local falhou
                logger.error(f"[RECONCILIACAO_BAIXA] Conta #{cid} baixada, mas o registro local falhou: {e_reg}")
            logger.info(
                f"[RECONCILIACAO_BAIXA] Conta #{cid} ({emp}) baixada: R$ {apto.valor_pago:.2f} em "
                f"{apto.data_pagamento.isoformat()} (débito {itx_id}){f' por {usuario}' if usuario else ''}."
            )
            resultados.append(_resultado(item, "sucesso", f"Conta #{cid} baixada com sucesso no Tiny ERP.", apto))
            sucessos += 1
        except Exception as e:
            logger.error(f"[RECONCILIACAO_BAIXA] Falha ao baixar conta #{cid} ({emp}): {e}")
            _falha(str(e), apto)

    # As contas baixadas mudaram de situação no Tiny: atualiza o cache sem consultar tudo de novo.
    baixadas = [(r["empresa"], r["conta_pagar_id"]) for r in resultados if r["status"] == "sucesso"]
    if baixadas:
        marcar_baixadas_no_cache(baixadas)
        try:
            itens_remover = [
                {
                    "empresa": r["empresa"],
                    "conta_pagar_id": r["conta_pagar_id"],
                    "numero_documento": r.get("numero_documento"),
                    "valor_pago": r.get("valor_pago"),
                }
                for r in resultados
                if r["status"] == "sucesso"
            ]
            store_contas_pagar.remover_contas_baixadas(itens_remover, motivo="automacao")
        except Exception as e_rem:
            logger.warning(f"[CONTAS_PAGAR_ROTINA] Erro ao remover baixas do estado persistente: {e_rem}")

    return {
        "status": "concluido" if falhas == 0 else ("parcial" if sucessos > 0 else "erro"),
        "total_solicitados": len(payload.itens),
        "total_sucessos": sucessos,
        "total_falhas": falhas,
        "resultados": resultados,
    }


@router.post("/api/v1/reconciliacao/jobs/preview")
def iniciar_job_preview(payload: ReconciliacaoPreviewRequest) -> Dict[str, Any]:
    return _iniciar_job(
        "preview",
        lambda progresso: _run_preview(payload, progresso),
        sincrono=_preview_todo_em_cache(payload),
    )


@router.post("/api/v1/reconciliacao/jobs/baixar")
def iniciar_job_baixa(payload: ReconciliacaoBaixarRequest, request: Request) -> Dict[str, Any]:
    if not payload.itens:
        raise HTTPException(status_code=400, detail="Nenhum item informado para baixa.")
    usuario = usuario_da_requisicao(request)
    treino = _treino_baixa(payload)
    chaves = _reservar_baixas(payload)  # 409 se outra baixa em andamento já pegou alguma destas contas

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            return _run_baixa(payload, progresso, usuario=usuario)
        finally:
            _liberar_baixas(chaves)

    try:
        return {**_iniciar_job("baixar", executar), "treino": treino}
    except Exception:
        _liberar_baixas(chaves)
        raise


@router.get("/api/v1/reconciliacao/jobs/{job_id}")
def consultar_job(job_id: str) -> Dict[str, Any]:
    return _consultar_job(job_id, conciliacao_ml=False)
