# Backup automático (MariaDB + caches das automações)

`backup.sh` faz, uma vez por dia:

| Arquivo | Conteúdo |
|---|---|
| `mariadb-<banco>.sql.gz` | dump de cada banco de `BACKUP_DB_NAMES` (usuários, sessões, notificações, chat, incidentes, auditoria, conciliação de contas a pagar) |
| `caches.tar.gz` | pastas de `BACKUP_CACHE_PATHS`: cache e status do Dashboard Financeiro, notas em revisão, arquivadas, falhas e processadas da `automacao-nfe` |
| `*.age` | cópia criptografada do dump e dos caches (só com `BACKUP_AGE_RECIPIENT`, ver [Criptografia](#criptografia-age)) |
| `SHA256SUMS` | soma de verificação de cada arquivo |

Cada execução vai para `BACKUP_DIR/AAAA-MM-DD_HHMMSS/`. Backups mais velhos que
`BACKUP_RETENTION_DAYS` são apagados. O script confere o que gerou: o gzip precisa
estar íntegro e o dump precisa terminar com `-- Dump completed`, porque um dump
cortado no meio falha nessa checagem. Se algo falhar, a pasta recebe um arquivo
`FALHOU` e o erro vai para o status.

O resultado de cada execução fica em `BACKUP_DIR/last-backup.json`. O gateway lê
esse arquivo e mostra o último backup na página **Saúde do sistema** (admin). A
página avisa quando o backup falhou ou quando o último tem mais de 26 horas.

Os certificados A1 (`automacoes-financeiro/secrets/`) ficam **fora** do backup de propósito.
Guarde os `.pfx` num lugar seguro separado.

## Instalação no servidor

```bash
cd ~/norvia/interface-web/scripts/backup
cp backup.env.example backup.env
chmod 600 backup.env
nano backup.env                          # BACKUP_DIR, container/credenciais, pastas
./backup.sh                              # primeira execução manual, para conferir
cat "$BACKUP_DIR/last-backup.json"       # use o BACKUP_DIR do backup.env
```

### Usuário do banco só para backup

Recomendado: um usuário só de leitura, em vez do root ou do usuário da aplicação. Se o
`backup.env` vazar, quem pegar a senha não consegue alterar nem apagar nada. Rode no
MariaDB como root (`docker exec -it <container-mariadb> mariadb -uroot -p`):

```sql
-- Com MARIADB_CONTAINER (dump via docker exec), a conexão vem de dentro do próprio
-- container: 'localhost' basta. Sem container (DB_HOST=127.0.0.1), use '127.0.0.1'.
CREATE USER IF NOT EXISTS 'backup'@'localhost' IDENTIFIED BY '<senha forte>';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON financeiro.* TO 'backup'@'localhost';
-- repita o GRANT para cada banco de BACKUP_DB_NAMES, ex.:
-- GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON marketplace.* TO 'backup'@'localhost';
-- Só se houver procedures/functions e o dump reclamar de "--routines": o mariadb-dump lê
-- as rotinas de mysql.proc (no MariaDB 11.3+ o privilégio é SHOW CREATE ROUTINE).
-- GRANT SELECT ON mysql.proc TO 'backup'@'localhost';
FLUSH PRIVILEGES;
SHOW GRANTS FOR 'backup'@'localhost';
```

Gere a senha com `openssl rand -base64 24` e coloque em `DB_USER=backup` /
`DB_PASSWORD=` no `backup.env` (que já é `chmod 600`). Rode `./backup.sh` uma vez à
mão para confirmar que o dump termina com `-- Dump completed` com o novo usuário.

A senha nunca vai na linha de comando: o script exporta `MYSQL_PWD` só para o
`docker exec -e MYSQL_PWD` (sem valor, o docker copia do ambiente) ou para o
`mariadb-dump`, então ela não aparece em `ps` nem em `/proc/<pid>/cmdline`.

### Agendamento (systemd de usuário)

O Docker do servidor é rootless, então o timer roda no systemd do **mesmo usuário**:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/norvia-backup.service systemd/norvia-backup.timer ~/.config/systemd/user/
# se o repositório não estiver em ~/norvia/interface-web, ajuste o ExecStart do .service
systemctl --user daemon-reload
systemctl --user enable --now norvia-backup.timer
loginctl enable-linger "$USER"           # o timer roda mesmo sem sessão aberta
systemctl --user list-timers norvia-backup.timer
journalctl --user -u norvia-backup.service   # log das execuções
```

Pelo timer (e pelo cron) não existe o `DOCKER_HOST` que o `.bashrc` define para o
Docker rootless. O script usa então o socket do usuário (`/run/user/<uid>/docker.sock`).
Se o seu socket estiver em outro lugar, defina `DOCKER_HOST` no `backup.env`.

Os arquivos que os containers gravam nas pastas de cache ficam com dono subuid no host
e nem sempre são legíveis pelo seu usuário — era o "Falha na etapa: cópia dos caches
(código 2)" da página Saúde do sistema. Por isso o `tar` dos caches roda dentro do
namespace de usuário do Docker rootless (`nsenter -U` no PID de
`$XDG_RUNTIME_DIR/docker.pid`), onde o seu usuário lê esses arquivos. Para desligar:
`BACKUP_CACHE_USERNS=off` no `backup.env`. Se ainda falhar, a mensagem na página traz o
primeiro erro do `tar` (ex.: qual arquivo deu "Permissão negada").
Depois de instalar, teste pelo systemd e não só no terminal:
`systemctl --user start norvia-backup.service`.

Alternativa com cron (`crontab -e`):

```cron
30 2 * * * /caminho/do/repo/scripts/backup/backup.sh >> /caminho/dos/backups/backup.log 2>&1
```

### Mostrar o status na página Saúde do sistema

O gateway roda em container. Monte a pasta de backups **somente leitura** e aponte a
variável para o status, no serviço do gateway no `docker-compose.yml` do servidor:

```yaml
  gateway:
    environment:
      BACKUP_STATUS_FILE: /backups/last-backup.json
    volumes:
      - /home/jotape1302/backups/norvia:/backups:ro   # o mesmo BACKUP_DIR do backup.env
```

O `last-backup.json` é gravado com permissão 644 e a pasta raiz com 711, então o
container consegue ler o status sem mudar o dono da pasta. As pastas de cada
backup continuam 700, e o gateway não enxerga os dumps.

## Cópia fora do servidor

Um backup que fica só no próprio servidor não sobrevive à perda do disco. Preencha
`BACKUP_RSYNC_TARGET` (ex.: um NAS: `usuario@nas.local:/backups/norvia`) com chave
SSH sem senha para o usuário do timer. Cada execução copia a pasta do dia para lá.
Sem criptografia, o log avisa que a cópia externa vai em texto claro.

### Criptografia (age)

O dump tem dados de clientes, fornecedores e usuários. Com `BACKUP_AGE_RECIPIENT`
definido, o script cria `mariadb-<banco>.sql.gz.age` e `caches.tar.gz.age` com a chave
**pública**, e só os `.age` e o `SHA256SUMS` vão para `BACKUP_RSYNC_TARGET`
(`rsync --delete-excluded`: se já houver texto claro naquela pasta do destino, ele é
apagado). No servidor ficam os dois, nas pastas `700`, para restaurar rápido sem a chave
privada. O `SHA256SUMS` cobre os arquivos em claro e os `.age`, e o `last-backup.json`
ganha `"encrypted": true`.

Se a variável estiver definida e o `age` não estiver instalado, o backup **falha antes do
dump**, com o motivo na página Saúde do sistema: assim nada sai em texto claro por engano.

1. Num computador **fora do servidor** (o seu, ou um pendrive guardado no cofre), gere o par:
   ```bash
   age-keygen -o norvia-backup.key   # imprime "Public key: age1..."
   ```
   Guarde o `norvia-backup.key` em dois lugares seguros. Sem ele não dá para restaurar
   a cópia externa. Ele **não** vai para o servidor.
2. No servidor: instale o `age` (`apt install age`, ou peça a quem administra a VPS, já
   que não temos sudo. Outra opção é o binário estático de
   <https://github.com/FiloSottile/age/releases> em `~/bin/age` com `AGE_BIN=$HOME/bin/age`).
3. No `backup.env`: `BACKUP_AGE_RECIPIENT=age1...` (a chave pública do passo 1).
4. `systemctl --user start norvia-backup.service` e confira `"encrypted": true` no
   `last-backup.json`.

Cópias antigas em texto claro que já estejam no destino externo (de antes da
criptografia) não são apagadas automaticamente. Remova-as à mão depois de conferir
uma cópia `.age`, por exemplo: `ssh usuario@nas.local 'find /backups/norvia -name "*.gz" -delete'`.

Restaurar a partir da cópia externa (no computador que tem a chave privada):

```bash
cd 2026-10-06_023000
sha256sum -c --ignore-missing SHA256SUMS
age -d -i norvia-backup.key -o mariadb-financeiro.sql.gz mariadb-financeiro.sql.gz.age
age -d -i norvia-backup.key -o caches.tar.gz caches.tar.gz.age
sha256sum -c SHA256SUMS          # agora confere também os arquivos em claro
```

## Restauração

Confira a integridade antes:

```bash
cd /home/jotape1302/backups/norvia/2026-09-25_023000
test -f FALHOU && echo "backup incompleto, use outro"
sha256sum -c SHA256SUMS
```

Banco (o dump tem `CREATE DATABASE`/`USE`, então recria o banco inteiro). **Isso
sobrescreve os dados atuais**. Pare o gateway antes:

```bash
docker compose stop gateway
read -rsp 'Senha do root do MariaDB: ' MYSQL_PWD; echo; export MYSQL_PWD
zcat mariadb-financeiro.sql.gz | docker exec -i -e MYSQL_PWD <container-mariadb> mariadb -uroot
unset MYSQL_PWD
docker compose start gateway
```

Caches (pare a `automacao-nfe` antes). Os caminhos no tar são relativos à raiz:

```bash
docker compose stop automacao-nfe
tar -xzf caches.tar.gz -C /
docker compose start automacao-nfe
```

Para só inspecionar sem sobrescrever nada, extraia numa pasta à parte:
`mkdir /tmp/restauracao && tar -xzf caches.tar.gz -C /tmp/restauracao`.

Vale fazer um teste de restauração de vez em quando, num banco descartável
(`sed 's/`financeiro`/`financeiro_teste`/g'` no dump), para garantir que o backup
realmente volta.
