# Segurança no deploy (VPS Norvia)

Passo a passo das mudanças de infraestrutura das correções de segurança de 2026-10-06.
Tudo aqui é **manual** e fica fora do git: `docker-compose.yml` (governança humana, os
agentes não editam), `.env` reais, NGINX (do analista), MariaDB e configurações do GitHub.

Premissas: Docker **rootless** (usuário `jotape1302`, uid 1003, sem sudo). O repositório
e o `docker-compose.yml` (fora do git) ficam em `~/norvia/interface-web`: rode todo
`docker compose ...` dali. `servidor.norvia.example` é **público**,
então trate o painel, o gateway e qualquer porta publicada como alcançáveis pela internet.

Sumário:

1. [Ordem do deploy](#1-ordem-do-deploy)
2. [Variáveis novas (inventário)](#2-variáveis-novas-inventário)
3. [docker-compose: portas e rede](#3-docker-compose-portas-e-rede)
4. [Permissões dos volumes (fim do chmod 757)](#4-permissões-dos-volumes-fim-do-chmod-757)
5. [MariaDB: conferir e restringir grants](#5-mariadb-conferir-e-restringir-grants)
6. [NGINX: restringir o acesso ao painel](#6-nginx-restringir-o-acesso-ao-painel)
7. [Headers de segurança do NGINX](#7-headers-de-segurança-do-nginx)
8. [Backup: usuário só leitura e criptografia](#8-backup-usuário-só-leitura-e-criptografia)
9. [Varredura de segredos e dependências (CI)](#9-varredura-de-segredos-e-dependências-ci)
10. [GitHub: Secret Scanning, Push Protection e proteção da main](#10-github-secret-scanning-push-protection-e-proteção-da-main)
11. [Imagens Docker](#11-imagens-docker)
12. [Deploy e migração do RBAC por usuário (2026-10-08)](#12-deploy-e-migração-do-rbac-por-usuário-2026-10-08)

---

## 1. Ordem do deploy

O gateway e as duas automações HTTP (financeiro e marketplace) passam a conversar com a
chave interna `AUTOMATIONS_INTERNAL_KEY`. **Os três sobem juntos e com o mesmo valor.**
Se um deles estiver sem a chave ou com outra, o painel fica com `401`/`503` nas telas de
NF-e, Dashboard Financeiro, Contas a Pagar e Marketplace.

```bash
# 0) Gerar a chave UMA vez (guarde no gerenciador de senhas):
openssl rand -hex 32

# 1) Código novo
cd ~/norvia/interface-web && git pull --ff-only origin main

# 2) Editar o docker-compose.yml (seções 2 e 3 abaixo): variáveis, porta 3100 só em
#    127.0.0.1, porta 8000 fora do host (se o gateway usa a rede docker).

# 3) Gateway + financeiro + marketplace JUNTOS. --build é obrigatório: requirements.txt,
#    Dockerfiles e imagens base mudaram.
cd ~/norvia/interface-web
docker compose up -d --build gateway automacao-nfe automacoes-marketplace

# 4) Conferir
docker compose ps
docker compose logs --tail=50 gateway automacao-nfe automacoes-marketplace
curl -s http://127.0.0.1:3100/health                       # {"status":"ok"}
docker compose exec gateway wget -qO- http://automacao-nfe:8000/health
ss -ltn | grep -E ':(3100|8000|8001)\b'                     # 3100 só em 127.0.0.1; 8000/8001 ausentes
```

5. **Frontend estático** (depois do gateway, porque o painel novo espera as respostas novas).
   O destino é **`/var/www/automacoes/`** (o NGINX serve `servidor.norvia.example/automacoes/`
   dali). Use o comando do `frontend/README.md`. Em resumo:
   ```bash
   cd ~/norvia/interface-web/frontend
   npm ci && npm run build                     # export estático (basePath /automacoes)
   # Só dist/client/automacoes/ é publicado. Veja o que muda antes do --delete:
   rsync -a --delete --dry-run dist/client/automacoes/ /var/www/automacoes/
   rsync -a --delete dist/client/automacoes/ /var/www/automacoes/
   ```
   O `--dry-run` serve para ver o que vai mudar antes de apagar algo em `/var/www/automacoes/`.
6. **Bot de contagem de estoque**: `TELEGRAM_ALLOWED_USERS`/`TELEGRAM_ALLOWED_CHATS` no
   environment e `docker compose up -d --build <serviço do bot>`.
7. **PC das etiquetas** (fora da VPS): ver [2.4](#24-pc-das-etiquetas-automacoes-producao-windows).
8. Depois, sem pressa: volumes (seção 4), MariaDB (5), NGINX (6/7), backup (8), GitHub (10).

**Sessões:** a migração `database/migrations/2026-10-06-sessoes-token-hash.sql` passa a
guardar só o hash do token. O gateway a aplica sozinho no boot (idempotente), então rodá-la
à mão é opcional:
`docker exec -i <container-mariadb> mariadb -u<usuário> -p financeiro < interface-web/database/migrations/2026-10-06-sessoes-token-hash.sql`.
Todos precisam **logar de novo uma vez** depois do deploy.

---

## 2. Variáveis novas (inventário)

Conferido nos `.env.example` e READMEs de cada módulo. No compose, use o `environment:` do
serviço (ou o `.env`/`env_file` do módulo, se o seu compose usa `env_file`). Para a chave
ficar igual nos três serviços, defina-a uma vez no `.env` ao lado do `docker-compose.yml`
(`chmod 600`), que o compose interpola:

```bash
# ~/norvia/interface-web/.env  (ao lado do docker-compose.yml, fora do git, chmod 600)
AUTOMATIONS_INTERNAL_KEY=<saída do openssl rand -hex 32>
```

### 2.1 Gateway (`backend/gateway/.env.example`)

| Variável | Valor em produção | Observação |
|---|---|---|
| `DATA_MODE` | `live` | **Obrigatória.** Desde 2026-10-07 (SEC-01) a imagem (`NODE_ENV=production`) não sobe sem ela — antes, sem a variável, o gateway caía em `demo`, que libera rotas sem login. Em `demo`, ações (POST/PUT/PATCH/DELETE) exigem sessão. |
| `AUTOMATIONS_INTERNAL_KEY` | `${AUTOMATIONS_INTERNAL_KEY}` | **Obrigatória.** Mesmo valor das automações, mínimo 32 caracteres. Vai no header `X-Internal-Key` de toda chamada às portas 8000/8001. |
| `CORS_ORIGINS` | `https://servidor.norvia.example` | **Obrigatória**, sem curinga (nada de `*`, IP privado ou `*.ddns.net`). |
| `TRUSTED_PROXIES` | vazio no começo, depois o IP do NGINX | Vazio = loopback + faixas privadas. Só é seguro com a porta 3100 publicada **apenas em 127.0.0.1** (seção 3.1). Para fixar o IP certo, ver abaixo. |
| `ADMIN_BOOTSTRAP_PASSWORD` | remover | Só é usada no seed, quando o admin ainda não existe. Com o admin criado, tire do environment. |
| `DANFE_API_URL` / `PYTHON_API_URL` | `http://automacao-nfe:8000` | Já existiam. Defina as duas explicitamente (seção 3.2). |

**Descobrir o IP do NGINX para o `TRUSTED_PROXIES`.** No Docker rootless a conexão do NGINX
chega ao container com o IP da rede docker/slirp (ex.: `10.0.2.100` ou `172.18.0.1`), não
`127.0.0.1`. O gateway registra o IP que vê no log `untrusted_forwarded_header`, mas só
quando ele **não** é confiável. Por isso, para descobrir:

```bash
# 1) Temporariamente: TRUSTED_PROXIES=none no environment do gateway
docker compose up -d gateway
# 2) Abra o painel no navegador (qualquer requisição via NGINX) e veja:
docker compose logs gateway | grep untrusted_forwarded_header
#   {"event":"untrusted_forwarded_header", ..., "socketIp":"10.0.2.100"}
# 3) Fixe esse IP e suba de novo:
#   TRUSTED_PROXIES=10.0.2.100/32
docker compose up -d gateway
```

Enquanto estiver com `none`, o limite de login por IP trata todo mundo como um IP só (o do
NGINX). Faça o teste e volte logo. Com o driver de portas padrão do Docker rootless, **toda**
conexão à porta publicada chega com esse mesmo IP, venha de onde vier. É por isso que a 3100
não pode ficar aberta para a LAN: qualquer máquina da rede forjaria `X-Forwarded-For`.

### 2.2 Financeiro (`automacao-nfe`) e Marketplace (`automacoes-marketplace`)

| Variável | Valor em produção | Observação |
|---|---|---|
| `AUTOMATIONS_INTERNAL_KEY` | `${AUTOMATIONS_INTERNAL_KEY}` | Sem ela, toda rota (menos `/health` e `/api/v1/health`) responde `503`. Chave errada → `401`. |
| `INTERNAL_AUTH_DISABLED` | `false` (ou ausente) | `true` só em dev/testes. |
| `MOCK_MODE` | `false` | Financeiro: sem token do Tiny, a nota **não** é dada como lançada (fica em revisão). |
| `CORS_ORIGINS` | vazio | O navegador fala só com o gateway, nunca direto com as automações. |
| `UPLOAD_MAX_FILE_MB` / `UPLOAD_MAX_PDF_PAGES` / `UPLOAD_MAX_FILES` | opcionais (20 / 50 / 50) | Só financeiro (upload manual de DANFE/XML). |

Rebuild obrigatório (`--build`): os `requirements.txt` mudaram (fastapi/starlette/python-multipart
com correções de CVE).

### 2.3 Contagem de estoque (bot do Telegram)

| Variável | Valor | Observação |
|---|---|---|
| `TELEGRAM_ALLOWED_USERS` | IDs numéricos, vírgula | Quem pode usar o bot. |
| `TELEGRAM_ALLOWED_CHATS` | IDs dos grupos (negativos), vírgula | O bot responde se o usuário **ou** o chat estiver na lista. |

As duas vazias = qualquer pessoa (aviso no log). Para descobrir os IDs, mande uma foto e
procure `mensagem ignorada ... telegram_user_id=` no log do bot (depois de preencher ao
menos uma das listas), ou use o @userinfobot.

### 2.4 PC das etiquetas (`automacoes-producao`, Windows)

1. Baixe o **zip novo** pelo painel, depois do deploy do frontend:
   `https://servidor.norvia.example/automacoes/downloads/norvia-etiquetas-producao.zip`.
2. Feche o servidor e extraia por cima da pasta atual, **mantendo o `.env`**.
3. No `.env`, confira/adicione:
   - `CHAVE_API` (já obrigatória, mínimo 32 caracteres).
   - `LIMITE_REQUISICOES_MINUTO=30` e `LIMITE_COPIAS_MINUTO=2000`. Cada pedido continua
     aceitando de 1 a 1000 cópias, e o teto por minuto precisa ser >= 1000.
   - `CORS_ORIGINS=` a origem do sistema de OP (ex.: `https://op.norvia.example`). Vazio = `*`.
   - `HOST=127.0.0.1` **se** o tablet só chega pelo Cloudflare Tunnel. Se o tablet chama
     direto `http://IP-DO-PC:8003` na LAN, mantenha `HOST=0.0.0.0`.
4. Rode de novo o `liberar_firewall.bat` como administrador: agora a regra libera a 8003 só
   no perfil privado e só para a sub-rede local.
5. `iniciar.bat` (reinstala as dependências sozinho se o `requirements.txt` mudou).

---

## 3. docker-compose: portas e rede

### 3.1 Gateway só em 127.0.0.1

O NGINX roda no host e fala com `127.0.0.1:3100`. Publique a porta **só** no loopback:

```yaml
  gateway:
    ports:
      - "127.0.0.1:3100:3100"     # antes: "3100:3100" (todas as interfaces)
    environment:
      AUTOMATIONS_INTERNAL_KEY: ${AUTOMATIONS_INTERNAL_KEY}
      CORS_ORIGINS: https://servidor.norvia.example
      TRUSTED_PROXIES: ""          # depois: o IP descoberto na seção 2.1, ex. 10.0.2.100/32
      DANFE_API_URL: http://automacao-nfe:8000
      PYTHON_API_URL: http://automacao-nfe:8000
      # MARKETPLACE_API_URL: http://automacoes-marketplace:8001   (já é o padrão)
      # ADMIN_BOOTSTRAP_PASSWORD: remover depois que o admin existir
```

Confira com `ss -ltn | grep 3100`: deve aparecer `127.0.0.1:3100`, não `0.0.0.0:3100` nem `*:3100`.

### 3.2 Tirar a porta 8000 (automacao-nfe) do host

Hoje a 8000 está publicada no host e a 8001 (marketplace) não. Só dá para tirar a 8000 se o
gateway falar com o financeiro **pela rede docker, pelo nome do serviço**. O que o código faz:

- `index.ts`, `danfe.ts` e `financial-dashboard.ts` usam a mesma descoberta
  (`src/automation-http.ts`): `DANFE_API_URL` → `http://automacao-nfe:8000` → `127.0.0.1` →
  `localhost` → `host.docker.internal`.
- `reconciliation.ts` / `ml-reconciliation.ts` tentam `PYTHON_API_URL` → `http://127.0.0.1:8000` → `http://automacao-nfe:8000`.

Dentro do container do gateway, `127.0.0.1` é o **próprio container**, não o host. Então,
se o gateway funciona hoje, ele já usa `automacao-nfe:8000` (a menos que esteja com
`network_mode: host`). Antes de mexer:

```bash
docker compose exec gateway printenv DANFE_API_URL PYTHON_API_URL
docker compose exec gateway wget -qO- http://automacao-nfe:8000/health      # tem que responder
grep -n "network_mode" ~/norvia/interface-web/docker-compose.yml                          # gateway NÃO pode ter host
docker compose logs gateway | grep "Conectado ao automacao-nfe via"
```

- **Gateway e automacao-nfe na mesma rede do compose, sem `network_mode: host`:** defina
  `DANFE_API_URL` e `PYTHON_API_URL` como `http://automacao-nfe:8000` (seção 3.1) e remova a
  publicação:
  ```yaml
    automacao-nfe:
      # ports:
      #   - "8000:8000"      # REMOVIDO: só o gateway acessa, pela rede docker
      expose:
        - "8000"             # opcional, documenta a porta interna
      environment:
        AUTOMATIONS_INTERNAL_KEY: ${AUTOMATIONS_INTERNAL_KEY}
        MOCK_MODE: "false"
        CORS_ORIGINS: ""
  ```
- **Gateway com `network_mode: host`** (ou outro processo no host usa a 8000): não remova.
  Troque por `"127.0.0.1:8000:8000"`, para pelo menos sair da LAN/internet.

Depois: `ss -ltn | grep 8000` não deve listar nada (ou só `127.0.0.1:8000`), e as telas de
NF-e/Dashboard/Conciliação têm que abrir no painel.

O marketplace segue sem `ports:`. Só adicione `AUTOMATIONS_INTERNAL_KEY`, `MOCK_MODE` e
`CORS_ORIGINS` no environment dele.

### 3.3 MariaDB

Confira se a 3306 está publicada: `ss -ltn | grep 3306`. Se aparecer `0.0.0.0:3306`/`*:3306`
e ninguém fora dos containers precisa do banco, remova o `ports:` do serviço (ou use
`"127.0.0.1:3306:3306"` se o backup roda sem `MARIADB_CONTAINER`).

---

## 4. Permissões dos volumes (fim do chmod 757)

Hoje as pastas montadas (`data/`, `pending_review/`, `archived/`, `failed/`, `processed/`,
`secrets/`, `data/certs/`…) estão `1003:1003` com `chmod 757`, ou seja, **qualquer usuário do
host** lê e grava ali, incluindo o cache do token OAuth do Tiny e as chaves mTLS do Inter.

### 4.1 Quem é o `appuser` no host

No Docker rootless, o root do container é você (uid 1003) e os outros uids viram
**subuids**. O `appuser` (uid 1000 no container) vira `<início do subuid> + 999` no host:

```bash
grep "^jotape1302:" /etc/subuid                        # ex.: jotape1302:231072:65536
cat /proc/$(cat "$XDG_RUNTIME_DIR/docker.pid")/uid_map # 0 1003 1 / 1 231072 65536
# appuser = 231072 + (1000 - 1) = 232071

# Ou na prática: um arquivo criado como 1000 dentro de um container
docker run --rm -u 1000:1000 -v "$PWD/data:/x" alpine touch /x/.probe-uid
stat -c '%u:%g' data/.probe-uid && docker run --rm -v "$PWD/data:/x" alpine rm /x/.probe-uid
```

(`podman unshare` faz o mesmo no Podman. No Docker rootless o equivalente é
`nsenter -U --preserve-credentials -t $(cat $XDG_RUNTIME_DIR/docker.pid) --`, o mesmo que
o `backup.sh` usa.) Abaixo, `SUBUID_APP` é esse número (ex.: `232071`).

### 4.2 Opção A (recomendada): dono 1003 + ACL para o appuser

Você continua dono das pastas (consegue `ls`, `git pull` e copiar certificados sem
`docker exec`), os outros usuários do host perdem o acesso e o container ganha permissão por
ACL. Não precisa de sudo, porque o dono pode mudar a ACL da própria pasta:

```bash
cd ~/norvia/interface-web/backend/automations/automacoes-financeiro
SUBUID_APP=232071                     # o número da 4.1

# Pastas comuns: 750, appuser rwX, e ACL padrão para o que for criado depois
for d in data pending_review archived failed processed input_danfes logs; do
  [ -d "$d" ] || continue
  chmod -R u+rwX,g+rX,g-w,o-rwx "$d"
  setfacl -R -m "u:$SUBUID_APP:rwX" -m "d:u:$SUBUID_APP:rwX" -m "d:u:$(id -u):rwX" "$d"
done

# Pastas com segredo: 700/600, só você e o appuser (leitura)
for d in secrets data/certs; do
  [ -d "$d" ] || continue
  chmod -R u+rwX,go-rwx "$d"
  setfacl -R -m "u:$SUBUID_APP:rX" -m "d:u:$SUBUID_APP:rX" "$d"
done
getfacl -p data secrets | head -20
```

Repita na pasta `data/` do `automacoes-marketplace` (só o bloco das pastas comuns). Arquivos
que a aplicação grava como `0600` (ex.: `tiny_token_cache.json`) ficam legíveis só pelo
appuser. Isso é o esperado: o `backup.sh` lê pelo `nsenter -U` e continua funcionando.
Precisa de `setfacl` (pacote `acl`) e de um sistema de arquivos com ACL (ext4/xfs já têm).

### 4.3 Opção B: dono appuser dentro do container

Sem ACL: as pastas passam a ser do appuser, e você mexe nelas por `docker compose exec -u 0`
(ou pelo `nsenter -U` acima):

```bash
cd ~/norvia/interface-web
# segredos: só o appuser
docker compose exec -u 0 automacao-nfe sh -c '
  for d in /app/secrets /app/data/certs; do
    [ -d "$d" ] && chown -R 1000:1000 "$d" && chmod -R u+rwX,go-rwx "$d"
  done
  [ -f /app/data/tiny_token_cache.json ] && chmod 600 /app/data/tiny_token_cache.json
'
# resto: 770 (pastas) / 660 (arquivos) para o appuser e o grupo dele
docker compose exec -u 0 automacao-nfe sh -c '
  for d in /app/data /app/pending_review /app/archived /app/failed /app/processed /app/input_danfes /app/logs; do
    [ -d "$d" ] || continue
    chown 1000:1000 "$d"
    find "$d" \( -path /app/data/certs -prune \) -o -type d -exec chown 1000:1000 {} + -exec chmod 770 {} +
    find "$d" \( -path /app/data/certs -prune \) -o -type f -exec chown 1000:1000 {} + -exec chmod 660 {} +
  done
'
docker compose exec -u 0 automacoes-marketplace sh -c 'chown -R 1000:1000 /app/data && chmod -R u+rwX,g+rwX,o-rwx /app/data'
```

Use `750`/`640` em vez de `770`/`660` onde só o próprio processo grava. Consequência: no host
essas pastas aparecem com dono `232071` e o seu usuário não as lê diretamente. Para colocar
um certificado novo, use
`docker compose cp novo.pfx automacao-nfe:/app/secrets/ && docker compose exec -u 0 automacao-nfe chown 1000:1000 /app/secrets/novo.pfx && docker compose exec -u 0 automacao-nfe chmod 600 /app/secrets/novo.pfx`.

### 4.4 Conferir

```bash
stat -c '%A %U:%G %n' data secrets data/certs 2>/dev/null   # nada com "rwx" no último trio (o)
find . -maxdepth 2 -perm -o+w -not -type l                    # deve voltar vazio
docker compose exec automacao-nfe sh -c 'touch /app/data/.w && rm /app/data/.w && echo grava-ok'
systemctl --user start norvia-backup.service && cat ~/backups/norvia/last-backup.json
```

Os READMEs das automações ainda citam "dono 1003 + chmod 757". Esta seção substitui essa
orientação.

---

## 5. MariaDB: conferir e restringir grants

Os grants atuais não são conhecidos. Rode como root no container do banco
(`docker exec -it <container-mariadb> mariadb -uroot -p`):

```sql
-- Quem existe e de onde pode conectar
SELECT user, host, plugin, account_locked FROM mysql.user ORDER BY user, host;
-- Usuário anônimo (não deve existir)
SELECT user, host FROM mysql.user WHERE user = '';
-- O que cada usuário pode fazer (repita para cada linha da 1ª consulta)
SHOW GRANTS FOR 'root'@'%';
SHOW GRANTS FOR 'norvia_user'@'%';
SHOW GRANTS FOR CURRENT_USER();
```

Sinais de problema: `GRANT ALL PRIVILEGES ON *.*` para o usuário da aplicação, `WITH GRANT
OPTION`, `root@'%'`, usuário anônimo, ou o mesmo usuário em todos os serviços.

**Restringir o usuário da aplicação ao(s) banco(s) que ele usa.** Os containers conectam pela
rede docker (IP `172.x`), por isso o host costuma ser `'%'`. Exemplo para o usuário do
gateway/financeiro (troque o nome pelo da sua consulta):

```sql
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'norvia_user'@'%';
-- O gateway e o financeiro criam/alteram as próprias tabelas no boot: CREATE, ALTER, INDEX.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES
  ON financeiro.* TO 'norvia_user'@'%';
SHOW GRANTS FOR 'norvia_user'@'%';
```

- Marketplace (pelo README dele): acesso total ao `marketplace.*` e só `SELECT` em
  `financeiro.api_tokens`. O ideal é um usuário próprio:
  ```sql
  CREATE USER 'marketplace_app'@'%' IDENTIFIED BY '<senha forte>';
  GRANT ALL PRIVILEGES ON marketplace.* TO 'marketplace_app'@'%';
  GRANT SELECT ON financeiro.api_tokens TO 'marketplace_app'@'%';
  ```
- A página Saúde do sistema do gateway consulta os esquemas `financeiro`, `marketplace` e
  `producao`. Se, depois do REVOKE, algum card ficar "sem acesso", dê só `SELECT` naquele
  esquema ao usuário do gateway, e nada além disso.
- Teste **antes** de tirar o acesso antigo: reinicie os serviços e confira login, NF-e, Contas
  a Pagar e Marketplace. Se der errado, o `GRANT` antigo (da saída do `SHOW GRANTS`) volta tudo.

**Remover `root@'%'`** (root acessível de qualquer IP). Antes, confirme que existe
`root@'localhost'` com senha conhecida e que nenhum serviço/backup usa root:

```sql
SELECT user, host FROM mysql.user WHERE user = 'root';      -- tem que ter 'localhost'
DROP USER 'root'@'%';
FLUSH PRIVILEGES;
```

A imagem oficial do MariaDB cria `root@'%'` na primeira inicialização (`MARIADB_ROOT_HOST`,
padrão `%`). Depois do `DROP`, ele não volta enquanto o volume de dados existir. Em
instalações novas, defina `MARIADB_ROOT_HOST=localhost` no compose. Para administrar,
use `docker exec -it <container> mariadb -uroot -p`, que conecta como `localhost`.

---

## 6. NGINX: restringir o acesso ao painel

O NGINX é do analista, então passe a ele o trecho abaixo. Hoje não há allowlist, e o
`servidor.norvia.example` é público. O mesmo domínio serve outros sistemas (`/`,
`/tms/`, `/pcp-extrusao/`...). **Aplique a restrição só nos `location` do painel
(`/automacoes/`) e do gateway**, para não quebrar os outros.

Descubra os blocos certos com `grep -n "location\|proxy_pass\|alias" /etc/nginx/sites-enabled/*`:
o painel aponta para `/var/www/automacoes`, o gateway para `proxy_pass http://127.0.0.1:3100`.

### Opção 1: só a rede local (allowlist)

```nginx
# Faixas da LAN da empresa (ajuste para as reais: veja o IP do tablet/PCs).
geo $norvia_lan {
    default         0;
    127.0.0.0/8     1;
    192.168.0.0/16  1;   # troque pela sub-rede real, ex. 192.168.1.0/24
    10.0.0.0/8      1;
    172.16.0.0/12   1;
}

server {
    # ...
    location /automacoes/ {
        if ($norvia_lan = 0) { return 403; }
        alias /var/www/automacoes/;
        # ... (resto como está)
    }
    location /<prefixo-do-gateway>/ {          # o location que faz proxy_pass para :3100
        allow 127.0.0.1;
        allow 192.168.0.0/16;                   # mesma(s) faixa(s) do geo acima
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        deny  all;
        proxy_set_header X-Forwarded-For $remote_addr;   # sobrescreve, não acumula
        proxy_set_header X-Real-IP       $remote_addr;
        proxy_pass http://127.0.0.1:3100;
    }
}
```

(Nos dois `location`, `allow`/`deny` e o `geo` têm o mesmo efeito. O `geo` fica mais
fácil de reaproveitar.)

O que muda na prática:

- **Tablet do sistema de OP do analista**: ele abre a URL do ddns de dentro da LAN e continua
  funcionando. Atenção: se o roteador faz *NAT loopback*, o NGINX pode ver o IP do roteador,
  ou até o IP público da empresa, em vez do IP do tablet. Antes de ativar o `deny`, olhe o
  `access.log` com o tablet acessando (`tail -f /var/log/nginx/access.log`) e inclua o IP
  que aparecer (o IP público fixo da empresa pode entrar como `/32`).
- **PC das etiquetas**: não é afetado (é chamado pelo Cloudflare Tunnel ou direto na LAN, sem
  passar por este NGINX).
- **Quem acessa de fora** (celular no 4G, diretoria em casa) perde o acesso. Para isso,
  use uma VPN (WireGuard/Tailscale: o IP da VPN entra na allowlist) ou a opção 2.
- `proxy_set_header X-Forwarded-For $remote_addr` (em vez de `$proxy_add_x_forwarded_for`)
  impede que o cliente injete IPs falsos na cadeia que o gateway lê.

### Opção 2: autenticação na frente (acesso de fora)

- **Cloudflare Access** (Zero Trust, gratuito até 50 usuários): exige que o domínio passe pelo
  Cloudflare (proxy ou Tunnel). O login por e-mail/Google acontece antes de chegar ao NGINX.
  Crie a aplicação só para `servidor.norvia.example/automacoes*` e para o caminho do gateway.
  Para o tablet de OP, use uma regra "Bypass" por IP da empresa ou um *service token*.
- **Basic auth no NGINX** (mais simples, uma senha compartilhada a mais):
  ```nginx
  location /automacoes/ {
      satisfy any;                         # LAN entra direto; de fora pede senha
      allow 192.168.0.0/16;
      deny  all;
      auth_basic           "Norvia";
      auth_basic_user_file /etc/nginx/htpasswd-automacoes;   # htpasswd -B -c ...
      alias /var/www/automacoes/;
  }
  ```
  Repita no `location` do gateway. Basic auth só é aceitável sobre HTTPS (já é o caso).

Seja qual for a opção, o login do painel continua valendo: essas camadas são extras.

---

## 7. Headers de segurança do NGINX

<a id="headers-de-seguranca"></a>
Os headers HTTP de segurança do painel (CSP, `X-Frame-Options`/`frame-ancestors`,
`X-Content-Type-Options`, `Referrer-Policy`, HSTS, `Permissions-Policy`) estão documentados
pelo frontend em **`frontend/README.md`**, seção "Headers de segurança (NGINX)", que é a
fonte. Aplique-os no mesmo `location /automacoes/` da seção 6. Lá está explicado: um
`add_header` dentro do `location` anula os herdados do `server {}`.

---

## 8. Backup: usuário só leitura e criptografia

Detalhes em `scripts/backup/README.md`. Resumo do que mudou:

- A senha do banco não aparece mais na linha de comando (`docker exec -e MYSQL_PWD` sem
  valor). Nada a configurar.
- **Usuário `backup` só leitura**: SQL pronto no README, seção "Usuário do banco só para
  backup". Troque `DB_USER`/`DB_PASSWORD` no `backup.env`.
- **Criptografia com `age`**: `BACKUP_AGE_RECIPIENT=age1...` no `backup.env` (chave
  pública; a privada fica **fora** do servidor). Com ela, só arquivos `.age` saem para o
  `BACKUP_RSYNC_TARGET`. Se a variável estiver definida e o `age` não estiver instalado, o
  backup falha antes do dump e a página Saúde do sistema mostra o motivo.
- Pendências antigas que continuam valendo: timer systemd, `backup.env` e o volume
  `/backups:ro` no gateway.

---

## 9. Varredura de segredos e dependências (CI)

`.github/workflows/security.yml` roda em todo push na `main`, toda segunda às 06:00 (BRT) e
sob demanda (Actions → security → Run workflow):

| Job | O que faz | Falha quando |
|---|---|---|
| `gitleaks` | Varre **todo o histórico** com o `.gitleaks.toml` (binário 8.30.1 conferido por SHA256; a `gitleaks-action` exige licença para repositórios de organização) | qualquer segredo fora da allowlist |
| `npm-audit` | `npm audit --omit=dev --audit-level=high` no `backend/gateway` e no `frontend` | vulnerabilidade high/critical em dependência de produção |
| `pip-audit` | `pip-audit -r requirements.txt` em cada automação | qualquer vulnerabilidade conhecida |

Os dois jobs `npm-audit` (gateway e frontend) **bloqueiam** (`blocking: true` na matriz).
O do frontend passou a bloquear em 2026-10-08; antes só reportava.

**Por que o `vinext` é devDependency** (2026-10-08): o GHSA-vfj7-8cjw-p6xm (`braces`, high,
faixa `*`, sem versão corrigida; última `braces` 3.0.3, última `micromatch` 4.0.8) chega por
`vinext > vite-plugin-commonjs > vite-plugin-dynamic-import > fast-glob > micromatch > braces`
e derrubava o job com 6 vulnerabilidades high. O `vinext` 1.0.1 ainda depende de
`vite-plugin-commonjs ^0.10.4`, então atualizar não resolve. Como a produção do frontend é
export estático servido pelo NGINX (sem Node), o `vinext` é só ferramenta de build: saiu de
`dependencies` para `devDependencies` na mesma versão (`1.0.0-beta.9`), e o `--omit=dev`
deixa de contá-lo. O lockfile só mudou nos metadados `dev`/`devOptional`; nenhum pacote mudou
de versão. O `react-server-dom-webpack` continua em `dependencies` (runtime, não vulnerável).

- **Deploy inalterado**: `npm ci && npm run build` instala as devDependencies, e o
  `frontend/Dockerfile` (só desenvolvimento) usa `npm ci` sem `--omit=dev` e sem
  `NODE_ENV=production`. Não rode `npm ci --omit=dev` no frontend: o build quebra sem o
  `vinext`.
- **Esperado, não é regressão**: `npm audit` **sem** `--omit=dev` no `frontend` continua
  acusando essa cadeia nas ferramentas de build.
- **Quando revisar**: quando sair um `braces` corrigido
  (https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) ou quando o `vinext` deixar de puxar
  `vite-plugin-commonjs`/`fast-glob`. Aí a cadeia some também do audit completo; o `vinext`
  continua em devDependencies, porque não roda em produção.

O workflow só tem `contents: read`: não publica nada nem precisa de segredo. Um job vermelho
não bloqueia o push, porque o push direto na main continua permitido. Ele avisa por e-mail
e aparece como ✗ no commit.

**Localmente** (raiz do repo):

```bash
npm run audit            # tudo; ou audit:secrets / audit:npm / audit:python
pipx install pre-commit && pre-commit install   # gitleaks em cada commit (só o que está staged)
```

`audit:secrets` precisa do `gitleaks` no PATH, e `audit:python` precisa do `uv`.

**Allowlist (`.gitleaks.toml`)**: só fixtures conhecidas (JWT de exemplo do jwt.io,
`test-admin-password`, `tok_*`/`test-*`, placeholders `seu_..._aqui`/`norvia_pass`, o ID do
workflow n8n e `package-lock.json`). Os `.env.example` **não** estão liberados de propósito:
é onde um segredo real costuma ser colado por engano. Se o gitleaks achar um segredo real,
**revogue/troque** a credencial; não a coloque na allowlist.

---

## 10. GitHub: Secret Scanning, Push Protection e proteção da main

Repositório: `norvia-ti/interface-web` (privado, de organização).

### 10.1 Secret Scanning + Push Protection

*Settings → Advanced Security* (em contas antigas, *Code security and analysis*):

1. **Secret Protection** → *Enable*. Em repositório **privado de organização**, isso exige a
   licença *GitHub Secret Protection* (paga, por committer ativo). Sem a licença o botão não
   aparece. Nesse caso, o gitleaks no CI e no pre-commit (seção 9) cobre o mesmo risco.
2. **Push protection** → *Enable*: o GitHub recusa o `git push` que contenha um token
   reconhecido (GitHub, AWS, Google, Slack, Stripe…). Para liberar um falso positivo, o push
   mostra um link de "bypass" com justificativa.
3. Na organização (*Organization settings → Advanced Security*) dá para ligar os dois em
   todos os repositórios de uma vez.

### 10.2 Proteger a main contra force-push e exclusão, mantendo push direto

O fluxo continua sendo **push direto na main, sem PR obrigatório**. O que se protege é só o
histórico: ninguém reescreve (`push --force`) nem apaga a branch.

**Importante:** quem está na lista de *bypass* de um ruleset ignora **todas** as regras dele,
inclusive o bloqueio de force-push. Se já existe um ruleset com "Require a pull request" e
você entra pelo bypass (a mensagem "must be made through a pull request" no push), **não**
coloque as regras abaixo nele. Crie um ruleset separado e **sem** bypass:

*Settings → Rules → Rulesets → New ruleset → New branch ruleset*

- Nome: `main-sem-force-push`
- Enforcement status: **Active**
- Bypass list: **vazia**
- Target branches: *Include default branch*
- Regras marcadas: **Restrict deletions** e **Block force pushes**
- Todo o resto desmarcado (principalmente *Require a pull request before merging*)

Ou pelo `gh` (admin da organização/repo):

```bash
gh api -X POST repos/norvia-ti/interface-web/rulesets --input - <<'JSON'
{
  "name": "main-sem-force-push",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" } ]
}
JSON
gh api repos/norvia-ti/interface-web/rulesets   # conferir
```

Teste: `git push --force` na main deve ser recusado e um `git push` normal deve passar.
Quando precisar reescrever o histórico de verdade (ex.: tirar um segredo commitado), mude
o ruleset para *Disabled*, faça o force-push e reative.

---

## 11. Imagens Docker

### 11.1 Imagens base fixadas

Todos os Dockerfiles usam **tag de patch + digest** do índice multi-arquitetura. O build fica
reprodutível e uma tag movida no Docker Hub não troca a base sem você saber:

| Dockerfile | Base |
|---|---|
| `backend/gateway/Dockerfile` | `node:22.23.3-alpine3.24@sha256:0a7108bf…e402` |
| `frontend/Dockerfile` (só dev) | `node:22.23.3-bookworm-slim@sha256:c3de60bf…8392` |
| `backend/automations/{automacoes-financeiro,automacoes-marketplace,contagem-estoque}/Dockerfile` | `python:3.11.17-slim-bookworm@sha256:0a310eee…5f89` |

O outro lado do digest fixo: correções de segurança da imagem base **não chegam sozinhas**.
Atualize uma vez por mês (ou quando sair CVE do Node/Python/Debian/Alpine):

```bash
skopeo inspect --raw docker://docker.io/library/node:22-alpine | sha256sum      # digest do índice
skopeo inspect --config docker://docker.io/library/node:22-alpine | grep -o 'NODE_VERSION=[^"]*'
# ou: docker buildx imagetools inspect node:22-alpine   (linha "Digest:")
```

Para atualizar, troque a tag de patch e o digest juntos no Dockerfile e rode `docker compose up -d --build`.

### 11.2 O que mudou nos Dockerfiles

- **Gateway**: multi-stage. O build usa `npm ci` (com devDependencies, para o `tsc`) e
  `npm prune --omit=dev`. A imagem final leva só `dist/`, `package.json` e as dependências de
  produção (`node_modules` ~8 MB), com `NODE_ENV=production`, `USER node`, porta 3100 e o
  mesmo `CMD ["node", "dist/index.js"]`.
- **Frontend**: roda como `USER node`, com `npm ci`. É **só para desenvolvimento** (dev
  server). Produção é o export estático em `/var/www/automacoes/`.
- **`.dockerignore`** em cada contexto de build (gateway, frontend, financeiro, marketplace,
  contagem-estoque): `.env*`, `node_modules`, `.git`, `dist`, logs, `data`, `certs`,
  `secrets`, chaves/certificados, `__pycache__`, `.venv` e as pastas de notas
  (`input_danfes`, `processed`, `failed`, `pending_review`, `archived`). Assim nenhum
  segredo nem nota fiscal vai para o contexto do daemon ou para uma camada da imagem por
  engano.

---

## 12. Deploy e migração do RBAC por usuário (2026-10-08)

Esta entrega substitui o modelo de permissões baseado em setor pelo controle granular de **permissões por usuário (16 abas × 43 ações)**, introduz o papel `Gestor` abaixo de `Admin`, proteção física do usuário ROOT (`is_root`), concorrência otimista (`expectedVersion`) e transações atômicas na criação de usuários.

### 12.1 Ordem Obrigatória de Execução

> [!CAUTION]
> **NUNCA execute a PARTE 2 da migração com o gateway antigo rodando.**
> O gateway legado interpreta a ausência de linhas em `usuario_permissoes` como permissão concedida. Se a limpeza rodar com o gateway antigo ativo, **todos os usuários passarão a ver e executar tudo**.

1. **Atualizar código:**
   ```bash
   cd ~/norvia/interface-web && git pull --ff-only origin main
   ```

2. **Subir Gateway novo e Frontend novo simultaneamente:**
   ```bash
   # Rebuild e subida do gateway novo (aplica PARTE 1 da migração de forma segura no bootstrap)
   docker compose up -d --build gateway

   # Build e publicação do frontend estático
   cd ~/norvia/interface-web/frontend
   npm ci && npm run build
   rsync -a --delete dist/client/automacoes/ /var/www/automacoes/
   ```

3. **Aplicar a PARTE 2 da migração SQL (limpeza das permissões legadas):**
   Com o gateway novo já no ar (ou com o gateway temporariamente pausado), execute:
   ```bash
   cd ~/norvia/interface-web
   docker compose exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" financeiro' \
     < database/migrations/2026-10-08-rbac-permissoes-por-usuario.sql
   ```
   - Esta etapa apaga as chaves legadas sem `:` e remove as linhas de permissão negada.
   - Todos os usuários não-admin iniciarão com **zero permissões** (acesso bloqueado), conforme a decisão de transição segura.

4. **Conceder permissões no painel:**
   O administrador deve entrar em `https://servidor.norvia.example/automacoes/admin/usuarios` e conceder as permissões de cada colaborador através do novo painel lateral de permissões.

5. **Procedimento de Rollback:**
   Caso seja necessário reverter para a versão anterior do gateway, **restaure o backup do MariaDB antes de iniciar o gateway antigo**, garantindo que as permissões legadas estejam restauradas.
