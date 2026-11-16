"""
Contagem conferida → estoque do Tiny v3.

Regra do usuário (2026-10-14): o Tiny só GANHA o que falta. Tiny com 10 e contagem de 50 → entrada
de +40. Tiny com o contado ou mais → nada é lançado (a automação nunca tira estoque).

A diferença é sempre calculada contra o saldo ATUAL do depósito, então reenviar a mesma contagem
depois de um lançamento não duplica a entrada (o saldo já subiu). O POST de entrada nunca é
repetido sozinho: sem resposta, o saldo é relido para saber se a entrada entrou.

A observação de cada lançamento começa com "Auditoria {data} lançamento {ID} - ...", com o
número e a data da contagem como aparecem no painel (app/auditoria.py).
"""
import contextlib
import json
import logging
import os
import random
import tempfile
import threading
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

import requests

from app.auditoria import cabecalho, formatar_numero
from app.config import TinySettings

logger = logging.getLogger("contagem_estoque.tiny")

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; NorviaAutomacao/1.0; +https://norvia.example)",
}
OBSERVACOES_MAX = 250

# Decisão do usuário (2026-10-14): o estoque contado é SÓ da Revesta e em hipótese alguma vai
# para outra filial. Por isso a conta é constante (sem variável de ambiente) e o token só é usado
# se o CNPJ cadastrado na api_tokens for o da Revesta (ou estiver vazio).
CONTA_TINY = "revesta"
CNPJ_REVESTA = "36592814000100"

_throttle_lock = threading.Lock()
_ultima_chamada = 0.0
# Um ajuste por vez: duas conferências seguidas do mesmo SKU leriam o mesmo saldo e lançariam a
# diferença duas vezes. ATENÇÃO: a trava é por PROCESSO. O serviço roda com 1 processo (a API é
# uma thread do bot); exigir_processo_unico() recusa a subida com mais de um worker, e o arquivo
# de lançamentos (HistoricoLancamentos) ainda protege com flock entre processos do mesmo volume.
_ajuste_lock = threading.Lock()


def exigir_processo_unico(ambiente: Optional[Dict[str, str]] = None) -> None:
    """Falha na subida se o uvicorn/gunicorn foi configurado com mais de 1 worker (EST-02)."""
    env = os.environ if ambiente is None else ambiente
    for nome in ("WEB_CONCURRENCY", "UVICORN_WORKERS"):
        bruto = (env.get(nome) or "").strip()
        if bruto.isdigit() and int(bruto) > 1:
            raise RuntimeError(
                f"{nome}={bruto}: a contagem de estoque exige 1 processo (a trava de ajuste é por processo; "
                "com mais de um, duas contagens do mesmo SKU poderiam lançar a entrada em duplicidade)."
            )


class HistoricoLancamentos:
    """
    Entradas já lançadas no Tiny por registro_id (arquivo JSON atômico): o mesmo registro nunca
    lança duas vezes, mesmo se a resposta se perdeu e o painel reenviou. O flock em arquivo
    irmão serializa também processos diferentes que dividam a pasta.
    """

    def __init__(self, pasta: Path) -> None:
        self.pasta = Path(pasta)
        self.arquivo = self.pasta / "lancamentos_tiny.json"
        self._trava = self.pasta / ".lancamentos_tiny.lock"

    @contextlib.contextmanager
    def exclusivo(self) -> Iterator[None]:
        self.pasta.mkdir(parents=True, exist_ok=True)
        with open(self._trava, "a+") as f:
            try:
                import fcntl

                fcntl.flock(f, fcntl.LOCK_EX)
            except ImportError:  # Windows: sem flock, vale só a trava do processo
                pass
            yield

    def _ler(self) -> Dict[str, Any]:
        if not self.arquivo.exists():
            return {}
        try:
            return json.loads(self.arquivo.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            # Não recomeça do zero: perderia a proteção contra lançamento duplicado.
            raise RuntimeError(f"Histórico de lançamentos ilegível em {self.arquivo}: {e}") from e

    def obter(self, registro_id: str) -> Optional[Dict[str, Any]]:
        return self._ler().get(registro_id)

    def registrar(self, registro_id: str, resultado: Dict[str, Any]) -> None:
        dados = self._ler()
        dados[registro_id] = resultado
        fd, tmp = tempfile.mkstemp(dir=self.pasta, prefix=".lancamentos-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(dados, f, ensure_ascii=False)
            os.replace(tmp, self.arquivo)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


# Leituras (GET) repetem em 429/5xx/rede: backoff exponencial com jitter, respeitando Retry-After.
# Escrita (POST de entrada) nunca é repetida aqui: o desfecho é apurado relendo o saldo.
TENTATIVAS_LEITURA = 4
TETO_ESPERA_S = 60.0


class TinyAPIError(RuntimeError):
    """Falha de comunicação com o Tiny (HTTP, rede, token)."""

    def __init__(self, mensagem: str, status: Optional[int] = None) -> None:
        super().__init__(mensagem)
        self.status = status


def _espera_retry(tentativa: int, resp: Any = None) -> float:
    try:
        valor = float((getattr(resp, "headers", None) or {}).get("Retry-After", ""))
        if valor >= 0:
            return min(TETO_ESPERA_S, valor)
    except (TypeError, ValueError):
        pass
    return min(TETO_ESPERA_S, 2.0 * (2 ** (tentativa - 1)) + random.uniform(0, 1))


def _dormir(segundos: float) -> None:
    time.sleep(segundos)


class EstoqueTinyErro(RuntimeError):
    """Situação de negócio que impede o lançamento (SKU não encontrado, depósito ambíguo...)."""


def _dec(valor: Any) -> Decimal:
    try:
        return Decimal(str(valor if valor is not None else 0))
    except (InvalidOperation, ValueError):
        return Decimal(0)


def _numero_json(valor: Decimal, casas: int) -> Any:
    """
    Decimal → número JSON sem perda: arredonda em `casas` e devolve int (inteiro) ou float (o
    json grava o menor texto que volta ao mesmo número, ex.: 2.5, 11.75). Recusa o que passaria de
    15 dígitos significativos, onde o float já não representa o decimal.
    """
    q = valor.quantize(Decimal(1).scaleb(-casas))
    if len(q.as_tuple().digits) > 15:
        raise EstoqueTinyErro(f"Valor {valor} grande demais para enviar ao Tiny sem perder precisão.")
    return int(q) if q == q.to_integral() else float(q)


def _fmt(valor: Decimal) -> str:
    """40 em vez de 40.000; 2.5 continua 2.5."""
    return format(valor.quantize(Decimal(1)) if valor == valor.to_integral() else valor.normalize(), "f")


def _erro_legivel(resp: Any) -> str:
    """{"mensagem": "...", "detalhes": [{"campo", "mensagem"}]} do Tiny → "mensagem (campo: mensagem)"."""
    try:
        corpo = resp.json()
    except ValueError:
        corpo = None
    if isinstance(corpo, dict) and corpo.get("mensagem"):
        detalhes = [
            f"{d.get('campo')}: {d.get('mensagem')}" if d.get("campo") else str(d.get("mensagem"))
            for d in (corpo.get("detalhes") or [])
            if isinstance(d, dict) and d.get("mensagem")
        ]
        return str(corpo["mensagem"]) + (f" ({'; '.join(detalhes)})" if detalhes else "")
    return str(getattr(resp, "text", ""))[:300]


class ClienteTinyEstoque:
    def __init__(
        self,
        token: Callable[[], Optional[str]],
        cfg: TinySettings,
        http: Any = None,
    ) -> None:
        self._token = token
        self.cfg = cfg
        self.http = http or requests.Session()
        self.base_url = cfg.TINY_API_URL.rstrip("/")

    def _throttle(self) -> None:
        global _ultima_chamada
        with _throttle_lock:
            espera = self.cfg.TINY_PAUSA_S - (time.monotonic() - _ultima_chamada)
            if espera > 0:
                time.sleep(espera)
            _ultima_chamada = time.monotonic()

    def _chamar(self, metodo: str, caminho: str, descricao: str, **kwargs: Any) -> Any:
        token = self._token()
        if not token:
            raise TinyAPIError(f"Sem token do Tiny para a conta {CONTA_TINY} (tabela api_tokens).")
        leitura = metodo.upper() == "GET"
        tentativas = TENTATIVAS_LEITURA if leitura else 1
        for tentativa in range(1, tentativas + 1):
            self._throttle()
            try:
                resp = self.http.request(
                    metodo,
                    f"{self.base_url}{caminho}",
                    headers={**HEADERS, "Authorization": f"Bearer {token}"},
                    timeout=(5, 25),
                    **kwargs,
                )
            except requests.RequestException:
                if tentativa == tentativas:
                    raise
                _dormir(_espera_retry(tentativa))
                continue
            if leitura and (resp.status_code == 429 or resp.status_code >= 500) and tentativa < tentativas:
                _dormir(_espera_retry(tentativa, resp))
                continue
            break
        if not 200 <= resp.status_code < 300:
            raise TinyAPIError(
                f"o Tiny respondeu HTTP {resp.status_code} ao {descricao}: {_erro_legivel(resp)}", resp.status_code
            )
        try:
            return resp.json() if resp.content else {}
        except ValueError:
            return {}

    def buscar_produto(self, sku: str) -> Dict[str, Any]:
        """Produto pelo código (SKU), com correspondência exata: a busca da API é por trecho."""
        pagina = self._chamar("GET", "/produtos", f"buscar o produto {sku}", params={"codigo": sku, "limit": 100})
        itens: List[Dict[str, Any]] = (pagina or {}).get("itens") or []
        alvo = sku.strip().upper()
        exatos = [p for p in itens if str(p.get("sku") or p.get("codigo") or "").strip().upper() == alvo]
        if not exatos:
            raise EstoqueTinyErro(f"SKU {sku} não encontrado no Tiny.")
        if len(exatos) > 1:
            raise EstoqueTinyErro(f"Mais de um produto com o SKU {sku} no Tiny: ajuste manualmente.")
        return exatos[0]

    def estoque(self, id_produto: int) -> Dict[str, Any]:
        """GET /estoque/{idProduto}: saldo total e por depósito."""
        return self._chamar("GET", f"/estoque/{id_produto}", f"ler o estoque do produto #{id_produto}") or {}

    def preco_custo(self, id_produto: int) -> Decimal:
        """
        Preço unitário da entrada (o Tiny exige `precoUnitario`): o custo médio do produto, para a
        entrada da contagem não mexer no custo médio; sem ele, o preço de custo; sem os dois, 0.
        """
        produto = self._chamar("GET", f"/produtos/{id_produto}", f"ler o produto #{id_produto}") or {}
        precos = produto.get("precos") if isinstance(produto.get("precos"), dict) else {}
        for chave in ("precoCustoMedio", "precoCusto"):
            valor = _dec(precos.get(chave, produto.get(chave)))
            if valor > 0:
                return valor
        return Decimal(0)

    def lancar_entrada(
        self, id_produto: int, deposito_id: Any, quantidade: Decimal, observacoes: str, preco_unitario: Decimal
    ) -> Optional[int]:
        """POST /estoque/{idProduto} tipo "E" (entrada). Devolve o id do lançamento quando vem."""
        corpo = self._chamar(
            "POST",
            f"/estoque/{id_produto}",
            f"lançar a entrada de estoque do produto #{id_produto}",
            json={
                "deposito": {"id": int(deposito_id)},
                "tipo": "E",
                "quantidade": _numero_json(quantidade, 4),
                "precoUnitario": _numero_json(preco_unitario, 4),
                "observacoes": observacoes[:OBSERVACOES_MAX],
            },
        )
        id_lanc = (corpo or {}).get("idLancamento") or (corpo or {}).get("id")
        return int(id_lanc) if id_lanc else None


def escolher_deposito(estoque: Dict[str, Any], deposito_id: Optional[int]) -> Dict[str, Any]:
    """
    Depósito da contagem: o configurado (CONTAGEM_TINY_DEPOSITO_ID) ou, sem configuração, o único
    depósito considerado no saldo. Com mais de um não dá para adivinhar onde fica a prateleira
    contada: pede a configuração em vez de lançar no lugar errado.
    """
    depositos = [d for d in (estoque.get("depositos") or []) if isinstance(d, dict)]
    if deposito_id:
        for d in depositos:
            if str(d.get("id")) == str(deposito_id):
                return d
        raise EstoqueTinyErro(f"Depósito {deposito_id} (CONTAGEM_TINY_DEPOSITO_ID) não aparece no estoque do produto no Tiny.")
    considerados = [d for d in depositos if not d.get("desconsiderar")]
    if len(considerados) == 1:
        return considerados[0]
    if not considerados:
        raise EstoqueTinyErro("O produto não tem depósito de estoque no Tiny.")
    nomes = ", ".join(f"{d.get('nome')} ({d.get('id')})" for d in considerados)
    raise EstoqueTinyErro(f"O produto tem mais de um depósito no Tiny ({nomes}): configure CONTAGEM_TINY_DEPOSITO_ID.")


def consultar_produto(cliente: ClienteTinyEstoque, sku: str) -> Dict[str, Any]:
    """
    Só leitura, para a conferência no painel: nome do produto (confere se o SKU é o certo) e saldo
    atual do depósito no Tiny (compara com a foto). Depósito ambíguo não impede mostrar o nome:
    volta saldo None com o aviso.
    """
    produto = cliente.buscar_produto(sku)
    id_produto = int(produto["id"])
    estoque = cliente.estoque(id_produto)
    base = {
        "sku": sku,
        "id_produto": id_produto,
        "produto": str(produto.get("descricao") or estoque.get("nome") or ""),
        "unidade": str(produto.get("unidade") or estoque.get("unidade") or ""),
    }
    try:
        deposito = escolher_deposito(estoque, cliente.cfg.CONTAGEM_TINY_DEPOSITO_ID)
    except EstoqueTinyErro as e:
        return {**base, "deposito": None, "saldo": None, "aviso": str(e)}
    return {
        **base,
        "deposito": str(deposito.get("nome") or deposito.get("id")),
        "saldo": float(_dec(deposito.get("saldo"))),
        "aviso": None,
    }


def ajustar_contagem(
    cliente: ClienteTinyEstoque,
    sku: str,
    quantidade_contada: int,
    registro_id: str,
    numero: int,
    criado_em: str,
    usuario: str = "",
    historico: Optional[HistoricoLancamentos] = None,
) -> Dict[str, Any]:
    """
    Compara a contagem (em unidades) com o saldo do depósito no Tiny e lança só a entrada que falta.
    status "lancado" (entrou a diferença) ou "sem_entrada" (o Tiny já tem o contado ou mais).
    """
    deposito_cfg = cliente.cfg.CONTAGEM_TINY_DEPOSITO_ID
    contado = Decimal(quantidade_contada)
    auditoria = cabecalho(numero, criado_em)
    with _ajuste_lock, (historico.exclusivo() if historico else contextlib.nullcontext()):
        # Idempotência por registro: o mesmo registro (mesmo SKU e quantidade) já lançado com
        # sucesso não lança de novo, nem que o saldo do Tiny tenha mudado depois.
        if historico is not None:
            anterior = historico.obter(registro_id)
            if anterior and anterior.get("sku") == sku and anterior.get("contado") == int(contado):
                logger.info("[TINY] registro %s já lançado (%s); nada a fazer", registro_id, sku)
                return {**anterior, "repetido": True}
        resultado = _ajustar(cliente, sku, contado, registro_id, numero, auditoria, usuario, deposito_cfg)
        if historico is not None and resultado["status"] == "lancado":
            historico.registrar(registro_id, resultado)
        return resultado


def _ajustar(
    cliente: ClienteTinyEstoque,
    sku: str,
    contado: Decimal,
    registro_id: str,
    numero: int,
    auditoria: str,
    usuario: str,
    deposito_cfg: Optional[int],
) -> Dict[str, Any]:
    produto = cliente.buscar_produto(sku)
    id_produto = int(produto["id"])
    deposito = escolher_deposito(cliente.estoque(id_produto), deposito_cfg)
    saldo = _dec(deposito.get("saldo"))
    base = {
        "sku": sku,
        "id_produto": id_produto,
        "produto": str(produto.get("descricao") or ""),
        "deposito": str(deposito.get("nome") or deposito.get("id")),
        "saldo_anterior": float(saldo),
        "contado": int(contado),
        "auditoria": formatar_numero(numero),
    }
    entrada = contado - saldo
    if entrada <= 0:
        logger.info("[TINY] %s sem entrada: Tiny %s, contado %s (registro %s)", sku, saldo, contado, registro_id)
        return {**base, "status": "sem_entrada", "entrada": 0, "id_lancamento": None}

    obs = (
        f"{auditoria} - Divergência na contagem do SKU {sku}: contado {int(contado)}, "
        f"saldo no Tiny {_fmt(saldo)}, entrada de {_fmt(entrada)} (registro {registro_id}"
        + (f", {usuario})" if usuario else ")")
    )
    preco = cliente.preco_custo(id_produto)
    try:
        id_lanc = cliente.lancar_entrada(id_produto, deposito.get("id"), entrada, obs, preco)
    except (requests.RequestException, TinyAPIError) as e:
        if isinstance(e, TinyAPIError) and not (e.status and e.status >= 500):
            raise  # 4xx/token: o Tiny recusou, a entrada não entrou
        # Sem resposta ou 5xx: a entrada pode ter entrado. Relê o saldo em vez de repetir o POST.
        logger.warning("[TINY] %s sem resposta/5xx no lançamento (%s); relendo o saldo", sku, e)
        depois = _dec(escolher_deposito(cliente.estoque(id_produto), deposito_cfg).get("saldo"))
        if depois >= contado:
            return {**base, "status": "lancado", "entrada": float(entrada), "id_lancamento": None}
        raise TinyAPIError(
            f"O Tiny não respondeu ao lançar a entrada de {sku} e o saldo segue {_fmt(depois)}: envie de novo."
        ) from e
    logger.info(
        "[TINY] %s entrada %s (Tiny %s → contado %s) registro %s (%s) lançamento %s usuário %s",
        sku, _fmt(entrada), _fmt(saldo), int(contado), registro_id, auditoria, id_lanc, usuario,
    )
    return {**base, "status": "lancado", "entrada": float(entrada), "id_lancamento": id_lanc}


def token_da_revesta(linha: Optional[Dict[str, Any]]) -> Optional[str]:
    """Token da linha da api_tokens, só se for da Revesta (conta e, quando cadastrado, CNPJ)."""
    if not linha or not linha.get("access_token"):
        return None
    if str(linha.get("conta_identificador") or "").strip() != CONTA_TINY:
        raise TinyAPIError(f"Token da api_tokens não é da conta {CONTA_TINY}: lançamento bloqueado.")
    cnpj = "".join(c for c in str(linha.get("empresa_cnpj") or "") if c.isdigit())
    if cnpj and cnpj != CNPJ_REVESTA:
        raise TinyAPIError(f"Token da conta {CONTA_TINY} com CNPJ {cnpj}, diferente do da Revesta: lançamento bloqueado.")
    return str(linha["access_token"])


def token_tiny_do_banco(cfg: TinySettings) -> Callable[[], Optional[str]]:
    """Leitor do token da Revesta na tabela api_tokens (MariaDB do financeiro), como na automacoes-marketplace."""

    def ler() -> Optional[str]:
        if not cfg.banco_configurado():
            return None
        import pymysql
        from pymysql.cursors import DictCursor

        banco = cfg.TINY_TOKENS_DB.replace("`", "")
        conn = pymysql.connect(
            host=cfg.DB_HOST,
            port=int(cfg.DB_PORT),
            user=cfg.DB_USER,
            password=cfg.DB_PASSWORD.get_secret_value() if cfg.DB_PASSWORD else "",
            database=banco,
            charset="utf8mb4",
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=10,
        )
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT access_token, conta_identificador, empresa_cnpj FROM `{banco}`.api_tokens
                    WHERE servico = 'tiny_v3' AND conta_identificador = %s
                      AND access_token IS NOT NULL AND access_token != ''
                    ORDER BY atualizado_em DESC LIMIT 1
                    """,
                    (CONTA_TINY,),
                )
                linha = cur.fetchone()
        finally:
            conn.close()
        return token_da_revesta(linha)

    return ler
