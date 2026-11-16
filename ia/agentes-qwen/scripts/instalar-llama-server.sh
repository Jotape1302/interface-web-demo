#!/usr/bin/env bash
# Instala o llama-server (llama.cpp, build CUDA 13) em dados/llama-server/ para o classificador de NF-e
# com adaptador LoRA (agentes/llama_server.py). Confere o sha256 dos dois pacotes antes de extrair.
# Para trocar de versão: atualize VERSAO e os dois sha256 (página de releases do ggml-org/llama.cpp).
set -euo pipefail

VERSAO=b12110
SABOR=bin-ubuntu-cuda-13.4-x64
BASE_URL="https://github.com/ggml-org/llama.cpp/releases/download/${VERSAO}"
declare -A SHA=(
  ["llama-${VERSAO}-${SABOR}.tar.gz"]=2afd2ca540da119570b1dac36b5a2c862bb03a3b789c46661dfa55e600f5b19b
  ["cudart-llama-${VERSAO}-${SABOR}.tar.gz"]=9b1110161943882ec85c8e9ae641075ee8c962a50f8f1e36534ee65ea1e56ed9
)

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO="${DADOS_DIR:-$RAIZ/dados}/llama-server"
BAIXADOS="$(mktemp -d)"
trap 'rm -rf "$BAIXADOS"' EXIT

for arq in "${!SHA[@]}"; do
  echo "[*] Baixando $arq"
  curl -fL --retry 3 -o "$BAIXADOS/$arq" "$BASE_URL/$arq"
  echo "${SHA[$arq]}  $BAIXADOS/$arq" | sha256sum -c -
done

NOVO="$DESTINO.novo"
rm -rf "$NOVO" && mkdir -p "$NOVO"
for arq in "${!SHA[@]}"; do
  tar -xzf "$BAIXADOS/$arq" -C "$NOVO"
done
# Os pacotes trazem uma pasta própria (ex.: build/bin): achata para dados/llama-server/.
BIN="$(dirname "$(find "$NOVO" -type f -name llama-server | head -1)")"
[ -x "$BIN/llama-server" ] || { echo "llama-server não encontrado no pacote" >&2; exit 1; }
if [ "$BIN" != "$NOVO" ]; then
  find "$NOVO" -mindepth 2 \( -type f -o -type l \) -exec mv -n {} "$NOVO"/ \;  # links das .so também
  find "$NOVO" -mindepth 1 -type d -empty -delete
fi
rm -rf "$DESTINO" && mv "$NOVO" "$DESTINO"
echo "$VERSAO $SABOR" > "$DESTINO/VERSAO"

LD_LIBRARY_PATH="$DESTINO" "$DESTINO/llama-server" --version
echo "[*] Pronto: $DESTINO/llama-server"
