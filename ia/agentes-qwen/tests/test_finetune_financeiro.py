"""Etapa 5 sem GPU: pré-voo, liberação da GPU, Modelfile, repasse ao .venv-treino e o gate de qualidade."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agentes import __main__ as cli, finetune_financeiro as ft, llm, treino_financeiro as tf
from tests.test_financeiro import CATS
from tests.test_treino_financeiro import Base

COMPRAS, LIMPEZA, ESCRITORIO = (c["id"] for c in CATS)
ROTULO = {COMPRAS: "3.Custos → Compras", LIMPEZA: "4.Despesas Operacionais → Materiais de Limpeza",
          ESCRITORIO: "4.Despesas Operacionais → Material de Escritório"}


class PreVooTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.pasta = Path(self.dir.name)

    def sft(self, n):
        linha = json.dumps({"messages": [{"role": "user", "content": "x"}, {"role": "assistant", "content": "{}"}]})
        (self.pasta / "financeiro_sft.jsonl").write_text("\n".join([linha] * n) + "\n")

    def test_sem_dataset_ou_abaixo_do_minimo_nao_treina(self):
        with mock.patch.object(ft, "treinar") as treinar:
            self.assertEqual(ft.main(["--pasta", str(self.pasta)]), 2)
            self.sft(5)
            self.assertEqual(ft.main(["--pasta", str(self.pasta), "--min-exemplos", "10"]), 2)
        treinar.assert_not_called()

    def test_force_treina_com_a_gpu_livre_e_registra_o_candidato(self):
        self.sft(5)
        ordem = []
        with mock.patch.object(ft, "baixar_base", side_effect=lambda repo: ordem.append("baixar")), \
             mock.patch.object(ft, "treinar", side_effect=lambda *a: ordem.append("treinar")), \
             mock.patch.object(ft, "gpu_livre", side_effect=lambda parar: _ctx(ordem, parar)), \
             mock.patch.object(ft, "converter_gguf", return_value=self.pasta / "adapter.gguf") as conv:
            codigo = ft.main(["--pasta", str(self.pasta), "--saida", str(self.pasta / "lora"), "--force"])
        self.assertEqual(codigo, 0)
        self.assertEqual(ordem, ["baixar", "gpu_livre:True", "treinar", "gpu_devolvida"])
        conv.assert_called_once_with(self.pasta / "lora")  # o adapter.gguf é o candidato; nada de ollama create


class _ctx:
    def __init__(self, ordem, parar):
        self.ordem = ordem
        ordem.append(f"gpu_livre:{parar}")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.ordem.append("gpu_devolvida")
        return False


class GpuLivreTest(unittest.TestCase):
    def test_religa_o_servico_mesmo_se_o_treino_falhar(self):
        chamadas = []

        def systemctl(*args):
            chamadas.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="active\n" if args[0] == "is-active" else "")

        with mock.patch.object(ft, "_systemctl", side_effect=systemctl), \
             mock.patch.object(ft, "descarregar_ollama", return_value=[]):
            with self.assertRaises(RuntimeError):
                with ft.gpu_livre():
                    raise RuntimeError("OOM")
        self.assertEqual(chamadas, [("is-active", ft.SERVICO), ("stop", ft.SERVICO), ("start", ft.SERVICO)])

    def test_servico_parado_continua_parado(self):
        with mock.patch.object(ft, "_systemctl", return_value=subprocess.CompletedProcess([], 3, stdout="inactive\n")) as s, \
             mock.patch.object(ft, "descarregar_ollama", return_value=[]):
            with ft.gpu_livre():
                pass
        self.assertEqual([c.args[0] for c in s.call_args_list], ["is-active"])

    def test_descarrega_todo_modelo_carregado(self):
        respostas = {"/api/ps": {"models": [{"name": "qwen2.5:14b"}, {"name": "qwen2.5-coder:14b"}]}}
        with mock.patch.object(ft, "_ollama", side_effect=lambda c, corpo=None: respostas.get(c, {})) as o:
            self.assertEqual(ft.descarregar_ollama(), ["qwen2.5:14b", "qwen2.5-coder:14b"])
        self.assertIn(mock.call("/api/generate", {"model": "qwen2.5-coder:14b", "keep_alive": 0}), o.call_args_list)


class RepasseTest(unittest.TestCase):
    def test_cli_repassa_ao_venv_de_treino(self):
        with tempfile.TemporaryDirectory() as raiz:
            python = Path(raiz) / ".venv-treino" / "bin" / "python"
            with mock.patch.object(cli.config, "RAIZ", Path(raiz)), mock.patch.object(cli.subprocess, "call", return_value=0) as call:
                self.assertEqual(cli.main(["finetune-financeiro", "--force"]), 2)  # sem o venv
                python.parent.mkdir(parents=True)
                python.touch()
                self.assertEqual(cli.main(["finetune-financeiro", "--force", "--max-passos", "2"]), 0)
        call.assert_called_once()
        self.assertEqual(call.call_args.args[0], [str(python), "-m", "agentes.finetune_financeiro", "--force", "--max-passos", "2"])


class GateTest(Base):
    def validacao(self):
        exemplos = [
            {"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "nota A"}],
             "contexto": {"itens": [{"item_id": "1", "categoria_id": LIMPEZA, "valor_total": 90.0},
                                    {"item_id": "2", "categoria_id": ESCRITORIO, "valor_total": 10.0}]}},
        ]
        pasta = Path(self.dir.name)
        (pasta / "financeiro_validacao.jsonl").write_text("".join(json.dumps(e) + "\n" for e in exemplos))
        return pasta

    def servidor_falso(self, lora_errado):
        """Servidor que erra o item 2 quando a requisição usa o adaptador `lora_errado`."""
        teste = self

        class Falso:
            def __init__(self, adaptadores, **_):
                teste.adaptadores = adaptadores

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def gerar(self, modelo, sistema, usuario, esquema, lora=None):
                cat = COMPRAS if lora == lora_errado else ESCRITORIO
                return esquema.model_validate({"itens": [
                    {"item_id": "1", "motivo": "m", "categoria": ROTULO[LIMPEZA], "confianca": "alta"},
                    {"item_id": "2", "motivo": "m", "categoria": ROTULO[cat], "confianca": "media"},
                ]})

        return Falso

    def candidato(self):
        arq = Path(self.dir.name) / "cand.gguf"
        arq.write_bytes(b"candidato")
        return arq

    def test_mede_base_pura_contra_o_candidato_no_mesmo_servidor(self):
        from agentes import llama_server

        with mock.patch.object(llama_server, "Servidor", self.servidor_falso(lora_errado=None)):
            atual, novo = tf.comparar(self.banco, self.candidato(), self.validacao())
        self.assertEqual(self.adaptadores, [self.candidato()])
        self.assertEqual((atual.acertos, atual.itens), (1, 2))
        self.assertAlmostEqual(atual.acuracia_valor, 0.9)
        self.assertEqual((novo.acertos, novo.acuracia_valor), (2, 1.0))
        self.assertTrue(novo.modelo.startswith("qwen2.5:14b+lora-"))

    def test_com_promovido_o_atual_e_o_adaptador_promovido(self):
        from agentes import llama_server

        promovido = Path(self.dir.name) / "promovido.gguf"
        promovido.write_bytes(b"antigo")
        with mock.patch.object(llama_server, "Servidor", self.servidor_falso(lora_errado=1)):
            atual, novo = tf.comparar(self.banco, self.candidato(), self.validacao(), promovido)
        self.assertEqual(self.adaptadores, [promovido, self.candidato()])
        self.assertEqual((atual.acertos, novo.acertos), (2, 1))

    def test_promover_troca_o_arquivo_e_guarda_o_anterior(self):
        destino = Path(self.dir.name) / "financeiro" / "promovido.gguf"
        self.assertIsNone(tf.promover(self.candidato(), destino))
        self.assertEqual(destino.read_bytes(), b"candidato")
        novo = Path(self.dir.name) / "novo.gguf"
        novo.write_bytes(b"novo")
        anterior = tf.promover(novo, destino)
        self.assertEqual((destino.read_bytes(), anterior.read_bytes()), (b"novo", b"candidato"))

    def test_cli_so_promove_se_nao_piorar_e_para_o_servico(self):
        from agentes import finetune_financeiro, llama_server

        pasta = self.validacao()
        promovido = Path(self.dir.name) / "promovido.gguf"
        args = ["comparar-financeiro", "--candidato", str(self.candidato()), "--pasta", str(pasta), "--promover"]
        with mock.patch.object(cli, "Banco", return_value=self.banco), \
             mock.patch.object(cli.config, "ADAPTADOR_FINANCEIRO", promovido), \
             mock.patch.object(finetune_financeiro, "gpu_livre", side_effect=lambda: _ctx([], True)) as livre:
            with mock.patch.object(llama_server, "Servidor", self.servidor_falso(lora_errado=0)):
                self.assertEqual(cli.main(args), 1)  # sem promovido: base pura (None) acerta tudo, candidato (0) erra
            self.assertFalse(promovido.exists())
            with mock.patch.object(llama_server, "Servidor", self.servidor_falso(lora_errado=None)):
                self.assertEqual(cli.main(args), 0)
            self.assertEqual(promovido.read_bytes(), b"candidato")
        self.assertEqual(livre.call_count, 2)

    def test_tudo_invalido_nao_e_empate(self):
        from agentes import finetune_financeiro, llama_server, llm

        Falso = self.servidor_falso(lora_errado=None)
        Falso.gerar = lambda self, *a, lora=None: (_ for _ in ()).throw(llm.SaidaInvalida("fora do schema"))
        promovido = Path(self.dir.name) / "promovido.gguf"
        args = ["comparar-financeiro", "--candidato", str(self.candidato()), "--pasta", str(self.validacao()), "--promover"]
        with mock.patch.object(cli, "Banco", return_value=self.banco), \
             mock.patch.object(cli.config, "ADAPTADOR_FINANCEIRO", promovido), \
             mock.patch.object(finetune_financeiro, "gpu_livre", side_effect=lambda: _ctx([], True)), \
             mock.patch.object(llama_server, "Servidor", Falso):
            self.assertEqual(cli.main(args), 1)
        self.assertFalse(promovido.exists())


if __name__ == "__main__":
    unittest.main()
