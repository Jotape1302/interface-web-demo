"""Receptor HTTP dos incidentes do coletor da VPS (scripts/coletor-incidentes no interface-web).

Escuta só em 127.0.0.1: a VPS chega aqui pela ponta do túnel SSH reverso aberto pelo PC.
POST /incidentes, POST /execucoes (contagem por rota, para o monitor) e GET /painel (estado para a
aba "Agentes Qwen" do painel, que o coletor repassa ao gateway) exigem
`Authorization: Bearer <INCIDENTES_TOKEN>`. POST /comandos traz o que o TI pediu na aba (hoje só
{"acao": "resolver", "incidente", "nota", "por"}), repassado pelo coletor. POST /financeiro/sincronizar
é a ponte do classificador de NF-e (financeiro_fila.py), com limite de corpo próprio; POST
/financeiro/boletos/sincronizar, a dos boletos DDA sem conta (boletos_fila.py).
GET /saude responde sem token.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from . import boletos_fila, config, financeiro_fila, painel
from .banco import Banco

logger = logging.getLogger("agentes.receptor")
OBRIGATORIOS = ("assinatura", "servico", "mensagem")


def criar_servidor(
    banco: Banco, chegou: threading.Event, token: str, porta: int = config.PORTA, nota_chegou: Optional[threading.Event] = None
) -> ThreadingHTTPServer:
    """`nota_chegou` acorda a linha do classificador de NF-e (sem ela, acorda o trabalhador dos incidentes)."""
    class Receptor(BaseHTTPRequestHandler):
        server_version = "agentes-qwen"

        def _responder(self, status: int, corpo: dict) -> None:
            dados = json.dumps(corpo).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(dados)))
            self.end_headers()
            self.wfile.write(dados)

        def _autorizado(self) -> bool:
            recebido = self.headers.get("Authorization", "")
            if hmac.compare_digest(recebido.encode(), f"Bearer {token}".encode()):
                return True
            self._responder(401, {"erro": "token inválido"})
            return False

        def do_GET(self) -> None:
            if self.path == "/saude":
                self._responder(200, {"ok": True})
            elif self.path == "/painel":
                if self._autorizado():
                    with banco.trava:
                        dados = painel.estado(banco)
                    self._responder(200, dados)
            else:
                self._responder(404, {"erro": "não encontrado"})

        def do_POST(self) -> None:
            if self.path not in ("/incidentes", "/execucoes", "/comandos", "/financeiro/sincronizar", "/financeiro/boletos/sincronizar"):
                return self._responder(404, {"erro": "não encontrado"})
            if not self._autorizado():
                return None
            tamanho = int(self.headers.get("Content-Length") or 0)
            limite = config.CORPO_MAX_FINANCEIRO if self.path.startswith("/financeiro/") else config.CORPO_MAX
            if not 0 < tamanho <= limite:
                return self._responder(413, {"erro": "corpo vazio ou grande demais"})
            try:
                inc = json.loads(self.rfile.read(tamanho))
            except ValueError:
                return self._responder(400, {"erro": "JSON inválido"})
            if self.path == "/financeiro/sincronizar":
                erro = financeiro_fila.validar(inc)
                if erro:
                    return self._responder(400, {"erro": erro})
                resposta = financeiro_fila.sincronizar(banco, inc)
                if resposta["pendentes_novas"]:
                    logger.info("Financeiro: %s nota(s) nova(s) para classificar", resposta["pendentes_novas"])
                    (nota_chegou or chegou).set()
                return self._responder(200, resposta)
            if self.path == "/financeiro/boletos/sincronizar":
                erro = boletos_fila.validar(inc)
                if erro:
                    return self._responder(400, {"erro": erro})
                resposta = boletos_fila.sincronizar(banco, inc)
                if resposta["pendentes_novas"]:
                    logger.info("Boletos DDA: %s boleto(s) novo(s) para classificar", resposta["pendentes_novas"])
                    (nota_chegou or chegou).set()
                return self._responder(200, resposta)
            if self.path == "/comandos" and isinstance(inc, dict) and inc.get("acao") == "reportar":
                rep = inc.get("reporte")
                if not isinstance(rep, dict) or not isinstance(rep.get("id"), int) or any(
                    not isinstance(rep.get(c), str) or not rep[c].strip() for c in ("servico", "mensagem")
                ):
                    return self._responder(400, {"erro": "reporte inválido (id, servico, mensagem)"})
                inc_id, rodar = banco.receber_reporte(rep)
                logger.info("Reporte %s do painel (%s · %s) → incidente %s%s", rep["id"], rep["servico"], rep.get("automacao"), inc_id, "" if rodar else " (já existia)")
                if rodar:
                    chegou.set()
                return self._responder(200, {"ok": True, "incidente": inc_id, "novo": rodar})
            if self.path == "/comandos":
                if not isinstance(inc, dict) or inc.get("acao") != "resolver" or not isinstance(inc.get("incidente"), int):
                    return self._responder(400, {"erro": "comando inválido (acao=resolver ou reportar)"})
                por = str(inc.get("por") or "TI")[:100]
                nota = str(inc.get("nota") or "").strip()[:2000] or "sem nada pendente"
                ok = painel.resolver_pelo_ti(banco, inc["incidente"], f"Resolvido pelo painel por {por}: {nota}", em_segundo_plano=True)
                logger.info("Incidente %s marcado como resolvido pelo painel (%s)", inc["incidente"], por)
                return self._responder(200 if ok else 404, {"ok": ok})
            if self.path == "/execucoes":
                if not isinstance(inc, dict) or not isinstance(inc.get("rotas"), dict):
                    return self._responder(400, {"erro": "campo obrigatório: rotas"})
                return self._responder(202, {"rotas": banco.receber_execucoes(inc)})
            if not isinstance(inc, dict) or any(not isinstance(inc.get(c), str) or not inc[c] for c in OBRIGATORIOS):
                return self._responder(400, {"erro": f"campos obrigatórios: {', '.join(OBRIGATORIOS)}"})
            inc_id, novo = banco.receber(inc)
            logger.info("Incidente %s %s (%s · %s)", inc_id, "novo" if novo else "repetiu", inc["servico"], inc.get("evento"))
            chegou.set()
            self._responder(202, {"id": inc_id, "novo": novo})

        def log_message(self, formato: str, *args) -> None:
            logger.debug(formato, *args)

    return ThreadingHTTPServer((config.HOST, porta), Receptor)
