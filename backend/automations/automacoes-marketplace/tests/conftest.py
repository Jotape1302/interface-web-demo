import copy
from typing import Any, Dict, List, Optional

import pytest

from app.db import RepositorioMemoria
from app.dimensoes import Dimensoes
from app.estado import Estado, agora


class MLFalso:
    """Mercado Livre em memória: guarda os anúncios e registra cada alteração pedida."""

    def __init__(self, itens: List[Dict[str, Any]], descricoes: Optional[Dict[str, str]] = None) -> None:
        self.itens = {i["id"]: copy.deepcopy(i) for i in itens}
        self.descricoes = dict(descricoes or {})
        self.medidas_enviadas: List[tuple] = []
        self.trocas: List[tuple] = []
        self.atributos_enviados: List[tuple] = []
        self.descricoes_lidas: List[str] = []
        # Simula o ML aceitando o PUT e voltando para "a combinar" logo depois.
        self.reverter_troca = False
        self.recusar_ficha = False

    def ids_dos_anuncios(self) -> List[str]:
        return list(self.itens)

    def anuncios(self, ids: List[str]):
        for i in ids:
            yield copy.deepcopy(self.itens[i])

    def anuncio(self, mlb: str) -> Dict[str, Any]:
        return copy.deepcopy(self.itens[mlb])

    def descricao(self, mlb: str) -> str:
        self.descricoes_lidas.append(mlb)
        return self.descricoes.get(mlb, "")

    def atualizar_atributos(self, mlb: str, atributos: List[Dict[str, str]], descricao: str) -> None:
        from app.ml_client import MLAPIError

        if self.recusar_ficha:
            raise MLAPIError("attribute not modifiable", 400)
        self.atributos_enviados.append((mlb, atributos))

    def enviar_medidas(self, mlb: str, dims: Dimensoes) -> None:
        if not dims.peso:
            from app.ml_client import MLAPIError

            raise MLAPIError("The attributes [seller_package_weight] are all required", 400)
        self.medidas_enviadas.append((mlb, (dims.altura, dims.largura, dims.comprimento), dims.peso))
        dims = dims.para_ml()  # o ML real só aceita e guarda inteiros
        attrs = [a for a in self.itens[mlb].get("attributes", []) if not a["id"].startswith("SELLER_PACKAGE_")]
        attrs += [
            {"id": "SELLER_PACKAGE_HEIGHT", "value_name": f"{dims.altura} cm"},
            {"id": "SELLER_PACKAGE_WIDTH", "value_name": f"{dims.largura} cm"},
            {"id": "SELLER_PACKAGE_LENGTH", "value_name": f"{dims.comprimento} cm"},
            {"id": "SELLER_PACKAGE_WEIGHT", "value_name": f"{dims.peso} g"},
        ]
        self.itens[mlb]["attributes"] = attrs

    def trocar_envio(self, mlb: str, dims: Dimensoes, modo: str, envio_atual: Dict[str, Any]) -> None:
        self.trocas.append((mlb, modo, dict(envio_atual)))
        if not self.reverter_troca:
            self.itens[mlb]["shipping"]["mode"] = modo


class TinyFalso:
    """Tiny em memória: produtos por id; registra as gravações de dimensões."""

    def __init__(self, produtos: List[Dict[str, Any]]) -> None:
        self.produtos_por_id = {p["id"]: copy.deepcopy(p) for p in produtos}
        self.gravados: List[tuple] = []
        self.lidos: List[int] = []

    def produtos(self):
        for p in self.produtos_por_id.values():
            yield {"id": p["id"], "sku": p["sku"], "descricao": p["descricao"], "dataAlteracao": p.get("dataAlteracao", "1")}

    def produto(self, produto_id: int) -> Dict[str, Any]:
        self.lidos.append(produto_id)
        return copy.deepcopy(self.produtos_por_id[produto_id])

    def gravar_dimensoes(self, produto: Dict[str, Any], dims: Dimensoes) -> None:
        self.gravados.append((produto["id"], dims))
        p = self.produtos_por_id[produto["id"]]
        p["dimensoes"] = {
            "altura": dims.altura, "largura": dims.largura, "comprimento": dims.comprimento,
            "pesoLiquido": dims.peso / 1000 if dims.peso else None,
        }
        p["dataAlteracao"] = str(int(p.get("dataAlteracao", "1")) + 1)


def item(
    mlb: str,
    titulo: str,
    modo: str = "me2",
    dims_ml: Optional[str] = None,
    atributos: Optional[List[Dict[str, Any]]] = None,
    status: str = "active",
    sku: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    attrs = list(atributos or [])
    if sku:
        attrs.append({"id": "SELLER_SKU", "value_name": sku})
    return {
        "id": mlb,
        "title": titulo,
        "status": status,
        "permalink": f"https://produto.mercadolivre.com.br/{mlb}",
        "last_updated": "2026-09-29T10:00:00.000Z",
        "shipping": {"mode": modo, "dimensions": dims_ml, "tags": list(tags or []), "free_shipping": True, "local_pick_up": True},
        "attributes": attrs,
    }


def produto_tiny(pid: int, sku: str, descricao: str, dims: Optional[Dict[str, Any]] = None, complementar: str = "") -> Dict[str, Any]:
    return {"id": pid, "sku": sku, "descricao": descricao, "descricaoComplementar": complementar, "dimensoes": dims or {}}


def gravar_padrao(repo: RepositorioMemoria, sku: str, a: float, l: float, c: float, peso: Optional[int] = 500) -> None:
    repo.salvar({
        "sku": sku, "descricao": sku, "altura_cm": a, "largura_cm": l, "comprimento_cm": c, "peso_g": peso,
        "embalagem_comprimento_cm": None, "confiabilidade": "alta", "fontes": [], "envios": None,
        "validado_por": "teste", "validado_em": agora(), "atualizado_em": agora(),
    })


@pytest.fixture
def estado(tmp_path) -> Estado:
    return Estado(tmp_path)


@pytest.fixture
def repo() -> RepositorioMemoria:
    return RepositorioMemoria()


@pytest.fixture(autouse=True)
def _config_padrao(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "ML_CONTAS_COM_ME1", "norvia")
    monkeypatch.setattr(settings, "FRETES_MINUTOS_CONFERENCIA", 10)
    monkeypatch.setattr(settings, "TINY_CONTAS", "norvia_campinas,revesta")
    monkeypatch.setattr(settings, "EMBALAGEM_SECAO_CM", "5,7")
    monkeypatch.setattr(settings, "EMBALAGEM_COMPRIMENTOS_CM", "100,200,300")


@pytest.fixture(autouse=True)
def _sem_chave_interna_por_padrao(monkeypatch):
    """A chave interna tem testes próprios (test_seguranca.py); nos demais fica desligada, como em dev."""
    monkeypatch.setenv("INTERNAL_AUTH_DISABLED", "true")
    monkeypatch.delenv("AUTOMATIONS_INTERNAL_KEY", raising=False)
