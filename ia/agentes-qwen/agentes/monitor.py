"""Monitor depois do PR (fase 3): merge → deploy → as próximas execuções confirmam a correção.

  pr_aberto ── rótulo 'aprovado' do TI + CI verde: o monitor faz o merge
  pr_aberto ── comentário '/refazer <pedido>' do TI: fecha o PR e refaz na volta seguinte seguindo o
               pedido (que também entra na RAG da resolução e da qualidade e marca a volta como errada no treino)
  pr_aberto ── gh: merged ──► aguardando_deploy ── commit da produção contém o merge ──► monitorando
            └─ gh: closed ──► pr_fechado
  monitorando ── as 5 próximas execuções da rota ok (contagem do gateway e das automações Python) ──► resolvido
                 (rotina agendada 1×/dia = 5 dias; "ok" = sem exceção e sem log ERROR)
              └─ alguma das 5 falhou ──► escalado (a correção não segurou: o TI corrige)
              └─ erro sem rota: janela sem recorrência (5× o intervalo entre as ocorrências)
  Recorrência da mesma assinatura em monitorando reabre o incidente na volta seguinte (banco.receber).

Roda no mesmo trabalhador da cadeia, entre um incidente e outro: nada em paralelo com os agentes.
"""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import datetime, timedelta, timezone

from . import config, rag
from .banco import Banco, agora

logger = logging.getLogger("agentes.monitor")

EXECUCOES_OK = 5
JANELA_MIN, JANELA_MAX, JANELA_UNICA = timedelta(hours=1), timedelta(days=7), timedelta(hours=24)
SEM_TRAFEGO_MAX = timedelta(days=14)


def _dt(texto: str) -> datetime:
    return datetime.fromisoformat(texto[:19]).replace(tzinfo=timezone.utc)


def janela_sem_rota(inc) -> timedelta:
    """5× o intervalo médio entre as ocorrências antes da correção (1 h a 7 dias; 1 ocorrência: 24 h)."""
    if inc["ocorrencias"] < 2 or not inc["primeiro_em"] or not inc["ultimo_em"]:
        return JANELA_UNICA
    intervalo = (_dt(inc["ultimo_em"]) - _dt(inc["primeiro_em"])) / (inc["ocorrencias"] - 1)
    return min(JANELA_MAX, max(JANELA_MIN, 5 * intervalo))


def _gh(*args: str) -> str:
    r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-300:])
    return r.stdout


def estado_do_pr(url: str) -> tuple[str, str]:
    """(OPEN|MERGED|CLOSED, sha do merge)."""
    dados = json.loads(_gh("pr", "view", url, "--json", "state,mergeCommit"))
    return dados["state"], (dados.get("mergeCommit") or {}).get("oid", "")


def aprovacao(url: str) -> tuple[str, str]:
    """Rótulo de aprovação + CI do PR aberto: ('sem_rotulo'|'aguardando_ci'|'ci_falhou'|'aprovado', quem).

    Vale só o rótulo posto por alguém de PR_APROVADORES (o último 'labeled' dele, sem 'unlabeled' depois).
    """
    dados = json.loads(_gh("pr", "view", url, "--json", "number,labels,statusCheckRollup"))
    if config.PR_ROTULO_APROVADO not in {r["name"] for r in dados["labels"]}:
        return "sem_rotulo", ""
    eventos = json.loads(_gh("api", f"repos/{config.REPO_GITHUB}/issues/{dados['number']}/events?per_page=100"))
    quem = ""
    for ev in eventos:
        if (ev.get("label") or {}).get("name") != config.PR_ROTULO_APROVADO:
            continue
        if ev["event"] == "labeled":
            quem = (ev.get("actor") or {}).get("login", "")
        elif ev["event"] == "unlabeled":
            quem = ""
    if quem.lower() not in config.PR_APROVADORES:
        return "sem_rotulo", quem
    checks = dados.get("statusCheckRollup") or []
    conclusoes = [(c.get("conclusion") or c.get("state") or "").upper() for c in checks]
    if any(c in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED") for c in conclusoes):
        return "ci_falhou", quem
    if any(c not in ("SUCCESS", "SKIPPED", "NEUTRAL") for c in conclusoes):
        return "aguardando_ci", quem
    return "aprovado", quem


COMANDO_REFAZER = "/refazer"


def pedido_de_ajuste(url: str) -> tuple[str, str]:
    """Último comentário '/refazer <pedido>' de alguém de PR_APROVADORES no PR: (pedido, quem) ou ("", "")."""
    dados = json.loads(_gh("pr", "view", url, "--json", "comments"))
    for c in reversed(dados.get("comments") or []):
        corpo = (c.get("body") or "").strip()
        quem = (c.get("author") or {}).get("login", "")
        if corpo.lower().startswith(COMANDO_REFAZER) and quem.lower() in config.PR_APROVADORES:
            pedido = corpo[len(COMANDO_REFAZER):].strip()
            if pedido:
                return pedido, quem
    return "", ""


def texto_licao(banco: Banco, inc, pedido: str) -> str:
    """Como o pedido do TI entra na RAG: o erro, a correção recusada e o que faltou."""
    res = next((json.loads(e["saida"]) for e in reversed(banco.etapas(inc["id"], inc["volta"])) if e["agente"] == "resolucao"), {})
    return (
        f"Lição do TI (correção recusada no incidente #{inc['id']}, {inc['servico']} · {inc['evento']})\n"
        f"Mensagem: {inc['mensagem']}\nCorreção recusada: {res.get('resumo', '-')}\nO que o TI pediu: {pedido}"
    )


def refazer(banco: Banco, inc, pedido: str, quem: str) -> None:
    """Fecha o PR e devolve o incidente à fila na volta seguinte, com o pedido do TI para os agentes."""
    nova = inc["volta"] + 1
    _gh("pr", "close", inc["pr_url"], "--delete-branch", "--comment", f"Os agentes vão refazer a correção na volta {nova} seguindo o pedido de {quem}.")
    banco.gravar_desfecho(inc["id"], inc["volta"], "ti_pediu_ajuste", detalhe=pedido[:2000])
    licao = texto_licao(banco, inc, pedido)
    banco.mudar_estado(inc["id"], "novo", volta=nova, volta_base=inc["volta"], pedido_ti=pedido, pr_url=None, branch=None)
    for agente in ("resolucao", "qualidade"):
        try:
            rag.adicionar(agente, f"lições do TI › #{inc['id']} volta {inc['volta']}", licao)
        except Exception:  # noqa: BLE001 — a RAG atrasada não impede a nova volta
            logger.exception("Incidente %s: lição do TI não entrou na RAG de %s", inc["id"], agente)
    logger.info("Incidente %s: %s pediu ajuste no PR; refazendo na volta %s", inc["id"], quem, nova)


def fazer_merge(url: str) -> None:
    _gh("pr", "merge", url, "--squash", "--admin", "--delete-branch")


def em_producao(merge_sha: str, commit_prod: str) -> bool:
    """O commit da produção contém o merge? (clone dos agentes, depois de um fetch)."""
    repo_dir = str(config.REPO_AGENTE)
    if not (config.REPO_AGENTE / ".git").is_dir():
        config.REPO_AGENTE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "-q", config.REPO_REMOTO, repo_dir], capture_output=True, timeout=600)
    subprocess.run(["git", "-C", repo_dir, "fetch", "-q", "origin", "main"], capture_output=True, timeout=120)
    r = subprocess.run(["git", "-C", repo_dir, "merge-base", "--is-ancestor", merge_sha, commit_prod], capture_output=True, timeout=30)
    return r.returncode == 0


def _resolver(banco: Banco, inc, detalhe: str) -> None:
    res = next((json.loads(e["saida"]) for e in reversed(banco.etapas(inc["id"])) if e["agente"] == "resolucao"), {})
    nota = f"Confirmado pelo monitor: {detalhe}. Correção: {res.get('resumo', '-')} ({inc['pr_url'] or inc['branch'] or 'sem PR'})"
    banco.gravar_desfecho(inc["id"], inc["volta"], "confirmado_em_producao", detalhe=detalhe)
    banco.mudar_estado(inc["id"], "resolvido", nota_ti=nota)
    try:
        rag.adicionar("resolucao", f"incidentes › #{inc['id']} {inc['servico']}", rag.texto_resolvido(banco, banco.incidente(inc["id"])))
    except Exception:  # noqa: BLE001 — a RAG atrasada não desfaz a confirmação
        logger.exception("Incidente %s: não entrou na RAG da resolução", inc["id"])


def verificar(banco: Banco, agora_dt: datetime | None = None) -> list[int]:
    """Uma passada do monitor. Devolve os incidentes que mudaram para um estado que merece aviso."""
    agora_dt = agora_dt or datetime.now(timezone.utc)
    avisar = []

    for inc in banco.por_estado("pr_aberto"):
        try:
            estado, sha = estado_do_pr(inc["pr_url"])
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as erro:
            logger.warning("Incidente %s: não consegui ler o PR (%s)", inc["id"], erro)
            continue
        if estado == "OPEN":
            try:
                pedido, quem = pedido_de_ajuste(inc["pr_url"])
                if pedido:
                    refazer(banco, inc, pedido, quem)
                    continue
                situacao, quem = aprovacao(inc["pr_url"])
                if situacao == "aprovado":
                    fazer_merge(inc["pr_url"])
                    banco.gravar_desfecho(inc["id"], inc["volta"], "ti_aprovou", detalhe=quem)
                    logger.info("Incidente %s: aprovado por %s; merge feito", inc["id"], quem)
                    estado, sha = estado_do_pr(inc["pr_url"])
                elif situacao == "ci_falhou":
                    logger.warning("Incidente %s: rótulo de aprovação, mas o CI do PR falhou; sem merge", inc["id"])
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as erro:
                logger.warning("Incidente %s: aprovação/merge do PR falhou (%s)", inc["id"], erro)
                continue
        if estado == "MERGED" and sha:
            banco.gravar_desfecho(inc["id"], inc["volta"], "pr_mergeado", detalhe=sha)
            banco.mudar_estado(inc["id"], "aguardando_deploy", merge_sha=sha)
            logger.info("Incidente %s: PR mergeado (%s); aguardando o deploy", inc["id"], sha[:7])
            avisar.append(inc["id"])  # o aviso leva ao relatório com os comandos de deploy
        elif estado == "CLOSED":
            banco.gravar_desfecho(inc["id"], inc["volta"], "pr_fechado", detalhe=inc["pr_url"] or "")
            banco.mudar_estado(inc["id"], "pr_fechado")
            avisar.append(inc["id"])

    prod = banco.producao()
    if prod and prod["commit_prod"]:
        for inc in banco.por_estado("aguardando_deploy"):
            if em_producao(inc["merge_sha"], prod["commit_prod"]):
                deploy_em = prod["desde"] or agora()
                ate = None if inc["rota"] else (_dt(deploy_em) + janela_sem_rota(inc)).isoformat(timespec="seconds")
                banco.mudar_estado(inc["id"], "monitorando", deploy_em=deploy_em, monitor_ate=ate)
                logger.info("Incidente %s: correção em produção (%s); monitorando", inc["id"], prod["commit_prod"])
                avisar.append(inc["id"])

    for inc in banco.por_estado("monitorando"):
        if inc["rota"]:
            acompanhadas, ok = banco.acompanhamento(inc["rota"], inc["deploy_em"], inc["servico"], EXECUCOES_OK)
            if acompanhadas >= EXECUCOES_OK and ok == acompanhadas:
                _resolver(banco, inc, f"{ok} execuções ok de {inc['rota']} depois do deploy, sem o erro voltar")
                avisar.append(inc["id"])
            elif acompanhadas >= EXECUCOES_OK:
                # Falha na rota com outra assinatura (a mesma reabre o incidente em banco.receber):
                # a correção está em produção e não segurou; vai para o TI em vez de uma nova volta.
                detalhe = f"{acompanhadas}/{EXECUCOES_OK} execuções acompanhadas com {ok}/{EXECUCOES_OK} sucessos em {inc['rota']}"
                banco.gravar_desfecho(inc["id"], inc["volta"], "falhou_no_acompanhamento", detalhe=detalhe)
                banco.mudar_estado(inc["id"], "escalado", nota_ti=f"a correção está em produção, mas {detalhe}: precisa de correção manual")
                logger.info("Incidente %s: %s; escalado", inc["id"], detalhe)
                avisar.append(inc["id"])
            elif agora_dt - _dt(inc["deploy_em"]) > SEM_TRAFEGO_MAX:
                _resolver(banco, inc, f"só {ok} execução(ões) de {inc['rota']} em {SEM_TRAFEGO_MAX.days} dias, sem o erro voltar")
                avisar.append(inc["id"])
        elif inc["monitor_ate"] and agora_dt >= _dt(inc["monitor_ate"]):
            _resolver(banco, inc, f"sem o erro voltar de {inc['deploy_em'][:16]} até {inc['monitor_ate'][:16]} (UTC)")
            avisar.append(inc["id"])
    return avisar
