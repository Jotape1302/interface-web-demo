-- =============================================================================
-- 04-incidentes-schema.sql - INCIDENTES REPORTADOS PELOS OPERADORES (NORVIA)
-- =============================================================================
-- Reportes do botão "Reportar erro" das abas. Vão aos agentes Qwen (agente_incidente_id é o
-- incidente que os recebeu no PC; agente_grupo, onde ele está). O gateway também cria esta tabela
-- no bootstrap (incidents.ts) se ela ainda não existir.

USE financeiro;

CREATE TABLE IF NOT EXISTS incidentes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    execution_id VARCHAR(255) NOT NULL,
    automation_id VARCHAR(50) NOT NULL,
    automation_title VARCHAR(255) NOT NULL,
    stopped_node VARCHAR(255) NULL,
    reported_by_id INT NULL,
    reported_by VARCHAR(255) NOT NULL,
    user_role VARCHAR(50) NOT NULL,
    reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status ENUM('pending', 'resolved') NOT NULL DEFAULT 'pending',
    diagnostic_explanation TEXT NULL,
    recommended_action TEXT NULL,
    operator_note TEXT NULL,
    resolved_at DATETIME NULL,
    resolved_by VARCHAR(255) NULL,
    mensagem_erro TEXT NULL,
    agente_incidente_id INT NULL,
    agente_grupo VARCHAR(20) NULL,
    INDEX idx_incidentes_status (status),
    INDEX idx_incidentes_execucao (execution_id),
    INDEX idx_incidentes_agente (agente_incidente_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
