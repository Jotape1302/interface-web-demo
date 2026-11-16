"""
Medidas de produto: a ficha técnica e a embalagem dos anúncios do ML, as medidas do cadastro do
Tiny (fonte das medidas e do peso bruto), a embalagem e o tipo de envio indicado.

A embalagem que vai ao ML é a do cadastro do Tiny (altura, largura, comprimento e peso bruto),
a mesma que a integração do Tiny manda; o maior lado decide o tipo de envio (até 2 m: ME2; maior: ME1).
"""
import math
import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, List, Optional

from app.config import settings

# Tolerâncias da comparação interface × ML: o ML guarda números "redondos" e o título às vezes
# traz medida com casa decimal, então diferença menor que isso não vira pendência.
TOLERANCIA_CM = 0.5


@dataclass
class Dimensoes:
    altura: Optional[float] = None  # cm
    largura: Optional[float] = None  # cm
    comprimento: Optional[float] = None  # cm
    # g — o do ML; na interface, só preenchido em anúncio sem peso nenhum no ML (ver
    # docstring do módulo e rotina.peso_para_envio).
    peso: Optional[int] = None

    @property
    def lados(self) -> List[Optional[float]]:
        return [self.altura, self.largura, self.comprimento]

    def para_ml(self) -> "Dimensoes":
        """
        Como vai ao ML: ele só aceita cm e g inteiros ("Only integers are accepted"). Lado com
        fração sobe para o próximo inteiro (embalagem de 1,2 cm não cabe em 1 cm).
        """
        return Dimensoes(*(cm_inteiro(v) for v in self.lados), int(round(self.peso)) if self.peso else None)

    def completas(self) -> bool:
        return all(v is not None and v > 0 for v in self.lados)

    def vazias(self) -> bool:
        return all(v is None for v in self.lados)

    def faltando(self) -> List[str]:
        nomes = {"altura": self.altura, "largura": self.largura, "comprimento": self.comprimento}
        return [nome for nome, v in nomes.items() if v is None or v <= 0]

    def texto_ml(self) -> Optional[str]:
        """O texto de shipping.dimensions; None sem peso (o ML exige peso nesse campo)."""
        if not self.completas() or not self.peso:
            return None
        ml = self.para_ml()
        return f"{ml.altura}x{ml.largura}x{ml.comprimento},{ml.peso}"

    def para_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @staticmethod
    def de_dict(dados: Optional[Dict[str, Any]]) -> "Dimensoes":
        dados = dados or {}
        return Dimensoes(
            altura=_num(dados.get("altura")),
            largura=_num(dados.get("largura")),
            comprimento=_num(dados.get("comprimento")),
            peso=_int(dados.get("peso")),
        )


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        n = float(str(v).replace(",", "."))
    except ValueError:
        return None
    return n if n > 0 else None


def _int(v: Any) -> Optional[int]:
    n = _num(v)
    return int(round(n)) if n is not None else None


def cm_inteiro(v: Optional[float]) -> Optional[int]:
    return max(1, math.ceil(round(v, 2))) if v else None


def _sem_zeros(v: Optional[float]) -> str:
    """5.0 -> "5", 2.5 -> "2.5" (o ML não aceita "5.0")."""
    if v is None:
        return ""
    return f"{v:.2f}".rstrip("0").rstrip(".")


# ---------------------------------------------------------------------------------------------
# Atributos do anúncio no ML
# ---------------------------------------------------------------------------------------------

def _valor_atributo(attr: Dict[str, Any], unidade_alvo: str) -> Optional[float]:
    """Lê "10 cm", "0,5 kg", "500 g" (value_name) ou value_struct {number, unit}."""
    struct = attr.get("value_struct") or {}
    numero, unidade = struct.get("number"), struct.get("unit")
    if numero is None:
        m = re.match(r"\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?", str(attr.get("value_name") or ""))
        if not m:
            return None
        numero, unidade = float(m.group(1).replace(",", ".")), m.group(2)
    try:
        numero = float(numero)
    except (TypeError, ValueError):
        return None
    unidade = (unidade or unidade_alvo).lower()
    if unidade_alvo == "cm":
        fator = {"mm": 0.1, "cm": 1.0, "m": 100.0}.get(unidade)
    else:
        fator = {"g": 1.0, "kg": 1000.0, "mg": 0.001}.get(unidade)
    if fator is None or numero <= 0:
        return None
    return round(numero * fator, 2)


def _dims_de_atributos(atributos: Iterable[Dict[str, Any]], prefixo: str) -> Dimensoes:
    por_id = {a.get("id"): a for a in atributos or [] if isinstance(a, dict)}

    def lado(nome: str) -> Optional[float]:
        a = por_id.get(f"{prefixo}{nome}")
        return _valor_atributo(a, "cm") if a else None

    peso_attr = por_id.get(f"{prefixo}WEIGHT")
    peso = _valor_atributo(peso_attr, "g") if peso_attr else None
    return Dimensoes(
        altura=lado("HEIGHT"),
        largura=lado("WIDTH"),
        comprimento=lado("LENGTH"),
        peso=int(round(peso)) if peso else None,
    )


# Ficha técnica do PRODUTO no ML (não a embalagem: SELLER_PACKAGE_*/PACKAGE_* ficam de fora).
# Perfis, cantoneiras e chapas costumam ter espessura/profundidade/diâmetro no lugar da altura.
ATRIBUTOS_PRODUTO_ML = {
    "altura": ("HEIGHT", "THICKNESS", "DEPTH", "DIAMETER"),
    "largura": ("WIDTH",),
    "comprimento": ("LENGTH",),
}
ATRIBUTOS_PESO_ML = ("WEIGHT", "NET_WEIGHT", "UNIT_WEIGHT")


def _atributos(item: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    atributos = list(item.get("attributes") or [])
    for v in item.get("variations") or []:
        atributos.extend(v.get("attributes") or [])
    por_id: Dict[str, Dict[str, Any]] = {}
    for a in atributos:
        if isinstance(a, dict) and a.get("id") and a["id"] not in por_id and (a.get("value_name") or a.get("value_struct")):
            por_id[a["id"]] = a
    return por_id


def ficha_ml(item: Dict[str, Any]) -> Dimensoes:
    """Ficha técnica ("dados do produto") do anúncio: medidas e peso do produto."""
    por_id = _atributos(item)

    def primeiro(ids: Iterable[str], unidade: str) -> Optional[float]:
        for attr_id in ids:
            if attr_id in por_id:
                v = _valor_atributo(por_id[attr_id], unidade)
                if v:
                    return v
        return None

    peso = primeiro(ATRIBUTOS_PESO_ML, "g")
    return Dimensoes(
        **{nome: primeiro(ids, "cm") for nome, ids in ATRIBUTOS_PRODUTO_ML.items()},
        peso=int(round(peso)) if peso else None,
    )


def valores_ficha(item: Dict[str, Any], ids: Iterable[str]) -> Dict[str, Optional[float]]:
    """Valor atual de cada atributo de medida da ficha (cm; os de peso em g), None se vazio."""
    por_id = _atributos(item)
    return {
        attr_id: (_valor_atributo(por_id[attr_id], "g" if "WEIGHT" in attr_id else "cm") if attr_id in por_id else None)
        for attr_id in ids
    }


def medidas_tiny(produto: Dict[str, Any]) -> Dimensoes:
    """
    Medidas do cadastro do Tiny (cm) com o PESO BRUTO (kg → g): é o que vai para os anúncios do
    ML. Sem diâmetro no lugar da altura: só os três lados que o cadastro traz.
    """
    d = produto.get("dimensoes") or {}
    peso_kg = _num(d.get("pesoBruto"))
    return Dimensoes(
        altura=_num(d.get("altura")),
        largura=_num(d.get("largura")),
        comprimento=_num(d.get("comprimento")),
        peso=int(round(peso_kg * 1000)) if peso_kg else None,
    )


def peso_liquido_tiny(produto: Dict[str, Any]) -> Optional[int]:
    """Peso líquido do cadastro do Tiny em g (atributo NET_WEIGHT do ML), se houver."""
    peso_kg = _num((produto.get("dimensoes") or {}).get("pesoLiquido"))
    return int(round(peso_kg * 1000)) if peso_kg else None


def dimensoes_de_texto_ml(texto: Optional[str]) -> Dimensoes:
    """shipping.dimensions: "10x20x30,500"."""
    m = re.match(
        r"\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)", str(texto or "")
    )
    if not m:
        return Dimensoes()
    return Dimensoes(float(m.group(1)), float(m.group(2)), float(m.group(3)), int(round(float(m.group(4)))))


def embalagem_no_ml(item: Dict[str, Any]) -> Dimensoes:
    """
    Medidas de EMBALAGEM que o ML usa para o frete (conferência do tipo de envio). Nos anúncios
    "user product" ele usa SELLER_PACKAGE_* e ignora shipping.dimensions; nos demais, o texto.
    """
    pacote = _dims_de_atributos(item.get("attributes") or [], "SELLER_PACKAGE_")
    envio = dimensoes_de_texto_ml((item.get("shipping") or {}).get("dimensions"))
    return Dimensoes(
        altura=pacote.altura or envio.altura,
        largura=pacote.largura or envio.largura,
        comprimento=pacote.comprimento or envio.comprimento,
        peso=pacote.peso or envio.peso,
    )


# ---------------------------------------------------------------------------------------------
# Comparação e embalagem
# ---------------------------------------------------------------------------------------------

def mesmo_tamanho(a: Dimensoes, b: Dimensoes) -> bool:
    """Lados sem ordem, com tolerância de 0,5 cm ou 3% (2,98 m ≈ 3 m)."""
    if not (a.completas() and b.completas()):
        return False
    return all(
        abs(x - y) <= max(TOLERANCIA_CM, 0.03 * max(x, y))  # type: ignore[operator]
        for x, y in zip(sorted(a.lados), sorted(b.lados))  # type: ignore[type-var]
    )


def mesmo_peso(a: Optional[int], b: Optional[int]) -> bool:
    return bool(a and b and abs(a - b) <= max(10, 0.05 * max(a, b)))


def embalagem_para(produto: Dimensoes) -> Optional[Dimensoes]:
    """
    Embalagem do produto no ML: as medidas do cadastro do Tiny como estão, com o peso bruto (a
    padrão 5 x 7 x 100/200/300 era trocada de volta pela integração do Tiny). None sem os três lados.
    """
    if not produto.completas():
        return None
    return Dimensoes(produto.altura, produto.largura, produto.comprimento, produto.peso)


def envio_indicado(embalagem: Optional[Dimensoes]) -> Optional[str]:
    """
    Pelo maior lado da embalagem: até ME2_MAX_EMBALAGEM_CM (1 m e 2 m) é 'me2'; maior (3 m) é
    'me1'. None sem embalagem.
    """
    if embalagem is None or not embalagem.completas():
        return None
    return "me2" if max(embalagem.lados) <= settings.ME2_MAX_EMBALAGEM_CM else "me1"  # type: ignore[type-var]


def e_carrinho(titulo: Optional[str]) -> bool:
    """Carrinhos ficam fora da automação e da tela (decisão do e-commerce, 2026-09-29)."""
    texto = "".join(c for c in unicodedata.normalize("NFD", titulo or "") if unicodedata.category(c) != "Mn")
    return re.search(r"\bcarrinho", texto, re.IGNORECASE) is not None
