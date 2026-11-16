#!/usr/bin/env bash
# ==============================================================================
# Migrações do MariaDB (database/migrations) com registro em `schema_migrations`.
#
# Não aplica nada sozinho em lote: cada migração daqui tem pré-condições escritas no
# cabeçalho (ordem de deploy, parte destrutiva). O script só tira a dúvida de "essa já
# rodou no servidor?" e registra quando você aplica.
#
#   scripts/migrate.sh                 status: aplicadas, pendentes e alteradas depois de aplicadas
#   scripts/migrate.sh apply <arquivo> mostra o cabeçalho, pede confirmação, aplica e registra
#   scripts/migrate.sh mark <arquivo>  só registra (para as que já foram aplicadas à mão antes)
#
# Rode na VPS a partir de ~/norvia/interface-web. Pede a senha do MariaDB uma vez (ou use
# MYSQL_PWD). MIGRATE_DB_SERVICE (padrão mariadb) e MIGRATE_DB_USER (padrão root) ajustam o
# serviço do compose e o usuário; MIGRATE_DB_CMD troca o cliente inteiro (lê SQL do stdin).
# ==============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=database/migrations
DB_SERVICE=${MIGRATE_DB_SERVICE:-mariadb}
DB_USER=${MIGRATE_DB_USER:-root}
# Trava de execução: apply/mark em paralelo (dois terminais) aplicariam a mesma migração duas vezes.
LOCKFILE=${MIGRATE_LOCKFILE:-${XDG_RUNTIME_DIR:-/tmp}/norvia-migrate.lock}

command -v flock >/dev/null || { echo "flock não encontrado (pacote util-linux): instale para usar o migrate.sh." >&2; exit 1; }

# Pega o lock (esperando até 60 s) e o mantém no fd 9 até o script terminar.
travar() {
  exec 9>"$LOCKFILE"
  flock -w 60 9 || { echo "Outra execução do migrate.sh está em andamento ($LOCKFILE). Tente de novo depois." >&2; exit 1; }
}

if [[ -n ${MIGRATE_DB_CMD:-} ]]; then
  db() { bash -c "$MIGRATE_DB_CMD"; }
else
  # A senha é pedida uma vez e vai só no ambiente (`-e MYSQL_PWD` sem valor copia a variável),
  # como no backup.sh: não aparece na linha de comando nem depende do env do container.
  if [[ -z ${MYSQL_PWD:-} ]]; then
    read -r -s -p "Senha do MariaDB ($DB_USER): " MYSQL_PWD
    echo
  fi
  export MYSQL_PWD
  db() {
    docker compose exec -T -e MYSQL_PWD "$DB_SERVICE" \
      mariadb --batch --skip-column-names -u"$DB_USER" financeiro
  }
fi

garantir_tabela() {
  db <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  versao       VARCHAR(255) NOT NULL PRIMARY KEY,
  checksum     CHAR(64)     NOT NULL,
  aplicada_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aplicada_por VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SQL
}

checksum() { sha256sum "$1" | cut -d' ' -f1; }

arquivo_valido() {
  local f=$1
  [[ -f $f ]] || f="$DIR/$(basename "$f")"
  [[ -f $f && $f == "$DIR"/*.sql ]] || { echo "Migração não encontrada em $DIR: $1" >&2; exit 1; }
  echo "$f"
}

sql_registro() {
  local versao=$1 soma=$2 quem=${SUDO_USER:-${USER:-desconhecido}}
  printf "INSERT INTO schema_migrations (versao, checksum, aplicada_por) VALUES ('%s', '%s', '%s');\n" \
    "${versao//\'/}" "$soma" "${quem//\'/}"
}

registrada() {
  local versao=$1
  [[ -n $(printf "SELECT 1 FROM schema_migrations WHERE versao = '%s';\n" "${versao//\'/}" | db) ]]
}

status() {
  garantir_tabela
  declare -A aplicadas=()
  while IFS=$'\t' read -r versao soma; do
    [[ -n $versao ]] && aplicadas[$versao]=$soma
  done < <(echo "SELECT versao, checksum FROM schema_migrations;" | db)

  local pendentes=0
  for f in "$DIR"/*.sql; do
    local v; v=$(basename "$f")
    if [[ -z ${aplicadas[$v]+x} ]]; then
      echo "PENDENTE   $v"; pendentes=$((pendentes + 1))
    elif [[ ${aplicadas[$v]} != baseline && ${aplicadas[$v]} != "$(checksum "$f")" ]]; then
      echo "ALTERADA   $v   (arquivo mudou depois de aplicado: confira o diff)"
    else
      echo "aplicada   $v"
    fi
  done
  echo "$pendentes pendente(s)."
}

apply() {
  local f; f=$(arquivo_valido "$1")
  local v; v=$(basename "$f")
  garantir_tabela
  travar
  # Confere de novo já dentro do lock: outra execução pode ter registrado enquanto esperávamos.
  registrada "$v" && { echo "$v já está registrada como aplicada." >&2; exit 1; }
  echo "----- cabeçalho de $v -----"
  sed -n '/^[^-]/q;p' "$f"
  echo "---------------------------"
  read -r -p "Pré-condições conferidas? Aplicar $v agora [s/N]? " ok
  [[ $ok == [sS] ]] || { echo "Cancelado."; exit 1; }
  # O cliente para no primeiro erro (sem --force) e o `set -e` interrompe aqui: o registro só
  # é gravado se a migração inteira passou. O registro vem logo em seguida, sem pergunta no meio.
  db <"$f"
  if ! sql_registro "$v" "$(checksum "$f")" | db; then
    echo "ATENÇÃO: $v foi APLICADA, mas o registro falhou. Rode: $0 mark $v" >&2
    exit 1
  fi
  echo "Aplicada e registrada: $v"
}

mark() {
  local f; f=$(arquivo_valido "$1")
  local v; v=$(basename "$f")
  garantir_tabela
  travar
  registrada "$v" && { echo "$v já está registrada." >&2; exit 1; }
  sql_registro "$v" "$(checksum "$f")" | db
  echo "Registrada sem executar: $v"
}

case ${1:-status} in
  status) status ;;
  apply) [[ $# -eq 2 ]] || { echo "uso: $0 apply <arquivo>" >&2; exit 2; }; apply "$2" ;;
  mark) [[ $# -eq 2 ]] || { echo "uso: $0 mark <arquivo>" >&2; exit 2; }; mark "$2" ;;
  *) echo "uso: $0 [status | apply <arquivo> | mark <arquivo>]" >&2; exit 2 ;;
esac
