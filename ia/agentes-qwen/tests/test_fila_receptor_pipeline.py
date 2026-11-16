"""Testes sem GPU nem Ollama: python -m unittest discover -s tests"""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from agentes import agentes, config, llm, pipeline
from agentes.banco import Banco
from agentes.receptor import criar_servidor

INC = {"assinatura": "a1", "servico": "gateway", "evento": "request_error", "mensagem": "TypeError: x", "ocorrencias": 1}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")

    def tearDown(self):
        self.dir.cleanup()


class BancoTest(Base):
    def test_mesma_assinatura_aberta_so_soma_e_depois_de_resolvida_abre_outro_ligado_ao_anterior(self):
        a, novo_a = self.banco.receber(INC)
        b, novo_b = self.banco.receber({**INC, "ocorrencias": 3})
        self.assertEqual((a, novo_a, novo_b), (b, True, False))
        self.assertEqual(self.banco.incidente(a)["ocorrencias"], 4)
        self.banco.mudar_estado(a, "resolvido", nota_ti="ok")
        c, novo_c = self.banco.receber(INC)
        self.assertTrue(novo_c)
        self.assertEqual(self.banco.incidente(c)["anterior_id"], a)


AUTOMACAO_656 = {
    "assinatura": "nfe656", "servico": "automacao-nfe", "evento": "automacao_nfe.api", "ocorrido_em": "2026-11-03T18:57:43.262410220Z",
    "mensagem": "2026-11-03 15:57:43 [ERROR] [automacao_nfe.api]: [IMPORT_KEY] Falha ao consultar chave <longo>: A nota fiscal "
    "<longo> não foi obtida da SEFAZ. O CNPJ abaixo falhou e pode ser o destinatário — Revesta: SEFAZ retornou rejeição: "
    "cStat 656 - Rejeicao: Consumo Indevido (Ultrapassou o limite de 20 consultas por hora)",
}
GATEWAY_656 = {
    "assinatura": "gw656", "servico": "gateway", "evento": "request_public_error", "ocorrido_em": "2026-11-03T18:57:43.266174276Z",
    "mensagem": "UpstreamError: Falha ao importar NF-e pela chave: *** ao consultar a chave na SEFAZ: A nota fiscal <longo> não "
    "foi obtida da SEFAZ. O CNPJ abaixo falhou e pode ser o destinatário — Revesta: SEFAZ retornou rejeição: cStat 656 - "
    "Rejeicao: Consumo Indevido (Ultrapassou o limite de 20 consultas por hora)",
}


class EcoDoGatewayTest(Base):
    """Incidentes #16/#17 de 03/11: o UpstreamError do gateway era a mesma falha da automação."""

    def test_repasse_do_gateway_se_junta_ao_incidente_da_automacao(self):
        a, _ = self.banco.receber(AUTOMACAO_656)
        self.assertEqual(self.banco.receber(GATEWAY_656), (a, False))
        self.assertEqual(self.banco.db.execute("SELECT COUNT(*) FROM incidentes").fetchone()[0], 1)

    def test_repasse_que_chega_antes_sai_da_fila(self):
        self.banco.receber(GATEWAY_656)
        a, novo = self.banco.receber(AUTOMACAO_656)
        self.assertTrue(novo)
        restantes = [(r["id"], r["servico"]) for r in self.banco.db.execute("SELECT id, servico FROM incidentes")]
        self.assertEqual(restantes, [(a, "automacao-nfe")])

    def test_longe_no_tempo_ou_outro_erro_continua_separado(self):
        a, _ = self.banco.receber(AUTOMACAO_656)
        tarde = {**GATEWAY_656, "ocorrido_em": "2026-11-03T19:10:00Z"}
        outro = {**GATEWAY_656, "assinatura": "gw2", "mensagem": "UpstreamError: Falha ao listar notas: HTTP 500 Internal Server Error"}
        self.assertNotEqual(self.banco.receber(tarde)[0], a)
        self.assertNotEqual(self.banco.receber(outro)[0], a)


class ReceptorTest(Base):
    def setUp(self):
        super().setUp()
        self.chegou = threading.Event()
        self.servidor = criar_servidor(self.banco, self.chegou, "t" * 32, porta=0)
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.servidor.server_port}"

    def tearDown(self):
        self.servidor.shutdown()
        self.servidor.server_close()
        super().tearDown()

    def post(self, corpo, token="t" * 32):
        req = urllib.request.Request(self.url + "/incidentes", data=json.dumps(corpo).encode(), method="POST", headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_token_errado_e_campos_faltando_sao_recusados(self):
        self.assertEqual(self.post(INC, token="x" * 32), 401)
        self.assertEqual(self.post({"assinatura": "a"}), 400)
        self.assertIsNone(self.banco.proximo())

    def test_incidente_valido_entra_e_acorda_o_trabalhador(self):
        self.assertEqual(self.post(INC), 202)
        self.assertTrue(self.chegou.is_set())
        self.assertEqual(self.banco.proximo()["assinatura"], "a1")

    def test_receptor_so_escuta_no_loopback(self):
        self.assertEqual(self.servidor.server_address[0], "127.0.0.1")


class AgenteFalso(agentes.Agente):
    def __init__(self, nome, saida=None, erro=None, chamadas=None):
        self.nome, self.saida, self.erro, self.chamadas = nome, saida or {"resumo": nome}, erro, chamadas

    def rodar(self, inc, anteriores):
        self.chamadas.append((self.nome, sorted(anteriores)))
        if self.erro:
            raise self.erro
        return self.saida, [f"{self.nome}.md"]


class PipelineTest(Base):
    def test_cada_agente_recebe_a_saida_completa_do_anterior_e_tudo_fica_gravado(self):
        chamadas = []
        cadeia = [AgenteFalso("diagnostico", chamadas=chamadas), AgenteFalso("resolucao", chamadas=chamadas)]
        inc_id, _ = self.banco.receber(INC)
        with mock.patch.object(pipeline, "CADEIA", cadeia):
            self.assertEqual(pipeline.processar(self.banco, inc_id), "aguardando_ti")
        self.assertEqual(chamadas, [("diagnostico", []), ("resolucao", ["diagnostico"])])
        self.assertEqual([e["agente"] for e in self.banco.etapas(inc_id)], ["diagnostico", "resolucao"])
        self.assertIn("## Resolucao", pipeline.relatorio(self.banco, inc_id))

    def test_ollama_fora_no_meio_retoma_sem_refazer_o_agente_ja_concluido(self):
        chamadas = []
        inc_id, _ = self.banco.receber(INC)
        caindo = [AgenteFalso("diagnostico", chamadas=chamadas), AgenteFalso("resolucao", erro=llm.OllamaFora("x"), chamadas=chamadas)]
        with mock.patch.object(pipeline, "CADEIA", caindo):
            self.assertEqual(pipeline.processar(self.banco, inc_id), "em_andamento")
        self.assertEqual(self.banco.proximo()["id"], inc_id)
        chamadas.clear()
        voltou = [AgenteFalso("diagnostico", chamadas=chamadas), AgenteFalso("resolucao", chamadas=chamadas)]
        with mock.patch.object(pipeline, "CADEIA", voltou):
            self.assertEqual(pipeline.processar(self.banco, inc_id), "aguardando_ti")
        self.assertEqual(chamadas, [("resolucao", ["diagnostico"])])

    def test_json_invalido_escala_e_passar_do_limite_de_voltas_escala(self):
        inc_id, _ = self.banco.receber(INC)
        with mock.patch.object(pipeline, "CADEIA", [AgenteFalso("diagnostico", erro=llm.SaidaInvalida("x"), chamadas=[])]):
            self.assertEqual(pipeline.processar(self.banco, inc_id), "escalado")
        outro, _ = self.banco.receber({**INC, "assinatura": "b"})
        self.banco.mudar_estado(outro, "novo", volta=config.MAX_VOLTAS + 1)
        self.assertEqual(pipeline.processar(self.banco, outro), "escalado")


class LlmTest(unittest.TestCase):
    def test_resposta_fora_do_esquema_pede_de_novo_e_desiste_depois_das_tentativas(self):
        respostas = iter([{"message": {"content": "{}"}}] * config.TENTATIVAS_JSON)
        with mock.patch.object(llm, "_post", side_effect=lambda *a: next(respostas)) as post:
            with self.assertRaises(llm.SaidaInvalida):
                llm.gerar("m", "s", "u", agentes.Diagnostico)
        self.assertEqual(post.call_count, config.TENTATIVAS_JSON)
        self.assertIn("não seguiu o esquema", post.call_args[0][1]["messages"][-1]["content"])


class TrechoDoCodigoTest(unittest.TestCase):
    def test_acha_a_funcao_python_e_o_ts_do_gateway_compilado(self):
        with tempfile.TemporaryDirectory() as d:
            raiz = Path(d)
            (raiz / "app").mkdir()
            (raiz / "app" / "ml.py").write_text("x = 1\n\ndef baixar(a):\n    return a\n")
            (raiz / "src").mkdir()
            (raiz / "src" / "roi.ts").write_text("export function montar(x: number) {\n  return x;\n}\n")
            with mock.patch.object(config, "REPO_INTERFACE", raiz):
                self.assertIn("app/ml.py (linha 3)", agentes.rag.trecho_do_codigo("ml.py:baixar"))
                self.assertIn("src/roi.ts (linha 1)", agentes.rag.trecho_do_codigo("roi.js:montar"))
                self.assertIsNone(agentes.rag.trecho_do_codigo("ml.py:nao_existe"))


    def test_sem_traceback_acha_o_codigo_pelo_texto_do_log_ou_pela_rota(self):
        """Incidentes #12/#13 de 03/11: log sem stack deixava os agentes sem código e o caso ia ao TI."""
        with tempfile.TemporaryDirectory() as d:
            raiz = Path(d)
            (raiz / "app" / "routers").mkdir(parents=True)
            (raiz / "app" / "routers" / "danfe.py").write_text(
                '@router.post("/api/v1/danfe/import-key")\ndef importar(req):\n    try:\n        pass\n'
                '    except Exception as e:\n        logger.error(f"[IMPORT_KEY] Falha ao consultar chave {raw_key}: {e}")\n'
            )
            (raiz / "tests").mkdir()
            (raiz / "tests" / "test_x.py").write_text('"[IMPORT_KEY] Falha ao consultar chave"\n')
            msg = "2026-11-03 15:17:02 [ERROR] [automacao_nfe.api]: [IMPORT_KEY] Falha ao consultar chave <longo>: cStat 640"
            trecho = agentes.rag.trecho_pelo_log(msg, raiz=raiz)
            self.assertTrue(trecho.startswith("app/routers/danfe.py (linha 1)"))
            self.assertIn("logger.error", trecho)
            # Mensagem que não está no código: cai na rota.
            self.assertTrue(agentes.rag.trecho_pelo_log("erro qualquer que não existe no repo", "POST /api/v1/danfe/import-key", raiz=raiz).startswith("app/routers/danfe.py"))
            self.assertIsNone(agentes.rag.trecho_pelo_log("curto", None, raiz=raiz))
            inc = {"funcao": "", "mensagem": msg, "rota": None}
            with mock.patch.object(config, "REPO_INTERFACE", raiz):
                self.assertIn("logger.error", agentes.rag.trecho_do_incidente(inc))


if __name__ == "__main__":
    unittest.main()
