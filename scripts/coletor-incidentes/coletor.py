#!/usr/bin/env python3
"""
coletor.py — Lê os logs dos containers do interface-web, separa erros e falhas e envia cada
incidente ao orquestrador dos agentes Qwen (no PC do TI, repo agentes-qwen).

Fluxo:
  1. `docker compose logs -f -t --since <cursor>` dos serviços monitorados.
  2. Junta linhas de continuação (traceback, stack) ao registro que as abriu.
  3. É erro: JSON do gateway com `event` de erro, nível ERROR/CRITICAL das automações, traceback
     "Erro não tratado" ou linha "[Serviço] Falha ..." dos serviços internos do gateway.
  4. Mascara segredos e dados pessoais (token, senha, CPF/CNPJ, e-mail) antes de sair da VPS.
  5. Agrupa por assinatura (serviço + evento + mensagem normalizada + função do traceback): a
     1ª ocorrência sai na hora; as seguintes, dentro de JANELA_REENVIO, só somam contagem.
  6. Linhas {"event":"execucoes"} do gateway e das automações Python (contagem por rota/rotina,
     1 por minuto) vão sem agrupamento para /execucoes: o monitor dos agentes usa para ver a rota
     funcionar depois do deploy. Nos erros Python a rota vem da marca " [execucao=<chave>]" que o
     app/execucoes.py das automações põe no log, ou do "Erro não tratado [...] em <MÉTODO> <path>".
  7. Fila em SQLite: se o PC estiver desligado ou o túnel caído, tenta de novo com espera
     crescente e nada se perde.
  8. A cada PAINEL_INTERVALO, lê GET /painel do orquestrador (estado dos incidentes, PRs, deploy e
     acompanhamento das 5 execuções) e repassa ao gateway (POST /api/agentes-qwen/estado, mesmo
     token): é a aba "Agentes Qwen" do painel. PC desligado: o gateway mostra o último estado. A
     resposta traz os comandos pedidos no painel (marcar como resolvido na aba e os erros
     reportados pelo botão "Reportar erro" das abas), entregues em POST /comandos.
  9. A cada FINANCEIRO_INTERVALO, ponte do classificador Qwen da revisão de NF-e: lê pelo gateway
     (/api/agentes-qwen/financeiro/*, mesmo token; o gateway repassa ao automacoes-financeiro, que
     não tem porta no host) as notas sem classificação e uma página das confirmadas, entrega em
     POST /financeiro/sincronizar do orquestrador e aplica as classificações prontas que voltam
     (POST .../financeiro/sugestoes). O que aconteceu com cada uma vai no ciclo seguinte; sem isso
     o orquestrador manda de novo. No mesmo ciclo, a ponte dos boletos DDA sem conta faz o mesmo
     com .../financeiro/boletos/* e POST /financeiro/boletos/sincronizar (cursor próprio).

O orquestrador é alcançado em 127.0.0.1:<porta> da VPS, a ponta do túnel SSH reverso aberto pelo
PC. O Ollama nunca fica exposto.

Configuração (ambiente ou --env-file): INCIDENTES_URL (padrão http://127.0.0.1:8790/incidentes),
INCIDENTES_TOKEN (obrigatório, mínimo 32 caracteres, o mesmo do orquestrador e do
AGENTES_QWEN_TOKEN do gateway), GATEWAY_ESTADO_URL (padrão
http://127.0.0.1:3100/api/agentes-qwen/estado; vazio desliga o repasse), COMPOSE_DIR
(pasta do docker-compose.yml, padrão a raiz do repo), SERVICOS (padrão abaixo), ESTADO_DIR
(padrão ~/.local/state/coletor-incidentes), DOCKER_HOST (padrão o socket rootless do usuário),
GATEWAY_FINANCEIRO_URL (padrão http://127.0.0.1:3100/api/agentes-qwen/financeiro; vazio desliga a
ponte do classificador).

Uso:
  python3 scripts/coletor-incidentes/coletor.py --env-file .env        # serviço (systemd --user)
  python3 scripts/coletor-incidentes/coletor.py --testar < linhas.log  # só mostra o que seria enviado
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import logging
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlencode

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("coletor_incidentes")

REPO_DIR = Path(__file__).resolve().parents[2]
# automacoes-producao não está no compose da VPS: roda no PC do encarregado (etiquetas).
SERVICOS_PADRAO = "gateway automacao-nfe automacoes-marketplace automacoes-marketing contagem-estoque"
JANELA_REENVIO = 6 * 3600  # mesma assinatura só volta a ser enviada depois de 6 h
FIM_DE_REGISTRO = 2.0  # segundos sem linha nova encerram o registro aberto (traceback acabou)
AMOSTRA_MAX = 8000
TAMANHO_MINIMO_TOKEN = 32
PAINEL_INTERVALO = 60  # segundos entre um repasse do estado dos agentes ao gateway e outro
PAINEL_MAX = 1024 * 1024  # limite de corpo do gateway
FINANCEIRO_INTERVALO = 60  # segundos entre um ciclo da ponte do classificador e outro
FINANCEIRO_PAGINA_SEGUINTE = 2  # com mais confirmadas por enviar (carga do histórico), o ciclo seguinte sai logo
FINANCEIRO_PENDENTES = 10  # notas por ciclo: o Qwen leva segundos por nota
FINANCEIRO_CONFIRMADAS = 100  # confirmadas por ciclo (cabe folgado nos 4 MB do orquestrador)

# Eventos do gateway que não são defeito de código (ver knowledge/runbooks/logs-gateway.md).
# agentes_qwen_financeiro_failed: o repasse da ponte do classificador não alcançou a automação
# (ex.: contêiner reiniciando no deploy, incidente #18). É o mesmo 502 que esta ponte já trata como
# passageiro; queda de verdade da automação aparece pelos erros dela e pela saúde do sistema.
EVENTOS_IGNORADOS = {"login_locked", "admin_seed_skipped", "demo_profiles_seed_failed", "agentes_qwen_financeiro_failed"}

# Gateway sem alcançar uma automação: é o contêiner reiniciando no deploy (incidentes #27–#33 de
# 09/11/2026, 10 s de "fetch failed" e circuito aberto no rebuild da automacao-nfe). Queda de verdade
# aparece pelos erros da própria automação e pela Saúde do Sistema; lentidão (timeout) continua valendo.
_UPSTREAM_FORA = re.compile(
    r"\bfetch failed\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|Circuito '[\w-]+' está temporariamente ABERTO"
)
# Aviso de nova tentativa ("1ª tentativa falhou ...; tentando de novo"): só a falha final é erro.
_NOVA_TENTATIVA = re.compile(r"tentando de novo\s*$", re.I)

# Linha que continua o registro anterior: corpo de traceback/stack, a exceção final e os elos
# entre exceções encadeadas. Qualquer outra abre registro novo.
_CONTINUACAO = re.compile(
    r"^(\s|$|Traceback \(most recent call last\)|During handling of|The above exception"
    r"|[\w.]*(Error|Exception|Exit|Interrupt|Warning|Timeout|Refused|Failure)\b)"
)
# Serviços internos do gateway logam texto com prefixo: "[ReconciliationHistory] Falha ao gravar ...".
_PREFIXO_FALHA = re.compile(r"^\[([\w -]+)\] .*?\b(falh\w*|erro|error|exception)\b", re.I)
_NIVEL_PY = re.compile(r"\[(ERROR|CRITICAL)\]|^(ERROR|CRITICAL):")
_LINHA_COMPOSE = re.compile(r"^(?P<servico>[\w.-]+?)(?:-\d+)?\s+\|\s(?:(?P<ts>\d{4}-\d\d-\d\dT[\d:.]+Z)\s)?(?P<texto>.*)$")
_MARCA_EXECUCAO = re.compile(r"\s*\[execucao=([^\]]+)\]")
_ERRO_HTTP_PY = re.compile(r"Erro não tratado \[[^\]]*\] em ([A-Z]+) (/\S*?):? ")
_FRAME_PY = re.compile(r'File "([^"]+)", line \d+, in (\S+)')
_FRAME_JS = re.compile(r"at (?:(\S+) )?\(?([^():\s]+):\d+:\d+\)?")

_MASCARAS = [
    (re.compile(r"(?i)\bbearer\s+[\w.~+/=-]+"), "Bearer ***"),
    (re.compile(r"(?i)\b(APP_USR-|TG-)[\w-]+"), r"\1***"),
    (re.compile(r'(?i)("?(?:senha|password|passwd|secret|token|access_token|refresh_token|api_?key|chave\w*|client_secret|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,;&}]+)'), r"\1***"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "***@***"),
    (re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b"), "<cnpj>"),
    (re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b"), "<cpf>"),
    (re.compile(r"\b[A-Za-z0-9+/_-]{40,}={0,2}"), "<longo>"),
]


def mascarar(texto: str) -> str:
    for padrao, troca in _MASCARAS:
        texto = padrao.sub(troca, texto)
    return texto


def normalizar_rota(path: str) -> str:
    """Mesma regra de backend/gateway/src/execucoes.ts: ids, UUIDs, hashes e MLB123 viram :id."""
    segs = []
    for seg in path.split("/"):
        if re.fullmatch(r"\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,}|[A-Za-z]{2,5}\d{4,}", seg, flags=re.I):
            seg = ":id"
        segs.append(seg)
    return "/".join(segs)


def execucoes(reg: "Registro") -> Optional[dict]:
    """Payload da linha de contagem do gateway, ou None se o registro não é uma."""
    if not reg.linhas[0].startswith('{"event":"execucoes"'):
        return None
    try:
        dados = json.loads(reg.linhas[0])
    except ValueError:
        return None
    return {"tipo": "execucoes", "servico": reg.servico, "rotas": dados.get("rotas", {}), "ocorrido_em": dados.get("at") or reg.ts}


def normalizar(mensagem: str) -> str:
    """Tira o que muda entre ocorrências do mesmo erro (ids, números, valores entre aspas)."""
    m = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<id>", mensagem, flags=re.I)
    m = re.sub(r"'[^']*'|\"[^\"]*\"", "<v>", m)
    m = re.sub(r"\d+", "#", m)
    return re.sub(r"\s+", " ", m).strip()[:300]


class Registro:
    def __init__(self, servico: str, ts: Optional[str], linha: str) -> None:
        self.servico = servico
        self.ts = ts
        self.linhas = [linha]

    @property
    def texto(self) -> str:
        return "\n".join(self.linhas)


def classificar(reg: Registro) -> Optional[dict]:
    """Incidente (sem contagem) se o registro é erro; None se não é."""
    primeira = reg.linhas[0]
    texto = reg.texto
    evento, mensagem, pilha, rota = None, primeira, texto, None
    if primeira.startswith("{"):
        try:
            dados = json.loads(primeira)
        except ValueError:
            dados = None
        if isinstance(dados, dict) and "event" in dados:
            evento = str(dados["event"])
            if evento in EVENTOS_IGNORADOS:
                return None
            if not (evento.endswith(("_error", "_failed")) or evento in ("uncaught_exception", "unhandled_rejection")):
                return None
            mensagem = f"{dados.get('name', '')}: {dados.get('message', '')}".strip(": ") or evento
            pilha = str(dados.get("stack", "")) or texto
            if dados.get("method") and dados.get("path"):
                rota = f"{dados['method']} {normalizar_rota(str(dados['path']))}"
        elif dados is not None:
            return None
    prefixo = _PREFIXO_FALHA.match(primeira) if evento is None else None
    if prefixo:
        if _NOVA_TENTATIVA.search(primeira):
            return None
        evento = prefixo.group(1)
    if reg.servico == "gateway" and evento is not None and _UPSTREAM_FORA.search(mensagem):
        return None
    if evento is None:
        tem_traceback = "Traceback (most recent call last)" in texto
        if not (_NIVEL_PY.search(primeira) or tem_traceback or "Erro não tratado" in primeira):
            return None
        if tem_traceback:
            ultimas = [t for t in reg.linhas if t and not t.startswith((" ", "\t", "Traceback"))]
            mensagem = ultimas[-1] if len(ultimas) > 1 else primeira
        nivel = re.search(r"\[(?:ERROR|CRITICAL)\]\s*\[([\w.]+)\]", primeira)
        evento = nivel.group(1) if nivel else "erro"
        marca = _MARCA_EXECUCAO.search(primeira)
        http = _ERRO_HTTP_PY.search(primeira)
        if marca:
            rota = marca.group(1)
        elif http:
            rota = f"{http.group(1)} {normalizar_rota(http.group(2))}"
        mensagem = _MARCA_EXECUCAO.sub("", mensagem)
    # Função do próprio código mais perto do erro: a mais funda do Python, a do topo no Node.
    py = [f for f in _FRAME_PY.findall(pilha) if "site-packages" not in f[0] and "/lib/python" not in f[0]]
    js = [(f, fn or "") for fn, f in _FRAME_JS.findall(pilha) if "node_modules" not in f and not f.startswith("node:")]
    frame = py[-1] if py else (js[0] if js else None)
    funcao = f"{Path(frame[0]).name}:{frame[1]}" if frame else ""
    mensagem = mascarar(mensagem.strip())
    base = f"{reg.servico}|{evento}|{normalizar(mensagem)}|{funcao}"
    return {
        "assinatura": hashlib.sha1(base.encode()).hexdigest()[:16],
        "servico": reg.servico,
        "evento": evento,
        "funcao": funcao,
        "rota": rota,
        "mensagem": mensagem[:500],
        "amostra": mascarar(texto)[:AMOSTRA_MAX],
        "ocorrido_em": reg.ts or datetime.now(timezone.utc).isoformat(),
    }


class Agrupador:
    """Junta as linhas de cada serviço em registros (uma linha de início + continuações)."""

    def __init__(self) -> None:
        self.abertos: Dict[str, Registro] = {}
        self.ultima_linha = time.monotonic()

    def linha(self, bruta: str) -> List[Registro]:
        m = _LINHA_COMPOSE.match(bruta.rstrip("\n"))
        if not m:
            return []
        self.ultima_linha = time.monotonic()
        servico, ts, texto = m.group("servico"), m.group("ts"), m.group("texto")
        aberto = self.abertos.get(servico)
        if aberto and _CONTINUACAO.match(texto):
            aberto.linhas.append(texto)
            return []
        prontos = [aberto] if aberto else []
        self.abertos[servico] = Registro(servico, ts, texto)
        return prontos

    def fechar(self) -> List[Registro]:
        prontos = list(self.abertos.values())
        self.abertos.clear()
        return prontos


class Fila:
    """SQLite do estado: assinaturas já vistas, fila de envio e cursor dos logs."""

    def __init__(self, caminho: Path) -> None:
        caminho.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(caminho), check_same_thread=False, isolation_level=None)
        self.trava = threading.Lock()
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS vistos (assinatura TEXT PRIMARY KEY, enviado_em REAL, pendentes INTEGER);
            CREATE TABLE IF NOT EXISTS fila (id INTEGER PRIMARY KEY, payload TEXT, tentativas INTEGER DEFAULT 0, proxima REAL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), ts TEXT);
            CREATE TABLE IF NOT EXISTS cursor_financeiro (id INTEGER PRIMARY KEY CHECK (id = 1), valor TEXT);
            CREATE TABLE IF NOT EXISTS cursores (nome TEXT PRIMARY KEY, valor TEXT);
            """
        )

    def registrar(self, incidente: dict, agora: float) -> bool:
        """Enfileira se é novo ou se passou a janela; senão só soma. True se enfileirou."""
        with self.trava:
            linha = self.db.execute("SELECT enviado_em, pendentes FROM vistos WHERE assinatura=?", (incidente["assinatura"],)).fetchone()
            if linha and agora - linha[0] < JANELA_REENVIO:
                self.db.execute("UPDATE vistos SET pendentes=pendentes+1 WHERE assinatura=?", (incidente["assinatura"],))
                return False
            ocorrencias = 1 + (linha[1] if linha else 0)
            self.db.execute(
                "INSERT INTO vistos VALUES (?, ?, 0) ON CONFLICT(assinatura) DO UPDATE SET enviado_em=excluded.enviado_em, pendentes=0",
                (incidente["assinatura"], agora),
            )
            self.db.execute("INSERT INTO fila (payload) VALUES (?)", (json.dumps({**incidente, "ocorrencias": ocorrencias}),))
            return True

    def enfileirar(self, payload: dict) -> None:
        with self.trava:
            self.db.execute("INSERT INTO fila (payload) VALUES (?)", (json.dumps(payload),))

    def proximo(self, agora: float) -> Optional[tuple]:
        with self.trava:
            return self.db.execute("SELECT id, payload, tentativas FROM fila WHERE proxima<=? ORDER BY id LIMIT 1", (agora,)).fetchone()

    def concluir(self, item_id: int) -> None:
        with self.trava:
            self.db.execute("DELETE FROM fila WHERE id=?", (item_id,))

    def adiar(self, item_id: int, tentativas: int, agora: float) -> None:
        with self.trava:
            espera = min(300, 5 * 2 ** min(tentativas, 6))
            self.db.execute("UPDATE fila SET tentativas=?, proxima=? WHERE id=?", (tentativas + 1, agora + espera, item_id))

    def cursor(self) -> Optional[str]:
        linha = self.db.execute("SELECT ts FROM cursor WHERE id=1").fetchone()
        return linha[0] if linha else None

    def salvar_cursor(self, ts: str) -> None:
        with self.trava:
            self.db.execute("INSERT INTO cursor VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts", (ts,))

    def cursor_financeiro(self) -> Optional[str]:
        """Até onde as notas confirmadas já chegaram ao orquestrador (cursor de confirmadas-recentes)."""
        linha = self.db.execute("SELECT valor FROM cursor_financeiro WHERE id=1").fetchone()
        return linha[0] if linha else None

    def salvar_cursor_financeiro(self, valor: str) -> None:
        with self.trava:
            self.db.execute("INSERT INTO cursor_financeiro VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET valor=excluded.valor", (valor,))

    def cursor_nomeado(self, nome: str) -> Optional[str]:
        linha = self.db.execute("SELECT valor FROM cursores WHERE nome=?", (nome,)).fetchone()
        return linha[0] if linha else None

    def salvar_cursor_nomeado(self, nome: str, valor: str) -> None:
        with self.trava:
            self.db.execute("INSERT INTO cursores VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor", (nome, valor))


def enviar_pendentes(fila: Fila, url: str, token: str, parar: threading.Event, compose_dir: Path) -> None:
    while not parar.is_set():
        agora = time.time()
        item = fila.proximo(agora)
        if not item:
            parar.wait(2)
            continue
        item_id, payload, tentativas = item
        # Commit lido na hora do envio: depois de um git pull + deploy o coletor não é reiniciado.
        dados = json.loads(payload)
        corpo = json.dumps({**dados, "commit": commit_atual(compose_dir), "versao": 1}).encode()
        destino = re.sub(r"/incidentes$", "/execucoes", url) if dados.get("tipo") == "execucoes" else url
        req = urllib.request.Request(destino, data=corpo, method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
            fila.concluir(item_id)
        except urllib.error.HTTPError as erro:
            if 400 <= erro.code < 500 and erro.code not in (408, 429):
                logger.error("Orquestrador recusou o incidente (HTTP %s); descartado: %s", erro.code, erro.read()[:200])
                fila.concluir(item_id)
            else:
                fila.adiar(item_id, tentativas, agora)
        except (urllib.error.URLError, OSError) as erro:
            if tentativas == 0:
                logger.warning("Orquestrador fora do ar (%s); fica na fila", erro)
            fila.adiar(item_id, tentativas, agora)


def repassar_painel(url: str, gateway_url: str, token: str) -> bool:
    """Uma leitura do GET /painel do orquestrador repassada ao gateway. False se uma ponta falhou."""
    origem = re.sub(r"/incidentes$", "/painel", url)
    cabecalho = {"Authorization": f"Bearer {token}"}
    try:
        with urllib.request.urlopen(urllib.request.Request(origem, headers=cabecalho), timeout=15) as resp:
            corpo = resp.read(PAINEL_MAX + 1)
        if len(corpo) > PAINEL_MAX:
            logger.warning("Estado dos agentes maior que %s bytes; não repassado", PAINEL_MAX)
            return False
        req = urllib.request.Request(gateway_url, data=corpo, method="POST", headers={**cabecalho, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resposta = json.loads(resp.read() or b"{}")
        # O que o TI pediu na aba (ex.: marcar como resolvido) vai ao orquestrador; o gateway para de
        # mandar o comando quando o estado seguinte já mostra o incidente resolvido.
        destino = re.sub(r"/incidentes$", "/comandos", url)
        for comando in resposta.get("comandos") or []:
            dados = json.dumps(comando).encode()
            alvo = f"do reporte {comando['reporte'].get('id')}" if isinstance(comando.get("reporte"), dict) else f"do incidente {comando.get('incidente')}"
            req = urllib.request.Request(destino, data=dados, method="POST", headers={**cabecalho, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp.read()
                logger.info("Comando %s %s entregue ao orquestrador", comando.get("acao"), alvo)
            except urllib.error.HTTPError as erro:
                logger.warning("Orquestrador recusou o comando %s %s: HTTP %s", comando.get("acao"), alvo, erro.code)
        return True
    except urllib.error.HTTPError as erro:
        logger.warning("Repasse do estado dos agentes ao painel: HTTP %s em %s", erro.code, erro.url)
    except (urllib.error.URLError, OSError) as erro:
        logger.debug("Repasse do estado dos agentes ao painel falhou: %s", erro)
    return False


def repassar_painel_sempre(url: str, gateway_url: str, token: str, parar: threading.Event) -> None:
    while not parar.is_set():
        repassar_painel(url, gateway_url, token)
        parar.wait(PAINEL_INTERVALO)


def _json(url: str, cabecalho: Dict[str, str], corpo: Optional[dict] = None, timeout: int = 30) -> dict:
    dados = json.dumps(corpo).encode() if corpo is not None else None
    extra = {"Content-Type": "application/json"} if dados is not None else {}
    req = urllib.request.Request(url, data=dados, method="POST" if dados is not None else "GET", headers={**cabecalho, **extra})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def _aplicar_sugestao(fin_url: str, token: str, pronta: dict) -> Optional[dict]:
    """Grava uma classificação pronta na VPS. None: falha passageira, o orquestrador manda de novo."""
    corpo = {c: pronta.get(c) for c in ("chave", "staged_at", "modelo", "itens")}
    try:
        _json(f"{fin_url}/sugestoes", {"Authorization": f"Bearer {token}"}, corpo)
        return {"chave": pronta.get("chave"), "staged_at": pronta.get("staged_at"), "status": "aplicado", "http": 200}
    except urllib.error.HTTPError as erro:
        if erro.code in (404, 409, 422):
            # Nota saiu da revisão, foi estagiada de novo ou a sugestão não serve: não adianta repetir.
            logger.info("Sugestão do Qwen para a nota %s descartada pela automação (HTTP %s)", pronta.get("chave"), erro.code)
            return {"chave": pronta.get("chave"), "staged_at": pronta.get("staged_at"), "status": "descartado", "http": erro.code}
        logger.warning("Automação financeira recusou a sugestão da nota %s: HTTP %s", pronta.get("chave"), erro.code)
    except (urllib.error.URLError, OSError, ValueError) as erro:
        logger.debug("Sugestão da nota %s não aplicada: %s", pronta.get("chave"), erro)
    return None


def sincronizar_financeiro(
    fila: Fila, fin_url: str, url: str, token: str, resultados: List[dict]
) -> Tuple[List[dict], bool]:
    """
    Um ciclo da ponte do classificador. `resultados`: o que houve com as prontas do ciclo
    anterior (vão agora ao orquestrador). Devolve os resultados deste ciclo e se ainda há
    confirmadas por enviar. Qualquer ponta fora do ar só adia: nada trava a coleta de incidentes.
    """
    vps = {"Authorization": f"Bearer {token}"}
    cursor = fila.cursor_financeiro()
    try:
        pendentes = _json(f"{fin_url}/pendentes?limit={FINANCEIRO_PENDENTES}", vps)
        consulta = urlencode({"limit": FINANCEIRO_CONFIRMADAS, **({"cursor": cursor} if cursor else {})})
        pagina = _json(f"{fin_url}/confirmadas-recentes?{consulta}", vps)
    except urllib.error.HTTPError as erro:
        # 502/503: o gateway não alcançou a automação (reinício, deploy); só adia.
        nivel = logging.DEBUG if erro.code in (502, 503) else logging.WARNING
        logger.log(nivel, "Ponte do classificador: gateway respondeu HTTP %s em %s", erro.code, erro.url)
        return resultados, False
    except (urllib.error.URLError, OSError, ValueError) as erro:
        logger.debug("Ponte do classificador: automação financeira fora do ar (%s)", erro)
        return resultados, False

    corpo = {
        "categorias": pendentes.get("categorias") or [],
        "pendentes": pendentes.get("notas") or [],
        "confirmadas": pagina.get("confirmadas") or [],
        "resultados": resultados,
    }
    destino = re.sub(r"/incidentes$", "/financeiro/sincronizar", url)
    try:
        resposta = _json(destino, {"Authorization": f"Bearer {token}"}, corpo, timeout=60)
    except urllib.error.HTTPError as erro:
        logger.warning("Ponte do classificador: orquestrador respondeu HTTP %s", erro.code)
        return resultados, False
    except (urllib.error.URLError, OSError, ValueError) as erro:
        logger.debug("Ponte do classificador: orquestrador fora do ar (%s)", erro)
        return resultados, False

    # Só depois de o orquestrador gravar as confirmadas o cursor anda.
    if pagina.get("cursor") and pagina["cursor"] != cursor:
        fila.salvar_cursor_financeiro(pagina["cursor"])
    novos = [r for r in (_aplicar_sugestao(fin_url, token, p) for p in resposta.get("prontas") or []) if r]
    aplicados = sum(1 for r in novos if r["status"] == "aplicado")
    if aplicados:
        logger.info("Ponte do classificador: %s sugestão(ões) do Qwen aplicada(s) na revisão de NF-e", aplicados)
    return novos, bool(corpo["confirmadas"]) and not pagina.get("fim", True)


def _aplicar_sugestao_boleto(fin_url: str, token: str, pronta: dict) -> Optional[dict]:
    """Grava a classificação de um boleto DDA. None: falha passageira, o orquestrador manda de novo."""
    corpo = {c: pronta.get(c) for c in ("boleto_id", "versao", "modelo", "categoria_id", "confianca", "motivo")}
    base = {"boleto_id": pronta.get("boleto_id"), "versao": pronta.get("versao")}
    try:
        _json(f"{fin_url}/boletos/sugestoes", {"Authorization": f"Bearer {token}"}, corpo)
        return {**base, "status": "aplicado", "http": 200}
    except urllib.error.HTTPError as erro:
        if erro.code in (404, 409, 422):
            logger.info("Sugestão do Qwen para o boleto %s descartada pela automação (HTTP %s)", pronta.get("boleto_id"), erro.code)
            return {**base, "status": "descartado", "http": erro.code}
        logger.warning("Automação financeira recusou a sugestão do boleto %s: HTTP %s", pronta.get("boleto_id"), erro.code)
    except (urllib.error.URLError, OSError, ValueError) as erro:
        logger.debug("Sugestão do boleto %s não aplicada: %s", pronta.get("boleto_id"), erro)
    return None


def sincronizar_boletos(
    fila: Fila, fin_url: str, url: str, token: str, resultados: List[dict]
) -> Tuple[List[dict], bool]:
    """Um ciclo da ponte dos boletos DDA sem conta (mesmo desenho de sincronizar_financeiro)."""
    vps = {"Authorization": f"Bearer {token}"}
    cursor = fila.cursor_nomeado("boletos")
    try:
        pendentes = _json(f"{fin_url}/boletos/pendentes?limit={FINANCEIRO_PENDENTES}", vps)
        consulta = urlencode({"limit": FINANCEIRO_CONFIRMADAS, **({"cursor": cursor} if cursor else {})})
        pagina = _json(f"{fin_url}/boletos/confirmadas-recentes?{consulta}", vps)
    except urllib.error.HTTPError as erro:
        nivel = logging.DEBUG if erro.code in (502, 503) else logging.WARNING
        logger.log(nivel, "Ponte dos boletos: gateway respondeu HTTP %s em %s", erro.code, erro.url)
        return resultados, False
    except (urllib.error.URLError, OSError, ValueError) as erro:
        logger.debug("Ponte dos boletos: automação financeira fora do ar (%s)", erro)
        return resultados, False

    corpo = {
        "categorias": pendentes.get("categorias") or {},
        "pendentes": pendentes.get("boletos") or [],
        "confirmadas": pagina.get("confirmadas") or [],
        "resultados": resultados,
    }
    destino = re.sub(r"/incidentes$", "/financeiro/boletos/sincronizar", url)
    try:
        resposta = _json(destino, vps, corpo, timeout=60)
    except urllib.error.HTTPError as erro:
        logger.warning("Ponte dos boletos: orquestrador respondeu HTTP %s", erro.code)
        return resultados, False
    except (urllib.error.URLError, OSError, ValueError) as erro:
        logger.debug("Ponte dos boletos: orquestrador fora do ar (%s)", erro)
        return resultados, False

    if pagina.get("cursor") and pagina["cursor"] != cursor:
        fila.salvar_cursor_nomeado("boletos", pagina["cursor"])
    novos = [r for r in (_aplicar_sugestao_boleto(fin_url, token, p) for p in resposta.get("prontas") or []) if r]
    aplicados = sum(1 for r in novos if r["status"] == "aplicado")
    if aplicados:
        logger.info("Ponte dos boletos: %s sugestão(ões) do Qwen aplicada(s) nos boletos DDA", aplicados)
    return novos, bool(corpo["confirmadas"]) and not pagina.get("fim", True)


def sincronizar_financeiro_sempre(fila: Fila, fin_url: str, url: str, token: str, parar: threading.Event) -> None:
    resultados: List[dict] = []
    resultados_boletos: List[dict] = []
    while not parar.is_set():
        mais = mais_boletos = False
        try:
            resultados, mais = sincronizar_financeiro(fila, fin_url, url, token, resultados)
        except Exception:  # noqa: BLE001 — a ponte nunca derruba o coletor
            logger.exception("Falha na ponte do classificador")
        try:
            resultados_boletos, mais_boletos = sincronizar_boletos(fila, fin_url, url, token, resultados_boletos)
        except Exception:  # noqa: BLE001
            logger.exception("Falha na ponte dos boletos")
        parar.wait(FINANCEIRO_PAGINA_SEGUINTE if mais or mais_boletos else FINANCEIRO_INTERVALO)


def commit_atual(compose_dir: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(compose_dir), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=5).stdout.strip()
    except OSError:
        return ""


def processar(registros: Iterable[Registro], fila: Optional[Fila], saida=None) -> None:
    for reg in registros:
        contagem = execucoes(reg)
        if contagem:
            if fila is None:
                print(json.dumps(contagem, ensure_ascii=False), file=saida or sys.stdout)
            else:
                fila.enfileirar(contagem)
            continue
        inc = classificar(reg)
        if not inc:
            continue
        if fila is None:
            print(json.dumps(inc, ensure_ascii=False), file=saida or sys.stdout)
        elif fila.registrar(inc, time.time()):
            logger.info("Incidente %s (%s · %s) enfileirado", inc["assinatura"], inc["servico"], inc["evento"])


def servicos_existentes(compose_dir: Path, servicos: List[str]) -> List[str]:
    """Só os serviços que o compose conhece: um nome inexistente faz o docker compose logs recusar todos."""
    try:
        saida = subprocess.run(["docker", "compose", "config", "--services"], cwd=str(compose_dir), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return servicos
    if saida.returncode != 0:
        return servicos
    conhecidos = set(saida.stdout.split())
    faltando = [s for s in servicos if s not in conhecidos]
    if faltando:
        logger.warning("Fora do compose, ignorados: %s", ", ".join(faltando))
    return [s for s in servicos if s in conhecidos]


def _ler_linhas(saida, linhas: "queue.Queue[str]") -> None:
    """Passa cada linha do docker compose logs para a fila; "" no fim da saída."""
    for bruta in saida:
        linhas.put(bruta)
    linhas.put("")


def seguir_logs(fila: Fila, compose_dir: Path, servicos: List[str], parar: threading.Event) -> None:
    """Segue os logs para sempre; se o docker compose sair (container recriado), retoma do cursor."""
    while not parar.is_set():
        cmd = ["docker", "compose", "logs", "-f", "-t", "--no-color"]
        cursor = fila.cursor()
        cmd += ["--since", cursor] if cursor else ["--tail", "0"]
        proc = subprocess.Popen(cmd + servicos, cwd=str(compose_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        agrupador = Agrupador()
        ultimas = collections.deque(maxlen=5)  # mostradas se o docker compose sair com erro
        assert proc.stdout is not None
        # Leitura numa thread: select() no fd não enxerga as linhas já no buffer do readline(), e o
        # registro fechava pelo FIM_DE_REGISTRO com o traceback ainda no buffer (incidente partido).
        linhas: "queue.Queue[str]" = queue.Queue()
        threading.Thread(target=_ler_linhas, args=(proc.stdout, linhas), daemon=True).start()
        while not parar.is_set():
            try:
                bruta = linhas.get(timeout=0.5)
            except queue.Empty:
                bruta = None
            if bruta is not None:
                if not bruta:
                    break
                ultimas.append(bruta.strip())
                processar(agrupador.linha(bruta), fila)
                m = _LINHA_COMPOSE.match(bruta)
                if m and m.group("ts"):
                    fila.salvar_cursor(m.group("ts"))
            elif agrupador.abertos and time.monotonic() - agrupador.ultima_linha > FIM_DE_REGISTRO:
                processar(agrupador.fechar(), fila)
        processar(agrupador.fechar(), fila)
        proc.terminate()
        if not parar.is_set():
            codigo = proc.wait()
            detalhe = f": {' | '.join(ultimas)}" if codigo and ultimas else ""
            logger.warning("docker compose logs terminou (código %s)%s; retomando em 10 s", codigo, detalhe)
            parar.wait(10)


def carregar_env(caminho: Optional[str]) -> None:
    if not caminho:
        return
    for linha in Path(caminho).read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if linha and not linha.startswith("#") and "=" in linha:
            chave, valor = linha.split("=", 1)
            os.environ.setdefault(chave.strip(), valor.strip().strip("'\""))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--env-file", help="arquivo .env com INCIDENTES_TOKEN e afins")
    parser.add_argument("--testar", action="store_true", help="lê linhas do docker compose logs -t no stdin e imprime os incidentes, sem enviar")
    args = parser.parse_args(argv)

    if args.testar:
        agrupador = Agrupador()
        for bruta in sys.stdin:
            processar(agrupador.linha(bruta), None)
        processar(agrupador.fechar(), None)
        return 0

    if args.env_file and not Path(args.env_file).is_file():
        logger.error("Arquivo %s não existe: copie coletor.env.example e preencha INCIDENTES_TOKEN", args.env_file)
        return 1
    carregar_env(args.env_file)
    token = os.environ.get("INCIDENTES_TOKEN", "")
    if len(token) < TAMANHO_MINIMO_TOKEN:
        logger.error("INCIDENTES_TOKEN ausente ou com menos de %s caracteres", TAMANHO_MINIMO_TOKEN)
        return 1
    os.environ.setdefault("DOCKER_HOST", f"unix:///run/user/{os.getuid()}/docker.sock")
    url = os.environ.get("INCIDENTES_URL", "http://127.0.0.1:8790/incidentes")
    compose_dir = Path(os.environ.get("COMPOSE_DIR", str(REPO_DIR)))
    servicos = os.environ.get("SERVICOS", SERVICOS_PADRAO).split()
    estado = Path(os.environ.get("ESTADO_DIR", str(Path.home() / ".local/state/coletor-incidentes")))
    fila = Fila(estado / "coletor.db")

    parar = threading.Event()
    envio = threading.Thread(target=enviar_pendentes, args=(fila, url, token, parar, compose_dir), daemon=True)
    envio.start()
    gateway_url = os.environ.get("GATEWAY_ESTADO_URL", "http://127.0.0.1:3100/api/agentes-qwen/estado").strip()
    if gateway_url:
        threading.Thread(target=repassar_painel_sempre, args=(url, gateway_url, token, parar), daemon=True).start()
    fin_url = os.environ.get("GATEWAY_FINANCEIRO_URL", "http://127.0.0.1:3100/api/agentes-qwen/financeiro").strip().rstrip("/")
    if fin_url:
        threading.Thread(target=sincronizar_financeiro_sempre, args=(fila, fin_url, url, token, parar), daemon=True).start()
        logger.info("Ponte do classificador Qwen da revisão de NF-e ligada (%s)", fin_url)
    servicos = servicos_existentes(compose_dir, servicos)
    if not servicos:
        logger.error("Nenhum dos serviços de SERVICOS existe no compose de %s", compose_dir)
        return 1
    logger.info("Seguindo %s em %s; envio para %s", ", ".join(servicos), compose_dir, url)
    try:
        seguir_logs(fila, compose_dir, servicos, parar)
    except KeyboardInterrupt:
        pass
    finally:
        parar.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
