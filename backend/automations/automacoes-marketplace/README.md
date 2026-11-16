# Automações de Marketplace

Serviço Python (FastAPI, porta 8001) da área **Marketplace**, com duas automações, cada uma com
sua tela em **Marketplace**:

1. **Padronização de dimensões** (`app/padronizacao.py`, rotas `/api/v1/dimensoes/*`)
2. **Tipo de frete** (`app/rotina.py`, rotas `/api/v1/fretes/*`; tela "Tipo de frete")

**Carrinhos** (título com "carrinho") ficam fora das duas.

## 1. Padronização de dimensões

O **Tiny é a fonte da verdade** das medidas. Para cada anúncio do ML, pega o SKU e lê no Tiny
**da mesma empresa** (`TINY_CONTA_POR_FILIAL`: ML Norvia → `norvia_campinas`, ML Revesta →
`revesta`) altura, largura, comprimento e **peso bruto**. Medida de outra empresa não vale.

Coleta diária às `DIMENSOES_HORA_COLETA` (6h) ou pelo botão da tela:

- **Mercado Livre** primeiro (as duas contas): anúncios, SKUs, os atributos de medida que a ficha
  já usa (`HEIGHT/THICKNESS/WIDTH/LENGTH/WEIGHT/NET_WEIGHT`) e a embalagem (`SELLER_PACKAGE_*`).
  Anúncios sem SKU no ML aparecem numa lista à parte.
- **Tiny**: só os SKUs anunciados naquela conta; o cadastro só é relido quando `dataAlteracao`
  muda (`cache_tiny`).
- Progresso na tela e no log (`[DIMENSOES] etapa: feitos/total`).
- Cada anúncio fica **igual**, **diferente** (a enviar), **sem medida** (Tiny sem lado ou peso
  bruto) ou **fora do Tiny** (SKU não encontrado; Tiny que não respondeu não vira "não
  encontrado"). Tolerância: 0,5 cm na ficha; lados ±0,5 cm ou 3% e peso ±10 g ou 5% na embalagem.

**Automático com confirmação**: a coleta não envia nada. Na tela, alguém seleciona os produtos
a enviar e confirma em lote (sem editar medidas). O envio, em segundo plano, vai **só ao ML** e só
com o que está diferente:

- **Ficha técnica**: as medidas do Tiny nos atributos de medida que o anúncio já usa (`WEIGHT` =
  peso bruto, `NET_WEIGHT` = peso líquido). Se o ML recusar a ficha, a embalagem vai sozinha.
- **Embalagem** (`SELLER_PACKAGE_*`): as medidas do Tiny, com o peso bruto.

**Nada é gravado no Tiny.** A tabela `dimensoes_produtos` não é mais usada (fica como histórico).
O resultado fica por anúncio, com reenvio dos que falharam.

**Embalagem**: altura, largura e comprimento do cadastro do Tiny, como estão (o ML só aceita
inteiros: lado com fração sobe), com o peso bruto. Até 28/10/2026 era a padrão 5 x 7 x
100/200/300 cm, que em boa parte dos anúncios voltava no ML para as medidas do cadastro.

## 2. Tipo de frete

Usa as medidas do Tiny da mesma empresa (última coleta da Padronização). Envio indicado pelo
maior lado da embalagem: até `ME2_MAX_EMBALAGEM_CM` (200: embalagem de **1 m e 2 m**) é **ME2**; a de
**3 m** é **ME1** (só nas contas de `ML_CONTAS_COM_ME1`; nas outras fica bloqueado).

- **Rotina diária** (`FRETES_HORA_DIARIA`, 7h) e botão "Verificar agora": só os anúncios **a
  combinar** — envia as medidas da embalagem (com o peso bruto; o ML só aceita inteiros) e troca
  para o envio indicado. SKU sem medida/peso bruto no Tiny não é alterado.
- **"Corrigir tipo de frete"** (botão, permissão `fretes:corrigir_tipo`, `POST
  /api/v1/fretes/corrigir-tipo`): faz o mesmo e também troca os anúncios já em ME1/ME2 cujo tipo
  não bate com a embalagem (ex.: 2 m em ME1). Anúncios no Full (`fulfillment`) ficam de fora.
- Toda alteração é **conferida `FRETES_MINUTOS_CONFERENCIA` (10) minutos depois**. Se o ML
  desfez, vai para o card **ML desfez**, com nova tentativa em lote.

**Ordem recomendada** na primeira vez: coletar → confirmar o envio das medidas → "Corrigir tipo
de frete". Depois disso a rotina diária cuida dos novos a combinar.

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
ler os tokens do Tiny em `financeiro.api_tokens` (`TINY_TOKENS_DB`). O banco `marketplace`
(`DB_NAME`) guarda só a tabela antiga `dimensoes_produtos`, que não é mais gravada:

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
- **Retentativas (`app/retry.py`)**: até 4 tentativas com backoff exponencial, jitter e `Retry-After` (teto de 60 s), nas chamadas ao ML e ao Tiny. 429 é repetido em qualquer método; 5xx e falha de rede só em leitura (GET). Um POST só é repetido no 429 (o servidor recusou antes de processar).
- **Jobs órfãos no startup (`recuperar_orfaos`, `app/api.py`)**: se o serviço reiniciar no meio de uma coleta ou verificação, ela vira `interrompida` com aviso no histórico. Um envio que estava `enviando` vira `erro` no destino `interrompido` ("reenvie o produto"). Nada fica "em execução" para sempre.
- **Limite de 200 itens**: `skus` e `anuncios` aceitam no máximo 200 por requisição (`app/api.py`, `max_length=200`). O gateway recusa com `400` as listas acima de 200 (SEC-08), porque cada item vira uma chamada ao ML.
- **Fuso e tzdata**: datas de negócio em `America/Sao_Paulo` (`FUSO_SP` em `app/config.py`). A imagem tem `TZ` e `tzdata`.

---

## 🧪 Testes e Desenvolvimento Local

```bash
# A partir da raiz do monorepo:
npm run test:marketplace

# Ou dentro de backend/automations/automacoes-marketplace:
uv run --with-requirements requirements.txt pytest tests/ -q
```
*(62 testes automatizados cobrindo API FastAPI, rotinas de fretes, padronização de dimensões e clientes ML/Tiny).*
