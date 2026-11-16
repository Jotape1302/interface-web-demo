"""
Conciliação Mercado Livre × Mercado Pago × Contas a Receber do Tiny, e sincronização dos tokens do ML.

Separado de app/api.py (que monta o FastAPI, as rotinas de fundo e inclui os routers).
"""
import json
import logging
import time
import uuid
import math
import re
from datetime import date
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from app.internal_auth import usuario_da_requisicao
from app.config import settings
from app import ml_reconciliation as ml
from app.ml_reconciliation_rotina import (
    EmExecucao as MLEmExecucao,
    periodo_padrao as ml_periodo_padrao,
    resumo_execucao as ml_resumo_execucao,
    rotina as ml_rotina,
    token_tiny as ml_token_tiny,
    validar_periodo as ml_validar_periodo,
)
from app.ml_apis import (
    sincronizar_todos_tokens_ml,
    _candidatos_ml_tokens_files,
    token_esta_valido,
)
from app.routers.jobs import _Progresso, _consultar_job, _iniciar_job

logger = logging.getLogger("automacao_nfe.api")

router = APIRouter()


# =============================================================================
# CONCILIAÇÃO MERCADO LIVRE × CONTAS A RECEBER TINY ERP
# =============================================================================
# Vendas (API do Mercado Livre) × liberações (relatório do Mercado Pago) × Contas a Receber do
# Tiny. Regras em app/ml_reconciliation.py; coleta, histórico e baixa em
# app/ml_reconciliation_rotina.py. Roda sozinha 1x/dia (ML_RECONCILIATION_HOUR) e sob demanda;
# as duas tarefas usam a fila de tarefas da conciliação Inter, mas são consultadas só por
# /conciliacao-ml/jobs/{id}. A baixa é sempre confirmada pelo usuário.


class MLExecutarRequest(BaseModel):
    empresas: Optional[List[str]] = None
    de: Optional[date] = None
    ate: Optional[date] = None


class MLBaixarRequest(BaseModel):
    analise_id: str
    grupos: List[str]
    usuario: Optional[str] = None


class MLLancarTarifasRequest(BaseModel):
    empresa: str
    grupos: List[str]
    incluir_exportados: bool = False
    usuario: Optional[str] = None


def _ml_analise_ou_404(analise_id: str) -> ml.Analise:
    analise = ml_rotina.estado.analise(analise_id)
    if analise is None:
        raise HTTPException(status_code=404, detail="Análise não encontrada (removida pela retenção ou inexistente).")
    return analise


@router.get("/api/v1/conciliacao-ml/status")
def ml_status() -> Dict[str, Any]:
    return ml_rotina.status()


@router.get("/api/v1/conciliacao-ml/pendencias")
def ml_pendencias() -> Dict[str, Any]:
    """Aptos ainda não baixados e lançamentos ainda não exportados, recalculados agora."""
    return ml_rotina.pendencias()


@router.post("/api/v1/conciliacao-ml/executar")
def ml_executar(payload: MLExecutarRequest) -> Dict[str, Any]:
    """Executa agora (fora do horário diário). Sem período: as liberações de ontem."""
    if ml_rotina.em_execucao:
        raise HTTPException(status_code=409, detail="Já existe uma conciliação Mercado Livre em andamento. Aguarde terminar.")
    de, ate = payload.de, payload.ate
    if (de is None) != (ate is None):
        raise HTTPException(status_code=400, detail="Informe a data inicial e a final, ou nenhuma (ontem).")
    if de is None or ate is None:
        de, ate = ml_periodo_padrao()
    try:
        ml_validar_periodo(de, ate)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    empresas = payload.empresas or None
    if empresas and any(e not in ml.EMPRESAS_ML for e in empresas):
        raise HTTPException(status_code=400, detail="Empresa sem conciliação Mercado Livre.")

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            execucao = ml_rotina.executar("manual", empresas, de, ate, progresso=progresso)
        except MLEmExecucao as e:
            raise HTTPException(status_code=409, detail=str(e))
        return ml_resumo_execucao(execucao)

    return _iniciar_job("ml_executar", executar)


@router.get("/api/v1/conciliacao-ml/execucoes")
def ml_execucoes(limit: int = 30, tipo: str = "") -> Dict[str, Any]:
    execucoes = [e for e in reversed(ml_rotina.estado.ler()["execucoes"]) if not tipo or e.get("tipo", "analise") == tipo]
    return {"itens": [ml_resumo_execucao(e) for e in execucoes[: max(1, min(limit, 200))]], "total": len(execucoes)}


@router.get("/api/v1/conciliacao-ml/execucoes/{execucao_id}")
def ml_execucao(execucao_id: str) -> Dict[str, Any]:
    for e in ml_rotina.estado.ler()["execucoes"]:
        if e.get("id") == execucao_id:
            return e
    raise HTTPException(status_code=404, detail="Execução não encontrada.")


@router.get("/api/v1/conciliacao-ml/analises")
def ml_analises(empresa: str = "", limit: int = 30) -> Dict[str, Any]:
    todas = ml_rotina.estado.ler()["analises"]
    filtradas = [a for a in todas if not empresa or a.get("empresa") == empresa]
    consolidadas = [a for a in filtradas if a.get("analise_id", "").startswith("consolidado_")]
    normais = [a for a in reversed(filtradas) if not a.get("analise_id", "").startswith("consolidado_")]
    ordenadas = consolidadas + normais
    return {"itens": ordenadas[: max(1, min(limit, 200))], "total": len(ordenadas)}


@router.get("/api/v1/conciliacao-ml/analises/{analise_id}")
def ml_consultar_analise(analise_id: str) -> Dict[str, Any]:
    return ml.analise_json(_ml_analise_ou_404(analise_id))


def _resposta_xlsx(nome: str, conteudo: bytes, headers: Dict[str, str]) -> Response:
    return Response(
        content=conteudo,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(nome)}", **headers},
    )


@router.get("/api/v1/conciliacao-ml/analises/{analise_id}/arquivos/{tipo}")
def ml_baixar_arquivo(analise_id: str, tipo: str) -> Response:
    """Planilhas de leitura (sem efeito colateral). Os lançamentos têm rota POST própria (SEC-06)."""
    analise = _ml_analise_ou_404(analise_id)
    if tipo not in ml.TIPOS_ARQUIVO:
        raise HTTPException(status_code=404, detail=f"Arquivo '{tipo}' inexistente. Use: {', '.join(ml.TIPOS_ARQUIVO)}.")
    if tipo == "lancamentos":
        raise HTTPException(
            status_code=405,
            detail="A planilha de lançamentos registra o que foi exportado e por isso não sai por GET. "
            f"Use POST /api/v1/conciliacao-ml/analises/{analise_id}/arquivos/lancamentos/exportar.",
            headers={"Allow": "POST"},
        )
    nome, conteudo = ml.gerar_arquivo(analise, tipo)
    return _resposta_xlsx(nome, conteudo, {})


class MLExportarLancamentosRequest(BaseModel):
    incluir_exportados: bool = False


@router.post("/api/v1/conciliacao-ml/analises/{analise_id}/arquivos/lancamentos/exportar")
def ml_exportar_lancamentos(analise_id: str, payload: Optional[MLExportarLancamentosRequest] = None) -> Response:
    """
    ML-5: gera a planilha de lançamentos de caixa e REGISTRA o que saiu (efeito colateral, por isso
    POST). Lançamento já exportado fica de fora (evita importar duas vezes no Tiny);
    `incluir_exportados=true` gera tudo de novo (ex.: a importação anterior falhou).
    """
    incluir_exportados = payload.incluir_exportados if payload else False
    analise = _ml_analise_ou_404(analise_id)
    chaves = [ml.chave_lancamento(l) for l in analise.lancamentos.lancamentos]
    exportados = ml_rotina.estado.lancamentos_exportados()
    ja = [c for c in chaves if c in exportados]
    lancados_api = set(ml_rotina.estado.lancamentos_tiny())
    novos = [c for c in chaves if c not in lancados_api and (incluir_exportados or c not in exportados)]
    if not incluir_exportados and chaves and not novos:
        raise HTTPException(
            status_code=409,
            detail=f"Os {len(chaves)} lançamento(s) desta análise já foram exportados em planilha anterior. "
            "Baixe de novo só se a importação no Tiny falhou.",
        )
    # O que a baixa já lançou no caixa pela API nunca volta para a planilha (nem "gerar tudo de novo").
    lancados = set(ml_rotina.estado.lancamentos_tiny())
    excluir = lancados if incluir_exportados else set(exportados) | lancados
    headers = {"X-Lancamentos-Total": str(len(chaves)), "X-Lancamentos-Ja-Exportados": str(len(ja)),
               "X-Lancamentos-Na-Planilha": str(len(novos))}
    nome, conteudo = ml.gerar_arquivo(analise, "lancamentos", excluir_lancamentos=excluir)
    ml_rotina.estado.registrar_exportados(novos)
    return _resposta_xlsx(nome, conteudo, headers)


@router.post("/api/v1/conciliacao-ml/jobs/baixar")
def ml_iniciar_baixa(payload: MLBaixarRequest, request: Request) -> Dict[str, Any]:
    if not payload.grupos:
        raise HTTPException(status_code=400, detail="Nenhum recebimento selecionado para baixa.")
    analise = _ml_analise_ou_404(payload.analise_id)
    if ml_token_tiny(analise.empresa_id) is None:
        raise HTTPException(status_code=409, detail=f"Token do Tiny não configurado para {analise.empresa_nome}: baixa indisponível.")

    # Autor da auditoria: X-Usuario do gateway (sessão); o `usuario` do corpo só sem o header.
    usuario = usuario_da_requisicao(request, payload.usuario)

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            return ml_rotina.baixar(payload.analise_id, payload.grupos, usuario=usuario, progresso=progresso)
        except MLEmExecucao as e:
            raise HTTPException(status_code=409, detail=str(e))

    # Para o registro de treino do gateway (atividades.ts): os recebimentos que a análise mostrou
    # como aptos (a sugestão) e os escolhidos, como a tela mostrou, antes da baixa mudar a situação.
    escolhidos = set(payload.grupos)
    treino = {
        "contexto": {
            "analise_id": payload.analise_id,
            "empresa": analise.empresa_nome,
            "grupos": [ml.grupo_json(g) for g in analise.grupos if g.apto_baixa or g.id in escolhidos],
        },
        "sugestao": {"baixar": [g.id for g in analise.grupos if g.apto_baixa]},
    }
    return {**_iniciar_job("ml_baixar", executar), "treino": treino}


@router.get("/api/v1/conciliacao-ml/tarifas")
def ml_tarifas_pendentes(empresa: str, incluir_exportados: bool = False) -> Dict[str, Any]:
    """Vendas já baixadas com tarifas, envios ou extras que ainda não estão no caixa do Tiny."""
    try:
        return ml_rotina.tarifas_pendentes(empresa, incluir_exportados=incluir_exportados)
    except KeyError:
        raise HTTPException(status_code=404, detail="Empresa sem conciliação Mercado Livre.")


class MLConferirApagadosRequest(BaseModel):
    empresa: str


@router.post("/api/v1/conciliacao-ml/tarifas/conferir-apagados")
def ml_conferir_apagados(payload: MLConferirApagadosRequest) -> Dict[str, Any]:
    """Lançamentos do padrão antigo apagados no Tiny voltam para as tarifas pendentes."""
    try:
        return ml_rotina.conferir_apagados(payload.empresa)
    except KeyError:
        raise HTTPException(status_code=404, detail="Empresa sem conciliação Mercado Livre.")
    except MLEmExecucao as e:
        raise HTTPException(status_code=409, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


class MLMarcarRefeitosRequest(BaseModel):
    empresa: str
    chaves: List[str]
    usuario: Optional[str] = None


@router.post("/api/v1/conciliacao-ml/tarifas/marcar-refeitos")
def ml_marcar_refeitos(payload: MLMarcarRefeitosRequest, request: Request) -> Dict[str, Any]:
    """Lançamentos do padrão antigo refeitos à mão no Tiny: saem da lista e nunca voltam às pendentes."""
    if not payload.chaves:
        raise HTTPException(status_code=400, detail="Nenhum lançamento selecionado.")
    try:
        return ml_rotina.marcar_refeitos(payload.empresa, payload.chaves, usuario_da_requisicao(request, payload.usuario))
    except KeyError:
        raise HTTPException(status_code=404, detail="Empresa sem conciliação Mercado Livre.")
    except MLEmExecucao as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/api/v1/conciliacao-ml/jobs/lancar-tarifas")
def ml_iniciar_lancar_tarifas(payload: MLLancarTarifasRequest, request: Request) -> Dict[str, Any]:
    if not payload.grupos:
        raise HTTPException(status_code=400, detail="Nenhuma venda selecionada.")
    if payload.empresa not in ml.EMPRESAS_ML:
        raise HTTPException(status_code=404, detail="Empresa sem conciliação Mercado Livre.")
    if ml_token_tiny(payload.empresa) is None:
        raise HTTPException(status_code=409, detail="Token do Tiny não configurado: lançamento indisponível.")
    usuario = usuario_da_requisicao(request, payload.usuario)

    def executar(progresso: _Progresso) -> Dict[str, Any]:
        try:
            return ml_rotina.lancar_tarifas(
                payload.empresa, payload.grupos, incluir_exportados=payload.incluir_exportados,
                usuario=usuario, progresso=progresso,
            )
        except MLEmExecucao as e:
            raise HTTPException(status_code=409, detail=str(e))
        except KeyError:
            raise HTTPException(status_code=404, detail="Visão consolidada da empresa ainda não existe.")

    return _iniciar_job("ml_lancar_tarifas", executar)


@router.get("/api/v1/conciliacao-ml/jobs/{job_id}")
def ml_consultar_job(job_id: str) -> Dict[str, Any]:
    return _consultar_job(job_id, conciliacao_ml=True)


@router.get("/api/v1/conciliacao-ml/avisos")
def ml_avisos(depois_de: int = 0) -> Dict[str, Any]:
    """Avisos novos para o gateway notificar (permissão conciliacao_ml:ver)."""
    dados = ml_rotina.estado.ler()
    itens = [a for a in dados["avisos"] if int(a["id"]) > depois_de]
    return {"itens": itens, "ultimo_id": int(dados.get("proximo_aviso") or 1) - 1}


_ML_TOKENS_SYNC_LAST_TS: float = 0.0
_ML_TOKENS_SYNC_COOLDOWN_SEGUNDOS: float = 60.0


@router.post("/api/v1/conciliacao-ml/tokens/sincronizar")
def ml_sincronizar_tokens(request: Request) -> Any:
    """Força sincronização imediata dos tokens do Mercado Livre via TMS / OAuth."""
    global _ML_TOKENS_SYNC_LAST_TS
    agora = time.time()
    decorrido = agora - _ML_TOKENS_SYNC_LAST_TS
    if decorrido < _ML_TOKENS_SYNC_COOLDOWN_SEGUNDOS:
        restante = int(math.ceil(_ML_TOKENS_SYNC_COOLDOWN_SEGUNDOS - decorrido))
        raise HTTPException(
            status_code=429,
            detail=f"Aguarde {restante} segundos antes de solicitar uma nova sincronização de tokens.",
        )

    _ML_TOKENS_SYNC_LAST_TS = agora

    if settings.MOCK_MODE:
        return {
            "ok": True,
            "mock": True,
            "contas": {
                "norvia": {"conectado": True, "renovado": True},
                "revesta": {"conectado": True, "renovado": True},
            },
            "tokens_atualizados": ["norvia", "revesta"],
        }

    try:
        tokens_obtidos = sincronizar_todos_tokens_ml(settings, forcar=True) or {}

        # Ler dados do disco diretamente para checar validade com token_esta_valido
        # SEM chamar token_ml (que dispararia novas renovações ou trataria token vencido como válido)
        tokens_disco: Dict[str, Any] = {}
        for arq in _candidatos_ml_tokens_files(settings):
            if arq.is_file():
                try:
                    d = json.loads(arq.read_text(encoding="utf-8"))
                    if isinstance(d, dict):
                        for k, v in d.items():
                            if k not in tokens_disco and isinstance(v, dict):
                                tokens_disco[k] = v
                except Exception:
                    logger.warning("Cache de tokens do ML ilegível em %s; ignorado", arq, exc_info=True)

        resumo: Dict[str, Dict[str, Any]] = {}
        contas_esperadas = ("norvia", "revesta")
        for conta in contas_esperadas:
            dados_conta = tokens_disco.get(conta) or {}
            conectado = token_esta_valido(dados_conta)
            renovado = conta in tokens_obtidos and bool(tokens_obtidos[conta].get("access_token"))
            info_conta: Dict[str, Any] = {
                "conectado": conectado,
                "renovado": renovado,
            }
            if not renovado:
                info_conta["motivo"] = "Falha ao renovar via TMS"
            resumo[conta] = info_conta

        todas_renovadas = all(resumo[c]["renovado"] for c in contas_esperadas)
        todas_conectadas = all(resumo[c]["conectado"] for c in contas_esperadas)

        return {
            "ok": todas_renovadas and todas_conectadas,
            "contas": resumo,
            "tokens_atualizados": [c for c in contas_esperadas if resumo[c]["renovado"]],
        }
    except HTTPException:
        raise
    except Exception as e:
        req_id = request.headers.get("x-request-id") or ""
        erro_id = req_id if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", req_id) else uuid.uuid4().hex[:12]
        logger.error(f"[CONCILIACAO_ML] Erro não tratado [{erro_id}] ao sincronizar tokens: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"Erro interno ao sincronizar tokens (id {erro_id}). Consulte os logs da automação.",
                "erro_id": erro_id,
            },
        )
