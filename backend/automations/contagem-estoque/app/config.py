"""
Configuração centralizada da contagem de estoque (variáveis de ambiente ou .env).

Os parâmetros do detector ficam separados do bot para que a CLI e a calibração
funcionem sem token do Telegram. Nenhum valor numérico do detector deve ficar
espalhado pelo código: tudo que influencia a detecção está aqui.
"""
from pathlib import Path
from typing import FrozenSet, Optional

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False)


class DetectorSettings(BaseSettings):
    """
    Parâmetros da detecção dos marcadores (prendedores verdes). NÃO estão
    calibrados: os valores iniciais partem do verde-amarelado dos prendedores
    (H ≈ 43–54 numa foto de referência) com folga, e devem ser ajustados com fotos
    reais do estoque (ver README, seção Calibração).
    """

    model_config = _ENV

    # Faixa de cor em HSV na escala do OpenCV: H 0–179, S 0–255, V 0–255.
    # Amarelo fica por volta de H 20–34, verde-amarelado 35–55, verde puro ~60 e
    # verde-azulado a partir de ~75.
    # 32 (era 35): sob luz mais quente/amarelada o verde dos prendedores desce para H ~34 e
    # sumia (teste de 2026-10-07: 15/18 -> 18/18 acertos). Abaixo de ~28 entram tons amarelados.
    MARKER_HUE_MIN: int = Field(default=32, ge=0, le=179)
    MARKER_HUE_MAX: int = Field(default=65, ge=0, le=179)
    MARKER_SATURATION_MIN: int = Field(default=70, ge=0, le=255)
    MARKER_SATURATION_MAX: int = Field(default=255, ge=0, le=255)
    MARKER_VALUE_MIN: int = Field(default=40, ge=0, le=255)
    MARKER_VALUE_MAX: int = Field(default=255, ge=0, le=255)

    # Prendedor ROSA CHOQUE = fardo de 10 unidades (verde = 5; padronização de 2026-10-15). Só a
    # faixa de cor muda; forma, área e agrupamento são os mesmos do verde. NÃO calibrado: faixa
    # estimada para rosa choque (H ~145–175 no OpenCV; o roxo fica abaixo de 145 e o laranja do
    # papelão abaixo de 25), sem foto real ainda — ajuste com fotos dos prendedores rosa.
    ROSA_HUE_MIN: int = Field(default=145, ge=0, le=179)
    ROSA_HUE_MAX: int = Field(default=175, ge=0, le=179)
    ROSA_SATURATION_MIN: int = Field(default=90, ge=0, le=255)
    ROSA_VALUE_MIN: int = Field(default=70, ge=0, le=255)

    # Resolução de processamento: imagens mais largas são reduzidas (mantendo a
    # proporção); menores não são ampliadas.
    MAX_PROCESSING_WIDTH: int = Field(default=1600, ge=320)

    # Morfologia (tamanho do kernel elíptico, em pixels, ímpar):
    # OPEN remove pontinhos de ruído; CLOSE preenche falhas dentro do marcador.
    MORPH_KERNEL_SIZE: int = Field(default=5, ge=1)
    MORPH_CLOSE_KERNEL_SIZE: int = Field(default=9, ge=1)

    # Filtros geométricos. Áreas em pixels, medidas numa imagem com largura
    # MAX_PROCESSING_WIDTH; para imagens menores são reduzidas na mesma proporção.
    MIN_MARKER_AREA: float = Field(default=150, ge=0)
    MAX_MARKER_AREA: float = Field(default=40000, gt=0)
    # Prendedor atrás do plástico do pacote: só um pedaço do verde entra na máscara e a
    # região fica bem menor que as outras da mesma foto. Por isso a área mínima também é
    # relativa: com a área típica da foto conhecida, vale o MENOR entre MIN_MARKER_AREA e
    # MIN_MARKER_AREA_RATIO x área típica — mas nunca abaixo de MARKER_NOISE_AREA (ruído).
    MIN_MARKER_AREA_RATIO: float = Field(default=0.2, ge=0, le=1)
    MARKER_NOISE_AREA: float = Field(default=40, ge=0)
    # Proporção lado maior / lado menor do retângulo mínimo (independe da rotação; ≥ 1).
    # O prendedor é alongado (~4–6 visto de lado); a folga cobre fotos em ângulo.
    MIN_ASPECT_RATIO: float = Field(default=1.0, ge=1.0)
    MAX_ASPECT_RATIO: float = Field(default=7.0, ge=1.0)

    # Regiões da cor do marcador separadas por até esta distância entre as bordas
    # são tratadas como o mesmo marcador — evita contar duas vezes um prendedor que
    # a máscara partiu em pedaços (sombra, reflexo, listras). A distância usada é a
    # maior entre:
    #   MERGE_DISTANCE        px fixos, na largura de processamento;
    #   MERGE_DISTANCE_RATIO  fração do tamanho típico (diâmetro equivalente mediano)
    #                         dos marcadores daquela foto — acompanha fotos de perto
    #                         e de longe.
    # Mantenha abaixo do espaço entre prendedores de pacotes vizinhos.
    MERGE_DISTANCE: float = Field(default=10, ge=0)
    MERGE_DISTANCE_RATIO: float = Field(default=0.25, ge=0)

    # Região com pelo menos esta fração da área típica é um marcador INTEIRO, não um pedaço:
    # dois marcadores inteiros nunca são unidos (prendedores de pacotes vizinhos encostados),
    # e uma região que o fechamento morfológico (MORPH_CLOSE) formou juntando dois ou mais
    # marcadores inteiros é separada de novo.
    WHOLE_MARKER_AREA_RATIO: float = Field(default=0.6, gt=0, le=1)

    # Marcador contado com área abaixo desta fração da típica sai em amarelo na imagem, para o
    # operador conferir: costuma ser prendedor parcialmente coberto ou de outra prateleira ao fundo.
    ALERTA_AREA_RATIO: float = Field(default=0.5, gt=0, le=1)

    # Ordenação: marcadores cuja diferença vertical é menor que esta fração da
    # altura típica de um marcador ficam na mesma linha (numerados da esquerda
    # para a direita).
    ROW_TOLERANCE_RATIO: float = Field(default=0.8, gt=0)

    @model_validator(mode="after")
    def _ranges_are_ordered(self) -> "DetectorSettings":
        pairs = [
            ("MARKER_HUE", self.MARKER_HUE_MIN, self.MARKER_HUE_MAX),
            ("MARKER_SATURATION", self.MARKER_SATURATION_MIN, self.MARKER_SATURATION_MAX),
            ("MARKER_VALUE", self.MARKER_VALUE_MIN, self.MARKER_VALUE_MAX),
            ("ROSA_HUE", self.ROSA_HUE_MIN, self.ROSA_HUE_MAX),
            ("MARKER_AREA", self.MIN_MARKER_AREA, self.MAX_MARKER_AREA),
            ("ASPECT_RATIO", self.MIN_ASPECT_RATIO, self.MAX_ASPECT_RATIO),
        ]
        for name, low, high in pairs:
            if low > high:
                raise ValueError(f"{name}: mínimo ({low}) maior que o máximo ({high})")
        return self


def _ids(lista: str) -> FrozenSet[int]:
    """'123, -100456' → {123, -100456}. Item que não é número é ignorado."""
    ids = set()
    for parte in (lista or "").replace(";", ",").split(","):
        parte = parte.strip()
        if parte.lstrip("-").isdigit():
            ids.add(int(parte))
    return frozenset(ids)


class BotSettings(BaseSettings):
    model_config = _ENV

    TELEGRAM_STOCK_BOT_TOKEN: Optional[SecretStr] = Field(default=None)
    # Quem pode usar o bot: IDs numéricos do Telegram separados por vírgula. O bot responde se o
    # usuário OU o chat (grupo) estiver na lista. As duas vazias = qualquer um (comportamento
    # antigo, com aviso no log) — preencha para fechar o bot.
    TELEGRAM_ALLOWED_USERS: str = Field(default="")
    TELEGRAM_ALLOWED_CHATS: str = Field(default="")
    # true: mantém a foto recebida e a processada em TEMP_DIR para investigar a calibração.
    STOCK_COUNTER_DEBUG: bool = Field(default=False)
    TEMP_DIR: Path = Field(default=Path("./temp"))
    LOG_DIR: Path = Field(default=Path("./logs"))
    LOG_TO_FILE: bool = Field(default=True)
    LOG_LEVEL: str = Field(default="INFO")

    # Limites da foto (CE-3/CE-7). Lado maior abaixo do mínimo: os prendedores ficam pequenos e a
    # contagem erra (teste de 2026-10-07: 768 px errou 2 de 6 fotos; 960 px acertou todas).
    MIN_LADO_FOTO: int = Field(default=960, ge=320)
    # Acima disso a foto é recusada antes de abrir (memória do servidor). 20 MB é o teto do Telegram.
    MAX_ARQUIVO_MB: float = Field(default=20, gt=0)
    MAX_MEGAPIXELS: float = Field(default=40, gt=0)

    # Registro das contagens (código da prateleira, quantidade, confirmação do operador e imagem
    # anotada). Dentro de TEMP_DIR por padrão: no servidor, temp/ já é volume persistente.
    REGISTRO_DIR: Optional[Path] = Field(default=None)
    REGISTRO_RETENCAO_DIAS: int = Field(default=60, ge=1)

    @field_validator("REGISTRO_DIR", mode="before")
    @classmethod
    def _registro_vazio_e_padrao(cls, valor: object) -> object:
        # REGISTRO_DIR= (vazio no .env) seria Path(".") — o registro iria para a pasta atual.
        return None if isinstance(valor, str) and not valor.strip() else valor

    @property
    def registro_dir(self) -> Path:
        return self.REGISTRO_DIR or (self.TEMP_DIR / "registro")

    @property
    def allowed_users(self) -> FrozenSet[int]:
        return _ids(self.TELEGRAM_ALLOWED_USERS)

    @property
    def allowed_chats(self) -> FrozenSet[int]:
        return _ids(self.TELEGRAM_ALLOWED_CHATS)

    @property
    def received_dir(self) -> Path:
        return self.TEMP_DIR / "received"

    @property
    def processed_dir(self) -> Path:
        return self.TEMP_DIR / "processed"


class TinySettings(BaseSettings):
    """
    Integração da contagem com o estoque do Tiny v3 (desde 2026-10-14). A conferência no painel
    chama a API interna deste serviço (gateway → porta API_PORT, com a chave interna), que lança
    no Tiny só a ENTRADA do que falta — nunca tira estoque.
    """

    model_config = _ENV

    API_PORT: int = Field(default=8002, ge=1, le=65535)
    AUTOMATIONS_INTERNAL_KEY: Optional[SecretStr] = Field(default=None)
    INTERNAL_AUTH_DISABLED: bool = Field(default=False)  # True só em dev local/testes

    # Tokens do Tiny: tabela api_tokens (banco do financeiro), renovados fora daqui — o mesmo
    # que a automacoes-marketplace faz. Só leitura.
    DB_HOST: Optional[str] = Field(default=None)
    DB_PORT: int = Field(default=3306)
    DB_USER: Optional[str] = Field(default=None)
    DB_PASSWORD: Optional[SecretStr] = Field(default=None)
    TINY_TOKENS_DB: str = Field(default="financeiro")
    TINY_API_URL: str = Field(default="https://api.tiny.com.br/public-api/v3")
    TINY_PAUSA_S: float = Field(default=0.6, ge=0)

    # A conta do Tiny é FIXA (Revesta, ver app/tiny_estoque.py) e não é configurável.
    # Depósito onde entra a diferença: sem configuração, vale o único depósito considerado no
    # saldo do produto; com mais de um, a contagem não é lançada (não dá para saber qual é).
    CONTAGEM_TINY_DEPOSITO_ID: Optional[int] = Field(default=None)

    @field_validator("CONTAGEM_TINY_DEPOSITO_ID", mode="before")
    @classmethod
    def _deposito_vazio(cls, valor: object) -> object:
        return None if isinstance(valor, str) and not valor.strip() else valor

    def banco_configurado(self) -> bool:
        return bool(self.DB_HOST and self.DB_USER)
