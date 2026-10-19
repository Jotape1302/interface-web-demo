"""
Estado da automação em DATA_DIR, gravado de forma atômica (json_store):

- `fretes.json`: catálogo de anúncios (com as medidas da interface), trocas de frete com a
  conferência de 10 minutos, execuções da rotina e avisos para o gateway notificar.
- `ml_tokens.json`: access token do Mercado Livre por conta. A renovação é feita FORA da
  automação (fluxo externo, ainda a definir), que grava o token novo aqui; por isso o arquivo
  é relido a cada uso em vez de ficar em memória.

Um único processo usa estes arquivos; o lock protege a API e as rotinas em segundo plano.
"""
import copy
import json
import logging
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from app.config import settings
from app.dimensoes import e_carrinho
from app.json_store import SECRET_FILE_MODE, write_json_atomic

logger = logging.getLogger("marketplace.estado")

MAX_TROCAS = 2000
MAX_EXECUCOES = 90
MAX_AVISOS = 500


def agora() -> str:
    # Com o fuso (-03:00): sem ele o frontend lê o horário como UTC e mostra 3 h a menos.
    return datetime.now().astimezone().isoformat(timespec="seconds")


def ler_data(texto: str) -> datetime:
    """ISO gravado pela automação; os antigos, sem fuso, são horário local."""
    dt = datetime.fromisoformat(texto)
    return dt if dt.tzinfo else dt.astimezone()


def chave_anuncio(filial: str, mlb: str) -> str:
    return f"{filial}:{mlb}"


def _vazio() -> Dict[str, Any]:
    return {"anuncios": {}, "trocas": [], "execucoes": [], "avisos": [], "proximo_aviso": 1}


class Estado:
    """
    Um arquivo de estado em DATA_DIR. `fretes.json` (tipo de frete) é o padrão;
    a padronização de dimensões usa outro arquivo (`dimensoes.json`) com o mesmo mecanismo.
    """

    def __init__(self, pasta: Optional[Path] = None, arquivo: str = "fretes.json", vazio=None) -> None:
        self.pasta = Path(pasta or settings.DATA_DIR)
        self._nome = arquivo
        self._vazio = vazio or _vazio
        self._lock = threading.RLock()
        self._dados: Optional[Dict[str, Any]] = None

    @property
    def _arquivo(self) -> Path:
        return self.pasta / self._nome

    @property
    def _arquivo_tokens(self) -> Path:
        return self.pasta / "ml_tokens.json"

    def _ler(self, caminho: Path, padrao: Dict[str, Any]) -> Dict[str, Any]:
        if not caminho.exists():
            return padrao
        try:
            return json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as e:
            # Não sobrescreve um arquivo ilegível com um vazio: o catálogo tem medidas digitadas.
            raise RuntimeError(f"Estado ilegível em {caminho}: {e}") from e

    @contextmanager
    def alterar(self) -> Iterator[Dict[str, Any]]:
        """
        Bloco de leitura+escrita sobre uma cópia: só vale (em memória e no disco) se terminar
        sem exceção e a gravação der certo.
        """
        with self._lock:
            dados = copy.deepcopy(self.ler())
            yield dados
            write_json_atomic(self._arquivo, dados)
            self._dados = dados

    def ler(self) -> Dict[str, Any]:
        with self._lock:
            if self._dados is None:
                self._dados = {**self._vazio(), **self._ler(self._arquivo, self._vazio())}
            return self._dados

    # --- tokens do ML -----------------------------------------------------------------------

    def token(self, filial: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self._ler(self._arquivo_tokens, {}).get(filial) or {})

    def salvar_token(self, filial: str, dados: Dict[str, Any]) -> None:
        with self._lock:
            tokens = self._ler(self._arquivo_tokens, {})
            tokens[filial] = dados
            # Tokens do ML: 0600 (o backup do host lê via nsenter no userns do Docker rootless).
            write_json_atomic(self._arquivo_tokens, tokens, mode=SECRET_FILE_MODE)

    # --- listas com limite ------------------------------------------------------------------

    @staticmethod
    def registrar_aviso(dados: Dict[str, Any], tipo: str, titulo: str, mensagem: str) -> None:
        """Aviso para o gateway transformar em notificação (setor Marketplace + admins)."""
        aviso_id = int(dados.get("proximo_aviso") or 1)
        dados["avisos"].append({"id": aviso_id, "tipo": tipo, "titulo": titulo, "mensagem": mensagem, "criado_em": agora()})
        dados["proximo_aviso"] = aviso_id + 1
        del dados["avisos"][:-MAX_AVISOS]

    @staticmethod
    def registrar_troca(dados: Dict[str, Any], troca: Dict[str, Any]) -> Dict[str, Any]:
        troca = {"id": uuid.uuid4().hex[:12], **troca}
        dados["trocas"].append(troca)
        del dados["trocas"][:-MAX_TROCAS]
        return troca

    @staticmethod
    def registrar_execucao(dados: Dict[str, Any], execucao: Dict[str, Any]) -> None:
        dados["execucoes"].append(execucao)
        del dados["execucoes"][:-MAX_EXECUCOES]


def lista_anuncios(dados: Dict[str, Any]) -> List[Dict[str, Any]]:
    # Carrinhos saem na próxima verificação; até lá, também não aparecem na tela.
    return [r for r in dados["anuncios"].values() if not e_carrinho(r.get("titulo"))]


estado = Estado()
