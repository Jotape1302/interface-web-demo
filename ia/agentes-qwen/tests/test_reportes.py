"""Reportes do botão "Reportar erro" do painel: viram incidente sem duplicar os que vêm do log."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from agentes import painel
from agentes.banco import REPORTE, Banco
from agentes.receptor import criar_servidor

LOG = {"assinatura": "log1", "servico": "automacao-nfe", "evento": "erro", "funcao": "inter.py:baixar", "rota": "POST /api/baixa",
       "mensagem": "HTTPError: 403 Forbidden ao consultar o Tiny", "amostra": "Traceback ... execucao 98765 ...",
       "ocorrido_em": "2026-10-30T10:00:00Z"}


def reporte(id_, **extra):
    return {"id": id_, "automacao": "accounts-payable", "titulo": "Contas a Pagar", "servico": "automacao-nfe",
            "referencia": "EXEC-1", "mensagem": "403 Forbidden ao consultar o Tiny", "nota": "travou de novo", "por": "Ana",
            "em": "2026-10-30T10:05:00Z", **extra}


class ReportesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.banco = Banco(Path(self.dir.name) / "i.db")

    def total(self):
        return self.banco.db.execute("SELECT COUNT(*) FROM incidentes").fetchone()[0]

    def test_reporte_sem_log_abre_incidente_e_entrega_repetida_nao_duplica(self):
        inc, rodar = self.banco.receber_reporte(reporte(1))
        self.assertTrue(rodar)
        self.assertEqual(self.banco.incidente(inc)["evento"], REPORTE)
        self.assertIn("travou de novo", self.banco.incidente(inc)["amostra"])
        self.assertEqual(self.banco.receber_reporte(reporte(1)), (inc, False))
        self.assertEqual(self.total(), 1)
        self.assertEqual([d["evento"] for d in self.banco.desfechos(inc)], ["operador_reportou"])

    def test_reporte_de_erro_que_o_log_ja_trouxe_junta_no_mesmo(self):
        log, _ = self.banco.receber(LOG)
        inc, rodar = self.banco.receber_reporte(reporte(2))
        self.assertEqual((inc, rodar), (log, False))
        self.assertEqual(self.total(), 1)
        self.assertEqual([r["id"] for r in self.banco.reportes(log)], [2])

    def test_referencia_no_log_junta_mesmo_com_mensagem_diferente(self):
        log, _ = self.banco.receber(LOG)
        inc, _ = self.banco.receber_reporte(reporte(3, referencia="98765", mensagem="Não deu baixa no boleto"))
        self.assertEqual(inc, log)

    def test_dois_reportes_do_mesmo_erro_em_execucoes_diferentes_caem_no_mesmo(self):
        a, _ = self.banco.receber_reporte(reporte(4, referencia="EXEC-1"))
        b, rodar = self.banco.receber_reporte(reporte(5, referencia="EXEC-2", por="Bia"))
        self.assertEqual((b, rodar), (a, False))
        self.assertEqual(self.banco.incidente(a)["ocorrencias"], 2)

    def test_log_que_chega_depois_do_reporte_completa_o_incidente(self):
        rep, _ = self.banco.receber_reporte(reporte(6))
        log, rodar = self.banco.receber(LOG)
        self.assertEqual((log, rodar), (rep, False))
        inc = self.banco.incidente(rep)
        self.assertIn("Log do erro:", inc["amostra"])
        self.assertEqual((inc["rota"], inc["funcao"]), ("POST /api/baixa", "inter.py:baixar"))

    def test_erro_diferente_ou_outro_servico_abre_outro(self):
        self.banco.receber(LOG)
        self.banco.receber_reporte(reporte(7, mensagem="Timeout no Banco Inter ao buscar extrato"))
        self.banco.receber_reporte(reporte(8, servico="automacoes-marketplace"))
        self.assertEqual(self.total(), 3)

    def test_ja_resolvido_nao_recebe_reporte_novo(self):
        log, _ = self.banco.receber(LOG)
        self.banco.mudar_estado(log, "resolvido")
        inc, rodar = self.banco.receber_reporte(reporte(9))
        self.assertNotEqual(inc, log)
        self.assertTrue(rodar)

    def test_em_monitoramento_reabre_o_mesmo_na_volta_seguinte(self):
        log, _ = self.banco.receber(LOG)
        self.banco.mudar_estado(log, "monitorando")
        inc, rodar = self.banco.receber_reporte(reporte(10))
        self.assertEqual((inc, rodar), (log, True))
        self.assertEqual((self.banco.incidente(log)["estado"], self.banco.incidente(log)["volta"]), ("novo", 2))

    def test_painel_traz_os_reportes(self):
        inc, _ = self.banco.receber_reporte(reporte(11))
        [dado] = painel.estado(self.banco)["incidentes"]
        self.assertEqual(dado["reportes"], [{"id": 11, "automacao": "accounts-payable", "referencia": "EXEC-1", "por": "Ana", "em": "2026-10-30T10:05:00Z"}])

    def test_post_comandos_reportar(self):
        chegou = threading.Event()
        servidor = criar_servidor(self.banco, chegou, "t" * 32, porta=0)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        url = f"http://127.0.0.1:{servidor.server_port}/comandos"

        def post(corpo):
            req = urllib.request.Request(url, data=json.dumps(corpo).encode(), method="POST", headers={"Authorization": "Bearer " + "t" * 32})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.load(r)
            except urllib.error.HTTPError as e:
                return e.code, None

        self.assertEqual(post({"acao": "reportar", "reporte": {"id": "x"}})[0], 400)
        status, corpo = post({"acao": "reportar", "reporte": reporte(12)})
        self.assertEqual((status, corpo["novo"]), (200, True))
        self.assertTrue(chegou.is_set())
        self.assertEqual(post({"acao": "reportar", "reporte": reporte(12)})[1]["incidente"], corpo["incidente"])


if __name__ == "__main__":
    unittest.main()
