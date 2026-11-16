import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

FUSO_SP = ZoneInfo("America/Sao_Paulo")
BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Configuração da automação de Marketing (RD Station + Kit Instagram) da Norvia."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # data/ e publico/ são volumes do container; o catálogo e referências vêm na imagem.
    DATA_DIR: Path = Field(default=BASE_DIR / "data", description="Rascunhos, histórico e estado (volume)")
    PUBLICO_DIR: Path = Field(default=BASE_DIR / "publico", description="Arquivos públicos servidos pelo NGINX (volume)")
    CATALOGO_PATH: Path = Field(default=BASE_DIR / "catalogo" / "catalogo_produtos_norvia.json")
    API_PORT: int = 8004
    MOCK_MODE: bool = False

    # Chave interna gateway → automação (contrato C1)
    AUTOMATIONS_INTERNAL_KEY: Optional[str] = None
    INTERNAL_AUTH_DISABLED: bool = False  # True só em dev local/testes

    # Camada 1: Triagem e Roteamento FinOps (100% Gratuito)
    GEMINI_API_KEY: Optional[str] = None
    GEMINI_FREE_MODEL: str = "gemini-3.8-flash"
    # Reservas quando o principal responde 500/503 (sobrecarga); conferidos em v1beta/models em 13/11/2026.
    GEMINI_FALLBACK_MODELS: str = "gemini-3.5-flash,gemini-flash-latest"

    GROQ_API_KEY: Optional[str] = None
    GROQ_FREE_MODEL: str = "openai/gpt-oss-120b"

    # Camada 2: Redação Editorial (Opcional Paga)
    ANTHROPIC_API_KEY: Optional[str] = None
    ANTHROPIC_MODEL: str = "claude-sonnet-5-5"
    OPENAI_API_KEY: Optional[str] = None
    OPENAI_MODEL: str = "gpt-4o"

    # Rotina semanal: na sexta, a esta hora (fuso de SP), gera as edições de segunda e quinta.
    GERAR_SEXTA_AUTOMATICO: bool = True
    HORA_GERACAO_SEXTA: int = Field(default=8, ge=0, le=23)

    # RD Station Marketing
    RD_STATION_CLIENT_ID: Optional[str] = None
    RD_STATION_CLIENT_SECRET: Optional[str] = None
    RD_STATION_REFRESH_TOKEN: Optional[str] = None

    # Arch Journal: Links Oficiais e Imagens de Ambiente
    MARKETING_URL_CATALOGO: str = (
        "https://www.canva.com/design/DAG_ErVS6gc/0eOY1pTRuMsk6BI1ZshLPg/view?"
        "utm_content=DAG_ErVS6gc&utm_campaign=designshare&utm_medium=link2&utm_source=uniquelinks&utlId=h1ee67a76ae#1"
    )
    MARKETING_LINK_ATENDIMENTO: str = (
        "https://wa.me/5543991875825?text=Ol%C3%A1%21%20Sou%20especificador%20e%20vim%20pelo%20Arch%20Journal%20da%20Norvia."
    )
    MARKETING_URL_PUBLICA_IMAGENS: str = "https://servidor.norvia.example/marketing-imagens"
    MARKETING_IMAGEM_PROVEDOR: str = "gemini"  # "gemini" ou "openai"
    GEMINI_IMAGE_MODEL: str = "gemini-3.1-flash-image"
    OPENAI_IMAGE_MODEL: str = "gpt-image-1"
    MARKETING_IMAGENS_LIMITE_DIA: int = 20
    TEXTO_FIXO_B2B: str = (
        "Conheça o portfólio completo de rodapés invertidos, perfis de iluminação, "
        "cantoneiras e filetes em alumínio com pintura eletrostática e anodizada "
        "de alta durabilidade para arquitetos e especificadores."
    )

    def ia_gratuita_configurada(self) -> bool:
        return bool(self.GEMINI_API_KEY or self.GROQ_API_KEY)

    def ia_paga_configurada(self) -> bool:
        return bool(self.ANTHROPIC_API_KEY or self.OPENAI_API_KEY)

    def rd_station_configurado(self) -> bool:
        return bool(self.RD_STATION_CLIENT_ID and self.RD_STATION_CLIENT_SECRET)


settings = Settings()
DATA_DIR = settings.DATA_DIR
PUBLICO_DIR = settings.PUBLICO_DIR
PASTA_REFERENCIAS = BASE_DIR / "referencias"
CAMINHO_CATALOGO_JSON = settings.CATALOGO_PATH
CAMINHO_RASCUNHOS_JSON = DATA_DIR / "rascunhos.json"
CAMINHO_EXECUCOES_JSON = DATA_DIR / "execucoes.json"
CAMINHO_ESTADO_JSON = DATA_DIR / "estado.json"
PASTA_AMBIENTES_DATA = DATA_DIR / "ambientes"
CAMINHO_INDICE_AMBIENTES = PASTA_AMBIENTES_DATA / "indice.json"
PASTA_AMBIENTES_PUBLICO = PUBLICO_DIR / "ambientes"
PASTA_MARCA_PUBLICO = PUBLICO_DIR / "marca"


def frases_completas(texto: str, limite: int) -> str:
    """
    Devolve as primeiras frases inteiras (separadas por '.', '!' ou '?') que cabem no limite.
    Nunca corta no meio e nunca devolve texto terminado em '...' ou '…'.
    O trecho que terminava em '...' ou '…' é descartado, não pontuado.
    Colapsa \\n e espaços múltiplos antes de dividir.
    """
    if not texto:
        return ""
    # 1. Colapsar \\n e espaços múltiplos
    t = re.sub(r"\s+", " ", texto).strip()
    # 2. Remover reticências ou pontos soltos no início
    t = re.sub(r"^[.…\s]+", "", t).strip()
    if not t:
        return ""

    partes = re.split(r"(?<=[.!?])\s+", t)
    frases: List[str] = []
    for p in partes:
        p_strip = p.strip()
        # Se termina em reticências (... ou …) ou não termina em pontuação, foi cortada -> descartar!
        if p_strip.endswith("...") or p_strip.endswith("…"):
            continue
        if not re.search(r"[.!?]$", p_strip):
            continue
        p_strip = re.sub(r"^[.…\s]+", "", p_strip).strip()
        if p_strip and re.search(r"[.!?]$", p_strip):
            frases.append(p_strip)

    if not frases:
        return ""

    resultado = ""
    for f in frases:
        candidato = f"{resultado} {f}".strip() if resultado else f
        if len(candidato) <= limite:
            resultado = candidato
        else:
            break
    if not resultado:
        resultado = frases[0]
    return resultado


def _sanitizar_linhas_editoriais(linhas: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    for prod in linhas.values():
        desc = prod.get("descricao") or ""
        prod["descricao_curta"] = frases_completas(desc, 420)
        rc = prod.get("resumo_card") or ""
        if not rc or rc.endswith("...") or rc.endswith("…"):
            prod["resumo_card"] = frases_completas(desc, 220)
        else:
            prod["resumo_card"] = frases_completas(rc, 220)
    return linhas


def carregar_base_conhecimento_norvia() -> Dict[str, Any]:
    """
    Lê a base de conhecimento 100% factual extraída de https://www.norvia.example/
    (213 produtos oficiais + dados institucionais).
    """
    caminho = CAMINHO_CATALOGO_JSON
    if caminho.exists():
        try:
            return json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as e:
            logging.getLogger(__name__).warning("Falha ao carregar catálogo factual Norvia: %s", e)
    return {"total_produtos": 0, "linhas_editoriais": {}, "produtos": [], "empresa": {}}


KB_NORVIA: Dict[str, Any] = carregar_base_conhecimento_norvia()

# Linhas de destaque editorial carregadas do catálogo oficial do site (com fallback seguro)
PRODUTOS_NORVIA: Dict[str, Dict[str, Any]] = _sanitizar_linhas_editoriais(KB_NORVIA.get("linhas_editoriais") or {
    "rodape_invertido": {
        "slug": "rodape_invertido",
        "referencia": "NRVRPI02",
        "sku_principal": "NRVRPI02-1M-02",
        "nome": "Rodapé Invertido Veles em Aluminio com Aba para LED 50mm x 20mm - Norvia",
        "nome_curto": "Rodapé Invertido Veles em Aluminio com Aba para LED 50mm x 20mm",
        "categoria_tag": "RODAPÉ INVERTIDO & ILUMINAÇÃO LED",
        "categoria_oficial": "Rodapés › Rodapés Invertidos",
        "marca": "norvia",
        "preco_a_partir_brl": 30.9,
        "especificacoes_site": "Tamanhos no site: 1m, 2m, 3m | Cores no site: Branco, Chumbo Microtexturizado, Natural Fosco, Off-White Microtexturizado, Preto Microtexturizado, Preto",
        "descricao": "Transforme seus espaços com o Rodapé Invertido Veles Com Aba da Norvia, uma combinação perfeita de design moderno, alta qualidade e funcionalidade. Fabricado em alumínio de alta qualidade. Este rodapé oferece um acabamento sofisticado e duradouro para qualquer ambiente, seja residencial ou comercial.",
        "resumo_card": "Transforme seus espaços com o Rodapé Invertido Veles Com Aba da Norvia, fabricado em alumínio de alta qualidade com aba para iluminação indireta em LED.",
        "imagem_path": "/marketing/produto-rodape-invertido-led.jpg",
        "imagem_cdn_oficial": "https://cdn.vnda.com.br/norvia/2025/10/15/13_18_54_920_ca2a2a89e47f712bd9b963d7ca214bc2.png?v=1764684163",
        "cta_texto": "Ver Rodapés Invertidos no Site Norvia",
        "cta_url": "https://www.norvia.example/rodapes/rodape-invertido",
    },
    "perfil_t": {
        "slug": "perfil_t",
        "referencia": "NRVPTL02",
        "sku_principal": "NRVPTL02-1M-01",
        "nome": "Perfil T 45mm em Alumínio Para Piso Laminado - Norvia",
        "nome_curto": "Perfil T 45mm em Alumínio Para Piso Laminado",
        "categoria_tag": "TRANSIÇÃO DE PISOS NO MESMO NÍVEL",
        "categoria_oficial": "Acabamentos de Piso › Perfis T",
        "marca": "norvia",
        "preco_a_partir_brl": 23.9,
        "especificacoes_site": "Tamanhos no site: 1m, 2m, 3m | Cores no site: Bege, Branco, Champanhe, Fumê, Marrom, Natural Fosco, Preto",
        "descricao": "O perfil T 45mm em alumínio para piso laminado da Norvia é uma solução para realizar o acabamento e a transição entre pisos no mesmo nível, proporcionando uma união discreta e organizada entre os revestimentos. Também conhecido como perfil de dilatação, permite que o piso laminado trabalhe naturalmente.",
        "resumo_card": "Solução em alumínio para realizar o acabamento e a transição entre pisos no mesmo nível, garantindo proteção das bordas e espaço para dilatação.",
        "imagem_path": "/marketing/produto-perfil-t.jpg",
        "imagem_cdn_oficial": "https://cdn.vnda.com.br/norvia/2025/10/17/17_45_28_178_ac57196d33e15cadff2d80611e071a51.png?v=1761934179",
        "cta_texto": "Ver Perfis T de Piso no Site Norvia",
        "cta_url": "https://www.norvia.example/acabamento-de-piso/perfis-t",
    },
    "cantoneira": {
        "slug": "cantoneira",
        "referencia": "NRVCMP04",
        "sku_principal": "NRVCMP04-1M-02",
        "nome": "Cantoneira Alumínio Para Canto Parede 1/1 - 25mm x 25mm - Norvia",
        "nome_curto": "Cantoneira Alumínio Para Canto Parede 25mm x 25mm",
        "categoria_tag": "PROTEÇÃO DE QUINAS & CANTOS DE PAREDE",
        "categoria_oficial": "Cantoneiras › Cantoneira de Parede",
        "marca": "norvia",
        "preco_a_partir_brl": 27.9,
        "especificacoes_site": "Tamanhos no site: 1m, 2m, 3m | Cores no site: Branco, Bronze, Natural Fosco, Preto",
        "descricao": "A cantoneira de alumínio para parede 25mm x 25mm da Norvia é uma solução prática para proteger quinas, disfarçar pequenas irregularidades e proporcionar um acabamento mais uniforme aos cantos das paredes. Fabricada em alumínio resistente e durável.",
        "resumo_card": "Solução em alumínio para proteger quinas, disfarçar pequenas irregularidades e proporcionar acabamento uniforme aos cantos das paredes.",
        "imagem_path": "/marketing/produto-cantoneira.jpg",
        "imagem_cdn_oficial": "https://cdn.vnda.com.br/norvia/2025/10/17/14_48_50_619_1fb40fb8dbecdf31484cf0e2ebbc38fa.jpg?v=1764681150",
        "cta_texto": "Ver Cantoneiras em Alumínio no Site Norvia",
        "cta_url": "https://www.norvia.example/cantoneira/cantoneira-de-parede",
    },
})

FONTES_ARQUITETURA: List[Dict[str, str]] = [
    {
        "id": "archdaily_br",
        "nome": "ArchDaily Brasil",
        "rss_url": "https://www.archdaily.com.br/br/rss",
        "idioma": "pt-BR",
        "foco": "Arquitetura residencial, interiores, iluminação e materiais construtivos",
    },
    {
        "id": "dezeen_interiors",
        "nome": "Dezeen Interiors",
        "rss_url": "https://www.dezeen.com/interiors/feed/",
        "idioma": "en",
        "foco": "Tendências globais de design de interiores, minimalismo e detalhamento",
    },
]
