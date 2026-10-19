# Automações Financeiras & Fiscais — Norvia

Motor backend de automação financeira e fiscal desenvolvido em **Python 3.11+ e FastAPI** (porta `8000`, serviço Docker `automacao-nfe`), responsável por varredura SEFAZ, conciliação bancária Banco Inter × Tiny ERP, conciliação Mercado Livre × Contas a Receber, baixa de contas a pagar e inteligência de dados financeiros.

---

## 🏛️ Pilares da Automação Financeira

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. ESTEIRA FISCAL & NF-e                                                    │
│    - Varredura SEFAZ DFe direta com Certificados Digitais A1 Multi-CNPJ     │
│    - Scanner de contingência: Barcode Code 128 (pyzbar) + OCR (pytesseract) │
│    - Validação de Módulo 11 SEFAZ e Parser XML completo (defusedxml)        │
│    - Revisão Humana (pending_review) com categorização heurística           │
│    - Lançamento automatizado de Contas a Pagar no ERP Tiny v3 via OAuth2    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 2. CONCILIAÇÃO BANCÁRIA & BAIXA AUTOMÁTICA                                  │
│    - Banco Inter PJ Banking API v2 (Autenticação mTLS + Certificados CRT)   │
│    - Leitura em tempo real de Extratos Bancários e Boletos DDA              │
│    - Motor de matching: Extrato Inter × Contas a Pagar Tiny v3             │
│    - Baixa automática no Tiny na conta correta ("Banco Inter - <empresa>")  │
│    - Registro do histórico permanente em `conciliacao_baixas_historico`     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 3. CONCILIAÇÃO MERCADO LIVRE (Norvia Campinas e Revesta)                 │
│    - Rotina diária: liberações do Mercado Pago do dia anterior              │
│    - Cruzamento por ID de pagamento com pedidos ML e contas a receber Tiny  │
│    - Análise e log guardados em disco; avisos viram notificação no painel   │
│    - Baixa NÃO automática: confirmada pelo usuário na tela                  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 4. DASHBOARD FINANCEIRO & TELEMETRIA                                        │
│    - Fluxo de Caixa previsto vs. realizado por período                      │
│    - DRE simplificado e ranking de despesas por fornecedor/categoria        │
│    - Monitoramento de inadimplência e geração de insights de caixa          │
│    - Monitoramento de validade e expiração de Certificados A1               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🏢 Empresas e Filiais Atendidas (Multi-Tenant)

O motor atende simultaneamente às 4 operações do grupo empresarial:

| Identificador | Razão Social / Nome Fantasia | CNPJ | Conta de Origem no Tiny v3 |
|---|---|---|---|
| `norvia_campinas` | Norvia Campinas (Matriz SP) | `27.184.930/0001-07` | `Banco Inter - Norvia Campinas` |
| `norvia_curitiba` | Norvia Curitiba (Filial PR) | `27.184.930/0002-80` | `Banco Inter - Norvia Curitiba` |
| `revesta` | Revesta Revestimentos | `36.592.814/0001-00` | `Banco Inter - Revesta` |
| `fabrilux` | Fabrilux Indústria e Comércio | `43.820.617/0001-66` | `Banco Inter - Fabrilux` |

---

## 🔐 Autenticação e Gestão de Segredos

### 1. Certificados Digitais A1 (SEFAZ e mTLS Banco Inter)
- **SEFAZ A1**: Arquivos `.pfx` ou `.p12` alocados em `./secrets/` (nunca versionados no git). As senhas são configuradas via `.env` por arquivo ou CNPJ.
- **Banco Inter PJ**: Certificados `.crt` e chaves privadas `.key` em `./data/certs/inter/` para conexão segura via mTLS.
- **Auditoria de Vencimento**: O módulo `cert_status.py` analisa os certificados em disco e alerta o operador preventivamente antes do vencimento.

### 2. Tokens Tiny ERP v3 (Tabela `api_tokens` no MariaDB & Resiliência Multinível)
- O conector Tiny ERP v3 obtém as credenciais OAuth de forma centralizada e dinâmica a partir da tabela `api_tokens` do MariaDB (`token_repository.py`), sincronizada com o n8n a cada 4 horas.
- **Detecção Inteligente de Erros Transitórios**: O repositório classifica erros transitórios de rede/DB (`_is_transient_db_error`), aplicando retentativas automáticas com reconexão imediata.
- **Período de Carência (Grace Period) em Memória**: Em caso de indisponibilidade temporária do banco de dados, o repositório utiliza tokens em cache por até 1 hora, impedindo paradas catastróficas nas rotinas fiscais.
- **Invalidação Imediata sob HTTP 401**: Respostas 401 do Tiny invalidam o cache em memória, forçando a busca do token mais recente gerado pelo n8n.

### 3. Timeouts Padronizados em Serviços Upstream
Para evitar o travamento de conexões ou bloqueio de workers FastAPI em caso de instabilidade externa, todas as integrações utilizam timeouts em tupla `(connect, read)`:
- **SEFAZ DFe (`nfe_client.py`)**: `DEFAULT_SEFAZ_TIMEOUT = (10.0, 35.0)`
- **Tiny ERP v3 (`tiny_client.py`)**: `DEFAULT_TINY_TIMEOUT = (5.0, 20.0)` e `DEFAULT_TINY_QUERY_TIMEOUT = (10.0, 45.0)`
- **Banco Inter PJ (`inter_client.py`)**: `DEFAULT_INTER_TIMEOUT = (5.0, 25.0)`

### 4. Trilha Estruturada de Auditoria (`app/audit.py`)
- Emissão de logs estruturados em JSON (`log_audit_event`) para operações críticas (lançamento de notas, conciliação bancária, baixas de contas a pagar, invalidação de tokens), compatível com coletores modernos de telemetria.

### 5. Proteção da API (correções de segurança de 2026-10-06)
- **Chave interna** (`app/internal_auth.py`): toda rota exige `X-Internal-Key: <AUTOMATIONS_INTERNAL_KEY>`
  (mesma variável no gateway), menos `GET /health` e `GET /api/v1/health`. Chave errada/ausente → `401`;
  variável não definida → `503` (só `INTERNAL_AUTH_DISABLED=true` libera, para dev/testes). As rotinas
  agendadas (SEFAZ, dashboard, conciliação ML) rodam no próprio processo e não dependem da chave.
- **Health público mínimo**: sem a chave, `/health` devolve só `{"status","timestamp"}`; com a chave
  (o gateway), inclui `nfe_provider`, `tiny_configured` etc.
- **A porta 8000 NÃO deve ser publicada no host** (`ports:` no compose): o gateway fala com o serviço
  pela rede docker (`http://automacao-nfe:8000`). Dentro do container o bind continua `0.0.0.0` (é o
  que a rede docker precisa); a proteção é a chave + não publicar a porta.
- **Autor da auditoria**: header `X-Usuario` (login da sessão, enviado pelo gateway; URL-encoded) tem
  prioridade sobre o campo `usuario` do corpo.
- **CORS**: nenhuma origem por padrão (`CORS_ORIGINS` só em dev), sem `allow_credentials`.
- **Erros**: exceção não tratada → `500` com mensagem genérica e `erro_id` (o `X-Request-Id` do gateway
  quando vier); detalhe só no log. Respostas cruas do Tiny/Inter não chegam ao cliente.
- **Baixa Inter × Tiny**: a baixa só aceita pares conta × débito que a última prévia (até 1 h) deu como
  aptos; valor, data, juros, multa, desconto e conta de origem vêm do extrato guardado, não do corpo.
  A conta é relida no Tiny antes (em aberto e com o valor da prévia). POST `/baixar` com resposta
  ambígua (timeout de leitura, 5xx) relê a conta antes de repetir. Trava por (empresa, conta) e registro
  das baixas feitas em `DATA_DIR/reconciliacao_inter_baixas.json` (um débito do Inter baixa uma conta só).
- **Segredos em disco**: o cache OAuth do Tiny e os tokens do Mercado Livre (`ml_tokens.json`) são gravados
  exclusivamente com permissões restritas `0600` no `DATA_DIR` próprio; arquivos de estado comuns seguem `0644`.
  O `backup.sh` lê via `nsenter -U` no userns do Docker rootless, então não é afetado.
- **Sincronização de tokens ML**: `POST /api/v1/conciliacao-ml/tokens/sincronizar` possui cooldown de 60 s
  (retornando HTTP 429), retorno sanitizado sem vazar `token_prefixo` e 500 genérico em caso de falha. A renovação
  direta de tokens ML no serviço requer `ML_OAUTH_RENOVACAO_PROPRIA=true` (por padrão `false`).
- **Certificado A1**: o PEM extraído do `.pfx` vai para uma pasta privada (`0700`, arquivos `0600`) em
  `/dev/shm` (tmpfs) quando disponível, apagada ao fim de cada consulta e no encerramento.
- **Limites de upload**: `UPLOAD_MAX_FILE_MB` (20), `UPLOAD_MAX_PDF_PAGES` (50), `UPLOAD_MAX_FILES` (50).
- **NSU**: `set_nsu` do reset e o NSU do envelope SOAP só aceitam `^\d{1,15}$`.
- **MOCK_MODE**: a simulação de lançamento sem token só existe com `MOCK_MODE=true`.
- **Reauditoria de 2026-10-07**: `/docs`, `/redoc` e `/openapi.json` desligados (a dependência da chave não os
  cobria — SEC-05); planilhas `.xlsx` da conciliação ML gravam texto iniciado por `=` como texto, nunca fórmula
  (dados de ML/Tiny vêm de terceiros — SEC-03); tarefas da conciliação ML só em `/api/v1/conciliacao-ml/jobs/{id}`
  e as da conciliação Inter só em `/api/v1/reconciliacao/jobs/{id}` (SEC-04).

---

## 📁 Estrutura Interna de Módulos (`app/`)

- `api.py`: Servidor FastAPI com rotas de upload, listagem de pendências, execução de baixas, conciliação e dados do dashboard financeiro.
- `audit.py`: Logger unificado para auditoria estruturada em formato JSON.
- `sefaz_scan.py`: Rotina agendada ou sob demanda que consulta o WebService de Distribuição DFe da SEFAZ para localizar novas notas fiscais emitidas contra os CNPJs do grupo.
- `scanner.py`: Scanner de alta precisão para leitura de chave de 44 dígitos em PDFs e imagens com OpenCV, Otsu e OCR Tesseract.
- `nfe_client.py`: Provedores de NF-e, download de XMLs completos e parser de duplicatas/parcelas com timeouts padronizados.
- `review_store.py` & `review_pipeline.py`: Gestão de fila das notas que aguardam aprovação humana antes do lançamento financeiro.
- `categorization.py` & `category_history.py`: Motor heurístico que aprende as categorias de despesa preferidas por emitente.
- `inter_client.py`: Cliente seguro da API v2 do Banco Inter com mTLS, extratos e boletos DDA.
- `reconciliation.py`: Algoritmo de cruzamento entre saídas bancárias do Inter e títulos do Tiny ERP.
- `tiny_client.py`: Conector com o Tiny ERP v2 e v3 para inclusão de títulos, consulta de saldos e baixa de títulos.
- `financial_dashboard.py`: Cálculo consolidado de indicadores financeiros e geração de insights de tesouraria.
- `token_repository.py`: Repositório resiliente de tokens com retry transitório, cache em memória e grace period.
- `ml_apis.py`: Clientes do Mercado Livre e do Mercado Pago (relatório de liberações, pedidos) e resolução dos tokens.
- `ml_reconciliation.py` & `ml_reconciliation_rotina.py`: Regras de cruzamento liberação × venda × conta a receber e a rotina diária (execuções, análises e baixas registradas em `DATA_DIR/conciliacao_ml/`).
- `contas_pagar_rotina.py`: Estado persistente das pendências de Contas a Pagar (`DATA_DIR/contas_pagar/estado.json`), mesclagem das prévias e conferência diária de baixas externas.
- `internal_auth.py`: Validação do header `X-Internal-Key` enviado pelo gateway.
- `boleto.py`, `nfe_items.py`, `tiny_categories.py`, `cert_status.py`, `json_store.py`: Linha digitável de boletos, itens da NF-e, categorias do Tiny, validade dos certificados e gravação atômica de estado em JSON.

### Contas a Pagar — rotina diária e estado persistente (`/api/v1/reconciliacao/*`)

As pendências do cruzamento Extrato Inter × Contas a Pagar Tiny ficam salvas em
`DATA_DIR/contas_pagar/estado.json` (`app/contas_pagar_rotina.py`), e não só na última prévia:
- Cada prévia é **mesclada** ao estado: a janela nova atualiza as pendências, e as contas que saíram
  da janela continuam salvas enquanto estiverem em aberto.
- Uma conta sai das pendências quando é **baixada pela tela** (remoção imediata, motivo `automacao`) ou
  **liquidada fora da automação no Tiny** (motivo `baixa_externa_tiny`). Nesse caso a conferência só
  remove a conta se a situação deixou de ser `aberto`, `parcial` ou `atrasada(o)`, ou se o saldo zerou
  e a situação não é `aberto`. Saldo ausente não conta como zerado.
- As baixas vão para `historico_saidas` (máximo de 5000 registros) e as execuções para o histórico de
  execuções (máximo de 60).
- Rotina diária às `CONTAS_PAGAR_ROTINA_HOUR` (padrão 7h, horário do servidor). Ela faz a prévia dos
  últimos `CONTAS_PAGAR_ROTINA_DIAS` dias (padrão 60) com `forcar_atualizacao` e depois confere as baixas
  externas. Com `MOCK_MODE=true` a conferência externa não roda.
- `GET /api/v1/reconciliacao/estado` devolve esse estado. O gateway expõe a mesma leitura em
  `GET /api/reconciliation/estado`.

### Conciliação Mercado Livre (`/api/v1/conciliacao-ml/*`)

Todo dia às `ML_RECONCILIATION_HOUR` (padrão 8h), para Norvia Campinas e Revesta, a rotina reanalisa a
**janela móvel de 60 dias** (de D-60 até ontem, `periodo_padrao`): baixa o relatório de liberações do
Mercado Pago, busca as vendas do ML desde `ML_RECONCILIATION_VENDAS_DIAS` (padrão 60) dias antes do
período, cruza com os pedidos e as contas a receber do Tiny (só leitura) e grava a análise.
- A **visão consolidada** `consolidado_<empresa>` une os grupos das análises da janela de 60 dias. Os
  grupos recebem id `C-<id da venda>-<id da operação>` (`_id_grupo_consolidado`) e são atualizados a cada rotina.
- `GET /api/v1/conciliacao-ml/status` traz `renovacao_tokens_no_painel`: `true` quando o próprio serviço
  consegue renovar os tokens (`TMS_USER`/`TMS_PASSWORD` ou `ML_OAUTH_RENOVACAO_PROPRIA=true`). Sem isso,
  a renovação vem do cron do host (ver [scripts/README.md](../../../scripts/README.md)). As horas de
  `proxima_execucao` e `agora` saem com o fuso local (`-03:00`), para o frontend não mostrar 3 h a menos.
- O gateway lê `/api/v1/conciliacao-ml/avisos` a cada 5 min e notifica o Financeiro. A baixa é um job
  (`POST /api/v1/conciliacao-ml/jobs/baixar`) disparado pelo usuário, e cada liberação só baixa uma vez.

**Tokens do ML** (`app/ml_apis.py`): são lidos primeiro de `DATA_DIR/ml_tokens.json` (onde o financeiro
grava os tokens renovados, modo `0600`) e depois de `ML_TOKENS_FILE`. Vale o primeiro token válido
(expiração com margem de 15 min), e só se nenhum estiver válido há renovação.

---

## ⚙️ Variáveis de Ambiente (`.env`)

Copie o arquivo `.env.example` e configure as credenciais da sua infraestrutura:

```env
# Conexão com o banco central MariaDB
DB_HOST=mariadb
DB_PORT=3306
DB_USER=root
DB_PASSWORD=sua_senha
DB_NAME=financeiro

# Provedor Fiscal SEFAZ A1
NFE_PROVIDER=sefaz_a1
SEFAZ_CERTS_DIR=./secrets
SEFAZ_PASSWORD_MATRIZ=senha_do_certificado

# Banco Inter PJ (mTLS)
INTER_CERTS_DIR=./data/certs/inter
INTER_NORVIA_CAMPINAS_CLIENT_ID=...
INTER_NORVIA_CAMPINAS_CLIENT_SECRET=...

# Segurança (ver seção 5)
AUTOMATIONS_INTERNAL_KEY=   # mesmo valor do gateway, mín. 32 caracteres
MOCK_MODE=false             # true só em dev local

# Contas a Pagar (rotina diária de conferência, app/contas_pagar_rotina.py)
CONTAS_PAGAR_ROTINA_HOUR=7                          # 0-23, horário do servidor
CONTAS_PAGAR_ROTINA_DIAS=60                         # janela em dias para trás

# Conciliação Mercado Livre
ML_RECONCILIATION_HOUR=8
ML_RECONCILIATION_VENDAS_DIAS=60                    # vendas buscadas antes do período (janela de 60 dias)
ML_TOKENS_FILE=data/ml_tokens.json                  # leitura extra de ml_tokens.json (depois de DATA_DIR)
ML_OAUTH_RENOVACAO_PROPRIA=false                    # true habilita renovação OAuth própria pelo financeiro
MP_NORVIA_CAMPINAS_ACCESS_TOKEN=                 # opcional: sem ele, usa o token ML da conta
MP_REVESTA_ACCESS_TOKEN=
```

---

## 🧪 Testes Automatizados

```bash
# Executar a partir da raiz do monorepo:
npm run test:nfe

# Ou dentro da pasta, sem venv (requirements-dev.txt = requirements.txt + httpx do TestClient):
uv run --python 3.11 --with-requirements requirements-dev.txt pytest tests/ -v
```
*(426 testes unitários e de integração cobrindo SEFAZ, parser XML, Inter, conciliação, resiliência de tokens, auditoria estruturada e Tiny ERP).*
