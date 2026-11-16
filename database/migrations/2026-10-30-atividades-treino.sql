-- =============================================================================
-- Ações dos usuários para treino de modelos (2026-10-30) - atividades_treino
-- =============================================================================
-- Tabela nova (database/init/09-atividades-treino.sql). O gateway também a cria no bootstrap
-- (atividades.ts) se o usuário do banco tiver CREATE; esta migração só registra a versão.
-- Sem pré-condição nem parte destrutiva. ORDEM: qualquer uma (antes ou depois do gateway).
-- Idempotente.
-- =============================================================================

USE financeiro;

CREATE TABLE IF NOT EXISTS atividades_treino (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NULL,
  perfil VARCHAR(32) NULL,
  setor VARCHAR(64) NULL,
  metodo VARCHAR(8) NOT NULL,
  rota VARCHAR(255) NOT NULL,
  permissao VARCHAR(96) NULL,
  consulta TEXT NULL,
  entrada LONGTEXT NULL,
  contexto LONGTEXT NULL,
  sugestao LONGTEXT NULL,
  resposta LONGTEXT NULL,
  truncado TINYINT(1) NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL,
  duracao_ms INT NULL,
  request_id VARCHAR(64) NULL,
  criado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_atividades_criado (criado_em),
  INDEX idx_atividades_permissao (permissao, criado_em),
  INDEX idx_atividades_rota (rota, criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
