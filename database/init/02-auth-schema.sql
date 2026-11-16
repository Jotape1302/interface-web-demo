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
    -- (sem índice próprio em email: o UNIQUE já indexa; idx_usuarios_email era redundante)
    INDEX idx_usuarios_status (status),
    INDEX idx_usuarios_role (role),
    -- Quem aprovou / alterou permissões: se esse usuário for excluído, o registro fica sem autor.
    CONSTRAINT fk_usuarios_aprovado_por FOREIGN KEY (aprovado_por) REFERENCES usuarios(id) ON DELETE SET NULL,
    CONSTRAINT fk_usuarios_perm_alterado_por FOREIGN KEY (permissoes_alterado_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabela de Permissões de Usuários
CREATE TABLE IF NOT EXISTS usuario_permissoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    recurso VARCHAR(100) NOT NULL, -- chave '<aba>:<acao>' do catálogo do gateway (RBAC por usuário); só concessões
    permitido BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_usuario_recurso (usuario_id, recurso),
    -- (sem idx_perm_usuario: o UNIQUE (usuario_id, recurso) já serve de índice da FK)
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
    INDEX idx_sessoes_usuario_ativo_expira (usuario_id, ativo, expira_em),
    INDEX idx_sessoes_expira (expira_em),
    CONSTRAINT fk_sessoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SEM FK de propósito: auditoria_acoes.usuario_id (05) e conciliacao_baixas_historico.usuario_id
-- (06) guardam quem fez a ação. O histórico deve sobreviver à exclusão do usuário (a linha
-- guarda também usuario_nome), então não pode haver CASCADE nem SET NULL ali.
