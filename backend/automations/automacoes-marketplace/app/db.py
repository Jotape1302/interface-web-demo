"""
MariaDB da automação de Marketplace (mesmo servidor da automacoes-financeiro): só leitura dos
tokens do Tiny v3 em `<TINY_TOKENS_DB>.api_tokens` (banco do financeiro), renovados fora desta
automação.

A tabela `<DB_NAME>.dimensoes_produtos` (padrões validados à mão até 2026-10-26) não é mais lida
nem gravada: as medidas vêm do cadastro do Tiny. Ela fica no banco como histórico.

O repositório em memória tem a mesma interface e serve aos testes e ao modo sem banco.
"""
import logging
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger("marketplace.db")

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:  # pragma: no cover - o requirements instala
    pymysql = None  # type: ignore[assignment]


class RepositorioMemoria:
    """Mesma interface do MariaDB, em memória (testes / serviço sem banco configurado)."""

    def __init__(self) -> None:
        self._tokens: Dict[str, str] = {}

    def token_tiny(self, conta: str) -> Optional[str]:
        return self._tokens.get(conta)


class RepositorioMariaDB:
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
                cur.execute(sql, params)
                return list(cur.fetchall() or [])

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
    logger.warning("[DB] MariaDB não configurado (DB_HOST/DB_USER): sem tokens do Tiny.")
    return RepositorioMemoria()
