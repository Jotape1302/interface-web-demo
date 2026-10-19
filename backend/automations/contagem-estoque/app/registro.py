"""
Registro das contagens (base para a futura integração com o ERP).

Cada foto com UM código de prateleira lido vira um registro "aguardando_confirmacao". O
operador confirma a quantidade ou corrige pelo bot; só registros "confirmada"/"corrigida"
devem alimentar o estoque. A imagem anotada fica guardada `retencao_dias` para auditoria.

Arquivo JSON único com gravação atômica (arquivo temporário + rename) e trava: o bot atende
vários operadores ao mesmo tempo.

Cada contagem tem um `numero` sequencial (1, 2, 3...; no painel e no Tiny como 000001), pedido do
usuário em 2026-10-15 para identificar o lançamento no Tiny. O último número fica em
sequencia.json, à parte: a limpeza por retenção apaga registros antigos e o número nunca pode
voltar a ser usado. Contagens de antes da numeração recebem número pela ordem de criação.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

FUSO_SP = timezone(timedelta(hours=-3))

AGUARDANDO = "aguardando_confirmacao"
CONFIRMADA = "confirmada"
CORRIGIDA = "corrigida"


def agora() -> str:
    return datetime.now(FUSO_SP).isoformat(timespec="seconds")


def sha256_arquivo(caminho: Path) -> str:
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


class RegistroContagens:
    def __init__(self, pasta: Path, retencao_dias: int = 60) -> None:
        self.pasta = Path(pasta)
        self.imagens = self.pasta / "imagens"
        self.arquivo = self.pasta / "contagens.json"
        self.arquivo_sequencia = self.pasta / "sequencia.json"
        self.retencao_dias = retencao_dias
        self._lock = threading.Lock()

    # --- arquivo ------------------------------------------------------------------------------

    def _ler(self) -> dict[str, Any]:
        if not self.arquivo.exists():
            return {}
        try:
            return json.loads(self.arquivo.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            # Nunca sobrescreve um registro ilegível: é o histórico das contagens.
            raise RuntimeError(f"Registro de contagens ilegível em {self.arquivo}: {e}") from e

    def _gravar(self, dados: dict[str, Any]) -> None:
        self.pasta.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.pasta, prefix=".contagens-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(dados, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.arquivo)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def _ultimo_numero(self, dados: dict[str, Any]) -> int:
        maior = max((int(r.get("numero") or 0) for r in dados.values()), default=0)
        if not self.arquivo_sequencia.exists():
            return maior
        try:
            ultimo = int(json.loads(self.arquivo_sequencia.read_text(encoding="utf-8"))["ultimo"])
        except (ValueError, KeyError, TypeError) as e:
            # Nunca recomeça a contagem por cima: repetiria números já lançados no Tiny.
            raise RuntimeError(f"Sequência das contagens ilegível em {self.arquivo_sequencia}: {e}") from e
        return max(ultimo, maior)

    def _gravar_sequencia(self, ultimo: int) -> None:
        self.pasta.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.pasta, prefix=".sequencia-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"ultimo": ultimo}, f)
            os.replace(tmp, self.arquivo_sequencia)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def _numerar(self, dados: dict[str, Any]) -> bool:
        """Dá número às contagens que ainda não têm, na ordem de criação. True se mudou algo."""
        sem_numero = sorted((r for r in dados.values() if not r.get("numero")), key=lambda r: r.get("criado_em", ""))
        if not sem_numero:
            return False
        ultimo = self._ultimo_numero(dados)
        for registro in sem_numero:
            ultimo += 1
            registro["numero"] = ultimo
        # Sequência antes do registro: se cair no meio, sobra um número sem uso, nunca um repetido.
        self._gravar_sequencia(ultimo)
        return True

    def numerar_existentes(self) -> None:
        """Na subida do bot: numera as contagens anteriores à numeração (o painel já mostra o número)."""
        with self._lock:
            dados = self._ler()
            if self._numerar(dados):
                self._gravar(dados)

    def _limpar_antigos(self, dados: dict[str, Any]) -> None:
        limite = (datetime.now(FUSO_SP) - timedelta(days=self.retencao_dias)).isoformat(timespec="seconds")
        for rid in [r for r, reg in dados.items() if reg.get("criado_em", "") < limite]:
            imagem = dados[rid].get("imagem")
            if imagem:
                (self.imagens / imagem).unlink(missing_ok=True)
            imagem_original = dados[rid].get("imagem_original")
            if imagem_original:
                (self.imagens / imagem_original).unlink(missing_ok=True)
            del dados[rid]

    # --- operações ----------------------------------------------------------------------------

    def criar(
        self,
        *,
        codigo: Optional[str],
        origem_codigo: str,
        quantidade: int,
        alertas: list[str],
        imagem_anotada: Path,
        foto_original: Path,
        telegram_user_id: Optional[int],
        telegram_user: str,
        telegram_chat_id: Optional[int],
        sku_legenda: Optional[str] = None,
        codigos_barras: Optional[list[str]] = None,
        cor: str = "verde",
        unidades_por_fardo: int = 5,
    ) -> dict[str, Any]:
        rid = uuid.uuid4().hex[:12]
        self.imagens.mkdir(parents=True, exist_ok=True)
        nome_imagem = f"{rid}.jpg"
        nome_imagem_original = f"{rid}_original.jpg"
        shutil.copyfile(imagem_anotada, self.imagens / nome_imagem)
        shutil.copyfile(foto_original, self.imagens / nome_imagem_original)
        registro = {
            "id": rid,
            "criado_em": agora(),
            "codigo": codigo,
            # Como o produto foi identificado: "codigo_e_legenda" (os dois batem — o mais
            # confiável), "codigo_de_barras", "legenda" (SKU digitado pelo operador) ou
            # "sem_produto" (codigo None: o SKU é informado depois pelo painel).
            "origem_codigo": origem_codigo,
            "sku_legenda": sku_legenda,
            "codigos_barras": list(codigos_barras or []),
            "quantidade_detectada": quantidade,
            # Cor do prendedor e unidades por fardo dela (verde 5, rosa 10): o painel só pede as
            # unidades soltas. Registros antigos não têm esses campos (fardo informado à mão).
            "cor": cor,
            "unidades_por_fardo": unidades_por_fardo,
            "quantidade_final": None,
            "status": AGUARDANDO,
            "alertas": list(alertas),
            "telegram_user_id": telegram_user_id,
            "telegram_user": telegram_user,
            "telegram_chat_id": telegram_chat_id,
            "foto_sha256": sha256_arquivo(foto_original),
            "imagem": nome_imagem,
            "imagem_original": nome_imagem_original,
            "concluido_em": None,
        }
        with self._lock:
            dados = self._ler()
            self._limpar_antigos(dados)
            dados[rid] = registro
            self._numerar(dados)
            self._gravar(dados)
        return registro

    def obter(self, rid: str) -> Optional[dict[str, Any]]:
        with self._lock:
            return self._ler().get(rid)

    def concluir(self, rid: str, quantidade_final: int, telegram_user_id: Optional[int]) -> dict[str, Any]:
        """Confirma (quantidade igual à detectada) ou corrige. Só quem enviou a foto conclui."""
        if quantidade_final < 0:
            raise ValueError("Quantidade não pode ser negativa.")
        with self._lock:
            dados = self._ler()
            registro = dados.get(rid)
            if registro is None:
                raise KeyError(rid)
            if registro["telegram_user_id"] is not None and registro["telegram_user_id"] != telegram_user_id:
                raise PermissionError("Só quem enviou a foto pode confirmar esta contagem.")
            if registro["status"] != AGUARDANDO:
                raise ValueError(f"Contagem já {registro['status']} ({registro['quantidade_final']}).")
            registro["quantidade_final"] = quantidade_final
            registro["status"] = CONFIRMADA if quantidade_final == registro["quantidade_detectada"] else CORRIGIDA
            registro["concluido_em"] = agora()
            self._gravar(dados)
            return dict(registro)
