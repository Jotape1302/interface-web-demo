"""
Rotina da conciliação Mercado Livre (regras em app/ml_reconciliation.py).

Todo dia às ML_RECONCILIATION_HOUR, para cada empresa (Norvia Campinas e Revesta):
1. Mercado Pago: relatório de Liberações do dia anterior (API de relatórios).
2. Mercado Livre: pedidos criados de ML_RECONCILIATION_VENDAS_DIAS antes até o fim do período,
   mais os pedidos citados no relatório que ficaram de fora (venda mais antiga).
3. Tiny: pedidos do mesmo intervalo (cliente e CPF/CNPJ de cada venda) e as contas a receber de
   cada cliente (só leitura).
4. Análise gravada em disco, com o histórico da execução (log linha a linha) e um aviso para o
   gateway notificar o Financeiro. A BAIXA NÃO É AUTOMÁTICA: o usuário confirma na tela.

Estado em DATA_DIR/conciliacao_ml/ (gravação atômica, json_store):
- `estado.json`: execuções (com log), avisos, índice das análises e o registro das baixas já
  feitas (chave do movimento -> data), que impede baixar duas vezes a mesma liberação quando o
  período é reprocessado.
- `analises/<id>.json`: análise completa (sobrevive a restart; antes ficava em memória).
"""
from __future__ import annotations

import copy
import dataclasses
import json
import logging
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from app import ml_reconciliation as ml
from app.config import Settings, settings
from app.json_store import erro_gravacao, save_json_state, write_json_atomic
from app.ml_apis import (
    ClienteMercadoLivre,
    ClienteMercadoPago,
    SemCredencial,
    token_ml,
    token_mp,
)
from app.tiny_client import TinyClient
from app.token_repository import TokenRepository

logger = logging.getLogger("automacao_nfe.conciliacao_ml")

MAX_EXECUCOES = 120
MAX_AVISOS = 300
MAX_LINHAS_LOG = 1500
MAX_DIAS_PERIODO = 60  # limite do relatório de liberações do Mercado Pago
MAX_PEDIDOS_AVULSOS_ML = 300
MAX_PEDIDOS_AVULSOS_TINY = 150
DIAS_REGISTRO_BAIXAS = 400
PAGINAS_CONTAS_CLIENTE = 50  # 5.000 contas por cliente (antes eram 5 páginas)

Progresso = Callable[[str, int, int], None]


def agora() -> str:
    # Com o fuso (-03:00): sem ele o frontend lê o horário como UTC e mostra 3 h a menos.
    return datetime.now().astimezone().isoformat(timespec="seconds")


def proxima_execucao(cfg: Optional[Settings] = None, agora_dt: Optional[datetime] = None) -> datetime:
    cfg = cfg or settings
    agora_dt = agora_dt or datetime.now()
    alvo = agora_dt.replace(hour=cfg.ML_RECONCILIATION_HOUR, minute=0, second=0, microsecond=0)
    return alvo if alvo > agora_dt else alvo + timedelta(days=1)


def periodo_padrao(hoje: Optional[date] = None, dias: int = 60) -> Tuple[date, date]:
    """Janela móvel de 60 dias (D-60 a D-1)."""
    hoje_dt = hoje or date.today()
    ontem = hoje_dt - timedelta(days=1)
    inicio = hoje_dt - timedelta(days=dias)
    return inicio, ontem


def _id_grupo_consolidado(id_venda: str, operacao: str) -> str:
    limpo = lambda v: "".join(c for c in str(v or "") if c.isalnum() or c == "-") or "x"
    return f"C-{limpo(id_venda)}-{limpo(operacao)}"


def fatiar_periodo(de: date, ate: date, max_dias_fatia: int = 15) -> List[Tuple[date, date]]:
    """Divide o intervalo de busca em fatias de até max_dias_fatia para não estourar o limite de 2.000 pedidos por busca."""
    if de > ate:
        return []
    fatias = []
    atual = de
    while atual <= ate:
        fim = min(atual + timedelta(days=max_dias_fatia - 1), ate)
        fatias.append((atual, fim))
        atual = fim + timedelta(days=1)
    return fatias


def validar_periodo(de: date, ate: date, hoje: Optional[date] = None) -> None:
    hoje = hoje or date.today()
    if de > ate:
        raise ValueError("A data inicial é depois da data final.")
    if ate > hoje:
        raise ValueError("O período não pode terminar depois de hoje.")
    if (ate - de).days + 1 > MAX_DIAS_PERIODO:
        raise ValueError(f"O período máximo é de {MAX_DIAS_PERIODO} dias (limite do relatório do Mercado Pago).")


# ─────────────────────────────────────────────────────────────────────────────
# Log da execução
# ─────────────────────────────────────────────────────────────────────────────


class LogExecucao:
    """Linhas do log da execução (vão para o histórico na tela) e para o log do serviço."""

    def __init__(self) -> None:
        self.linhas: List[Dict[str, str]] = []
        self.empresa = ""

    def _add(self, nivel: str, mensagem: str) -> None:
        prefixo = f"[CONCILIACAO_ML]{f' [{self.empresa}]' if self.empresa else ''}"
        getattr(logger, {"info": "info", "aviso": "warning", "erro": "error"}[nivel])(f"{prefixo} {mensagem}")
        if len(self.linhas) < MAX_LINHAS_LOG:
            self.linhas.append({"em": agora(), "nivel": nivel, "empresa": self.empresa, "mensagem": mensagem})
        elif len(self.linhas) == MAX_LINHAS_LOG:
            self.linhas.append({"em": agora(), "nivel": "aviso", "empresa": "", "mensagem": "Log truncado."})

    def info(self, mensagem: str) -> None:
        self._add("info", mensagem)

    def aviso(self, mensagem: str) -> None:
        self._add("aviso", mensagem)

    def erro(self, mensagem: str) -> None:
        self._add("erro", mensagem)


# ─────────────────────────────────────────────────────────────────────────────
# Estado em disco
# ─────────────────────────────────────────────────────────────────────────────


def _vazio() -> Dict[str, Any]:
    return {"execucoes": [], "avisos": [], "proximo_aviso": 1, "analises": [], "baixas": {}, "baixas_pendentes": {},
            "lancamentos_exportados": {}}


class EstadoML:
    def __init__(self, pasta: Optional[Path] = None, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or settings
        self._pasta = Path(pasta) if pasta else None
        self._lock = threading.RLock()
        self._dados: Optional[Dict[str, Any]] = None

    @property
    def pasta(self) -> Path:
        return self._pasta or (Path(self.cfg.DATA_DIR) / "conciliacao_ml")

    @property
    def arquivo(self) -> Path:
        return self.pasta / "estado.json"

    def _arquivo_analise(self, analise_id: str) -> Path:
        if not all(c.isalnum() or c in ("-", "_") for c in analise_id):
            raise KeyError(analise_id)
        return self.pasta / "analises" / f"{analise_id}.json"

    def ler(self) -> Dict[str, Any]:
        with self._lock:
            if self._dados is None:
                dados = _vazio()
                if self.arquivo.exists():
                    try:
                        dados.update(json.loads(self.arquivo.read_text(encoding="utf-8")))
                    except Exception as e:
                        # Não sobrescreve um arquivo ilegível: tem o registro das baixas feitas.
                        raise RuntimeError(f"Estado ilegível em {self.arquivo}: {e}") from e
                self._dados = dados
            return self._dados

    @contextmanager
    def alterar(self) -> Iterator[Dict[str, Any]]:
        """Leitura+escrita sobre uma cópia; em memória só vale se gravou (ou registra a falha)."""
        with self._lock:
            dados = copy.deepcopy(self.ler())
            yield dados
            self._dados = dados
            save_json_state(self.arquivo, dados, "CONCILIACAO_ML")

    def erro_gravacao(self) -> Optional[str]:
        return erro_gravacao(self.arquivo)

    # --- análises -------------------------------------------------------------------------

    def salvar_analise(self, analise: ml.Analise) -> None:
        write_json_atomic(self._arquivo_analise(analise.id), ml.analise_para_dict(analise), indent=None)
        cabecalho = ml.analise_resumo_json(analise)
        with self.alterar() as dados:
            todas = [a for a in dados["analises"] if a["analise_id"] != analise.id] + [cabecalho]
            consolidadas = [a for a in todas if a.get("analise_id", "").startswith("consolidado_")]
            normais = [a for a in todas if not a.get("analise_id", "").startswith("consolidado_")]
            excedentes = normais[: -self.cfg.ML_RECONCILIATION_MAX_ANALISES]
            dados["analises"] = consolidadas + normais[-self.cfg.ML_RECONCILIATION_MAX_ANALISES:]
        for antiga in excedentes:
            try:
                self._arquivo_analise(antiga["analise_id"]).unlink(missing_ok=True)
            except OSError as e:
                logger.warning(f"[CONCILIACAO_ML] Não removeu a análise antiga {antiga['analise_id']}: {e}")

    def analise(self, analise_id: str) -> Optional[ml.Analise]:
        try:
            caminho = self._arquivo_analise(analise_id)
        except KeyError:
            return None
        if not caminho.exists():
            return None
        return ml.analise_de_dict(json.loads(caminho.read_text(encoding="utf-8")))

    # --- listas com limite ------------------------------------------------------------------

    @staticmethod
    def registrar_aviso(dados: Dict[str, Any], tipo: str, titulo: str, mensagem: str) -> None:
        aviso_id = int(dados.get("proximo_aviso") or 1)
        dados["avisos"].append({"id": aviso_id, "tipo": tipo, "titulo": titulo, "mensagem": mensagem, "criado_em": agora()})
        dados["proximo_aviso"] = aviso_id + 1
        del dados["avisos"][:-MAX_AVISOS]

    @staticmethod
    def registrar_execucao(dados: Dict[str, Any], execucao: Dict[str, Any]) -> None:
        dados["execucoes"].append(execucao)
        del dados["execucoes"][:-MAX_EXECUCOES]

    def lancamentos_exportados(self) -> Dict[str, str]:
        return dict(self.ler().get("lancamentos_exportados") or {})

    def registrar_exportados(self, chaves: List[str]) -> None:
        """Lançamentos de caixa que saíram numa planilha para importação no Tiny (ML-5)."""
        hoje = date.today()
        limite = (hoje - timedelta(days=DIAS_REGISTRO_BAIXAS)).isoformat()
        with self.alterar() as dados:
            exportados = {k: v for k, v in (dados.get("lancamentos_exportados") or {}).items() if v >= limite}
            for chave in chaves:
                if chave and chave not in exportados:
                    exportados[chave] = hoje.isoformat()
            dados["lancamentos_exportados"] = exportados

    @staticmethod
    def registrar_baixas(dados: Dict[str, Any], chaves: List[str]) -> None:
        hoje = date.today()
        for chave in chaves:
            dados["baixas"][chave] = hoje.isoformat()
        limite = (hoje - timedelta(days=DIAS_REGISTRO_BAIXAS)).isoformat()
        dados["baixas"] = {k: v for k, v in dados["baixas"].items() if v >= limite}


# ─────────────────────────────────────────────────────────────────────────────
# Credenciais e cadastros do Tiny
# ─────────────────────────────────────────────────────────────────────────────


def token_tiny(empresa_id: str, cfg: Optional[Settings] = None) -> Optional[str]:
    """Token do Tiny da empresa (api_tokens); sem banco, o TINY_API_TOKEN do .env."""
    cfg = cfg or settings
    token: Optional[str] = None
    repo = TokenRepository(cfg)
    if repo.is_configured():
        res = repo.get_token_by_cnpj_or_account(account_id=empresa_id)
        if res:
            token = res[0]
    token = token or cfg.TINY_API_TOKEN
    if not token or token in ("mock", "seu_token_aqui"):
        return None
    return token


def conexoes(empresa: ml.EmpresaML, cfg: Optional[Settings] = None) -> Dict[str, bool]:
    cfg = cfg or settings
    return {
        "mercado_pago": token_mp(empresa.id, empresa.conta_ml, cfg, permitir_fallback_ml=False) is not None,
        "mercado_livre": token_ml(empresa.conta_ml, cfg) is not None,
        "tiny": token_tiny(empresa.id, cfg) is not None,
    }


def _descricao(item: Dict[str, Any]) -> str:
    return str(item.get("descricao") or item.get("nome") or "")


class ResolvedorTiny:
    """
    Conta financeira e categoria do recebimento no Tiny: IDs fixos (EmpresaML ou .env) ou pelo
    nome, via API. Só aceita um resultado único — nunca baixa numa conta "parecida".
    """

    def __init__(self, tiny: TinyClient, obter_token: Callable[[str], Optional[str]], cfg: Optional[Settings] = None) -> None:
        self.tiny = tiny
        self.obter_token = obter_token
        self.cfg = cfg or settings
        self._cache: Dict[str, Tuple[int, int]] = {}

    def _fixos(self, empresa: ml.EmpresaML) -> Tuple[Optional[int], Optional[int]]:
        if empresa.id == "revesta":
            return (
                self.cfg.ML_REVESTA_CONTA_DESTINO_ID or empresa.conta_destino_id,
                self.cfg.ML_REVESTA_CATEGORIA_RECEBIMENTO_ID or empresa.categoria_recebimento_id,
            )
        return empresa.conta_destino_id, empresa.categoria_recebimento_id

    def ids(self, empresa: ml.EmpresaML) -> Tuple[int, int]:
        if empresa.id in self._cache:
            return self._cache[empresa.id]
        conta_id, categoria_id = self._fixos(empresa)
        token = self.obter_token(empresa.id)
        if (conta_id is None or categoria_id is None) and not token:
            raise RuntimeError(f"Sem token do Tiny para localizar a conta e a categoria de {empresa.nome}.")

        if conta_id is None:
            alvo = ml._normalizar_nome(empresa.conta_lancamento)
            contas = [c for c in self.tiny.obter_contas_financeiras_v3(token) if ml._normalizar_nome(_descricao(c)) == alvo]
            if len(contas) != 1:
                raise RuntimeError(
                    f"{'Mais de uma' if contas else 'Nenhuma'} conta financeira '{empresa.conta_lancamento}' no Tiny de "
                    f"{empresa.nome}. Ajuste o nome no Tiny ou fixe ML_REVESTA_CONTA_DESTINO_ID."
                )
            conta_id = int(contas[0]["id"])

        if categoria_id is None:
            ref = ml.EMPRESAS_ML.get(empresa.categoria_igual_a or "")
            if ref is None or ref.categoria_recebimento_id is None:
                raise RuntimeError(f"Categoria de recebimento de {empresa.nome} sem referência configurada.")
            token_ref = self.obter_token(ref.id)
            if not token_ref:
                raise RuntimeError(f"Sem token do Tiny de {ref.nome} para ler o nome da categoria de recebimento.")
            nome = next(
                (_descricao(c) for c in self.tiny.list_categorias_receita_despesa_v3(token_ref)
                 if str(c.get("id")) == str(ref.categoria_recebimento_id)),
                "",
            )
            if not nome:
                raise RuntimeError(f"Categoria #{ref.categoria_recebimento_id} não encontrada no Tiny de {ref.nome}.")
            alvo = ml._normalizar_nome(nome)
            cats = [c for c in self.tiny.list_categorias_receita_despesa_v3(token) if ml._normalizar_nome(_descricao(c)) == alvo]
            if len(cats) != 1:
                raise RuntimeError(
                    f"{'Mais de uma' if cats else 'Nenhuma'} categoria '{nome}' no Tiny de {empresa.nome}. "
                    "Ajuste o nome no Tiny ou fixe ML_REVESTA_CATEGORIA_RECEBIMENTO_ID."
                )
            categoria_id = int(cats[0]["id"])

        self._cache[empresa.id] = (conta_id, categoria_id)
        return conta_id, categoria_id

    def categoria_frete_id(self, empresa: ml.EmpresaML) -> int:
        if empresa.id == "revesta":
            cat_fixa = self.cfg.ML_REVESTA_CATEGORIA_FRETE_ID or empresa.categoria_frete_id
            if cat_fixa:
                return int(cat_fixa)
            token = self.obter_token(empresa.id)
            if token:
                try:
                    cats = [
                        c for c in self.tiny.list_categorias_receita_despesa_v3(token)
                        if ml._normalizar_nome(_descricao(c)) in ("receita de fretes", "fretes sobre vendas")
                    ]
                    if cats:
                        return int(cats[0]["id"])
                except Exception as e:
                    logger.warning(f"Não foi possível buscar categoria de frete no Tiny de {empresa.nome}: {e}")
            raise RuntimeError(
                f"Nenhuma categoria de frete configurada para {empresa.nome}. "
                "Ajuste no Tiny ou configure ML_REVESTA_CATEGORIA_FRETE_ID."
            )
        # Norvia Campinas (ou default)
        cat_fixa = self.cfg.ML_CATEGORIA_FRETE_ID or empresa.categoria_frete_id
        if cat_fixa:
            return int(cat_fixa)
        token = self.obter_token(empresa.id)
        if token:
            try:
                cats = [
                    c for c in self.tiny.list_categorias_receita_despesa_v3(token)
                    if ml._normalizar_nome(_descricao(c)) in ("receita de fretes", "fretes sobre vendas")
                ]
                if cats:
                    return int(cats[0]["id"])
            except Exception as e:
                logger.warning(f"Não foi possível buscar categoria 'Receita de Fretes' no Tiny de {empresa.nome}: {e}")
        return 489820971


# ─────────────────────────────────────────────────────────────────────────────
# Rotina
# ─────────────────────────────────────────────────────────────────────────────


class EmExecucao(RuntimeError):
    pass


class RotinaConciliacaoML:
    def __init__(
        self,
        estado: Optional[EstadoML] = None,
        cfg: Optional[Settings] = None,
        tiny: Optional[TinyClient] = None,
        fabrica_mp: Optional[Callable[[ml.EmpresaML], ClienteMercadoPago]] = None,
        fabrica_ml: Optional[Callable[[ml.EmpresaML], ClienteMercadoLivre]] = None,
        obter_token_tiny: Optional[Callable[[str], Optional[str]]] = None,
    ) -> None:
        self.cfg = cfg or settings
        self.estado = estado or EstadoML(cfg=self.cfg)
        self._tiny = tiny
        self.obter_token_tiny = obter_token_tiny or (lambda emp_id: token_tiny(emp_id, self.cfg))
        self.fabrica_mp = fabrica_mp or (
            lambda e: ClienteMercadoPago(e.id, lambda: token_mp(e.id, e.conta_ml, self.cfg, permitir_fallback_ml=False), cfg=self.cfg)
        )
        self.fabrica_ml = fabrica_ml or (
            lambda e: ClienteMercadoLivre(e.conta_ml, lambda: token_ml(e.conta_ml, self.cfg), cfg=self.cfg)
        )
        self._executando = threading.Lock()
        self._resolvedor: Optional[ResolvedorTiny] = None
        self.em_execucao: Optional[Dict[str, Any]] = None
        self.progresso: Optional[Dict[str, Any]] = None
        self._baixas_em_andamento: set = set()
        self._baixas_lock = threading.Lock()

    @property
    def tiny(self) -> TinyClient:
        if self._tiny is None:
            self._tiny = TinyClient()
        return self._tiny

    @property
    def resolvedor(self) -> ResolvedorTiny:
        if self._resolvedor is None:
            self._resolvedor = ResolvedorTiny(self.tiny, self.obter_token_tiny, self.cfg)
        return self._resolvedor

    # --- execução (análise) -----------------------------------------------------------------

    def executar(
        self,
        origem: str = "agendada",
        empresas: Optional[List[str]] = None,
        de: Optional[date] = None,
        ate: Optional[date] = None,
        progresso: Optional[Progresso] = None,
    ) -> Dict[str, Any]:
        if de is None or ate is None:
            de, ate = periodo_padrao()
        validar_periodo(de, ate)
        ids = empresas or list(ml.EMPRESAS_ML)
        desconhecidas = [e for e in ids if e not in ml.EMPRESAS_ML]
        if desconhecidas:
            raise ValueError(f"Empresa(s) sem conciliação Mercado Livre: {', '.join(desconhecidas)}.")
        if not self._executando.acquire(blocking=False):
            raise EmExecucao("Já existe uma conciliação Mercado Livre em andamento.")

        execucao_id = uuid.uuid4().hex[:12]
        inicio = agora()
        log = LogExecucao()
        self.em_execucao = {"execucao_id": execucao_id, "iniciada_em": inicio, "origem": origem}
        resultado_empresas: Dict[str, Dict[str, Any]] = {}

        def avancar(etapa: str, atual: int, total: int) -> None:
            self.progresso = {"etapa": etapa, "atual": atual, "total": total, "empresa": log.empresa}
            if progresso:
                progresso(f"{log.empresa}: {etapa}" if log.empresa else etapa, atual, total)

        try:
            log.info(
                f"Execução {origem} iniciada: liberações de {de:%d/%m/%Y} a {ate:%d/%m/%Y}, "
                f"empresas: {', '.join(ml.EMPRESAS_ML[e].nome for e in ids)}."
            )
            for emp_id in ids:
                empresa = ml.EMPRESAS_ML[emp_id]
                log.empresa = empresa.nome
                try:
                    resultado_empresas[emp_id] = self._executar_empresa(empresa, de, ate, origem, execucao_id, log, avancar)
                except SemCredencial as e:
                    log.erro(f"Sem credencial: {e}")
                    resultado_empresas[emp_id] = {"status": "sem_credencial", "mensagem": str(e)}
                except Exception as e:  # uma empresa com problema não impede a outra
                    logger.error(f"[CONCILIACAO_ML] Falha em {empresa.nome}: {e}", exc_info=True)
                    log.erro(f"Falha: {e}")
                    resultado_empresas[emp_id] = {"status": "erro", "mensagem": str(e)}
            log.empresa = ""
            oks = [r for r in resultado_empresas.values() if r["status"] == "ok"]
            status = "ok" if len(oks) == len(resultado_empresas) else ("parcial" if oks else "erro")
            log.info(f"Execução concluída ({status}).")
        finally:
            self.em_execucao = None
            self.progresso = None
            self._executando.release()

        execucao = {
            "id": execucao_id,
            "tipo": "analise",
            "origem": origem,
            "iniciada_em": inicio,
            "concluida_em": agora(),
            "status": status,
            "periodo_de": de.isoformat(),
            "periodo_ate": ate.isoformat(),
            "empresas": resultado_empresas,
            "log": log.linhas,
        }
        with self.estado.alterar() as dados:
            self.estado.registrar_execucao(dados, execucao)
            self._avisar(dados, execucao)
        return execucao

    def _avisar(self, dados: Dict[str, Any], execucao: Dict[str, Any]) -> None:
        periodo = _texto_periodo(execucao["periodo_de"], execucao["periodo_ate"])
        falhas = [
            f"{ml.EMPRESAS_ML[e].nome}: {r.get('mensagem')}"
            for e, r in execucao["empresas"].items()
            if r["status"] != "ok"
        ]
        if falhas:
            self.estado.registrar_aviso(
                dados, "conciliacao_ml_erro", f"Falha na conciliação Mercado Livre ({periodo})", "; ".join(falhas)[:500]
            )
        partes = []
        for e, r in execucao["empresas"].items():
            if r["status"] != "ok":
                continue
            res = r.get("resumo") or {}
            if res.get("aptos_baixa") or res.get("total_pendencias"):
                partes.append(
                    f"{ml.EMPRESAS_ML[e].nome}: {res.get('aptos_baixa', 0)} apto(s) para baixa"
                    f" (R$ {res.get('valor_aptos_baixa') or 0:,.2f}), {res.get('total_pendencias', 0)} para conferir"
                    .replace(",", "X").replace(".", ",").replace("X", ".")
                )
        if partes:
            self.estado.registrar_aviso(
                dados, "conciliacao_ml_pronta", f"Conciliação Mercado Livre pronta ({periodo})", "; ".join(partes)[:500]
            )

    def _executar_empresa(
        self,
        empresa: ml.EmpresaML,
        de: date,
        ate: date,
        origem: str,
        execucao_id: str,
        log: LogExecucao,
        avancar: Progresso,
    ) -> Dict[str, Any]:
        avisos: List[str] = []
        token = self.obter_token_tiny(empresa.id)
        if not token:
            log.aviso("Sem token do Tiny: a análise sai sem cliente, sem conta a receber e sem baixa.")

        # 1. Recebimentos (Mercado Pago)
        avancar("Pedindo o relatório de liberações ao Mercado Pago", 0, 0)
        liberacoes = self.fabrica_mp(empresa).liberacoes(de, ate, progresso=lambda etapa: avancar(etapa, 0, 0))
        log.info(f"Mercado Pago: {len(liberacoes)} linha(s) no relatório de liberações.")

        # 2. Vendas (Mercado Livre)
        vendas_de = de - timedelta(days=self.cfg.ML_RECONCILIATION_VENDAS_DIAS)
        pedidos_ml: List[Dict[str, Any]] = []
        cliente_ml = self.fabrica_ml(empresa)
        try:
            pedidos_ml = cliente_ml.pedidos(vendas_de, ate, progresso=lambda etapa: avancar(etapa, 0, 0))
            log.info(f"Mercado Livre: {len(pedidos_ml)} pedido(s) de {vendas_de:%d/%m/%Y} a {ate:%d/%m/%Y}.")
            movs = ml.expandir_liberacoes(liberacoes)
            faltando = ml.pedidos_a_buscar(movs, pedidos_ml)
            if faltando:
                if len(faltando) > MAX_PEDIDOS_AVULSOS_ML:
                    log.aviso(f"{len(faltando)} pedidos fora do período: buscando só os {MAX_PEDIDOS_AVULSOS_ML} primeiros.")
                avulsos = 0
                for i, pid in enumerate(faltando[:MAX_PEDIDOS_AVULSOS_ML]):
                    avancar("Buscando vendas mais antigas no Mercado Livre", i, min(len(faltando), MAX_PEDIDOS_AVULSOS_ML))
                    pedido = cliente_ml.pedido(pid)
                    if pedido:
                        pedidos_ml.append(pedido)
                        avulsos += 1
                log.info(f"Mercado Livre: {avulsos} venda(s) anterior(es) ao período buscada(s) pelo pedido do relatório.")
        except SemCredencial as e:
            aviso = f"Vendas do Mercado Livre não lidas ({e}): a venda sai só pelo pedido informado no relatório do Mercado Pago."
            log.aviso(aviso)
            avisos.append(aviso)

        # 3. Clientes (pedidos do Tiny)
        pedidos_tiny: List[Dict[str, Any]] = []
        if token:
            pedidos_map: Dict[Any, Dict[str, Any]] = {}
            fatias = fatiar_periodo(vendas_de, ate, max_dias_fatia=15)
            for f_de, f_ate in fatias:
                avancar(f"Lendo os pedidos do Tiny ({f_de:%d/%m} a {f_ate:%d/%m})", 0, 0)
                fatia_pedidos = self.tiny.list_pedidos_v3(token, data_inicial=f_de.isoformat(), data_final=f_ate.isoformat())
                for p in fatia_pedidos:
                    pid = p.get("id") or p.get("numeroPedidoEcommerce") or p.get("numero")
                    if pid:
                        pedidos_map[pid] = p
                    else:
                        pedidos_map[id(p)] = p
            pedidos_tiny = list(pedidos_map.values())
            log.info(f"Tiny: {len(pedidos_tiny)} pedido(s) de venda no mesmo intervalo ({len(fatias)} fatia(s)).")
            pedidos_tiny += self._pedidos_tiny_avulsos(token, liberacoes, pedidos_ml, pedidos_tiny, log, avancar)

            try:
                self.resolvedor.ids(empresa)
            except Exception as e:
                aviso = f"Baixa indisponível: {e}"
                log.aviso(aviso)
                avisos.append(aviso)

        def listar_contas(nome: str) -> List[Dict[str, Any]]:
            contas = self.tiny.list_contas_receber_v3(
                token, nome_cliente=nome, max_pages=PAGINAS_CONTAS_CLIENTE, estrito=True
            )
            if len(contas) >= PAGINAS_CONTAS_CLIENTE * 100:
                log.aviso(f"Cliente '{nome}' com {len(contas)}+ contas a receber: a lista pode estar incompleta.")
            return contas

        baixas_feitas = dict(self.estado.ler().get("baixas") or {})
        exportados = self.estado.lancamentos_exportados()
        analise = ml.analisar(
            uuid.uuid4().hex,
            empresa,
            liberacoes,
            pedidos_ml,
            pedidos_tiny,
            listar_contas if token else None,
            (de, ate),
            origem=origem,
            execucao_id=execucao_id,
            baixas_feitas=baixas_feitas,
            exportados=exportados,
            progresso=avancar,
            avisos=avisos,
        )
        self.estado.salvar_analise(analise)
        self._atualizar_visao_consolidada(empresa, analise, token=token, log=log)
        res = ml.resumo(analise)
        casam = res["pagamentos_por_casamento"]
        log.info(
            f"Vendas × recebimentos: {res['pagamentos']} pagamento(s); {casam.get(ml.CASOU_PAGAMENTO, 0)} pelo ID do pagamento, "
            f"{casam.get(ml.CASOU_PEDIDO, 0)} pelo pedido do relatório, {casam.get(ml.CASOU_NENHUM, 0)} sem venda."
        )
        for situacao, qtd in sorted(res["grupos_por_situacao"].items()):
            log.info(f"Recebimentos {situacao}: {qtd}.")
        log.info(
            f"{res['aptos_baixa']} apto(s) para baixa; {res['total_lancamentos']} lançamento(s) de caixa; "
            f"{res['total_pendencias']} pendência(s); {res['total_anuladas']} movimento(s) anulado(s)."
        )
        return {"status": "ok", "analise_id": analise.id, "resumo": res, "mensagem": ""}

    def _atualizar_visao_consolidada(
        self,
        empresa: ml.EmpresaML,
        analise_recente: ml.Analise,
        token: Optional[str] = None,
        log: Optional[LogExecucao] = None,
    ) -> ml.Analise:
        """
        Mantém a visão consolidada de pendências dos últimos 60 dias da empresa (ID 'consolidado_{empresa.id}').
        Une os grupos das análises da janela ativa, confere baixas externas no Tiny e persiste no disco.
        """
        cid = f"consolidado_{empresa.id}"
        existente = self.estado.analise(cid)

        # Se houver token do Tiny, relê contas em aberto na análise consolidada anterior
        # para remover/marcar contas liquidadas externamente no Tiny
        baixas_externas: List[str] = []
        if existente and token:
            for g in existente.grupos:
                if g.situacao not in (ml.SIT_CONCILIADO, ml.SIT_ANULADA) and g.conta_id:
                    try:
                        c_data = self.tiny.obter_conta_receber_v3(token, int(g.conta_id))
                        situacao_c = ml._situacao_conta(c_data)
                        # Saldo ausente no retorno não é saldo zero: marcar como baixada gravaria a
                        # venda no registro de baixas e ela nunca mais seria baixada.
                        saldo_bruto = c_data.get("saldo")
                        saldo_zerado = saldo_bruto not in (None, "") and ml.para_decimal(saldo_bruto) <= Decimal("0")
                        if not situacao_c:
                            continue
                        if situacao_c not in ml.SITUACOES_TINY_BAIXAVEIS or saldo_zerado:
                            g.situacao = ml.SIT_CONCILIADO
                            g.mensagem = "Baixado externamente no Tiny."
                            g.conta_situacao = situacao_c
                            g.conta_saldo = Decimal("0")
                            g.baixado_em = agora()[:10]
                            baixas_externas.extend(g.chaves)
                            if log:
                                log.info(f"Venda {g.id_venda} (conta #{g.conta_id}): baixa externa detectada no Tiny.")
                    except Exception as e:
                        logger.warning(f"Não foi possível conferir baixa externa da conta #{g.conta_id}: {e}")

        # Mesclagem de grupos indexada estavelmente por (id_venda, id_operacao or id)
        grupos_map: Dict[Tuple[str, str], ml.GrupoRecebimento] = {}
        if existente:
            for g in existente.grupos:
                chave_g = (g.id_venda, g.id_operacao or g.id)
                grupos_map[chave_g] = g

        # A análise recente (que cobre a janela de 60 dias) atualiza/sobrepõe os grupos
        for g in analise_recente.grupos:
            chave_g = (g.id_venda, g.id_operacao or g.id)
            if g.conta_situacao and g.conta_situacao not in ml.SITUACOES_TINY_BAIXAVEIS and g.conta_id:
                g.situacao = ml.SIT_CONCILIADO
                g.mensagem = "Baixado externamente no Tiny."
                g.baixado_em = agora()[:10]
                baixas_externas.extend(g.chaves)
            grupos_map[chave_g] = g

        if baixas_externas:
            with self.estado.alterar() as dados:
                self.estado.registrar_baixas(dados, baixas_externas)

        # Ids únicos e estáveis: "G-{índice}" só é único dentro de uma análise, e a baixa localiza o
        # grupo pelo id — com grupos de análises diferentes, marcar uma venda baixaria outra.
        grupos_consolidados = [
            dataclasses.replace(g, id=_id_grupo_consolidado(g.id_venda, g.id_operacao or g.id))
            for g in grupos_map.values()
        ]

        # Análise consolidada final
        analise_consolidada = ml.Analise(
            id=cid,
            empresa_id=empresa.id,
            empresa_nome=empresa.nome,
            conta_lancamento=empresa.conta_lancamento,
            criada_em=agora(),
            periodo_de=analise_recente.periodo_de,
            periodo_ate=analise_recente.periodo_ate,
            origem="agendada",
            execucao_id=analise_recente.execucao_id,
            movimentos=analise_recente.movimentos,
            grupos=grupos_consolidados,
            lancamentos=analise_recente.lancamentos,
            comparativo=analise_recente.comparativo,
            fontes=analise_recente.fontes,
            tiny_consultado=analise_recente.tiny_consultado,
            avisos=analise_recente.avisos,
        )

        self.estado.salvar_analise(analise_consolidada)
        if log:
            res_c = ml.resumo(analise_consolidada)
            log.info(
                f"Visão consolidada de 60 dias atualizada para {empresa.nome}: "
                f"{res_c['total_grupos']} grupos ({res_c['aptos_baixa']} aptos para baixa, "
                f"{res_c['conciliados']} conciliados)."
            )
        return analise_consolidada

    def _pedidos_tiny_avulsos(
        self,
        token: str,
        liberacoes: List[Dict[str, Any]],
        pedidos_ml: List[Dict[str, Any]],
        pedidos_tiny: List[Dict[str, Any]],
        log: LogExecucao,
        avancar: Progresso,
    ) -> List[Dict[str, Any]]:
        """Vendas sem pedido do Tiny no intervalo (pedido antigo): busca uma a uma pelo número."""
        movs = ml.expandir_liberacoes(liberacoes)
        ml.cruzar_vendas(movs, pedidos_ml, pedidos_tiny)
        faltando = list(dict.fromkeys(
            m.id_venda for m in movs if m.tipo_operacao in ml.TIPOS_RECEBIMENTO and m.id_venda and not m.nome_cliente
        ))
        if not faltando:
            return []
        if len(faltando) > MAX_PEDIDOS_AVULSOS_TINY:
            log.aviso(f"{len(faltando)} vendas sem pedido no Tiny: buscando só as {MAX_PEDIDOS_AVULSOS_TINY} primeiras.")
        achados: List[Dict[str, Any]] = []
        for i, numero in enumerate(faltando[:MAX_PEDIDOS_AVULSOS_TINY]):
            avancar("Buscando pedidos antigos no Tiny", i, min(len(faltando), MAX_PEDIDOS_AVULSOS_TINY))
            try:
                achados += self.tiny.list_pedidos_v3(token, numero_pedido_ecommerce=numero, max_pages=1)
            except Exception as e:
                log.aviso(f"Tiny: falha ao buscar o pedido {numero}: {e}")
        log.info(f"Tiny: {len(achados)} pedido(s) avulso(s) encontrados para {len(faltando)} venda(s) sem cliente.")
        return achados

    # --- baixa --------------------------------------------------------------------------------

    def baixar(self, analise_id: str, grupo_ids: List[str], usuario: str = "", progresso: Optional[Progresso] = None) -> Dict[str, Any]:
        """
        Baixa no Tiny os recebimentos confirmados pelo usuário. Antes de cada baixa relê a conta:
        se deixou de estar em aberto, ou o valor passou do saldo, não baixa. Depois relê de novo
        para gravar valor pago e saldo. Cada baixa feita entra no registro de baixas na hora.
        """
        analise = self.estado.analise(analise_id)
        if analise is None:
            raise KeyError(analise_id)
        empresa = ml.EMPRESAS_ML[analise.empresa_id]
        token = self.obter_token_tiny(empresa.id)
        if not token:
            raise RuntimeError(f"Token do Tiny não configurado para {empresa.nome}: nenhuma conta foi baixada.")
        # Trava por empresa (ML-3): duas análises de períodos que se sobrepõem têm as mesmas
        # vendas — baixar as duas ao mesmo tempo podia baixar a mesma conta duas vezes.
        with self._baixas_lock:
            if empresa.id in self._baixas_em_andamento:
                raise EmExecucao(f"Já existe uma baixa em andamento para {empresa.nome}. Aguarde terminar.")
            self._baixas_em_andamento.add(empresa.id)

        log = LogExecucao()
        log.empresa = empresa.nome
        inicio = agora()
        execucao_id = uuid.uuid4().hex[:12]
        resultados: List[Dict[str, Any]] = []
        sucessos = falhas = ignorados = 0
        try:
            conta_destino_id, categoria_id = self.resolvedor.ids(empresa)
            categoria_frete_id = self.resolvedor.categoria_frete_id(empresa)
            log.info(
                f"Baixa de {len(grupo_ids)} recebimento(s) da análise {analise_id[:8]}"
                f"{f' por {usuario}' if usuario else ''} (conta #{conta_destino_id}, categoria #{categoria_id}, frete #{categoria_frete_id})."
            )
            por_id = {g.id: g for g in analise.grupos}
            for n, gid in enumerate(dict.fromkeys(grupo_ids)):
                grupo = por_id.get(gid)
                base: Dict[str, Any] = {"grupo_id": gid}
                if grupo is None:
                    resultados.append({**base, "status": "erro", "mensagem": "Recebimento não encontrado na análise."})
                    falhas += 1
                    continue
                base.update(conta_id=grupo.conta_id, id_venda=grupo.id_venda, nome_cliente=grupo.nome_cliente,
                            valor=float(grupo.valor_total))
                rotulo_baixa = (
                    f"{len(grupo.contas_vinculadas)} parcelas da venda {grupo.id_venda}"
                    if len(grupo.contas_vinculadas) > 1
                    else f"conta #{grupo.conta_id}"
                )
                if progresso:
                    progresso(f"Baixando {rotulo_baixa} ({grupo.nome_cliente})", n, len(grupo_ids))
                ja_feitas = self.estado.ler().get("baixas") or {}
                if grupo.ja_baixado(ja_feitas):
                    grupo.situacao, grupo.mensagem = ml.SIT_CONCILIADO, "Já baixado no Tiny por esta automação."
                    resultados.append({**base, "status": "ignorado", "mensagem": grupo.mensagem})
                    ignorados += 1
                    continue
                # Erro de API numa tentativa anterior pode ser repetido: a conta é relida e reavaliada
                # abaixo, e uma tentativa sem resposta clara é conferida antes (ML-2).
                repetir_erro = grupo.situacao == ml.SIT_ERRO_API and grupo.conta_id is not None
                if not grupo.apto_baixa and not repetir_erro:
                    resultados.append({**base, "status": "ignorado", "mensagem": f"Recebimento não está apto para baixa ({grupo.situacao})."})
                    ignorados += 1
                    continue

                contas_alvo_ids = (
                    [int(c["id"]) for c in grupo.contas_vinculadas if c.get("id")]
                    if grupo.contas_vinculadas
                    else ([int(grupo.conta_id)] if grupo.conta_id else [])
                )
                if not contas_alvo_ids:
                    resultados.append({**base, "status": "ignorado", "mensagem": "Nenhuma conta vinculada encontrada para baixa."})
                    ignorados += 1
                    continue

                chave_pendente = f"{empresa.id}|{grupo.conta_id}|{grupo.id_venda}"
                try:
                    contas_atuais = []
                    for cid in contas_alvo_ids:
                        c_data = self.tiny.obter_conta_receber_v3(token, cid)
                        contas_atuais.append({**c_data, "id": cid})

                    # Confere tentativas anteriores sem resposta clara do Tiny (ML-2, B2)
                    partes_concluidas = set((self.estado.ler().get("baixas_partes") or {}).keys())
                    for cid in contas_alvo_ids:
                        c_atual = next((c for c in contas_atuais if c["id"] == cid), None)
                        if not c_atual:
                            continue
                        # Confere por parte (prod / frete)
                        for parte in ("prod", "frete"):
                            chk_p = f"{empresa.id}|{cid}|{grupo.id_venda}|{parte}"
                            ant_p = (self.estado.ler().get("baixas_pendentes") or {}).get(chk_p)
                            if ant_p is not None:
                                entrou_p = baixa_entrou(ant_p, c_atual)
                                if entrou_p is True:
                                    with self.estado.alterar() as dados:
                                        dados.setdefault("baixas_partes", {})[chk_p] = agora()
                                        (dados.get("baixas_pendentes") or {}).pop(chk_p, None)
                                    partes_concluidas.add(chk_p)
                                    log.aviso(f"Conta #{cid} ({parte}): a tentativa anterior tinha entrado.")
                                elif entrou_p is False:
                                    self._descartar_pendente(chk_p)
                                else:
                                    raise RuntimeError(
                                        f"Baixa da conta #{cid} ({parte}) em estado incerto. Confira no Tiny antes de repetir."
                                    )
                        # Confere formato legado ("{empresa}|{cid}|{id_venda}")
                        chk_pendente = f"{empresa.id}|{cid}|{grupo.id_venda}"
                        anterior = (self.estado.ler().get("baixas_pendentes") or {}).get(chk_pendente)
                        if anterior is not None:
                            entrou_leg = baixa_entrou(anterior, c_atual)
                            if entrou_leg is True:
                                self._concluir_pendente(chk_pendente, anterior.get("chaves") or grupo.chaves)
                                with self.estado.alterar() as dados:
                                    dados.setdefault("baixas_partes", {})[f"{chk_pendente}|prod"] = agora()
                                    dados.setdefault("baixas_partes", {})[f"{chk_pendente}|frete"] = agora()
                                partes_concluidas.add(f"{chk_pendente}|prod")
                                partes_concluidas.add(f"{chk_pendente}|frete")
                                log.aviso(f"Conta #{cid}: a tentativa anterior (sem resposta do Tiny) tinha entrado.")
                            elif entrou_leg is False:
                                self._descartar_pendente(chk_pendente)
                            else:
                                raise RuntimeError(
                                    f"Baixa da conta #{cid} em estado incerto. Confira no Tiny antes de repetir."
                                )

                    ml.aplicar_contas_ao_grupo(grupo, contas_atuais)
                    ml.avaliar_conta(grupo)
                    if not grupo.apto_baixa:
                        resultados.append({**base, "status": "ignorado", "mensagem": f"Conta mudou desde a análise: {grupo.mensagem}"})
                        log.aviso(f"Venda {grupo.id_venda} não baixada: {grupo.mensagem}")
                        ignorados += 1
                        continue

                    data_baixa = grupo.data
                    valor_restante_prod = Decimal(str(grupo.valor_produtos))
                    valor_restante_frete = Decimal(str(grupo.valor_frete))
                    if valor_restante_prod <= Decimal("0") and valor_restante_frete <= Decimal("0"):
                        valor_restante_prod = Decimal(str(grupo.valor_total))

                    contas_abertas = [c for c in contas_atuais if ml._situacao_conta(c) in ml.SITUACOES_TINY_BAIXAVEIS]
                    contas_abertas.sort(key=ml.numero_parcela)
                    parcelas_baixadas = []

                    for c in contas_abertas:
                        cid = int(c["id"])
                        chk_prod = f"{empresa.id}|{cid}|{grupo.id_venda}|prod"
                        chk_frete = f"{empresa.id}|{cid}|{grupo.id_venda}|frete"

                        saldo_p = ml.para_decimal(c.get("saldo"))
                        if saldo_p <= Decimal("0"):
                            continue
                        if (valor_restante_prod + valor_restante_frete) <= Decimal("0.005"):
                            break

                        # Se a parte do produto já foi baixada nesta conta, não repete
                        if chk_prod in partes_concluidas:
                            valor_baixa_prod = Decimal("0")
                        else:
                            valor_baixa_prod = min(saldo_p, valor_restante_prod)

                        saldo_restante_conta = saldo_p - valor_baixa_prod
                        # Se a parte do frete já foi baixada nesta conta, não repete
                        if chk_frete in partes_concluidas:
                            valor_baixa_frete = Decimal("0")
                        else:
                            valor_baixa_frete = min(saldo_restante_conta, valor_restante_frete)

                        if valor_baixa_prod <= Decimal("0.005") and valor_baixa_frete <= Decimal("0.005"):
                            continue

                        # 1. Baixa do PRODUTO com tentativa isolada por POST
                        if valor_baixa_prod > Decimal("0.005"):
                            tentativa_prod = {
                                "chaves": list(grupo.chaves),
                                "conta_id": cid,
                                "valor": str(valor_baixa_prod),
                                "valor_pago_antes": _texto_ou_none(c.get("valorPago")),
                                "saldo_antes": _texto_ou_none(c.get("saldo")),
                                "em": agora(),
                                "usuario": usuario,
                                "tipo": "prod",
                            }
                            with self.estado.alterar() as dados:
                                dados.setdefault("baixas_pendentes", {})[chk_prod] = tentativa_prod
                            try:
                                self.tiny.baixar_conta_receber_v3(
                                    token, cid, valor_pago=float(valor_baixa_prod), data_pagamento=data_baixa,
                                    conta_destino_id=conta_destino_id, categoria_id=categoria_id,
                                )
                            except Exception as erro_prod:
                                try:
                                    c_depois = self.tiny.obter_conta_receber_v3(token, cid)
                                    entrou = baixa_entrou(tentativa_prod, c_depois)
                                except Exception:
                                    entrou = None
                                if entrou is True:
                                    log.aviso(f"Conta #{cid} (produto): o Tiny respondeu com erro ({erro_prod}), mas a baixa entrou.")
                                elif entrou is False:
                                    self._descartar_pendente(chk_prod)
                                    raise erro_prod
                                else:
                                    raise RuntimeError(
                                        f"{erro_prod} — sem confirmação do Tiny se a baixa de produto da conta #{cid} entrou. "
                                        f"Confira no Tiny; a próxima tentativa confere antes de repetir."
                                    ) from erro_prod

                            with self.estado.alterar() as dados:
                                dados.setdefault("baixas_partes", {})[chk_prod] = agora()
                                (dados.get("baixas_pendentes") or {}).pop(chk_prod, None)
                            partes_concluidas.add(chk_prod)
                            c["valorPago"] = float(ml.para_decimal(c.get("valorPago")) + valor_baixa_prod)
                            c["saldo"] = float(ml.para_decimal(c.get("saldo")) - valor_baixa_prod)
                            valor_restante_prod -= valor_baixa_prod

                        # 2. Baixa do FRETE com tentativa isolada por POST
                        if valor_baixa_frete > Decimal("0.005"):
                            tentativa_frete = {
                                "chaves": list(grupo.chaves),
                                "conta_id": cid,
                                "valor": str(valor_baixa_frete),
                                "valor_pago_antes": _texto_ou_none(c.get("valorPago")),
                                "saldo_antes": _texto_ou_none(c.get("saldo")),
                                "em": agora(),
                                "usuario": usuario,
                                "tipo": "frete",
                            }
                            with self.estado.alterar() as dados:
                                dados.setdefault("baixas_pendentes", {})[chk_frete] = tentativa_frete
                            try:
                                self.tiny.baixar_conta_receber_v3(
                                    token, cid, valor_pago=float(valor_baixa_frete), data_pagamento=data_baixa,
                                    conta_destino_id=conta_destino_id, categoria_id=categoria_frete_id,
                                )
                            except Exception as erro_frete:
                                try:
                                    c_depois = self.tiny.obter_conta_receber_v3(token, cid)
                                    entrou = baixa_entrou(tentativa_frete, c_depois)
                                except Exception:
                                    entrou = None
                                if entrou is True:
                                    log.aviso(f"Conta #{cid} (frete): o Tiny respondeu com erro ({erro_frete}), mas a baixa entrou.")
                                elif entrou is False:
                                    self._descartar_pendente(chk_frete)
                                    raise erro_frete
                                else:
                                    raise RuntimeError(
                                        f"{erro_frete} — sem confirmação do Tiny se a baixa de frete da conta #{cid} entrou. "
                                        f"Confira no Tiny; a próxima tentativa confere antes de repetir."
                                    ) from erro_frete

                            with self.estado.alterar() as dados:
                                dados.setdefault("baixas_partes", {})[chk_frete] = agora()
                                (dados.get("baixas_pendentes") or {}).pop(chk_frete, None)
                            partes_concluidas.add(chk_frete)
                            c["valorPago"] = float(ml.para_decimal(c.get("valorPago")) + valor_baixa_frete)
                            c["saldo"] = float(ml.para_decimal(c.get("saldo")) - valor_baixa_frete)
                            valor_restante_frete -= valor_baixa_frete

                        parcelas_baixadas.append(cid)

                    # Registra a baixa concluída no estado
                    self._concluir_pendente(chave_pendente, grupo.chaves)
                    grupo.situacao = ml.SIT_CONCILIADO
                    grupo.baixado_em = date.today().isoformat()
                    if len(parcelas_baixadas) > 1:
                        msg_ok = f"Baixa realizada: {len(parcelas_baixadas)} parcelas ({', '.join(f'#{p}' for p in parcelas_baixadas)}) baixadas no Tiny totalizando R$ {grupo.valor_total:.2f}."
                    else:
                        msg_ok = f"Conta #{grupo.conta_id} baixada no Tiny."
                    grupo.mensagem = ""

                    try:
                        contas_depois = []
                        for cid in contas_alvo_ids:
                            cd = self.tiny.obter_conta_receber_v3(token, cid)
                            contas_depois.append({**cd, "id": cid})
                        ml.aplicar_contas_ao_grupo(grupo, contas_depois)
                    except Exception as e:
                        log.aviso(f"Venda {grupo.id_venda} baixada, mas a releitura falhou: {e}")

                    log.info(f"Venda {grupo.id_venda} ({grupo.nome_cliente}) baixada: {msg_ok} em {data_baixa}.")
                    resultados.append({**base, "status": "sucesso", "mensagem": msg_ok})
                    sucessos += 1
                except Exception as e:
                    log.erro(f"Falha ao baixar venda {grupo.id_venda} ({grupo.nome_cliente}): {e}")
                    grupo.situacao, grupo.mensagem = ml.SIT_ERRO_API, str(e)
                    resultados.append({**base, "status": "erro", "mensagem": str(e)})
                    falhas += 1
                finally:
                    ml.refletir_grupos_nas_linhas(analise.movimentos, [grupo])
        except Exception as e:
            log.erro(f"Baixa interrompida: {e}")
            raise
        finally:
            with self._baixas_lock:
                self._baixas_em_andamento.discard(empresa.id)
            try:
                self.estado.salvar_analise(analise)
            except Exception as e:
                logger.error(f"[CONCILIACAO_ML] Não gravou a análise {analise_id} depois da baixa: {e}")
            status = "ok" if falhas == 0 else ("parcial" if sucessos else "erro")
            log.empresa = ""
            log.info(f"Baixa concluída: {sucessos} baixada(s), {falhas} falha(s), {ignorados} pulada(s).")
            with self.estado.alterar() as dados:
                self.estado.registrar_execucao(dados, {
                    "id": execucao_id,
                    "tipo": "baixa",
                    "origem": "manual",
                    "usuario": usuario,
                    "iniciada_em": inicio,
                    "concluida_em": agora(),
                    "status": status,
                    "periodo_de": analise.periodo_de,
                    "periodo_ate": analise.periodo_ate,
                    "empresas": {empresa.id: {"status": status, "analise_id": analise_id, "mensagem": "",
                                              "baixa": {"sucessos": sucessos, "falhas": falhas, "ignorados": ignorados}}},
                    "log": log.linhas,
                })

        return {
            "status": "concluido" if falhas == 0 else ("parcial" if sucessos > 0 else "erro"),
            "total_solicitados": len(grupo_ids),
            "total_sucessos": sucessos,
            "total_falhas": falhas,
            "total_ignorados": ignorados,
            "resultados": resultados,
        }

    def _concluir_pendente(self, chave_pendente: str, chaves: List[str]) -> None:
        with self.estado.alterar() as dados:
            self.estado.registrar_baixas(dados, list(chaves))
            (dados.get("baixas_pendentes") or {}).pop(chave_pendente, None)

    def _descartar_pendente(self, chave_pendente: str) -> None:
        with self.estado.alterar() as dados:
            (dados.get("baixas_pendentes") or {}).pop(chave_pendente, None)

    # --- consultas ----------------------------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        dados = self.estado.ler()
        analises = [a for a in dados["execucoes"] if a.get("tipo", "analise") == "analise"]
        ultimas: Dict[str, Optional[Dict[str, Any]]] = {}
        for cab in reversed(dados["analises"]):
            ultimas.setdefault(cab["empresa"], cab)
        return {
            "empresas": [
                {
                    "id": e.id,
                    "nome": e.nome,
                    "conta_lancamento": e.conta_lancamento,
                    "conexoes": conexoes(e, self.cfg),
                    "ultima_analise": ultimas.get(e.id),
                }
                for e in ml.EMPRESAS_ML.values()
            ],
            "em_execucao": self.em_execucao,
            "progresso": self.progresso,
            "ultima_execucao": resumo_execucao(analises[-1]) if analises else None,
            "proxima_execucao": proxima_execucao(self.cfg).astimezone().isoformat(timespec="seconds"),
            "hora_diaria": self.cfg.ML_RECONCILIATION_HOUR,
            # O botão "Sincronizar Tokens ML" só renova com credenciais do TMS (ou OAuth próprio) neste
            # serviço. Sem elas, quem renova é o cron do servidor (scripts/sync_ml_tokens.py; ver scripts/README.md).
            "renovacao_tokens_no_painel": bool(
                (self.cfg.TMS_USER and self.cfg.TMS_PASSWORD) or self.cfg.ML_OAUTH_RENOVACAO_PROPRIA
            ),
            "periodo_padrao": [d.isoformat() for d in periodo_padrao()],
            "erro_gravacao": self.estado.erro_gravacao(),
        }


def _texto_ou_none(valor: Any) -> Optional[str]:
    return None if valor is None or valor == "" else str(valor)


def baixa_entrou(tentativa: Dict[str, Any], conta: Dict[str, Any]) -> Optional[bool]:
    """
    A baixa registrada em `tentativa` aparece na conta relida? Compara o valor pago (ou, sem ele, o
    saldo) de antes com o de agora. None = o Tiny não informou o suficiente para saber.
    """
    valor = ml.para_decimal(tentativa.get("valor"))
    tolerancia = Decimal("0.01")
    antes_pago, agora_pago = tentativa.get("valor_pago_antes"), conta.get("valorPago")
    if antes_pago is not None and agora_pago not in (None, ""):
        return ml.para_decimal(agora_pago) - ml.para_decimal(antes_pago) >= valor - tolerancia
    antes_saldo, agora_saldo = tentativa.get("saldo_antes"), conta.get("saldo")
    if antes_saldo is not None and agora_saldo not in (None, ""):
        return ml.para_decimal(antes_saldo) - ml.para_decimal(agora_saldo) >= valor - tolerancia
    return None


def resumo_execucao(execucao: Dict[str, Any]) -> Dict[str, Any]:
    linhas = execucao.get("log") or []
    return {
        **{k: v for k, v in execucao.items() if k != "log"},
        "linhas_log": len(linhas),
        "erros_log": sum(1 for l in linhas if l.get("nivel") == "erro"),
        "avisos_log": sum(1 for l in linhas if l.get("nivel") == "aviso"),
    }


def _texto_periodo(de: str, ate: str) -> str:
    def br(iso: str) -> str:
        a, m, d = iso.split("-")
        return f"{d}/{m}/{a}"

    return br(de) if de == ate else f"{br(de)} a {br(ate)}"


rotina = RotinaConciliacaoML()
