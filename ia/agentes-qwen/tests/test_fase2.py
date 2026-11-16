"""Fase 2: travas do pipeline, voltas, PR, edição exata e sandbox (bwrap real, sem Ollama)."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agentes import config, pipeline, repo
from agentes.banco import Banco

INC = {"assinatura": "a1", "servico": "gateway", "evento": "request_error", "mensagem": "TypeError: x", "funcao": "roi.js:montar"}
DIAG = {"resumo": "d", "precisa_de_humano": False}
RES_CODIGO = {"resumo": "r", "tipo": "codigo", "automatizavel": True, "arquivos_afetados": ["backend/gateway/src/roi.ts"]}
EXEC = {"explicacao": "e", "edicoes": [{"arquivo": "backend/gateway/src/roi.ts", "procurar": "a", "substituir": "b"}], "titulo_pr": "fix(gateway): x", "diff": "DIFF"}


class Falso:
    def __init__(self, nome, saidas, chamadas):
        self.nome, self.saidas, self.chamadas = nome, list(saidas), chamadas

    def rodar(self, inc, anteriores):
        self.chamadas.append(self.nome)
        self.anteriores = dict(anteriores)
        saida = self.saidas.pop(0) if len(self.saidas) > 1 else self.saidas[0]
        if isinstance(saida, Exception):
            raise saida
        return dict(saida), []


def avaliacao(aprovado):
    return {"resolve_a_causa": aprovado, "problemas": [], "regras_violadas": [], "aprovado": aprovado, "motivo": "m"}


class PipelineFase2Test(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")
        self.inc_id, _ = self.banco.receber(INC)
        self.chamadas = []
        self.publicar = mock.Mock(return_value="https://github.com/norvia-ti/interface-web/pull/9")
        self.testar = mock.Mock(return_value=[{"comando": "npm run test:gateway", "ok": True, "saida": ""}])
        raiz = Path(self.dir.name) / "repo"
        (raiz / "backend/gateway/src").mkdir(parents=True)
        (raiz / "backend/gateway/src/roi.ts").write_text("x")
        self.patches = [
            mock.patch.object(config, "REPO_INTERFACE", raiz),
            mock.patch.object(repo, "preparar"), mock.patch.object(repo, "aquecer", return_value=[]),
            mock.patch.object(repo, "aplicar_diff"), mock.patch.object(repo, "testar", self.testar),
            mock.patch.object(repo, "publicar", self.publicar),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.dir.cleanup()

    def cadeia(self, res=RES_CODIGO, execs=(EXEC,), avals=(avaliacao(True),)):
        return [
            mock.patch.object(pipeline, "CADEIA", [Falso("diagnostico", [DIAG], self.chamadas), Falso("resolucao", [res], self.chamadas)]),
            mock.patch.object(pipeline, "EXECUTOR", Falso("executor", execs, self.chamadas)),
            mock.patch.object(pipeline, "QUALIDADE", Falso("qualidade", avals, self.chamadas)),
        ]

    def rodar(self, **kw):
        ps = self.cadeia(**kw)
        for p in ps:
            p.start()
        try:
            estados = []
            while True:
                estados.append(pipeline.processar(self.banco, self.inc_id))
                if estados[-1] != "nova_volta":
                    return estados
        finally:
            for p in ps:
                p.stop()

    def test_sem_arquivo_fonte_editavel_para_no_relatorio_sem_executor(self):
        # 403 do Tiny: os passos apontam documentação; config: .env (proibido); arquivo inexistente.
        res = {**RES_CODIGO, "arquivos_afetados": ["integrations/erp.md", "backend/gateway/.env", "backend/gateway/src/nao-existe.ts"]}
        self.banco.mudar_estado(self.inc_id, "novo", nota_ti="falha no clone/testes/PR: CUDA out of memory")
        self.assertEqual(self.rodar(res=res), ["aguardando_ti"])
        self.assertNotIn("executor", self.chamadas)
        # A nota da aba diz por que parou (não a de uma tentativa anterior).
        self.assertTrue(self.banco.incidente(self.inc_id)["nota_ti"].startswith("a correção não é de código automatizável: "))

    def test_github_inalcancavel_no_clone_espera_em_vez_de_escalar(self):
        # 13/11 (#36–#38, #42): "Could not resolve host: github.com" logo depois de ligar o PC.
        erro = repo.RedeFora("git fetch -q origin main: fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com")
        with mock.patch.object(repo, "preparar", side_effect=erro):
            ps = self.cadeia()
            for p in ps:
                p.start()
            try:
                self.assertEqual(pipeline.processar(self.banco, self.inc_id), "em_andamento")
            finally:
                for p in ps:
                    p.stop()
        self.assertEqual(self.banco.incidente(self.inc_id)["estado"], "em_andamento")
        self.assertEqual(self.rodar(), ["pr_aberto"])

    def test_falha_de_rede_reconhecida_e_403_continua_escalando(self):
        self.assertTrue(repo.eh_falha_de_rede("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com"))
        self.assertFalse(repo.eh_falha_de_rede("fatal: unable to access 'https://github.com/x/': The requested URL returned error: 403"))

    def test_arquivo_fonte_nos_passos_libera_o_executor_mesmo_com_rotulo_errado_do_llm(self):
        res = {"resumo": "r", "tipo": "infraestrutura", "automatizavel": False, "arquivos_afetados": [],
               "passos": [{"acao": "a", "arquivo": "backend/gateway/src/roi.ts", "detalhe": "d"}]}
        self.assertEqual(self.rodar(res=res), ["pr_aberto"])

    def test_caminho_so_no_texto_do_passo_libera_o_executor(self):
        res = {"resumo": "r", "tipo": "codigo", "automatizavel": True, "arquivos_afetados": [],
               "passos": [{"acao": "a", "arquivo": None, "detalhe": "No arquivo backend/gateway/src/roi.ts, trate o caso."}]}
        self.assertEqual(self.rodar(res=res), ["pr_aberto"])

    def test_aprovado_abre_pr_com_a_branch_da_volta(self):
        self.assertEqual(self.rodar(), ["pr_aberto"])
        self.assertEqual(self.chamadas, ["diagnostico", "resolucao", "executor", "qualidade"])
        inc = self.banco.incidente(self.inc_id)
        self.assertEqual((inc["branch"], inc["pr_url"]), ("agente/inc-1-v1", "https://github.com/norvia-ti/interface-web/pull/9"))
        branch, titulo, corpo = self.publicar.call_args[0]
        self.assertEqual((branch, titulo), ("agente/inc-1-v1", "fix(gateway): x"))
        self.assertIn("adicione o rótulo `aprovado`", corpo)

    def test_teste_falhando_reprova_mesmo_com_o_llm_aprovando_e_volta_ao_diagnostico(self):
        self.testar.side_effect = [[{"comando": "npm run test:gateway", "ok": False, "saida": "1 failed"}], [{"comando": "npm run test:gateway", "ok": True, "saida": ""}]]
        self.assertEqual(self.rodar(), ["nova_volta", "pr_aberto"])
        self.assertEqual(self.chamadas, ["diagnostico", "resolucao", "executor", "qualidade"] * 2)
        q1 = json.loads(self.banco.etapas(self.inc_id, 1)[-1]["saida"])
        self.assertEqual((q1["testes_ok"], q1["aprovado_final"]), (False, False))
        self.assertEqual(self.banco.incidente(self.inc_id)["branch"], "agente/inc-1-v2")

    def test_reprovado_em_todas_as_voltas_escala_para_o_ti(self):
        estados = self.rodar(avals=(avaliacao(False),))
        self.assertEqual(estados, ["nova_volta"] * config.MAX_VOLTAS + ["escalado"])
        self.publicar.assert_not_called()

    def test_pedido_do_ti_chega_aos_agentes_e_as_voltas_contam_a_partir_dele(self):
        if type(self) is not PipelineFase2Test:
            self.skipTest("lê o que o Falso desta suíte guarda")
        self.assertEqual(self.rodar(), ["pr_aberto"])
        # /refazer no PR (monitor.refazer): volta 2, base 1, com o pedido.
        self.banco.gravar_desfecho(self.inc_id, 1, "ti_pediu_ajuste", detalhe="logue em WARNING")
        self.banco.mudar_estado(self.inc_id, "novo", volta=2, volta_base=1, pedido_ti="logue em WARNING")
        ps = self.cadeia(avals=(avaliacao(False),))
        for p in ps:
            p.start()
        try:
            estados = [pipeline.processar(self.banco, self.inc_id)]
            vistos = {"resolucao": pipeline.CADEIA[1].anteriores, "executor": pipeline.EXECUTOR.anteriores}
            while estados[-1] == "nova_volta":
                estados.append(pipeline.processar(self.banco, self.inc_id))
        finally:
            for p in ps:
                p.stop()
        self.assertEqual(vistos["resolucao"]["pedido_ti"], "logue em WARNING")
        self.assertEqual(vistos["executor"]["diff_recusado"], "DIFF")
        # Todas as voltas do /refazer partem do PR recusado (o diff da volta 1), não só a primeira.
        self.assertTrue(vistos["executor"]["base_recusada"])
        com_base = [c for c in repo.preparar.call_args_list if c.args[1:] == ("DIFF",)]
        self.assertEqual(len(com_base), config.MAX_VOLTAS)
        # Três voltas novas (2, 3, 4) antes de escalar, mesmo já tendo passado da volta 3.
        self.assertEqual(estados, ["nova_volta"] * config.MAX_VOLTAS + ["escalado"])
        self.assertEqual(self.banco.incidente(self.inc_id)["volta"], 1 + config.MAX_VOLTAS + 1)

    def test_pedido_de_teste_sem_arquivo_de_teste_no_diff_reprova_mesmo_com_a_qualidade_aprovando(self):
        self.banco.mudar_estado(self.inc_id, "novo", pedido_ti="trate o 656 e inclua um teste")
        exec_com_teste = {**EXEC, "edicoes": EXEC["edicoes"] + [{"arquivo": "backend/gateway/test/roi.test.ts", "procurar": "", "substituir": "t"}]}
        self.assertEqual(self.rodar(execs=(EXEC, exec_com_teste)), ["nova_volta", "pr_aberto"])
        q1 = json.loads(self.banco.etapas(self.inc_id, 1)[-1]["saida"])
        self.assertFalse(q1["aprovado_final"])
        self.assertIn("não altera nenhum arquivo de teste", q1["motivo"])
        eventos = [d["evento"] for d in self.banco.db.execute("SELECT evento FROM desfechos WHERE volta=1")]
        self.assertIn("faltou_teste", eventos)

    def test_corpo_do_pr_leva_so_a_volta_aprovada_e_cabe_no_limite_do_github(self):
        grande = {**EXEC, "diff": "x" * 30000}
        self.assertEqual(self.rodar(execs=(grande, grande, EXEC), avals=(avaliacao(False), avaliacao(False), avaliacao(True))),
                         ["nova_volta", "nova_volta", "pr_aberto"])
        corpo = self.publicar.call_args[0][2]
        self.assertLess(len(corpo), pipeline.CORPO_PR_MAX + 1)
        self.assertIn("Voltas 1 a 2 ficam fora deste PR", corpo)
        self.assertNotIn("volta 1,", corpo)

    def test_corpo_do_pr_ensina_o_refazer(self):
        self.assertEqual(self.rodar(), ["pr_aberto"])
        self.assertIn("`/refazer <o que está errado", self.publicar.call_args[0][2])

    def test_executor_que_nao_consegue_aplicar_vira_nova_volta(self):
        estados = self.rodar(execs=(repo.ErroEdicao("trecho não encontrado"), EXEC))
        self.assertEqual(estados, ["nova_volta", "pr_aberto"])
        self.assertEqual(json.loads(self.banco.etapas(self.inc_id, 1)[-1]["saida"]), {"falhou": "trecho não encontrado"})

    def test_pr_desligado_para_com_a_branch_local(self):
        with mock.patch.object(config, "PR_ABRIR", False):
            self.assertEqual(self.rodar(), ["pronto_para_pr"])
        self.publicar.assert_not_called()


class RepoTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.raiz = Path(self.dir.name) / "interface-web"
        (self.raiz / "backend/gateway/src").mkdir(parents=True)
        (self.raiz / "backend/gateway/src/roi.ts").write_text("const a = 1;\nconst b = 1;\n")
        (self.raiz / ".env").write_text("SEGREDO=1\n")
        subprocess.run(["git", "init", "-q", str(self.raiz)], check=True)
        subprocess.run(["git", "-C", str(self.raiz), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.raiz), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], check=True)
        self.p = mock.patch.object(config, "REPO_AGENTE", self.raiz)
        self.p.start()

    def tearDown(self):
        self.p.stop()
        self.dir.cleanup()

    def test_caminhos_proibidos(self):
        for proibido in (".env", "backend/gateway/.env.production", "database/migrations/001.sql", "backend/gateway/package.json",
                         "docker-compose.yml", ".github/workflows/ci.yml", "backend/automations/x/requirements.lock",
                         "backend/../.env", "scripts/coletor-incidentes/coletor.py", "backend/gateway/certs/a.pfx"):
            self.assertFalse(repo.caminho_permitido(proibido), proibido)
        self.assertTrue(repo.caminho_permitido("backend/gateway/src/roi.ts"))

    def test_edicao_exata_unica_e_tudo_ou_nada(self):
        with self.assertRaisesRegex(repo.ErroEdicao, "2 vez"):
            repo.aplicar([{"arquivo": "backend/gateway/src/roi.ts", "procurar": "= 1;", "substituir": "= 2;"}])
        with self.assertRaisesRegex(repo.ErroEdicao, "fora do que"):
            repo.aplicar([
                {"arquivo": "backend/gateway/src/roi.ts", "procurar": "const a = 1;", "substituir": "const a = 2;"},
                {"arquivo": ".env", "procurar": "SEGREDO=1", "substituir": "SEGREDO=2"},
            ])
        self.assertIn("const a = 1;", (self.raiz / "backend/gateway/src/roi.ts").read_text())  # nada foi gravado
        diff = repo.aplicar([{"arquivo": "backend/gateway/src/roi.ts", "procurar": "const a = 1;", "substituir": "const a = 2;"}])
        self.assertIn("+const a = 2;", diff)

    def test_trecho_repetido_mostra_as_linhas_de_cada_ocorrencia(self):
        # Incidente #35: o retorno tem que dar ao executor o contexto para desambiguar.
        with self.assertRaises(repo.ErroEdicao) as ctx:
            repo.aplicar([{"arquivo": "backend/gateway/src/roi.ts", "procurar": "= 1;", "substituir": "= 2;"}])
        msg = str(ctx.exception)
        self.assertIn("2 vez", msg)
        self.assertIn("linha 1:", msg)
        self.assertIn("linha 2:", msg)
        self.assertIn("const a = 1;", msg)

    def test_suites_pelas_pastas_tocadas(self):
        self.assertEqual(repo.suites(["backend/gateway/src/roi.ts", "frontend/lib/x.ts"]), ["backend/gateway", "frontend"])


@unittest.skipUnless(shutil.which("bwrap"), "bubblewrap não instalado")
class SandboxTest(unittest.TestCase):
    def test_testes_rodam_sem_rede_sem_home_e_so_gravam_no_clone(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(config, "REPO_AGENTE", Path(d)), mock.patch.object(config, "DADOS_DIR", Path(d) / "dados"):
            script = (
                "ls ~/.ssh >/dev/null 2>&1 && echo HOME_VISIVEL; "
                "python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 53), 2)' 2>/dev/null && echo COM_REDE; "
                "touch /etc/agentes-teste 2>/dev/null && echo ETC_GRAVAVEL; "
                "touch ok && echo CLONE_GRAVAVEL"
            )
            r = subprocess.run(repo._sandbox(["sh", "-c", script]), capture_output=True, text=True, timeout=30)
            self.assertEqual(r.stdout.split(), ["CLONE_GRAVAVEL"])

    @unittest.skipUnless(shutil.which("uv"), "uv não instalado")
    def test_uv_da_home_continua_visivel_na_sandbox(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(config, "REPO_AGENTE", Path(d)), mock.patch.object(config, "DADOS_DIR", Path(d) / "dados"):
            r = subprocess.run(repo._sandbox(["uv", "--version"]), capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 0, r.stderr)


class ConferenciaDeTesteTest(unittest.TestCase):
    """O que vai no prompt sobre testes sai do código, não da palavra dos agentes."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        raiz = Path(self.dir.name)
        fin = raiz / "backend/automations/automacoes-financeiro"
        (fin / "app/routers").mkdir(parents=True)
        (fin / "tests").mkdir()
        (fin / "app/routers/danfe.py").write_text("def import_nfe_by_key():\n    pass\n")
        (fin / "tests/conftest.py").write_text("danfe danfe danfe")
        (fin / "tests/test_outro.py").write_text("x")
        (fin / "tests/test_import_chave.py").write_text("from app.routers import danfe\n" + "y" * 50)
        p = mock.patch.object(config, "REPO_AGENTE", raiz)
        p.start()
        self.addCleanup(p.stop)

    def test_eh_teste_e_exemplo_da_mesma_suite_que_cita_o_modulo(self):
        self.assertTrue(repo.eh_teste("backend/automations/automacoes-financeiro/tests/test_api.py"))
        self.assertTrue(repo.eh_teste("backend/gateway/test/roi.test.ts"))
        self.assertFalse(repo.eh_teste("backend/automations/automacoes-financeiro/app/routers/danfe.py"))
        self.assertEqual(
            repo.teste_de_exemplo("backend/automations/automacoes-financeiro/app/routers/danfe.py"),
            "backend/automations/automacoes-financeiro/tests/test_import_chave.py",
        )

    def test_alvo_do_teste_e_o_arquivo_citado_no_pedido_ou_um_novo_ao_lado_do_exemplo(self):
        from agentes import agentes

        res = {"arquivos_afetados": ["backend/automations/automacoes-financeiro/app/routers/danfe.py"], "passos": []}
        inc = {"id": 16, "amostra": "", "mensagem": "m", "funcao": None}
        citado = "backend/automations/automacoes-financeiro/tests/test_import_chave.py"
        with mock.patch.object(agentes.rag, "trecho_do_incidente", return_value=""):
            self.assertIsNone(agentes.EXECUTOR.teste_pedido(inc, {"resolucao": res, "pedido_ti": "logue em WARNING"}))
            self.assertEqual(agentes.EXECUTOR.teste_pedido(inc, {"resolucao": res, "pedido_ti": f"inclua o teste em {citado}."}), (citado, True))
            self.assertEqual(
                agentes.EXECUTOR.teste_pedido(inc, {"resolucao": res, "pedido_ti": "inclua um teste"}),
                ("backend/automations/automacoes-financeiro/tests/test_incidente_16.py", False),
            )
            # O prompt do código não leva o arquivo de teste (vai na etapa separada).
            self.assertEqual(list(agentes.EXECUTOR.arquivos(inc, {"resolucao": res, "pedido_ti": "inclua um teste"})),
                             ["backend/automations/automacoes-financeiro/app/routers/danfe.py"])

    def test_lista_conferida_dos_arquivos_alterados(self):
        from agentes import agentes

        txt = agentes._arquivos_alterados_txt({"arquivos": ["a/danfe.py"], "arquivos_teste": []})
        self.assertIn("Nenhum arquivo de teste foi alterado", txt)
        txt = agentes._arquivos_alterados_txt({"arquivos": ["a/danfe.py", "a/tests/test_x.py"], "arquivos_teste": ["a/tests/test_x.py"]})
        self.assertIn("- a/tests/test_x.py (teste)", txt)
        self.assertNotIn("Nenhum arquivo de teste", txt)

    def test_executor_escreve_o_teste_numa_segunda_chamada_e_acrescenta_ao_arquivo_citado(self):
        from agentes import agentes

        res = {"resumo": "r", "arquivos_afetados": ["backend/automations/automacoes-financeiro/app/routers/danfe.py"], "passos": []}
        inc = {"id": 16, "amostra": "", "mensagem": "m", "funcao": None, "servico": "automacao-nfe", "evento": "e",
               "ocorrencias": 1, "primeiro_em": "", "ultimo_em": "", "commit_prod": ""}
        citado = "backend/automations/automacoes-financeiro/tests/test_import_chave.py"
        fonte = {"arquivo": "backend/automations/automacoes-financeiro/app/routers/danfe.py", "procurar": "pass", "substituir": "return 1"}
        respostas = [
            agentes.Execucao(explicacao="e", edicoes=[fonte], titulo_pr="fix(x): y"),
            agentes.Teste(explicacao="t", codigo="```python\ndef test_656():\n    assert True\n```"),  # cercas saem
        ]
        prompts = []

        def gerar(modelo, sistema, prompt, esquema, num_ctx=None):
            prompts.append(prompt)
            return respostas[len(prompts) - 1]

        with mock.patch.object(agentes.rag, "trecho_do_incidente", return_value=""), mock.patch.object(agentes.rag, "buscar", return_value=[]), \
                mock.patch.object(agentes.llm, "gerar", side_effect=gerar), mock.patch.object(repo, "_git", return_value="DIFF"):
            saida, _ = agentes.EXECUTOR.rodar(inc, {"resolucao": res, "pedido_ti": f"inclua um teste em {citado}"})
        self.assertIn("etapa separada", prompts[0])
        self.assertIn(f"entra em {citado}: função com nome NOVO é acrescentada ao fim", prompts[1])
        self.assertIn("<antes>\npass\n</antes>", prompts[1])
        self.assertEqual([e["arquivo"] for e in saida["edicoes"]], [fonte["arquivo"], citado])
        texto = (config.REPO_AGENTE / citado).read_text()
        self.assertTrue(texto.startswith("from app.routers import danfe") and texto.endswith("def test_656():\n    assert True\n"))
        self.assertEqual((config.REPO_AGENTE / fonte["arquivo"]).read_text(), "def import_nfe_by_key():\n    return 1\n")


class ReindentarTest(unittest.TestCase):
    def test_trecho_novo_na_coluna_zero_ganha_o_recuo_do_trecho(self):
        atual = "def f(e):\n    try:\n        x()\n    except E as e:\n        logger.error(e)\n        raise X(502)\n"
        procurar = "logger.error(e)\n        raise X(502)"
        substituir = 'if e.c == "656":\n    logger.warning(e)\n    raise X(422)\nlogger.error(e)\nraise X(502)'
        novo = atual.replace(procurar, repo._reindentar(atual, procurar, substituir), 1)
        compile(novo, "x", "exec")
        self.assertIn('        if e.c == "656":\n            logger.warning(e)\n            raise X(422)\n        logger.error(e)\n        raise X(502)', novo)

    def test_recuo_ja_certo_nao_muda(self):
        atual = "def f():\n    a = 1\n    b = 2\n"
        self.assertEqual(repo._reindentar(atual, "a = 1\n    b = 2", "a = 3\n    b = 4"), "a = 3\n    b = 4")
        self.assertEqual(repo._reindentar(atual, "    a = 1", "    a = 5"), "    a = 5")


class PublicarTest(unittest.TestCase):
    def test_branch_ja_enviada_numa_tentativa_que_falhou_vai_para_outro_nome_sem_force(self):
        pushes = []

        def git(*args):
            if args[0] == "push":
                pushes.append(args)
                if args[-1].endswith("agente/inc-16-v12"):
                    raise RuntimeError("rejected")
            return ""

        pr = mock.Mock(returncode=0, stdout="https://github.com/o/r/pull/7\n", stderr="")
        with mock.patch.object(repo, "_git", side_effect=git), mock.patch.object(repo.subprocess, "run", return_value=pr) as run:
            self.assertEqual(repo.publicar("agente/inc-16-v12", "fix(x): y", "corpo"), "https://github.com/o/r/pull/7")
        self.assertEqual([p[-1] for p in pushes], ["HEAD:refs/heads/agente/inc-16-v12", "HEAD:refs/heads/agente/inc-16-v12-2"])
        self.assertTrue(all("--force" not in p and "-f" not in p for p in pushes))
        self.assertIn("agente/inc-16-v12-2", run.call_args[0][0])


class RevisaoDoPrTest(unittest.TestCase):
    def test_diff_do_pr_recusado_vem_da_volta_do_ultimo_refazer(self):
        with tempfile.TemporaryDirectory() as d:
            banco = Banco(Path(d) / "i.db")
            inc_id, _ = banco.receber(INC)
            self.assertEqual(pipeline.diff_do_pr_recusado(banco, inc_id), "")
            for volta, diff in ((1, "D1"), (2, "D2")):
                banco.gravar_etapa(inc_id, volta, "executor", "m", [], {"diff": diff}, 0)
            banco.gravar_desfecho(inc_id, 2, "ti_pediu_ajuste", detalhe="ajuste")
            self.assertEqual(pipeline.diff_do_pr_recusado(banco, inc_id), "D2")

    def test_mesclar_testes_substitui_o_de_mesmo_nome_e_acrescenta_o_novo(self):
        atual = (
            'from unittest.mock import patch\n\nCHAVE = "1"\n\n\ndef test_antigo():\n    assert True\n\n\n'
            "@patch('x')\ndef test_656(m):\n    assert 'a' == 'a'\n\n\ndef test_depois():\n    pass\n"
        )
        codigo = (
            'import logging\nfrom unittest.mock import patch\n\nCHAVE = "2"\n\n\n@patch("x")\n'
            'def test_656(m, caplog):\n    assert "a" == "a"\n\n\ndef test_novo():\n    pass\n'
        )
        novo = repo.mesclar_testes(atual, codigo)
        compile(novo, "t", "exec")
        self.assertEqual(novo.count("def test_656"), 1)
        self.assertIn('@patch("x")\ndef test_656(m, caplog):\n    assert "a" == "a"\n\n\ndef test_depois', novo)
        self.assertNotIn("@patch('x')", novo)
        self.assertIn('from unittest.mock import patch\nimport logging\n', novo)
        self.assertIn('CHAVE = "1"', novo)
        self.assertNotIn('CHAVE = "2"', novo)
        self.assertTrue(novo.endswith("def test_novo():\n    pass\n"))

    def test_mesclar_testes_com_codigo_invalido_so_acrescenta(self):
        self.assertEqual(repo.mesclar_testes("def a():\n    pass\n", "def b(:"), "def a():\n    pass\n\n\ndef b(:\n")

    def test_pedido_com_o_nome_do_teste_do_pr_usa_esse_arquivo(self):
        from agentes import agentes

        arquivo = "backend/automations/automacoes-financeiro/tests/test_import_chave_multi_cnpj.py"
        with tempfile.TemporaryDirectory() as d, mock.patch.object(config, "REPO_AGENTE", Path(d)):
            (Path(d) / arquivo).parent.mkdir(parents=True)
            (Path(d) / arquivo).write_text("def test_x():\n    pass\n")
            anteriores = {"resolucao": {"arquivos_afetados": []}, "pedido_ti": "test_import_chave_multi_cnpj.py: use aspas duplas no teste",
                          "diff_recusado": f"+++ b/backend/automations/automacoes-financeiro/app/routers/danfe.py\n+++ b/{arquivo}\n"}
            self.assertEqual(agentes.EXECUTOR.teste_pedido({"id": 16}, anteriores), (arquivo, True))

    def test_prompt_diz_que_o_pr_recusado_ja_esta_no_codigo(self):
        from agentes import agentes

        base = {"pedido_ti": "ajuste", "diff_recusado": "DIFF"}
        self.assertIn("JÁ CONTÉM esse diff", agentes._pedido_txt({**base, "base_recusada": True}))
        self.assertIn("(não repita)", agentes._pedido_txt(base))


class TestUvForaDoPathDoSystemd(unittest.TestCase):
    """06/11: depois de reiniciar o PC, o systemd --user sobe sem ~/.local/bin no PATH."""

    def test_ambiente_inclui_local_bin_e_acha_o_uv_da_home(self):
        with tempfile.TemporaryDirectory() as home:
            binario = Path(home) / ".local" / "bin" / "uv"
            binario.parent.mkdir(parents=True)
            binario.write_text("#!/bin/sh\n")
            binario.chmod(0o755)
            with mock.patch.dict("os.environ", {"PATH": "/usr/local/bin:/usr/bin"}), \
                    mock.patch.object(Path, "home", return_value=Path(home)):
                self.assertIn(str(binario.parent), repo._ambiente()["PATH"].split(":"))
                binds = repo._binarios_da_home()
            self.assertEqual(binds[:3], ["--ro-bind", str(binario), str(binario)])


if __name__ == "__main__":
    unittest.main()
