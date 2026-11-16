"""Clone próprio do interface-web onde o executor trabalha, testes isolados e o PR.

O clone fica em dados/interface-web (nunca a pasta de trabalho do TI). Cada volta parte de
origin/main numa branch agente/inc-<id>-v<volta>.

Segurança: o executor é um LLM influenciado por texto vindo dos logs de produção. Por isso:
- só edita arquivos em backend/ e frontend/, fora da lista PROIBIDOS (segredos, migrações,
  compose, Dockerfile, CI, dependências, governança) — conferido aqui, não só no prompt;
- os testes rodam no bubblewrap SEM rede e com a home trocada por um tmpfs (sem ~/.ssh, sem o
  token do gh); as dependências são baixadas antes, com rede, a partir dos lockfiles da main,
  sem nenhuma edição do agente aplicada;
- o resultado é sempre um PR: merge e deploy são do TI.
"""

from __future__ import annotations

import ast
import hashlib
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from . import config

logger = logging.getLogger(__name__)

PERMITIDOS = ("backend/", "frontend/")
PROIBIDOS = re.compile(
    r"(^|/)\.env|\.(pem|pfx|p12|key|crt)$|(^|/)docker-compose|(^|/)Dockerfile|(^|/)package(-lock)?\.json$"
    r"|(^|/)requirements[^/]*\.(txt|lock)$|(^|/)(pyproject\.toml|uv\.lock|ruff\.toml)$|(^|/)\.github/|(^|/)node_modules/"
    r"|(^|/)\.venv/|(^|/)dist/|(^|/)data/|(^|/)migrations?/"
)

# Pasta do monorepo → comandos que provam que nada quebrou (scripts do package.json da raiz, que
# o executor não pode alterar). (comando, precisa de node_modules em <pasta>)
SUITES = {
    # build -- --noEmit, e não "npm --prefix ... exec -- tsc": o exec roda na raiz (sem tsconfig) e só imprime a ajuda.
    "backend/gateway": [["npm", "run", "test:gateway"], ["npm", "--prefix", "backend/gateway", "run", "build", "--", "--noEmit"]],
    "frontend": [["npm", "run", "test:frontend"], ["npm", "--prefix", "frontend", "run", "typecheck"]],
    "backend/automations/automacoes-financeiro": [["npm", "run", "test:nfe"]],
    "backend/automations/automacoes-marketplace": [["npm", "run", "test:marketplace"]],
    "backend/automations/contagem-estoque": [["npm", "run", "test:estoque"]],
    "backend/automations/automacoes-producao": [["npm", "run", "test:producao"]],
}
SAIDA_MAX = 4000
# Pasta do monorepo → serviço do docker compose da VPS (deployment.md da RAG).
SERVICOS_COMPOSE = {
    "backend/gateway": "gateway",
    "backend/automations/automacoes-financeiro": "automacao-nfe",
    "backend/automations/automacoes-marketplace": "automacoes-marketplace",
    "backend/automations/contagem-estoque": "contagem-estoque",
}
VPS_DIR = "~/norvia/interface-web"


class ErroEdicao(Exception):
    """Edição recusada (caminho proibido) ou que não se aplica (trecho não encontrado/ambíguo)."""


class RedeFora(RuntimeError):
    """GitHub inalcançável (DNS/conexão): o incidente espera a rede voltar, como no OllamaFora."""


# 13/11 (#36–#38, #42): "Could not resolve host: github.com" logo depois de ligar o PC escalava o incidente.
_SINAIS_DE_REDE = (
    "could not resolve host", "could not resolve hostname", "failed to connect", "connection timed out",
    "connection refused", "network is unreachable", "temporary failure in name resolution",
    "connection reset", "operation timed out",
)


def eh_falha_de_rede(texto: str) -> bool:
    texto = texto.lower()
    return any(s in texto for s in _SINAIS_DE_REDE)


def _git(*args: str, checar: bool = True) -> str:
    r = subprocess.run(["git", "-C", str(config.REPO_AGENTE), *args], capture_output=True, text=True, timeout=300)
    if checar and r.returncode != 0:
        mensagem = f"git {' '.join(args)}: {r.stderr.strip()[-500:]}"
        raise (RedeFora if eh_falha_de_rede(r.stderr) else RuntimeError)(mensagem)
    return r.stdout


def _ambiente() -> dict:
    """uv com cache e Pythons próprios em dados/ (não mexe nos do TI)."""
    env = dict(os.environ)
    # O systemd --user sobe com PATH=/usr/local/bin:/usr/bin: sem isto o uv de ~/.local/bin some
    # depois de reiniciar o PC (06/11: "No such file or directory: 'uv'" no incidente #21).
    local_bin = str(Path.home() / ".local" / "bin")
    caminhos = env.get("PATH", os.defpath).split(os.pathsep)
    if local_bin not in caminhos:
        env["PATH"] = os.pathsep.join([*caminhos, local_bin])
    env["UV_CACHE_DIR"] = str(config.DADOS_DIR / "uv" / "cache")
    env["UV_PYTHON_INSTALL_DIR"] = str(config.DADOS_DIR / "uv" / "python")
    return env


def caminho_permitido(arquivo: str) -> bool:
    arquivo = arquivo.strip().lstrip("./")
    return arquivo.startswith(PERMITIDOS) and ".." not in Path(arquivo).parts and not PROIBIDOS.search(arquivo)


def preparar(branch: str, base: str = "") -> bool:
    """Clone limpo em origin/main, na branch da volta. Com `base` (o diff do PR recusado pelo TI), aplica
    o diff no índice por cima da main: True se aplicou; se a main mudou e ele não entra, segue da main pura."""
    if not (config.REPO_AGENTE / ".git").is_dir():
        config.REPO_AGENTE.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["git", "clone", "-q", config.REPO_REMOTO, str(config.REPO_AGENTE)], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            mensagem = f"git clone: {r.stderr.strip()[-500:]}"
            raise (RedeFora if eh_falha_de_rede(r.stderr) else RuntimeError)(mensagem)
    _git("config", "user.name", config.GIT_NOME)
    _git("config", "user.email", config.GIT_EMAIL)
    _git("fetch", "-q", "origin", "main")
    # -f: uma volta interrompida (reinício do serviço, escalação) pode deixar o clone sujo.
    _git("checkout", "-q", "-f", "-B", branch, "origin/main")
    _git("reset", "-q", "--hard", "origin/main")
    _git("clean", "-q", "-fd")  # sem -x: node_modules e caches (ignorados) ficam
    if not base:
        return False
    try:
        aplicar_diff(base)
    except ErroEdicao:
        logger.warning("Diff do PR recusado não se aplica mais na main; a volta parte da main pura")
        return False
    return True


TESTE = re.compile(r"(^|/)(tests?|__tests__)/|(^|/)test_[^/]*\.py$|\.test\.[jt]sx?$")


def eh_teste(arquivo: str) -> bool:
    return bool(TESTE.search(arquivo))


def teste_de_exemplo(fonte: str) -> Optional[str]:
    """Arquivo de teste da mesma suíte que mais cita o módulo editado (empate: o menor), para o executor seguir o estilo."""
    pasta = next((p for p in SUITES if fonte.startswith(p + "/")), None)
    if not pasta:
        return None
    raiz = config.REPO_AGENTE / pasta
    modulo = Path(fonte).stem
    candidatos = []
    for caminho in raiz.rglob("*"):
        rel = caminho.relative_to(config.REPO_AGENTE).as_posix()
        if "node_modules" in rel or not caminho.is_file() or not eh_teste(rel) or caminho.suffix not in (".py", ".ts", ".tsx"):
            continue
        if caminho.name in ("conftest.py", "__init__.py"):
            continue
        texto = caminho.read_text(encoding="utf-8", errors="replace")
        candidatos.append((-texto.count(modulo), len(texto), rel))
    return min(candidatos)[2] if candidatos else None


def teste_novo(exemplo: str, inc_id: int) -> str:
    """Caminho do arquivo de teste NOVO do incidente, ao lado do exemplo (criar não exige copiar trecho exato)."""
    pasta = Path(exemplo).parent.as_posix()
    if exemplo.endswith(".py"):
        return f"{pasta}/test_incidente_{inc_id}.py"
    return f"{pasta}/incidente-{inc_id}.test{Path(exemplo).suffix}"


def ler(arquivo: str) -> Optional[str]:
    caminho = config.REPO_AGENTE / arquivo
    return caminho.read_text(encoding="utf-8", errors="replace") if caminho.is_file() else None


def _recuo(linha: str) -> int:
    return len(linha) - len(linha.lstrip(" \t"))


def _reindentar(atual: str, procurar: str, substituir: str) -> str:
    """Devolve o recuo que o modelo perdeu nas linhas seguintes do trecho novo.

    'procurar' costuma começar no meio da linha (depois do recuo, como em "logger.error(...)") e o
    14B escreve o 'substituir' a partir da coluna 0 (#16, volta 10: Python inválido). Se as linhas
    seguintes de 'procurar' estão todas no recuo do trecho ou além, e alguma de 'substituir' ficou
    abaixo dele, soma o recuo do trecho às linhas seguintes de 'substituir'.
    """
    inicio = atual.index(procurar)
    prefixo = atual[atual.rfind("\n", 0, inicio) + 1:inicio]
    if not prefixo or prefixo.strip():
        return substituir
    base = len(prefixo)
    seguintes_p = [linha for linha in procurar.split("\n")[1:] if linha.strip()]
    linhas_s = substituir.split("\n")
    seguintes_s = [linha for linha in linhas_s[1:] if linha.strip()]
    if any(_recuo(linha) < base for linha in seguintes_p) or not any(_recuo(linha) < base for linha in seguintes_s):
        return substituir
    return "\n".join([linhas_s[0]] + [prefixo + linha if linha.strip() else linha for linha in linhas_s[1:]])


def aplicar(edicoes: list[dict]) -> str:
    """Aplica trocas exatas {arquivo, procurar, substituir}. Tudo ou nada. Devolve o diff."""
    novos: dict[str, str] = {}
    for e in edicoes:
        arquivo = e["arquivo"].strip().lstrip("./")
        if not caminho_permitido(arquivo):
            raise ErroEdicao(f"{arquivo}: fora do que o executor pode editar (só backend/ e frontend/, sem segredos, dependências, migrações, Docker ou CI)")
        atual = novos.get(arquivo, ler(arquivo))
        if "conteudo" in e:
            # Arquivo inteiro já montado pelo código (testes mesclados por nome em mesclar_testes).
            novos[arquivo] = e["conteudo"]
            continue
        if atual is None:
            if e["procurar"]:
                raise ErroEdicao(f"{arquivo}: arquivo não existe (para criar um arquivo, deixe 'procurar' vazio)")
            novos[arquivo] = e["substituir"]
            continue
        if not e["procurar"]:
            # Arquivo existente e 'procurar' vazio: acrescenta ao fim (testes novos num arquivo de testes).
            novos[arquivo] = atual.rstrip("\n") + "\n" + e["substituir"]
            continue
        vezes = atual.count(e["procurar"])
        if vezes > 1:
            raise ErroEdicao(_mensagem_repetido(arquivo, atual, e["procurar"], vezes))
        if vezes != 1:
            raise ErroEdicao(f"{arquivo}: o trecho de 'procurar' aparece {vezes} vez(es); precisa aparecer exatamente 1, copiado igual ao arquivo")
        novos[arquivo] = atual.replace(e["procurar"], _reindentar(atual, e["procurar"], e["substituir"]), 1)
    if not novos:
        raise ErroEdicao("nenhuma edição")
    for arquivo, texto in novos.items():
        caminho = config.REPO_AGENTE / arquivo
        caminho.parent.mkdir(parents=True, exist_ok=True)
        caminho.write_text(texto, encoding="utf-8")
    _git("add", "-A")
    return _git("diff", "--cached")


def _mensagem_repetido(arquivo: str, atual: str, procurar: str, vezes: int, contexto: int = 3, max_ocorrencias: int = 4) -> str:
    """'procurar' que aparece mais de uma vez: diz em que linhas e mostra as linhas logo acima de cada
    ocorrência, para a próxima volta incluir no 'procurar' o que o torna único (incidente #35 de
    12/11/2026: `signal: AbortSignal.timeout(8000),` aparece 2 vezes em danfe.ts e o executor
    repetiu o mesmo trecho nas 3 voltas, só com "aparece 2 vez(es)" de retorno)."""
    linhas = atual.splitlines()
    partes = []
    inicio = atual.find(procurar)
    while inicio != -1 and len(partes) < max_ocorrencias:
        n = atual.count("\n", 0, inicio)  # índice (0) da linha onde o trecho começa
        acima = "\n".join(f"  {i + 1}: {linhas[i]}" for i in range(max(0, n - contexto), min(n + 1, len(linhas))))
        partes.append(f"- linha {n + 1}:\n{acima}")
        inicio = atual.find(procurar, inicio + 1)
    return (
        f"{arquivo}: o trecho de 'procurar' aparece {vezes} vez(es); precisa aparecer exatamente 1. "
        "Inclua no 'procurar' (e no 'substituir') as linhas de cima que distinguem a ocorrência que você quer mudar "
        "(ex.: a linha com o nome da função), copiadas igual ao arquivo. Ocorrências:\n" + "\n".join(partes)
    )


def mesclar_testes(atual: str, codigo: str) -> str:
    """Junta testes Python novos a um arquivo existente: função/classe com nome que já existe SUBSTITUI a
    antiga (corrigir o teste recusado, #16), import que falta entra depois dos imports, o resto vai ao fim.
    Se algum dos dois não compila, só acrescenta ao fim (como antes)."""
    try:
        velho, novo = ast.parse(atual), ast.parse(codigo)
    except SyntaxError:
        return atual.rstrip("\n") + "\n\n\n" + codigo.strip("\n") + "\n"

    def inicio(no: ast.stmt) -> int:
        return min([no.lineno] + [d.lineno for d in getattr(no, "decorator_list", [])])

    linhas, novas = atual.splitlines(), codigo.splitlines()
    existentes = {no.name: no for no in velho.body if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    constantes = {t.id for no in velho.body if isinstance(no, ast.Assign) for t in no.targets if isinstance(t, ast.Name)}
    trocas: dict[int, tuple[int, list[str]]] = {}
    imports, fim = [], []
    for no in novo.body:
        trecho = novas[inicio(no) - 1:no.end_lineno]
        nome = getattr(no, "name", None)
        if nome in existentes:
            antigo = existentes[nome]
            trocas[inicio(antigo) - 1] = (antigo.end_lineno, trecho)
        elif isinstance(no, (ast.Import, ast.ImportFrom)):
            imports += [linha for linha in trecho if linha.strip() and linha not in linhas]
        elif not (isinstance(no, ast.Assign) and all(isinstance(t, ast.Name) and t.id in constantes for t in no.targets)):
            fim += ["", ""] + trecho
    saida, i = [], 0
    ultimo_import = max((no.end_lineno for no in velho.body if isinstance(no, (ast.Import, ast.ImportFrom))), default=0)
    while i < len(linhas):
        if i in trocas:
            ate, trecho = trocas[i]
            saida += trecho
            i = ate
            continue
        saida.append(linhas[i])
        i += 1
        if i == ultimo_import:
            saida += imports
    if not ultimo_import:
        saida = imports + saida
    return "\n".join(saida).rstrip("\n") + "\n" + ("\n".join(fim) + "\n" if fim else "")


def aplicar_diff(diff: str) -> None:
    r = subprocess.run(["git", "-C", str(config.REPO_AGENTE), "apply", "--index", "-"], input=diff, capture_output=True, text=True)
    if r.returncode != 0:
        raise ErroEdicao(f"diff gravado não se aplica mais na main: {r.stderr.strip()[-300:]}")


def suites(arquivos: list[str]) -> list[str]:
    return sorted({pasta for pasta in SUITES for a in arquivos if a.startswith(pasta + "/")})


def comandos_deploy(arquivos: list[str]) -> list[str]:
    """O que rodar depois do merge, tirado dos arquivos que o PR muda (não do LLM)."""
    servicos = sorted({s for pasta, s in SERVICOS_COMPOSE.items() for a in arquivos if a.startswith(pasta + "/")})
    linhas = ["Na VPS:", "```bash", f"cd {VPS_DIR}", "git pull origin main"]
    if servicos:
        linhas += [f"docker compose up -d --build {' '.join(servicos)}",
                   "docker compose ps   # em 1 a 2 min: (healthy) em " + ", ".join(servicos)]
        linhas += [f"docker compose logs --tail=30 {s}" for s in servicos]
    linhas.append("```")
    if any(a.startswith("frontend/") for a in arquivos):
        linhas += ["", "Frontend (export estático, na sua máquina, a partir da main atualizada):", "```bash",
                   "cd frontend && npm ci && npm run build",
                   "rsync -avz --delete -e 'ssh -p 2222' dist/client/automacoes/ norvia@servidor.norvia.example:/var/www/automacoes",
                   "```", "Confira o destino `/var/www/automacoes` antes do `--delete`."]
    if any(a.startswith("backend/automations/automacoes-producao/") for a in arquivos):
        linhas += ["", "`automacoes-producao` roda no PC do encarregado (fora do compose da VPS): atualize lá."]
    return linhas


def _hash(caminho: Path) -> str:
    return hashlib.sha1(caminho.read_bytes()).hexdigest() if caminho.is_file() else ""


def aquecer(pastas: list[str]) -> list[str]:
    """Baixa dependências COM rede, antes de aplicar a edição (lockfiles da main). Erros em texto."""
    erros, env = [], _ambiente()
    for pasta in pastas:
        raiz = config.REPO_AGENTE / pasta
        if (raiz / "package-lock.json").is_file():
            marca = raiz / "node_modules" / ".agentes-lock"
            if not marca.is_file() or marca.read_text() != _hash(raiz / "package-lock.json"):
                r = subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=raiz, capture_output=True, text=True, timeout=1200, env=env)
                if r.returncode != 0:
                    erros.append(f"npm ci em {pasta}: {r.stderr[-500:]}")
                    continue
                marca.write_text(_hash(raiz / "package-lock.json"))
        if (raiz / "requirements.lock").is_file():
            r = subprocess.run(
                ["uv", "run", "-q", "--no-project", "--python", "3.11", "--with-requirements", "requirements.lock",
                 "--with", "pytest", "--with", "httpx", "python", "-c", "pass"],
                cwd=raiz, capture_output=True, text=True, timeout=1200, env=env,
            )
            if r.returncode != 0:
                erros.append(f"uv em {pasta}: {r.stderr[-500:]}")
    return erros


def _sandbox(cmd: list[str]) -> list[str]:
    """bubblewrap: sistema só leitura, home vazia (tmpfs), sem rede; graváveis só o clone e o uv de dados/."""
    uv = config.DADOS_DIR / "uv"
    uv.mkdir(parents=True, exist_ok=True)
    return [
        "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--tmpfs", str(Path.home()), *_binarios_da_home(), "--bind", str(config.REPO_AGENTE), str(config.REPO_AGENTE),
        "--bind", str(uv), str(uv), "--unshare-net", "--unshare-pid", "--die-with-parent",
        "--chdir", str(config.REPO_AGENTE), *cmd,
    ]


def _binarios_da_home() -> list[str]:
    """O uv costuma ficar em ~/.local/bin, que o tmpfs da home esconderia: volta só o binário, só leitura."""
    home, binds = Path.home().resolve(), []
    for nome in ("uv", "uvx"):
        achado = shutil.which(nome, path=_ambiente()["PATH"])
        if achado and Path(achado).resolve().is_relative_to(home):
            binds += ["--ro-bind", achado, achado]
    return binds


def testar(arquivos: list[str]) -> list[dict]:
    """Roda as suítes das pastas tocadas, na sandbox. [{comando, ok, saida}]"""
    env = {**_ambiente(), "UV_OFFLINE": "1", "npm_config_offline": "true", "CI": "1"}
    resultados = []
    for pasta in suites(arquivos):
        for cmd in SUITES[pasta]:
            try:
                r = subprocess.run(_sandbox(cmd), capture_output=True, text=True, timeout=config.TESTES_TIMEOUT, env=env)
                ok, saida = r.returncode == 0, (r.stdout + r.stderr)[-SAIDA_MAX:]
            except subprocess.TimeoutExpired:
                ok, saida = False, f"tempo esgotado ({config.TESTES_TIMEOUT} s)"
            resultados.append({"comando": " ".join(cmd), "ok": ok, "saida": saida})
    py = [a for a in arquivos if a.endswith(".py") and (config.REPO_AGENTE / a).is_file()]
    if py:
        r = subprocess.run(["uvx", "ruff@0.14.0", "check", *py], cwd=config.REPO_AGENTE, capture_output=True, text=True, timeout=300, env=_ambiente())
        resultados.append({"comando": "ruff check", "ok": r.returncode == 0, "saida": (r.stdout + r.stderr)[-SAIDA_MAX:]})
    return resultados


def publicar(branch: str, titulo: str, corpo: str) -> str:
    """Commit, push da branch e PR para a main. Devolve a URL do PR."""
    _git("commit", "-q", "-m", f"{titulo}\n\nGerado pelos agentes Qwen (norvia-ti/agentes-qwen).")
    # Uma publicação que falhou depois do push (ex.: corpo do PR grande demais) deixa a branch no
    # GitHub com outro commit: sem push --force, a nova tentativa vai para <branch>-2, -3...
    destino = branch
    for tentativa in range(2, 7):
        try:
            _git("push", "-q", "-u", "origin", f"HEAD:refs/heads/{destino}")
            break
        except RuntimeError:
            if tentativa == 6:
                raise
            destino = f"{branch}-{tentativa}"
    r = subprocess.run(
        ["gh", "pr", "create", "--repo", config.REPO_GITHUB, "--base", "main", "--head", destino, "--title", titulo, "--body-file", "-"],
        input=corpo, capture_output=True, text=True, timeout=120, cwd=config.REPO_AGENTE,
    )
    if r.returncode != 0:
        raise RuntimeError(f"gh pr create: {r.stderr.strip()[-500:]}")
    return r.stdout.strip().splitlines()[-1]
