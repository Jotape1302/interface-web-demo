# Migrações do MariaDB

Aplicadas à mão no servidor com `scripts/migrate.sh` (status / apply / mark); o registro fica
na tabela `schema_migrations`.

## Regra: toda migração nova entra também no baseline do `init/07`

Banco novo nasce dos scripts `database/init/01..08`, que já refletem o estado final. Por isso
**cada arquivo novo desta pasta precisa**:

1. ser espelhado no DDL do `database/init` correspondente (tabela/coluna/índice/FK);
2. ser acrescentado à lista do `INSERT IGNORE` em `database/init/07-schema-migrations.sql`
   (checksum `baseline`), senão um banco novo apareceria com a migração como PENDENTE.

Convenções: nome `AAAA-MM-DD-assunto.sql`, cabeçalho com pré-condições e ordem de deploy
(a parte destrutiva avisada), idempotente (`IF NOT EXISTS` / `IF EXISTS`) e, se depender do
estado dos dados, abortando com `SIGNAL SQLSTATE '45000'` e uma mensagem que diga a query
para listar o problema. Blocos `BEGIN NOT ATOMIC` usam `DELIMITER //` e devolvem `DELIMITER ;`.

## Migrações de 2026-10-27

- `2026-10-27-baixas-sucesso-unico.sql`: UNIQUE de baixa com sucesso por conta. Aborta se
  houver duplicatas (a query para listá-las está no cabeçalho). **Aplicar antes de subir o
  gateway** que trata o `ER_DUP_ENTRY`.
- `2026-10-27-indices-sessoes-e-fks-usuarios.sql`: índices de sessões, remoção de índices
  redundantes e FKs `ON DELETE SET NULL` em `usuarios`. Aborta se houver órfãos.

## Migração de 2026-10-30

- `2026-10-30-atividades-treino.sql`: tabela `atividades_treino` (ações dos usuários para treino
  de modelos, ver `backend/gateway/src/atividades.ts`). Só cria a tabela; ordem livre.
- `2026-10-30-agentes-qwen.sql`: tabelas `agentes_qwen_estado` e `agentes_qwen_avisos` (aba Agentes
  Qwen, ver `backend/gateway/src/agentes-qwen.ts`). Só cria as tabelas; ordem livre.
- `2026-10-30-agentes-qwen-comandos.sql`: tabela `agentes_qwen_comandos` (botão "Marcar como
  resolvido" da aba Agentes Qwen). Só cria a tabela; ordem livre.
- `2026-10-30-reportar-erro-agentes.sql`: colunas `mensagem_erro`, `agente_incidente_id` e
  `agente_grupo` em `incidentes` ("Reportar erro" vai aos agentes Qwen) e apaga as permissões
  `erros:*` (aba Erros & Falhas removida). Ordem livre.
