from pathlib import Path
from typing import Optional, Literal
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Configurações centralizadas da aplicação carregadas de variáveis de ambiente ou arquivo .env.
    """
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False
    )

    # Diretórios de I/O
    INPUT_DIR: Path = Field(default=Path("./input_danfes"), description="Diretório monitorado para novas DANFEs")
    PROCESSED_DIR: Path = Field(default=Path("./processed"), description="Diretório para onde DANFEs processadas com sucesso são movidas")
    FAILED_DIR: Path = Field(default=Path("./failed"), description="Diretório para onde DANFEs com erro são movidas")
    PENDING_REVIEW_DIR: Path = Field(default=Path("./pending_review"), description="Diretório de DANFEs aguardando revisão/categorização humana antes do lançamento no Tiny")
    ARCHIVED_DIR: Path = Field(default=Path("./archived"), description="Diretório de DANFEs arquivadas pelo usuário (não deletadas, só fora da revisão pendente; podem ser restauradas)")
    LOG_DIR: Path = Field(default=Path("./logs"), description="Diretório de arquivos de log")
    DATA_DIR: Path = Field(default=Path("./data"), description="Diretório para dados persistentes e cache de tokens")

    # Modo de Execução e Agendamento
    RUN_MODE: Literal["daemon", "once", "serve"] = Field(
        default="daemon",
        description="Modo de execução: 'serve' para API REST, 'daemon' para monitoramento contínuo, 'once' para varredura única"
    )

    POLL_INTERVAL_SECONDS: int = Field(default=60, description="Intervalo em segundos entre varreduras no modo daemon")

    # Segurança (correções de 2026-10-06)
    MOCK_MODE: bool = Field(
        default=False,
        description="True só em dev local: sem token do Tiny, simula o lançamento. Em produção (False) a nota fica em revisão pendente.",
    )
    AUTOMATIONS_INTERNAL_KEY: Optional[str] = Field(
        default=None, description="Chave interna exigida no header X-Internal-Key (mesma do gateway, mín. 32 caracteres)"
    )
    INTERNAL_AUTH_DISABLED: bool = Field(default=False, description="True desliga a chave interna (só dev local/testes)")
    UPLOAD_MAX_FILE_MB: int = Field(default=20, description="Tamanho máximo de cada arquivo no upload manual de DANFE/XML")
    UPLOAD_MAX_PDF_PAGES: int = Field(default=50, description="Máximo de páginas de um PDF no upload manual")
    UPLOAD_MAX_FILES: int = Field(default=50, description="Máximo de arquivos por lote no upload manual")

    # Configurações do ERP Tiny (Suporta Token estático legado ou OAuth2 com renovação a cada 4h)
    TINY_API_TOKEN: Optional[str] = Field(default=None, description="Token de autenticação estático legado do Tiny")
    TINY_CLIENT_ID: Optional[str] = Field(default=None, description="Client ID do Aplicativo OAuth2 no Tiny ERP")
    TINY_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret do Aplicativo OAuth2 no Tiny ERP")
    TINY_REFRESH_TOKEN: Optional[str] = Field(default=None, description="Refresh Token inicial do Tiny ERP")
    TINY_REDIRECT_URI: str = Field(default="https://localhost", description="Redirect URI configurada no aplicativo do Tiny")
    TINY_TOKEN_URL: str = Field(
        default="https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token",
        description="Endpoint de renovação de Token OAuth2 do Tiny"
    )
    TINY_AUTH_URL: str = Field(
        default="https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth",
        description="Endpoint de autorização OAuth2 do Tiny"
    )
    TINY_TOKEN_CACHE_FILE: Path = Field(
        default=Path("./data/tiny_token_cache.json"),
        description="Arquivo local para armazenamento persistente dos tokens OAuth2"
    )
    TINY_API_URL: str = Field(
        default="https://api.tiny.com.br/api2/conta.pagar.incluir.php",
        description="Endpoint de inclusão de conta a pagar no Tiny"
    )
    TINY_DEFAULT_CATEGORY: str = Field(default="Despesas com Fornecedores", description="Categoria padrão da despesa no Tiny")
    TINY_OCORRENCIA: str = Field(default="U", description="Ocorrência da conta: 'U' (Única), 'P' (Parcelada)")
    TINY_HISTORICO_TEMPLATE: str = Field(
        default="NF-e {numero_nota} - {emitente_nome} (Chave: {chave})",
        description="Template para preenchimento do histórico da conta no Tiny"
    )

    # Configurações do Banco Inter (Banking API v2 para conciliação bancária)
    INTER_BASE_URL: str = Field(
        default="https://cdpj.partners.bancointer.com.br",
        description="Endpoint base da API do Banco Inter PJ",
    )
    INTER_CERTS_DIR: Path = Field(
        default=Path("./data/certs/inter"),
        description="Diretório contendo os certificados mTLS (.crt e .key) do Banco Inter",
    )
    # Credenciais OAuth2 (client_credentials) de cada conta PJ no Inter — segredos, nunca no código
    INTER_FABRILUX_CLIENT_ID: Optional[str] = Field(default=None)
    INTER_FABRILUX_CLIENT_SECRET: Optional[str] = Field(default=None)
    INTER_REVESTA_CLIENT_ID: Optional[str] = Field(default=None)
    INTER_REVESTA_CLIENT_SECRET: Optional[str] = Field(default=None)
    INTER_NORVIA_CAMPINAS_CLIENT_ID: Optional[str] = Field(default=None)
    INTER_NORVIA_CAMPINAS_CLIENT_SECRET: Optional[str] = Field(default=None)
    INTER_NORVIA_CURITIBA_CLIENT_ID: Optional[str] = Field(default=None)
    INTER_NORVIA_CURITIBA_CLIENT_SECRET: Optional[str] = Field(default=None)

    # Configurações do Banco de Dados MariaDB (Centralizador de api_tokens)
    DB_HOST: Optional[str] = Field(default=None, description="Host do MariaDB (ex: localhost, mariadb, 192.168.50.20)")
    DB_PORT: int = Field(default=3306, description="Porta de conexão do MariaDB")
    DB_USER: Optional[str] = Field(default=None, description="Usuário do MariaDB")
    DB_PASSWORD: Optional[str] = Field(default=None, description="Senha do MariaDB")
    DB_NAME: str = Field(default="financeiro", description="Nome do banco de dados")

    # Mapeamento CNPJ -> Identificador da Empresa (pode ser sobrescrito por variável)
    CNPJ_COMPANY_MAP: Optional[str] = Field(
        default=None,
        description="Mapeamento opcional CNPJ:empresa_identificador (JSON ou lista 'CNPJ:empresa,CNPJ:empresa')"
    )

    def get_cnpj_company_map(self) -> dict:
        """Retorna o dicionário de correspondência entre CNPJ e empresa_identificador."""
        mapping = {
            "43820617000166": "fabrilux",
            "36592814000100": "revesta",
            "27184930000107": "norvia_campinas",
            "27184930000280": "norvia_curitiba",
        }

        if self.CNPJ_COMPANY_MAP:
            raw = self.CNPJ_COMPANY_MAP.strip()
            if raw.startswith("{"):
                try:
                    import json
                    parsed = json.loads(raw)
                    for k, v in parsed.items():
                        clean_k = "".join(c for c in str(k) if c.isdigit())
                        if clean_k:
                            mapping[clean_k] = str(v).strip()
                except Exception:
                    pass
            else:
                for pair in raw.split(","):
                    if ":" in pair:
                        k, v = pair.split(":", 1)
                        clean_k = "".join(c for c in k if c.isdigit())
                        if clean_k:
                            mapping[clean_k] = v.strip()
        return mapping


    # Mapeamento Empresa -> Conta de Origem no Tiny ERP v3 (opcional, para sobrescrever a busca automática)
    TINY_CONTA_ORIGEM_MAP: Optional[str] = Field(
        default=None,
        description="Mapeamento opcional empresa_identificador -> ID ou nome da conta financeira de origem no Tiny v3 (ex: 'norvia_curitiba:12345,revesta:67890' ou 'norvia_curitiba:Inter Norvia Curitiba')"
    )

    def get_tiny_conta_origem_map(self) -> dict:
        """Retorna mapeamento configurado de conta de origem por empresa."""
        mapping = {}
        if self.TINY_CONTA_ORIGEM_MAP:
            raw = self.TINY_CONTA_ORIGEM_MAP.strip()
            if raw.startswith("{"):
                try:
                    import json
                    parsed = json.loads(raw)
                    for k, v in parsed.items():
                        mapping[str(k).strip()] = str(v).strip()
                except Exception:
                    pass
            else:
                for pair in raw.split(","):
                    if ":" in pair:
                        k, v = pair.split(":", 1)
                        mapping[k.strip()] = v.strip()
        return mapping

    # Provedor de Consulta de NF-e
    NFE_PROVIDER: Literal["mock", "receita_oficial", "sefaz_a1", "nuvem_fiscal", "plugnotas"] = Field(
        default="sefaz_a1",
        description="Provedor de consulta da NF-e ('receita_oficial', 'sefaz_a1', 'nuvem_fiscal', 'plugnotas', 'mock')"
    )

    # Varredura direta na SEFAZ (substitui a antiga esteira baseada em pasta do Google Drive)
    SEFAZ_SCAN_HOUR: int = Field(
        default=6,
        description="Hora do dia (0-23, horário do servidor) em que a varredura diária contra a SEFAZ (distNSUInt) é disparada automaticamente"
    )

    # Dashboard Financeiro (agregação de contas-pagar/receber/caixa do Tiny ERP v3)
    FINANCIAL_DASHBOARD_SYNC_HOUR: int = Field(
        default=4,
        description="Hora do dia (0-23, horário do servidor) em que a sincronização diária do Dashboard Financeiro é disparada automaticamente"
    )
    FINANCIAL_DASHBOARD_LOOKBACK_MONTHS: int = Field(
        default=13,
        description="Quantidade de meses (incluindo o atual) mantidos no fluxo de caixa mensal do Dashboard Financeiro"
    )
    FINANCIAL_DASHBOARD_SYNC_COOLDOWN_SECONDS: int = Field(
        default=300,
        description="Intervalo mínimo entre sincronizações manuais do Dashboard Financeiro, para não sobrecarregar a API do Tiny"
    )

    # Contas a Pagar (Inter × Tiny - app/contas_pagar_rotina.py)
    CONTAS_PAGAR_ROTINA_HOUR: int = Field(
        default=7,
        description="Hora do dia (0-23, horário do servidor) da conferência diária de contas a pagar (Inter × Tiny)"
    )
    CONTAS_PAGAR_ROTINA_DIAS: int = Field(
        default=60,
        description="Janela de dias para trás consultada na conferência diária de contas a pagar (padrão: 60 dias)"
    )

    # Conciliação Mercado Livre × Contas a Receber Tiny (app/ml_reconciliation*.py)
    ML_RECONCILIATION_HOUR: int = Field(
        default=8,
        description="Hora do dia (0-23, horário do servidor) da conciliação diária do Mercado Livre (liberações do dia anterior)"
    )
    ML_RECONCILIATION_VENDAS_DIAS: int = Field(
        default=60,
        description="Quantos dias antes do início do período buscar pedidos do Mercado Livre (o dinheiro é liberado semanas depois da venda)"
    )
    ML_RECONCILIATION_RELATORIO_TIMEOUT_SECONDS: int = Field(
        default=900,
        description="Espera máxima pela geração do relatório de liberações do Mercado Pago (é assíncrono)"
    )
    ML_RECONCILIATION_MAX_ANALISES: int = Field(
        default=180,
        description="Quantidade de análises guardadas em DATA_DIR/conciliacao_ml/analises (as mais antigas saem)"
    )
    MP_API_URL: str = Field(default="https://api.mercadopago.com", description="API do Mercado Pago")
    ML_API_URL: str = Field(default="https://api.mercadolibre.com", description="API do Mercado Livre")
    # Credenciais OAuth do Mercado Pago (Client ID e Client Secret por conta)
    # Permite renovação automática de access token via POST /oauth/token.
    MP_NORVIA_CAMPINAS_CLIENT_ID: Optional[str] = Field(default=None, description="Client ID do Mercado Pago (Norvia Campinas)")
    MP_NORVIA_CAMPINAS_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret do Mercado Pago (Norvia Campinas)")
    MP_REVESTA_CLIENT_ID: Optional[str] = Field(default=None, description="Client ID do Mercado Pago (Revesta)")
    MP_REVESTA_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret do Mercado Pago (Revesta)")

    # Access token de PRODUÇÃO do Mercado Pago de cada conta (painel Developers > Suas integrações >
    # Credenciais de produção). Não expira. Sem ele ou client_id/secret, usa o token do Mercado Livre da mesma conta.
    MP_NORVIA_CAMPINAS_ACCESS_TOKEN: Optional[str] = Field(default=None)
    MP_REVESTA_ACCESS_TOKEN: Optional[str] = Field(default=None)
    # Tokens do Mercado Livre sincronizados via TMS. O arquivo de outra automação
    # é montado somente como leitura se configurado; o financeiro grava em seu próprio DATA_DIR.
    ML_TOKENS_FILE: Optional[Path] = Field(default=Path("data/ml_tokens.json"), description="ml_tokens.json configurado para leitura/escrita própria")
    ML_NORVIA_ACCESS_TOKEN: Optional[str] = Field(default=None)
    ML_REVESTA_ACCESS_TOKEN: Optional[str] = Field(default=None)

    # Plataforma Interna TMS (login e extração de tokens ML atualizados)
    TMS_BASE_URL: str = Field(default="https://servidor.norvia.example/tms_api", description="URL base da API do TMS")
    TMS_USER: Optional[str] = Field(default=None, description="Usuário/nome de login no TMS")
    TMS_PASSWORD: Optional[str] = Field(default=None, description="Senha de login no TMS")

    # Renovação OAuth própria (SA-07): desligada por padrão, ligada só por flag explícita
    ML_OAUTH_RENOVACAO_PROPRIA: bool = Field(
        default=False,
        description="Habilita renovação OAuth própria do ML via POST /oauth/token (padrão False, TMS é a fonte primária)"
    )

    # Credenciais diretas de aplicativo OAuth do Mercado Livre (opcionais, quando ML_OAUTH_RENOVACAO_PROPRIA=True)
    ML_CLIENT_ID: Optional[str] = Field(default=None, description="App ID / Client ID do Mercado Livre")
    ML_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret do Mercado Livre")
    ML_NORVIA_CLIENT_ID: Optional[str] = Field(default=None, description="Client ID do Mercado Livre (Campinas)")
    ML_NORVIA_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret do Mercado Livre (Campinas)")
    ML_REVESTA_CLIENT_ID: Optional[str] = Field(default=None, description="Client ID do Mercado Livre (Revesta)")
    ML_REVESTA_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret do Mercado Livre (Revesta)")


    # IDs fixos no Tiny (opcionais): sem eles, a conta financeira e a categoria do recebimento são
    # localizadas pelo nome via API (ver EMPRESAS_ML em app/ml_reconciliation.py).
    ML_REVESTA_CONTA_DESTINO_ID: Optional[int] = Field(default=None)
    ML_REVESTA_CATEGORIA_RECEBIMENTO_ID: Optional[int] = Field(default=None)
    ML_REVESTA_CATEGORIA_FRETE_ID: Optional[int] = Field(default=None)
    ML_CATEGORIA_FRETE_ID: Optional[int] = Field(default=None)

    # API Oficial da Receita Federal (SERPRO / Gateway gov.br)
    RECEITA_CONSUMER_KEY: Optional[str] = Field(default=None, description="Consumer Key da API Serpro/Receita Federal")
    RECEITA_CONSUMER_SECRET: Optional[str] = Field(default=None, description="Consumer Secret da API Serpro/Receita Federal")
    RECEITA_API_TOKEN: Optional[str] = Field(default=None, description="Token de acesso direto (Bearer) da API da Receita Federal")
    RECEITA_AUTH_URL: str = Field(
        default="https://gateway.apiserpro.serpro.gov.br/token",
        description="Endpoint de autenticação OAuth2 do Serpro"
    )
    RECEITA_API_URL: str = Field(
        default="https://gateway.apiserpro.serpro.gov.br/consulta-nfe-df/v1",
        description="Endpoint de consulta de NF-e da Receita Federal"
    )

    # SEFAZ Direta com Certificado Digital A1 (Suporte a múltiplos CNPJs e senhas distintas)
    SEFAZ_CERTS_DIR: Optional[Path] = Field(default=None, description="Diretório com múltiplos certificados A1 (.pfx/.p12)")
    SEFAZ_PASSWORDS: Optional[str] = Field(
        default=None,
        description="Senhas distintas: lista separada por vírgulas ('senha1, senha2'), pares 'arquivo:senha' ou JSON {'CNPJ': 'senha'}"
    )
    SEFAZ_CERT_PASSWORD: Optional[str] = Field(default=None, description="Senha padrão/fallback caso os certificados compartilhem a mesma senha")
    SEFAZ_CERT_PATH: Optional[Path] = Field(default=None, description="Caminho para o certificado A1 (.pfx ou .p12) em caso de CNPJ único")
    SEFAZ_CNPJ: Optional[str] = Field(default=None, description="CNPJ consultante cadastrado na SEFAZ (opcional se auto-detectado)")
    SEFAZ_UF: str = Field(default="SP", description="Sigla da UF padrão de fallback da empresa")
    SEFAZ_AMBIENTE: Literal["1", "2"] = Field(default="1", description="Ambiente SEFAZ: '1' para Produção, '2' para Homologação")

    # Nuvem Fiscal (https://dev.nuvemfiscal.com.br/)
    NUVEM_FISCAL_CLIENT_ID: Optional[str] = Field(default=None, description="Client ID da aplicação na Nuvem Fiscal")
    NUVEM_FISCAL_CLIENT_SECRET: Optional[str] = Field(default=None, description="Client Secret da aplicação na Nuvem Fiscal")
    NUVEM_FISCAL_AUTH_URL: str = Field(default="https://auth.nuvemfiscal.com.br/oauth/token", description="URL de autenticação OAuth2")
    NUVEM_FISCAL_API_URL: str = Field(default="https://api.nuvemfiscal.com.br/v2", description="URL base da API da Nuvem Fiscal")

    # PlugNotas (https://plugnotas.com.br/)
    PLUGNOTAS_API_KEY: Optional[str] = Field(default=None, description="Chave de API do PlugNotas")
    PLUGNOTAS_API_URL: str = Field(default="https://api.plugnotas.com.br", description="URL base da API do PlugNotas")

    # Scanner / OCR
    OCR_ENABLED: bool = Field(default=True, description="Se True, usa OCR Tesseract como fallback quando código de barras falhar")
    TESSERACT_LANG: str = Field(default="por+eng", description="Idiomas do Tesseract OCR")
    TESSERACT_CMD: Optional[str] = Field(default=None, description="Caminho do executável do Tesseract, se não estiver no PATH")
    POPPLER_PATH: Optional[str] = Field(default=None, description="Caminho dos utilitários do Poppler (pdftoppm), se necessário")
    PDF_DPI: int = Field(default=300, description="DPI utilizado na conversão de PDF para imagem")

    # Logging
    LOG_LEVEL: str = Field(default="INFO", description="Nível de log (DEBUG, INFO, WARNING, ERROR)")
    LOG_TO_FILE: bool = Field(default=True, description="Se True, grava logs em arquivo além do console")

    def ensure_directories(self) -> None:
        """Garante que todos os diretórios de trabalho existam no sistema de arquivos."""
        for directory in (self.INPUT_DIR, self.PROCESSED_DIR, self.FAILED_DIR, self.PENDING_REVIEW_DIR, self.ARCHIVED_DIR, self.LOG_DIR, self.DATA_DIR, self.INTER_CERTS_DIR):
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass


# Instância global de configuração
settings = Settings()
