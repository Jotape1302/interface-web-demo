"""Trabalhador único: pega um incidente por vez, em ordem de chegada, e passa pela cadeia de
agentes. Um agente só começa quando a saída do anterior está gravada; se o Ollama cair no meio,
o incidente fica em_andamento e a retomada pula as etapas já gravadas na volta.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import threading
import time
from typing import Optional

from . import config, llm, monitor, rag, repo
from .agentes import CADEIA, EXECUTOR, QUALIDADE
from .banco import Banco

logger = logging.getLogger("agentes.pipeline")


def _rodar(banco: Banco, inc_id: int, volta: int, agente, inc, anteriores: dict, modelo: str) -> dict:
    logger.info("Incidente %s volta %s: agente %s começou", inc_id, volta, agente.nome)
    inicio = time.monotonic()
    with llm.registrando(lambda **c: banco.gravar_chamada(inc_id, volta, agente.nome, **c)):
        saida, fontes = agente.rodar(inc, anteriores)
    banco.gravar_etapa(inc_id, volta, agente.nome, modelo, fontes, saida, round(time.monotonic() - inicio, 1))
    logger.info("Incidente %s: agente %s terminou em %.0f s", inc_id, agente.nome, time.monotonic() - inicio)
    return saida


def _nova_volta(banco: Banco, inc_id: int, volta: int, motivo: str) -> str:
    logger.info("Incidente %s: volta %s reprovada (%s); começa a volta %s", inc_id, volta, motivo[:200], volta + 1)
    banco.gravar_desfecho(inc_id, volta, "volta_reprovada", detalhe=motivo[:1000])
    banco.mudar_estado(inc_id, "novo", volta=volta + 1)
    return "nova_volta"


def _corpo_pr(banco: Banco, inc_id: int) -> str:
    cabecalho = (
        f"Correção proposta pelos agentes Qwen para o incidente #{inc_id} de produção. **Revise antes de aprovar.**\n\n"
        f"Para aprovar, adicione o rótulo `{config.PR_ROTULO_APROVADO}`: os agentes fazem o merge (squash) quando o CI passar. "
        f"Para pedir ajuste, comente `{monitor.COMANDO_REFAZER} <o que está errado e como deve ficar>`: os agentes fecham este PR e "
        "refazem seguindo o pedido, que também vira lição para os próximos incidentes. Para recusar de vez, feche o PR. "
        "O deploy continua sendo manual.\n\n"
    )
    rodape = "\n\n🤖 Gerado por norvia-ti/agentes-qwen"
    texto = relatorio(banco, inc_id, so_volta=banco.incidente(inc_id)["volta"])
    if len(cabecalho) + len(texto) + len(rodape) > CORPO_PR_MAX:
        texto = texto[: CORPO_PR_MAX - len(cabecalho) - len(rodape) - 80] + "\n\n_(relatório cortado: o completo está no PC)_"
    return cabecalho + texto + rodape


PEDE_TESTE = re.compile(r"\btest", re.I)


def pede_teste(anteriores: dict) -> bool:
    """O pedido do TI exige teste: conferido no diff, não na palavra da qualidade."""
    return bool(PEDE_TESTE.search(anteriores.get("pedido_ti") or ""))


def arquivos_editaveis(res: dict, inc=None) -> list[str]:
    """Arquivos-fonte que a resolução manda mudar, existem no repo e o executor pode editar.

    É a trava do executor. Os rótulos do LLM (tipo, automatizavel, precisa_de_humano) não servem
    para isso: no teste do bug do batch com timeout (2026-10-30), o Qwen 14B classificou como
    "infraestrutura" porque o erro cita o MariaDB, mesmo apontando o arquivo .ts certo nos passos.
    """
    candidatos = list(res.get("arquivos_afetados", [])) + [p.get("arquivo") or "" for p in res.get("passos", [])]
    # Passo sem o campo arquivo, mas com o caminho no texto (#16, volta 10); por último, onde o erro nasce.
    candidatos += re.findall(r"(?:backend|frontend)/[\w./-]+\.\w+", " ".join(p.get("detalhe") or "" for p in res.get("passos", [])))
    if inc is not None:
        trecho = rag.trecho_do_incidente(inc)
        if trecho:
            candidatos.append(trecho.split(" (linha", 1)[0])
    vistos = []
    for a in candidatos:
        a = a.strip().strip("`").lstrip("./")
        if a and a not in vistos and repo.caminho_permitido(a) and (config.REPO_INTERFACE / a).is_file():
            vistos.append(a)
    return vistos


def diff_do_pr_recusado(banco: Banco, inc_id: int) -> str:
    """Diff (contra a main) do último PR em que o TI comentou /refazer; vazio se não houver."""
    voltas = [d["volta"] for d in banco.desfechos(inc_id) if d["evento"] == "ti_pediu_ajuste"]
    if not voltas:
        return ""
    executor = [json.loads(e["saida"]) for e in banco.etapas(inc_id, voltas[-1]) if e["agente"] == "executor"]
    return (executor[-1].get("diff") if executor else "") or ""


def processar(banco: Banco, inc_id: int) -> str:
    """Roda a volta atual do incidente até um estado final ou até reprovar (nova volta).

    Devolve o estado final, 'nova_volta' ou 'em_andamento' (Ollama caiu; tenta de novo depois).
    """
    inc = banco.incidente(inc_id)
    volta = inc["volta"]
    if volta - (inc["volta_base"] or 0) > config.MAX_VOLTAS:
        banco.gravar_desfecho(inc_id, volta - 1, "escalado", detalhe=f"passou de {config.MAX_VOLTAS} voltas")
        banco.mudar_estado(inc_id, "escalado", nota_ti=f"passou de {config.MAX_VOLTAS} voltas sem a qualidade aprovar")
        return "escalado"
    banco.mudar_estado(inc_id, "em_andamento")
    feitas = {e["agente"]: json.loads(e["saida"]) for e in banco.etapas(inc_id, volta)}
    anteriores: dict = dict(feitas)
    if volta > 1:
        anteriores["volta_anterior"] = {e["agente"]: json.loads(e["saida"]) for e in banco.etapas(inc_id, volta - 1)}
    if inc["pedido_ti"]:
        anteriores["pedido_ti"] = inc["pedido_ti"]
        anteriores["diff_recusado"] = diff_do_pr_recusado(banco, inc_id)

    branch = f"agente/inc-{inc_id}-v{volta}"
    try:
        # O /refazer é revisão do PR: a volta parte da main COM o diff recusado, e o pedido ajusta em cima
        # dele (#16, volta 13: na main pura o executor procurou o bloco do 656 e mexeu no genérico).
        if repo.preparar(branch, anteriores.get("diff_recusado", "")):
            anteriores["base_recusada"] = True
        for agente in CADEIA:
            if agente.nome not in feitas:
                anteriores[agente.nome] = _rodar(banco, inc_id, volta, agente, inc, anteriores, config.MODELO)

        res = anteriores.get("resolucao", {})
        editaveis = arquivos_editaveis(res, inc)
        if not editaveis:
            banco.gravar_desfecho(inc_id, volta, "sem_arquivo_editavel", "resolucao", json.dumps(res.get("arquivos_afetados", []), ensure_ascii=False))
            motivo = res.get("resumo") or anteriores.get("diagnostico", {}).get("resumo") or "sem resumo"
            banco.mudar_estado(inc_id, "aguardando_ti", nota_ti=f"a correção não é de código automatizável: {motivo}")
            return "aguardando_ti"

        # O executor recebe os arquivos já conferidos, inclusive os achados fora do campo 'arquivo'.
        anteriores["resolucao"] = {**res, "arquivos_afetados": editaveis}
        if "executor" not in feitas:
            try:
                anteriores["executor"] = _rodar(banco, inc_id, volta, EXECUTOR, inc, anteriores, config.MODELO_EXECUTOR)
            except repo.ErroEdicao as erro:
                banco.gravar_etapa(inc_id, volta, "executor", config.MODELO_EXECUTOR, [], {"falhou": str(erro)}, 0)
                banco.gravar_desfecho(inc_id, volta, "edicao_nao_aplicou", "executor", str(erro)[:1000])
                return _nova_volta(banco, inc_id, volta, f"executor não conseguiu aplicar: {erro}")
        elif anteriores["executor"].get("falhou"):
            return _nova_volta(banco, inc_id, volta, anteriores["executor"]["falhou"])

        arquivos = sorted({e["arquivo"].strip().lstrip("./") for e in anteriores["executor"]["edicoes"]})
        # Clone de volta à main pura: dependências baixadas COM rede sem nenhuma edição do agente;
        # só então o diff volta e os testes rodam na sandbox sem rede.
        repo.preparar(branch)
        erros_dep = repo.aquecer(repo.suites(arquivos)) if "qualidade" not in feitas else []
        repo.aplicar_diff(anteriores["executor"]["diff"])
        if "qualidade" not in feitas:
            anteriores["arquivos"] = arquivos
            anteriores["arquivos_teste"] = [a for a in arquivos if repo.eh_teste(a)]
            anteriores["testes"] = repo.testar(arquivos) + [{"comando": "preparar dependências", "ok": False, "saida": e} for e in erros_dep]
            avaliacao = _rodar(banco, inc_id, volta, QUALIDADE, inc, anteriores, config.MODELO)
            testes_ok = all(t["ok"] for t in anteriores["testes"])
            avaliacao.update(
                testes=[{"comando": t["comando"], "ok": t["ok"], **({} if t["ok"] else {"saida": t["saida"][-1500:]})} for t in anteriores["testes"]],
                testes_ok=testes_ok,
            )
            faltou_teste = pede_teste(anteriores) and not anteriores["arquivos_teste"]
            if faltou_teste:
                # A qualidade (14B) já aprovou dizendo que havia teste quando o diff não tinha nenhum (#16, volta 4).
                avaliacao["problemas"] = [*avaliacao.get("problemas", []), "o pedido do TI exige teste e o diff não altera nenhum arquivo de teste"]
                avaliacao["motivo"] = "o pedido do TI exige teste e o diff não altera nenhum arquivo de teste. " + avaliacao.get("motivo", "")
                banco.gravar_desfecho(inc_id, volta, "faltou_teste", "executor")
            avaliacao["aprovado_final"] = bool(
                testes_ok and avaliacao["aprovado"] and avaliacao["resolve_a_causa"] and not avaliacao["regras_violadas"] and not faltou_teste
            )
            falhos = [t["comando"] for t in anteriores["testes"] if not t["ok"]]
            banco.gravar_desfecho(inc_id, volta, "testes_falharam" if falhos else "testes_passaram", "executor", ", ".join(falhos))
            banco.gravar_desfecho(inc_id, volta, "qualidade_aprovou" if avaliacao["aprovado"] else "qualidade_reprovou", "qualidade")
            with banco.trava:
                banco.db.execute(
                    "UPDATE etapas SET saida=? WHERE incidente_id=? AND volta=? AND agente='qualidade'",
                    (json.dumps(avaliacao, ensure_ascii=False), inc_id, volta),
                )
            anteriores["qualidade"] = avaliacao
        avaliacao = anteriores["qualidade"]
        if not avaliacao.get("aprovado_final"):
            falhas = [t["comando"] for t in avaliacao.get("testes", []) if not t["ok"]]
            return _nova_volta(banco, inc_id, volta, avaliacao.get("motivo", "") + (f" · testes falhando: {falhas}" if falhas else ""))

        if not config.PR_ABRIR:
            banco.gravar_desfecho(inc_id, volta, "volta_aprovada", detalhe=branch)
            banco.mudar_estado(inc_id, "pronto_para_pr", branch=branch)
            return "pronto_para_pr"
        url = repo.publicar(branch, anteriores["executor"]["titulo_pr"], _corpo_pr(banco, inc_id))
        banco.gravar_desfecho(inc_id, volta, "volta_aprovada", detalhe=url)
        banco.mudar_estado(inc_id, "pr_aberto", branch=branch, pr_url=url)
        return "pr_aberto"
    except llm.OllamaFora as erro:
        logger.warning("Ollama fora (%s); incidente %s espera", erro, inc_id)
        return "em_andamento"
    except repo.RedeFora as erro:
        logger.warning("GitHub inalcançável (%s); incidente %s espera", erro, inc_id)
        return "em_andamento"
    except llm.SaidaInvalida as erro:
        banco.gravar_desfecho(inc_id, volta, "escalado", detalhe=f"JSON inválido: {erro}"[:1000])
        banco.mudar_estado(inc_id, "escalado", nota_ti=f"um agente não devolveu JSON válido: {erro}")
        return "escalado"
    except (repo.ErroEdicao, RuntimeError, OSError) as erro:
        logger.exception("Incidente %s: falha na etapa de repositório", inc_id)
        banco.gravar_desfecho(inc_id, volta, "falha_de_infra", detalhe=str(erro)[:1000])
        banco.mudar_estado(inc_id, "escalado", nota_ti=f"falha no clone/testes/PR: {erro}")
        return "escalado"


CORPO_PR_MAX = 60000  # o GitHub recusa corpo de PR acima de 65536 caracteres (#16: 12 voltas, 83 mil)


def relatorio(banco: Banco, inc_id: int, so_volta: Optional[int] = None) -> str:
    inc = banco.incidente(inc_id)
    linhas = [
        f"# Incidente {inc['id']} — {inc['servico']} · {inc['evento']}",
        "",
        f"- Estado: **{inc['estado']}** · volta {inc['volta']} · {inc['ocorrencias']} ocorrência(s) ({inc['primeiro_em']} → {inc['ultimo_em']})",
        f"- Função: `{inc['funcao'] or '-'}` · commit em produção: `{inc['commit_prod'] or '-'}` · assinatura `{inc['assinatura']}`",
        f"- Mensagem: `{inc['mensagem']}`",
    ]
    if inc["anterior_id"]:
        linhas.append(f"- Reapareceu: incidente anterior com a mesma assinatura é o #{inc['anterior_id']}")
    if inc["rota"]:
        linhas.append(f"- Rota: `{inc['rota']}`")
    if inc["pr_url"] or inc["branch"]:
        linhas.append(f"- PR: {inc['pr_url'] or '(não aberto)'} · branch `{inc['branch']}`")
    if inc["merge_sha"]:
        linhas.append(f"- Merge: `{inc['merge_sha'][:7]}` · deploy visto em {inc['deploy_em'] or '(ainda não)'}"
                      + (f" · monitor até {inc['monitor_ate']}" if inc["monitor_ate"] else ""))
    if inc["nota_ti"]:
        linhas.append(f"- Nota: {inc['nota_ti']}")
    execucao = next((json.loads(e["saida"]) for e in reversed(banco.etapas(inc_id)) if e["agente"] == "executor"), {})
    if execucao.get("edicoes"):
        arquivos = sorted({e["arquivo"].strip().lstrip("./") for e in execucao["edicoes"]})
        linhas += ["", "## Depois do merge: deploy", ""] + repo.comandos_deploy(arquivos)
    if so_volta is not None and so_volta > 1:
        linhas += ["", f"_Voltas 1 a {so_volta - 1} ficam fora deste PR: veja o histórico na aba Agentes Qwen ou "
                   f"`python -m agentes mostrar {inc_id}` no PC._"]
    for e in banco.etapas(inc_id, so_volta):
        saida = json.loads(e["saida"])
        linhas += ["", f"## {e['agente'].capitalize()} (volta {e['volta']}, {e['segundos']} s, {e['modelo']})", ""]
        for chave, valor in saida.items():
            if chave == "diff":
                linhas += ["- **diff**:", "", "```diff", valor.rstrip(), "```"]
            elif isinstance(valor, list):
                linhas.append(f"- **{chave}**:")
                for item in valor:
                    linhas.append(f"  - {json.dumps(item, ensure_ascii=False) if isinstance(item, dict) else item}")
            else:
                linhas.append(f"- **{chave}**: {valor}")
        linhas.append(f"- _fontes_: {', '.join(json.loads(e['fontes'])) or '-'}")
    linhas += ["", "## Log", "", "```", inc["amostra"] or "", "```", ""]
    return "\n".join(linhas)


def notificar(banco: Banco, inc_id: int) -> None:
    config.RELATORIOS_DIR.mkdir(parents=True, exist_ok=True)
    caminho = config.RELATORIOS_DIR / f"incidente-{inc_id:05d}.md"
    caminho.write_text(relatorio(banco, inc_id), encoding="utf-8")
    inc = banco.incidente(inc_id)
    resumo = next((json.loads(e["saida"]).get("resumo") for e in reversed(banco.etapas(inc_id))), inc["mensagem"])
    if inc["estado"] == "aguardando_deploy":
        resumo = "PR mergeado: rode o deploy na VPS (comandos no fim do relatório)."
    logger.info("Incidente %s: %s — relatório em %s", inc_id, inc["estado"], caminho)
    if config.NOTIFICAR and shutil.which("notify-send"):
        subprocess.run(
            ["notify-send", "-a", "Agentes Qwen", f"Incidente {inc_id} · {inc['servico']} ({inc['estado']})", f"{resumo}\n{caminho}"],
            check=False,
        )


def trabalhar(banco: Banco, chegou: threading.Event, parar: threading.Event) -> None:
    from . import monitor

    ultimo_monitor = 0.0
    while not parar.is_set():
        if time.monotonic() - ultimo_monitor >= config.MONITOR_INTERVALO:
            ultimo_monitor = time.monotonic()
            try:
                for inc_id in monitor.verificar(banco):
                    notificar(banco, inc_id)
            except Exception:  # noqa: BLE001 — o monitor nunca derruba a cadeia
                logger.exception("Falha no monitor")
        inc = banco.proximo()
        if inc is None:
            chegou.wait(5)
            chegou.clear()
            continue
        estado = processar(banco, inc["id"])
        if estado == "em_andamento":
            parar.wait(config.ESPERA_OLLAMA_FORA)
        elif estado != "nova_volta":
            notificar(banco, inc["id"])
