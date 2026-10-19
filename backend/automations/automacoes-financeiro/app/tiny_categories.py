"""
Catálogo estrito das categorias financeiras oficiais do Tiny ERP.

Lista fechada, extraída diretamente do cadastro do Tiny ERP. A automação NUNCA cria
nem altera categorias — apenas escolhe entre as opções abaixo. Qualquer alteração
neste arquivo deve refletir uma mudança real no cadastro do Tiny, feita manualmente
por um operador no ERP.

`suggest_category_id` é uma heurística de palavras-chave (best-effort) usada apenas
para PRÉ-selecionar uma sugestão de categoria por item na tela de revisão humana —
o usuário sempre pode trocar antes de confirmar o lançamento.
"""
import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass(frozen=True)
class TinyCategory:
    id: str
    nome: str
    grupo: str

    @property
    def label(self) -> str:
        return f"{self.grupo} → {self.nome}"


TINY_CATEGORIES: List[TinyCategory] = [
    TinyCategory("484450322", "Vendas Loja", "1.Receitas"),
    TinyCategory("484450325", "Vendas Online", "1.Receitas"),
    TinyCategory("484455059", "Devolução de mercadorias", "2.Deduções"),
    TinyCategory("484436608", "Impostos", "2.Deduções"),
    TinyCategory("480897321", "Compras", "3.Custos"),
    TinyCategory("704231448", "Frete sobre Compras", "3.Custos"),
    TinyCategory("699668830", "Imposto sobre compras", "3.Custos"),
    TinyCategory("484436724", "Mão de Obra", "3.Custos"),
    TinyCategory("484437474", "Água", "4.Despesas Operacionais"),
    TinyCategory("484437462", "Alarme", "4.Despesas Operacionais"),
    TinyCategory("484437781", "Alimentação", "4.Despesas Operacionais"),
    TinyCategory("484437383", "Aluguel", "4.Despesas Operacionais"),
    TinyCategory("708209672", "Aquisição de Equipamentos", "4.Despesas Operacionais"),
    TinyCategory("817609369", "Aquisição de Móveis", "4.Despesas Operacionais"),
    TinyCategory("484437351", "Assistência Médica", "4.Despesas Operacionais"),
    TinyCategory("484437371", "Bonificação", "4.Despesas Operacionais"),
    TinyCategory("817652456", "Bonificação a Clientes", "4.Despesas Operacionais"),
    TinyCategory("484437787", "Combustível", "4.Despesas Operacionais"),
    TinyCategory("484441546", "Comissões", "4.Despesas Operacionais"),
    TinyCategory("786246967", "Décimo Terceiro Salário", "4.Despesas Operacionais"),
    TinyCategory("484437785", "Despesa de Viagem", "4.Despesas Operacionais"),
    TinyCategory("484437550", "Despesas com Cartório", "4.Despesas Operacionais"),
    TinyCategory("748023205", "Despesas com Colaboradores", "4.Despesas Operacionais"),
    TinyCategory("704231667", "Despesas com Veículos", "4.Despesas Operacionais"),
    TinyCategory("757803841", "Despesas com Vendas", "4.Despesas Operacionais"),
    TinyCategory("817647741", "Despesas de consumo presencial", "4.Despesas Operacionais"),
    TinyCategory("484437478", "Energia Elétrica", "4.Despesas Operacionais"),
    TinyCategory("484437262", "FGTS", "4.Despesas Operacionais"),
    TinyCategory("484436871", "Fretes sobre Vendas", "4.Despesas Operacionais"),
    TinyCategory("823964949", "Honorários Advogados", "4.Despesas Operacionais"),
    TinyCategory("484445603", "Honorários Contábeis", "4.Despesas Operacionais"),
    TinyCategory("484437265", "INSS", "4.Despesas Operacionais"),
    TinyCategory("484437208", "Intermediação de Negócios", "4.Despesas Operacionais"),
    TinyCategory("817609805", "Internet", "4.Despesas Operacionais"),
    TinyCategory("758393197", "Investimentos em Produtos", "4.Despesas Operacionais"),
    TinyCategory("792569384", "IRRF - Imposto de Renda Retido na Fonte", "4.Despesas Operacionais"),
    TinyCategory("484437677", "Manutenção de Equipamentos", "4.Despesas Operacionais"),
    TinyCategory("484437680", "Manutenção Predial", "4.Despesas Operacionais"),
    TinyCategory("701885961", "Materiais de Limpeza", "4.Despesas Operacionais"),
    TinyCategory("484437483", "Material de Escritório", "4.Despesas Operacionais"),
    TinyCategory("484437458", "Material de Expediente", "4.Despesas Operacionais"),
    TinyCategory("484437538", "Material Gráfico", "4.Despesas Operacionais"),
    TinyCategory("776676389", "Mensalidade Marketplace", "4.Despesas Operacionais"),
    TinyCategory("484437789", "Outras Despesas", "4.Despesas Operacionais"),
    TinyCategory("782436689", "Pró-labore", "4.Despesas Operacionais"),
    TinyCategory("484437541", "Propaganda/ Publicidade", "4.Despesas Operacionais"),
    TinyCategory("483351497", "Salários", "4.Despesas Operacionais"),
    TinyCategory("488380104", "Software", "4.Despesas Operacionais"),
    TinyCategory("484437642", "Telefones", "4.Despesas Operacionais"),
    TinyCategory("484437367", "Vale Transporte", "4.Despesas Operacionais"),
    TinyCategory("484437467", "Vigilância", "4.Despesas Operacionais"),
    TinyCategory("484438533", "Receita de Aplicações", "5.Receitas Financeiras"),
    TinyCategory("484445631", "Juros de Mora", "6.Despesas Financeiras"),
    TinyCategory("577873092", "Juros Financeiros", "6.Despesas Financeiras"),
    TinyCategory("484438614", "Tarifas Bancárias", "6.Despesas Financeiras"),
    TinyCategory("484445654", "Tarifas de Cartões", "6.Despesas Financeiras"),
    TinyCategory("820789020", "Bonificação de Gastos de Publicidade", "7. Outras Receitas/ Despesas"),
    TinyCategory("484438544", "Outras Receitas", "7. Outras Receitas/ Despesas"),
    TinyCategory("776135800", "Propriedade Intelectual", "7. Outras Receitas/ Despesas"),
    TinyCategory("489820971", "Receita de Fretes", "7. Outras Receitas/ Despesas"),
    TinyCategory("820789732", "Receita Sobre Reclamações", "7. Outras Receitas/ Despesas"),
    TinyCategory("820789086", "Reembolso de Intermediação de Negócios", "7. Outras Receitas/ Despesas"),
    TinyCategory("822889803", "Reembolso sobre Compras de Materiais de Expediente", "7. Outras Receitas/ Despesas"),
    TinyCategory("768364351", "Retirada de Lucro", "7. Outras Receitas/ Despesas"),
    TinyCategory("802301773", "Seguro", "7. Outras Receitas/ Despesas"),
    TinyCategory("495807871", "Empréstimos", "9. Outros"),
    TinyCategory("484441565", "Imobilizado", "9. Outros"),
    TinyCategory("549107726", "Pedidos Cancelados", "9. Outros"),
    TinyCategory("817648084", "Transferência de entrada entre empresas", "9. Outros"),
    TinyCategory("817647361", "Transferência de saída entre empresas", "9. Outros"),
]

CATEGORY_BY_ID: Dict[str, TinyCategory] = {c.id: c for c in TINY_CATEGORIES}

DEFAULT_CATEGORY_ID = "480897321"  # Compras


def _normalize(text: str) -> str:
    """Minúsculas e sem acento, para comparação de palavras-chave resiliente a OCR."""
    nfkd = unicodedata.normalize("NFKD", text or "")
    ascii_clean = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", ascii_clean.lower()).strip()


# Palavras-chave adicionais por categoria (além do próprio nome, que já entra
# automaticamente na correspondência). Cobertura best-effort dos casos mais comuns
# de despesas operacionais de loja/escritório — não é uma classificação fiscal
# por NCM, é um ponto de partida para o usuário revisar e corrigir.
_EXTRA_KEYWORDS: Dict[str, List[str]] = {
    "701885961": ["limpeza", "detergente", "sabao", "desinfetante", "alvejante", "esponja", "vassoura", "rodo", "sanitaria", "sanitario"],
    "484437483": ["escritorio", "caneta", "papel a4", "toner", "cartucho", "grampeador", "grampo", "pasta", "envelope", "post it", "clips"],
    "484437458": ["expediente", "papelaria"],
    "484437787": ["combustivel", "gasolina", "etanol", "diesel", "posto"],
    "484437474": ["agua mineral", "galao de agua", "sabesp", "saneamento"],
    "484437478": ["energia", "eletrica", "cpfl", "enel", "luz"],
    "817609805": ["internet", "banda larga", "provedor", "wifi", "wi-fi"],
    "484437642": ["telefone", "celular", "telefonia", "claro", "vivo", "tim", "oi"],
    "484437781": ["alimentacao", "lanche", "restaurante", "almoco", "marmita", "padaria", "cafe", "refeicao"],
    "484437677": ["manutencao de equipamento", "conserto", "peca", "reparo"],
    "484437680": ["manutencao predial", "pintura", "eletricista", "encanador", "reforma"],
    "704231667": ["veiculo", "pneu", "oleo", "revisao do carro", "estacionamento", "pedagio"],
    "484437538": ["grafica", "impressao", "banner", "panfleto", "cartao de visita"],
    "484437541": ["publicidade", "propaganda", "marketing", "anuncio", "midia"],
    "488380104": ["software", "assinatura", "licenca", "saas", "sistema"],
    "484437467": ["vigilancia", "seguranca patrimonial", "monitoramento"],
    "484437462": ["alarme"],
    "484437351": ["plano de saude", "assistencia medica", "medico"],
    "484437367": ["vale transporte", "passagem", "onibus", "metro"],
    "704231448": ["frete sobre compras", "transportadora"],
    "802301773": ["seguro"],
}


def suggest_category_id(descricao: str, ncm: Optional[str] = None) -> str:
    """
    Sugere uma categoria oficial para um item com base em correspondência de
    palavras-chave na descrição. Não usa NCM hoje (não há tabela NCM->categoria
    definida) — o parâmetro existe para permitir essa extensão futura sem
    quebrar a assinatura da função.
    Retorna DEFAULT_CATEGORY_ID quando nenhuma regra corresponde.
    """
    desc_norm = _normalize(descricao)
    if not desc_norm:
        return DEFAULT_CATEGORY_ID

    best_match: Optional[str] = None
    best_len = 0

    for category in TINY_CATEGORIES:
        keywords = [_normalize(category.nome)] + [_normalize(k) for k in _EXTRA_KEYWORDS.get(category.id, [])]
        for kw in keywords:
            if kw and kw in desc_norm and len(kw) > best_len:
                best_match = category.id
                best_len = len(kw)

    return best_match or DEFAULT_CATEGORY_ID
