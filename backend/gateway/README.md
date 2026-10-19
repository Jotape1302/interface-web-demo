# API Gateway Central — Norvia Automações

API Gateway central corporativo em **Node.js 22+ e TypeScript** (porta `3100`), desenvolvido sobre o módulo HTTP nativo do Node.js (sem frameworks pesados), responsável por roteamento, autenticação, controle de acesso por usuário (RBAC: abas × ações), barramento de eventos em tempo real (SSE) e proxy reverso para os motores de automação.

---

## 🏛️ Responsabilidades Arquiteturais

```
                                  [ Navegador / Frontend (vinext)  ]
                                                │
                                                ▼ (HTTP / SSE / Cookies / Bearer)
                        ┌────────────────────────────────────────────────┐
                        │          API Gateway (Porta 3100)              │
                        │  - Rate Limiting & Proteção contra abuso       │
                        │  - Autenticação e Sessões (MariaDB + scrypt)   │
                        │  - RBAC por usuário (abas × ações)             │
                        │  - Barramento de Eventos SSE (/api/events)     │
                        │  - Trilha Unificada de Auditoria               │
                        │  - Agregação de Telemetria (/api/overview)     │
                        └───────────────────────┬────────────────────────┘
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 ▼                              ▼                              ▼
    [ automacoes-financeiro ]       [ automacoes-marketplace ]         [ MariaDB ]
      FastAPI (Porta 8000)             FastAPI (Porta 8001)           (Porta 3306)
     - NF-e SEFAZ A1 Multi-CNPJ       - Padronização de Dimensões   - financeiro
     - Banco Inter PJ API v2          - Fretes a Combinar (ME1/ME2) - marketplace
     - Dashboard Financeiro & DRE     - Sincronização Tiny/Meli     - producao
     - Conciliação e Baixas Tiny
```

---

## 🔐 Controle de Acesso (RBAC por usuário, 2026-10-08)

O acesso vem das **permissões de cada usuário** (abas × ações), não do setor. Fonte da verdade: `src/permissions.ts`.

- **Perfis:** `admin` (acesso total implícito), `gestor` (só o que o admin liberar; pode receber ações de Gestão de
  Usuários, sempre sobre usuários `user`) e `user`. O ROOT (`usuarios.is_root`) é intocável por terceiros.
- **Chave** = `<aba>:<acao>` (ex.: `contas_pagar:baixar`; `ver` abre a aba). Catálogo para o editor:
  `GET /api/admin/permissions/catalog`. Linhas legadas sem `:` ficam inertes.
- **Negado por padrão:** toda `/api/*` passa por `routeAccess` (`ROUTE_RULES`) em `server.ts` — `public`, `free`
  (qualquer logado: perfil próprio, chat, notificações próprias, eventos, catálogo), `scoped` (incidentes),
  `admin` (troca de perfil, emissão manual de notificação) ou `perm` (aba × ação). Rota sem regra → 404 mesmo com
  sessão; `test/permissions-coverage.test.ts` falha se surgir rota sem mapeamento.
- **Ações de risco** (`revisao_nfe:forcar_varredura`, `dashboard_financeiro:forcar_sincronizacao`) são conferidas
  na rota quando há `?force=true`.
- **Setor** é só rótulo de equipe (cadastro, exibição, envio manual por setor); não dá acesso.
- **Notificações** seguem a permissão: avisos de Marketplace → `dimensoes:ver`/`fretes:ver`; conciliação ML →
  `conciliacao_ml:ver`; certificados A1 → `revisao_nfe:ver`; incidentes → `erros:ver`; cadastro pendente →
  `usuarios:aprovar_cadastro`; alteração de cadastro de User → `usuarios:revisar_alteracao` (admins sempre recebem).
- **Mudança de perfil/permissões** vale na próxima requisição (`findSession` relê tudo) e dispara o evento SSE
  `session` para o alvo.

### Segurança (correções de 2026-10-06)

- **Sessões:** o banco guarda só `sha256(token)`; o painel admin lista e encerra sessões pelo `public_id`
  (`database/migrations/2026-10-06-sessoes-token-hash.sql` — sessões abertas antes do deploy caem e todos
  logam de novo uma vez). Em live não há fallback em memória: MariaDB fora → `503`.
- **Senhas:** `crypto.scrypt` assíncrono, N=2^17 (formato `scrypt$N$r$p$hex`); hashes antigos continuam
  válidos e são regravados no primeiro login. Mínimo de 10 caracteres. Troca de senha encerra as demais sessões.
- **Login:** bloqueio por (login + IP) e por IP; por conta só há atraso progressivo (1s, 2s, 4s… até 8s) —
  terceiros não conseguem trancar a conta do admin.
- **Cadastro:** resposta neutra para e-mail repetido; nasce sem permissões. A aprovação
  (`POST /api/admin/users/:id/approve`, `{ "username"?, "setor"?, "grants"? }`) e a rejeição
  (`POST /api/admin/users/:id/reject`) operam estritamente sobre status `pending` (alvo fora de pending
  devolve 409 `not_pending` para Admin e Gestor, via transição condicional no banco; auditoria só no sucesso).
- **Corpo JSON:** máx. 1 MB (`413`), `Content-Type: application/json` obrigatório quando há corpo (`415`).
- **Erros:** respostas `500` trazem só mensagem genérica + `requestId`; o detalhe fica no log.
- **Automações:** toda chamada às automações 8000/8001 leva `X-Internal-Key` (`AUTOMATIONS_INTERNAL_KEY`),
  `X-Request-Id` e, nas ações do usuário, `X-Usuario` (login da sessão). Ver `src/automation-http.ts`.
- **IP do cliente:** socket; `X-Forwarded-For`/`X-Real-IP` só de `TRUSTED_PROXIES`.

### Reauditoria de 2026-10-07

- **SEC-01:** `DATA_MODE` é obrigatória com `NODE_ENV=production` (a imagem Docker); em `demo`, requisição sem
  token só lê — ações exigem sessão, porque as rotas de proxy falam com as automações reais.
- **SEC-04:** conciliação ML e dashboard financeiro com abas próprias no catálogo (acima); a tarefa da conciliação ML é
  consultada em `/api/v1/conciliacao-ml/jobs/:id`, que não enxerga tarefas da conciliação Inter (e vice-versa).

---

## 🔌 Catálogo de Rotas e Endpoints

### 1. Autenticação e Usuários
- `POST /api/auth/login`: Autenticação por e-mail e senha com hash seguro `scrypt`.
- `POST /api/auth/logout`: Revogação da sessão ativa.
- `GET /api/auth/me`: usuário autenticado + `permissions` efetivas (admin = catálogo inteiro).
- `GET /api/admin/permissions/catalog`: catálogo de abas × ações (qualquer logado).
- `GET /api/admin/users` (`usuarios:ver`): lista com `is_root`, `version`, `permissions_count`, alterado por/em.
- `POST /api/admin/users` (`usuarios:criar`): `{ nome, username?, email, setor, senha, role?, grants? }`; erros 400 com `code` + `field`.
- `GET|PUT /api/admin/users/:id/permissions` (`usuarios:ver` / `usuarios:editar_permissoes`): `{ grants, expectedVersion }`, conflito → 409.
- `PUT /api/admin/users/:id/role` (só Admin): `{ role }`.
- `PUT /api/admin/users/:id/setor` (`usuarios:alterar_setor`).

### 2. Notificações, Chat e Eventos em Tempo Real
- `GET /api/events`: Stream contínuo via **Server-Sent Events (SSE)** para alertas e mensagens em tempo real.
- `GET /api/notifications`: Notificações do usuário logado (os avisos automáticos seguem as permissões).
- `PATCH /api/notifications/:id/read`: Marcação de notificação como lida.
- `GET /api/chat/messages` & `POST /api/chat/messages`: Canal de chat operacional interno com registro de auditoria.

### 3. Saúde do Sistema, Resiliência e Auditoria
- `GET /health`: público, `{ "status": "ok" }` (processo vivo).
- `GET /api/health`: público, `{ "status": "ok" | "degraded" }` (200/503) agregando Tiny + Inter, com cache de 30 s. Sem detalhes.
- `GET /api/health/{tiny,inter,n8n,circuits}` (e `/health/...`): detalhes por conector e circuitos — exige `saude:ver`.
- `GET /api/admin/system-health`: Monitoramento administrativo contínuo (amostrado a cada 5min, histórico 24h, latência do MariaDB e saúde do marketplace).
- `GET /api/admin/audit`: Relatório completo de auditoria com filtro por período, usuário, setor e tipo de ação.

### 4. Proxies Especializados de Negócio
- `/api/danfe/*` $\rightarrow$ Repassado para `automacao-nfe:8000` (varredura SEFAZ, upload de DANFEs, revisão humana).
- `/api/financial-dashboard/*` $\rightarrow$ Repassado para `automacao-nfe:8000` (fluxo de caixa, DRE, inadimplência e insights).
- `/api/reconciliation/*` $\rightarrow$ Repassado para `automacao-nfe:8000` (extratos Inter e conciliação Tiny).
- `/api/ml-reconciliation/*` $\rightarrow$ Repassado para `automacao-nfe:8000` em `/api/v1/conciliacao-ml/*` (status, `executar`, `execucoes`, `analises` e arquivos, `jobs/baixar`). Os avisos da rotina diária viram notificação para quem vê a Conciliação ML.
- `/api/marketplace/*` $\rightarrow$ Repassado para `automacoes-marketplace:8001` (coleta e validação de dimensões e fretes Mercado Livre).
- `/api/overview` $\rightarrow$ Agregação dos dados consolidados das automações ativas com janela móvel de 14 dias em São Paulo (UTC−03).
- `/api/reconciliation/estado` $\rightarrow$ Repassado para `automacao-nfe:8000` em `/api/v1/reconciliacao/estado`: pendências persistidas de Contas a Pagar (Inter × Tiny), gravadas em `DATA_DIR/contas_pagar/estado.json` pela rotina diária.

### 5. Contagem de Estoque (lida pelo gateway, não proxy)

O gateway **não** chama o bot de contagem: lê `CONTAGEM_REGISTRO_DIR/contagens.json` e as fotos em `imagens/`, e guarda a conferência, o SKU informado no painel e as exclusões no MariaDB (`backend/gateway/src/stock-sku.ts`, criadas no boot).

- `GET /api/stock-count/contagens` (`contagem_estoque:ver`): lista as contagens com conferência e SKU do painel já aplicados.
- `GET /api/stock-count/imagens/:id/anotada` e `GET /api/stock-count/imagens/:id/original` (`contagem_estoque:ver`): JPEG da foto anotada ou da original. O `:id` é o identificador de 12 caracteres hex da contagem (`^[a-f0-9]{12}$`); há barreira contra path traversal.
- `POST /api/stock-count/contagens/:id/conferir` (`contagem_estoque:conferir`): confirma ou corrige a quantidade. Grava em `contagem_estoque_conferencia`.
- `POST /api/stock-count/contagens/:id/sku` (`contagem_estoque:informar_sku`): informa o SKU de contagem sem produto (`sem_produto`). Grava em `contagem_estoque_sku_manual`; recusa com 409 se o bot já identificou o SKU.
- `DELETE /api/stock-count/contagens/:id` (`contagem_estoque:excluir`): exclusão lógica em `contagem_estoque_excluidas`. Não altera `contagens.json` nem as fotos.

O diretório é **somente leitura** para o gateway (ele nunca grava nele). No compose do servidor, monte `backend/automations/contagem-estoque/temp/registro` no gateway com `:ro` e dê ao usuário do container (uid 1000, conferir com `docker compose exec gateway id`) acesso de leitura por ACL, pelo mesmo cálculo de subuid de `docs/seguranca-deploy.md` §4.1. O snippet de compose é governança humana e fica fora do repositório.

---

## 🛡️ Resiliência, Circuit Breaker e Rastreabilidade

- **Padrão Circuit Breaker (`src/circuit-breaker.ts`)**:
  - Protege o gateway contra degradação em cascata decorrente de falhas ou lentidão em provedores externos (SEFAZ, Tiny ERP v3, Banco Inter e microsserviços Python).
  - Três estados: `CLOSED` (operação normal), `OPEN` (bloqueio fail-fast imediato sem prender conexões), e `HALF_OPEN` (testes controlados de recuperação).
  - Preserva requisições canceladas pelo cliente (`clientSignal`): abort voluntário do usuário não é contabilizado como falha de infraestrutura.
- **Rastreabilidade Distribuída (`X-Request-Id`)**:
  - Cada requisição que entra no Gateway recebe um identificador de correlação único (`req_<timestamp>_<hash>`), repassado automaticamente nos headers para os microsserviços Python (`automacao-nfe` e `automacoes-marketplace`).

---

## ⚙️ Variáveis de Ambiente (`.env`)

Copie `backend/gateway/.env.example` para `backend/gateway/.env`:

```env
PORT=3100
DATA_MODE=live
# Só estas origens (sem curingas de IP privado/ddns). Produção:
CORS_ORIGINS=https://servidor.norvia.example
# Chave enviada às automações (X-Internal-Key). Mesmo valor no .env das automações; mín. 32 caracteres.
AUTOMATIONS_INTERNAL_KEY=
# Proxies cujos X-Forwarded-For/X-Real-IP valem (IP/CIDR, vírgula). Padrão: loopback + faixas privadas.
TRUSTED_PROXIES=

# Banco de dados MariaDB
DB_HOST=mariadb
DB_PORT=3306
DB_USER=root
DB_PASSWORD=sua_senha
DB_NAME=financeiro

# Motores Python Internos
DANFE_API_URL=http://automacao-nfe:8000
MARKETPLACE_API_URL=http://automacoes-marketplace:8001

# Integração n8n
N8N_BASE_URL=https://n8n.seuservidor.com
N8N_API_KEY=sua_chave_n8n
# Contagem de Estoque (somente leitura: contagens.json e imagens/ anotadas e originais, montados com :ro)
CONTAGEM_REGISTRO_DIR=/app/data/contagem_estoque/registro
```

---

## 🧪 Testes Automatizados

O gateway possui uma suíte completa de testes unitários e de integração utilizando o runner nativo do Node.js (`node:test`):

```bash
# Executar a partir da raiz do monorepo:
npm run test:gateway

# Ou diretamente dentro de backend/gateway:
npm test
```
*(137 testes automatizados cobrindo rotas, autenticação, circuit breakers, auditoria, RBAC, histórico, contagem de estoque e observabilidade: 136 pass, 1 skip).*
