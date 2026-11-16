-- =============================================================================
-- Registro das migrações aplicadas (scripts/migrate.sh). Instalação nova: as migrações
-- abaixo já estão cobertas pelos scripts 01-06 e pelo bootstrap do gateway, então entram
-- como aplicadas, com checksum 'baseline' (o migrate.sh não compara o arquivo nesse caso).
-- No servidor existente a tabela é criada pelo próprio migrate.sh; as que já foram
-- rodadas à mão se registram com `scripts/migrate.sh mark <arquivo>`.
-- REGRA: toda migração nova de database/migrations entra também nesta lista (ver o
-- README daquela pasta). Cobertas pelos scripts 01-08.
-- =============================================================================

USE financeiro;

CREATE TABLE IF NOT EXISTS schema_migrations (
  versao       VARCHAR(255) NOT NULL PRIMARY KEY,
  checksum     CHAR(64)     NOT NULL,
  aplicada_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aplicada_por VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (versao, checksum, aplicada_por) VALUES
  ('2026-09-28-remove-conciliacao-contas-pagar.sql', 'baseline', 'init'),
  ('2026-10-06-sessoes-token-hash.sql', 'baseline', 'init'),
  ('2026-10-08-rbac-permissoes-por-usuario.sql', 'baseline', 'init'),
  ('2026-10-27-baixas-sucesso-unico.sql', 'baseline', 'init'),
  ('2026-10-27-indices-sessoes-e-fks-usuarios.sql', 'baseline', 'init'),
  ('2026-10-30-atividades-treino.sql', 'baseline', 'init'),
  ('2026-10-30-agentes-qwen.sql', 'baseline', 'init'),
  ('2026-10-30-agentes-qwen-comandos.sql', 'baseline', 'init'),
  ('2026-10-30-reportar-erro-agentes.sql', 'baseline', 'init');
