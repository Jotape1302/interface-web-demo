"""Configuração do orquestrador dos agentes Qwen (variáveis de ambiente ou .env da raiz)."""

from __future__ import annotations

import os
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]


def _carregar_env(caminho: Path) -> None:
    if not caminho.is_file():
        return
    for linha in caminho.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if linha and not linha.startswith("#") and "=" in linha:
            chave, valor = linha.split("=", 1)
            os.environ.setdefault(chave.strip(), valor.strip().strip("'\""))


_carregar_env(RAIZ / ".env")

DADOS_DIR = Path(os.getenv("DADOS_DIR", str(RAIZ / "dados")))
BANCO = DADOS_DIR / "incidentes.db"
RELATORIOS_DIR = DADOS_DIR / "relatorios"
CHROMA_DIR = DADOS_DIR / "chroma"

# Receptor: só escuta no loopback; a VPS chega pela ponta do túnel SSH reverso.
HOST = "127.0.0.1"
PORTA = int(os.getenv("PORTA", "8790"))
INCIDENTES_TOKEN = os.getenv("INCIDENTES_TOKEN", "")
TAMANHO_MINIMO_TOKEN = 32
CORPO_MAX = 64 * 1024
# POST /financeiro/sincronizar leva notas inteiras (itens + histórico): limite próprio.
CORPO_MAX_FINANCEIRO = 4 * 1024 * 1024

# Ollama local. num_ctx 6144: Qwen 14B (9,9 GB) + reranker fp16 (1,2 GB) cabem nos 12 GB da
# RTX 3060; com 8192 o Ollama passa camadas para a CPU.
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
MODELO = os.getenv("MODELO", "qwen2.5:14b")
MODELO_EXECUTOR = os.getenv("MODELO_EXECUTOR", "qwen2.5-coder:14b")
# Classificador de NF-e (financeiro.py). Mesmo modelo dos agentes por padrão: não troca modelo na VRAM.
# É também a base (GGUF do Ollama) sobre a qual o adaptador do fine-tuning roda no llama-server.
MODELO_FINANCEIRO = os.getenv("MODELO_FINANCEIRO", "qwen2.5:14b")
NUM_CTX = int(os.getenv("NUM_CTX", "6144"))
# Classificador com o adaptador LoRA do fine-tuning (etapa 5): o Ollama 0.40 não aceita mais ADAPTER,
# então o lote roda no llama-server (llama.cpp) sobre o mesmo GGUF do MODELO_FINANCEIRO no Ollama.
# Sem o arquivo promovido, o classificador segue no Ollama sem adaptador.
LLAMA_SERVER = Path(os.getenv("LLAMA_SERVER", str(DADOS_DIR / "llama-server" / "llama-server")))
LLAMA_SERVER_PORTA = int(os.getenv("LLAMA_SERVER_PORTA", "8791"))
LLAMA_SERVER_ESPERA = int(os.getenv("LLAMA_SERVER_ESPERA", "300"))  # segundos para o modelo carregar
MODELOS_FINANCEIRO_DIR = DADOS_DIR / "modelos" / "financeiro"
ADAPTADOR_FINANCEIRO = Path(os.getenv("ADAPTADOR_FINANCEIRO", str(MODELOS_FINANCEIRO_DIR / "promovido.gguf")))
CANDIDATO_FINANCEIRO = DADOS_DIR / "modelos" / "qwen-financeiro-lora" / "adapter.gguf"
# Classificador dos boletos DDA sem conta (boletos.py): mesma base, adaptador e dataset próprios.
MODELO_BOLETOS = os.getenv("MODELO_BOLETOS", MODELO_FINANCEIRO)
ADAPTADOR_BOLETOS = Path(os.getenv("ADAPTADOR_BOLETOS", str(DADOS_DIR / "modelos" / "boletos" / "promovido.gguf")))
CANDIDATO_BOLETOS = DADOS_DIR / "modelos" / "qwen-boletos-lora" / "adapter.gguf"
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "600"))
TENTATIVAS_JSON = 3

# Fontes das RAGs dos agentes: a base de conhecimento do interface-web (RAGs/knowledge) e o
# próprio código do interface-web (trecho da função citada no stack).
KNOWLEDGE_DIR = Path(os.getenv("KNOWLEDGE_DIR", str(RAIZ.parent / "RAGs" / "knowledge")))
REPO_INTERFACE = Path(os.getenv("REPO_INTERFACE", str(RAIZ.parent / "interface-web")))

# Clone de trabalho do executor (fase 2): nunca a pasta do TI. O PR sai com a identidade do TI.
REPO_AGENTE = DADOS_DIR / "interface-web"
REPO_GITHUB = os.getenv("REPO_GITHUB", "Jotape1302/interface-web-demo")
REPO_REMOTO = os.getenv("REPO_REMOTO", f"https://github.com/{REPO_GITHUB}.git")
GIT_NOME = os.getenv("GIT_NOME", "Autor")
GIT_EMAIL = os.getenv("GIT_EMAIL", "autor@users.noreply.github.com")
TESTES_TIMEOUT = int(os.getenv("TESTES_TIMEOUT", "900"))
# 8192 no executor: precisa do arquivo inteiro no prompt. Com FA + KV q8_0 cabe com o reranker.
NUM_CTX_EXECUTOR = int(os.getenv("NUM_CTX_EXECUTOR", "8192"))
# 0 = para em "pronto_para_pr" com a branch local, sem push nem PR (para testar a cadeia).
PR_ABRIR = os.getenv("PR_ABRIR", "1").lower() in ("1", "true", "sim", "yes")
# Aprovação: o TI põe o rótulo no PR e o monitor faz o merge (squash, bypass da conta do gh) com o CI verde.
# O GitHub não deixa aprovar o PR da própria conta, e o gh dos agentes usa a conta do TI.
PR_ROTULO_APROVADO = os.getenv("PR_ROTULO_APROVADO", "aprovado")
PR_APROVADORES = {u.strip().lower() for u in os.getenv("PR_APROVADORES", "Jotape1302").split(",") if u.strip()}

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
# CPU por padrão (1 vetor por consulta); "cuda" carrega em fp16. Na ingestão, cuda é bem mais
# rápido, mas só com o Qwen descarregado (ollama stop).
EMBEDDING_DEVICE = os.getenv("EMBEDDING_DEVICE", "cpu")
RERANK_MODEL = os.getenv("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
RERANK_DEVICE = os.getenv("RERANK_DEVICE", "auto")
CANDIDATOS = int(os.getenv("CANDIDATOS", "16"))
TOP_K = int(os.getenv("TOP_K", "4"))

# Uma volta = diagnóstico → resolução → executor → qualidade. Qualidade reprovou → nova volta
# com o histórico; passou do limite, o incidente vai para o TI.
MAX_VOLTAS = int(os.getenv("MAX_VOLTAS", "3"))
ESPERA_OLLAMA_FORA = 60
# Passada do monitor da fase 3 (PR mergeado? deploy? 5 execuções?), entre um incidente e outro.
MONITOR_INTERVALO = int(os.getenv("MONITOR_INTERVALO", "300"))

NOTIFICAR = os.getenv("NOTIFICAR", "1").lower() in ("1", "true", "sim", "yes")
