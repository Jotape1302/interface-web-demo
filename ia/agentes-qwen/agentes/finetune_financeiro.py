"""Fine-tuning QLoRA 4-bit do classificador de NF-e na RTX 3060 (12 GB) (etapa 5); o adaptador roda no llama-server.

Roda no venv de treino (requirements-train.txt), não no do RAGs:

  .venv-treino/bin/python -m agentes.finetune_financeiro [--force] [--max-passos N] [--dpo]

ou pelo atalho `../RAGs/.venv/bin/python -m agentes finetune-financeiro ...`, que chama este mesmo
módulo com o .venv-treino. Só usa a biblioteca padrão fora das funções de treino.

Passos:
  1. Pré-voo: pelo menos --min-exemplos linhas em dados/treino/financeiro_sft.jsonl (gere antes com
     `python -m agentes treino-financeiro`); --force passa por cima, para testar o caminho.
  2. Baixa a base (~10 GB na primeira vez) com o serviço ainda no ar. Libera a GPU: para o serviço agentes-qwen (o classificador e os incidentes esperam; o coletor da
     VPS guarda a fila) e descarrega do Ollama os modelos carregados (keep_alive 0). O serviço volta no fim,
     mesmo se o treino falhar.
  3. SFT com Unsloth: base unsloth/Qwen2.5-14B-Instruct-bnb-4bit, LoRA r=16/alpha=16 nas 7 projeções,
     batch 1 × acumulação 8, adamw_8bit, lr 2e-4 cosseno, 3 épocas, loss só na resposta.
     --dpo roda depois uma passada de DPO com financeiro_dpo.jsonl (pode faltar memória com 12 GB).
  4. Salva o adaptador em dados/modelos/qwen-financeiro-lora/ e converte para GGUF com o
     convert_lora_to_gguf.py do llama.cpp (clone raso em dados/llama.cpp na primeira vez): o
     adapter.gguf é o CANDIDATO. Ele não vai para o Ollama (o 0.40 não aceita mais ADAPTER): roda no
     llama-server sobre o mesmo GGUF da base (agentes/llama_server.py).

A promoção NÃO é aqui: `python -m agentes comparar-financeiro` mede o candidato contra o modelo atual
na validação e só promove (`--promover`) se a acurácia for maior ou igual.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
DADOS = Path(os.getenv("DADOS_DIR", str(RAIZ / "dados")))
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
BASE_HF = "unsloth/Qwen2.5-14B-Instruct-bnb-4bit"
BASE_CONFIG_HF = "Qwen/Qwen2.5-14B-Instruct"  # config/tokenizer para o conversor GGUF (não baixa os pesos)
SERVICO = "agentes-qwen"
ALVO_LORA = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
LLAMA_CPP_REPO = "https://github.com/ggml-org/llama.cpp"


def ler_jsonl(caminho: Path) -> list[dict]:
    if not caminho.is_file():
        return []
    return [json.loads(l) for l in caminho.read_text(encoding="utf-8").splitlines() if l.strip()]


def texto_sft(ex: dict, template) -> dict:
    """Uma linha do SFT no texto do chat template do Qwen (a loss fica só na resposta, ver treinar_sft)."""
    return {"text": template(ex["messages"], tokenize=False)}


def baixar_base(repo: str) -> None:
    """Baixa (ou confere no cache do HuggingFace) a base antes de parar o serviço: são ~10 GB."""
    from huggingface_hub import snapshot_download

    print(f"[*] Base {repo}: baixando/conferindo no cache do HuggingFace (o serviço segue no ar)")
    snapshot_download(repo)


# --- GPU e serviço ----------------------------------------------------------------------------


def _ollama(caminho: str, corpo: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{OLLAMA_URL}{caminho}", data=json.dumps(corpo).encode() if corpo is not None else None,
        headers={"Content-Type": "application/json"}, method="POST" if corpo is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read() or b"{}")


def descarregar_ollama() -> list[str]:
    """Tira da VRAM todo modelo que o Ollama tiver carregado. Ollama fora do ar: nada a liberar."""
    try:
        carregados = [m["name"] for m in _ollama("/api/ps").get("models", [])]
    except OSError:
        return []
    for nome in carregados:
        _ollama("/api/generate", {"model": nome, "keep_alive": 0})
    return carregados


def _systemctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True)


@contextmanager
def gpu_livre(parar_servico: bool = True):
    """Para o serviço e esvazia o Ollama; no fim (com ou sem erro) religa o serviço se ele estava ativo."""
    estava_ativo = parar_servico and _systemctl("is-active", SERVICO).stdout.strip() == "active"
    if estava_ativo:
        print(f"[*] Parando o serviço {SERVICO} enquanto usa a GPU (o coletor da VPS guarda a fila)")
        _systemctl("stop", SERVICO)
    descarregados = descarregar_ollama()
    if descarregados:
        print(f"[*] Descarregados do Ollama: {', '.join(descarregados)}")
        time.sleep(3)
    try:
        yield
    finally:
        if estava_ativo:
            _systemctl("start", SERVICO)
            print(f"[*] Serviço {SERVICO} religado")


# --- treino -------------------------------------------------------------------------------------


def treinar(args, sft: list[dict], dpo: list[dict], saida: Path) -> None:
    import torch
    from datasets import Dataset
    from unsloth import FastLanguageModel  # antes de trl/transformers: o Unsloth aplica os patches dele
    from unsloth.chat_templates import train_on_responses_only
    from trl import SFTConfig, SFTTrainer

    torch.cuda.empty_cache()
    modelo, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base, max_seq_length=args.seq, load_in_4bit=True, dtype=None
    )
    modelo = FastLanguageModel.get_peft_model(
        modelo, r=16, lora_alpha=16, lora_dropout=0.0, target_modules=ALVO_LORA, bias="none",
        use_gradient_checkpointing="unsloth", random_state=3407,
    )
    dados = Dataset.from_list([texto_sft(ex, tokenizer.apply_chat_template) for ex in sft])
    comum = dict(
        per_device_train_batch_size=1, gradient_accumulation_steps=8, learning_rate=args.lr, lr_scheduler_type="cosine",
        optim="adamw_8bit", num_train_epochs=args.epocas, max_steps=args.max_passos or -1, logging_steps=1,
        bf16=True, save_strategy="no", report_to="none", seed=3407,
    )
    treinador = SFTTrainer(
        model=modelo, processing_class=tokenizer, train_dataset=dados,
        args=SFTConfig(output_dir=str(saida / "sft"), dataset_text_field="text", max_length=args.seq, **comum),
    )
    # Loss só nos tokens da resposta: o modelo aprende o JSON da classificação, não a decorar o prompt.
    treinador = train_on_responses_only(
        treinador, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n"
    )
    treinador.train()

    if args.dpo and dpo:
        from trl import DPOConfig, DPOTrainer

        pares = Dataset.from_list([{k: p[k] for k in ("prompt", "chosen", "rejected")} for p in dpo])
        DPOTrainer(
            model=modelo, ref_model=None, processing_class=tokenizer, train_dataset=pares,
            args=DPOConfig(output_dir=str(saida / "dpo"), beta=0.1, max_length=args.seq, **{**comum, "learning_rate": 5e-6}),
        ).train()

    modelo.save_pretrained(str(saida))
    tokenizer.save_pretrained(str(saida))


# --- GGUF e Ollama -------------------------------------------------------------------------------


def converter_gguf(adaptador: Path) -> Path:
    llama = DADOS / "llama.cpp"
    if not (llama / "convert_lora_to_gguf.py").is_file():
        print(f"[*] Clonando o llama.cpp (raso) em {llama}")
        subprocess.run(["git", "clone", "--depth", "1", LLAMA_CPP_REPO, str(llama)], check=True)
    destino = adaptador / "adapter.gguf"
    subprocess.run(
        [sys.executable, str(llama / "convert_lora_to_gguf.py"), "--base-model-id", BASE_CONFIG_HF,
         "--outtype", "f16", "--outfile", str(destino), str(adaptador)],
        check=True, env={**os.environ, "PYTHONPATH": str(llama / "gguf-py")},
    )
    return destino


# --- CLI ------------------------------------------------------------------------------------------


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="finetune-financeiro", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pasta", type=Path, default=DADOS / "treino", help="onde estão os financeiro_*.jsonl")
    p.add_argument("--saida", type=Path, default=DADOS / "modelos" / "qwen-financeiro-lora")
    p.add_argument("--min-exemplos", type=int, default=100)
    p.add_argument("--force", action="store_true", help="treina mesmo abaixo de --min-exemplos (teste do caminho)")
    p.add_argument("--base", default=BASE_HF)
    p.add_argument("--seq", type=int, default=4096, help="max_seq_length (os prompts de 11/2026 têm até ~2.600 tokens)")
    p.add_argument("--epocas", type=float, default=3)
    p.add_argument("--max-passos", type=int, default=0, help="limita os passos de otimização (0 = as épocas inteiras)")
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--dpo", action="store_true", help="passada de DPO depois do SFT (financeiro_dpo.jsonl)")
    p.add_argument("--nao-parar-servico", action="store_true")
    p.add_argument("--sem-gguf", action="store_true", help="só treina e salva o adaptador em safetensors")
    args = p.parse_args(argv)

    sft = ler_jsonl(args.pasta / "financeiro_sft.jsonl")
    dpo = ler_jsonl(args.pasta / "financeiro_dpo.jsonl")
    if not sft:
        print(f"Sem {args.pasta / 'financeiro_sft.jsonl'}: rode antes `python -m agentes treino-financeiro`.", file=sys.stderr)
        return 2
    if len(sft) < args.min_exemplos and not args.force:
        print(f"Só {len(sft)} exemplo(s) de SFT (mínimo {args.min_exemplos}). Espere mais notas confirmadas ou use --force.", file=sys.stderr)
        return 2
    print(f"[*] SFT: {len(sft)} exemplo(s) · DPO: {len(dpo)} par(es){'' if args.dpo else ' (desligado)'}")

    args.saida.mkdir(parents=True, exist_ok=True)
    baixar_base(args.base)
    inicio = time.monotonic()
    with gpu_livre(not args.nao_parar_servico):
        treinar(args, sft, dpo, args.saida)
    print(f"[*] Adaptador em {args.saida} ({(time.monotonic() - inicio) / 60:.1f} min)")
    if args.sem_gguf:
        return 0
    gguf = converter_gguf(args.saida)
    print(f"[*] Candidato: {gguf}. Compare antes de promover:\n"
          "    ../RAGs/.venv/bin/python -m agentes comparar-financeiro")
    return 0


if __name__ == "__main__":
    sys.exit(main())
