-- =============================================================================
-- 05-auditoria-schema.sql - LOG DE AUDITORIA DAS AÇÕES DOS USUÁRIOS (NORVIA)
-- =============================================================================
-- Quem fez o quê, em quê e quando: aprovações, exclusões, permissões, lançamentos de
-- NF-e, incidentes resolvidos, logins. Não guarda senha, token nem conteúdo de nota.
-- O gateway também cria esta tabela no bootstrap (audit.ts) se ela ainda não existir.
-- criado_em é gravado em UTC.

USE financeiro;

CREATE TABLE IF NOT EXISTS auditoria_acoes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NULL,
    usuario_nome VARCHAR(255) NOT NULL,
    acao VARCHAR(64) NOT NULL,
    alvo VARCHAR(255) NULL,
    detalhes TEXT NULL,
    sucesso TINYINT(1) NOT NULL DEFAULT 1,
    ip VARCHAR(64) NULL,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_auditoria_criado (criado_em),
    INDEX idx_auditoria_usuario (usuario_id),
    INDEX idx_auditoria_acao (acao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
