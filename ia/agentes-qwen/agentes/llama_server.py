"""llama-server (llama.cpp) para o classificador de NF-e com adaptador LoRA.

O Ollama 0.40 deixou de aceitar ADAPTER no Modelfile. O llama-server carrega o MESMO GGUF do
qwen2.5:14b que o Ollama já tem (sem cópia: o caminho sai de `ollama show --modelfile`) e aplica os
adaptadores por requisição (`"lora": [{"id": n, "scale": 1}]`), sem recarregar a base. Vários
adaptadores (um por atividade) podem ficar carregados juntos; nenhum aplicado = a base pura.

Ciclo por lote, dentro da llm.TRAVA_GPU (os agentes de incidentes esperam):
  descarrega o Ollama → sobe o servidor em 127.0.0.1:LLAMA_SERVER_PORTA → espera o /health →
  classifica → encerra o processo (a VRAM volta para o Ollama).

Pré-requisitos (README, "Fine-tuning"): o binário em dados/llama-server/ (scripts/instalar-llama-server.sh)
e leitura do blob do Ollama pelo seu usuário (setfacl, uma vez).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Type

from . import config, llm

logger = logging.getLogger("agentes.llama_server")


class LlamaServerIndisponivel(Exception):
    """Binário ausente, base sem leitura ou servidor que não subiu: o lote segue no Ollama sem adaptador."""


def base_gguf(modelo: str = "") -> Path:
    """Caminho do GGUF que o Ollama usa para `modelo` (linha FROM do Modelfile)."""
    modelo = modelo or config.MODELO_FINANCEIRO
    try:
        saida = subprocess.run(["ollama", "show", "--modelfile", modelo], capture_output=True, text=True, timeout=60, check=True).stdout
    except (OSError, subprocess.SubprocessError) as erro:
        raise LlamaServerIndisponivel(f"ollama show {modelo}: {erro}") from erro
    caminho = next((Path(l.split(None, 1)[1].strip()) for l in saida.splitlines() if l.startswith("FROM /")), None)
    if caminho is None:
        raise LlamaServerIndisponivel(f"Modelfile de {modelo} sem FROM para um arquivo GGUF")
    if not os.access(caminho, os.R_OK):
        raise LlamaServerIndisponivel(
            f"sem leitura em {caminho} (blob do Ollama): libere com setfacl, ver README, seção Fine-tuning"
        )
    return caminho


def rotulo_modelo(adaptador: Optional[Path], base: str = "") -> str:
    """Nome que vai para a VPS e para o registro: a base e, com adaptador, 8 dígitos do sha256 dele."""
    base = base or config.MODELO_FINANCEIRO
    if adaptador is None:
        return base
    h = hashlib.sha256()
    with adaptador.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return f"{base}+lora-{h.hexdigest()[:8]}"


class Servidor:
    """`with Servidor([adaptador, ...]) as s: s.gerar(..., lora=0)`. Segura a trava da GPU do início ao fim."""

    def __init__(self, adaptadores: list[Path], base: Optional[Path] = None, num_ctx: int = 0, porta: int = 0):
        self.adaptadores = adaptadores
        self.base = base
        self.num_ctx = num_ctx or config.NUM_CTX
        self.porta = porta or config.LLAMA_SERVER_PORTA
        self.url = f"http://127.0.0.1:{self.porta}"
        self.processo: Optional[subprocess.Popen] = None
        self._log = None

    def comando(self) -> list[str]:
        cmd = [str(config.LLAMA_SERVER), "-m", str(self.base), "--host", "127.0.0.1", "--port", str(self.porta),
               "-c", str(self.num_ctx), "-ngl", "999", "-np", "1", "--jinja", "--no-webui",
               # Mesmo ajuste do Ollama (override.conf): flash attention + KV q8_0 cabem com folga nos 12 GB.
               "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"]
        for a in self.adaptadores:
            cmd += ["--lora", str(a)]
        if self.adaptadores:
            cmd.append("--lora-init-without-apply")  # cada requisição diz qual aplicar
        return cmd

    def __enter__(self) -> "Servidor":
        if not config.LLAMA_SERVER.is_file():
            raise LlamaServerIndisponivel(f"llama-server não instalado em {config.LLAMA_SERVER}")
        self.base = self.base or base_gguf()
        llm.TRAVA_GPU.acquire()
        try:
            descarregados = llm.descarregar_ollama()
            if descarregados:
                logger.info("Ollama descarregado para o llama-server: %s", ", ".join(descarregados))
            log = config.DADOS_DIR / "llama-server.log"
            self._log = log.open("ab")
            pasta = str(config.LLAMA_SERVER.parent)  # libs CUDA/ggml do pacote ficam ao lado do binário
            env = {**os.environ, "LD_LIBRARY_PATH": os.pathsep.join(filter(None, [pasta, os.environ.get("LD_LIBRARY_PATH")]))}
            self.processo = subprocess.Popen(self.comando(), stdout=self._log, stderr=subprocess.STDOUT, env=env)
            self._esperar_pronto()
        except BaseException:
            self._encerrar()
            llm.TRAVA_GPU.release()
            raise
        return self

    def __exit__(self, *exc) -> None:
        try:
            self._encerrar()
        finally:
            llm.TRAVA_GPU.release()

    def _esperar_pronto(self) -> None:
        limite = time.monotonic() + config.LLAMA_SERVER_ESPERA
        while time.monotonic() < limite:
            if self.processo.poll() is not None:
                raise LlamaServerIndisponivel(f"llama-server saiu com código {self.processo.returncode} (ver dados/llama-server.log)")
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=5) as resp:
                    if resp.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(1)
        raise LlamaServerIndisponivel(f"llama-server não ficou pronto em {config.LLAMA_SERVER_ESPERA} s")

    def _encerrar(self) -> None:
        if self.processo and self.processo.poll() is None:
            self.processo.terminate()
            try:
                self.processo.wait(30)
            except subprocess.TimeoutExpired:
                self.processo.kill()
                self.processo.wait(10)
        if self._log:
            self._log.close()
            self._log = None

    def gerar(self, modelo: str, sistema: str, usuario: str, esquema: Type[llm.M], lora: Optional[int] = None) -> llm.M:
        """Como llm.gerar, com o adaptador `lora` (índice na lista do construtor) ou a base pura (None)."""

        def enviar(mensagens: list[dict], schema: dict) -> str:
            corpo = {
                "messages": mensagens,
                # Formato OpenAI: o servidor lê response_format.json_schema.schema. Com "schema" solto
                # (como no README dele) cai em "qualquer objeto" e o JSON sai fora do esquema.
                "response_format": {"type": "json_schema", "json_schema": {"name": "saida", "strict": True, "schema": schema}},
                "temperature": 0.2,
                "lora": [{"id": i, "scale": 1.0 if i == lora else 0.0} for i in range(len(self.adaptadores))],
            }
            req = urllib.request.Request(
                self.url + "/v1/chat/completions", data=json.dumps(corpo).encode(), method="POST",
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT) as resp:
                    dados = json.loads(resp.read())
            except (urllib.error.URLError, OSError, TimeoutError) as erro:
                raise llm.OllamaFora(f"llama-server: {erro}") from erro
            return dados["choices"][0]["message"].get("content") or ""

        return llm.gerar_com(enviar, modelo, sistema, usuario, esquema)
