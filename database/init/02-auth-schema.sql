-- =============================================================================
-- 02-auth-schema.sql - SISTEMA DE AUTENTICAÇÃO E PERMISSÕES (NORVIA)
-- =============================================================================

USE financeiro;

-- 1. Tabela de Usuários
CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    setor VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    role ENUM('admin', 'gestor', 'user') NOT NULL DEFAULT 'user',
    is_root BOOLEAN NOT NULL DEFAULT FALSE, -- admin raiz (seed); nunca rebaixado/excluído
    status ENUM('pending', 'approved', 'rejected', 'blocked') NOT NULL DEFAULT 'pending',
    permissoes_versao INT UNSIGNED NOT NULL DEFAULT 0, -- concorrência otimista do editor de permissões
    permissoes_alterado_por INT NULL,
    permissoes_alterado_em DATETIME NULL,
    aprovado_por INT NULL,
    aprovado_em DATETIME NULL,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_usuarios_email (email),
    INDEX idx_usuarios_status (status),
    INDEX idx_usuarios_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabela de Permissões de Usuários
CREATE TABLE IF NOT EXISTS usuario_permissoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    recurso VARCHAR(100) NOT NULL, -- chave '<aba>:<acao>' do catálogo do gateway (RBAC por usuário); só concessões
    permitido BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_usuario_recurso (usuario_id, recurso),
    INDEX idx_perm_usuario (usuario_id),
    CONSTRAINT fk_permissoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Tabela de Sessões Ativas (Controle de Logados e Forçar Logout)
CREATE TABLE IF NOT EXISTS usuario_sessoes (
    id VARCHAR(128) NOT NULL PRIMARY KEY, -- Token de sessão (hash hex)
    usuario_id INT NOT NULL,
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,
    ultimo_acesso DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expira_em DATETIME NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessoes_usuario (usuario_id),
    INDEX idx_sessoes_ativo (ativo),
    CONSTRAINT fk_sessoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
