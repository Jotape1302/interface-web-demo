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
import time
from concurrent.futures import ThreadPoolExecutor
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Set, Tuple

from app import ml_reconciliation as ml
from app.dinheiro import dinheiro_json
from app.fuso import agora_sp, hoje_sp, FUSO_SP
from app.config import Settings, settings
from app.json_store import erro_gravacao, save_json_state, write_json_atomic
from app.ml_apis import (
    ClienteMercadoLivre,
    ClienteMercadoPago,
    SemCredencial,
    token_ml,
    token_mp,
)
from app.tiny_client import LancamentoCaixaIncerto, TinyClient
from app.token_repository import TokenRepository

logger = logging.getLogger("automacao_nfe.conciliacao_ml")

MAX_EXECUCOES = 120
MAX_AVISOS = 300
MAX_LINHAS_LOG = 1500
MAX_DIAS_PERIODO = 60  # limite do relatório de liberações do Mercado Pago
SEM_DOC = "?"  # CPF/CNPJ não lido na cópia das tarifas de venda antiga
MAX_FAIXAS_CAIXA = 4  # relatórios extras por execução para as tarifas das vendas antigas da consolidada
MAX_PEDIDOS_AVULSOS_ML = 300
MAX_PEDIDOS_AVULSOS_TINY = 150
MAX_PAGAMENTOS_SEM_VENDA = 300  # pagamentos sem pedido que a análise procura no Mercado Pago por empresa
MAX_RELOCALIZAR = 200  # 'não localizados' antigos que a consolidada tenta de novo por rodada (2–3 chamadas cada)
DIAS_REGISTRO_BAIXAS = 400
PAGINAS_CONTAS_CLIENTE = 50  # 5.000 contas por cliente (antes eram 5 páginas)
# Contas com vencimento num dia (reserva da busca da conta pela nota): ~30 por dia na Campinas.
PAGINAS_CONTAS_VENCIMENTO = 20
PAGINAS_CAIXA_DIA = 30  # 3.000 lançamentos de caixa num dia: lista no limite não serve para conferir

Progresso = Callable[[str, int, int], None]


def _pedido_tem_pagamento(pedido: Dict[str, Any], id_pagamento: str) -> bool:
    return any(ml.limpar_id((p or {}).get("id")) == id_pagamento for p in pedido.get("payments") or [])


def _duracao(segundos: float) -> str:
    """Duração legível para o log: '42 s' ou '12 min 05 s'."""
    s = int(round(segundos))
    return f"{s} s" if s < 60 else f"{s // 60} min {s % 60:02d} s"


def agora() -> str:
    # Com o fuso (-03:00): sem ele o frontend lê o horário como UTC e mostra 3 h a menos.
    return agora_sp().isoformat(timespec="seconds")


def proxima_execucao(cfg: Optional[Settings] = None, agora_dt: Optional[datetime] = None) -> datetime:
    cfg = cfg or settings
    agora_dt = agora_dt or agora_sp()
    alvo = agora_dt.replace(hour=cfg.ML_RECONCILIATION_HOUR, minute=0, second=0, microsecond=0)
    return alvo if alvo > agora_dt else alvo + timedelta(days=1)


def periodo_padrao(hoje: Optional[date] = None, dias: int = 60) -> Tuple[date, date]:
    """Janela móvel de 60 dias (D-60 a D-1)."""
    hoje_dt = hoje or hoje_sp()
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
    hoje = hoje or hoje_sp()
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

    def lancamentos_tiny(self) -> Dict[str, Dict[str, Any]]:
        """Lançamentos de caixa criados no Tiny pela API junto com a baixa: {chave: {id, em, venda}}."""
        return dict(self.ler().get("lancamentos_tiny") or {})

    def registrar_lancamento_tiny(self, chave: str, info: Dict[str, Any], incerto: bool = False) -> None:
        """Registra o lançamento criado (ou incerto) e o tira da planilha: conta como já exportado."""
        hoje = hoje_sp().isoformat()
        with self.alterar() as dados:
            campo = "lancamentos_tiny_incertos" if incerto else "lancamentos_tiny"
            dados.setdefault(campo, {})[chave] = {**info, "em": agora()}
            dados.setdefault("lancamentos_exportados", {}).setdefault(chave, hoje)

    def acrescimos_divididos(self) -> Set[str]:
        """Linhas de parcelamento que a conciliação já dividiu (acréscimo na baixa, resto no caixa):
        exportadas ou lançadas DEPOIS, saíram com o resto, então continuam divididas."""
        return set(self.ler().get("acrescimos_divididos") or {})

    def registrar_acrescimos_divididos(self, chaves: List[str]) -> None:
        novas = [c for c in chaves if c]
        if not novas:
            return
        hoje = hoje_sp().isoformat()
        with self.alterar() as dados:
            reg = dados.setdefault("acrescimos_divididos", {})
            for c in novas:
                reg.setdefault(c, hoje)

    def registrar_exportados(self, chaves: List[str]) -> None:
        """Lançamentos de caixa que saíram numa planilha para importação no Tiny (ML-5)."""
        hoje = hoje_sp()
        limite = (hoje - timedelta(days=DIAS_REGISTRO_BAIXAS)).isoformat()
        with self.alterar() as dados:
            exportados = {k: v for k, v in (dados.get("lancamentos_exportados") or {}).items() if v >= limite}
            for chave in chaves:
                if chave and chave not in exportados:
                    exportados[chave] = hoje.isoformat()
            dados["lancamentos_exportados"] = exportados

    @staticmethod
    def registrar_baixas(dados: Dict[str, Any], chaves: List[str]) -> None:
        hoje = hoje_sp()
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
        self._categorias: Dict[Tuple[str, str], int] = {}

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

    def categoria_por_nome(self, empresa: ml.EmpresaML, nome: str) -> int:
        """Categoria de receita/despesa do Tiny da empresa pelo nome exato (o mesmo da planilha de
        lançamentos). Só aceita um resultado: nome ausente ou repetido é erro, nunca um parecido."""
        chave = (empresa.id, ml._normalizar_nome(nome))
        if chave in self._categorias:
            return self._categorias[chave]
        token = self.obter_token(empresa.id)
        if not token:
            raise RuntimeError(f"Sem token do Tiny de {empresa.nome} para localizar a categoria '{nome}'.")
        cats = [c for c in self.tiny.list_categorias_receita_despesa_v3(token) if ml._normalizar_nome(_descricao(c)) == chave[1]]
        if len(cats) != 1:
            raise RuntimeError(f"{'Mais de uma' if cats else 'Nenhuma'} categoria '{nome}' no Tiny de {empresa.nome}.")
        self._categorias[chave] = int(cats[0]["id"])
        return self._categorias[chave]

    def contato_mercado_livre(self, empresa: ml.EmpresaML) -> int:
        """Contato dos lançamentos de caixa da venda (tarifas, envios, extras): o Mercado Livre
        (EBAZAR.COM.BR LTDA), como a conciliação do financeiro lança. Cadastro com o MESMO nome no
        Tiny da empresa; havendo mais de um, o do CNPJ da planilha. Nunca cria nem escolhe parecido."""
        chave = (empresa.id, "__contato_ml__")
        if chave in self._categorias:
            return self._categorias[chave]
        nome, cnpj = ml.CONTATO_PUBLICIDADE
        token = self.obter_token(empresa.id)
        if not token:
            raise RuntimeError(f"Sem token do Tiny de {empresa.nome} para localizar o contato {nome}.")
        alvo = ml._normalizar_nome(nome)
        iguais = [c for c in self.tiny.buscar_contatos_v3(token, nome=nome)
                  if c.get("id") and ml._normalizar_nome(str(c.get("nome") or "")) == alvo]
        if len(iguais) > 1:
            digitos = "".join(ch for ch in cnpj if ch.isdigit())
            iguais = [c for c in iguais if "".join(ch for ch in str(c.get("cpfCnpj") or "") if ch.isdigit()) == digitos]
        if len(iguais) != 1:
            raise RuntimeError(
                f"{'Mais de um' if iguais else 'Nenhum'} contato '{nome}' no Tiny de {empresa.nome} "
                "(a automação não cria contatos)."
            )
        self._categorias[chave] = int(iguais[0]["id"])
        return self._categorias[chave]

    def categoria_frete_id(self, empresa: ml.EmpresaML) -> int:
        """
        Categoria da parte do frete na baixa (frete pago pelo comprador): "Fretes sobre Vendas" do
        Tiny da empresa, pelo nome exato (ml.CATEGORIA_FRETE_RECEBIDO; até 11/11/2026 era Receita de
        Fretes). ML_CATEGORIA_FRETE_ID / ML_REVESTA_CATEGORIA_FRETE_ID no .env fixam outra.
        """
        fixa = self.cfg.ML_REVESTA_CATEGORIA_FRETE_ID if empresa.id == "revesta" else self.cfg.ML_CATEGORIA_FRETE_ID
        if fixa or empresa.categoria_frete_id:
            return int(fixa or empresa.categoria_frete_id)
        return self.categoria_por_nome(empresa, ml.CATEGORIA_FRETE_RECEBIDO)


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

        try:
            log.info(
                f"Execução {origem} iniciada: liberações de {de:%d/%m/%Y} a {ate:%d/%m/%Y}, "
                f"empresas: {', '.join(ml.EMPRESAS_ML[e].nome for e in ids)}."
            )
            # Relatórios do Mercado Pago pedidos de uma vez: o de cada empresa é gerado enquanto as
            # anteriores são conciliadas (o Mercado Pago chega a levar mais de 40 min).
            clientes_mp = {emp_id: self.fabrica_mp(ml.EMPRESAS_ML[emp_id]) for emp_id in ids}
            for emp_id, cliente_mp in clientes_mp.items():
                pedir = getattr(cliente_mp, "pedir_liberacoes", None)
                if pedir is None:
                    continue
                try:
                    pedir(de, ate)
                except Exception as e:  # pede de novo na vez da empresa, que registra a falha
                    logger.warning(f"[CONCILIACAO_ML] Pedido antecipado do relatório falhou em {emp_id}: {e}")
                if self.cfg.ML_LANCAR_CAIXA_NA_BAIXA:
                    # Relatórios dos dias das vendas antigas da consolidada sem as tarifas copiadas.
                    for f_de, f_ate in self.faixas_caixa_pendente(ml.EMPRESAS_ML[emp_id]):
                        try:
                            pedir(f_de, f_ate)
                        except Exception as e:
                            logger.warning(f"[CONCILIACAO_ML] Pedido do relatório de {f_de} a {f_ate} falhou em {emp_id}: {e}")
            logs = {emp_id: LogExecucao() for emp_id in ids}

            def rodar(emp_id: str) -> Dict[str, Any]:
                empresa = ml.EMPRESAS_ML[emp_id]
                log_emp = logs[emp_id]
                log_emp.empresa = empresa.nome

                def avancar_emp(etapa: str, atual: int, total: int) -> None:
                    self.progresso = {"etapa": etapa, "atual": atual, "total": total, "empresa": empresa.nome}
                    if progresso:
                        progresso(f"{empresa.nome}: {etapa}", atual, total)

                try:
                    return self._executar_empresa(
                        empresa, de, ate, origem, execucao_id, log_emp, avancar_emp, clientes_mp[emp_id]
                    )
                except SemCredencial as e:
                    log_emp.erro(f"Sem credencial: {e}")
                    return {"status": "sem_credencial", "mensagem": str(e)}
                except Exception as e:  # uma empresa com problema não impede a outra
                    logger.error(f"[CONCILIACAO_ML] Falha em {empresa.nome}: {e}", exc_info=True)
                    log_emp.erro(f"Falha: {e}")
                    return {"status": "erro", "mensagem": str(e)}

            # Em paralelo: cada empresa tem a sua conta do Tiny, e a fila de chamadas é por conta
            # (tiny/base.py). Em série, as ~2 h eram quase todas uma empresa esperando a outra.
            if self.cfg.ML_RECONCILIATION_PARALELO and len(ids) > 1:
                with ThreadPoolExecutor(max_workers=len(ids), thread_name_prefix="conciliacao-ml") as pool:
                    futuros = {emp_id: pool.submit(rodar, emp_id) for emp_id in ids}
                    for emp_id in ids:
                        resultado_empresas[emp_id] = futuros[emp_id].result()
            else:
                for emp_id in ids:
                    resultado_empresas[emp_id] = rodar(emp_id)
            # O log da execução fica em blocos por empresa, na ordem de sempre.
            for emp_id in ids:
                log.linhas.extend(logs[emp_id].linhas)
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
        cliente_mp: ClienteMercadoPago,
    ) -> Dict[str, Any]:
        avisos: List[str] = []
        token = self.obter_token_tiny(empresa.id)
        if not token:
            log.aviso("Sem token do Tiny: a análise sai sem cliente, sem conta a receber e sem baixa.")

        # 1. Recebimentos (Mercado Pago)
        avancar("Pedindo o relatório de liberações ao Mercado Pago", 0, 0)
        liberacoes = cliente_mp.liberacoes(de, ate, progresso=lambda etapa: avancar(etapa, 0, 0))
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
            ligados = self._ligar_pagamentos_sem_venda(cliente_mp, cliente_ml, movs, pedidos_ml, avancar)
            if ligados:
                log.info(f"Mercado Pago: {ligados} pagamento(s) sem pedido no relatório ligados à venda pelo próprio pagamento.")
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

        clientes_lidos = [0]

        def listar_contas(nome: str) -> List[Dict[str, Any]]:
            clientes_lidos[0] += 1
            contas = self.tiny.list_contas_receber_v3(
                token, nome_cliente=nome, max_pages=PAGINAS_CONTAS_CLIENTE, estrito=True
            )
            if len(contas) >= PAGINAS_CONTAS_CLIENTE * 100:
                log.aviso(f"Cliente '{nome}' com {len(contas)}+ contas a receber: a lista pode estar incompleta.")
            return contas

        pedido_da_venda = self._pedido_da_venda(token, pedidos_tiny) if token else None
        contas_da_venda = self._contas_pela_nota(token, pedido_da_venda) if token else None
        cupons, cupons_com_erro = self._cupons_do_mp(
            cliente_mp, ml.pagamentos_com_diferenca(ml.expandir_liberacoes(liberacoes)), log, avancar
        )
        baixas_feitas = dict(self.estado.ler().get("baixas") or {})
        exportados = self.estado.lancamentos_exportados()
        acrescimos_lidos = [0]

        def acrescimo_do_grupo(g: ml.GrupoRecebimento) -> Optional[Decimal]:
            acrescimos_lidos[0] += 1
            return self._acrescimo_do_mp(cliente_mp, g)

        t_analise = time.monotonic()
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
            cupons_vendedor=cupons,
            contas_da_venda=contas_da_venda,
            pedido_da_venda=pedido_da_venda,
            acrescimo_do_grupo=acrescimo_do_grupo,
            bloqueadas=self._ja_no_caixa() - self.estado.acrescimos_divididos(),
        )
        self._registrar_divisoes(analise.grupos)
        if acrescimos_lidos[0]:
            acr = [g for g in analise.grupos if g.acrescimo_descontado]
            log.info(
                f"Mercado Pago: acréscimo do comprador lido em {acrescimos_lidos[0]} divergente(s) com parcelamento: "
                f"{len(acr)} ficou(aram) apto(s) com a linha de parcelamento dividida."
            )
        if token:
            log.info(
                f"Tiny: contas a receber de {clientes_lidos[0]} cliente(s) consultadas em "
                f"{_duracao(time.monotonic() - t_analise)}."
            )
        # Cupom já conferido pela linha do relatório: a consolidada não consulta de novo.
        for g in analise.grupos:
            g.cupom_consultado = not (set(g.ids_pagamento) & cupons_com_erro)
        self.estado.salvar_analise(analise)
        self._atualizar_visao_consolidada(
            empresa, analise, token=token, log=log, contas_da_venda=contas_da_venda, cliente_mp=cliente_mp,
            pedido_da_venda=pedido_da_venda,
        )
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

    def _cupons_do_mp(
        self,
        cliente: ClienteMercadoPago,
        pagamentos: List[str],
        log: Optional[LogExecucao] = None,
        avancar: Optional[Progresso] = None,
    ) -> Tuple[Dict[str, Decimal], Set[str]]:
        """Cupom pago pelo vendedor de cada pagamento (o relatório de liberações não traz: sai como
        "Diferença na liberação"). Falha numa consulta só deixa aquela diferença para conferência."""
        cupons: Dict[str, Decimal] = {}
        com_erro: Set[str] = set()
        for i, pid in enumerate(pagamentos):
            if avancar:
                avancar("Conferindo cupons do vendedor no Mercado Pago", i, len(pagamentos))
            try:
                valor = cliente.cupom_vendedor(pid)
            except Exception as e:
                com_erro.add(pid)
                logger.warning(f"[CONCILIACAO_ML] Cupom do pagamento {pid}: {e}")
                continue
            if valor > 0:
                cupons[pid] = valor
        if log and pagamentos:
            log.info(
                f"Mercado Pago: {len(cupons)} cupom(ns) do vendedor em {len(pagamentos)} pagamento(s) com diferença na liberação"
                + (f" ({len(com_erro)} consulta(s) com erro)." if com_erro else ".")
            )
        return cupons, com_erro

    def _completar_cupom(
        self, empresa: ml.EmpresaML, grupos: List[ml.GrupoRecebimento], log: Optional[LogExecucao] = None
    ) -> int:
        """
        Grupos da consolidada (fora da janela de 60 dias, sem a linha do relatório reclassificada) com
        recebido acima do saldo e sem cupom: lê o cupom do vendedor nos pagamentos do grupo, uma vez só
        (`cupom_consultado`), e reavalia. A linha "Diferença na liberação" da análise antiga continua lá.
        """
        faltam = [
            g for g in grupos
            if g.situacao == ml.SIT_VALOR_DIVERGENTE and not g.cupom_consultado and g.valor_cupom <= 0
            and g.conta_saldo is not None and g.valor_total > g.conta_saldo
        ]
        if not faltam:
            return 0
        try:
            cliente = self.fabrica_mp(empresa)
        except SemCredencial as e:
            if log:
                log.aviso(f"Mercado Pago sem credencial para buscar cupons: {e}")
            return 0
        aptos = 0
        for g in faltam:
            pagamentos = ml.pagamentos_do_grupo(g)
            total = Decimal("0")
            try:
                for pid in pagamentos:
                    total += cliente.cupom_vendedor(pid)
            except Exception as e:
                logger.warning(f"[CONCILIACAO_ML] Cupom da venda {g.id_venda}: {e}")
                continue
            g.cupom_consultado = True
            if total > 0:
                g.valor_cupom = total
                ml.avaliar_conta(g)
                aptos += g.situacao == ml.SIT_APTO_BAIXA
        if log:
            log.info(f"Cupom do vendedor conferido no Mercado Pago em {len(faltam)} divergente(s) da consolidada: {aptos} ficou(aram) apto(s).")
        return aptos

    def _registrar_divisoes(self, grupos: List[ml.GrupoRecebimento]) -> None:
        self.estado.registrar_acrescimos_divididos([
            c for g in grupos if g.acrescimo_descontado and not g.acrescimo_bloqueado for c in g.chaves_parcelamento
        ])

    @staticmethod
    def _acrescimo_do_mp(cliente: Any, g: ml.GrupoRecebimento) -> Optional[Decimal]:
        """Acréscimo do comprador somado nos pagamentos do grupo; None se alguma consulta falhou."""
        total = Decimal("0")
        pagamentos = ml.pagamentos_do_grupo(g)
        try:
            for pid in pagamentos:
                total += cliente.acrescimo_comprador(pid)
        except Exception as e:
            logger.warning(f"[CONCILIACAO_ML] Acréscimo do comprador da venda {g.id_venda}: {e}")
            return None
        g.ids_pagamento = pagamentos  # grupo antigo: grava os pagamentos e não volta a ler
        return total

    def _completar_acrescimo(
        self, empresa: ml.EmpresaML, grupos: List[ml.GrupoRecebimento], log: Optional[LogExecucao] = None
    ) -> int:
        """
        Grupos da consolidada (fora da janela, ou de análises anteriores à regra) divergentes com custos
        de parcelamento: lê o acréscimo do comprador no Mercado Pago, uma vez (`acrescimo_consultado`),
        e reavalia. Os lançamentos guardados no grupo são ajustados na baixa (`ajustar_lancamentos_parcelamento`).
        """
        faltam = [g for g in grupos if ml.precisa_acrescimo(g)]
        if not faltam:
            return 0
        try:
            cliente = self.fabrica_mp(empresa)
        except SemCredencial as e:
            if log:
                log.aviso(f"Mercado Pago sem credencial para buscar o acréscimo do comprador: {e}")
            return 0
        bloqueadas = self._ja_no_caixa() - self.estado.acrescimos_divididos()
        aptos = 0
        for g in faltam:
            valor = self._acrescimo_do_mp(cliente, g)
            if valor is None:
                continue
            # Linhas de parcelamento das cópias guardadas (grupos antigos não têm `chaves_parcelamento`).
            if not g.chaves_parcelamento:
                g.chaves_parcelamento = [
                    ml.chave_lancamento(ml.lancamento_de_json(d)) for d in g.lancamentos_caixa
                    if d.get("tipo_operacao") == ml.TIPO_CUSTO_PARCELAMENTO
                ]
            ml.aplicar_acrescimo(g, valor, bloqueadas)
            aptos += g.situacao == ml.SIT_APTO_BAIXA
        self._registrar_divisoes(faltam)
        if log:
            log.info(f"Acréscimo do comprador conferido no Mercado Pago em {len(faltam)} divergente(s) da consolidada: {aptos} ficou(aram) apto(s).")
        return aptos

    def _regras_nos_herdados(
        self,
        empresa: ml.EmpresaML,
        herdados: List[ml.GrupoRecebimento],
        analise_recente: ml.Analise,
        log: Optional[LogExecucao] = None,
    ) -> Tuple[List[ml.Movimento], ml.ResultadoLancamentos]:
        """
        Grupos da consolidada que não vieram na análise recente (saíram da janela de 60 dias):
        1) VALOR DIVERGENTE é reavaliado com as regras atuais (frete fora da conta, cupom, parcelamento);
        2) frete que foi para o caixa (frete_no_caixa) e ainda não saiu em planilha ganha o lançamento
           de Fretes sobre Vendas AQUI, porque a análise de origem não gera mais lançamentos. A linha vem
           da cópia no grupo (`movimentos_frete`) ou das análises salvas; sem ela, o grupo apto volta a
           divergente (baixar o produto sem lançar o frete perderia a receita).
        """
        vazio = ml.ResultadoLancamentos()
        if not herdados:
            return [], vazio
        reavaliados = 0
        for g in herdados:
            g.chaves_frete = ml.chaves_frete_legado(g)
            if g.situacao == ml.SIT_VALOR_DIVERGENTE:
                ml.avaliar_conta(g)
                reavaliados += g.situacao != ml.SIT_VALOR_DIVERGENTE
        com_frete = [g for g in herdados if g.frete_no_caixa > 0]
        if not com_frete:
            if log and reavaliados:
                log.info(f"Consolidada: {reavaliados} divergente(s) antigo(s) resolvido(s) pelas regras atuais.")
            return [], vazio

        exportados = self.estado.lancamentos_exportados()
        ja_lancados = {ml.chave_lancamento(l) for l in analise_recente.lancamentos.lancamentos}
        faltam = {c for g in com_frete for c in g.chaves_frete if c not in exportados and c not in ja_lancados}
        achados: Dict[str, ml.Movimento] = {}
        for g in com_frete:
            for d in g.movimentos_frete:
                m = ml.movimento_de_json(d)
                if m.chave in faltam:
                    achados.setdefault(m.chave, m)
        if faltam - set(achados):
            for arq in sorted((self.estado.pasta / "analises").glob("*.json"), reverse=True):
                try:
                    dados = json.loads(arq.read_text(encoding="utf-8"))
                except Exception as e:
                    logger.warning(f"[CONCILIACAO_ML] Análise salva ilegível {arq.name}: {e}")
                    continue
                if dados.get("empresa_id") != empresa.id:
                    continue
                for d in dados.get("movimentos") or []:
                    if d.get("tipo_operacao") != ml.TIPO_RECEBIMENTO_FRETE:
                        continue
                    m = ml.movimento_de_json(d)
                    if m.chave in faltam:
                        achados.setdefault(m.chave, m)
                if not faltam - set(achados):
                    break

        proximo = max((m.indice for m in analise_recente.movimentos), default=-1) + 1
        extras: List[ml.Movimento] = []
        sem_linha = 0
        for g in com_frete:
            pendentes = [c for c in g.chaves_frete if c in faltam]
            if any(c not in achados for c in pendentes):
                sem_linha += 1
                if g.situacao != ml.SIT_CONCILIADO:
                    ml._restaurar_descontos(g)
                    g.situacao = ml.SIT_VALOR_DIVERGENTE
                    g.mensagem = (
                        "O frete não está na conta do Tiny, mas a linha dele já não está nas análises salvas: "
                        "baixe o produto e lance a Fretes sobre Vendas à mão."
                    )
                continue
            for c in pendentes:
                m = dataclasses.replace(achados[c], indice=proximo, situacao=ml.SIT_FRETE_NO_CAIXA)
                proximo += 1
                extras.append(m)
            g.movimentos_frete = g.movimentos_frete or [ml._para_json(dataclasses.asdict(achados[c])) for c in pendentes]
        resultado = ml.gerar_lancamentos(extras, empresa.conta_lancamento) if extras else vazio
        if log:
            log.info(
                f"Consolidada: {reavaliados} divergente(s) antigo(s) resolvido(s) pelas regras atuais; "
                f"{len(resultado.lancamentos)} lançamento(s) de Fretes sobre Vendas de vendas fora da janela"
                + (f"; {sem_linha} sem a linha do frete (à mão)." if sem_linha else ".")
            )
        return extras, resultado

    def _completar_data_venda(
        self, empresa: ml.EmpresaML, grupos: List[ml.GrupoRecebimento], log: Optional[LogExecucao] = None
    ) -> int:
        """
        Data da venda dos grupos que não a têm (análises anteriores a 2026-10-21, herdadas pela
        visão consolidada). A análise só aceita os últimos 60 dias, então reprocessar não alcança
        vendas antigas. Fontes: 1) as análises salvas da empresa que já têm a data; 2) o pagamento
        no Mercado Pago (`GET /v1/payments/{id}`), que não tem limite de período.
        """
        faltam = [g for g in grupos if not g.data_venda and g.situacao != ml.SIT_CONCILIADO]
        if not faltam:
            return 0
        conhecidas: Dict[str, str] = {}
        for arq in sorted((self.estado.pasta / "analises").glob("*.json")):
            try:
                dados = json.loads(arq.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning(f"[CONCILIACAO_ML] Análise salva ilegível {arq.name}: {e}")
                continue
            if dados.get("empresa_id") != empresa.id:
                continue
            for g in dados.get("grupos") or []:
                if g.get("id_venda") and g.get("data_venda"):
                    conhecidas.setdefault(g["id_venda"], g["data_venda"])
        cliente: Optional[ClienteMercadoPago] = None
        mp_disponivel = True
        preenchidos = 0
        for g in faltam:
            data = conhecidas.get(g.id_venda, "") if g.id_venda else ""
            if not data and g.id_operacao and mp_disponivel:
                try:
                    cliente = cliente or self.fabrica_mp(empresa)
                    data = ml.data_br(ml.data_sp(cliente.data_aprovacao(g.id_operacao)))
                except SemCredencial as e:
                    mp_disponivel = False
                    if log:
                        log.aviso(f"Mercado Pago sem credencial para buscar a data da venda: {e}")
                except Exception as e:
                    logger.warning(f"[CONCILIACAO_ML] Data da venda do pagamento {g.id_operacao}: {e}")
            if data:
                g.data_venda = data
                preenchidos += 1
        if log:
            log.info(f"Data da venda completada em {preenchidos} de {len(faltam)} recebimento(s) de análises antigas.")
        return preenchidos

    def _atualizar_visao_consolidada(
        self,
        empresa: ml.EmpresaML,
        analise_recente: ml.Analise,
        token: Optional[str] = None,
        log: Optional[LogExecucao] = None,
        contas_da_venda: Optional[ml.ContasDaVenda] = None,
        cliente_mp: Optional[ClienteMercadoPago] = None,
        pedido_da_venda: Optional[ml.PedidoDaVenda] = None,
    ) -> ml.Analise:
        """
        Mantém a visão consolidada de pendências da empresa (ID 'consolidado_{empresa.id}'): ACUMULA os grupos
        de todas as rodadas, sem corte por data. A análise só cobre os últimos 60 dias, mas um recebimento apto
        que sai da janela continua aqui e baixável (a baixa relê a conta no Tiny). Nunca podar por data: era
        a única cópia desses aptos (test_ml_aptos_persistem). Confere baixas externas no Tiny e persiste no disco.
        """
        cid = f"consolidado_{empresa.id}"
        existente = self.estado.analise(cid)

        # Se houver token do Tiny, relê contas em aberto na análise consolidada anterior
        # para remover/marcar contas liquidadas externamente no Tiny
        baixas_externas: List[str] = []
        docs: Dict[int, str] = {}  # conta -> CPF/CNPJ do cliente no Tiny
        recentes = {(g.id_venda, g.id_operacao or g.id) for g in analise_recente.grupos}
        if existente and token:
            # Só os herdados: os grupos da análise recente acabaram de ler a conta no Tiny (situação e
            # saldo) e substituem os antigos logo abaixo — reler um a um era ~1.700 chamadas (~15 min
            # por empresa, 06/11/2026) jogadas fora.
            conferir = [
                g for g in existente.grupos
                if g.situacao not in (ml.SIT_CONCILIADO, ml.SIT_ANULADA) and g.conta_id
                and (g.id_venda, g.id_operacao or g.id) not in recentes
            ]
            t0 = time.monotonic()
            for g in conferir:
                try:
                    c_data = self.tiny.obter_conta_receber_v3(token, int(g.conta_id))
                    docs[int(g.conta_id)] = str((c_data.get("cliente") or {}).get("cpfCnpj") or "")
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
            if log and conferir:
                log.info(
                    f"Consolidada: {len(conferir)} conta(s) de vendas antigas conferidas no Tiny em "
                    f"{_duracao(time.monotonic() - t0)}."
                )

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
            g.lancamentos_caixa = [
                ml._para_json(dataclasses.asdict(l))
                for l in ml.lancamentos_da_venda(analise_recente.movimentos, analise_recente.lancamentos.lancamentos, g.id_venda)
            ]
            g.caixa_lido = True
            grupos_map[chave_g] = g

        self._descartar_herdados_repetidos(grupos_map, log)
        herdados = [g for k, g in grupos_map.items() if k not in recentes]
        if contas_da_venda:
            self._relocalizar_herdados(herdados, contas_da_venda, log, pedido_da_venda, cliente_mp)
        if token:
            self._religar_herdados_sem_venda(empresa, herdados, token, cliente_mp, contas_da_venda, log)
            # Sem venda que acabou de ganhar a venda pode repetir uma liberação de outro grupo.
            if self._descartar_herdados_repetidos(grupos_map, log):
                herdados = [g for k, g in grupos_map.items() if k not in recentes]
        self._completar_cupom(empresa, list(grupos_map.values()), log)
        self._completar_acrescimo(empresa, list(grupos_map.values()), log)
        # Grupos herdados de consolidadas anteriores a 2026-10-21 não têm a data da venda.
        self._completar_data_venda(empresa, list(grupos_map.values()), log)
        extras_movs, extras_lanc = self._regras_nos_herdados(empresa, herdados, analise_recente, log)
        if self.cfg.ML_LANCAR_CAIXA_NA_BAIXA:
            t_caixa = time.monotonic()
            if self._copiar_caixa_dos_herdados(empresa, herdados, docs, cliente_mp, log) and log:
                log.info(f"Consolidada: leitura das tarifas das vendas antigas levou {_duracao(time.monotonic() - t_caixa)}.")
        for g in grupos_map.values():
            if g.situacao == ml.SIT_APTO_BAIXA and not g.data_venda:
                g.situacao, g.mensagem = ml.SIT_SEM_DATA_VENDA, ml.MSG_SEM_DATA_VENDA
            elif g.situacao == ml.SIT_SEM_DATA_VENDA and g.data_venda:
                ml.avaliar_conta(g)

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
            movimentos=list(analise_recente.movimentos) + extras_movs,
            grupos=grupos_consolidados,
            lancamentos=dataclasses.replace(
                analise_recente.lancamentos,
                lancamentos=list(analise_recente.lancamentos.lancamentos) + extras_lanc.lancamentos,
                pendencias=list(analise_recente.lancamentos.pendencias) + extras_lanc.pendencias,
            ),
            comparativo=analise_recente.comparativo,
            fontes=analise_recente.fontes,
            tiny_consultado=analise_recente.tiny_consultado,
            avisos=analise_recente.avisos,
        )

        self.estado.salvar_analise(analise_consolidada)
        if log:
            res_c = ml.resumo(analise_consolidada)
            log.info(
                f"Visão consolidada (acumulada) atualizada para {empresa.nome}: "
                f"{res_c['total_grupos']} grupos ({res_c['aptos_baixa']} aptos para baixa, "
                f"{res_c['conciliados']} conciliados)."
            )
        return analise_consolidada

    def _pedido_da_venda(self, token: str, pedidos_tiny: List[Dict[str, Any]]) -> ml.PedidoDaVenda:
        """Pedido completo do Tiny (GET /pedidos/{id}) pelo número da venda no ML, com cache. Achado
        pelos pedidos já listados na análise ou, senão, pelo filtro numeroPedidoEcommerce."""
        por_numero: Dict[str, Any] = {}
        for p in pedidos_tiny:
            eco = p.get("ecommerce") or {}
            for numero in (eco.get("numeroPedidoEcommerce"), eco.get("numeroPedidoCanalVenda"), p.get("numeroPedidoEcommerce")):
                n = ml.limpar_id(numero)
                if n and p.get("id") and n not in por_numero:
                    por_numero[n] = p["id"]
        cache: Dict[str, Optional[Dict[str, Any]]] = {}

        def pedido(id_venda: str) -> Optional[Dict[str, Any]]:
            if id_venda in cache:
                return cache[id_venda]
            pedido_id = por_numero.get(id_venda)
            if pedido_id is None:
                achados = self.tiny.list_pedidos_v3(token, numero_pedido_ecommerce=id_venda, max_pages=1)
                pedido_id = next((p.get("id") for p in achados if p.get("id")), None)
            cache[id_venda] = self.tiny.obter_pedido_v3(token, int(pedido_id)) if pedido_id is not None else None
            return cache[id_venda]

        return pedido

    def _contas_pela_nota(self, token: str, pedido_da_venda: ml.PedidoDaVenda) -> ml.ContasDaVenda:
        """
        Contas a receber da venda pelo caminho exato: pedido do Tiny (pelo número do pedido no ML)
        -> nota fiscal do pedido -> GET /contas-receber?idNota. É a reserva da busca pelo nome do
        cliente, que o Tiny não resolve para alguns nomes (06/11: "Instituto Exemplo Sa (centro
        de Pesquisas, ..." com 0 contas pelo nome e a conta #895456079 pela nota).

        Sem conta da nota que cite a venda: as contas com vencimento nas datas das parcelas do
        pedido (11/11: Marcello, venda 2000082629008667 — a conta #895400280 cita a venda, mas não
        está ligada à nota 895400543 e o filtro nomeCliente devolve 0). Cada data é lida uma vez.
        """
        cache: Dict[str, List[Dict[str, Any]]] = {}
        por_data: Dict[str, List[Dict[str, Any]]] = {}

        def contas_do_dia(data: str) -> List[Dict[str, Any]]:
            if data not in por_data:
                por_data[data] = self.tiny.list_contas_receber_v3(
                    token, data_inicial_vencimento=data, data_final_vencimento=data,
                    max_pages=PAGINAS_CONTAS_VENCIMENTO, estrito=True,
                )
            return por_data[data]

        def contas(id_venda: str) -> List[Dict[str, Any]]:
            if id_venda in cache:
                return cache[id_venda]
            pedido = pedido_da_venda(id_venda) or {}
            nota = pedido.get("notaFiscal") if isinstance(pedido.get("notaFiscal"), dict) else {}
            nota_id = (nota or {}).get("id") or pedido.get("idNotaFiscal")
            resultado: List[Dict[str, Any]] = []
            if nota_id:
                resultado = self.tiny.list_contas_receber_v3(token, id_nota=int(nota_id), max_pages=2, estrito=True)
            if not ml.selecionar_contas_da_venda(resultado, id_venda):
                pagamento = pedido.get("pagamento") if isinstance(pedido.get("pagamento"), dict) else {}
                datas = sorted({str(p.get("data") or "")[:10] for p in (pagamento or {}).get("parcelas") or [] if p.get("data")})
                for data in datas:
                    resultado = resultado + contas_do_dia(data)
            cache[id_venda] = resultado
            return resultado

        return contas

    @staticmethod
    def _completar_ids_pedido(g: ml.GrupoRecebimento, cliente_mp: Any) -> None:
        """Grupo antigo sem os pedidos do pacote: pergunta ao MP o pedido de cada pagamento (uma vez)."""
        buscar = getattr(cliente_mp, "pedido_do_pagamento", None)
        if g.ids_pedido or g.ids_pedido_lidos or buscar is None:
            return
        for pid in ml.pagamentos_do_grupo(g):
            oid = buscar(pid)
            if oid and oid != g.id_venda and oid not in g.ids_pedido:
                g.ids_pedido.append(oid)
        g.ids_pedido_lidos = True

    @staticmethod
    def _descartar_herdados_repetidos(grupos_map: Dict[Tuple[str, str], ml.GrupoRecebimento], log: Optional[LogExecucao] = None) -> int:
        """
        Grupo sem conta (sem cliente / não localizado) cujos pagamentos estão todos em OUTRO grupo da
        mesma venda: é a mesma liberação contada de novo (11/11/2026: frete de R$ 52,41 do pagamento
        171685744887 ficou num grupo "sem venda" antigo e, ligado depois à venda 2000057678923331,
        repetia o frete que já está no grupo da venda). Sai da consolidada; nunca um grupo com conta
        ou baixa.
        """
        removidas = []
        for chave, g in list(grupos_map.items()):
            if g.conta_id and not g.baixado_em and g.situacao != ml.SIT_CONCILIADO and g.id_venda and g.chaves:
                # Com conta, só pelas LINHAS (mais estrito que os pagamentos): todas dentro de outro
                # grupo da mesma venda, que é maior ou já foi baixado (12/11/2026, Anelize, venda
                # 2000096926594881: o recebimento de R$ 191,41 num grupo próprio e também no grupo
                # de R$ 261,14 com o outro pagamento, os dois "valor acima do saldo").
                minhas = set(g.chaves)
                if any(
                    o is not g and o.id_venda == g.id_venda
                    and (minhas < set(o.chaves) or (minhas == set(o.chaves) and o.baixado_em))
                    for o in grupos_map.values()
                ):
                    removidas.append(chave)
                continue
            if g.situacao not in (ml.SIT_SEM_CLIENTE, ml.SIT_NAO_LOCALIZADO) or g.conta_id or g.baixado_em or not g.id_venda:
                continue
            pags = set(ml.pagamentos_do_grupo(g))
            if not pags:
                continue
            if any(
                o is not g and o.id_venda == g.id_venda and pags <= set(ml.pagamentos_do_grupo(o))
                for o in grupos_map.values()
            ):
                removidas.append(chave)
        for chave in removidas:
            del grupos_map[chave]
        if log and removidas:
            log.info(f"Consolidada: {len(removidas)} grupo(s) repetido(s) (pagamento já em outro grupo da mesma venda) retirado(s).")
        return len(removidas)

    def _relocalizar_herdados(
        self,
        herdados: List[ml.GrupoRecebimento],
        contas_da_venda: ml.ContasDaVenda,
        log: Optional[LogExecucao] = None,
        pedido_da_venda: Optional[ml.PedidoDaVenda] = None,
        cliente_mp: Any = None,
    ) -> int:
        """'Conta não localizada' de fora da janela de 60 dias: a análise não os vê mais, então a
        consolidada tenta de novo pela nota fiscal do pedido (no máximo MAX_RELOCALIZAR por rodada).
        Sem conta e com o pedido cancelado no Tiny, vira "venda cancelada"; com nota fiscal e sem conta,
        "sem conta a receber" (a baixa cria a conta). Venda de pacote: também
        pelo número do pedido (lido no MP pelo pagamento), que é o que o Tiny pode ter gravado."""
        faltam = [g for g in herdados if g.situacao == ml.SIT_NAO_LOCALIZADO and g.id_venda][:MAX_RELOCALIZAR]
        achados = canceladas = sem_conta = 0
        for g in faltam:
            try:
                self._completar_ids_pedido(g, cliente_mp)
                contas = ml.contas_por_numeros(contas_da_venda, g)
            except Exception as e:
                logger.warning(f"[CONCILIACAO_ML] Conta da venda {g.id_venda} pela nota fiscal: {e}")
                continue
            if contas:
                ml.aplicar_contas_ao_grupo(g, contas)
                ml.avaliar_conta(g)
                achados += 1
                continue
            try:
                pedido = ml.pedido_por_numeros(pedido_da_venda, g) if pedido_da_venda else None
            except Exception as e:
                logger.warning(f"[CONCILIACAO_ML] Pedido do Tiny da venda {g.id_venda}: {e}")
                continue
            if ml.pedido_cancelado(pedido):
                ml.marcar_venda_cancelada(g, pedido)
                canceladas += 1
            elif ml.pedido_com_nota(pedido):
                ml.marcar_sem_conta_receber(g, pedido)
                sem_conta += 1
        if log and faltam:
            log.info(
                f"Consolidada: {achados} de {len(faltam)} 'não localizado(s)' antigos achados pela nota fiscal do pedido; "
                f"{canceladas} com o pedido cancelado no Tiny (venda cancelada/devolvida); "
                f"{sem_conta} com nota fiscal e sem conta a receber."
            )
        return achados

    @staticmethod
    def _ligar_pagamentos_sem_venda(
        cliente_mp: Any,
        cliente_ml: Any,
        movs: List[ml.Movimento],
        pedidos_ml: List[Dict[str, Any]],
        avancar: Optional[Progresso] = None,
    ) -> int:
        """
        Recebimento cujo pagamento não está em nenhum pedido buscado e sem pedido no relatório
        (06/11/2026: Maysa, R$ 2.453,64, ficou "sem venda" com o pagamento 173604496909 do pedido
        2000036158838540): pergunta ao Mercado Pago de qual pedido é o pagamento e busca o pedido.
        Só entra se o pedido trouxer o mesmo pagamento. Identifica a venda; os valores seguem os
        do relatório. Devolve quantos pedidos foram acrescentados.
        """
        buscar = getattr(cliente_mp, "pedido_do_pagamento", None)
        if buscar is None:
            return 0
        por_pagamento, por_pedido = ml.indice_pedidos_ml(pedidos_ml)
        pids = list(dict.fromkeys(
            m.id_pagamento for m in movs
            if m.tipo_operacao in ml.TIPOS_RECEBIMENTO and m.id_pagamento and m.id_pagamento not in por_pagamento
            and not m.id_pedido and not m.id_pacote
        ))[:MAX_PAGAMENTOS_SEM_VENDA]
        ligados = 0
        for i, pid in enumerate(pids):
            if avancar:
                avancar("Procurando a venda dos pagamentos sem pedido no relatório", i, len(pids))
            try:
                oid = buscar(pid)
                pedido = (por_pedido.get(oid) or cliente_ml.pedido(oid)) if oid else None
            except Exception as e:
                logger.warning(f"[CONCILIACAO_ML] Venda do pagamento {pid}: {e}")
                continue
            if not pedido or not _pedido_tem_pagamento(pedido, pid) or oid in por_pedido:
                continue
            pedidos_ml.append(pedido)
            por_pedido[oid] = pedido
            ligados += 1
        return ligados

    def _religar_herdados_sem_venda(
        self,
        empresa: ml.EmpresaML,
        herdados: List[ml.GrupoRecebimento],
        token: str,
        cliente_mp: Any,
        contas_da_venda: Optional[ml.ContasDaVenda],
        log: Optional[LogExecucao] = None,
    ) -> int:
        """
        "Sem cliente" de fora da janela de 60 dias: a análise não os vê mais. Sem venda, procura o
        pedido pelo pagamento (Mercado Pago -> pedido do Mercado Livre com o mesmo pagamento); com a
        venda, o cliente no pedido do Tiny e a conta (pela nota fiscal do pedido, senão pelo nome).
        """
        alvo = [g for g in herdados if g.situacao == ml.SIT_SEM_CLIENTE and not g.venda_procurada][:MAX_RELOCALIZAR]
        if not alvo:
            return 0
        buscar = getattr(cliente_mp, "pedido_do_pagamento", None)
        cliente_ml: Any = None
        vendas = achados = 0
        for g in alvo:
            try:
                if not g.id_venda:
                    pid = next(iter(g.ids_pagamento), "") or g.id_operacao
                    if not pid or buscar is None:
                        continue
                    oid = buscar(pid)
                    if oid:
                        cliente_ml = cliente_ml or self.fabrica_ml(empresa)
                    pedido = cliente_ml.pedido(oid) if oid else None
                    if not pedido or not _pedido_tem_pagamento(pedido, pid):
                        g.venda_procurada = True
                        continue
                    g.id_venda = ml.limpar_id(pedido.get("pack_id")) or ml.limpar_id(pedido.get("id"))
                    oid_pedido = ml.limpar_id(pedido.get("id"))
                    if oid_pedido and oid_pedido != g.id_venda and oid_pedido not in g.ids_pedido:
                        g.ids_pedido.append(oid_pedido)
                    g.ids_pedido_lidos = True
                    g.mlb = g.mlb or ml.extrair_mlb_pedido(pedido)
                    g.data_venda = g.data_venda or ml.data_venda_pedido(pedido, pid)
                    if pid not in g.ids_pagamento:
                        g.ids_pagamento.append(pid)
                    vendas += 1
                self._completar_ids_pedido(g, cliente_mp)
                nome_tiny = ""
                for numero in ml.numeros_da_venda(g):
                    indice = ml.indice_pedidos_tiny(
                        self.tiny.list_pedidos_v3(token, numero_pedido_ecommerce=numero, max_pages=1)
                    )
                    if numero in indice:
                        nome_tiny = indice[numero][0]
                        break
                if not nome_tiny:
                    g.mensagem = f"Venda {' / '.join(ml.numeros_da_venda(g))} não encontrada nos pedidos do Tiny."
                    continue
                g.nome_cliente = nome_tiny
                contas: List[Dict[str, Any]] = []
                if contas_da_venda:
                    contas = ml.contas_por_numeros(contas_da_venda, g)
                if not contas:
                    contas = ml.contas_que_citam(
                        self.tiny.list_contas_receber_v3(
                            token, nome_cliente=g.nome_cliente, max_pages=PAGINAS_CONTAS_CLIENTE, estrito=True
                        ),
                        g,
                    )
                if not contas:
                    g.situacao = ml.SIT_NAO_LOCALIZADO
                    g.mensagem = (
                        f"Nenhuma conta de {g.nome_cliente} cita a venda {' / '.join(ml.numeros_da_venda(g))} no histórico "
                        "(busca pelo nome e pela nota fiscal do pedido)."
                    )
                    continue
                ml.aplicar_contas_ao_grupo(g, contas)
                ml.avaliar_conta(g)
                achados += 1
            except Exception as e:
                logger.warning(f"[CONCILIACAO_ML] Recebimento sem cliente {g.id} ({empresa.nome}): {e}")
        if log and (vendas or achados):
            log.info(
                f"Consolidada: {vendas} recebimento(s) antigo(s) sem venda ligados à venda pelo pagamento; "
                f"{achados} 'sem cliente' antigo(s) com a conta achada no Tiny."
            )
        return achados

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
            # Categoria do frete (Fretes sobre Vendas, pelo nome no Tiny): só procurada quando uma
            # venda tem parte de frete, para uma baixa sem frete nunca falhar por ela.
            cache_frete: Dict[str, int] = {}

            def categoria_frete() -> int:
                if "id" not in cache_frete:
                    cache_frete["id"] = self.resolvedor.categoria_frete_id(empresa)
                return cache_frete["id"]

            log.info(
                f"Baixa de {len(grupo_ids)} recebimento(s) da análise {analise_id[:8]}"
                f"{f' por {usuario}' if usuario else ''} (conta #{conta_destino_id}, categoria #{categoria_id})."
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
                if not grupo.data_venda:
                    self._completar_data_venda(empresa, [grupo])
                    if grupo.data_venda and grupo.situacao == ml.SIT_SEM_DATA_VENDA:
                        ml.avaliar_conta(grupo)
                ja_feitas = self.estado.ler().get("baixas") or {}
                if grupo.ja_baixado(ja_feitas):
                    grupo.situacao, grupo.mensagem = ml.SIT_CONCILIADO, "Já baixado no Tiny por esta automação."
                    resultados.append({**base, "status": "ignorado", "mensagem": grupo.mensagem})
                    ignorados += 1
                    continue
                # Venda cancelada/devolvida (pedido cancelado no Tiny, sem conta) ou faturada sem conta:
                # cria a conta a receber do pedido e segue como uma baixa comum; as tarifas (e, na
                # cancelada, o estorno) vão para o caixa depois.
                cancelada = grupo.situacao == ml.SIT_VENDA_CANCELADA
                if grupo.situacao in ml.SITUACOES_CONTA_A_CRIAR:
                    if not grupo.cancelada_pronta:
                        resultados.append({**base, "status": "ignorado", "mensagem": grupo.mensagem})
                        ignorados += 1
                        continue
                    simulado = ml.simular_conta_cancelada(grupo)
                    if simulado.situacao != ml.SIT_APTO_BAIXA:
                        msg = (
                            f"Conta não criada: o recebido não fecha com o pedido nº {grupo.pedido_tiny_numero} "
                            f"(R$ {grupo.pedido_tiny_valor:.2f}). {simulado.mensagem}"
                        )
                        resultados.append({**base, "status": "ignorado", "mensagem": msg})
                        log.aviso(f"Venda {grupo.id_venda}: {msg}")
                        ignorados += 1
                        continue
                    try:
                        conta_nova = self._conta_da_venda_cancelada(empresa, grupo, token, categoria_id, usuario, log)
                    except Exception as e:
                        log.erro(f"Venda {grupo.id_venda}: conta a receber não criada: {e}")
                        resultados.append({**base, "status": "erro", "mensagem": f"Conta a receber não criada: {e}"})
                        falhas += 1
                        continue
                    ml.aplicar_contas_ao_grupo(grupo, [conta_nova])
                    ml.avaliar_conta(grupo)
                    base["conta_id"] = grupo.conta_id
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
                    # Uma parte já baixada numa tentativa anterior sai da comparação com o saldo, que
                    # já não a inclui. Só com conta única: nas parcelas não se sabe quanto foi em cada uma.
                    parte_feita = None
                    if len(contas_alvo_ids) == 1:
                        feitas = [
                            p for p in ("prod", "frete")
                            if f"{empresa.id}|{contas_alvo_ids[0]}|{grupo.id_venda}|{p}" in partes_concluidas
                        ]
                        if len(feitas) == 1 and (grupo.valor_produtos if feitas[0] == "prod" else grupo.valor_frete) > 0:
                            parte_feita = feitas[0]
                    if parte_feita:
                        ml.avaliar_conta_sem_parte(grupo, parte_feita)
                    else:
                        ml.avaliar_conta(grupo)
                    if not grupo.apto_baixa:
                        resultados.append({**base, "status": "ignorado", "mensagem": f"Conta mudou desde a análise: {grupo.mensagem}"})
                        log.aviso(f"Venda {grupo.id_venda} não baixada: {grupo.mensagem}")
                        ignorados += 1
                        continue

                    # O recebimento é baixado na data da venda, não na da liberação do dinheiro
                    # (avaliar_conta não deixa apto um grupo sem data da venda).
                    data_baixa = grupo.data_venda
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

                        # 1. Baixa do PRODUTO e 2. do FRETE, cada uma com tentativa isolada por POST
                        if valor_baixa_prod > Decimal("0.005"):
                            self._baixar_parte(
                                "prod", token=token, conta=c, chave=chk_prod, valor=valor_baixa_prod,
                                data_baixa=data_baixa, conta_destino_id=conta_destino_id,
                                categoria_id=categoria_id, grupo=grupo, usuario=usuario,
                                partes_concluidas=partes_concluidas, log=log,
                            )
                            valor_restante_prod -= valor_baixa_prod
                        if valor_baixa_frete > Decimal("0.005"):
                            self._baixar_parte(
                                "frete", token=token, conta=c, chave=chk_frete, valor=valor_baixa_frete,
                                data_baixa=data_baixa, conta_destino_id=conta_destino_id,
                                categoria_id=categoria_frete(), grupo=grupo, usuario=usuario,
                                partes_concluidas=partes_concluidas, log=log,
                            )
                            valor_restante_frete -= valor_baixa_frete

                        parcelas_baixadas.append(cid)

                    # Registra a baixa concluída no estado
                    self._concluir_pendente(chave_pendente, grupo.chaves_para_registro())
                    grupo.situacao = ml.SIT_CONCILIADO
                    grupo.baixado_em = hoje_sp().isoformat()
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

                    if self.cfg.ML_LANCAR_CAIXA_NA_BAIXA:
                        criados, problemas = self._lancar_caixa_da_venda(
                            empresa, analise, grupo, token, conta_destino_id, contas_atuais, usuario, log
                        )
                        if criados:
                            msg_ok += f" {criados} lançamento(s) de caixa criado(s) no Tiny."
                        if problemas:
                            msg_ok += f" {len(problemas)} não entraram no caixa: " + "; ".join(problemas)
                        if cancelada and not self._tem_estorno(analise, grupo):
                            msg_ok += (
                                " O estorno (devolução) desta venda não está no relatório lido: lance a saída à mão."
                            )
                            log.aviso(f"Venda cancelada {grupo.id_venda}: estorno não encontrado no relatório.")
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

    def _tem_estorno(self, analise: ml.Analise, grupo: ml.GrupoRecebimento) -> bool:
        candidatos, _ = self._lancamentos_do_grupo(analise, grupo)
        return any(l.tipo_operacao in ml.TIPOS_ESTORNO for l in candidatos)

    def _conta_da_venda_cancelada(
        self,
        empresa: ml.EmpresaML,
        grupo: ml.GrupoRecebimento,
        token: str,
        categoria_id: int,
        usuario: str,
        log: LogExecucao,
    ) -> Dict[str, Any]:
        """
        Conta a receber do pedido cancelado (valor do pedido, cliente do pedido, emissão e
        vencimento na data da venda, histórico citando a venda). Nunca cria duas: usa a já
        registrada por esta automação ou a que já cite a venda nas contas do cliente; resposta
        sem confirmação do Tiny fica registrada e a próxima tentativa só procura a conta.
        """
        chave = f"{empresa.id}|{grupo.id_venda}"
        registro = (self.estado.ler().get("contas_criadas") or {}).get(chave) or {}
        if registro.get("id"):
            conta = self.tiny.obter_conta_receber_v3(token, int(registro["id"]))
            return {**conta, "id": int(registro["id"])}
        existentes = ml.contas_que_citam(
            self.tiny.list_contas_receber_v3(token, nome_cliente=grupo.nome_cliente, max_pages=PAGINAS_CONTAS_CLIENTE, estrito=True),
            grupo,
        )
        if existentes:
            conta_id = int(existentes[0]["id"])
            self._registrar_conta_criada(chave, {"id": conta_id, "existente": True, "usuario": usuario})
            log.aviso(f"Venda {grupo.id_venda}: a conta #{conta_id} já existia no Tiny; nenhuma criada.")
            return existentes[0]
        if registro.get("incerto"):
            raise RuntimeError(
                "uma tentativa anterior ficou sem confirmação do Tiny e a conta não apareceu nas contas do "
                f"cliente: confira no Tiny (histórico '{ml.historico_conta_cancelada(grupo)}') antes de repetir"
            )
        data_iso = datetime.strptime(grupo.data_venda, "%d/%m/%Y").date().isoformat()
        historico = ml.historico_conta_cancelada(grupo)
        info = {"pedido": grupo.pedido_tiny_id, "valor": str(grupo.pedido_tiny_valor), "data": data_iso,
                "historico": historico, "usuario": usuario, "em": agora()}
        try:
            conta_id = self.tiny.criar_conta_receber_v3(
                token, historico=historico, data=data_iso, valor=grupo.pedido_tiny_valor,
                contato_id=int(grupo.cliente_tiny_id), categoria_id=categoria_id,
                numero_documento=grupo.pedido_tiny_numero,
            )
        except LancamentoCaixaIncerto as e:
            self._registrar_conta_criada(chave, {**info, "incerto": True, "erro": str(e)})
            raise RuntimeError(f"sem confirmação do Tiny ao criar a conta ({e}); confira no Tiny antes de repetir") from e
        self._registrar_conta_criada(chave, {**info, "id": conta_id})
        log.info(f"Venda {grupo.id_venda}: conta a receber #{conta_id} criada do pedido nº {grupo.pedido_tiny_numero} (R$ {grupo.pedido_tiny_valor:.2f}).")
        conta = self.tiny.obter_conta_receber_v3(token, conta_id)
        return {**conta, "id": conta_id}

    def _registrar_conta_criada(self, chave: str, info: Dict[str, Any]) -> None:
        with self.estado.alterar() as dados:
            dados.setdefault("contas_criadas", {})[chave] = info

    def _lancar_caixa_da_venda(
        self,
        empresa: ml.EmpresaML,
        analise: ml.Analise,
        grupo: ml.GrupoRecebimento,
        token: str,
        conta_id: int,
        contas: List[Dict[str, Any]],
        usuario: str,
        log: LogExecucao,
        incluir_exportados: bool = False,
    ) -> Tuple[int, List[str]]:
        """
        Depois da baixa, lança no caixa do Tiny (POST /caixa) as tarifas, envios e extras da MESMA
        venda que a análise gerou como lançamento de caixa — os mesmos valores e categorias da
        planilha, na data da venda. Padrão do financeiro (06/11/2026): histórico = o da conta a
        receber baixada e contato = Mercado Livre (EBAZAR.COM.BR LTDA), como a conciliação manual; a
        devolução (ml.CATEGORIAS_CONTATO_CLIENTE) vai com o cliente da conta, que é quem recebe o
        reembolso (16/11/2026). Nunca repete o que já saiu numa planilha ou já foi lançado. Devolve (criados, problemas).

        Venda herdada pela consolidada (as linhas já não estão na análise): usa a cópia guardada no
        grupo (`lancamentos_caixa`), feita enquanto a venda estava na janela ou, para as herdadas antes
        de 06/11, tirada do relatório do dia da liberação pela execução. A baixa nunca espera o
        Mercado Pago (o relatório leva até 40 min).
        """
        por_chave = {m.chave: m for m in analise.movimentos if m.chave}
        ja = self._ja_no_caixa(incluir_exportados)
        data_iso = datetime.strptime(grupo.data_venda, "%d/%m/%Y").date().isoformat()
        # Padrão do financeiro (06/11/2026): histórico = o da conta baixada, contato = Mercado Livre.
        historico = next((str(c.get("historico")).strip() for c in contas if str(c.get("historico") or "").strip()), "")
        erro_contato = ""
        contato_id: Optional[int] = None
        try:
            contato_id = self.resolvedor.contato_mercado_livre(empresa)
        except Exception as e:
            erro_contato = str(e)
        cliente_id = next((int(c["cliente"]["id"]) for c in contas
                           if isinstance(c.get("cliente"), dict) and str(c["cliente"].get("id") or "").isdigit()), None)
        criados, problemas = 0, []
        candidatos, na_planilha = self._lancamentos_do_grupo(analise, grupo)
        if grupo.chaves and not grupo.caixa_lido and not any(c in por_chave for c in grupo.chaves):
            problemas.append(
                "as tarifas desta venda antiga ainda não foram lidas do relatório do dia da liberação "
                "(a próxima execução lê): lance à mão"
            )
        cobrancas_mp: Dict[str, List[Tuple[str, Decimal]]] = {}

        def lancar(lanc: ml.Lancamento, chave: str, destino: str, extra: Dict[str, Any]) -> bool:
            """POST de um lançamento; True se ficou registrado (criado ou incerto)."""
            nonlocal criados
            rotulo = f"{extra.get('parte_rotulo') or lanc.tipo_operacao} R$ {lanc.valor.quantize(Decimal('0.01'))}"
            info = {"empresa": empresa.id, "venda": grupo.id_venda, "valor": str(lanc.valor), "tipo": lanc.tipo,
                    "data": data_iso, "historico": historico, "tipo_operacao": lanc.tipo_operacao, "usuario": usuario,
                    **extra}
            try:
                categoria_id = self.resolvedor.categoria_por_nome(empresa, lanc.categoria)
                contato = cliente_id if lanc.categoria in ml.CATEGORIAS_CONTATO_CLIENTE else contato_id
                lanc_id: Optional[int] = self.tiny.criar_lancamento_caixa_v3(
                    token, historico=historico, data=data_iso, valor=lanc.valor, tipo=lanc.tipo,
                    categoria_id=categoria_id, conta_id=conta_id, contato_id=contato,
                )
            except LancamentoCaixaIncerto as e:
                lanc_id = self._lancamento_no_caixa(token, data_iso, lanc, historico)
                if lanc_id is None:
                    self.estado.registrar_lancamento_tiny(chave, {**info, "erro": str(e)}, incerto=True)
                    problemas.append(f"{rotulo}: sem confirmação do Tiny ({e}); confira no caixa antes de lançar de novo")
                    log.aviso(f"Venda {grupo.id_venda}: lançamento de caixa incerto ({rotulo}): {e}")
                    return True
            except Exception as e:
                problemas.append(f"{rotulo}: {e} ({destino})")
                return False
            self.estado.registrar_lancamento_tiny(chave, {**info, "id": lanc_id})
            criados += 1
            return True

        for lanc in candidatos:
            chave = ml.chave_lancamento(lanc)
            if chave in ja:
                continue
            rotulo = f"{lanc.tipo_operacao} R$ {lanc.valor.quantize(Decimal('0.01'))}"
            destino = "fica na planilha" if chave in na_planilha else "venda fora da planilha: lance à mão"
            if not historico:
                problemas.append(f"{rotulo}: a conta do Tiny não trouxe o histórico ({destino})")
                continue
            if lanc.categoria in ml.CATEGORIAS_CONTATO_CLIENTE:
                if cliente_id is None:
                    problemas.append(f"{rotulo}: a conta do Tiny não trouxe o cliente da devolução ({destino})")
                    continue
            elif erro_contato:
                problemas.append(f"{rotulo}: {erro_contato} ({destino})")
                continue
            partes = self._partes_tarifa_venda(empresa, grupo, lanc, cobrancas_mp, log)
            if not partes:
                lancar(lanc, chave, destino, {})
                continue
            # Tarifa de venda em partes (como o Tiny): cada parte tem a própria chave, então uma
            # repetição só lança o que faltou; a linha inteira só conta como lançada (e sai das
            # pendentes e da planilha) quando todas as partes estão registradas.
            chaves_partes = [chave + ml.SUFIXO_PARTE_TARIFA + nome for nome, _, _ in partes]
            feitas = 0
            for (nome, rotulo_parte, valor), chave_parte in zip(partes, chaves_partes):
                if chave_parte in ja:
                    feitas += 1
                    continue
                parte = dataclasses.replace(lanc, valor=valor)
                feitas += lancar(parte, chave_parte, destino, {"parte": nome, "parte_rotulo": rotulo_parte, "linha": chave})
            if feitas == len(partes):
                self.estado.registrar_lancamento_tiny(chave, {
                    "empresa": empresa.id, "venda": grupo.id_venda, "valor": str(lanc.valor), "tipo": lanc.tipo,
                    "data": data_iso, "historico": historico, "tipo_operacao": lanc.tipo_operacao, "usuario": usuario,
                    "dividida_em": chaves_partes,
                })
        if criados or problemas:
            log.info(f"Venda {grupo.id_venda}: {criados} lançamento(s) de caixa no Tiny, {len(problemas)} para a planilha/conferência.")
        return criados, problemas

    def _partes_tarifa_venda(
        self,
        empresa: ml.EmpresaML,
        grupo: ml.GrupoRecebimento,
        lanc: ml.Lancamento,
        cache: Dict[str, List[Tuple[str, Decimal]]],
        log: LogExecucao,
    ) -> List[Tuple[str, str, Decimal]]:
        """Partes da tarifa de venda lidas do pagamento no MP (`ml.dividir_tarifa_venda`); [] = lança
        a linha inteira (flag desligada, outra operação, MP fora do ar ou cobranças que não fecham
        exatamente com o relatório). Um GET por pagamento."""
        if (not self.cfg.ML_DIVIDIR_TARIFA_VENDA or lanc.tipo_operacao != ml.TIPO_TARIFA_VENDA
                or lanc.tipo != "D" or not str(lanc.numero_documento).isdigit()):
            return []
        pid = str(lanc.numero_documento)
        if pid not in cache:
            try:
                buscar = getattr(self.fabrica_mp(empresa), "cobrancas_tarifa", None)
                cache[pid] = list(buscar(pid)) if buscar else []
            except Exception as e:
                log.aviso(f"Venda {grupo.id_venda}: tarifas do pagamento {pid} não lidas no Mercado Pago ({e}); "
                          "tarifa de venda lançada inteira.")
                cache[pid] = []
        partes = ml.dividir_tarifa_venda(lanc.valor, cache[pid])
        if not partes and cache[pid]:
            log.aviso(f"Venda {grupo.id_venda}: as cobranças do pagamento {pid} no Mercado Pago não fecham com a tarifa "
                      f"de venda de R$ {lanc.valor.quantize(Decimal('0.01'))}; lançada inteira.")
        return partes

    @staticmethod
    def _lancamentos_no_relatorio(
        empresa: ml.EmpresaML, grupo: ml.GrupoRecebimento, linhas: List[ml.Movimento], doc_cliente: str
    ) -> Optional[Tuple[List[ml.Lancamento], List[ml.Pendencia]]]:
        """
        Lançamentos de caixa de uma venda herdada, tirados do relatório de liberações que cobre o dia
        da liberação (grupo.data), com os valores do relatório. None se o relatório não traz o mesmo
        recebimento do grupo (mesma chave). Não entram: o recebimento, o frete (lançado pela
        consolidada) e o parcelamento/cupom descontados da baixa; o resto que não fecha vira pendência.
        """
        movs = [dataclasses.replace(m) for m in linhas]
        chaves = set(grupo.chaves)
        pagamentos = {m.id_pagamento for m in movs if m.chave in chaves and m.id_pagamento}
        if not pagamentos:
            return None
        indices: Set[int] = set()
        for m in movs:
            if m.id_pagamento not in pagamentos:
                continue
            if m.chave in chaves or m.tipo_operacao == ml.TIPO_RECEBIMENTO_FRETE:
                m.situacao = ml.SIT_CONCILIADO
            elif (m.tipo_operacao == ml.TIPO_CUSTO_PARCELAMENTO and grupo.parcelamento_descontado) or (
                m.tipo_operacao in (ml.TIPO_CUPOM_VENDEDOR, ml.TIPO_DIFERENCA) and grupo.cupom_descontado
            ):
                m.situacao = ml.SIT_DESCONTADO_NA_BAIXA
            # Mesmo número de venda da análise (o pacote, quando há): o histórico sai igual ao da planilha.
            m.id_pacote, m.mlb = grupo.id_venda, m.mlb or grupo.mlb
            m.nome_cliente, m.cpf_cnpj = grupo.nome_cliente, doc_cliente or SEM_DOC
            indices.add(m.indice)
        # As anulações (retido × liberado, tarifa × estorno) são vistas no relatório inteiro.
        resultado = ml.gerar_lancamentos(movs, empresa.conta_lancamento)
        lancs = ml.ajustar_lancamentos_parcelamento([l for l in resultado.lancamentos if l.indice in indices], grupo)
        for l in lancs:
            if l.cnpj == SEM_DOC:
                l.cnpj = ""  # o lançamento confere o cliente pela conta baixada
        return (
            lancs,
            [p for p in resultado.pendencias if p.indice in indices],
        )

    @staticmethod
    def _sem_caixa_lido(grupos: List[ml.GrupoRecebimento]) -> List[ml.GrupoRecebimento]:
        return [
            g for g in grupos
            if not g.caixa_lido and g.chaves and g.conta_id and g.situacao != ml.SIT_ANULADA
        ]

    def faixas_caixa_pendente(self, empresa: ml.EmpresaML) -> List[Tuple[date, date]]:
        """Períodos (até 60 dias cada, no máximo MAX_FAIXAS_CAIXA) que cobrem os dias de liberação
        das vendas da consolidada sem os lançamentos de caixa copiados."""
        existente = self.estado.analise(f"consolidado_{empresa.id}")
        return self._faixas(self._sem_caixa_lido(existente.grupos)) if existente else []

    @staticmethod
    def _faixas(grupos: List[ml.GrupoRecebimento]) -> List[Tuple[date, date]]:
        dias = set()
        for g in grupos:
            try:
                dias.add(datetime.strptime(g.data, "%d/%m/%Y").date())
            except ValueError:
                continue
        faixas: List[Tuple[date, date]] = []
        for dia in sorted(dias):
            if faixas and (dia - faixas[-1][0]).days < MAX_DIAS_PERIODO:
                faixas[-1] = (faixas[-1][0], dia)
            else:
                faixas.append((dia, dia))
        return faixas[:MAX_FAIXAS_CAIXA]

    def _copiar_caixa_dos_herdados(
        self,
        empresa: ml.EmpresaML,
        herdados: List[ml.GrupoRecebimento],
        docs: Dict[int, str],
        cliente_mp: Optional[ClienteMercadoPago],
        log: Optional[LogExecucao] = None,
    ) -> int:
        """Vendas herdadas antes de 06/11 não têm os lançamentos de caixa copiados: lê os relatórios
        de liberações dos dias delas (pedidos no início da execução) e copia. Falha num relatório
        deixa para a próxima execução."""
        faltam = self._sem_caixa_lido(herdados)
        if not faltam or cliente_mp is None:
            return 0
        copiados = 0
        for de, ate in self._faixas(faltam):
            try:
                linhas = ml.expandir_liberacoes(cliente_mp.liberacoes(de, ate))
            except Exception as e:
                if log:
                    log.aviso(f"Relatório de liberações de {de:%d/%m/%Y} a {ate:%d/%m/%Y} (tarifas das vendas antigas) não lido: {e}")
                continue
            for g in faltam:
                try:
                    dia = datetime.strptime(g.data, "%d/%m/%Y").date()
                except ValueError:
                    continue
                if g.caixa_lido or not (de <= dia <= ate):
                    continue
                achado = self._lancamentos_no_relatorio(empresa, g, linhas, docs.get(int(g.conta_id), ""))
                g.caixa_lido = True
                if achado is None:
                    continue
                lancs, pendentes = achado
                g.lancamentos_caixa = [ml._para_json(dataclasses.asdict(l)) for l in lancs]
                copiados += 1
                if pendentes and log:
                    log.aviso(
                        f"Venda {g.id_venda}: {len(pendentes)} linha(s) do relatório para conferência ("
                        + "; ".join(f"{p.tipo_operacao} R$ {abs(p.valor).quantize(Decimal('0.01'))}: {p.motivo}" for p in pendentes)
                        + ")"
                    )
        if log:
            log.info(f"Consolidada: tarifas de {copiados} venda(s) antiga(s) lidas do relatório do dia da liberação.")
        return copiados

    def _ja_no_caixa(self, incluir_exportados: bool = False) -> Set[str]:
        """Chaves que não podem ser lançadas: as lançadas pela API (inclusive as incertas) e, salvo
        pedido explícito, as que saíram numa planilha."""
        dados = self.estado.ler()
        ja = set(dados.get("lancamentos_tiny") or {}) | set(dados.get("lancamentos_tiny_incertos") or {})
        if not incluir_exportados:
            ja |= set(self.estado.lancamentos_exportados())
        return ja

    @staticmethod
    def _lancamentos_do_grupo(analise: ml.Analise, grupo: ml.GrupoRecebimento) -> Tuple[List[ml.Lancamento], Set[str]]:
        """Lançamentos de caixa da venda: os da análise (que estão na planilha) + a cópia do grupo.
        Devolve (lançamentos, chaves dos que estão na planilha)."""
        candidatos = ml.lancamentos_da_venda(analise.movimentos, analise.lancamentos.lancamentos, grupo.id_venda)
        na_planilha = {ml.chave_lancamento(l) for l in candidatos}
        vistos = set(na_planilha)
        for d in grupo.lancamentos_caixa:
            lanc = ml.lancamento_de_json(d)
            if ml.chave_lancamento(lanc) not in vistos:
                vistos.add(ml.chave_lancamento(lanc))
                candidatos.append(lanc)
        return ml.ajustar_lancamentos_parcelamento(candidatos, grupo), na_planilha

    # --- tarifas depois da baixa ----------------------------------------------------------------

    def tarifas_pendentes(self, empresa_id: str, incluir_exportados: bool = False) -> Dict[str, Any]:
        """
        Vendas já baixadas (CONCILIADO na consolidada) com tarifas, envios ou extras que ainda não
        entraram no caixa do Tiny. Com `incluir_exportados`, entram também as linhas que saíram numa
        planilha (só se a planilha NÃO foi importada no Tiny: senão duplica).
        """
        empresa = ml.EMPRESAS_ML.get(empresa_id)
        if empresa is None:
            raise KeyError(empresa_id)
        cons = self.estado.analise(f"consolidado_{empresa.id}")
        exportados = set(self.estado.lancamentos_exportados())
        ja = self._ja_no_caixa(incluir_exportados)
        vendas: List[Dict[str, Any]] = []
        sem_leitura = 0
        if cons is not None:
            presentes = {m.chave for m in cons.movimentos if m.chave}
            for g in cons.grupos:
                if g.situacao != ml.SIT_CONCILIADO or not g.conta_id:
                    continue
                lancs, _ = self._lancamentos_do_grupo(cons, g)
                if not lancs and not g.caixa_lido and not any(c in presentes for c in g.chaves):
                    sem_leitura += 1
                    continue
                linhas = [
                    {
                        "chave": ml.chave_lancamento(l),
                        "tipo_operacao": l.tipo_operacao,
                        "categoria": l.categoria,
                        "historico": l.historico,
                        "tipo": l.tipo,
                        "valor": float(l.valor),
                        "na_planilha": ml.chave_lancamento(l) in exportados,
                    }
                    for l in lancs
                    if ml.chave_lancamento(l) not in ja
                ]
                if linhas:
                    vendas.append({
                        "grupo_id": g.id, "id_venda": g.id_venda, "nome_cliente": g.nome_cliente,
                        "conta_id": g.conta_id, "data_venda": g.data_venda, "data_liberacao": g.data,
                        "baixado_em": g.baixado_em, "linhas": linhas,
                    })
        vendas.sort(key=lambda v: ml._chave_data(v["data_venda"] or v["data_liberacao"]), reverse=True)
        return {
            "empresa": empresa.id,
            "incluir_exportados": incluir_exportados,
            "vendas": vendas,
            "total_vendas": len(vendas),
            "total_linhas": sum(len(v["linhas"]) for v in vendas),
            "vendas_sem_leitura": sem_leitura,
            "padrao_antigo": self._padrao_antigo(empresa, cons),
        }

    def _padrao_antigo(self, empresa: ml.EmpresaML, cons: Optional[ml.Analise]) -> List[Dict[str, Any]]:
        """Lançamentos de caixa feitos pela API antes do padrão do financeiro de 06/11/2026 (histórico
        próprio e contato = cliente; os novos guardam a empresa). Só os das vendas desta empresa. Os
        marcados como refeitos à mão (`marcar_refeitos`) saem da lista."""
        if cons is None:
            return []
        vendas = {g.id_venda for g in cons.grupos if g.id_venda}
        saida = [
            {"chave": chave, "id": info.get("id"), "venda": info.get("venda"), "data": info.get("data"),
             "valor": float(ml.para_decimal(info.get("valor"))), "tipo": info.get("tipo"),
             "historico": info.get("historico") or "", "em": info.get("em")}
            for chave, info in self.estado.lancamentos_tiny().items()
            if info.get("id") and not info.get("empresa") and not info.get("refeito_manual") and info.get("venda") in vendas
        ]
        saida.sort(key=lambda x: (str(x["data"] or ""), str(x["venda"] or "")), reverse=True)
        return saida

    def marcar_refeitos(self, empresa_id: str, chaves: List[str], usuario: str = "") -> Dict[str, Any]:
        """
        Lançamentos do padrão antigo que o financeiro apagou e REFEZ À MÃO no Tiny (09/11/2026, 10 da
        Campinas). Continuam contando como lançados (nunca voltam para as pendentes) e saem da lista do
        padrão antigo, então "Conferir no Tiny" não os devolve mais — senão quem lançasse pela tela
        duplicaria o que já está no caixa. Só aceita chaves que estão hoje no padrão antigo da empresa.
        """
        empresa = ml.EMPRESAS_ML.get(empresa_id)
        if empresa is None:
            raise KeyError(empresa_id)
        antigos = {a["chave"] for a in self._padrao_antigo(empresa, self.estado.analise(f"consolidado_{empresa.id}"))}
        pedidas = list(dict.fromkeys(chaves))
        validas = [c for c in pedidas if c in antigos]
        with self._baixas_lock:
            if empresa.id in self._baixas_em_andamento:
                raise EmExecucao(f"Já existe uma baixa ou lançamento em andamento para {empresa.nome}. Aguarde terminar.")
            self._baixas_em_andamento.add(empresa.id)
        try:
            if validas:
                marca = {"por": usuario or "", "em": agora()}
                with self.estado.alterar() as dados:
                    registro = dados.get("lancamentos_tiny") or {}
                    for chave in validas:
                        if chave in registro:
                            registro[chave]["refeito_manual"] = dict(marca)
                logger.info(f"[CONCILIACAO_ML] {len(validas)} lançamento(s) do padrão antigo de {empresa.nome} "
                            f"marcados como refeitos à mão{f' por {usuario}' if usuario else ''}.")
            return {"empresa": empresa.id, "marcados": len(validas), "ignorados": len(pedidas) - len(validas)}
        finally:
            with self._baixas_lock:
                self._baixas_em_andamento.discard(empresa.id)

    def conferir_apagados(self, empresa_id: str) -> Dict[str, Any]:
        """
        Para refazer no padrão novo os lançamentos do padrão antigo: o financeiro apaga no Tiny os
        antigos e esta conferência procura cada um no caixa (GET /caixa do dia). O que NÃO está mais
        lá deixa de contar como lançado e volta para as tarifas pendentes. Dia que não deu para ler
        (erro ou lista no limite de páginas) não libera nada. Nunca apaga nada no Tiny.
        """
        empresa = ml.EMPRESAS_ML.get(empresa_id)
        if empresa is None:
            raise KeyError(empresa_id)
        token = self.obter_token_tiny(empresa.id)
        if not token:
            raise RuntimeError(f"Token do Tiny não configurado para {empresa.nome}.")
        antigos = self._padrao_antigo(empresa, self.estado.analise(f"consolidado_{empresa.id}"))
        with self._baixas_lock:
            if empresa.id in self._baixas_em_andamento:
                raise EmExecucao(f"Já existe uma baixa ou lançamento em andamento para {empresa.nome}. Aguarde terminar.")
            self._baixas_em_andamento.add(empresa.id)
        try:
            ids_por_dia: Dict[str, Optional[Set[str]]] = {}
            for dia in sorted({str(a["data"]) for a in antigos if a["data"]}):
                try:
                    itens = self.tiny.list_caixa_v3(token, data_inicial=dia, data_final=dia, max_pages=PAGINAS_CAIXA_DIA)
                except Exception as e:
                    logger.warning(f"[CONCILIACAO_ML] Caixa de {dia} não lido ({empresa.nome}): {e}")
                    ids_por_dia[dia] = None
                    continue
                cheio = len(itens) >= PAGINAS_CAIXA_DIA * 100
                ids_por_dia[dia] = None if cheio else {str(i.get("id")) for i in itens if i.get("id")}
            apagados = [a for a in antigos if ids_por_dia.get(str(a["data"])) is not None
                        and str(a["id"]) not in ids_por_dia[str(a["data"])]]
            nao_lidos = sum(1 for a in antigos if ids_por_dia.get(str(a["data"])) is None)
            if apagados:
                with self.estado.alterar() as dados:
                    tiny_reg = dados.get("lancamentos_tiny") or {}
                    exportados = dados.get("lancamentos_exportados") or {}
                    for a in apagados:
                        info = tiny_reg.pop(a["chave"], None) or {}
                        # Só tira a marca de "exportado" que o próprio lançamento pôs (mesmo dia).
                        if exportados.get(a["chave"]) and exportados[a["chave"]] == str(info.get("em") or "")[:10]:
                            exportados.pop(a["chave"], None)
            return {
                "empresa": empresa.id,
                "conferidos": len(antigos),
                "liberados": len(apagados),
                "ainda_no_tiny": len(antigos) - len(apagados) - nao_lidos,
                "nao_conferidos": nao_lidos,
            }
        finally:
            with self._baixas_lock:
                self._baixas_em_andamento.discard(empresa.id)

    def lancar_tarifas(
        self,
        empresa_id: str,
        grupo_ids: List[str],
        incluir_exportados: bool = False,
        usuario: str = "",
        progresso: Optional[Progresso] = None,
    ) -> Dict[str, Any]:
        """Lança no caixa do Tiny as tarifas, envios e extras de vendas JÁ baixadas (mesmas regras da
        baixa: valores do relatório, data da venda, histórico da conta, contato Mercado Livre, nunca repetindo)."""
        empresa = ml.EMPRESAS_ML.get(empresa_id)
        if empresa is None:
            raise KeyError(empresa_id)
        cons = self.estado.analise(f"consolidado_{empresa.id}")
        if cons is None:
            raise KeyError(f"consolidado_{empresa.id}")
        token = self.obter_token_tiny(empresa.id)
        if not token:
            raise RuntimeError(f"Token do Tiny não configurado para {empresa.nome}: nada foi lançado.")
        with self._baixas_lock:
            if empresa.id in self._baixas_em_andamento:
                raise EmExecucao(f"Já existe uma baixa ou lançamento em andamento para {empresa.nome}. Aguarde terminar.")
            self._baixas_em_andamento.add(empresa.id)
        log = LogExecucao()
        log.empresa = empresa.nome
        inicio = agora()
        resultados: List[Dict[str, Any]] = []
        total_criados = falhas = 0
        ids = list(dict.fromkeys(grupo_ids))
        try:
            conta_destino_id, _ = self.resolvedor.ids(empresa)
            por_id = {g.id: g for g in cons.grupos}
            log.info(f"Lançamento de tarifas de {len(ids)} venda(s) baixada(s){f' por {usuario}' if usuario else ''}.")
            for n, gid in enumerate(ids):
                g = por_id.get(gid)
                base: Dict[str, Any] = {"grupo_id": gid}
                if g is None or g.situacao != ml.SIT_CONCILIADO or not g.conta_id:
                    resultados.append({**base, "status": "erro", "mensagem": "Venda não está baixada na visão consolidada."})
                    falhas += 1
                    continue
                base.update(id_venda=g.id_venda, nome_cliente=g.nome_cliente, conta_id=g.conta_id)
                if progresso:
                    progresso(f"Lançando as tarifas da venda {g.id_venda} ({g.nome_cliente})", n, len(ids))
                if not g.data_venda:
                    self._completar_data_venda(empresa, [g])
                if not g.data_venda:
                    resultados.append({**base, "status": "erro", "mensagem": ml.MSG_SEM_DATA_VENDA})
                    falhas += 1
                    continue
                try:
                    contas = []
                    ids_contas = [int(c["id"]) for c in g.contas_vinculadas if c.get("id")] or [int(g.conta_id)]
                    for cid in ids_contas:
                        contas.append({**self.tiny.obter_conta_receber_v3(token, cid), "id": cid})
                    criados, problemas = self._lancar_caixa_da_venda(
                        empresa, cons, g, token, conta_destino_id, contas, usuario, log,
                        incluir_exportados=incluir_exportados,
                    )
                except Exception as e:
                    log.erro(f"Venda {g.id_venda}: tarifas não lançadas: {e}")
                    resultados.append({**base, "status": "erro", "mensagem": str(e)})
                    falhas += 1
                    continue
                total_criados += criados
                msg = f"{criados} lançamento(s) de caixa criado(s) no Tiny." if criados else "Nada lançado."
                if problemas:
                    msg += f" {len(problemas)} não entraram: " + "; ".join(problemas)
                status = "sucesso" if criados and not problemas else ("parcial" if criados else "erro")
                falhas += status == "erro"
                resultados.append({**base, "status": status, "mensagem": msg})
        finally:
            with self._baixas_lock:
                self._baixas_em_andamento.discard(empresa.id)
            sucessos = sum(r["status"] != "erro" for r in resultados)
            status_exec = "ok" if falhas == 0 else ("parcial" if sucessos else "erro")
            log.empresa = ""
            log.info(f"Lançamento de tarifas concluído: {total_criados} lançamento(s) criado(s), {falhas} venda(s) com falha.")
            with self.estado.alterar() as dados:
                self.estado.registrar_execucao(dados, {
                    "id": uuid.uuid4().hex[:12], "tipo": "tarifas", "origem": "manual", "usuario": usuario,
                    "iniciada_em": inicio, "concluida_em": agora(), "status": status_exec,
                    "periodo_de": cons.periodo_de, "periodo_ate": cons.periodo_ate,
                    "empresas": {empresa.id: {"status": status_exec, "analise_id": cons.id, "mensagem": "",
                                              "tarifas": {"lancamentos": total_criados, "falhas": falhas}}},
                    "log": log.linhas,
                })
        return {
            "status": "concluido" if falhas == 0 else ("parcial" if total_criados else "erro"),
            "total_solicitados": len(ids),
            "total_lancamentos": total_criados,
            "total_falhas": falhas,
            "resultados": resultados,
        }

    def _lancamento_no_caixa(self, token: str, data_iso: str, lanc: ml.Lancamento, historico: str) -> Optional[int]:
        """Depois de uma resposta ambígua: o lançamento já está no caixa (mesma data, tipo, valor e
        histórico, e ainda não registrado)? Devolve o id só se houver UM; None se não está, se há
        mais de um igual (o histórico é o da conta, comum às linhas da venda) ou se não deu para conferir."""
        try:
            itens = self.tiny.list_caixa_v3(token, data_inicial=data_iso, data_final=data_iso, tipo=lanc.tipo, max_pages=5)
        except Exception as e:
            logger.warning(f"[CONCILIACAO_ML] Conferência do caixa em {data_iso} falhou: {e}")
            return None
        registrados = {str(v.get("id")) for v in self.estado.lancamentos_tiny().values() if v.get("id")}
        achados = [
            int(item["id"]) for item in itens
            if item.get("id") and str(item["id"]) not in registrados
            and str(item.get("historico") or "").strip() == historico.strip()
            and abs(ml.para_decimal(item.get("valor")) - lanc.valor) < Decimal("0.01")
        ]
        return achados[0] if len(achados) == 1 else None

    def _concluir_pendente(self, chave_pendente: str, chaves: List[str]) -> None:
        with self.estado.alterar() as dados:
            self.estado.registrar_baixas(dados, list(chaves))
            (dados.get("baixas_pendentes") or {}).pop(chave_pendente, None)

    def _baixar_parte(
        self,
        tipo: str,
        *,
        token: str,
        conta: Dict[str, Any],
        chave: str,
        valor: Decimal,
        data_baixa: str,
        conta_destino_id: int,
        categoria_id: int,
        grupo: ml.GrupoRecebimento,
        usuario: str,
        partes_concluidas: Set[str],
        log: LogExecucao,
    ) -> None:
        """
        Baixa uma parte (`prod` ou `frete`) de uma conta a receber com tentativa isolada: registra a
        tentativa pendente, faz o POST e, se o Tiny responder com erro, relê a conta para saber se a
        baixa entrou antes de repetir ou desistir. Atualiza `valorPago`/`saldo` da conta em memória
        (Decimal) e marca a parte como concluída.
        """
        nome = "produto" if tipo == "prod" else "frete"
        cid = int(conta["id"])
        tentativa = {
            "chaves": list(grupo.chaves),
            "conta_id": cid,
            "valor": str(valor),
            "valor_pago_antes": _texto_ou_none(conta.get("valorPago")),
            "saldo_antes": _texto_ou_none(conta.get("saldo")),
            "em": agora(),
            "usuario": usuario,
            "tipo": tipo,
        }
        with self.estado.alterar() as dados:
            dados.setdefault("baixas_pendentes", {})[chave] = tentativa
        try:
            self.tiny.baixar_conta_receber_v3(
                token, cid, valor_pago=valor, data_pagamento=data_baixa,
                conta_destino_id=conta_destino_id, categoria_id=categoria_id,
            )
        except Exception as erro:
            try:
                c_depois = self.tiny.obter_conta_receber_v3(token, cid)
                entrou = baixa_entrou(tentativa, c_depois)
            except Exception as erro_leitura:
                # Sem a releitura não dá para saber se a baixa entrou: fica incerto (e registrado).
                log.aviso(
                    f"Conta #{cid} ({nome}): a releitura de conferência falhou "
                    f"({type(erro_leitura).__name__}: {erro_leitura})."
                )
                entrou = None
            if entrou is True:
                log.aviso(f"Conta #{cid} ({nome}): o Tiny respondeu com erro ({erro}), mas a baixa entrou.")
            elif entrou is False:
                self._descartar_pendente(chave)
                raise erro
            else:
                raise RuntimeError(
                    f"{erro} — sem confirmação do Tiny se a baixa de {nome} da conta #{cid} entrou. "
                    f"Confira no Tiny; a próxima tentativa confere antes de repetir."
                ) from erro

        with self.estado.alterar() as dados:
            dados.setdefault("baixas_partes", {})[chave] = agora()
            (dados.get("baixas_pendentes") or {}).pop(chave, None)
        partes_concluidas.add(chave)
        conta["valorPago"] = ml.para_decimal(conta.get("valorPago")) + valor
        conta["saldo"] = ml.para_decimal(conta.get("saldo")) - valor

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
            "proxima_execucao": proxima_execucao(self.cfg).astimezone(FUSO_SP).isoformat(timespec="seconds"),
            "hora_diaria": self.cfg.ML_RECONCILIATION_HOUR,
            # O botão "Sincronizar Tokens ML" só renova com credenciais do TMS (ou OAuth próprio) neste
            # serviço. Sem elas, quem renova é o cron do servidor (scripts/sync_ml_tokens.py; ver scripts/README.md).
            "renovacao_tokens_no_painel": bool(
                (self.cfg.TMS_USER and self.cfg.TMS_PASSWORD) or self.cfg.ML_OAUTH_RENOVACAO_PROPRIA
            ),
            "periodo_padrao": [d.isoformat() for d in periodo_padrao()],
            "erro_gravacao": self.estado.erro_gravacao(),
        }

    def pendencias(self) -> Dict[str, Any]:
        """
        O que ainda falta fazer na última análise de cada empresa, recalculado AGORA: recebimentos
        aptos que ainda não foram baixados (o resumo da análise fica congelado no momento em que
        ela rodou) e lançamentos de caixa que ainda não saíram em nenhuma planilha exportada.
        """
        dados = self.estado.ler()
        baixas = dict(dados.get("baixas") or {})
        legado = ml.prefixos_legado(baixas)
        exportados = self.estado.lancamentos_exportados()
        # A visão consolidada (acumulada, sem corte por data) tem precedência; sem ela, a última análise da empresa.
        ultimas: Dict[str, Dict[str, Any]] = {}
        for cab in reversed(dados["analises"]):
            if str(cab.get("analise_id", "")).startswith("consolidado_"):
                ultimas[cab["empresa"]] = cab
            elif not str(ultimas.get(cab["empresa"], {}).get("analise_id", "")).startswith("consolidado_"):
                ultimas.setdefault(cab["empresa"], cab)
        empresas = []
        for e in ml.EMPRESAS_ML.values():
            cab = ultimas.get(e.id)
            analise = self.estado.analise(cab["analise_id"]) if cab else None
            if analise is None:
                empresas.append({"id": e.id, "nome": e.nome, "analise_id": None, "analise_criada_em": None,
                                 "aptos_baixa": 0, "valor_aptos_baixa": 0.0, "lancamentos_nao_exportados": 0})
                continue
            aptos = [g for g in analise.grupos if g.pode_baixar and not g.ja_baixado(baixas, legado)]
            nao_exportados = [l for l in analise.lancamentos.lancamentos if ml.chave_lancamento(l) not in exportados]
            empresas.append({
                "id": e.id,
                "nome": e.nome,
                "analise_id": cab["analise_id"],
                "analise_criada_em": cab.get("criada_em"),
                "aptos_baixa": len(aptos),
                "valor_aptos_baixa": dinheiro_json(sum((g.valor_total for g in aptos), Decimal("0"))),
                "lancamentos_nao_exportados": len(nao_exportados),
            })
        return {"empresas": empresas}


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
