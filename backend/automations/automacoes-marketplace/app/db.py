"""
MariaDB da automação de Marketplace (mesmo servidor da automacoes-financeiro, banco próprio):

- `<DB_NAME>.dimensoes_produtos` (banco `marketplace`): as medidas padronizadas e validadas de
  cada produto (por SKU), fonte única para as plataformas e para o tipo de frete. Criada aqui na
  primeira conexão.
- `<TINY_TOKENS_DB>.api_tokens` (só leitura, banco do financeiro): tokens do Tiny v3,
  renovados fora desta automação.

O repositório em memória tem a mesma interface e serve aos testes e ao modo sem banco.
"""
import json
import logging
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger("marketplace.db")

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:  # pragma: no cover - o requirements instala
    pymysql = None  # type: ignore[assignment]

CRIAR_TABELA = """
CREATE TABLE IF NOT EXISTS dimensoes_produtos (
    sku VARCHAR(80) NOT NULL PRIMARY KEY,
    descricao VARCHAR(255) NULL,
    altura_cm DECIMAL(10,2) NOT NULL,
    largura_cm DECIMAL(10,2) NOT NULL,
    comprimento_cm DECIMAL(10,2) NOT NULL,
    peso_g INT NULL,
    embalagem_comprimento_cm INT NULL,
    confiabilidade VARCHAR(10) NOT NULL,
    fontes LONGTEXT NULL,
    envios LONGTEXT NULL,
    validado_por VARCHAR(120) NULL,
    validado_em DATETIME NOT NULL,
    atualizado_em DATETIME NOT NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
"""

CAMPOS = (
    "sku", "descricao", "altura_cm", "largura_cm", "comprimento_cm", "peso_g",
    "embalagem_comprimento_cm", "confiabilidade", "fontes", "envios", "validado_por",
    "validado_em", "atualizado_em",
)


def _normalizar_linha(linha: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(linha)
    for k in ("altura_cm", "largura_cm", "comprimento_cm"):
        if out.get(k) is not None:
            out[k] = float(out[k])
    for k in ("fontes", "envios"):
        if isinstance(out.get(k), str):
            try:
                out[k] = json.loads(out[k])
            except ValueError:
                out[k] = None
    for k in ("validado_em", "atualizado_em"):
        if isinstance(out.get(k), datetime):
            out[k] = out[k].isoformat(timespec="seconds")
    return out


class RepositorioMemoria:
    """Mesma interface do MariaDB, em memória (testes / serviço sem banco configurado)."""

    def __init__(self) -> None:
        self._linhas: Dict[str, Dict[str, Any]] = {}
        self._tokens: Dict[str, str] = {}
        self._lock = threading.Lock()

    def listar(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {k: dict(v) for k, v in self._linhas.items()}

    def obter(self, sku: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            linha = self._linhas.get(sku)
            return dict(linha) if linha else None

    def salvar(self, linha: Dict[str, Any]) -> None:
        with self._lock:
            self._linhas[linha["sku"]] = {k: linha.get(k) for k in CAMPOS}

    def atualizar_envios(self, sku: str, envios: Dict[str, Any]) -> None:
        with self._lock:
            if sku in self._linhas:
                self._linhas[sku]["envios"] = envios

    def token_tiny(self, conta: str) -> Optional[str]:
        return self._tokens.get(conta)


class RepositorioMariaDB:
    def __init__(self) -> None:
        self._tabela_ok = False

    def _conexao(self):
        if pymysql is None:
            raise RuntimeError("Driver pymysql não instalado.")
        return pymysql.connect(
            host=settings.DB_HOST,
            port=int(settings.DB_PORT),
            user=settings.DB_USER,
            password=settings.DB_PASSWORD or "",
            database=settings.DB_NAME,
            charset="utf8mb4",
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=20,
            write_timeout=20,
            autocommit=True,
        )

    def _executar(self, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
        with self._conexao() as conn:
            with conn.cursor() as cur:
                if not self._tabela_ok:
                    cur.execute(CRIAR_TABELA)
                    self._tabela_ok = True
                cur.execute(sql, params)
                return list(cur.fetchall() or [])

    def listar(self) -> Dict[str, Dict[str, Any]]:
        return {l["sku"]: _normalizar_linha(l) for l in self._executar("SELECT * FROM dimensoes_produtos")}

    def obter(self, sku: str) -> Optional[Dict[str, Any]]:
        linhas = self._executar("SELECT * FROM dimensoes_produtos WHERE sku = %s", (sku,))
        return _normalizar_linha(linhas[0]) if linhas else None

    def salvar(self, linha: Dict[str, Any]) -> None:
        valores = []
        for campo in CAMPOS:
            v = linha.get(campo)
            if campo in ("fontes", "envios") and v is not None:
                v = json.dumps(v, ensure_ascii=False)
            if campo in ("validado_em", "atualizado_em") and isinstance(v, str):
                v = datetime.fromisoformat(v).replace(tzinfo=None)
            valores.append(v)
        colunas = ", ".join(CAMPOS)
        marcadores = ", ".join(["%s"] * len(CAMPOS))
        atualizar = ", ".join(f"{c} = VALUES({c})" for c in CAMPOS if c != "sku")
        self._executar(
            f"INSERT INTO dimensoes_produtos ({colunas}) VALUES ({marcadores}) ON DUPLICATE KEY UPDATE {atualizar}",
            tuple(valores),
        )

    def atualizar_envios(self, sku: str, envios: Dict[str, Any]) -> None:
        self._executar(
            "UPDATE dimensoes_produtos SET envios = %s WHERE sku = %s", (json.dumps(envios, ensure_ascii=False), sku)
        )

    def token_tiny(self, conta: str) -> Optional[str]:
        banco = settings.TINY_TOKENS_DB.replace("`", "")
        linhas = self._executar(
            f"""
            SELECT access_token FROM `{banco}`.api_tokens
            WHERE servico = 'tiny_v3' AND conta_identificador = %s
              AND access_token IS NOT NULL AND access_token != ''
            ORDER BY atualizado_em DESC LIMIT 1
            """,
            (conta,),
        )
        return linhas[0]["access_token"] if linhas else None


def criar_repositorio():
    if settings.banco_configurado():
        return RepositorioMariaDB()
    logger.warning("[DB] MariaDB não configurado (DB_HOST/DB_USER): dimensões padronizadas ficam só em memória.")
    return RepositorioMemoria()
