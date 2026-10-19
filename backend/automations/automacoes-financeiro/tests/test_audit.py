import json
import logging
import tempfile
import unittest
from pathlib import Path

from app.audit import record_audit_error, mark_failure_resolved, load_resolved_failures
from app.config import Settings


class TestAuditModule(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cfg = Settings(
            FAILED_DIR=Path(self.temp_dir.name) / "failed",
            PROCESSED_DIR=Path(self.temp_dir.name) / "processed",
        )
        self.cfg.ensure_directories()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_record_audit_error_and_resolve(self):
        err_path = record_audit_error(
            details="Erro de conexão com SEFAZ Nacional",
            chave_acesso="35230912345678000123550010000001231000000123",
            emitente_nome="FORNECEDOR LTDA",
            emitente_cnpj="11111111000111",
            valor_total=1250.50,
            step="sefaz_dist_nsu",
            cfg=self.cfg
        )

        self.assertTrue(err_path.is_file())
        with open(err_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["audit_status"], "error")
        self.assertEqual(data["valor_total"], 1250.50)
        self.assertEqual(data["chave_acesso"], "35230912345678000123550010000001231000000123")

        # Resolve o erro registrado
        resolved_ts = mark_failure_resolved(err_path.name, cfg=self.cfg)
        self.assertIsNotNone(resolved_ts)

        resolved_map = load_resolved_failures(cfg=self.cfg)
        self.assertIn(err_path.name, resolved_map)


if __name__ == "__main__":
    unittest.main()
