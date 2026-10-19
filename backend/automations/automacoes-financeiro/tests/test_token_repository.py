import unittest
from unittest.mock import MagicMock, patch
from decimal import Decimal
from datetime import date

from app.config import Settings
from app.token_repository import TokenRepository
from app.nfe_client import NFeData
from app.tiny_client import TinyClient


class TestTokenRepository(unittest.TestCase):
    def test_token_repo_not_configured(self):
        cfg = Settings(DB_HOST=None, DB_USER=None)
        repo = TokenRepository(cfg=cfg)
        self.assertFalse(repo.is_configured())
        self.assertIsNone(repo.get_token_by_cnpj_or_account(cnpj="36592814000100"))

    def test_token_repo_resolves_via_db(self):
        cfg = Settings(
            DB_HOST="localhost",
            DB_USER="norvia_user",
            DB_PASSWORD="pwd",
            DB_NAME="financeiro"
        )
        repo = TokenRepository(cfg=cfg)

        with patch("app.token_repository.PYMYSQL_AVAILABLE", True):
            self.assertTrue(repo.is_configured())

            mock_conn = MagicMock()
            mock_cursor = MagicMock()
            mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
            mock_conn.__enter__.return_value = mock_conn

            mock_cursor.fetchone.return_value = {
                "conta_identificador": "revesta",
                "access_token": "token_revesta_123"
            }

            with patch.object(repo, "_get_connection", return_value=mock_conn):
                res = repo.get_token_by_cnpj_or_account(cnpj="36.592.814/0001-00")
                self.assertIsNotNone(res)
                token, account = res
                self.assertEqual(token, "token_revesta_123")
                self.assertEqual(account, "revesta")


    def test_tiny_client_resolve_token_dynamic(self):
        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.get_token_by_cnpj_or_account.return_value = ("token_campinas_xyz", "norvia_campinas")

        client = TinyClient(token_repository=mock_repo)

        nfe_data = NFeData(
            chave="35230912345678000123550010000001231000000123",
            numero_nota="100",
            data_emissao=date.today(),
            emitente_nome="FORNECEDOR",
            emitente_cnpj="11111111000111",
            valor_total=Decimal("500.00"),
            destinatario_cnpj="27184930000107"
        )

        token, account_id = client.resolve_token_for_nfe(nfe_data)
        self.assertEqual(token, "token_campinas_xyz")
        self.assertEqual(account_id, "norvia_campinas")

    def test_token_repo_retry_on_transient_connection_error(self):
        cfg = Settings(
            DB_HOST="localhost",
            DB_USER="norvia_user",
            DB_PASSWORD="pwd",
            DB_NAME="financeiro"
        )
        repo = TokenRepository(cfg=cfg)

        with patch("app.token_repository.PYMYSQL_AVAILABLE", True):
            mock_conn = MagicMock()
            mock_cursor = MagicMock()
            mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
            mock_conn.__enter__.return_value = mock_conn

            mock_cursor.fetchone.return_value = {
                "conta_identificador": "fabrilux",
                "access_token": "token_fabrilux_recovered"
            }

            # 1ª tentativa levanta exceção de conexão, 2ª tentativa tem sucesso
            call_count = [0]
            def side_effect():
                call_count[0] += 1
                if call_count[0] == 1:
                    raise ConnectionError("MySQL connection dropped")
                return mock_conn

            with patch.object(repo, "_get_connection", side_effect=side_effect):
                res = repo.get_token_by_cnpj_or_account(cnpj="43.820.617/0001-66")
                self.assertIsNotNone(res)
                token, account = res
                self.assertEqual(token, "token_fabrilux_recovered")
                self.assertEqual(account, "fabrilux")
                self.assertEqual(call_count[0], 2)

    def test_token_repo_stale_cache_fallback_on_db_down(self):
        cfg = Settings(
            DB_HOST="localhost",
            DB_USER="norvia_user",
            DB_PASSWORD="pwd",
            DB_NAME="financeiro"
        )
        repo = TokenRepository(cfg=cfg)

        with patch("app.token_repository.PYMYSQL_AVAILABLE", True):
            # Pré-alimenta o cache com token expirado recentemente (há 30s), dentro do grace period de 3600s
            import time
            clean_cnpj = "36592814000100"
            repo._cache[f"{clean_cnpj}:"] = ("cached_token_emergency", "revesta", time.time() - 30)

            # Banco de dados completamente fora do ar
            with patch.object(repo, "_get_connection", side_effect=ConnectionError("Database offline")):
                res = repo.get_token_by_cnpj_or_account(cnpj="36.592.814/0001-00")
                self.assertIsNotNone(res)
                token, account = res
                self.assertEqual(token, "cached_token_emergency")
                self.assertEqual(account, "revesta")

    def test_token_repo_cache_management(self):
        repo = TokenRepository(cfg=Settings())
        import time
        repo._cache["27184930000107:norvia_campinas"] = ("tok_test", "norvia_campinas", time.time() + 120)

        # Token está no cache
        res = repo.get_token_by_cnpj_or_account(cnpj="27184930000107")
        self.assertIsNotNone(res)
        self.assertEqual(res[0], "tok_test")

        # Invalidação seletiva
        repo.invalidate_cache(cnpj="27184930000107")
        self.assertNotIn("27184930000107:norvia_campinas", repo._cache)


if __name__ == "__main__":
    unittest.main()
