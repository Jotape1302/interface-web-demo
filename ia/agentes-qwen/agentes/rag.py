"""Uma RAG (coleção Chroma) por agente.

Cada agente lê só as pastas da base do interface-web que servem à sua tarefa (FONTES; "repo:"
é um arquivo do próprio interface-web, como as Regras de Ouro do .codexrules). A da
resolução recebe também os incidentes que o TI marcou como resolvidos, com a nota de como foi
resolvido: é assim que ela aprende com o tempo.

Busca: vetorial (bge-m3) nos CANDIDATOS mais próximos, reordenada pelo reranker
(bge-reranker-v2-m3, fp16 na GPU para caber junto com o Qwen) e cortada em TOP_K.
"""

from __future__ import annotations

import hashlib
import re
import threading
from pathlib import Path
from typing import Iterable, Optional

from . import config

FONTES = {
    # Onde está o problema: catálogos de log, arquitetura e o que cada automação faz.
    "diagnostico": ["runbooks", "architecture", "automations", "integrations", "database"],
    # O que fazer: runbooks ("O que fazer"), infraestrutura e regras das automações.
    "resolucao": ["runbooks", "infrastructure", "automations", "integrations"],
    # Como escrever a mudança: arquitetura, banco e as fronteiras de cada papel do monorepo.
    "executor": ["architecture", "database", "repo:agents/gateway.md", "repo:agents/backend.md",
                 "repo:agents/automation_engineer.md", "repo:agents/frontend.md"],
    # Como julgar a mudança: papel de QA, Regras de Ouro e a infraestrutura de testes.
    "qualidade": ["repo:agents/qa_engineer.md", "repo:.codexrules", "infrastructure"],
}
TAM_TRECHO = 1800
SOBREPOSICAO = 200

_trava = threading.Lock()
_trava_chroma = threading.RLock()  # o cliente do Chroma não aguenta ser criado/escrito por várias threads ao mesmo tempo
_embeddings = None
_reranker = None
_cliente = None


def _modelo_embeddings():
    global _embeddings
    with _trava:
        if _embeddings is None:
            import torch
            from sentence_transformers import SentenceTransformer

            meia = {"torch_dtype": torch.float16} if config.EMBEDDING_DEVICE.startswith("cuda") else {}
            _embeddings = SentenceTransformer(config.EMBEDDING_MODEL, device=config.EMBEDDING_DEVICE, model_kwargs=meia)
    return _embeddings


def _modelo_reranker():
    global _reranker
    with _trava:
        if _reranker is None:
            import torch
            from sentence_transformers import CrossEncoder

            device = config.RERANK_DEVICE
            if device == "auto":
                device = "cuda" if torch.cuda.is_available() else "cpu"
            meia = {"torch_dtype": torch.float16} if device.startswith("cuda") else {}
            _reranker = CrossEncoder(config.RERANK_MODEL, device=device, max_length=512, model_kwargs=meia)
    return _reranker


def _colecao(agente: str, recriar: bool = False):
    global _cliente
    import chromadb

    with _trava_chroma:
        if _cliente is None:
            config.CHROMA_DIR.mkdir(parents=True, exist_ok=True)
            _cliente = chromadb.PersistentClient(path=str(config.CHROMA_DIR))
        nome = f"agente_{agente}"
        if recriar:
            try:
                _cliente.delete_collection(nome)
            except Exception:  # noqa: BLE001 — coleção ainda não existe
                pass
        return _cliente.get_or_create_collection(nome, metadata={"hnsw:space": "cosine"})


def fatiar(texto: str, origem: str) -> list[tuple[str, str]]:
    """(rótulo, trecho) por seção "## " do Markdown; seção longa é partida com sobreposição."""
    titulo_doc = next((linha[2:].strip() for linha in texto.splitlines() if linha.startswith("# ")), origem)
    secoes = re.split(r"(?m)^(?=## )", texto)
    trechos = []
    for secao in secoes:
        secao = secao.strip()
        if not secao or secao.startswith("> **Metadados RAG**"):
            continue
        cabecalho = secao.splitlines()[0].lstrip("# ").strip() if secao.startswith("## ") else titulo_doc
        rotulo = f"{origem} › {cabecalho}"
        inicio = 0
        while inicio < len(secao):
            trechos.append((rotulo, secao[inicio : inicio + TAM_TRECHO]))
            if inicio + TAM_TRECHO >= len(secao):
                break
            inicio += TAM_TRECHO - SOBREPOSICAO
    return trechos


def _documentos(agente: str, extras: Iterable[tuple[str, str]] = ()) -> list[tuple[str, str]]:
    docs = []
    for fonte in FONTES[agente]:
        if fonte.startswith("repo:"):
            arquivo = config.REPO_INTERFACE / fonte[5:]
            if arquivo.is_file():
                docs += fatiar(arquivo.read_text(encoding="utf-8"), f"interface-web/{fonte[5:]}")
            continue
        for arquivo in sorted((config.KNOWLEDGE_DIR / fonte).rglob("*.md")):
            origem = str(arquivo.relative_to(config.KNOWLEDGE_DIR))
            docs += fatiar(arquivo.read_text(encoding="utf-8"), origem)
    return docs + list(extras)


def ingerir(agente: str, extras: Iterable[tuple[str, str]] = ()) -> int:
    """Recria a coleção do agente a partir das fontes. Devolve o número de trechos."""
    docs = _documentos(agente, extras)
    vetores = _modelo_embeddings().encode([f"[{r}]\n{t}" for r, t in docs], normalize_embeddings=True, batch_size=16, show_progress_bar=True)
    col = _colecao(agente, recriar=True)
    ids = [hashlib.sha1(f"{i}|{r}|{t}".encode()).hexdigest()[:16] for i, (r, t) in enumerate(docs)]
    for i in range(0, len(docs), 256):
        col.add(
            ids=ids[i : i + 256],
            embeddings=[v.tolist() for v in vetores[i : i + 256]],
            documents=[t for _, t in docs[i : i + 256]],
            metadatas=[{"rotulo": r} for r, _ in docs[i : i + 256]],
        )
    return len(docs)


def adicionar(agente: str, rotulo: str, texto: str) -> None:
    """Acrescenta um trecho à coleção sem reindexar tudo (incidente resolvido → RAG da resolução)."""
    vetor = _modelo_embeddings().encode([f"[{rotulo}]\n{texto}"], normalize_embeddings=True)[0].tolist()
    ident = hashlib.sha1(f"{rotulo}|{texto}".encode()).hexdigest()[:16]
    with _trava_chroma:
        _colecao(agente).upsert(ids=[ident], embeddings=[vetor], documents=[texto], metadatas=[{"rotulo": rotulo}])


def texto_resolvido(banco, inc) -> str:
    """Como um incidente resolvido entra na RAG da resolução: erro, causa e como foi resolvido."""
    import json

    etapas = {e["agente"]: json.loads(e["saida"]) for e in banco.etapas(inc["id"])}
    return (
        f"Incidente resolvido #{inc['id']} ({inc['servico']} · {inc['evento']})\nMensagem: {inc['mensagem']}\n"
        f"Causa: {etapas.get('diagnostico', {}).get('causa_raiz', '-')}\nComo foi resolvido: {inc['nota_ti']}"
    )


def buscar(agente: str, pergunta: str, k: Optional[int] = None) -> list[dict]:
    """[{rotulo, texto, nota}] do mais ao menos relevante."""
    col = _colecao(agente)
    if col.count() == 0:
        return []
    q = _modelo_embeddings().encode([pergunta], normalize_embeddings=True)[0].tolist()
    res = col.query(query_embeddings=[q], n_results=min(config.CANDIDATOS, col.count()))
    cands = [{"rotulo": m["rotulo"], "texto": d} for d, m in zip(res["documents"][0], res["metadatas"][0])]
    notas = _modelo_reranker().predict([(pergunta, c["texto"]) for c in cands], batch_size=8, show_progress_bar=False)
    for c, n in zip(cands, notas):
        c["nota"] = round(float(n), 4)
    cands.sort(key=lambda c: -c["nota"])
    return cands[: k or config.TOP_K]


def trecho_do_codigo(funcao: str, linhas: int = 60, raiz: Optional[Path] = None) -> Optional[str]:
    """Trecho do interface-web com a função citada no stack ("arquivo.py:nome" ou "arquivo.js:nome").

    O gateway roda compilado (dist/*.js): procura o .ts de mesmo nome em src/.
    """
    raiz = raiz or config.REPO_INTERFACE
    if not funcao or ":" not in funcao or not raiz.is_dir():
        return None
    arquivo, nome = funcao.split(":", 1)
    base = Path(arquivo).stem
    nomes = {arquivo} if arquivo.endswith(".py") else {f"{base}.ts", f"{base}.tsx", arquivo}
    nome_curto = nome.split(".")[-1]
    padrao = re.compile(rf"^\s*(async\s+)?(def|function|export\s+(async\s+)?function|(private|public|static|async)\s+)?\s*{re.escape(nome_curto)}\s*[(<]")
    for caminho in sorted(raiz.rglob("*")):
        if caminho.name not in nomes or any(p in caminho.parts for p in ("node_modules", "dist", ".venv", "tests", "__pycache__")):
            continue
        fonte = caminho.read_text(encoding="utf-8", errors="replace").splitlines()
        for i, linha in enumerate(fonte):
            if padrao.match(linha):
                rel = caminho.relative_to(raiz)
                corpo = "\n".join(f"{n + 1:4d}  {t}" for n, t in enumerate(fonte[i : i + linhas], start=i))
                return f"{rel} (linha {i + 1}):\n{corpo}"
    return None


_IGNORAR = ("node_modules", "dist", ".venv", "tests", "test", "__pycache__")
_FONTES = {".py", ".ts", ".tsx"}
LITERAL_MINIMO = 15
ANTES_DA_LINHA = 30


def _arquivos_fonte(raiz: Path):
    for caminho in sorted(raiz.rglob("*")):
        if caminho.suffix in _FONTES and caminho.is_file() and not any(p in caminho.parts for p in _IGNORAR):
            yield caminho


def _literais(mensagem: str) -> list[str]:
    """Pedaços fixos da mensagem do log: o que fica entre os valores variáveis (<longo>, ***, ': ')."""
    pedacos = re.split(r"<[^>]*>|\*{3}|: |\(ref\.", mensagem or "")
    return [p.strip() for p in pedacos if len(p.strip()) >= LITERAL_MINIMO and not p.strip().isdigit()]


def trecho_pelo_log(mensagem: str, rota: Optional[str] = None, linhas: int = 60, raiz: Optional[Path] = None) -> Optional[str]:
    """Trecho do interface-web onde a mensagem do log é escrita (ou, sem achar, onde a rota é declarada).

    Para erros sem traceback (ex.: logger.error(f"[IMPORT_KEY] Falha ao consultar chave {raw_key}: {e}")),
    em que trecho_do_codigo não tem função para procurar e os agentes ficavam sem código nenhum.
    """
    raiz = raiz or config.REPO_INTERFACE
    if not raiz.is_dir():
        return None
    alvos = _literais(mensagem)
    caminho_rota = (rota or "").split(" ")[-1]
    if caminho_rota.startswith("/"):
        alvos += [f'"{caminho_rota}"', f"'{caminho_rota}'"]
    arquivos = [(c, c.read_text(encoding="utf-8", errors="replace").splitlines()) for c in _arquivos_fonte(raiz)]
    for alvo in alvos:
        for caminho, fonte in arquivos:
            for i, linha in enumerate(fonte):
                if alvo in linha:
                    inicio = max(0, i - ANTES_DA_LINHA) if not alvo.startswith(("\"", "'")) else i
                    corpo = "\n".join(f"{n + 1:4d}  {t}" for n, t in enumerate(fonte[inicio : inicio + linhas], start=inicio))
                    return f"{caminho.relative_to(raiz)} (linha {inicio + 1}):\n{corpo}"
    return None


def trecho_do_incidente(inc, raiz: Optional[Path] = None) -> Optional[str]:
    """O trecho da função do stack ou, sem ela, o de onde a mensagem do log nasce."""
    chaves = inc.keys() if hasattr(inc, "keys") else []
    return trecho_do_codigo(inc["funcao"] or "", raiz=raiz) or trecho_pelo_log(
        inc["mensagem"] or "", inc["rota"] if "rota" in chaves else None, raiz=raiz
    )
