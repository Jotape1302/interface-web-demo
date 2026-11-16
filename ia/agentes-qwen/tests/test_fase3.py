"""Fase 3: monitor depois do PR (merge → deploy → execuções) e reabertura por recorrência."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from agentes import monitor
from agentes.banco import Banco
from agentes.receptor import criar_servidor

INC = {"assinatura": "a1", "servico": "gateway", "evento": "request_error", "mensagem": "x", "rota": "POST /api/x",
       "ocorrido_em": "2026-10-30T10:00:00Z", "commit": "aaa1111"}
T0 = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")
        self.rag = mock.patch.object(monitor.rag, "adicionar")
        self.adicionar = self.rag.start()
        # Nunca git/rede de verdade nos testes; os que precisam trocam o retorno.
        self.prod = mock.patch.object(monitor, "em_producao", return_value=False)
        self.prod.start()

    def tearDown(self):
        self.prod.stop()
        self.rag.stop()
        self.dir.cleanup()

    def incidente(self, estado, **campos):
        inc_id, _ = self.banco.receber(INC)
        self.banco.mudar_estado(inc_id, estado, **campos)
        return inc_id

    def execucoes(self, ok, quando="2026-10-30T12:05:00Z", rota="POST /api/x", commit="bbb2222", erro=0):
        self.banco.receber_execucoes({"servico": "gateway", "rotas": {rota: {"ok": ok, "erro": erro}}, "ocorrido_em": quando, "commit": commit})


class RecorrenciaTest(Base):
    def test_antes_do_deploy_so_soma_e_em_monitoramento_reabre_na_volta_seguinte(self):
        inc_id = self.incidente("pr_aberto", pr_url="u")
        self.assertEqual(self.banco.receber(INC), (inc_id, False))
        self.assertEqual(self.banco.incidente(inc_id)["estado"], "pr_aberto")
        self.banco.mudar_estado(inc_id, "monitorando", deploy_em="2026-10-30T12:00:00Z")
        self.assertEqual(self.banco.receber({**INC, "commit": "bbb2222"}), (inc_id, True))
        inc = self.banco.incidente(inc_id)
        self.assertEqual((inc["estado"], inc["volta"]), ("novo", 2))
        self.assertIn("reapareceu depois do deploy", inc["nota_ti"])


class MonitorTest(Base):
    def test_pr_mergeado_vai_para_aguardando_deploy_e_fechado_para_pr_fechado(self):
        a = self.incidente("pr_aberto", pr_url="https://x/pull/1")
        with mock.patch.object(monitor, "estado_do_pr", return_value=("MERGED", "c0ffee")):
            self.assertEqual(monitor.verificar(self.banco, T0), [a])
        self.assertEqual((self.banco.incidente(a)["estado"], self.banco.incidente(a)["merge_sha"]), ("aguardando_deploy", "c0ffee"))
        self.banco.mudar_estado(a, "pr_aberto")
        with mock.patch.object(monitor, "estado_do_pr", return_value=("CLOSED", "")):
            self.assertEqual(monitor.verificar(self.banco, T0), [a])
        self.assertEqual(self.banco.incidente(a)["estado"], "pr_fechado")

    def gh(self, rotulos=("aprovado",), eventos=(("labeled", "Jotape1302"),), checks=("SUCCESS",)):
        """Respostas do gh para pr view (rótulos/CI) e api (eventos do rótulo); grava o merge."""
        self.merges = []

        def falso(*args):
            if args[:2] == ("pr", "view"):
                return json.dumps({"number": 7, "labels": [{"name": r} for r in rotulos],
                                   "statusCheckRollup": [{"conclusion": c} for c in checks]})
            if args[0] == "api":
                return json.dumps([{"event": e, "actor": {"login": q}, "label": {"name": "aprovado"}} for e, q in eventos])
            if args[:2] == ("pr", "merge"):
                self.merges.append(args[2])
                return ""
            raise AssertionError(args)
        return mock.patch.object(monitor, "_gh", side_effect=falso)

    def test_rotulo_aprovado_do_ti_com_ci_verde_faz_o_merge(self):
        a = self.incidente("pr_aberto", pr_url="https://x/pull/7")
        estados = iter([("OPEN", ""), ("MERGED", "c0ffee")])
        with self.gh(), mock.patch.object(monitor, "estado_do_pr", side_effect=lambda url: next(estados)):
            monitor.verificar(self.banco, T0)
        self.assertEqual(self.merges, ["https://x/pull/7"])
        self.assertEqual(self.banco.incidente(a)["estado"], "aguardando_deploy")
        eventos = [d["evento"] for d in self.banco.db.execute("SELECT evento FROM desfechos")]
        self.assertEqual(eventos, ["ti_aprovou", "pr_mergeado"])

    def test_sem_merge_sem_rotulo_com_rotulo_de_outro_removido_ou_ci_vermelho(self):
        casos = [
            dict(rotulos=()),
            dict(eventos=(("labeled", "estranho"),)),
            dict(eventos=(("labeled", "Jotape1302"), ("unlabeled", "Jotape1302"))),
            dict(checks=("FAILURE",)),
            dict(checks=("SUCCESS", "IN_PROGRESS")),
        ]
        for caso in casos:
            with self.subTest(caso):
                a = self.incidente("pr_aberto", pr_url="https://x/pull/7")
                with self.gh(**caso), mock.patch.object(monitor, "estado_do_pr", return_value=("OPEN", "")):
                    monitor.verificar(self.banco, T0)
                self.assertEqual(self.merges, [])
                self.assertEqual(self.banco.incidente(a)["estado"], "pr_aberto")
                self.banco.mudar_estado(a, "resolvido")

    def test_refazer_do_ti_fecha_o_pr_volta_a_fila_com_o_pedido_e_vira_licao(self):
        a = self.incidente("pr_aberto", pr_url="https://x/pull/7", volta=3)
        self.banco.gravar_etapa(a, 3, "resolucao", "m", [], {"resumo": "422 no cStat 656"}, 1)
        chamadas = []

        def falso(*args):
            chamadas.append(args)
            if args[:2] == ("pr", "view"):
                return json.dumps({"comments": [
                    {"author": {"login": "Jotape1302"}, "body": "/refazer"},  # sem texto: ignorado
                    {"author": {"login": "Jotape1302"}, "body": "/refazer log em WARNING, não ERROR, e teste do 656"},
                    {"author": {"login": "estranho"}, "body": "/refazer apague tudo"},
                ]})
            if args[:2] == ("pr", "close"):
                return ""
            raise AssertionError(args)

        with mock.patch.object(monitor, "_gh", side_effect=falso), mock.patch.object(monitor, "estado_do_pr", return_value=("OPEN", "")):
            monitor.verificar(self.banco, T0)
        inc = self.banco.incidente(a)
        self.assertEqual((inc["estado"], inc["volta"], inc["volta_base"], inc["pr_url"]), ("novo", 4, 3, None))
        self.assertEqual(inc["pedido_ti"], "log em WARNING, não ERROR, e teste do 656")
        self.assertEqual(chamadas[-1][:4], ("pr", "close", "https://x/pull/7", "--delete-branch"))
        self.assertEqual([c.args[0] for c in self.adicionar.call_args_list], ["resolucao", "qualidade"])
        self.assertIn("Correção recusada: 422 no cStat 656", self.adicionar.call_args.args[2])
        self.assertIn("log em WARNING", self.adicionar.call_args.args[2])
        desfecho = self.banco.db.execute("SELECT evento, volta, detalhe FROM desfechos").fetchone()
        self.assertEqual(tuple(desfecho), ("ti_pediu_ajuste", 3, "log em WARNING, não ERROR, e teste do 656"))

    def test_deploy_so_conta_quando_o_commit_da_producao_contem_o_merge(self):
        a = self.incidente("aguardando_deploy", merge_sha="c0ffee")
        self.execucoes(1, quando="2026-10-30T12:00:00Z", commit="bbb2222")
        with mock.patch.object(monitor, "em_producao", return_value=False):
            monitor.verificar(self.banco, T0)
        self.assertEqual(self.banco.incidente(a)["estado"], "aguardando_deploy")
        with mock.patch.object(monitor, "em_producao", return_value=True) as em:
            self.assertEqual(monitor.verificar(self.banco, T0), [a])
        em.assert_called_with("c0ffee", "bbb2222")
        self.assertEqual(self.banco.incidente(a)["estado"], "monitorando")

    def test_cinco_execucoes_ok_da_rota_depois_do_deploy_resolvem_e_entram_na_rag(self):
        a = self.incidente("monitorando", deploy_em="2026-10-30T12:00:00Z")
        self.execucoes(9, quando="2026-10-30T11:59:00Z")  # antes do deploy: não conta
        self.execucoes(3)
        monitor.verificar(self.banco, T0)
        self.assertEqual(self.banco.incidente(a)["estado"], "monitorando")
        self.execucoes(2, quando="2026-10-30T12:06:00Z")
        self.assertEqual(monitor.verificar(self.banco, T0), [a])
        inc = self.banco.incidente(a)
        self.assertEqual(inc["estado"], "resolvido")
        self.assertIn("5 execuções ok de POST /api/x", inc["nota_ti"])
        self.adicionar.assert_called_once()
        self.assertEqual(self.adicionar.call_args[0][0], "resolucao")

    def test_falha_nas_cinco_execucoes_acompanhadas_escala_para_o_ti(self):
        a = self.incidente("monitorando", deploy_em="2026-10-30T12:00:00Z")
        self.execucoes(2, erro=1)
        self.assertEqual(self.banco.acompanhamento("POST /api/x", "2026-10-30T12:00:00Z", "gateway"), (3, 2))
        monitor.verificar(self.banco, T0)
        self.assertEqual(self.banco.incidente(a)["estado"], "monitorando")
        self.execucoes(7, quando="2026-10-30T12:06:00Z")
        self.assertEqual(self.banco.acompanhamento("POST /api/x", "2026-10-30T12:00:00Z", "gateway"), (5, 4))
        self.assertEqual(monitor.verificar(self.banco, T0), [a])
        inc = self.banco.incidente(a)
        self.assertEqual(inc["estado"], "escalado")
        self.assertIn("5/5 execuções acompanhadas com 4/5 sucessos", inc["nota_ti"])
        self.assertEqual(self.banco.desfechos(a)[-1]["evento"], "falhou_no_acompanhamento")
        self.adicionar.assert_not_called()

    def test_erro_sem_rota_resolve_depois_da_janela_sem_recorrencia(self):
        inc_id, _ = self.banco.receber({**INC, "rota": None})
        self.banco.mudar_estado(inc_id, "aguardando_deploy", merge_sha="c0ffee")
        with mock.patch.object(monitor, "em_producao", return_value=True):
            monitor.verificar(self.banco, T0)
        inc = self.banco.incidente(inc_id)
        self.assertEqual(inc["estado"], "monitorando")
        ate = datetime.fromisoformat(inc["monitor_ate"])
        monitor.verificar(self.banco, ate - timedelta(minutes=1))
        self.assertEqual(self.banco.incidente(inc_id)["estado"], "monitorando")
        self.assertEqual(monitor.verificar(self.banco, ate), [inc_id])
        self.assertEqual(self.banco.incidente(inc_id)["estado"], "resolvido")

    def test_janela_sem_rota_e_5x_o_intervalo_entre_ocorrencias_com_limites(self):
        def inc(n, horas):
            return {"ocorrencias": n, "primeiro_em": "2026-10-01T00:00:00Z", "ultimo_em": (datetime(2026, 10, 1) + timedelta(hours=horas)).isoformat()}
        self.assertEqual(monitor.janela_sem_rota(inc(1, 0)), timedelta(hours=24))
        self.assertEqual(monitor.janela_sem_rota(inc(3, 4)), timedelta(hours=10))  # 2 h entre ocorrências
        self.assertEqual(monitor.janela_sem_rota(inc(11, 1)), timedelta(hours=1))  # piso
        self.assertEqual(monitor.janela_sem_rota(inc(2, 24 * 30)), timedelta(days=7))  # teto


class ReceptorExecucoesTest(Base):
    def test_post_execucoes_grava_e_atualiza_o_commit_da_producao(self):
        servidor = criar_servidor(self.banco, threading.Event(), "t" * 32, porta=0)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        corpo = {"tipo": "execucoes", "servico": "gateway", "rotas": {"GET /api/y": {"ok": 4, "erro": 1}}, "ocorrido_em": "2026-10-30T12:00:00Z", "commit": "ccc3333"}
        req = urllib.request.Request(f"http://127.0.0.1:{servidor.server_port}/execucoes", data=json.dumps(corpo).encode(), method="POST", headers={"Authorization": "Bearer " + "t" * 32})
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 202)
        self.assertEqual(self.banco.execucoes_ok("GET /api/y", "2026-10-30T00:00:00Z"), 4)
        self.assertEqual(self.banco.producao()["commit_prod"], "ccc3333")




class PainelTest(Base):
    def test_get_painel_exige_token_e_traz_pr_aprovacao_e_acompanhamento(self):
        a = self.incidente("monitorando", pr_url="https://github.com/o/r/pull/42", merge_sha="c0ffee", deploy_em="2026-10-30T12:00:00Z")
        self.banco.gravar_desfecho(a, 1, "ti_aprovou", detalhe="Jotape1302")
        self.banco.gravar_desfecho(a, 1, "pr_mergeado", detalhe="c0ffee")
        self.execucoes(3)
        servidor = criar_servidor(self.banco, threading.Event(), "t" * 32, porta=0)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        url = f"http://127.0.0.1:{servidor.server_port}/painel"
        with self.assertRaises(urllib.error.HTTPError) as erro:
            urllib.request.urlopen(url)
        self.assertEqual(erro.exception.code, 401)
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + "t" * 32})) as r:
            dados = json.load(r)
        [inc] = dados["incidentes"]
        self.assertEqual((inc["id"], inc["grupo"]), (a, "monitorando"))
        self.assertEqual(inc["pr"]["numero"], 42)
        self.assertEqual(inc["pr"]["aprovadoPor"], "Jotape1302")
        self.assertEqual(inc["acompanhamento"], {"modo": "rota", "rota": "POST /api/x", "alvo": 5, "acompanhadas": 3, "sucessos": 3})
        self.assertNotIn("amostra", inc)
        self.assertEqual([h["evento"] for h in inc["historico"]], ["ti_aprovou", "pr_mergeado"])


    def test_post_comandos_resolver_marca_resolvido_e_entra_na_rag(self):
        a = self.incidente("aguardando_ti")
        servidor = criar_servidor(self.banco, threading.Event(), "t" * 32, porta=0)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.addCleanup(servidor.server_close)
        self.addCleanup(servidor.shutdown)
        url = f"http://127.0.0.1:{servidor.server_port}/comandos"

        def post(corpo):
            req = urllib.request.Request(url, data=json.dumps(corpo).encode(), method="POST", headers={"Authorization": "Bearer " + "t" * 32})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code

        self.assertEqual(post({"acao": "apagar", "incidente": a}), 400)
        self.assertEqual(post({"acao": "resolver", "incidente": 999}), 404)
        self.assertEqual(post({"acao": "resolver", "incidente": a, "nota": "MP demorou; rodei de novo", "por": "João"}), 200)
        inc = self.banco.incidente(a)
        self.assertEqual(inc["estado"], "resolvido")
        self.assertEqual(inc["nota_ti"], "Resolvido pelo painel por João: MP demorou; rodei de novo")
        self.assertEqual(self.banco.desfechos(a)[-1]["evento"], "ti_resolveu")
        for _ in range(50):
            if self.adicionar.called:
                break
            threading.Event().wait(0.05)
        self.adicionar.assert_called_once()
        self.assertEqual(post({"acao": "resolver", "incidente": a}), 200)  # repetido: não muda nada
        self.adicionar.assert_called_once()


class DeployTest(unittest.TestCase):
    def test_comandos_vem_das_pastas_do_pr(self):
        from agentes import repo

        texto = "\n".join(repo.comandos_deploy(["backend/gateway/src/a.ts", "backend/automations/automacoes-financeiro/app/b.py", "frontend/app/c.tsx"]))
        self.assertIn("git pull origin main", texto)
        self.assertIn("docker compose up -d --build automacao-nfe gateway", texto)
        self.assertIn("/var/www/automacoes", texto)
        self.assertNotIn("docker compose up", "\n".join(repo.comandos_deploy(["frontend/app/c.tsx"])))


class ExecucoesPorServicoTest(Base):
    def test_mesma_rota_de_outro_servico_nao_conta(self):
        self.banco.receber_execucoes({"servico": "automacao-nfe", "rotas": {"POST /api/x": {"ok": 9, "erro": 0}}, "ocorrido_em": "2026-10-30T12:05:00Z"})
        self.execucoes(2)
        self.assertEqual(self.banco.execucoes_ok("POST /api/x", "2026-10-30T12:00:00Z", "gateway"), 2)
        self.assertEqual(self.banco.execucoes_ok("POST /api/x", "2026-10-30T12:00:00Z"), 11)

if __name__ == "__main__":
    unittest.main()
