"""llama-server do classificador com adaptador, sem GPU: processo, /health e HTTP são simulados."""

import json
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from agentes import config, financeiro, llama_server as ls, llm
from tests.test_financeiro import CATS
from tests.test_treino_financeiro import Base

ROTULOS = list(financeiro.rotulos(CATS))


class Processo:
    """Popen falso: vivo até terminate()."""

    def __init__(self, *a, **k):
        self.returncode = None
        self.args = a[0] if a else None

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class Resposta:
    def __init__(self, corpo: dict, status: int = 200):
        self.status, self.corpo = status, corpo

    def read(self):
        return json.dumps(self.corpo).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class LlamaServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        raiz = Path(self.dir.name)
        self.binario = raiz / "llama-server"
        self.binario.touch()
        self.base = raiz / "base.gguf"
        self.base.write_bytes(b"gguf")
        self.adaptador = raiz / "promovido.gguf"
        self.adaptador.write_bytes(b"lora")
        for nome, valor in (("LLAMA_SERVER", self.binario), ("DADOS_DIR", raiz), ("LLAMA_SERVER_ESPERA", 5)):
            p = mock.patch.object(config, nome, valor)
            p.start()
            self.addCleanup(p.stop)
        self.pedidos = []

    def urlopen(self, req, timeout=None):
        url = req if isinstance(req, str) else req.full_url
        if url.endswith("/health"):
            return Resposta({"status": "ok"})
        corpo = json.loads(req.data)
        self.pedidos.append(corpo)
        itens = [{"item_id": "1", "motivo": "m", "categoria": ROTULOS[0], "confianca": "alta"}]
        return Resposta({"choices": [{"message": {"content": json.dumps({"itens": itens})}}]})

    def test_comando_usa_a_base_do_ollama_e_os_adaptadores_sem_aplicar(self):
        cmd = ls.Servidor([self.adaptador], base=self.base, num_ctx=6144, porta=8791).comando()
        self.assertEqual(cmd[:3], [str(self.binario), "-m", str(self.base)])
        self.assertIn("127.0.0.1", cmd)
        self.assertEqual(cmd[cmd.index("--lora") + 1], str(self.adaptador))
        self.assertIn("--lora-init-without-apply", cmd)
        self.assertEqual(cmd[cmd.index("-c") + 1], "6144")
        self.assertNotIn("--lora-init-without-apply", ls.Servidor([], base=self.base).comando())

    def test_base_gguf_pelo_modelfile_e_sem_leitura_explica(self):
        modelfile = f"# Modelfile\nFROM {self.base}\nTEMPLATE x\n"
        ok = subprocess.CompletedProcess([], 0, stdout=modelfile)
        with mock.patch.object(ls.subprocess, "run", return_value=ok):
            self.assertEqual(ls.base_gguf("qwen2.5:14b"), self.base)
            with mock.patch.object(ls.os, "access", return_value=False):
                with self.assertRaisesRegex(ls.LlamaServerIndisponivel, "setfacl"):
                    ls.base_gguf("qwen2.5:14b")

    def test_rotulo_do_modelo_leva_o_hash_do_adaptador(self):
        self.assertEqual(ls.rotulo_modelo(None, "qwen2.5:14b"), "qwen2.5:14b")
        self.assertRegex(ls.rotulo_modelo(self.adaptador, "qwen2.5:14b"), r"^qwen2\.5:14b\+lora-[0-9a-f]{8}$")

    def test_ciclo_segura_a_gpu_descarrega_o_ollama_e_aplica_so_o_adaptador_pedido(self):
        esquema = financeiro.esquema(ROTULOS, ["1"])
        with mock.patch.object(ls.subprocess, "Popen", side_effect=Processo) as popen, \
             mock.patch.object(ls.urllib.request, "urlopen", side_effect=self.urlopen), \
             mock.patch.object(llm, "descarregar_ollama", return_value=["qwen2.5:14b"]) as descarregar:
            with ls.Servidor([self.adaptador], base=self.base) as srv:
                outro = threading.Thread(target=lambda: setattr(self, "pegou", llm.TRAVA_GPU.acquire(blocking=False)))
                outro.start()
                outro.join()
                srv.gerar("m", "sis", "usu", esquema, lora=0)
                srv.gerar("m", "sis", "usu", esquema, lora=None)
            processo = srv.processo
        self.assertFalse(self.pegou)  # outra thread (agentes de incidentes) espera a GPU
        descarregar.assert_called_once()
        popen.assert_called_once()
        self.assertEqual(processo.returncode, 0)  # encerrado no fim
        self.assertEqual([p["lora"] for p in self.pedidos], [[{"id": 0, "scale": 1.0}], [{"id": 0, "scale": 0.0}]])
        formato = self.pedidos[0]["response_format"]
        self.assertEqual(formato["type"], "json_schema")
        self.assertEqual(formato["json_schema"]["schema"], esquema.model_json_schema())
        self.assertTrue(llm.TRAVA_GPU.acquire(blocking=False))  # devolvida
        llm.TRAVA_GPU.release()

    def test_processo_que_morre_ao_subir_devolve_a_gpu(self):
        def morto(*a, **k):
            p = Processo()
            p.returncode = 1
            return p

        with mock.patch.object(ls.subprocess, "Popen", side_effect=morto), \
             mock.patch.object(llm, "descarregar_ollama", return_value=[]):
            with self.assertRaisesRegex(ls.LlamaServerIndisponivel, "código 1"):
                ls.Servidor([self.adaptador], base=self.base).__enter__()
        self.assertTrue(llm.TRAVA_GPU.acquire(blocking=False))
        llm.TRAVA_GPU.release()

    def test_sem_binario_nao_toca_na_gpu(self):
        self.binario.unlink()
        with mock.patch.object(llm, "descarregar_ollama") as descarregar:
            with self.assertRaisesRegex(ls.LlamaServerIndisponivel, "não instalado"):
                ls.Servidor([self.adaptador], base=self.base).__enter__()
        descarregar.assert_not_called()


class MotorTest(Base):
    def test_sem_adaptador_promovido_usa_o_ollama(self):
        with mock.patch.object(config, "ADAPTADOR_FINANCEIRO", Path(self.dir.name) / "nao-existe.gguf"):
            with financeiro.motor() as (gerar, nome):
                self.assertIs(gerar, llm.gerar)
                self.assertEqual(nome, config.MODELO_FINANCEIRO)

    def test_llama_server_fora_cai_no_ollama(self):
        adaptador = Path(self.dir.name) / "promovido.gguf"
        adaptador.write_bytes(b"lora")
        with mock.patch.object(config, "ADAPTADOR_FINANCEIRO", adaptador), \
             mock.patch.object(ls.Servidor, "__enter__", side_effect=ls.LlamaServerIndisponivel("sem binário")):
            with financeiro.motor() as (gerar, nome):
                self.assertIs(gerar, llm.gerar)

    def test_com_adaptador_o_lote_vai_ao_llama_server_e_a_vps_ve_o_rotulo(self):
        adaptador = Path(self.dir.name) / "promovido.gguf"
        adaptador.write_bytes(b"lora")
        chamadas = []
        with mock.patch.object(config, "ADAPTADOR_FINANCEIRO", adaptador), \
             mock.patch.object(ls.Servidor, "__enter__", lambda s: s), \
             mock.patch.object(ls.Servidor, "__exit__", lambda s, *e: chamadas.append("saiu")), \
             mock.patch.object(ls.Servidor, "gerar", lambda s, *a, lora=None: chamadas.append(lora) or "ok"):
            with financeiro.motor() as (gerar, nome):
                self.assertEqual(gerar("m", "s", "u", None), "ok")
                self.assertTrue(nome.startswith(f"{config.MODELO_FINANCEIRO}+lora-"))
        self.assertEqual(chamadas, [0, "saiu"])


if __name__ == "__main__":
    unittest.main()
