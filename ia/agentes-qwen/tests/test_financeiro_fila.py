"""Ponte do classificador de NF-e (financeiro_fila.py + POST /financeiro/sincronizar), sem GPU nem Ollama."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from agentes import config, financeiro_fila as ff
from agentes.banco import Banco
from agentes.receptor import criar_servidor

CATS = [{"id": "480897321", "grupo": "3.Custos", "nome": "Compras"}, {"id": "701885961", "grupo": "4.Despesas", "nome": "Limpeza"}]


def nota(chave="N1", staged_at="2026-11-03T10:00:00", itens=("1", "2")):
    return {
        "chave": chave,
        "staged_at": staged_at,
        "nfe_data": {"emitente_cnpj": "111", "destinatario_cnpj": "222", "emitente_nome": "F"},
        "itens": [{"item_id": i, "descricao": f"Item {i}", "classificar": True} for i in itens],
    }


def confirmada(chave="N1", staged_at="2026-11-03T10:00:00", cats=None):
    cats = cats or {"1": "701885961", "2": "480897321"}
    return {
        "chave": chave, "staged_at": staged_at, "confirmado_em": "2026-11-03T12:00:00-03:00",
        "destinatario_cnpj": "222", "emitente_cnpj": "111", "emitente_nome": "F", "forma_pagamento": "boleto",
        "qwen_modelo": None,
        "itens": [{"item_id": i, "descricao": "x", "ncm": "3402", "valor_total": 10.0, "categoria_id": c} for i, c in cats.items()],
    }


CLASSIFICADO = [
    {"item_id": "1", "categoria_id": "701885961", "confianca": "alta", "motivo": "limpeza"},
    {"item_id": "2", "categoria_id": "701885961", "confianca": "baixa", "motivo": "chute"},
]


class FilaFinanceiroTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")

    def tearDown(self):
        self.banco.db.close()
        self.dir.cleanup()

    def sync(self, **corpo):
        self.assertIsNone(ff.validar(corpo))
        return ff.sincronizar(self.banco, corpo)

    def estado(self, chave="N1"):
        return self.banco.db.execute("SELECT * FROM notas_financeiro WHERE chave=?", (chave,)).fetchone()

    def test_ciclo_completo_so_encerra_com_o_resultado_do_coletor(self):
        r = self.sync(categorias=CATS, pendentes=[nota()])
        self.assertEqual((r["pendentes_novas"], r["prontas"]), (1, []))
        self.assertEqual([c["id"] for c in ff.categorias(self.banco)], ["480897321", "701885961"])
        # Repetir a mesma nota não reenfileira.
        self.assertEqual(self.sync(pendentes=[nota()])["pendentes_novas"], 0)

        pend = ff.proxima_nota(self.banco)
        self.assertTrue(ff.gravar_classificacao(self.banco, pend["chave"], pend["staged_at"], CLASSIFICADO, "qwen2.5:14b"))
        self.assertIsNone(ff.proxima_nota(self.banco))

        # Sem resultado (VPS fora), a pronta volta no ciclo seguinte.
        for _ in range(2):
            [pronta] = self.sync()["prontas"]
            self.assertEqual((pronta["chave"], pronta["modelo"], pronta["itens"]), ("N1", "qwen2.5:14b", CLASSIFICADO))
        r = self.sync(resultados=[{"chave": "N1", "staged_at": pronta["staged_at"], "status": "aplicado", "http": 200}])
        self.assertEqual((r["entregues"], r["prontas"]), (1, []))
        self.assertEqual((self.estado()["estado"], self.estado()["http_vps"]), ("entregue", 200))

    def test_nova_versao_da_nota_reclassifica_do_zero(self):
        self.sync(pendentes=[nota()])
        ff.gravar_classificacao(self.banco, "N1", "2026-11-03T10:00:00", CLASSIFICADO, "m")
        self.assertEqual(self.sync(pendentes=[nota(staged_at="2026-11-03T11:00:00", itens=("1",))])["pendentes_novas"], 1)
        linha = self.estado()
        self.assertEqual((linha["estado"], linha["resultado_json"], linha["staged_at"]), ("pendente", None, "2026-11-03T11:00:00"))
        # Resultado da versão antiga não encerra a nova; classificação da versão antiga também não grava.
        self.sync(resultados=[{"chave": "N1", "staged_at": "2026-11-03T10:00:00", "status": "aplicado"}])
        self.assertEqual(self.estado()["estado"], "pendente")
        self.assertFalse(ff.gravar_classificacao(self.banco, "N1", "2026-11-03T10:00:00", CLASSIFICADO, "m"))

    def test_descartada_pela_vps_nao_volta(self):
        self.sync(pendentes=[nota()])
        ff.gravar_classificacao(self.banco, "N1", "2026-11-03T10:00:00", CLASSIFICADO, "m")
        self.sync(resultados=[{"chave": "N1", "staged_at": "2026-11-03T10:00:00", "status": "descartado", "http": 404}])
        self.assertEqual(self.estado()["estado"], "descartada")
        self.assertEqual(self.sync()["prontas"], [])

    def test_entregue_que_a_vps_perdeu_e_reenviada(self):
        self.sync(pendentes=[nota()])
        ff.gravar_classificacao(self.banco, "N1", "2026-11-03T10:00:00", CLASSIFICADO, "m")
        self.sync(resultados=[{"chave": "N1", "staged_at": "2026-11-03T10:00:00", "status": "aplicado"}])
        # A VPS lista a nota de novo como sem classificação, mesma versão.
        self.assertEqual([p["chave"] for p in self.sync(pendentes=[nota()])["prontas"]], ["N1"])

    def test_confirmada_vincula_o_palpite_local_e_tira_da_fila(self):
        self.sync(pendentes=[nota()])
        ff.gravar_classificacao(self.banco, "N1", "2026-11-03T10:00:00", CLASSIFICADO, "qwen2.5:14b")
        r = self.sync(confirmadas=[confirmada()])
        self.assertEqual((r["itens_confirmados"], r["prontas"]), (2, []))
        self.assertEqual(self.estado()["estado"], "descartada")
        linhas = {
            r["item_id"]: r for r in self.banco.db.execute("SELECT * FROM historico_itens_financeiro WHERE chave_nfe='N1'")
        }
        self.assertEqual((linhas["1"]["categoria_id"], linhas["1"]["palpite_categoria_id"]), ("701885961", "701885961"))
        self.assertEqual((linhas["2"]["categoria_id"], linhas["2"]["palpite_categoria_id"], linhas["2"]["palpite_modelo"]), ("480897321", "701885961", "qwen2.5:14b"))
        self.assertEqual(linhas["1"]["forma_pagamento"], "boleto")
        # Reenvio da mesma confirmada (cursor perdido) só atualiza, sem duplicar nem perder o palpite.
        self.sync(confirmadas=[confirmada()])
        self.assertEqual(self.banco.db.execute("SELECT COUNT(*) FROM historico_itens_financeiro").fetchone()[0], 2)
        self.assertEqual(self.banco.db.execute("SELECT palpite_categoria_id FROM historico_itens_financeiro WHERE item_id='2'").fetchone()[0], "701885961")

    def test_falhas_seguidas_param_a_nota_em_erro(self):
        self.sync(pendentes=[nota()])
        estados = [ff.falhar_classificacao(self.banco, "N1", "2026-11-03T10:00:00", "SaidaInvalida") for _ in range(ff.MAX_TENTATIVAS)]
        self.assertEqual(estados, ["pendente"] * (ff.MAX_TENTATIVAS - 1) + ["erro"])
        self.assertIsNone(ff.proxima_nota(self.banco))

    def test_validar_recusa_formatos_errados(self):
        self.assertIsNotNone(ff.validar([]))
        self.assertIsNotNone(ff.validar({"pendentes": {}}))
        self.assertIsNotNone(ff.validar({"pendentes": [{"chave": "N1", "itens": []}]}))  # sem staged_at
        self.assertIsNotNone(ff.validar({"confirmadas": [{"chave": "N1", "itens": [{"descricao": "sem id"}]}]}))
        self.assertIsNotNone(ff.validar({"resultados": [{"chave": "N1", "status": "talvez"}]}))
        self.assertIsNotNone(ff.validar({"pendentes": [nota(chave=str(i)) for i in range(ff.MAX_PENDENTES + 1)]}))
        self.assertIsNone(ff.validar({}))


class ReceptorFinanceiroTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")
        self.chegou = threading.Event()
        self.servidor = criar_servidor(self.banco, self.chegou, "t" * 32, porta=0)
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.servidor.server_port}/financeiro/sincronizar"

    def tearDown(self):
        self.servidor.shutdown()
        self.servidor.server_close()
        self.banco.db.close()
        self.dir.cleanup()

    def post(self, corpo, token="t" * 32):
        req = urllib.request.Request(self.url, data=json.dumps(corpo).encode(), method="POST", headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_sincroniza_com_token_acorda_o_trabalhador_e_aceita_corpo_acima_de_64k(self):
        grande = nota(itens=[str(i) for i in range(400)])
        for item in grande["itens"]:
            item["descricao"] = "D" * 200
        self.assertGreater(len(json.dumps(grande)), config.CORPO_MAX)
        status, corpo = self.post({"categorias": CATS, "pendentes": [grande]})
        self.assertEqual((status, corpo["pendentes_novas"]), (200, 1))
        self.assertTrue(self.chegou.is_set())

    def test_sem_token_ou_formato_errado(self):
        self.assertEqual(self.post({}, token="x" * 32)[0], 401)
        status, corpo = self.post({"pendentes": "nao"})
        self.assertEqual(status, 400)
        self.assertIn("listas", corpo["erro"])


if __name__ == "__main__":
    unittest.main()
