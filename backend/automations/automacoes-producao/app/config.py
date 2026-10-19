"""Configurações do servidor de impressão da Produção (lidas do .env ao lado do iniciar.bat)."""
import sys
from typing import Literal, Optional

from pydantic import Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 0.0.0.0: o tablet pode chamar direto pela rede local (http://IP-DO-PC:8003). Se só o
    # Cloudflare Tunnel for usado (cloudflared → localhost:8003), prefira HOST=127.0.0.1 no .env.
    HOST: str = "0.0.0.0"
    PORT: int = 8003

    # Nome da impressora no Windows (Painel de Controle → Impressoras). Vazio: procura uma Elgin/L42/Zebra.
    IMPRESSORA: Optional[str] = None
    # Linux: dispositivo USB direto, usado quando não há spooler do Windows.
    DISPOSITIVO_USB: str = "/dev/usb/lp0"

    # Linguagem da impressora. A Elgin L42-DT vem em PPLB/EPL ("epl"): recebe ZPL mas imprime em
    # branco. Se trocar por uma Zebra ou ativar o modo PPLZ na Elgin, use "zpl".
    LINGUAGEM: Literal["epl", "zpl"] = "epl"
    # Só EPL: escuridão da impressão (0 a 15, comando D) e espaço entre etiquetas em pontos (comando Q).
    DENSIDADE: int = Field(default=10, ge=0, le=15)
    GAP_DOTS: int = Field(default=24, ge=0, le=240)

    # Etiqueta da Produção: Elgin L42-DT, 203 dpi, 60 x 40 mm.
    DPI: int = 203
    LARGURA_MM: float = 60.0
    ALTURA_MM: float = 40.0
    # Se a impressora trocar os acentos por símbolos estranhos, ligue para imprimir sem acento.
    REMOVER_ACENTOS: bool = False

    # Obrigatória: toda requisição precisa do header X-Api-Key (ou Authorization: Bearer) com este valor.
    # Definida por quem instala; vazia ou com menos de TAMANHO_MINIMO_CHAVE caracteres, o servidor não sobe.
    CHAVE_API: Optional[str] = None

    # Swagger em /docs. Desligado porque o serviço fica exposto na internet pelo Cloudflare.
    DOCS: bool = False

    # Só gera o ZPL e mostra no terminal, sem mandar para a impressora (testes).
    SIMULACAO: bool = False

    # Limites por cliente (IP; pelo Cloudflare, o IP real do CF-Connecting-IP), janela de 1 minuto.
    # Cada pedido continua aceitando de 1 a 1000 cópias; o teto de cópias por minuto deve ser >= 1000.
    LIMITE_REQUISICOES_MINUTO: int = 30
    LIMITE_COPIAS_MINUTO: int = 2000

    # Origens liberadas no CORS (separadas por vírgula), ex.: https://op.norvia.example.
    # Vazio = "*" (qualquer origem): seguro só porque toda rota exige a CHAVE_API e não há cookies.
    CORS_ORIGINS: str = ""

    @field_validator("LINGUAGEM", mode="before")
    @classmethod
    def _linguagem_minuscula(cls, valor: object) -> object:
        return valor.strip().lower() if isinstance(valor, str) else valor

    def origens_cors(self) -> list:
        origens = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        return origens or ["*"]


TAMANHO_MINIMO_CHAVE = 32

def _carregar() -> Settings:
    """Lê o .env; valor inválido (ex.: LINGUAGEM=pdf, DENSIDADE=20) para o servidor com mensagem clara."""
    try:
        return Settings()
    except ValidationError as e:
        erros = "; ".join(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors())
        sys.exit(f"[ERRO] Configuração inválida no .env — {erros}")


settings = _carregar()
