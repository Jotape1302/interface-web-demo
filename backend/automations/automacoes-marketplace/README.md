# Automações de Marketplace

Serviço Python (FastAPI, porta 8001) da área **Marketplace**, com duas automações, cada uma com
sua tela em **Marketplace**:

1. **Padronização de dimensões** (`app/padronizacao.py`, rotas `/api/v1/dimensoes/*`)
2. **Tipo de frete** (`app/rotina.py`, rotas `/api/v1/fretes/*`; tela "Tipo de frete")

**Carrinhos** (título com "carrinho") ficam fora das duas.

## 1. Padronização de dimensões

Medida do **produto real** (altura, largura, comprimento e peso), por **SKU**. Convenção:
comprimento = maior lado, altura = menor.

Coleta diária às `DIMENSOES_HORA_COLETA` (6h) ou pelo botão da tela:

- **Mercado Livre** primeiro (as duas contas): anúncios e SKUs — título, descrição e ficha
  técnica do produto (`HEIGHT/WIDTH/LENGTH/THICKNESS/WEIGHT`…). A descrição só é relida quando
  o anúncio muda. Anúncios sem SKU no ML aparecem numa lista à parte.
- **Tiny** (`TINY_CONTAS`: Norvia Campinas e Revesta): nome, descrição e dimensões/peso do
  cadastro, **só dos SKUs anunciados** (`DIMENSOES_SO_ANUNCIADOS`; o cadastro é lido um a um e
  todos os produtos levariam horas). O cadastro só é relido quando muda.
- Progresso na tela e no log (`[DIMENSOES] etapa: feitos/total`); os caches são gravados aos
  poucos, então um restart no meio não perde o que já foi lido.
- As medidas de cada fonte são comparadas (lados sem ordem, ±0,5 cm ou 3%; peso ±10 g ou 5%):
  **alta** = todas as fontes com medida batem; **média** = a maioria bate ou só uma fonte;
  **baixa** = conflito ou nenhuma medida. O peso conta junto (o ML exige peso).
- **Tudo passa por revisão humana** na tela, com a medida de cada local e o valor sugerido.

Ao **validar** (em lote): grava em `dimensoes_produtos` (MariaDB) e, em segundo plano, envia:

- **Tiny**: `PUT /produtos/{id}` em todas as contas onde o SKU existe (dimensões em cm, peso
  líquido e bruto em kg; `sku` e `descricao` vão como estão no cadastro, exigência da API).
- **Mercado Livre**: ficha técnica (só os atributos de medida que o anúncio já usa) e as medidas
  da **embalagem padrão** (`SELLER_PACKAGE_*`).

O resultado fica por destino, com reenvio. Produto padronizado cuja ficha (Tiny ou ML) mudar
depois volta como pendência **divergente do padrão**.

**Embalagem padrão**: seção `EMBALAGEM_SECAO_CM` (5 x 7 cm) e o menor comprimento de
`EMBALAGEM_COMPRIMENTOS_CM` (100, 200, 300 cm) que caiba o produto. Produto que não cabe não
tem embalagem automática.

## 2. Tipo de frete

Todo dia às `FRETES_HORA_DIARIA` (7h), para cada conta do ML:

1. Sincroniza os anúncios e pega as **dimensões padronizadas** do SKU (sem padrão, o anúncio
   não é alterado: aparece em "Sem dimensões padronizadas").
2. Envio indicado pela embalagem padrão: **ME2** se o ML marca o anúncio com `me2_available` ou
   se a embalagem cabe em `ME2_MAX_*`; senão **ME1** (só nas contas de `ML_CONTAS_COM_ME1`).
3. Anúncio **a combinar**: envia as medidas da embalagem (com o peso do produto; o ML só aceita
   inteiros) e troca para o envio indicado.
4. Toda alteração é **conferida `FRETES_MINUTOS_CONFERENCIA` (10) minutos depois**. Se o ML
   desfez, vai para o card **ML desfez**, com nova tentativa em lote.

Notificações (produtos a padronizar, frete desfeito, falha da rotina) vão pelo gateway só para
os usuários do setor E-Commerce/Marketplace e para os admins.

## Tokens do Mercado Livre

A automação **não renova** os tokens do ML: isso fica com um fluxo externo (n8n ou similar,
ainda a definir). Ela só lê o access token de cada conta, a cada chamada, de:

1. `data/ml_tokens.json` — onde o fluxo externo deve gravar o token renovado:
   ```json
   {"norvia": {"access_token": "APP_USR-...", "renovado_em": "2026-09-29T07:00:00"},
    "revesta": {"access_token": "APP_USR-..."}}
   ```
   (`user_id` opcional; sem ele a automação consulta `/users/me`);
2. senão `ML_<CONTA>_ACCESS_TOKEN` do `.env` (só para teste: o token expira em 6 h).

Conta sem token, ou com token expirado (HTTP 401), fica de fora da verificação e aparece como
sem conexão na tela.

## Deploy (servidor, Docker rootless)

No `docker-compose.yml` do servidor (fora do git):

```yaml
  automacoes-marketplace:
    build: ./backend/automations/automacoes-marketplace
    restart: unless-stopped
    env_file: ./backend/automations/automacoes-marketplace/.env
    environment:
      - TZ=America/Sao_Paulo
    volumes:
      - ./backend/automations/automacoes-marketplace/data:/app/data
```

e no `environment` do gateway: `MARKETPLACE_API_URL=http://automacoes-marketplace:8001`.

O `.env` precisa das variáveis `DB_*` (mesmo servidor MariaDB da automacoes-financeiro) para
gravar `dimensoes_produtos` no banco **`marketplace`** (`DB_NAME`) e ler os tokens do Tiny em
`financeiro.api_tokens` (`TINY_TOKENS_DB`). O banco `marketplace` precisa existir e o usuário
precisa de acesso a ele (a tabela é criada sozinha):

```sql
CREATE DATABASE IF NOT EXISTS marketplace CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON marketplace.* TO '<usuario>'@'%';
GRANT SELECT ON financeiro.api_tokens TO '<usuario>'@'%';
FLUSH PRIVILEGES;
```

Permissões da pasta `data/` (dono 1003 + `setfacl` para o subuid do container, segredos 700/600): ver [docs/seguranca-deploy.md §4](../../../docs/seguranca-deploy.md#4-permissões-dos-volumes-fim-do-chmod-757).

**Chave interna**: defina `AUTOMATIONS_INTERNAL_KEY` (a mesma do gateway) no `.env`. Todas as rotas
exigem `X-Internal-Key`, menos `/health` e `/api/v1/health` (status mínimo); sem a variável, `503`.
O autor gravado em validações/retentativas vem do header `X-Usuario` do gateway (o `usuario` do corpo
só vale sem o header). Não publique a porta 8001 no host (hoje não está publicada). Os tokens do ML
(`data/ml_tokens.json`) são gravados `0600` — a automacoes-financeiro, que lê o mesmo arquivo, roda
com o mesmo uid (1000) no container, e o backup lê via `nsenter -U`.

---

## 🛡️ Resiliência e Observabilidade com o Gateway

- **Circuit Breaker Dedicado**: Todas as chamadas repassadas pelo Gateway (`/api/marketplace/*` $\rightarrow$ `/api/v1/*`) são protegidas por uma instância do `CircuitBreaker("marketplace")`. Em caso de instabilidade, o Gateway aplica fail-fast imediato (0ms), poupando recursos e alertando os operadores.
- **Rastreabilidade (`X-Request-Id`)**: O Gateway gera e repassa o identificador de correlação para as rotas do marketplace, facilitando o diagnóstico conjunto de logs.
- **Health Check Nativo (`GET /health`)**: Expõe `{"status": "ok", "service": "automacoes-marketplace"}`, verificado continuamente pelo monitor de saúde do Gateway (`marketplaceEngineCheck`) a cada 5 minutos.

---

## 🧪 Testes e Desenvolvimento Local

```bash
# A partir da raiz do monorepo:
npm run test:marketplace

# Ou dentro de backend/automations/automacoes-marketplace:
uv run --with-requirements requirements.txt pytest tests/ -q
```
*(65 testes automatizados cobrindo API FastAPI, rotinas de fretes, padronização de dimensões e clientes ML/Tiny).*
