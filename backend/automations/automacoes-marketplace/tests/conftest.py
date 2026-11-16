import copy
from typing import Any, Dict, List, Optional

import pytest

from app.db import RepositorioMemoria
from app.dimensoes import Dimensoes
from app.estado import Estado


class MLFalso:
    """Mercado Livre em memória: guarda os anúncios e registra cada alteração pedida."""

    def __init__(self, itens: List[Dict[str, Any]], descricoes: Optional[Dict[str, str]] = None) -> None:
        self.itens = {i["id"]: copy.deepcopy(i) for i in itens}
        self.descricoes = dict(descricoes or {})
        self.medidas_enviadas: List[tuple] = []
        self.trocas: List[tuple] = []
        self.atributos_enviados: List[tuple] = []
        self.dimensoes_envio: List[tuple] = []
        self.descricoes_lidas: List[str] = []
        # Simula o ML aceitando o PUT e voltando para "a combinar" logo depois.
        self.reverter_troca = False
        self.recusar_ficha = False
        # Simula o ML respondendo OK ao PUT de medidas sem guardar nada.
        self.ignorar_envio = False
        # Simula o ML respondendo OK ao PUT da ficha e mantendo os valores (ex.: ficha do catálogo).
        self.ignorar_ficha = False

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
        if self.ignorar_envio or self.ignorar_ficha:
            return
        ids = {a["id"] for a in atributos}
        self.itens[mlb]["attributes"] = [a for a in self.itens[mlb].get("attributes", []) if a["id"] not in ids] + list(atributos)

    def enviar_medidas(self, mlb: str, dims: Dimensoes) -> None:
        if not dims.peso:
            from app.ml_client import MLAPIError

            raise MLAPIError("The attributes [seller_package_weight] are all required", 400)
        self.medidas_enviadas.append((mlb, (dims.altura, dims.largura, dims.comprimento), dims.peso))
        if self.ignorar_envio:
            return
        dims = dims.para_ml()  # o ML real só aceita e guarda inteiros
        attrs = [a for a in self.itens[mlb].get("attributes", []) if not a["id"].startswith("SELLER_PACKAGE_")]
        attrs += [
            {"id": "SELLER_PACKAGE_HEIGHT", "value_name": f"{dims.altura} cm"},
            {"id": "SELLER_PACKAGE_WIDTH", "value_name": f"{dims.largura} cm"},
            {"id": "SELLER_PACKAGE_LENGTH", "value_name": f"{dims.comprimento} cm"},
            {"id": "SELLER_PACKAGE_WEIGHT", "value_name": f"{dims.peso} g"},
        ]
        self.itens[mlb]["attributes"] = attrs

    def enviar_dimensoes_envio(self, mlb: str, dims: Dimensoes, envio_atual: Dict[str, Any]) -> bool:
        self.dimensoes_envio.append((mlb, dims.texto_ml(), envio_atual.get("mode")))
        if not self.ignorar_envio:
            self.itens[mlb]["shipping"]["dimensions"] = dims.texto_ml()
        return True

    def trocar_envio(self, mlb: str, dims: Dimensoes, modo: str, envio_atual: Dict[str, Any]) -> None:
        self.trocas.append((mlb, modo, dict(envio_atual)))
        if not self.reverter_troca:
            self.itens[mlb]["shipping"]["mode"] = modo


class TinyFalso:
    """Tiny em memória: produtos por id; registra os cadastros lidos."""

    def __init__(self, produtos: List[Dict[str, Any]]) -> None:
        self.produtos_por_id = {p["id"]: copy.deepcopy(p) for p in produtos}
        self.lidos: List[int] = []

    def produtos(self):
        for p in self.produtos_por_id.values():
            yield {"id": p["id"], "sku": p["sku"], "descricao": p["descricao"], "dataAlteracao": p.get("dataAlteracao", "1")}

    def produto(self, produto_id: int) -> Dict[str, Any]:
        self.lidos.append(produto_id)
        return copy.deepcopy(self.produtos_por_id[produto_id])


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


def produto_tiny(pid: int, sku: str, descricao: str, dims: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"id": pid, "sku": sku, "descricao": descricao, "dimensoes": dims or {}}


def medidas(a: float, l: float, c: float, peso_bruto_kg: Optional[float] = 0.4, **extra: Any) -> Dict[str, Any]:
    """Bloco `dimensoes` do cadastro do Tiny (cm e kg)."""
    return {"altura": a, "largura": l, "comprimento": c, "pesoBruto": peso_bruto_kg, **extra}


def padroes(por_filial: Dict[str, Dict[str, tuple]]):
    """Fonte de medidas do Tiny para a Rotina: {filial: {sku: (a, l, c, peso_g)}}."""
    return lambda: {
        f: {sku: {"sku": sku, "altura_cm": a, "largura_cm": l, "comprimento_cm": c, "peso_g": p} for sku, (a, l, c, p) in skus.items()}
        for f, skus in por_filial.items()
    }


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
    monkeypatch.setattr(settings, "TINY_CONTA_POR_FILIAL", "norvia:norvia_campinas,revesta:revesta")
    monkeypatch.setattr(settings, "ME2_MAX_EMBALAGEM_CM", 200.0)


@pytest.fixture(autouse=True)
def _sem_chave_interna_por_padrao(monkeypatch):
    """A chave interna tem testes próprios (test_seguranca.py); nos demais fica desligada, como em dev."""
    monkeypatch.setenv("INTERNAL_AUTH_DISABLED", "true")
    monkeypatch.delenv("AUTOMATIONS_INTERNAL_KEY", raising=False)
