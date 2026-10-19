# Manual de Integrações Operacionais — Norvia Automações

## 1. Arquitetura e Fronteiras do Sistema

O ecossistema Norvia opera através de uma arquitetura em camadas desacopladas:

1. **Frontend (vinext/Vite com convenções App Router / React 19)**, publicado como export estático: Interface reativa acessada pelos operadores, com controle de visualização baseado em papéis e setores (RBAC).
2. **API Gateway Central (Node.js 22+ / TypeScript)**: Porta de entrada única (porta `3100`), responsável por:
   - Autenticação e ciclo de vida de sessões seguras (`scrypt` + tokens opacos);
   - Controle de acesso por área operacional (`financeiro`, `marketplace`, `logistica`, `producao`);
   - Streaming em tempo real via **Server-Sent Events (SSE)** em `/api/events`;
   - Trilha imutável de auditoria de ações sensíveis em `auditoria`;
   - Agregação de telemetria das fontes em `/api/overview`.
3. **Motores Especializados de Automação (Python / FastAPI)**:
   - `automacoes-financeiro` (porta `8000`): Varredura SEFAZ A1 direta, Banco Inter PJ v2 (mTLS), conciliação bancária, conciliação Mercado Livre × Contas a Receber, lançamentos no Tiny ERP v3 e dashboard financeiro.
   - `automacoes-marketplace` (porta `8001`): Coleta diária no Mercado Livre e Tiny, padronização de dimensões e gestão de fretes Mercado Envios (ME1 e ME2).
   - `automacoes-producao` (porta `8003` local): Servidor de impressão térmica para etiquetas 60 × 40 mm (Elgin L42-DT em EPL por padrão; ZPL opcional) no PC do encarregado de fábrica, exposto via Cloudflare Tunnel com `X-Api-Key` obrigatório (`CHAVE_API`).
   - `contagem-estoque`: Bot Telegram com visão computacional (OpenCV) para contagem de pacotes por prendedores verdes.
4. **Banco de Dados MariaDB (Porta 3306)**: Multi-database centralizado (`financeiro`, `marketplace`, `producao`) com rotação automática de tokens OAuth v3 do Tiny ERP via n8n.

---

## 2. Alternância entre Modos (`Live` e `Demo`)

O sistema foi concebido para suportar desenvolvimento e homologação sem qualquer risco de impacto sobre dados ou serviços de produção:

- **Frontend (`NEXT_PUBLIC_DATA_MODE`)**:
  - `demo`: O frontend consome fixtures em memória estáticas e determinísticas, permitindo navegar por todas as telas sem depender do backend ou do banco de dados.
  - `live`: O frontend conecta-se ao Gateway (`NEXT_PUBLIC_API_BASE_URL=http://localhost:3100` ou origem relativa), utilizando cookies ou cabeçalhos de autorização (`X-Session-Token` / `Bearer`).
- **Gateway (`DATA_MODE`)**:
  - `demo`: O gateway gera payloads sintetizados determinísticos em `/api/overview` e `/api/accounts-payable/dashboard`.
  - `live`: O gateway conecta-se ao MariaDB, consulta o n8n e atua como proxy para os motores de automação.

---

## 3. Autenticação, Sessões e Controle de Acesso (RBAC)

O Gateway implementa identidade corporativa nativa:
- **Tabelas de Suporte**: `usuarios` e `sessoes` no banco `financeiro`.
- **Criptografia**: As senhas são protegidas com derivação de chave `scrypt` e salt criptográfico individual.
- **Tokens de Sessão**: Tokens opacos gerados via `crypto.randomBytes(32)` com expiração configurável (padrão de 24 horas). O banco guarda só o `sha256` do token; o painel admin identifica sessões pelo `public_id`.
- **Chamadas às automações**: o gateway envia `X-Internal-Key` (`AUTOMATIONS_INTERNAL_KEY`), `X-Request-Id` e, nas ações do usuário, `X-Usuario`.
- **Controle de Setores (`areas.ts`)**:
  - Usuários do setor **Financeiro** acessam NF-e, Conciliação Inter × Tiny, Conciliação Mercado Livre e Dashboard Financeiro.
  - Usuários do setor **Marketplace / E-Commerce** acessam Padronização de Dimensões e Fretes a Combinar.
  - Usuários do setor **Logística** acessam a Contagem de Estoque.
  - Usuários do setor **Produção** acessam o módulo de etiquetas e download do instalador da fábrica.
  - Administradores (`role: admin`) e membros da **Diretoria** possuem acesso irrestrito a todas as áreas operacionais.

---

## 4. Integrações Externas e Fontes de Dados

### 4.1. MariaDB Multi-Database
Configurado via variáveis `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

- **Tabela `conciliacao_baixas_historico`**: Registra cada baixa executada na conciliação Banco Inter × Tiny ERP (usuário, lote, empresa, documento, valores e status de retorno do Tiny).
- **Tabela `inter_dda_boletos`**: Boletos capturados pelo DDA do Banco Inter das 4 filiais.
- **Tabela `api_tokens`**: Tabela centralizada contendo os tokens OAuth v3 do Tiny ERP para cada uma das filiais (`norvia_campinas`, `norvia_curitiba`, `revesta`, `fabrilux`), rotacionados a cada 4 horas pelo n8n.
- **Tabela `dimensoes_produtos` (banco `marketplace`)**: Medidas padronizadas validadas pela equipe de e-commerce.

### 4.2. n8n (Orquestração de Workflows)
Configurado via `N8N_BASE_URL`, `N8N_API_KEY` e `N8N_WORKFLOW_IDS`:
- O gateway consulta as execuções dos workflows configurados via `GET /api/v1/executions` utilizando a API REST oficial do n8n.
- Os resultados são deduplicados e ordenados decrescentemente por data de início.
- No endpoint `/api/overview`, as páginas de execução são agregadas para compor o histórico de saúde e volumetria dos últimos 14 dias em São Paulo (UTC−03).

### 4.3. SEFAZ DFe (Distribuição de Documentos Fiscais Eletrônicos)
- Varredura direta via Web Service SOAP da SEFAZ Nacional com certificados digitais A1 (`.pfx` / `.p12`) de cada empresa do grupo.
- Parser completo dos XMLs com extração de emitente, destinatário, valor total e duplicatas de pagamento.

### 4.4. Banco Inter PJ (Banking API v2)
- Conexão autenticada via mTLS com certificados `.crt` e chaves `.key` exclusivos de cada empresa.
- Consulta de extratos bancários para conciliação automática com o Tiny ERP e captura de boletos DDA.

### 4.5. Tiny ERP v3 (Public API v3)
- Conexão via OAuth2 com Bearer Token dinâmico lido do MariaDB (`api_tokens`).
- Lançamento automatizado de títulos em Contas a Pagar a partir das NF-es revisadas.
- Baixa automática de títulos vinculada à respectiva conta de origem bancária da filial (`Banco Inter - <empresa>`).
- Sincronização de dimensões e fichas técnicas de produtos no catálogo.

### 4.6. Mercado Livre (Mercado Envios & Catálogo)
- Sincronização diária de anúncios ativos e fichas técnicas de produtos via API do Mercado Livre.
- Cálculo de embalagem padrão com base no comprimento do produto e atualização de modo de frete (ME1 / ME2).

### 4.7. Mercado Pago (Conciliação Mercado Livre)
- Rotina diária no `automacoes-financeiro` para Norvia Campinas e Revesta: relatório de liberações do dia anterior (API de relatórios, assíncrona), cruzado por ID de pagamento com os pedidos do ML e as contas a receber do Tiny.
- Tokens do ML lidos de `ml_tokens.json` em diretório configurado (`ML_TOKENS_FILE`, armazenado em `DATA_DIR` próprio com permissão `0600` e gravação atômica); renovação própria opcional via `ML_OAUTH_RENOVACAO_PROPRIA`; token de produção do Mercado Pago opcional por empresa.
- Avisos da rotina (`/api/v1/conciliacao-ml/avisos`) são lidos pelo gateway a cada 5 min e viram notificação para o Financeiro e os admins. A baixa no Tiny só acontece quando o usuário confirma na tela `/conciliacao-mercado-livre`.

---

## 5. Telemetria e Consolidação (`/api/overview`)

O endpoint `GET /api/overview` consolida o estado operacional de todo o monorepo:
- **Janela Temporal**: 14 dias móveis calculados estritamente no fuso horário `America/Sao_Paulo` (UTC−03).
- **Indicadores**:
  - Volume consolidado de transações concluídas;
  - Horas estimadas economizadas por automação;
  - ROI financeiro estimado (horas × R$ 11,00/h);
  - Taxa de sucesso de execuções técnicas (n8n e motores internos);
  - Diagnóstico de conectividade dos serviços (MariaDB, n8n, automacao-nfe, marketplace).

---

## 6. Arquitetura de Resiliência, Circuit Breakers e Telemetria Unificada

O sistema adota uma política rigorosa de fail-fast, isolamento de falhas e reatividade:

### 6.1. Frontend — Polling Inteligente & Reatividade (`DataPoller` / `useDataPolling`)
- **Suspensão em Segundo Plano**: Utiliza a Page Visibility API (`document.visibilityState`). Quando o operador minimiza o navegador ou troca de aba, as consultas periódicas de polling são imediatamente suspensas, reduzindo drasticamente o consumo de CPU e o tráfego de rede no servidor.
- **Retomada com Tolerância**: Ao retornar à aba, se o intervalo de atualização expirou, uma nova consulta é executada de forma transparente.
- **Cancelamento com `AbortController`**: Trocas de rota ou ações de recarregamento manual abortam imediatamente requisições HTTP pendentes em voo.
- **Invalidação Reativa via SSE (`/api/events`)**: Notificações e eventos de negócio emitidos pelo Gateway disparam revalidação instantânea das telas conectadas sem aguardar o próximo ciclo de polling.

### 6.2. API Gateway — Padrão Circuit Breaker (`circuit-breaker.ts`)
- **Proteção dos Upstreams**: Protege o Gateway contra travamento em cascata quando serviços externos (SEFAZ, Tiny ERP v3, Banco Inter e microsserviços Python) apresentam lentidão severa ou instabilidade.
- **Estados Operacionais**:
  - `CLOSED`: Operação normal. Todas as requisições passam e o contador de falhas é monitorado.
  - `OPEN`: Fail-fast ativado após limite de falhas consecutivas (`failureThreshold`). As requisições são rejeitadas imediatamente (0ms) com erro 503 descritivo, impedindo o esgotamento dos sockets do Node.js.
  - `HALF_OPEN`: Após o tempo de carência (`resetTimeoutMs`), requisições de teste (probes) são admitidas para aferir a recuperação do serviço. Se bem-sucedidas, o circuito é fechado novamente.
- **Preservação de Cancelamento do Cliente**: Abort voluntário pelo navegador (`clientSignal`) não penaliza o circuito nem incrementa contadores de erro de infraestrutura.
- **Rastreabilidade Distribuída (`X-Request-Id`)**: Cada requisição recebe um identificador único de correlação propagado nos cabeçalhos HTTP para os serviços Python downstream.
- **Telemetria de Circuitos**: Endpoint dedicado `GET /api/health/circuits` (somente sessão admin) expõe o estado, timestamps e contadores de cada circuito ativo.

### 6.3. Backend Fiscal/Financeiro — Resiliência Multinível & Timeouts Padronizados
- **Timeouts em Tupla `(connect, read)`**: Padronizados em todas as chamadas externas (`DEFAULT_SEFAZ_TIMEOUT`, `DEFAULT_TINY_TIMEOUT`, `DEFAULT_INTER_TIMEOUT`) para evitar bloqueio indefinido dos workers FastAPI.
- **Repositório de Tokens com Grace Period**: O conector `token_repository.py` identifica erros transitórios do MariaDB com reconexão automática. Em caso de indisponibilidade momentânea do banco, utiliza cache em memória por até 1 hora, assegurando continuidade operacional.
- **Invalidação Proativa de Tokens**: Respostas `HTTP 401 Unauthorized` do Tiny ERP v3 invalidam o cache em memória imediatamente, forçando a busca do novo token emitido pelo n8n.
- **Auditoria Estruturada (`audit.py`)**: Emissão de logs em JSON com metadados contextuais padronizados (`log_audit_event`).

### 6.4. Observabilidade Administrativa (`SystemHealthMonitor` & `/admin/saude`)
- **Amostragem Periódica**: Monitoramento executado a cada 5 minutos em segundo plano com janela histórica de 24 horas retida em memória.
- **Diagnóstico Multi-Database no MariaDB**: Aferição da latência de consulta (em milissegundos) e descoberta de múltiplos esquemas ativos (`financeiro`, `marketplace`, `producao`).
- **Supervisão Unificada**: Consolida em uma única visão o status do Gateway, MariaDB, Circuit Breakers, Motor Fiscal (`automacao-nfe`), Motor de Marketplace (`automacoes-marketplace`), Conectores Tiny e Inter, rotinas SEFAZ, certificados A1 e backups.

