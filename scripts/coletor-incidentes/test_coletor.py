"""Testes do coletor de incidentes: python3 -m unittest discover -s scripts/coletor-incidentes"""

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import coletor


def registros(*linhas):
    ag = coletor.Agrupador()
    saida = []
    for linha in linhas:
        saida += ag.linha(linha)
    return saida + ag.fechar()


def incidentes(*linhas):
    return [i for i in map(coletor.classificar, registros(*linhas)) if i]


class ClassificacaoTest(unittest.TestCase):
    def test_evento_de_erro_do_gateway_vira_incidente_com_funcao_do_topo(self):
        stack = "TypeError: x\\n    at node:internal/a:1:1\\n    at montar (/app/dist/roi.js:10:5)"
        linha = 'gateway-1  | 2026-10-30T12:00:00Z {"event":"request_error","name":"TypeError","message":"x","stack":"%s"}' % stack
        (inc,) = incidentes(linha)
        self.assertEqual((inc["servico"], inc["evento"], inc["funcao"]), ("gateway", "request_error", "roi.js:montar"))

    def test_eventos_que_nao_sao_defeito_ficam_de_fora(self):
        self.assertEqual(incidentes(
            'gateway-1  | 2026-10-30T12:00:00Z {"event":"login_locked","ip":"1.2.3.4"}',
            'gateway-1  | 2026-10-30T12:00:00Z {"event":"server_started"}',
            'gateway-1  | 2026-11-04T11:56:30Z {"event":"agentes_qwen_financeiro_failed","message":"fetch failed"}',
        ), [])

    def test_automacao_reiniciando_no_deploy_nao_vira_incidente(self):
        # Incidentes #27–#33 (09/11/2026): rebuild da automacao-nfe, 10 s sem resposta.
        self.assertEqual(incidentes(
            "gateway-1  | 2026-11-09T19:03:13Z [DANFE Service] readStatus falhou: fetch failed",
            "gateway-1  | 2026-11-09T19:03:13Z [DANFE Service] readSefazStatus: 1ª tentativa falhou (fetch failed); tentando de novo",
            'gateway-1  | 2026-11-09T19:03:13Z {"event":"request_error","name":"TypeError","message":"fetch failed","method":"GET","path":"/api/danfe/history"}',
            "gateway-1  | 2026-11-09T19:03:13Z [DANFE Service] readSefazStatus falhou: fetch failed",
            "gateway-1  | 2026-11-09T19:03:23Z [DANFE Service] readStatus falhou: Circuito 'financeiro' está temporariamente ABERTO devido a falhas consecutivas no serviço upstream. Próxima tentativa em 20s.",
        ), [])

    def test_timeout_do_gateway_e_erro_da_automacao_continuam_virando_incidente(self):
        incs = incidentes(
            "gateway-1  | 2026-11-09T19:03:13Z [DANFE Service] readSefazStatus falhou: The operation was aborted due to timeout",
            "automacao-nfe-1  | 2026-11-09T19:03:14Z 2026-11-09 16:03:14 [ERROR] [automacao_nfe]: ECONNREFUSED no Tiny",
        )
        self.assertEqual([i["servico"] for i in incs], ["gateway", "automacao-nfe"])

    def test_504_do_nginx_vira_incidente_com_a_rota(self):
        # Lote manual de 7 NFC-e (12/11/2026): o NGINX cortou em 60 s e nada chegava aos agentes.
        a = incidentes('gateway-1  | 2026-11-12T13:00:00Z {"event":"proxy_timeout_error","name":"TempoEsgotadoNoProxy",'
                       '"message":"POST /api/danfe/process-batch passou do limite do NGINX (61 s): o navegador recebeu HTTP 504",'
                       '"method":"POST","path":"/api/danfe/process-batch"}')
        b = incidentes('gateway-1  | 2026-11-12T14:00:00Z {"event":"proxy_timeout_error","name":"TempoEsgotadoNoProxy",'
                       '"message":"POST /api/danfe/process-batch passou do limite do NGINX (75 s): o navegador recebeu HTTP 504",'
                       '"method":"POST","path":"/api/danfe/process-batch"}')
        self.assertEqual((a[0]["evento"], a[0]["rota"]), ("proxy_timeout_error", "POST /api/danfe/process-batch"))
        self.assertEqual(a[0]["assinatura"], b[0]["assinatura"])

    def test_traceback_junta_ao_registro_e_usa_a_funcao_do_proprio_codigo(self):
        (inc,) = incidentes(
            "automacao-nfe-1  | 2026-10-30T12:00:03Z 2026-10-30 09:00:03 [ERROR] [automacao_nfe]: falhou",
            "automacao-nfe-1  | 2026-10-30T12:00:03Z Traceback (most recent call last):",
            'automacao-nfe-1  | 2026-10-30T12:00:03Z   File "/app/app/ml.py", line 8, in baixar',
            'automacao-nfe-1  | 2026-10-30T12:00:03Z   File "/usr/local/lib/python3.11/site-packages/x.py", line 5, in run',
            "automacao-nfe-1  | 2026-10-30T12:00:03Z ValueError: saldo",
            "automacao-nfe-1  | 2026-10-30T12:00:04Z 2026-10-30 09:00:04 [INFO] [automacao_nfe]: ok",
        )
        self.assertEqual(inc["funcao"], "ml.py:baixar")
        self.assertEqual(inc["mensagem"], "ValueError: saldo")
        self.assertEqual(inc["evento"], "automacao_nfe")

    def test_falha_com_prefixo_de_servico_do_gateway_vira_incidente_com_a_pilha(self):
        (inc,) = incidentes(
            "gateway-1  | 2026-10-30T12:00:00Z [ReconciliationHistory] Falha ao gravar histórico de baixas: Error: Cannot use timeout for Batch statement",
            "gateway-1  | 2026-10-30T12:00:00Z     at insertRows (/app/dist/reconciliation-history.js:325:20)",
            "gateway-1  | 2026-10-30T12:00:01Z [stock-count] contagem 12 recebida",
        )
        self.assertEqual((inc["evento"], inc["funcao"]), ("ReconciliationHistory", "reconciliation-history.js:insertRows"))

    def test_linhas_comuns_de_servico_sem_formato_nao_se_juntam(self):
        regs = registros(
            "automacoes-producao-1  | 2026-10-30T12:00:00Z Iniciando",
            "automacoes-producao-1  | 2026-10-30T12:00:01Z Gerando etiqueta",
        )
        self.assertEqual(len(regs), 2)

    def test_assinatura_igual_para_o_mesmo_erro_com_ids_diferentes(self):
        a = incidentes('gateway-1  | 2026-10-30T12:00:00Z {"event":"request_error","name":"E","message":"pedido 123 falhou"}')
        b = incidentes('gateway-1  | 2026-10-30T13:00:00Z {"event":"request_error","name":"E","message":"pedido 987 falhou"}')
        self.assertEqual(a[0]["assinatura"], b[0]["assinatura"])


class ExecucoesTest(unittest.TestCase):
    def test_request_error_leva_a_rota_normalizada_igual_ao_gateway(self):
        (inc,) = incidentes('gateway-1  | 2026-10-30T12:00:00Z {"event":"request_error","method":"POST","path":"/api/danfe/123/confirm","name":"E","message":"x"}')
        self.assertEqual(inc["rota"], "POST /api/danfe/:id/confirm")

    def test_erro_python_leva_a_rota_da_marca_de_execucao_sem_a_marca_na_mensagem(self):
        (inc,) = incidentes(
            "automacao-nfe-1  | 2026-10-30T12:00:03Z 2026-10-30 09:00:03 [ERROR] [automacao_nfe.api]: [SEFAZ_SCAN] Erro na varredura agendada: 503 [execucao=rotina SEFAZ_SCAN]",
        )
        self.assertEqual(inc["rota"], "rotina SEFAZ_SCAN")
        self.assertNotIn("execucao=", inc["mensagem"])
        (outro,) = incidentes(
            "automacao-nfe-1  | 2026-10-30T12:00:04Z 2026-10-30 09:00:04 [ERROR] [automacao_nfe.api]: [SEFAZ_SCAN] Erro na varredura agendada: 504 [execucao=rotina SEFAZ_SCAN]",
        )
        self.assertEqual(inc["assinatura"], outro["assinatura"])

    def test_erro_nao_tratado_python_leva_a_rota_http(self):
        (inc,) = incidentes(
            "automacoes-marketplace-1  | 2026-10-30T12:00:03Z 2026-10-30 09:00:03 [ERROR] [marketplace]: Erro não tratado [ab12] em POST /api/fretes/MLB123456/retentar: boom",
        )
        self.assertEqual(inc["rota"], "POST /api/fretes/:id/retentar")

    def test_linha_de_execucoes_das_automacoes_python_tambem_vai(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        fila = coletor.Fila(Path(d.name) / "c.db")
        linha = 'automacao-nfe-1  | 2026-10-30T12:01:00Z {"event":"execucoes","janela_s":60,"rotas":{"rotina SEFAZ_SCAN":{"ok":1,"erro":0}},"at":"2026-10-30T12:01:00.000Z"}'
        coletor.processar(registros(
            "automacao-nfe-1  | 2026-10-30T12:00:59Z 2026-10-30 09:00:59 [ERROR] [automacao_nfe]: falhou",
            "automacao-nfe-1  | 2026-10-30T12:00:59Z Traceback (most recent call last):",
            "automacao-nfe-1  | 2026-10-30T12:00:59Z ValueError: x",
            linha,
        ), fila)
        tipos = [json.loads(r[0]).get("tipo") for r in fila.db.execute("SELECT payload FROM fila")]
        self.assertIn("execucoes", tipos)
        execucao = [json.loads(r[0]) for r in fila.db.execute("SELECT payload FROM fila") if json.loads(r[0]).get("tipo") == "execucoes"][0]
        self.assertEqual(execucao["servico"], "automacao-nfe")

    def test_linha_de_execucoes_vai_para_a_fila_sem_virar_incidente(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        fila = coletor.Fila(Path(d.name) / "c.db")
        linha = 'gateway-1  | 2026-10-30T12:01:00Z {"event":"execucoes","janela_s":60,"rotas":{"POST /api/x":{"ok":2,"erro":0}},"at":"2026-10-30T12:01:00Z"}'
        coletor.processar(registros(linha), fila)
        (payload,) = [json.loads(r[0]) for r in fila.db.execute("SELECT payload FROM fila")]
        self.assertEqual((payload["tipo"], payload["rotas"]), ("execucoes", {"POST /api/x": {"ok": 2, "erro": 0}}))
        self.assertIsNone(fila.db.execute("SELECT assinatura FROM vistos").fetchone())


class MascaraTest(unittest.TestCase):
    def test_segredos_e_dados_pessoais_saem_mascarados(self):
        texto = coletor.mascarar('Authorization: Bearer abc.def {"senha": "x1"} token=zz joao@x.com 123.456.789-09 12.345.678/0001-90 APP_USR-123-abc')
        for vazado in ("abc.def", "x1", "zz", "joao@x.com", "123.456.789-09", "12.345.678/0001-90", "123-abc"):
            self.assertNotIn(vazado, texto)


class FilaTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.fila = coletor.Fila(Path(self.dir.name) / "c.db")
        self.inc = {"assinatura": "a1", "servico": "gateway"}

    def tearDown(self):
        self.dir.cleanup()

    def test_repeticao_na_janela_so_soma_e_depois_reenvia_com_contagem(self):
        self.assertTrue(self.fila.registrar(self.inc, 0))
        self.assertFalse(self.fila.registrar(self.inc, 10))
        self.assertFalse(self.fila.registrar(self.inc, 20))
        self.assertTrue(self.fila.registrar(self.inc, coletor.JANELA_REENVIO + 1))
        payloads = [json.loads(r[0]) for r in self.fila.db.execute("SELECT payload FROM fila ORDER BY id")]
        self.assertEqual([p["ocorrencias"] for p in payloads], [1, 3])

    def test_envio_fica_na_fila_com_orquestrador_fora_e_sai_quando_volta(self):
        recebidos = []

        class Receptor(BaseHTTPRequestHandler):
            def do_POST(self):
                recebidos.append((self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(202)
                self.end_headers()

            def log_message(self, *a):
                pass

        self.fila.registrar(self.inc, 0)
        parar = threading.Event()
        # Porta fechada: falha de rede adia, não descarta.
        t = threading.Thread(target=coletor.enviar_pendentes, args=(self.fila, "http://127.0.0.1:9/x", "t" * 32, parar, Path(self.dir.name)))
        t.start()
        parar.wait(0.5)
        parar.set()
        t.join()
        self.assertEqual(self.fila.db.execute("SELECT tentativas FROM fila").fetchone()[0], 1)

        servidor = HTTPServer(("127.0.0.1", 0), Receptor)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.fila.db.execute("UPDATE fila SET proxima=0")
        parar = threading.Event()
        url = f"http://127.0.0.1:{servidor.server_port}/incidentes"
        t = threading.Thread(target=coletor.enviar_pendentes, args=(self.fila, url, "t" * 32, parar, Path(self.dir.name)))
        t.start()
        for _ in range(50):
            if recebidos:
                break
            parar.wait(0.1)
        parar.set()
        t.join()
        servidor.shutdown()
        self.assertEqual(recebidos[0][0], "Bearer " + "t" * 32)
        self.assertEqual(recebidos[0][1]["assinatura"], "a1")
        self.assertIsNone(self.fila.db.execute("SELECT id FROM fila").fetchone())


class PainelTest(unittest.TestCase):
    def test_estado_do_orquestrador_vai_para_o_gateway_com_o_mesmo_token(self):
        chegou = []

        class Ponta(BaseHTTPRequestHandler):
            def do_GET(self):
                corpo = json.dumps({"incidentes": [], "auth": self.headers["Authorization"], "path": self.path}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(corpo)))
                self.end_headers()
                self.wfile.write(corpo)

            def do_POST(self):
                chegou.append((self.path, self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                resposta = json.dumps({"avisos": 0, "comandos": [{"acao": "resolver", "incidente": 3}]} if self.path.endswith("/estado") else {"ok": True}).encode()
                self.send_response(202)
                self.send_header("Content-Length", str(len(resposta)))
                self.end_headers()
                self.wfile.write(resposta)

            def log_message(self, *a):
                pass

        servidor = HTTPServer(("127.0.0.1", 0), Ponta)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.addCleanup(servidor.shutdown)
        base = f"http://127.0.0.1:{servidor.server_port}"
        self.assertTrue(coletor.repassar_painel(f"{base}/incidentes", f"{base}/api/agentes-qwen/estado", "t" * 32))
        [(path, auth, corpo), (path_cmd, auth_cmd, comando)] = chegou
        self.assertEqual((path, auth), ("/api/agentes-qwen/estado", "Bearer " + "t" * 32))
        self.assertEqual((corpo["path"], corpo["auth"]), ("/painel", "Bearer " + "t" * 32))
        # Comando pedido na aba vai ao orquestrador.
        self.assertEqual((path_cmd, auth_cmd, comando), ("/comandos", "Bearer " + "t" * 32, {"acao": "resolver", "incidente": 3}))
        self.assertFalse(coletor.repassar_painel("http://127.0.0.1:9/incidentes", f"{base}/x", "t" * 32))


class SeguirLogsTest(unittest.TestCase):
    def test_registro_que_chega_de_uma_vez_nao_e_partido_pelo_fim_de_registro(self):
        # O traceback inteiro chega num só write e o log fica quieto depois: antes, o select() não via
        # as linhas já no buffer do readline() e o registro fechava só com o cabeçalho.
        bloco = "".join(f"contagem-estoque-1  | 2026-10-31T01:13:00.{i:09d}Z {t}\n" for i, t in enumerate([
            "2026-10-30 22:13:00 [ERROR] contagem_estoque.bot: erro não tratado no bot",
            "Traceback (most recent call last):",
            '  File "/app/app/bot.py", line 1, in x',
            "telegram.error.NetworkError: Bad Gateway",
        ]))
        script = f"import sys, time; sys.stdout.write({bloco!r}); sys.stdout.flush(); time.sleep(0.8)"
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        fila = coletor.Fila(Path(d.name) / "c.db")
        popen, fim = coletor.subprocess.Popen, coletor.FIM_DE_REGISTRO
        self.addCleanup(setattr, coletor.subprocess, "Popen", popen)
        self.addCleanup(setattr, coletor, "FIM_DE_REGISTRO", fim)
        coletor.FIM_DE_REGISTRO = 0.2
        parar = threading.Event()

        def falso(cmd, **kw):
            proc = popen([sys.executable, "-c", script], **kw)
            # Uma volta só: pouco depois do fim da saída, para em vez de retomar do cursor.
            threading.Thread(target=lambda: (proc.wait(), parar.wait(0.3), parar.set()), daemon=True).start()
            return proc

        coletor.subprocess.Popen = falso
        coletor.seguir_logs(fila, Path(d.name), ["contagem-estoque"], parar)
        mensagens = [json.loads(r[0])["mensagem"] for r in fila.db.execute("SELECT payload FROM fila")]
        self.assertEqual(mensagens, ["telegram.error.NetworkError: Bad Gateway"])


class PonteFinanceiroTest(unittest.TestCase):
    """Automação financeira e orquestrador falsos no mesmo servidor (rotas diferentes)."""

    def setUp(self):
        self.chamadas = []
        self.sugestao_status = 200
        self.orquestrador_status = 200
        self.paginas = {None: {"confirmadas": [{"chave": "C1", "itens": []}], "cursor": "c1", "fim": False},
                        "c1": {"confirmadas": [], "cursor": "c1", "fim": True}}
        teste = self

        class Ponta(BaseHTTPRequestHandler):
            def _json(self, status, corpo):
                dados = json.dumps(corpo).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(dados)))
                self.end_headers()
                self.wfile.write(dados)

            def do_GET(self):
                teste.chamadas.append(("GET", self.path, self.headers.get("Authorization"), None))
                if self.path.startswith("/fin/boletos/pendentes"):
                    return self._json(200, {"categorias": {"revesta": [{"id": "7"}]}, "boletos": [{"id": "B1", "versao": "v1"}]})
                if self.path.startswith("/fin/pendentes"):
                    return self._json(200, {"categorias": [{"id": "1"}], "notas": [{"chave": "N1", "staged_at": "s1", "itens": []}]})
                cursor = dict(p.split("=") for p in self.path.split("?")[1].split("&")).get("cursor")
                return self._json(200, teste.paginas[cursor])

            def do_POST(self):
                corpo = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                teste.chamadas.append(("POST", self.path, self.headers.get("Authorization"), corpo))
                if self.path == "/financeiro/boletos/sincronizar":
                    pronta = {"boleto_id": "B0", "versao": "v0", "modelo": "m", "categoria_id": "7", "confianca": "alta", "motivo": "x"}
                    return self._json(teste.orquestrador_status, {"prontas": [pronta]})
                if self.path == "/financeiro/sincronizar":
                    pronta = {"chave": "N0", "staged_at": "s0", "modelo": "qwen2.5:14b", "itens": [{"item_id": "1"}]}
                    return self._json(teste.orquestrador_status, {"prontas": [pronta]})
                return self._json(teste.sugestao_status, {"ok": True})

            def log_message(self, *a):
                pass

        self.servidor = HTTPServer(("127.0.0.1", 0), Ponta)
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()
        self.addCleanup(self.servidor.shutdown)
        self.base = f"http://127.0.0.1:{self.servidor.server_port}"
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.fila = coletor.Fila(Path(self.dir.name) / "c.db")

    def ciclo(self, resultados=()):
        return coletor.sincronizar_financeiro(self.fila, f"{self.base}/fin", f"{self.base}/incidentes", "t" * 32, list(resultados))

    def test_ciclo_leva_notas_e_aplica_as_prontas_com_o_token(self):
        anteriores = [{"chave": "X", "staged_at": "s", "status": "aplicado", "http": 200}]
        resultados, mais = self.ciclo(anteriores)
        self.assertEqual(resultados, [{"chave": "N0", "staged_at": "s0", "status": "aplicado", "http": 200}])
        self.assertTrue(mais)  # a página dizia fim=false
        self.assertEqual(self.fila.cursor_financeiro(), "c1")
        sync = [c for c in self.chamadas if c[1] == "/financeiro/sincronizar"][0]
        self.assertEqual(sync[2], "Bearer " + "t" * 32)
        self.assertEqual([n["chave"] for n in sync[3]["pendentes"]], ["N1"])
        self.assertEqual((sync[3]["categorias"], sync[3]["resultados"]), ([{"id": "1"}], anteriores))
        aplicada = [c for c in self.chamadas if c[1] == "/fin/sugestoes"][0]
        self.assertEqual((aplicada[2], aplicada[3]["chave"], aplicada[3]["modelo"]), ("Bearer " + "t" * 32, "N0", "qwen2.5:14b"))
        self.assertTrue(all(c[2] == "Bearer " + "t" * 32 for c in self.chamadas if c[0] == "GET"))

        # Segundo ciclo continua do cursor salvo e termina a carga.
        _, mais = self.ciclo()
        self.assertFalse(mais)
        self.assertIn("cursor=c1", [c for c in self.chamadas if "confirmadas-recentes" in c[1]][-1][1])

    def test_recusa_definitiva_vira_descartado_e_falha_passageira_nao_confirma(self):
        self.sugestao_status = 409
        self.assertEqual(self.ciclo()[0][0]["status"], "descartado")
        self.sugestao_status = 503
        self.assertEqual(self.ciclo()[0], [])

    def test_orquestrador_fora_guarda_resultados_e_nao_anda_o_cursor(self):
        self.orquestrador_status = 502
        pendentes = [{"chave": "X", "staged_at": "s", "status": "aplicado"}]
        self.assertEqual(self.ciclo(pendentes), (pendentes, False))
        self.assertIsNone(self.fila.cursor_financeiro())
        self.assertFalse([c for c in self.chamadas if c[1] == "/fin/sugestoes"])

    def test_ponte_dos_boletos_tem_cursor_proprio(self):
        anteriores = [{"boleto_id": "X", "versao": "v", "status": "aplicado", "http": 200}]
        resultados, mais = coletor.sincronizar_boletos(self.fila, f"{self.base}/fin", f"{self.base}/incidentes", "t" * 32, anteriores)
        self.assertEqual(resultados, [{"boleto_id": "B0", "versao": "v0", "status": "aplicado", "http": 200}])
        self.assertTrue(mais)
        self.assertEqual((self.fila.cursor_nomeado("boletos"), self.fila.cursor_financeiro()), ("c1", None))
        sync = [c for c in self.chamadas if c[1] == "/financeiro/boletos/sincronizar"][0]
        self.assertEqual((sync[3]["pendentes"], sync[3]["categorias"], sync[3]["resultados"]),
                         ([{"id": "B1", "versao": "v1"}], {"revesta": [{"id": "7"}]}, anteriores))
        aplicada = [c for c in self.chamadas if c[1] == "/fin/boletos/sugestoes"][0][3]
        self.assertEqual((aplicada["boleto_id"], aplicada["categoria_id"], aplicada["versao"]), ("B0", "7", "v0"))
        self.sugestao_status = 422
        self.assertEqual(coletor.sincronizar_boletos(self.fila, f"{self.base}/fin", f"{self.base}/incidentes", "t" * 32, [])[0][0]["status"],
                         "descartado")

    def test_automacao_fora_do_ar_nao_levanta(self):
        r = coletor.sincronizar_financeiro(self.fila, "http://127.0.0.1:9/fin", f"{self.base}/incidentes", "t" * 32, [{"chave": "X"}])
        self.assertEqual(r, ([{"chave": "X"}], False))


if __name__ == "__main__":
    unittest.main()
