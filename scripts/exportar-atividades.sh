#!/usr/bin/env bash
# ==============================================================================
# Exporta as ações dos usuários (tabela atividades_treino) em JSONL para fine-tuning.
#
#   scripts/exportar-atividades.sh > atividades.jsonl
#   scripts/exportar-atividades.sh --desde 2026-11-01 --permissao revisao_nfe:lancar > nfe.jsonl
#
# Uma linha por ação: {id, criado_em, usuario_id, perfil, setor, metodo, rota, permissao, consulta,
# entrada, contexto, sugestao, resposta, truncado, status, duracao_ms}. entrada é a decisão humana;
# contexto e sugestao só vêm nas ações instrumentadas (ex.: categorização da NF-e).
# Os dados já estão mascarados pelo gateway (backend/gateway/src/atividades.ts).
#
# Rode na VPS a partir de ~/norvia/interface-web. Pede a senha do MariaDB (ou use MYSQL_PWD);
# EXPORT_DB_SERVICE (padrão mariadb) e EXPORT_DB_USER (padrão root) ajustam serviço e usuário.
# ==============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
DB_SERVICE=${EXPORT_DB_SERVICE:-mariadb}
DB_USER=${EXPORT_DB_USER:-root}
desde=""
permissao=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --desde) desde=${2:-}; shift 2 ;;
    --permissao) permissao=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1 (use --desde AAAA-MM-DD e/ou --permissao <aba:acao>)" >&2; exit 2 ;;
  esac
done

[[ -z $desde || $desde =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "--desde deve ser AAAA-MM-DD" >&2; exit 2; }
[[ -z $permissao || $permissao =~ ^[a-z_]+(:[a-z_]+)?$ ]] || { echo "--permissao deve ser como revisao_nfe:lancar" >&2; exit 2; }

filtros="1=1"
[[ -n $desde ]] && filtros+=" AND criado_em >= '$desde'"
[[ -n $permissao ]] && filtros+=" AND permissao = '$permissao'"

if [[ -z ${MYSQL_PWD:-} ]]; then
  read -r -s -p "Senha do MariaDB ($DB_USER): " MYSQL_PWD
  echo >&2
fi
export MYSQL_PWD

# Campo JSON válido vai como objeto; truncado (JSON cortado) vai como texto. O JSON_EXTRACT fica por
# fora: dentro de um IF o MariaDB perde o tipo JSON e o objeto sairia como texto.
j() { echo "JSON_EXTRACT(IF(JSON_VALID($1), $1, JSON_QUOTE($1)), '\$')"; }

docker compose exec -T -e MYSQL_PWD "$DB_SERVICE" \
  mariadb --batch --raw --skip-column-names -u"$DB_USER" financeiro <<SQL
SELECT JSON_OBJECT(
  'id', id, 'criado_em', DATE_FORMAT(criado_em, '%Y-%m-%dT%H:%i:%s.%fZ'), 'usuario_id', usuario_id,
  'perfil', perfil, 'setor', setor, 'metodo', metodo, 'rota', rota, 'permissao', permissao,
  'consulta', $(j consulta), 'entrada', $(j entrada), 'contexto', $(j contexto),
  'sugestao', $(j sugestao), 'resposta', $(j resposta),
  'truncado', truncado = 1, 'status', status, 'duracao_ms', duracao_ms
)
FROM atividades_treino WHERE $filtros ORDER BY id;
SQL
