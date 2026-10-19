"""
Medidas de produto: de onde vêm (títulos, descrições e fichas técnicas do ML e do Tiny), como
se comparam (confiabilidade da padronização), a embalagem padrão e o tipo de envio indicado.

A padronização é da medida do PRODUTO real (altura, largura, comprimento e peso). A embalagem é
padrão da empresa (seção 5 x 7 cm, comprimento 100/200/300 cm conforme o produto) e só serve ao
tipo de envio (medidas de embalagem no ML). Convenção: comprimento = maior lado, largura = o do
meio, altura = o menor (título e ficha não dizem qual é qual; o conjunto de lados é o que importa).
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
# Título do anúncio
# ---------------------------------------------------------------------------------------------

_NUMERO = r"(\d+(?:[.,]\d+)?)"
# A unidade pode vir colada no "x" ("16mmx16mmx3m"): basta não ser seguida de outra letra.
_UNIDADE = r"(mm|cm|m)(?![a-wyzA-WYZ])"
_X = r"\s*[xX×]\s*"
# "60x40x15cm", "60 x 40 x 15 cm", "1,20m x 0,80m x 5cm", "60x40x15" (sem unidade = cm)
_TRES_MEDIDAS = re.compile(
    rf"(?<![\d.,]){_NUMERO}\s*(?:{_UNIDADE})?{_X}{_NUMERO}\s*(?:{_UNIDADE})?{_X}{_NUMERO}\s*(?:{_UNIDADE})?",
    re.IGNORECASE,
)
# "60x40cm", "2,40 x 0,10 m" — só com unidade, para não confundir com "Kit 2x1".
_DUAS_MEDIDAS = re.compile(rf"(?<![\d.,]){_NUMERO}\s*(?:{_UNIDADE})?{_X}{_NUMERO}\s*{_UNIDADE}", re.IGNORECASE)
# Comprimento avulso em metros depois das duas medidas: "Cantoneira 16x16mm 3m", "... 2 Metros".
_METROS = re.compile(r"(?<![\d.,xX×])(\d+(?:[.,]\d+)?)\s*(?:m|metros?)(?![a-zA-Z])", re.IGNORECASE)

_PESO = re.compile(r"(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(kg|g)(?![a-zA-Z])", re.IGNORECASE)

_PARA_CM = {"mm": 0.1, "cm": 1.0, "m": 100.0}


def _em_cm(valor: str, unidade: Optional[str], unidade_padrao: str) -> float:
    fator = _PARA_CM[(unidade or unidade_padrao).lower()]
    return round(float(valor.replace(",", ".")) * fator, 2)


def dimensoes_do_titulo(titulo: str) -> Dimensoes:
    """
    Medidas escritas no título. A ordem do título não diz qual é altura, largura ou
    comprimento; como o tipo de envio e a comparação com o ML só dependem do conjunto de
    lados, gravamos na ordem em que aparecem. Com só duas medidas, a altura fica vazia.
    """
    texto = titulo or ""
    dims = Dimensoes()

    m = _TRES_MEDIDAS.search(texto)
    if m:
        v1, u1, v2, u2, v3, u3 = m.groups()
        # A unidade escrita no fim vale para os números sem unidade antes dela ("60x40x15cm").
        padrao = (u3 or u2 or u1 or "cm").lower()
        dims.altura = _em_cm(v1, u1, padrao)
        dims.largura = _em_cm(v2, u2, padrao)
        dims.comprimento = _em_cm(v3, u3, padrao)
    else:
        m2 = _DUAS_MEDIDAS.search(texto)
        if m2:
            v1, u1, v2, u2 = m2.groups()
            padrao = (u2 or u1).lower()
            metros = _METROS.search(texto, m2.end())
            if metros:
                dims.altura = _em_cm(v1, u1, padrao)
                dims.largura = _em_cm(v2, u2, padrao)
                dims.comprimento = _em_cm(metros.group(1), "m", "m")
            else:
                dims.largura = _em_cm(v1, u1, padrao)
                dims.comprimento = _em_cm(v2, u2, padrao)
    p = _PESO.search(texto)
    if p:
        dims.peso = _gramas(p.group(1), p.group(2))
    return dims


def _gramas(valor: str, unidade: Optional[str]) -> Optional[int]:
    n = float(valor.replace(",", "."))
    if not unidade:  # sem unidade: número pequeno é kg ("Peso: 1,2"), grande é g ("Peso: 850")
        unidade = "kg" if n < 50 else "g"
    g = n * (1000 if unidade.lower() == "kg" else 1)
    return int(round(g)) if g > 0 else None


_ROTULO = re.compile(
    r"\b(altura|largura|comprimento|profundidade|espessura|di[aâ]metro|peso(?:\s+l[ií]quido|\s+bruto)?)"
    r"(?:\s*\([^)]*\))?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m|kg|g)?(?![a-zA-Z])",
    re.IGNORECASE,
)


def dimensoes_de_texto(texto: str) -> Dimensoes:
    """
    Medidas numa descrição (ML ou Tiny): primeiro as rotuladas ("Altura: 10 cm", "Comprimento
    3m", "Espessura: 2mm", "Peso: 1,2 kg"); o que faltar, pelo padrão de título (60x40x15cm).
    """
    texto = re.sub(r"<[^>]+>", " ", texto or "")  # descrição do Tiny vem em HTML
    lados: Dict[str, float] = {}
    peso: Optional[int] = None
    for rotulo, valor, unidade in _ROTULO.findall(texto):
        r = _sem_acento(rotulo.lower())
        if r.startswith("peso"):
            if peso is None and (not unidade or unidade.lower() in ("kg", "g")):
                peso = _gramas(valor, unidade)
            continue
        if unidade and unidade.lower() in ("kg", "g"):
            continue
        chave = {"altura": "altura", "largura": "largura", "comprimento": "comprimento"}.get(r, "extra_" + r)
        if chave not in lados:
            lados[chave] = _em_cm(valor, unidade, "cm")
    principais = [lados.get("altura"), lados.get("largura"), lados.get("comprimento")]
    extras = [v for k, v in lados.items() if k.startswith("extra_")]
    for i, v in enumerate(principais):  # espessura/profundidade/diâmetro completam o que faltar
        if v is None and extras:
            principais[i] = extras.pop(0)
    dims = Dimensoes(*principais, peso)
    if not dims.completas():
        do_padrao = dimensoes_do_titulo(texto)
        if do_padrao.completas():
            dims = Dimensoes(*do_padrao.lados, dims.peso or do_padrao.peso)
    return dims


def _sem_acento(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn")


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


def ficha_tiny(produto: Dict[str, Any]) -> Dimensoes:
    """Dimensões do cadastro do Tiny (cm; peso em kg → g). Peso líquido é o do produto."""
    d = produto.get("dimensoes") or {}
    peso_kg = _num(d.get("pesoLiquido")) or _num(d.get("pesoBruto"))
    return Dimensoes(
        altura=_num(d.get("altura")) or _num(d.get("diametro")),
        largura=_num(d.get("largura")),
        comprimento=_num(d.get("comprimento")),
        peso=int(round(peso_kg * 1000)) if peso_kg else None,
    )


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
# Padronização: comparação entre fontes e confiabilidade
# ---------------------------------------------------------------------------------------------

# Ordem de preferência quando dois grupos empatam: ficha técnica > título > descrição.
PRIORIDADE_FONTE = {"tiny_ficha": 0, "ml_ficha": 1, "tiny_titulo": 2, "ml_titulo": 3, "tiny_descricao": 4, "ml_descricao": 5}
ORDEM_CONFIABILIDADE = {"baixa": 0, "media": 1, "alta": 2}


def normalizada(d: Dimensoes) -> Dimensoes:
    """Convenção da padronização: altura = menor lado, comprimento = maior."""
    if not d.completas():
        return d
    a, l, c = sorted(d.lados)  # type: ignore[type-var]
    return Dimensoes(a, l, c, d.peso)


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


def _grupos(itens: List[Dict[str, Any]], igual) -> List[List[Dict[str, Any]]]:
    grupos: List[List[Dict[str, Any]]] = []
    for it in sorted(itens, key=lambda f: PRIORIDADE_FONTE.get(f["fonte"], 9)):
        for g in grupos:
            if igual(g[0], it):
                g.append(it)
                break
        else:
            grupos.append([it])
    # Maior grupo primeiro; empate: o que tem a fonte mais confiável.
    grupos.sort(key=lambda g: (-len(g), PRIORIDADE_FONTE.get(g[0]["fonte"], 9)))
    return grupos


def _nivel(n_maior: int, n_total: int) -> str:
    if n_total == 0:
        return "baixa"
    if n_maior >= 2 and n_maior == n_total:
        return "alta"
    if n_maior >= 2 or n_total == 1:
        return "media"
    return "baixa"


def comparar_fontes(fontes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    fontes: [{"fonte": "ml_titulo"|..., "local": "...", "dims": {altura, largura, comprimento, peso}}].
    Agrupa as fontes com o mesmo tamanho (e, à parte, o mesmo peso) e sugere o valor do maior
    grupo. Confiabilidade: alta = todas as fontes com medida concordam (2 ou mais); média = a
    maioria concorda, ou só uma fonte tem medida; baixa = conflito ou nenhuma medida. A do peso
    conta junto (peso é obrigatório no ML): a geral é a menor das duas.
    """
    com_tamanho = [f for f in fontes if Dimensoes.de_dict(f.get("dims")).completas()]
    com_peso = [f for f in fontes if Dimensoes.de_dict(f.get("dims")).peso]

    g_tam = _grupos(com_tamanho, lambda a, b: mesmo_tamanho(Dimensoes.de_dict(a["dims"]), Dimensoes.de_dict(b["dims"])))
    g_peso = _grupos(com_peso, lambda a, b: mesmo_peso(Dimensoes.de_dict(a["dims"]).peso, Dimensoes.de_dict(b["dims"]).peso))

    sugestao = Dimensoes()
    if g_tam:
        sugestao = normalizada(Dimensoes(*Dimensoes.de_dict(g_tam[0][0]["dims"]).lados))
    else:  # sem nenhuma fonte completa: o que houver de mais completo, para adiantar a revisão
        parciais = sorted(
            (f for f in fontes if not Dimensoes.de_dict(f.get("dims")).vazias()),
            key=lambda f: (Dimensoes.de_dict(f["dims"]).faltando().__len__(), PRIORIDADE_FONTE.get(f["fonte"], 9)),
        )
        if parciais:
            sugestao = Dimensoes(*Dimensoes.de_dict(parciais[0]["dims"]).lados)
    if g_peso:
        sugestao.peso = Dimensoes.de_dict(g_peso[0][0]["dims"]).peso

    conf_tam = _nivel(len(g_tam[0]) if g_tam else 0, len(com_tamanho))
    conf_peso = _nivel(len(g_peso[0]) if g_peso else 0, len(com_peso))
    geral = min(conf_tam, conf_peso, key=lambda c: ORDEM_CONFIABILIDADE[c])
    return {
        "sugestao": sugestao.para_dict(),
        "confiabilidade": geral,
        "confiabilidade_tamanho": conf_tam,
        "confiabilidade_peso": conf_peso,
        "fontes_concordantes": [f["fonte"] + "|" + f.get("local", "") for f in (g_tam[0] if g_tam else [])],
    }


# ---------------------------------------------------------------------------------------------
# Embalagem padrão e tipo de envio
# ---------------------------------------------------------------------------------------------

def embalagem_para(produto: Dimensoes) -> Optional[Dimensoes]:
    """
    Embalagem padrão do produto: seção fixa (5 x 7 cm) e o menor comprimento padrão (100, 200
    ou 300 cm) que caiba o maior lado. None se o produto não cabe (seção ou comprimento): aí o
    tipo de envio não é decidido sozinho. Peso da embalagem = peso do produto.
    """
    if not produto.completas():
        return None
    menor, meio, maior = sorted(produto.lados)  # type: ignore[type-var]
    secao_a, secao_b = settings.embalagem_secao()
    if menor > secao_a or meio > secao_b:
        return None
    for comprimento in settings.embalagem_comprimentos():
        if maior <= comprimento:
            return Dimensoes(secao_a, secao_b, float(comprimento), produto.peso)
    return None


def envio_indicado(embalagem: Optional[Dimensoes], tags: Iterable[str] = ()) -> Optional[str]:
    """
    'me2' se o ML diz que o anúncio aceita ME2 (tag me2_available) ou se a embalagem cabe nos
    limites de ME2 (ME2_MAX_*); senão 'me1'. None sem embalagem.
    """
    if embalagem is None or not embalagem.completas():
        return None
    if "me2_available" in set(tags or ()):
        return "me2"
    lados = embalagem.lados
    cabe = (
        max(lados) <= settings.ME2_MAX_LADO_CM  # type: ignore[type-var]
        and sum(lados) <= settings.ME2_MAX_SOMA_CM  # type: ignore[arg-type]
    )
    return "me2" if cabe else "me1"


def e_carrinho(titulo: Optional[str]) -> bool:
    """Carrinhos ficam fora da automação e da tela (decisão do e-commerce, 2026-09-29)."""
    texto = "".join(c for c in unicodedata.normalize("NFD", titulo or "") if unicodedata.category(c) != "Mn")
    return re.search(r"\bcarrinho", texto, re.IGNORECASE) is not None
