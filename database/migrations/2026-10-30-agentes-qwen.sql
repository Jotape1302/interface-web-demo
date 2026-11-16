-- =============================================================================
-- Aba Agentes Qwen (2026-10-30) - agentes_qwen_estado e agentes_qwen_avisos
-- =============================================================================
-- Tabelas novas (database/init/10-agentes-qwen.sql). O gateway também as cria no bootstrap
-- (agentes-qwen.ts) se o usuário do banco tiver CREATE; esta migração só registra a versão.
-- Sem pré-condição nem parte destrutiva. ORDEM: qualquer uma (antes ou depois do gateway).
-- Idempotente.
-- =============================================================================

USE financeiro;

CREATE TABLE IF NOT EXISTS agentes_qwen_estado (
  id TINYINT PRIMARY KEY,
  dados LONGTEXT NOT NULL,
  recebido_em DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agentes_qwen_avisos (
  chave VARCHAR(96) PRIMARY KEY,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
