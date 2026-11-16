-- =============================================================================
-- Aba Agentes Qwen: botão "Marcar como resolvido" (2026-10-30) - agentes_qwen_comandos
-- =============================================================================
-- Tabela nova (database/init/10-agentes-qwen.sql). O gateway também a cria no bootstrap
-- (agentes-qwen.ts) se o usuário do banco tiver CREATE; esta migração só registra a versão.
-- Sem pré-condição nem parte destrutiva. ORDEM: qualquer uma (antes ou depois do gateway).
-- Idempotente.
-- =============================================================================

USE financeiro;

CREATE TABLE IF NOT EXISTS agentes_qwen_comandos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  incidente_id INT NOT NULL,
  acao VARCHAR(16) NOT NULL,
  nota TEXT NULL,
  usuario VARCHAR(100) NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  concluido_em DATETIME NULL,
  INDEX idx_agentes_qwen_comandos_pendentes (concluido_em, incidente_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
