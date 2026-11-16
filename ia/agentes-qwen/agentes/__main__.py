"""
Uso (com o venv do RAGs, que já tem torch/CUDA, sentence-transformers e chromadb):

  python -m agentes servir                 # receptor (127.0.0.1:8790) + trabalhador
  python -m agentes ingerir [agente]       # recria a RAG de um agente (ou de todos)
  python -m agentes listar
  python -m agentes mostrar <id>           # relatório completo
  python -m agentes reprocessar <id>       # refaz a volta atual do zero
  python -m agentes resolver <id> "nota"   # TI confirma como resolveu; entra na RAG da resolução
  python -m agentes simular                # manda um incidente de exemplo ao receptor
  python -m agentes treino [--agente X] [--rotulo certo,errado] [--saida arq.jsonl]
                                           # exporta as conversas rotuladas para fine-tuning
  python -m agentes classificar-nota <arquivo.review.json>
                                           # classifica uma nota da revisão de NF-e no terminal (sem gravar)
  python -m agentes importar-atividades <nfe.jsonl>
                                           # sugestão da tela de cada item (dump de exportar-atividades.sh da VPS)
  python -m agentes treino-financeiro [--pasta dados/treino]
                                           # datasets SFT, validação e DPO do classificador de NF-e
  python -m agentes avaliar-financeiro     # concordância com o Qwen e onde a pessoa mais corrige
  python -m agentes finetune-financeiro [--force] [--max-passos N] [--dpo]
                                           # QLoRA na GPU com o .venv-treino → adaptador candidato (GGUF)
  python -m agentes comparar-financeiro [--candidato arq.gguf] [--promover]
                                           # candidato × atual no llama-server; promove se não piorar
  python -m agentes classificar-boleto <boleto.json>
                                           # classifica um boleto DDA sem conta no terminal (sem gravar)
  python -m agentes treino-boletos [--pasta dados/treino]
                                           # datasets SFT, validação e DPO do classificador dos boletos DDA
  python -m agentes avaliar-boletos        # o que o histórico sozinho acerta, concordância do Qwen, correções
  python -m agentes finetune-boletos [--force] [--max-passos N] [--dpo]
                                           # QLoRA do classificador dos boletos (adaptador próprio)
  python -m agentes comparar-boletos [--candidato arq.gguf] [--promover]
                                           # candidato × atual × histórico sozinho; promove se não piorar
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import threading
import urllib.request

from pathlib import Path

from . import boletos, config, financeiro, financeiro_fila, pipeline, rag, treino, treino_boletos, treino_financeiro
from .banco import Banco

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("agentes")


def _incidentes_resolvidos(banco: Banco) -> list[tuple[str, str]]:
    extras = []
    for inc in banco.resolvidos():
        extras.append((f"incidentes › #{inc['id']} {inc['servico']}", rag.texto_resolvido(banco, inc)))
    return extras


def servir(banco: Banco) -> int:
    if len(config.INCIDENTES_TOKEN) < config.TAMANHO_MINIMO_TOKEN:
        logger.error("INCIDENTES_TOKEN ausente ou com menos de %s caracteres (.env)", config.TAMANHO_MINIMO_TOKEN)
        return 1
    from .receptor import criar_servidor

    chegou, nota_chegou, parar = threading.Event(), threading.Event(), threading.Event()
    servidor = criar_servidor(banco, chegou, config.INCIDENTES_TOKEN, nota_chegou=nota_chegou)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    passos = [("NF-e", financeiro.processar_fila), ("boletos DDA", boletos.processar_fila)]
    threading.Thread(target=financeiro.trabalhar, args=(banco, nota_chegou, parar, passos), daemon=True).start()
    logger.info("Receptor em http://%s:%s/incidentes · modelo %s · num_ctx %s", config.HOST, config.PORTA, config.MODELO, config.NUM_CTX)
    logger.info("Classificadores de NF-e e de boletos DDA ligados · modelo %s", config.MODELO_FINANCEIRO)
    try:
        pipeline.trabalhar(banco, chegou, parar)
    except KeyboardInterrupt:
        pass
    finally:
        parar.set()
        servidor.shutdown()
    return 0


def _portao(placares: list, atual, candidato, args, destino: Path, comando: str) -> int:
    """Imprime o placar e promove o candidato só se ele acertou algo, não teve mais inválidas e não piorou."""
    print(f"{'modelo':<34} {'acurácia':>17}  {'por R$':>7}  {'s/nota':>8}  inválidas")
    for p in placares:
        print(p.linha())
    if candidato.acertos == 0 or candidato.invalidas > atual.invalidas:
        # 0 × 0 não é "empate": é motor ou adaptador quebrado (ex.: schema ignorado, tudo inválido).
        print(f"\nCandidato sem acerto ou com mais respostas inválidas ({candidato.invalidas}): não promovido. Ver dados/llama-server.log.")
        return 1
    if candidato.acuracia < atual.acuracia:
        print("\nCandidato pior que o atual: não promovido.")
        return 1
    if not args.promover:
        print(f"\nCandidato não piorou. Para promover: {comando} --promover")
        return 0
    anterior = treino_financeiro.promover(args.candidato, destino)
    print(f"\nPromovido: {destino} (o classificador usa a partir do próximo lote)." + (f" O anterior ficou em {anterior}." if anterior else ""))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="agentes", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("servir")
    p = sub.add_parser("ingerir")
    p.add_argument("agente", nargs="?", choices=sorted(rag.FONTES))
    sub.add_parser("listar")
    for nome in ("mostrar", "reprocessar"):
        sub.add_parser(nome).add_argument("id", type=int)
    p = sub.add_parser("resolver")
    p.add_argument("id", type=int)
    p.add_argument("nota")
    sub.add_parser("simular")
    p = sub.add_parser("treino")
    p.add_argument("--agente", choices=sorted(rag.FONTES))
    p.add_argument("--rotulo", help="lista separada por vírgula (padrão: todos menos descartado)")
    p.add_argument("--saida", type=Path, default=config.DADOS_DIR / "treino" / "agentes.jsonl")
    sub.add_parser("classificar-nota").add_argument("arquivo", type=Path)
    sub.add_parser("importar-atividades").add_argument("arquivo", type=Path)
    sub.add_parser("treino-financeiro").add_argument("--pasta", type=Path, default=config.DADOS_DIR / "treino")
    sub.add_parser("avaliar-financeiro")
    sub.add_parser("finetune-financeiro", add_help=False)
    p = sub.add_parser("comparar-financeiro")
    p.add_argument("--candidato", type=Path, default=config.CANDIDATO_FINANCEIRO)
    p.add_argument("--pasta", type=Path, default=config.DADOS_DIR / "treino")
    p.add_argument("--promover", action="store_true", help="vira o adaptador do classificador se a acurácia não cair")
    sub.add_parser("classificar-boleto").add_argument("arquivo", type=Path)
    sub.add_parser("treino-boletos").add_argument("--pasta", type=Path, default=config.DADOS_DIR / "treino")
    sub.add_parser("avaliar-boletos")
    sub.add_parser("finetune-boletos", add_help=False)
    p = sub.add_parser("comparar-boletos")
    p.add_argument("--candidato", type=Path, default=config.CANDIDATO_BOLETOS)
    p.add_argument("--pasta", type=Path, default=config.DADOS_DIR / "treino")
    p.add_argument("--promover", action="store_true", help="vira o adaptador dos boletos se a acurácia não cair")
    argv = sys.argv[1:] if argv is None else list(argv)
    if argv[:1] == ["finetune-boletos"]:
        argv = ["finetune-financeiro", "--tarefa", "boletos", *argv[1:]]
    if argv[:1] == ["finetune-financeiro"]:
        # O treino roda no venv próprio (Unsloth não suporta o Python do RAGs): repassa os argumentos.
        python = config.RAIZ / ".venv-treino" / "bin" / "python"
        if not python.is_file():
            print("Falta o venv de treino: uv venv .venv-treino --python 3.12 && uv pip install -p .venv-treino -r requirements-train.txt",
                  file=sys.stderr)
            return 2
        return subprocess.call([str(python), "-m", "agentes.finetune_financeiro", *argv[1:]], cwd=config.RAIZ)
    args = parser.parse_args(argv)
    banco = Banco(config.BANCO)

    if args.cmd == "servir":
        return servir(banco)
    if args.cmd == "ingerir":
        for agente in [args.agente] if args.agente else sorted(rag.FONTES):
            extras = _incidentes_resolvidos(banco) if agente == "resolucao" else []
            print(f"{agente}: {rag.ingerir(agente, extras)} trechos")
        return 0
    if args.cmd == "listar":
        for inc in banco.listar():
            print(f"{inc['id']:>5}  {inc['estado']:<17} v{inc['volta']}  {inc['ocorrencias']:>4}x  {inc['servico']:<22} {inc['mensagem'][:70]}")
        return 0
    if args.cmd == "mostrar":
        if not banco.incidente(args.id):
            print("incidente não encontrado", file=sys.stderr)
            return 1
        print(pipeline.relatorio(banco, args.id))
        return 0
    if args.cmd == "reprocessar":
        inc = banco.incidente(args.id)
        if not inc:
            print("incidente não encontrado", file=sys.stderr)
            return 1
        with banco.trava:
            banco.db.execute("DELETE FROM etapas WHERE incidente_id=? AND volta=?", (args.id, inc["volta"]))
        banco.gravar_desfecho(args.id, inc["volta"], "ti_reprocessou")
        banco.mudar_estado(args.id, "novo", nota_ti=None)  # a nota era da tentativa refeita
        print(f"incidente {args.id} volta {inc['volta']} volta para a fila (o servir em execução pega em até 5 s)")
        return 0
    if args.cmd == "resolver":
        from . import painel

        if not painel.resolver_pelo_ti(banco, args.id, args.nota):
            print("incidente não encontrado", file=sys.stderr)
            return 1
        print(f"incidente {args.id} resolvido e incluído na RAG da resolução")
        return 0
    if args.cmd == "simular":
        exemplo = {
            "assinatura": "simulado0000001",
            "servico": "automacao-nfe",
            "evento": "automacao_nfe",
            "funcao": "ml_reconciliation.py:baixar",
            "mensagem": "Tiny HTTP 403 sem corpo ao baixar o recebimento",
            "amostra": "2026-10-30 09:00:03 [ERROR] [automacao_nfe]: Erro na baixa do recebimento: Tiny HTTP 403 sem corpo (POST /contas-receber/<id>/baixar)",
            "ocorrido_em": "2026-10-30T12:00:03Z",
            "ocorrencias": 1,
        }
        req = urllib.request.Request(
            f"http://{config.HOST}:{config.PORTA}/incidentes", data=json.dumps(exemplo).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {config.INCIDENTES_TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(resp.status, resp.read().decode())
        return 0
    if args.cmd == "classificar-nota":
        nota = financeiro.nota_do_review_json(args.arquivo)
        categorias = financeiro_fila.categorias(banco) or financeiro.catalogo_do_repo()
        financeiro.atualizar_vetores(banco)
        nomes = {c["id"]: f"{c['grupo']} → {c['nome']}" for c in categorias}
        descricoes = {i["item_id"]: i.get("descricao") for i in nota["itens"]}
        for r in financeiro.classificar(banco, nota, categorias):
            print(f"{r['item_id']:>4}  {r['confianca']:<5}  {nomes.get(r['categoria_id'], r['categoria_id'])}")
            print(f"      {descricoes.get(r['item_id'])}\n      motivo: {r['motivo']}")
        return 0
    if args.cmd == "importar-atividades":
        with args.arquivo.open(encoding="utf-8") as f:
            contagem = treino_financeiro.importar_atividades(banco, f)
        for nome in ("linhas", "confirmacoes", "itens", "incompletas", "recusadas_pela_vps", "json_invalido"):
            print(f"{nome:<20} {contagem[nome]:>6}")
        return 0
    if args.cmd == "treino-financeiro":
        financeiro.atualizar_vetores(banco)
        contagem = treino_financeiro.exportar(banco, args.pasta)
        for nome, n in sorted(contagem.items()):
            print(f"{nome:<24} {n:>6}")
        print(f"arquivos financeiro_*.jsonl em {args.pasta}")
        return 0
    if args.cmd == "avaliar-financeiro":
        print(treino_financeiro.avaliar(banco))
        return 0
    if args.cmd == "comparar-financeiro":
        if not args.candidato.is_file():
            print(f"Candidato {args.candidato} não existe: rode antes finetune-financeiro.", file=sys.stderr)
            return 2
        promovido = config.ADAPTADOR_FINANCEIRO if config.ADAPTADOR_FINANCEIRO.is_file() else None
        from . import finetune_financeiro

        # Outro processo: a trava da GPU do serviço não vale aqui, então o serviço para durante a medição.
        with finetune_financeiro.gpu_livre():
            atual, candidato = treino_financeiro.comparar(banco, args.candidato, args.pasta, promovido)
        return _portao([atual, candidato], atual, candidato, args, config.ADAPTADOR_FINANCEIRO, "comparar-financeiro")
    if args.cmd == "classificar-boleto":
        boleto = boletos.boleto_do_arquivo(args.arquivo)
        categorias = boletos.catalogo_do_historico(banco, boleto["empresa"])
        boletos.atualizar_vetores(banco)
        nomes = {c["id"]: f"{c['grupo']} → {c['nome']}" for c in categorias}
        r = boletos.classificar(banco, boleto, categorias)
        print(f"{r['confianca']:<5}  {nomes.get(r['categoria_id'], r['categoria_id'])}\n      motivo: {r['motivo']}")
        return 0
    if args.cmd == "treino-boletos":
        contagem = treino_boletos.exportar(banco, args.pasta)
        for nome, n in sorted(contagem.items()):
            print(f"{nome:<24} {n:>6}")
        print(f"arquivos boletos_*.jsonl em {args.pasta}")
        return 0
    if args.cmd == "avaliar-boletos":
        print(treino_boletos.avaliar(banco))
        return 0
    if args.cmd == "comparar-boletos":
        if not args.candidato.is_file():
            print(f"Candidato {args.candidato} não existe: rode antes finetune-boletos.", file=sys.stderr)
            return 2
        promovido = config.ADAPTADOR_BOLETOS if config.ADAPTADOR_BOLETOS.is_file() else None
        from . import finetune_financeiro

        with finetune_financeiro.gpu_livre():
            atual, candidato, base = treino_boletos.comparar(args.candidato, args.pasta, promovido)
        return _portao([base, atual, candidato], atual, candidato, args, config.ADAPTADOR_BOLETOS, "comparar-boletos")
    if args.cmd == "treino":
        rotulos = set(args.rotulo.split(",")) if args.rotulo else {"certo", "errado", "incerto", "pendente"}
        contagem = treino.exportar(banco, args.saida, args.agente, rotulos)
        for (agente, rotulo), n in sorted(contagem.items()):
            print(f"{agente:<12} {rotulo:<10} {n:>5}")
        print(f"{sum(contagem.values())} exemplos em {args.saida}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
