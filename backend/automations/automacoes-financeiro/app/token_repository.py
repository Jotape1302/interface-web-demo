import logging
import time
from typing import Dict, Iterator, Optional, Tuple

from app.config import Settings, settings

logger = logging.getLogger("automacao_nfe.token_repository")

try:
    import pymysql
    from pymysql.cursors import DictCursor
    PYMYSQL_AVAILABLE = True
except ImportError:
    PYMYSQL_AVAILABLE = False
    logger.warning("Módulo 'pymysql' não encontrado. Resolução de tokens via MariaDB desativada.")


def _is_transient_db_error(exc: Exception) -> bool:
    """Identifica se a falha de banco é transitória (queda de socket, timeout) para justificar retentativa imediata."""
    msg = str(exc).lower()
    permanent_patterns = [
        "name or service not known",
        "access denied",
        "unknown database",
    ]
    return not any(p in msg for p in permanent_patterns)


class TokenRepository:
    """
    Repositório de acesso à tabela `api_tokens` do MariaDB para resolução
    dinâmica do token de acesso do Tiny ERP da respectiva empresa/filial.
    Inclui retentativas em falha transitória de conexão, cache em memória
    e fallback de tolerância (grace period) contra indisponibilidade do banco.
    """

    def __init__(self, cfg: Optional[Settings] = None) -> None:
        self.cfg = cfg or settings
        self._cache: Dict[str, Tuple[str, str, float]] = {}  # key -> (access_token, conta_identificador, expires_timestamp)
        self._cache_ttl = 60  # Cache de 60 segundos para evitar sobrecarga no banco em lotes
        self._stale_cache_grace_period = 3600  # Fallback de até 1h se o banco estiver indisponível

    def is_configured(self) -> bool:
        """Indica se os parâmetros de conexão do banco estão definidos e o driver está instalado."""
        return bool(
            PYMYSQL_AVAILABLE
            and self.cfg.DB_HOST
            and self.cfg.DB_USER
            and "COLOQUE" not in self.cfg.DB_HOST
        )

    def _get_connection(self):
        """Cria e retorna uma conexão com o MariaDB."""
        if not PYMYSQL_AVAILABLE:
            raise RuntimeError("Driver 'pymysql' não instalado.")

        return pymysql.connect(
            host=self.cfg.DB_HOST,
            port=int(self.cfg.DB_PORT),
            user=self.cfg.DB_USER,
            password=self.cfg.DB_PASSWORD or "",
            database=self.cfg.DB_NAME,
            charset="utf8mb4",
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=10,
            write_timeout=10,
            autocommit=True
        )

    def invalidate_cache(self, cnpj: Optional[str] = None, account_id: Optional[str] = None) -> None:
        """Invalida a entrada no cache ou esvazia todo o cache se nenhum parâmetro for informado."""
        if not cnpj and not account_id:
            self._cache.clear()
            return
        clean_cnpj = "".join(c for c in (cnpj or "") if c.isdigit())
        keys_to_remove = [
            k for k in self._cache
            if (clean_cnpj and k.startswith(f"{clean_cnpj}:"))
            or (account_id and k.endswith(f":{account_id}"))
        ]
        for k in keys_to_remove:
            self._cache.pop(k, None)

    def _cache_matches(self, clean_cnpj: str, account: Optional[str]) -> Iterator[Tuple[str, str, float]]:
        """Entradas do cache (chave `cnpj:conta`) que batem com o CNPJ ou com a conta."""
        for k, entry in self._cache.items():
            k_cnpj, _, k_acc = k.partition(":")
            if (clean_cnpj and k_cnpj == clean_cnpj) or (account and k_acc == account):
                yield entry

    def get_token_by_cnpj_or_account(
        self,
        cnpj: Optional[str] = None,
        account_id: Optional[str] = None
    ) -> Optional[Tuple[str, str]]:
        """
        Localiza o access_token ativo do Tiny v3 a partir do CNPJ destinatário ou do identificador da conta.
        Retorna uma tupla (access_token, conta_identificador) ou None.
        Aplica cache com TTL e contingência com reconexão automática e tolerância a banco offline.
        """
        clean_cnpj = "".join(c for c in (cnpj or "") if c.isdigit())
        resolved_account = account_id
        if not resolved_account and clean_cnpj:
            cnpj_map = self.cfg.get_cnpj_company_map()
            resolved_account = cnpj_map.get(clean_cnpj)

        cache_key = f"{clean_cnpj}:{resolved_account or ''}"

        # 1. Cache ativo em memória, por CNPJ ou identificador (um dos dois pode ter sido omitido)
        for token, acc_id, exp_time in self._cache_matches(clean_cnpj, resolved_account):
            if time.time() < exp_time:
                return token, acc_id

        if not self.is_configured():
            return None

        max_attempts = 2
        last_error: Optional[Exception] = None

        for attempt in range(1, max_attempts + 1):
            try:
                with self._get_connection() as conn:
                    with conn.cursor() as cursor:
                        # 1. Tentativa pelo CNPJ diretamente na tabela ou pelo identificador resolvido
                        query = """
                            SELECT conta_identificador, access_token
                            FROM api_tokens
                            WHERE servico = 'tiny_v3'
                              AND (
                                (empresa_cnpj IS NOT NULL AND REPLACE(REPLACE(REPLACE(empresa_cnpj, '.', ''), '/', ''), '-', '') = %s)
                                OR conta_identificador = %s
                              )
                              AND access_token IS NOT NULL
                              AND access_token != ''
                            ORDER BY atualizado_em DESC
                            LIMIT 1;
                        """
                        cursor.execute(query, (clean_cnpj or "00000000000000", resolved_account or ""))
                        row = cursor.fetchone()

                        if row and row.get("access_token"):
                            found_token = row["access_token"]
                            found_account = row["conta_identificador"]
                            logger.info(
                                f"[TOKEN_DB] Token do Tiny v3 localizado no MariaDB para "
                                f"empresa '{found_account}' (CNPJ: {clean_cnpj or 'N/A'})."
                            )
                            self._cache[cache_key] = (found_token, found_account, time.time() + self._cache_ttl)
                            return found_token, found_account

                        # 2. Se não encontrou e temos apenas o account_id explícito
                        if account_id and account_id != resolved_account:
                            query_acc = """
                                SELECT conta_identificador, access_token
                                FROM api_tokens
                                WHERE servico = 'tiny_v3'
                                  AND conta_identificador = %s
                                  AND access_token IS NOT NULL
                                  AND access_token != ''
                                ORDER BY atualizado_em DESC
                                LIMIT 1;
                            """
                            cursor.execute(query_acc, (account_id,))
                            row_acc = cursor.fetchone()
                            if row_acc and row_acc.get("access_token"):
                                found_token = row_acc["access_token"]
                                found_account = row_acc["conta_identificador"]
                                self._cache[cache_key] = (found_token, found_account, time.time() + self._cache_ttl)
                                return found_token, found_account

                        # Se a consulta rodou sem erros e não encontrou registros
                        break
            except Exception as e:
                last_error = e
                if attempt < max_attempts and _is_transient_db_error(e):
                    logger.warning(
                        f"[TOKEN_DB] Falha temporária ao consultar MariaDB na tentativa {attempt}/{max_attempts}: {e}. "
                        f"Tentando reconectar..."
                    )
                    time.sleep(0.05)
                    continue
                logger.warning(
                    f"[TOKEN_DB] Falha ao consultar tabela 'api_tokens' no MariaDB ({self.cfg.DB_HOST}): {e}."
                )
                break

        # 3. Fallback de contingência: se houve erro de banco mas há token em cache dentro do grace period
        if last_error is not None:
            candidate = max(self._cache_matches(clean_cnpj, resolved_account), key=lambda e: e[2], default=None)
            if candidate:
                token, acc_id, exp_time = candidate
                if (time.time() - exp_time) <= self._stale_cache_grace_period:
                    logger.warning(
                        f"[TOKEN_DB] Usando token residual em cache de contingência para empresa '{acc_id}' "
                        f"(expirado há {int(time.time() - exp_time)}s) devido à indisponibilidade do banco."
                    )
                    return token, acc_id

        return None
