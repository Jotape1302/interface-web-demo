from pathlib import Path
from typing import Dict, List, Optional, Tuple

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Filiais atendidas: cada uma é uma conta diferente do Mercado Livre (mesmas do antigo
# sincronizador-anuncios-meli em Java).
FILIAIS = ("revesta", "norvia")


class Settings(BaseSettings):
    """Configuração da automação "Fretes a combinar", por variável de ambiente ou .env."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False)

    DATA_DIR: Path = Field(default=Path("./data"), description="Estado da automação (catálogo, pendências, tokens)")
    API_PORT: int = 8001
    # Chave interna exigida no header X-Internal-Key (a mesma do gateway; mín. 32 caracteres).
    AUTOMATIONS_INTERNAL_KEY: Optional[str] = None
    INTERNAL_AUTH_DISABLED: bool = False  # True só em dev local/testes

    # Access token de cada conta do Mercado Livre. A renovação dos tokens NÃO é feita por esta
    # automação: um fluxo externo (a definir) renova e grava o token em DATA_DIR/ml_tokens.json,
    # que tem prioridade. Estas variáveis são só o valor de partida/teste (o token expira em 6 h).
    ML_REVESTA_ACCESS_TOKEN: Optional[str] = None
    ML_NORVIA_ACCESS_TOKEN: Optional[str] = None
    # Contas com Mercado Envios 1 ativo. Sem ele, anúncio que só caberia no ME1 vira pendência.
    ML_CONTAS_COM_ME1: str = "norvia"
    ML_API_URL: str = "https://api.mercadolibre.com"

    # MariaDB (mesmo servidor da automacoes-financeiro). As tabelas do Marketplace
    # (dimensoes_produtos) ficam no banco próprio DB_NAME, não no do financeiro; os tokens do Tiny
    # continuam onde já estão (TINY_TOKENS_DB.api_tokens, renovados fora daqui), lidos na mesma
    # conexão — o usuário do banco precisa de SELECT nessa tabela.
    DB_HOST: Optional[str] = None
    DB_PORT: int = 3306
    DB_USER: Optional[str] = None
    DB_PASSWORD: Optional[str] = None
    DB_NAME: str = "marketplace"
    TINY_TOKENS_DB: str = "financeiro"

    # Contas do Tiny usadas nos anúncios (conta_identificador em api_tokens). As outras empresas
    # não anunciam no marketplace.
    TINY_CONTAS: str = "norvia_campinas,revesta"
    TINY_API_URL: str = "https://api.tiny.com.br/public-api/v3"
    TINY_PAUSA_S: float = 0.6  # limite de requisições do Tiny

    # Padronização de dimensões
    DIMENSOES_HORA_COLETA: int = Field(default=6, description="Hora local da coleta diária das medidas")
    # Só padroniza produtos anunciados no ML (o cadastro do Tiny é lido 1 a 1: todos levaria horas).
    DIMENSOES_SO_ANUNCIADOS: bool = True
    # Embalagem padrão (medida pelo e-commerce): seção fixa 5 x 7 cm e comprimento conforme o
    # produto. Serve só para o tipo de envio (medidas de embalagem no ML).
    EMBALAGEM_SECAO_CM: str = "5,7"
    EMBALAGEM_COMPRIMENTOS_CM: str = "100,200,300"

    # Rotina diária
    FRETES_HORA_DIARIA: int = Field(default=7, description="Hora local da verificação diária")
    FRETES_MINUTOS_CONFERENCIA: int = Field(default=10, description="Espera antes de conferir se a troca de frete ficou")
    # Pausa entre alterações de anúncios (limite de requisições do ML; o Java usava 2s).
    ML_PAUSA_ENTRE_ALTERACOES_S: float = 2.0

    # Limites de tamanho do Mercado Envios 2 usados para indicar o tipo de envio pelas medidas.
    ME2_MAX_LADO_CM: float = 100.0
    ME2_MAX_SOMA_CM: float = 200.0

    def access_token_env(self, filial: str) -> Optional[str]:
        return {"revesta": self.ML_REVESTA_ACCESS_TOKEN, "norvia": self.ML_NORVIA_ACCESS_TOKEN}.get(filial)

    def contas_tiny(self) -> List[str]:
        return [c.strip() for c in self.TINY_CONTAS.split(",") if c.strip()]

    def embalagem_secao(self) -> Tuple[float, float]:
        a, b = (float(x) for x in self.EMBALAGEM_SECAO_CM.split(","))
        return (min(a, b), max(a, b))

    def embalagem_comprimentos(self) -> List[int]:
        return sorted(int(x) for x in self.EMBALAGEM_COMPRIMENTOS_CM.split(",") if x.strip())

    def banco_configurado(self) -> bool:
        return bool(self.DB_HOST and self.DB_USER)

    def rotulo_tiny(self, conta: str) -> str:
        return {"norvia_campinas": "Tiny Norvia Campinas", "revesta": "Tiny Revesta"}.get(conta, f"Tiny {conta}")

    def contas_com_me1(self) -> List[str]:
        return [c.strip().lower() for c in self.ML_CONTAS_COM_ME1.split(",") if c.strip()]

    def rotulos(self) -> Dict[str, str]:
        return {"revesta": "Revesta", "norvia": "Norvia Campinas"}


settings = Settings()
