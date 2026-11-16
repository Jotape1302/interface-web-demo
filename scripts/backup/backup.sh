#!/usr/bin/env bash
# ==============================================================================
# backup.sh - Backup do MariaDB e dos caches das automações (Norvia)
# ==============================================================================
# Gera, em $BACKUP_DIR/<AAAA-MM-DD_HHMMSS>/:
#   mariadb-<banco>.sql.gz   dump de cada banco de BACKUP_DB_NAMES
#   caches.tar.gz            pastas de BACKUP_CACHE_PATHS (cache do Dashboard
#                            Financeiro, notas em revisão/arquivadas, falhas...)
#   *.age                    cópias criptografadas (age) do dump e dos caches,
#                            quando BACKUP_AGE_RECIPIENT está definido
#   SHA256SUMS               para conferir a integridade na hora de restaurar
# e atualiza $BACKUP_DIR/last-backup.json, que o gateway lê na página Saúde do
# sistema. Retenção: só se apaga o que for MAIS VELHO que BACKUP_RETENTION_DAYS e estiver
# além dos BACKUP_KEEP_MIN backups mais recentes BEM-SUCEDIDOS (marcador BACKUP_OK na pasta),
# então uma sequência de falhas nunca esvazia o histórico bom.
#
# Modos:
#   backup.sh                  faz o backup (padrão)
#   backup.sh verify-restore   carrega o último backup bom num MariaDB descartável e conta as
#                              tabelas (teste de restauração; ver README, "Teste de restauração")
#
# Configuração: scripts/backup/backup.env (copie de backup.env.example).
# Agendamento: scripts/backup/systemd/ (timer diário) — ver scripts/backup/README.md.
# ==============================================================================
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV_FILE:-$SCRIPT_DIR/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi

BACKUP_DIR="${BACKUP_DIR:?defina BACKUP_DIR no backup.env}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# Quantos backups bem-sucedidos mais recentes nunca são apagados, mesmo passando dos dias.
BACKUP_KEEP_MIN="${BACKUP_KEEP_MIN:-3}"
MODE="${1:-backup}"
BACKUP_DB_NAMES="${BACKUP_DB_NAMES:-financeiro}"
BACKUP_CACHE_PATHS="${BACKUP_CACHE_PATHS:-}"
# Certificados e chaves (Inter em data/certs, A1 em secrets) nunca entram no tar: o backup
# pode ser copiado para fora do servidor (BACKUP_RSYNC_TARGET). Padrões do `tar --exclude`.
BACKUP_CACHE_EXCLUDES="${BACKUP_CACHE_EXCLUDES:-certs secrets *.key *.pem *.pfx *.p12 *.crt}"
MARIADB_CONTAINER="${MARIADB_CONTAINER:-}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:?defina DB_USER no backup.env}"
DB_PASSWORD="${DB_PASSWORD:-}"
BACKUP_RSYNC_TARGET="${BACKUP_RSYNC_TARGET:-}"
# Criptografia (age) por chave pública. Com qualquer uma das duas definida, o dump e os
# caches ganham uma cópia .age e só os .age (mais o SHA256SUMS) vão para BACKUP_RSYNC_TARGET.
# A chave privada NÃO fica no servidor. Ver scripts/backup/README.md.
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
BACKUP_AGE_RECIPIENTS_FILE="${BACKUP_AGE_RECIPIENTS_FILE:-}"
AGE_BIN="${AGE_BIN:-age}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

# Docker rootless: no timer do systemd (ou no cron) não existe o DOCKER_HOST que o
# .bashrc define, e o CLI procuraria o socket no lugar errado. Usa o socket do
# usuário quando ele existe; DOCKER_HOST no backup.env tem prioridade.
if [[ ( -n "$MARIADB_CONTAINER" || "$MODE" == "verify-restore" ) && -z "${DOCKER_HOST:-}" ]]; then
  ROOTLESS_SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
  if [[ -S "$ROOTLESS_SOCK" ]]; then
    export DOCKER_HOST="unix://$ROOTLESS_SOCK"
  fi
fi

STAMP="$(date +%Y-%m-%d_%H%M%S)"
TARGET="$BACKUP_DIR/$STAMP"
STATUS_FILE="$BACKUP_DIR/last-backup.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"
CURRENT_STEP="preparação"
ERR_LOG="$BACKUP_DIR/.backup-erro-$STAMP.log"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

# Grava o status de forma atômica (arquivo temporário + mv) para o gateway nunca
# ler um JSON pela metade.
write_status() {
  local status="$1" error="${2:-}"
  local finished_at size files_json="" first=1 f
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  size=0
  if [[ -d "$TARGET" ]]; then
    size="$(du -sb "$TARGET" 2>/dev/null | cut -f1 || echo 0)"
    for f in "$TARGET"/*; do
      [[ -f "$f" ]] || continue
      [[ $first -eq 1 ]] || files_json+=","
      first=0
      files_json+="{\"name\":\"$(json_escape "$(basename "$f")")\",\"bytes\":$(stat -c %s "$f")}"
    done
  fi
  mkdir -p "$BACKUP_DIR"
  cat >"$STATUS_FILE.tmp" <<JSON
{
  "status": "$status",
  "startedAt": "$STARTED_AT",
  "finishedAt": "$finished_at",
  "durationSeconds": $(( $(date +%s) - STARTED_EPOCH )),
  "directory": "$(json_escape "$TARGET")",
  "sizeBytes": ${size:-0},
  "files": [${files_json}],
  "retentionDays": $BACKUP_RETENTION_DAYS,
  "offsite": $([[ -n "$BACKUP_RSYNC_TARGET" ]] && echo true || echo false),
  "encrypted": $(encryption_enabled && echo true || echo false),
  "error": $([[ -n "$error" ]] && printf '"%s"' "$(json_escape "$error")" || echo null)
}
JSON
  chmod 644 "$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

on_error() {
  local code=$? detalhe=""
  # Primeira mensagem do comando que falhou (ex.: "tar: …: Cannot open: Permission denied"),
  # para a página Saúde do sistema mostrar o motivo e não só o código.
  if [[ -s "$ERR_LOG" ]]; then
    cat "$ERR_LOG" >&2
    detalhe=" — $(grep -v -m1 '^tar: Exiting' "$ERR_LOG" || head -n1 "$ERR_LOG")"
    rm -f "$ERR_LOG"
  fi
  log "ERRO na etapa: $CURRENT_STEP (código $code)$detalhe"
  # Backup incompleto: fica marcado para ninguém restaurar dele por engano.
  [[ -d "$TARGET" ]] && echo "$CURRENT_STEP" >"$TARGET/FALHOU"
  write_status "error" "Falha na etapa: $CURRENT_STEP (código $code)$detalhe"
  exit "$code"
}

# Docker rootless: arquivos que os containers criam nos volumes ficam com dono subuid no
# host (ex.: 100999) e, quando não são públicos, o usuário do backup não os lê — o tar
# para com "Permission denied" (código 2). Dentro do namespace de usuário do dockerd
# rootless esse mesmo usuário é root e enxerga os subuids. Imprime o prefixo nsenter
# (um argumento por linha) ou nada, quando não há Docker rootless ou BACKUP_CACHE_USERNS=off.
rootless_userns() {
  [[ "${BACKUP_CACHE_USERNS:-auto}" == "off" ]] && return 0
  local pidfile="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.pid" pid
  [[ -r "$pidfile" ]] || return 0
  pid="$(cat "$pidfile")"
  [[ -n "$pid" && -d "/proc/$pid" ]] || return 0
  command -v nsenter >/dev/null 2>&1 || return 0
  # Só vale se o dockerd for do próprio usuário (rootless) e o nsenter funcionar.
  nsenter -U --preserve-credentials -t "$pid" -- true 2>/dev/null || return 0
  printf '%s\n' nsenter -U --preserve-credentials -t "$pid" --
}
# Falha com mensagem própria (sem depender do stderr de um comando), ex.: configuração
# inválida detectada antes de começar.
fail() {
  local msg="$1"
  trap - ERR
  log "ERRO: $msg"
  [[ -d "$TARGET" ]] && echo "$CURRENT_STEP" >"$TARGET/FALHOU"
  write_status "error" "Falha na etapa: $CURRENT_STEP — $msg"
  exit 1
}

encryption_enabled() {
  [[ -n "$BACKUP_AGE_RECIPIENT" || -n "$BACKUP_AGE_RECIPIENTS_FILE" ]]
}

# Argumentos -r/-R do age. BACKUP_AGE_RECIPIENT aceita uma ou mais chaves age1…
# (separadas por espaço ou vírgula); chaves SSH ou listas maiores vão num arquivo
# (BACKUP_AGE_RECIPIENTS_FILE, uma por linha).
age_recipient_args() {
  local r
  for r in ${BACKUP_AGE_RECIPIENT//,/ }; do printf '%s\n' -r "$r"; done
  if [[ -n "$BACKUP_AGE_RECIPIENTS_FILE" ]]; then printf '%s\n' -R "$BACKUP_AGE_RECIPIENTS_FILE"; fi
}

# Antes de qualquer dump: com a criptografia pedida e sem o age, o backup não pode
# seguir (mandaria texto claro para fora) — falha com o motivo no last-backup.json.
check_encryption() {
  CURRENT_STEP="criptografia (age)"
  if ! encryption_enabled; then
    if [[ -n "$BACKUP_RSYNC_TARGET" ]]; then
      log "Aviso: BACKUP_AGE_RECIPIENT vazio — a cópia externa vai SEM criptografia (ver README)"
    else
      log "Aviso: BACKUP_AGE_RECIPIENT vazio — backup sem criptografia"
    fi
    return 0
  fi
  if ! command -v "$AGE_BIN" >/dev/null 2>&1; then
    fail "BACKUP_AGE_RECIPIENT definido, mas o comando '$AGE_BIN' não está instalado no servidor (instale o pacote age ou ajuste AGE_BIN)"
  fi
  if [[ -n "$BACKUP_AGE_RECIPIENTS_FILE" && ! -r "$BACKUP_AGE_RECIPIENTS_FILE" ]]; then
    fail "BACKUP_AGE_RECIPIENTS_FILE não encontrado ou ilegível: $BACKUP_AGE_RECIPIENTS_FILE"
  fi
}

# Cria <arquivo>.age de cada dump/cache e confere que não ficou vazio.
encrypt_files() {
  local recipients=() f
  mapfile -t recipients < <(age_recipient_args)
  for f in "$TARGET"/*.sql.gz "$TARGET"/caches.tar.gz; do
    [[ -f "$f" ]] || continue
    log "Criptografando $(basename "$f")"
    "$AGE_BIN" "${recipients[@]}" -o "$f.age" "$f" 2>"$ERR_LOG"
    [[ -s "$f.age" ]]
    rm -f "$ERR_LOG"
  done
}
trap on_error ERR

dump_database() {
  local db="$1"
  local out="$TARGET/mariadb-$db.sql.gz"
  local args=(--single-transaction --quick --routines --triggers --events --hex-blob
    --default-character-set=utf8mb4 --user="$DB_USER" --databases "$db")
  if [[ -n "$MARIADB_CONTAINER" ]]; then
    # Dentro do container do MariaDB: o dump usa o cliente da mesma versão do servidor.
    # `-e MYSQL_PWD` sem valor: o docker copia a variável do próprio ambiente, então a
    # senha não aparece na linha de comando (ps / /proc/<pid>/cmdline). O MYSQL_PWD vale
    # só para este comando.
    MYSQL_PWD="$DB_PASSWORD" "$DOCKER_BIN" exec -i -e MYSQL_PWD "$MARIADB_CONTAINER" \
      sh -c 'if command -v mariadb-dump >/dev/null 2>&1; then exec mariadb-dump "$@"; else exec mysqldump "$@"; fi' \
      dump "${args[@]}" | gzip -9 >"$out"
  else
    local bin=mariadb-dump
    command -v "$bin" >/dev/null 2>&1 || bin=mysqldump
    # Senha só no ambiente do processo (não na linha de comando).
    MYSQL_PWD="$DB_PASSWORD" "$bin" --host="$DB_HOST" --port="$DB_PORT" "${args[@]}" | gzip -9 >"$out"
  fi
  # Um dump que parou no meio não termina com a linha "-- Dump completed".
  CURRENT_STEP="conferência do dump de $db"
  gzip -t "$out"
  zcat "$out" | tail -n 1 | grep -q -- "-- Dump completed"
}

# Backup bem-sucedido = tem BACKUP_OK. Pastas anteriores a este marcador (sem ele) valem como
# boas se tiverem SHA256SUMS e não tiverem FALHOU.
backup_ok() {
  local d="$1"
  [[ -f "$d/BACKUP_OK" ]] && return 0
  [[ -f "$d/SHA256SUMS" && ! -f "$d/FALHOU" ]]
}

# Apaga somente o que for mais velho que BACKUP_RETENTION_DAYS E não estiver entre os
# BACKUP_KEEP_MIN backups bem-sucedidos mais recentes.
apply_retention() {
  local d kept=0 name
  local -a dirs=()
  mapfile -t dirs < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' | sort -r)
  declare -A protegido=()
  for d in "${dirs[@]}"; do
    [[ $kept -ge $BACKUP_KEEP_MIN ]] && break
    if backup_ok "$d"; then
      protegido["$d"]=1
      kept=$((kept + 1))
    fi
  done
  for d in "${dirs[@]}"; do
    [[ -n ${protegido[$d]:-} ]] && continue
    # Idade pelo mtime da pasta, como antes (-mtime +N = mais de N dias).
    if [[ -n $(find "$d" -maxdepth 0 -mtime +"$BACKUP_RETENTION_DAYS") ]]; then
      name="$(basename "$d")"
      rm -rf -- "$d"
      echo "Removido: $name"
    fi
  done
  log "Retenção: $kept backup(s) bem-sucedido(s) recente(s) protegido(s) (BACKUP_KEEP_MIN=$BACKUP_KEEP_MIN)"
}

main() {
  mkdir -p "$BACKUP_DIR"
  check_encryption
  mkdir -p "$TARGET"
  # A raiz só precisa ser atravessável (711) para o gateway, que roda como outro
  # usuário no Docker rootless, ler o last-backup.json (644). As pastas de cada
  # backup continuam 700.
  chmod 711 "$BACKUP_DIR"
  log "Backup em $TARGET"

  local db
  for db in $BACKUP_DB_NAMES; do
    CURRENT_STEP="dump do banco $db"
    log "Dump do banco $db"
    dump_database "$db"
  done

  if [[ -n "$BACKUP_CACHE_PATHS" ]]; then
    CURRENT_STEP="cópia dos caches"
    local existing=() p
    for p in $BACKUP_CACHE_PATHS; do
      if [[ -e "$p" ]]; then
        # Relativo à raiz: restaure com `tar -xzf caches.tar.gz -C /`.
        p="$(realpath "$p")"
        existing+=("${p#/}")
      else
        log "Aviso: $p não existe, ignorado"
      fi
    done
    if [[ ${#existing[@]} -gt 0 ]]; then
      log "Caches: ${existing[*]/#//}"
      local userns=()
      mapfile -t userns < <(rootless_userns)
      [[ ${#userns[@]} -gt 0 ]] && log "Lendo os caches no namespace do Docker rootless"
      local excludes=() e
      set -f  # os padrões (*.key…) não podem ser expandidos pelo shell
      for e in $BACKUP_CACHE_EXCLUDES; do excludes+=("--exclude=$e"); done
      set +f
      "${userns[@]}" tar -czf "$TARGET/caches.tar.gz" "${excludes[@]}" -C / "${existing[@]}" 2>"$ERR_LOG"
      tar -tzf "$TARGET/caches.tar.gz" >/dev/null
      rm -f "$ERR_LOG"
    fi
  fi

  if encryption_enabled; then
    CURRENT_STEP="criptografia (age)"
    encrypt_files
  fi

  CURRENT_STEP="soma de verificação"
  (cd "$TARGET" && sha256sum -- * >SHA256SUMS)

  if [[ -n "$BACKUP_RSYNC_TARGET" ]]; then
    CURRENT_STEP="cópia externa (rsync)"
    log "Copiando para $BACKUP_RSYNC_TARGET"
    if encryption_enabled; then
      # Só os .age e o SHA256SUMS saem do servidor. --delete-excluded apaga, no destino,
      # qualquer texto claro que já estivesse nessa pasta. Lá fora, confira com
      # `sha256sum -c --ignore-missing SHA256SUMS`.
      rsync -a --delete-excluded --include='*.age' --include='SHA256SUMS' --exclude='*' \
        "$TARGET/" "$BACKUP_RSYNC_TARGET/$STAMP/"
    else
      rsync -a "$TARGET" "$BACKUP_RSYNC_TARGET/"
    fi
  fi

  # Marcador de sucesso: só agora o backup está completo (dump conferido, criptografia,
  # SHA256SUMS e cópia externa). A retenção conta apenas as pastas que o têm.
  date -u +%Y-%m-%dT%H:%M:%SZ >"$TARGET/BACKUP_OK"

  CURRENT_STEP="limpeza dos backups antigos"
  apply_retention

  write_status "ok"
  log "Backup concluído ($(du -sh "$TARGET" | cut -f1))"
}

# Teste de restauração: carrega o último backup bom num MariaDB descartável e conta as tabelas.
#   * padrão: sobe um container ($DOCKER_BIN = docker ou podman rootless) com VERIFY_MARIADB_IMAGE,
#     restaura nele e o derruba no fim; nada toca no banco de produção;
#   * VERIFY_DB_HOST definido: usa esse servidor TEMPORÁRIO (VERIFY_DB_USER/VERIFY_DB_PASSWORD/
#     VERIFY_DB_PORT) com um banco de nome único, que é apagado no fim. NUNCA aponte para o
#     servidor de produção.
# Dumps só em .age exigem BACKUP_AGE_IDENTITY (chave privada) na hora do teste.
verify_restore() {
  trap - ERR
  # Globais de propósito: o trap de EXIT roda depois que a função retorna.
  vdir="" cname="" tmp="" status="erro" msg="" tables=0
  local dump_tables=0 total=0 db
  local VERIFY_IMAGE="${VERIFY_MARIADB_IMAGE:-mariadb:11}"
  local VERIFY_MIN_TABLES="${VERIFY_MIN_TABLES:-1}"
  VERIFY_FILE="$BACKUP_DIR/last-verify.json"

  verify_finish() {
    local code=$?
    [[ -n "$cname" ]] && "$DOCKER_BIN" rm -f "$cname" >/dev/null 2>&1 || true
    [[ -n "$tmp" ]] && rm -rf -- "$tmp"
    if [[ -d "$BACKUP_DIR" ]]; then
      printf '{"status":"%s","checkedAt":"%s","backup":"%s","tables":%s,"message":"%s"}\n' \
        "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$(basename "${vdir:-}")")" "$tables" "$(json_escape "$msg")" \
        >"$VERIFY_FILE.tmp" && chmod 644 "$VERIFY_FILE.tmp" && mv -f "$VERIFY_FILE.tmp" "$VERIFY_FILE"
    fi
    if [[ "$status" == "ok" ]]; then log "verify-restore OK: $tables tabela(s) restaurada(s)"; else log "verify-restore FALHOU: ${msg:-erro inesperado (código $code)}"; fi
    return 0
  }
  verify_fail() { msg="$1"; status="erro"; exit 1; }
  trap verify_finish EXIT

  local d
  while IFS= read -r d; do
    if backup_ok "$d"; then vdir="$d"; break; fi
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' | sort -r)
  [[ -n "$vdir" ]] || verify_fail "nenhum backup bem-sucedido em $BACKUP_DIR"
  log "verify-restore: usando $vdir"
  (cd "$vdir" && sha256sum --quiet -c SHA256SUMS) || verify_fail "SHA256SUMS não confere em $vdir"

  tmp="$(mktemp -d)"
  local rootpw; rootpw="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  local client=() VPW
  if [[ -n "${VERIFY_DB_HOST:-}" ]]; then
    VPW="${VERIFY_DB_PASSWORD:-}"
    local bin=mariadb; command -v "$bin" >/dev/null 2>&1 || bin=mysql
    command -v "$bin" >/dev/null 2>&1 || verify_fail "cliente mariadb/mysql não instalado para VERIFY_DB_HOST"
    client=(env MYSQL_PWD="$VPW" "$bin" --host="$VERIFY_DB_HOST" --port="${VERIFY_DB_PORT:-3306}" --user="${VERIFY_DB_USER:?defina VERIFY_DB_USER}")
  else
    command -v "$DOCKER_BIN" >/dev/null 2>&1 || verify_fail "'$DOCKER_BIN' não encontrado (docker/podman rootless ou VERIFY_DB_HOST)"
    cname="norvia-verify-restore-$$"
    log "Subindo MariaDB descartável ($VERIFY_IMAGE)"
    MARIADB_ROOT_PASSWORD="$rootpw" "$DOCKER_BIN" run -d --name "$cname" -e MARIADB_ROOT_PASSWORD "$VERIFY_IMAGE" >/dev/null \
      || verify_fail "não consegui subir o container $VERIFY_IMAGE"
    client=(env MYSQL_PWD="$rootpw" "$DOCKER_BIN" exec -i -e MYSQL_PWD "$cname" mariadb -uroot)
    local ready=0
    for _ in $(seq 60); do
      if "${client[@]}" -e 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
      sleep 2
    done
    [[ $ready -eq 1 ]] || verify_fail "MariaDB descartável não ficou pronto em 120 s"
  fi

  for db in $BACKUP_DB_NAMES; do
    local gz="$vdir/mariadb-$db.sql.gz" sqldb="$db"
    if [[ ! -f "$gz" && -f "$gz.age" ]]; then
      [[ -n "${BACKUP_AGE_IDENTITY:-}" ]] || verify_fail "só existe $gz.age: defina BACKUP_AGE_IDENTITY (chave privada) para o teste"
      "$AGE_BIN" -d -i "$BACKUP_AGE_IDENTITY" -o "$tmp/dump.sql.gz" "$gz.age" || verify_fail "falha ao descriptografar $gz.age"
      gz="$tmp/dump.sql.gz"
    fi
    [[ -f "$gz" ]] || verify_fail "dump de $db não encontrado em $vdir"
    log "Restaurando $db"
    if [[ -n "${VERIFY_DB_HOST:-}" ]]; then
      # Servidor externo: renomeia o banco para um nome único e descartável (nunca sobrescreve o real).
      sqldb="verify_${db}_$$"
      zcat "$gz" | sed "s/\`$db\`/\`$sqldb\`/g" | "${client[@]}" || verify_fail "falha ao carregar o dump de $db"
    else
      zcat "$gz" | "${client[@]}" || verify_fail "falha ao carregar o dump de $db"
    fi
    tables="$("${client[@]}" --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$sqldb' AND TABLE_TYPE='BASE TABLE'")"
    dump_tables="$(zcat "$gz" | grep -c '^CREATE TABLE' || true)"
    log "Banco $db: $tables tabela(s) restaurada(s) (o dump declara $dump_tables CREATE TABLE)"
    [[ "$tables" -ge "$VERIFY_MIN_TABLES" ]] || verify_fail "banco $db restaurado com $tables tabela(s) (mínimo $VERIFY_MIN_TABLES)"
    total=$((total + tables))
    [[ -n "${VERIFY_DB_HOST:-}" ]] && "${client[@]}" -e "DROP DATABASE IF EXISTS \`$sqldb\`"
  done
  tables=$total
  status="ok"
  msg=""
}

case "$MODE" in
  backup) main ;;
  verify-restore) verify_restore ;;
  *) echo "uso: $0 [backup | verify-restore]" >&2; exit 2 ;;
esac
