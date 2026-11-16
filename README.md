# Norvia Automações (Monorepo) — versão de demonstração

Monorepo centralizado para gestão, orquestração e monitoramento de rotinas automatizadas de um grupo empresarial de acabamentos e revestimentos (**Norvia** Campinas, Norvia Curitiba, Revesta e Fabrilux).

> **Projeto de portfólio.** Esta é uma cópia anonimizada de uma plataforma interna em produção.
> Nomes de empresas, CNPJs, domínios, e-mails, IPs, clientes, fornecedores, números de venda e SKUs
> foram trocados por dados fictícios, e o histórico do git não é o original. Credenciais,
> certificados, dados de treino e fotos reais não fazem parte do repositório (as imagens do
> marketing são ilustrações neutras). O código, a arquitetura e os testes são os originais.

**🔗 Demonstração ao vivo:** https://jotape1302.github.io/interface-web-demo/ — clique em
**“Entrar como administrador (demonstração)”**. Tudo roda no navegador com dados simulados: nenhuma
chamada ao Tiny ERP, SEFAZ, Banco Inter, Polp, Mercado Livre ou aos modelos de IA.

### O que a plataforma faz

- **Financeiro:** varredura de NF-e na SEFAZ (certificado A1, distribuição por NSU com retomada),
  OCR de DANFE/NFC-e e lançamento no Tiny ERP com revisão humana e **categoria sugerida por IA**;
  conciliação de extratos do Banco Inter (mTLS) com contas a pagar; **boletos DDA** (Polp) que viram
  contas a pagar no Tiny, com validação humana em lote antes do agendamento no Inter e baixa depois de
  pago; conciliação de liberações do Mercado Pago com vendas do Mercado Livre (tarifas, fretes,
  cupons, devoluções, pacotes); dashboards de fluxo de caixa, DRE gerencial, inadimplência e ROI das
  automações.
- **Marketplace:** padronização de dimensões e tipo de frete dos anúncios do Mercado Livre a partir
  do cadastro do ERP.
- **Marketing:** rascunhos de e-mail marketing e carrossel a partir do catálogo, com ambientes
  aprovados por humano.
- **Logística:** contagem de estoque por foto da prateleira via bot do Telegram (visão
  computacional + código de barras).
- **Produção:** impressão de etiquetas EPL/ZPL a partir de um tablet no chão de fábrica.
- **Plataforma:** API Gateway com sessões, RBAC por área, SSE, circuit breaker, auditoria, saúde
  do sistema, alertas, backup, migrações versionadas e CI.

### 🤖 IA treinada e agentes locais (Qwen)

Os modelos rodam **localmente**, numa GPU de 12 GB no PC do TI (Ollama / llama.cpp), nunca na VPS
nem em API paga. A VPS só conversa com eles por um túnel SSH reverso aberto pelo PC.

- **Classificador de categorias da NF-e** — `ia/agentes-qwen/agentes/financeiro*.py`,
  `treino_financeiro.py`, `finetune_financeiro.py`, `llama_server.py`; lado do painel em
  `automacoes-financeiro/app/routers/danfe.py` (`/api/v1/danfe/qwen/*`) e
  `frontend/lib/danfe-review-helpers.ts`.
  - Precedência: mesmo **código** de produto já lançado com o fornecedor → mesmo **NCM** → **Qwen**.
    A tela mostra a origem, a confiança e o motivo de cada sugestão (no demo, passe o mouse no ícone
    ao lado da categoria em *NF-e & DANFE → Revisão*).
  - O modelo base (Qwen2.5 14B) classifica com exemplos recuperados por embeddings (bge-m3,
    few-shot). As confirmações humanas da revisão viram dados de treino (`scripts/exportar-atividades.sh`
    → `importar-atividades`), e um **adaptador LoRA (QLoRA/Unsloth)** é treinado, comparado com o
    modelo atual num conjunto separado (`comparar-financeiro`) e só **promovido** se ganhar. Depois
    disso, o lote roda no `llama-server` com o adaptador.
- **Classificador de categorias dos boletos DDA** — `ia/agentes-qwen/agentes/boletos*.py`,
  `treino_boletos.py`; lado do painel em `automacoes-financeiro/app/dda_categoria.py`
  (`/api/v1/dda/qwen/*`) e nos cards de *Contas a Pagar → Boletos DDA*.
  - Boleto não tem itens: decide o **fornecedor**. O histórico vem das saídas de caixa do ERP de cada
    empresa e das escolhas feitas no painel. Escolha anterior no painel, ou categoria com ≥ 80% dos
    lançamentos do fornecedor, vence sozinha; fornecedor novo ou dividido entre categorias vai ao Qwen,
    que vê a distribuição por valor e fornecedores parecidos (bge-m3).
  - Mesmo pipeline da NF-e com **dataset e adaptador LoRA próprios** (`finetune-boletos`), e o portão
    `comparar-boletos` mede também o "histórico sozinho" como linha de base.
- **Agentes de incidentes de produção** — `ia/agentes-qwen/` + `scripts/coletor-incidentes/`, com a
  tela em *Admin → Agentes Qwen* e o botão **Reportar erro** em todas as telas.
  - Um coletor na VPS lê os logs dos contêineres, mascara dados sensíveis e manda cada erro ao PC.
  - Na fila, uma cadeia de agentes com saída JSON validada (Pydantic) trata um incidente por vez:
    **diagnóstico → resolução → executor** (`qwen2.5-coder:14b`, edição por troca exata num clone
    próprio) **→ qualidade** (testes numa sandbox bubblewrap sem rede + revisão). Reprovou: nova
    volta, no máximo 3; depois, escala para o TI.
  - Aprovado, abre um **PR no GitHub**, que só é mergeado com o rótulo de aprovação de um humano e CI
    verde. Depois do deploy, um **monitor** acompanha as próximas 5 execuções da rota: o erro voltou,
    reabre; não voltou, fecha como resolvido.
  - Cada agente consulta uma base RAG própria (Chroma + bge-m3), e as resoluções confirmadas
    realimentam essa base.

**Stack:** React 19 + Vite/vinext (export estático) + Tailwind v4 · Node.js 22/TypeScript sem
framework · Python 3.11/FastAPI · MariaDB · Docker rootless · Qwen 2.5 (Ollama, llama.cpp,
Unsloth/QLoRA), Chroma + bge-m3 · GitHub Actions (CI, gitleaks, npm audit, pip-audit).

### Rodar a demonstração localmente

```bash
npm --prefix frontend ci
npm run dev:mock        # http://localhost:3000/automacoes/ — login "demo"
```

O gateway também sobe em modo demo (`DATA_MODE=demo`, padrão fora de produção), e as automações
têm `MOCK_MODE=true` nos `.env.example`. Os testes dos agentes Qwen não precisam de GPU nem de
Ollama: `cd ia/agentes-qwen && python -m unittest discover -s tests`.

---

## 🏛️ Topologia de Diretórios do Monorepo

```
interface-web/
├── frontend/                          # Interface Web Administrativa (vinext/Vite com convenções App Router / React 19 / Tailwind v4)
│   ├── app/                           # App Router: layout autenticado e páginas por setor
│   │   ├── (dashboard)/               # Rotas autenticadas com controle RBAC por setor
│   │   │   ├── financeiro/            # Visão Geral da área Financeiro (cards, ROI e tendências)
│   │   │   ├── danfe-tiny/            # Varredura SEFAZ, upload de DANFEs, OCR e revisão humana
│   │   │   ├── contas-a-pagar/        # Conciliação bancária: Extratos Inter × Contas a Pagar Tiny
│   │   │   ├── conciliacao-mercado-livre/ # Liberações Mercado Pago × vendas ML × Contas a Receber Tiny
│   │   │   ├── dashboard-financeiro/  # Fluxo de caixa, DRE gerencial, inadimplência e insights
│   │   │   ├── marketplace/           # Visão Geral da área Marketplace
│   │   │   ├── padronizacao-dimensoes/# Padronização de medidas (Tiny vs Mercado Livre)
│   │   │   ├── fretes-a-combinar/     # Conversão de fretes para Mercado Envios (ME1 e ME2)
│   │   │   ├── logistica/             # Visão Geral da área Logística
│   │   │   ├── contagem-estoque/      # Telemetria do bot Telegram de contagem por visão computacional
│   │   │   ├── email-marketing/       # Rascunhos de e-mail marketing e carrossel (área Marketing)
│   │   │   ├── producao/              # Visão Geral da Produção e download do instalador de etiquetas
│   │   │   ├── admin/                 # Painéis administrativos: Usuários, Saúde do Sistema e Auditoria
│   │   │   └── chat/                  # Central interna de mensagens operacionais
│   │   └── login/                     # Tela de autenticação corporativa
│   ├── components/                    # Design system (cards, tabelas, modais, gráficos e badges)
│   ├── lib/                           # Clientes HTTP, contratos tipados, adaptadores e testes unitários
│   └── public/                        # Ativos estáticos e instaladores (ex: norvia-etiquetas-producao.zip)
│
├── backend/                           # Camada Backend Unificada
│   ├── gateway/                       # API Gateway central Node.js/TypeScript (porta 3100)
│   │   ├── src/                       # Roteamento nativo, autenticação scrypt, sessões MariaDB, RBAC e SSE
│   │   └── test/                      # Testes unitários e de integração (node:test)
│   │
│   └── automations/                   # Catálogo de Microsserviços e Motores de Automação
│       ├── automacoes-financeiro/     # Motor Fiscal, Bancário e Financeiro (FastAPI, porta 8000; serviço `automacao-nfe`)
│       │   ├── app/                   # Varredura SEFAZ A1, Banco Inter PJ v2, Conciliação Inter e ML, Tiny v3 e DRE
│       │   ├── tests/                 # Testes automatizados (pytest - 660 testes)
│       │   └── secrets/               # Certificados digitais A1 locais (*.pfx/*.p12)
│       │
│       ├── automacoes-marketplace/    # Padronização e Fretes Mercado Livre (FastAPI, porta 8001; serviço `automacoes-marketplace`)
│       │   ├── app/                   # Coleta diária ML/Tiny, embalagens padrão e rotina de fretes
│       │   ├── tests/                 # Testes automatizados (pytest - 89 testes)
│       │   └── data/                  # Caches de catálogo e tokens
│       │
│       ├── automacoes-producao/       # Servidor de Impressão de Etiquetas Térmicas (FastAPI, porta 8003 local)
│       │   ├── app/                   # Etiqueta 60x40mm em EPL (padrão) ou ZPL, envio RAW USB para a Elgin L42-DT
│       │   ├── tests/                 # Testes de montagem EPL/ZPL, autenticação e sanitização (pytest - 47 testes)
│       │   └── empacotar.py           # Gera instalador Windows autônomo de 1 clique (iniciar.bat)
│       │
│       └── contagem-estoque/          # Bot Telegram de Inventário (OpenCV; serviço `contagem-estoque`)
│           ├── app/                   # Visão computacional para detecção de prendedores verdes
│           ├── tests/                 # Testes do detector, do bot e das fotos reais (pytest - 68 testes; 3 dependem das fotos reais, fora desta cópia)
│           └── scripts/               # Utilitários de calibração de cor e teste local via CLI
│
├── database/                          # Governança e Schemas do Banco de Dados
│   ├── init/                          # Scripts SQL de inicialização automática (01 a 07)
│   └── migrations/                    # Migrações versionadas, aplicadas com scripts/migrate.sh (registro em schema_migrations)
│
├── ia/agentes-qwen/                  # Agentes Qwen locais: incidentes de produção e classificador de NF-e (LoRA)
├── scripts/coletor-incidentes/        # Coletor de erros na VPS → fila dos agentes no PC (túnel SSH reverso)
├── scripts/backup/                    # Backup diário criptografado (MariaDB + caches) via systemd
├── .github/workflows/ci.yml           # CI de qualidade: typecheck, testes (Node e pytest) e ruff
├── .github/workflows/security.yml     # CI de segurança: gitleaks, npm audit e pip-audit
├── agents/                            # Prompts dos 12 agentes especialistas (catálogo em registry.json)
├── docs/                              # Contratos analíticos, métricas, integração e segurança/deploy
├── orchestrator.md                    # Prompt do Orquestrador Central (ponto único de contato)
├── .codexrules                        # Regras e leis de governança de código e infraestrutura
├── registry.json                      # Catálogo unificado de papéis técnicos
└── package.json                       # Scripts unificados de orquestração, desenvolvimento e testes
```

---

## 🗂️ Mapeamento de Áreas, Setores e Serviços

A plataforma divide suas responsabilidades em **4 áreas de negócio operacionais** mais a área **Administrativa**, com controle de acesso rigoroso por setor (RBAC):

| Área | Setores com Acesso | Telas Principais | Serviço Backend Responsável | Banco no MariaDB |
|---|---|---|---|---|
| **Financeiro** | Financeiro, Diretoria, Admin | `/danfe-tiny`<br>`/contas-a-pagar`<br>`/conciliacao-mercado-livre`<br>`/dashboard-financeiro` | `automacoes-financeiro` (porta 8000)<br>API Gateway (porta 3100) | `financeiro` |
| **Marketplace** | E-Commerce, Marketplace, Diretoria, Admin | `/padronizacao-dimensoes`<br>`/fretes-a-combinar` | `automacoes-marketplace` (porta 8001) | `marketplace` |
| **Logística** | Logística, Diretoria, Admin | `/contagem-estoque` | `contagem-estoque` (Bot Telegram) | - |
| **Produção** | Produção, Diretoria, Admin | `/producao` (download do instalador) | `automacoes-producao` (porta 8003 local no PC do encarregado) | `producao` |
| **Admin** | Apenas Administradores (`role: admin`) | `/admin/usuarios`<br>`/admin/saude`<br>`/admin/auditoria`<br>`/chat` | API Gateway (porta 3100) | `financeiro` |

---

## 🗄️ Arquitetura Multi-Database no MariaDB

O ecossistema utiliza um único container MariaDB compartilhado, dividido logicamente em três databases especializados:

1. **`financeiro`**:
   - Autenticação e Sessões (`usuarios`, `sessoes`).
   - Auditoria (`auditoria`), Notificações (`notificacoes`), Incidentes (`incidentes`) e Chat (`chat_mensagens`).
   - Boletos DDA (`inter_dda_boletos`) e Histórico de Baixas (`conciliacao_baixas_historico`).
   - **Tabela Central de Tokens**: `api_tokens` (onde o n8n executa a rotação de tokens OAuth do Tiny ERP v3 a cada 4 horas).

2. **`marketplace`**:
   - Tabela antiga `dimensoes_produtos` (histórico; as medidas agora vêm do cadastro do Tiny).
   - Lê os tokens do Tiny de forma transparente em `financeiro.api_tokens`.

3. **`producao`**:
   - Histórico e dados operacionais de fábrica.
   - Espelha os tokens do Tiny em tempo real via **VIEW SQL**:
     ```sql
     CREATE OR REPLACE VIEW producao.api_tokens AS SELECT * FROM financeiro.api_tokens;
     ```

---

## 🚀 Como Executar Localmente

### 1. Pré-requisitos
- Node.js >= 22.13.0
- Python >= 3.11 com gerenciador de pacotes (`uv` ou `venv`)
- MariaDB local ou via Docker

### 2. Comandos Unificados a partir da Raiz

```bash
# Executar os testes do gateway, frontend, financeiro, produção e marketplace (o estoque roda à parte):
npm run test:all

# Executar testes específicos por camada:
npm run test:gateway       # Testes do Gateway Node.js (229 testes)
npm run test:frontend      # Testes do Frontend (202 testes)
npm run test:nfe           # Testes da Automação Financeira (660 testes)
npm run test:marketplace   # Testes da Automação Marketplace (89 testes)
npm run test:producao      # Testes da Impressão de Produção (47 testes)
npm run test:estoque       # Testes da Contagem de Estoque (68 testes; 3 dependem das fotos reais, fora desta cópia)
npm run test:marketing     # Testes da Automação de Marketing (35 testes)

# Subir os serviços em desenvolvimento:
npm run dev:mock           # Frontend em modo demonstração (sem backend) em http://localhost:3000
npm run dev:frontend       # Frontend em http://localhost:3000
npm run dev:gateway        # API Gateway em http://localhost:3100
npm run dev:nfe            # Motor Fiscal/Financeiro em http://localhost:8000
npm run dev:marketplace    # Motor Marketplace em http://localhost:8001
npm run dev:producao       # Servidor de Etiquetas em http://localhost:8003
npm run dev:estoque        # Bot Telegram de contagem de estoque

# Build e auditoria:
npm run build              # Gateway + frontend (export estático)
npm run audit              # gitleaks + npm audit + pip-audit (precisa de gitleaks e uv no PATH)
```

> **Regra Mock vs. Live:** na máquina local, rode sempre em modo demonstração/mock
> (`npm run dev:mock`, `DATA_MODE=demo` no gateway, `MOCK_MODE=true` nas automações). Nada de
> chamadas reais à SEFAZ, Banco Inter ou Tiny a partir do ambiente local.

---

## 🛡️ Arquitetura de Resiliência e Observabilidade Unificada (Fases 1 a 4)

O ecossistema implementa uma arquitetura de resiliência e fail-fast em camadas:

1. **Frontend — Polling Inteligente & Reatividade em Tempo Real (`DataPoller` & `useDataPolling`)**:
   - Suspensão imediata de polling periódico quando a aba está em segundo plano (`document.visibilityState === "hidden"`), poupando recursos e tráfego.
   - Retomada imediata do ciclo de consulta ao refocar na aba.
   - Cancelamento limpo de requisições pendentes com `AbortController` ao desmontar componentes ou atualizar manualmente.
   - Revalidação instantânea das telas via Server-Sent Events (`/api/events`) sempre que eventos de negócio ou alertas são emitidos.

2. **API Gateway — Circuit Breaker & Tracing Distribuído (`CircuitBreaker`)**:
   - Circuit Breakers dedicados para provedores externos (SEFAZ, Tiny ERP v3, Banco Inter e microsserviços Python).
   - Estados: `CLOSED` (normal), `OPEN` (bloqueio fail-fast imediato para proteger conexões) e `HALF_OPEN` (testes controlados de recuperação).
   - Preservação do sinal do cliente (`clientSignal`): cancelamento pelo usuário não infla métricas de falha do upstream.
   - Rastreamento fim a fim (`X-Request-Id`) propagado para os motores de automação Python.
   - Endpoint de telemetria dos circuitos: `GET /api/health/circuits` (somente sessão admin).

3. **Backend Fiscal/Financeiro — Resiliência Multinível & Timeouts Padronizados**:
   - Timeouts padronizados em tuplas `(connect, read)` nas integrações HTTP/SOAP externas (SEFAZ, Tiny ERP, Banco Inter).
   - Repositório de tokens OAuth (`token_repository.py`) com detecção de falhas transitórias do MariaDB, reconexão com backoff exponencial e período de carência (grace period) em cache de até 1 hora durante quedas momentâneas do banco.
   - Invalidação automática de tokens em cache sob HTTP 401 do Tiny ERP.
   - Auditoria estruturada em JSON (`app/audit.py` com `log_audit_event`) para telemetria e observabilidade.

4. **Painel Unificado de Saúde do Sistema (`SystemHealthMonitor` & `/admin/saude`)**:
   - Monitoramento amostrado a cada 5 minutos com retenção de 24 horas em memória.
   - Medição de latência real de consultas no MariaDB e descoberta ativa de múltiplos esquemas (`financeiro`, `marketplace`, `producao`).
   - Monitoramento automático de todos os Circuit Breakers e do motor `automacoes-marketplace`.

---

## 🐳 Infraestrutura em Produção (Docker VPS)

Na VPS de produção, os serviços rodam conteinerizados sob rede interna isolada, expostos através de proxy reverso NGINX com terminação SSL:

```
[ NGINX Proxy SSL — https://servidor.norvia.example ]
  ├── /automacoes/      ──► /var/www/automacoes (export estático do frontend)
  └── /automacoes/api/  ──► 3100 interface-web-gateway (Node.js API Gateway)
                              ├── 8000 ──► automacao-nfe (FastAPI Financeiro — sem porta publicada no host)
                              ├── 8001 ──► automacoes-marketplace (FastAPI Marketplace — sem porta publicada)
                              └── 3306 ──► mariadb (financeiro, marketplace, producao)
```

As imagens dos serviços Python e do gateway têm `TZ=America/Sao_Paulo` e `tzdata` (desde 2026-10-27): datas de negócio saem no fuso de São Paulo, não no UTC do container.

As chamadas do gateway às automações levam `X-Internal-Key` (`AUTOMATIONS_INTERNAL_KEY`, o mesmo
valor no gateway, no financeiro e no marketplace). O acesso pela LAN (`http://IP:3001` → API `:3100`)
não passa pelo NGINX. A aba Agentes Qwen recebe o estado do coletor de incidentes com `AGENTES_QWEN_TOKEN`
no gateway (o mesmo `INCIDENTES_TOKEN` do coletor; ver [scripts/README.md](scripts/README.md)). Detalhes de variáveis, volumes e headers em [docs/seguranca-deploy.md](docs/seguranca-deploy.md).

*(A automação de etiquetas da Produção roda localmente no PC da fábrica conectado via USB à impressora Elgin L42-DT, recebendo os comandos JSON diretamente dos tablets via rede local).*

### Deploy e Atualização na VPS

Todo o deploy é feito **na própria VPS** (desde 2026-11-04 nada é gerado nem enviado a partir do PC). No servidor de produção (`norviaServidor:~/norvia/interface-web`), o ciclo de atualização contínua após novos commits na branch `main`:

```bash
# 1. Puxar as últimas alterações do repositório:
git pull origin main

# 2. Reconstruir e subir os serviços alterados (sem derrubar o MariaDB):
docker compose up -d --build gateway automacao-nfe automacoes-marketplace

# 2b. Migrações novas em database/migrations/ (o init só roda com o volume vazio): conferir
#     pendentes e aplicar uma a uma, lendo o cabeçalho de cada (ver scripts/README.md):
scripts/migrate.sh
scripts/migrate.sh apply <arquivo.sql>

# 3. Conferir o status dos contêineres e logs de inicialização:
docker compose ps
docker compose logs --tail=30 gateway
docker compose logs --tail=30 automacao-nfe
```

O `--build` só recria o contêiner cuja imagem mudou: serviço sem código novo aparece como `Running`, e está certo.

O frontend publicado também é gerado na VPS e copiado com `rsync` local (destino **sempre** `/var/www/automacoes/`; o `--dry-run` mostra antes o que vai apagar):

```bash
cd ~/norvia/interface-web/frontend
npm ci && npm run build
rsync -av --delete --dry-run dist/client/automacoes/ /var/www/automacoes/
rsync -av --delete dist/client/automacoes/ /var/www/automacoes/
```

Para a revisão de 2026-10-27 (commits 2e8f721..f90a6e3), a ordem obrigatória está em [docs/deploy-2026-10-27.md](docs/deploy-2026-10-27.md): migrações antes do gateway, rebuild conjunto de gateway, financeiro, marketplace e contagem-estoque, e frontend logo depois.

O `docker-compose.yml` não é versionado e é de governança exclusivamente humana (ver `.codexrules`).

---

## 🔒 Segurança e Gestão de Segredos

- **Zero vazamento de credenciais:** Certificados digitais (`*.pfx`, `*.p12`, `*.crt`, `*.key`), senhas e arquivos `.env` jamais são incluídos no controle de versão.
- **Isolamento de Segredos:** O `.gitignore` raiz aplica proteção recursiva para `**/secrets/`, `**/certs/`, `**/data/*.json`, etc.
- **Hashing de Senhas:** Todas as senhas de usuários são cifradas com algoritmo `scrypt` com salt criptográfico único por usuário.
- **Sessões:** o banco guarda só o `sha256` do token; com o MariaDB fora, o gateway em live responde `503` (sem fallback em memória).
- **Chave interna:** as automações 8000/8001 recusam qualquer rota (menos `/health`) sem `X-Internal-Key`; a produção exige `X-Api-Key` (`CHAVE_API`).
- **CI e pre-commit:** `.github/workflows/security.yml` roda gitleaks (histórico inteiro), `npm audit` e `pip-audit`; o `.pre-commit-config.yaml` roda o gitleaks a cada commit.
- **Trilha de Auditoria:** Qualquer ação sensível (baixa de títulos, alteração de fretes, login, criação de operadores) é registrada de forma imutável na tabela `auditoria`.

---

## 📚 Documentação Complementar

- [Documentação do Gateway Backend](backend/gateway/README.md)
- [Documentação do Frontend](frontend/README.md)
- [Documentação da Automação Financeira](backend/automations/automacoes-financeiro/README.md)
- [Documentação da Automação Marketplace](backend/automations/automacoes-marketplace/README.md)
- [Documentação da Automação de Produção](backend/automations/automacoes-producao/README.md)
- [Documentação da Contagem de Estoque](backend/automations/contagem-estoque/README.md)
- [Rotinas de Backup do Sistema](scripts/backup/README.md)
- [Contrato Analítico e Indicadores Fiscais](docs/metrics.md)
- [Contrato da Visão Geral Consolidada](docs/overview-metrics.md)
- [Manual de Integrações Operacionais](docs/integration.md)
- [Segurança e Deploy (variáveis, volumes, NGINX, CI)](docs/seguranca-deploy.md)
- [Deploy da revisão de 2026-10-27 (migrações, rebuild, frontend e backup)](docs/deploy-2026-10-27.md)
- [Orquestrador e agentes especialistas](orchestrator.md) · [registry.json](registry.json) · [.codexrules](.codexrules)
