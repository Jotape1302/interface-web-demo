-- =============================================================================
-- 03-notificacoes-schema.sql - ALTERAÇÕES DE CADASTRO, NOTIFICAÇÕES E CHAT (NORVIA)
-- =============================================================================

USE financeiro;

-- 4. Solicitações de alteração de cadastro (username/e-mail) pendentes de aprovação admin
CREATE TABLE IF NOT EXISTS usuario_alteracoes_pendentes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    tipo ENUM('username', 'email') NOT NULL,
    valor_atual VARCHAR(255) NOT NULL,
    valor_novo VARCHAR(255) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    solicitado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revisado_por INT NULL,
    revisado_em DATETIME NULL,
    INDEX idx_alt_usuario (usuario_id),
    INDEX idx_alt_status (status),
    CONSTRAINT fk_alt_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT fk_alt_revisor FOREIGN KEY (revisado_por) REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Notificações persistidas (histórico com estado lido/não lido, uma linha por destinatário)
CREATE TABLE IF NOT EXISTS notificacoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    destinatario_id INT NOT NULL,
    tipo VARCHAR(50) NOT NULL, -- 'cadastro_pendente','alteracao_pendente','alteracao_aprovada','alteracao_rejeitada','execucao_erro'
    titulo VARCHAR(255) NOT NULL,
    mensagem TEXT NULL,
    link VARCHAR(255) NULL,
    lida BOOLEAN NOT NULL DEFAULT FALSE,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lida_em DATETIME NULL,
    INDEX idx_notif_destinatario_lida (destinatario_id, lida),
    CONSTRAINT fk_notif_usuario FOREIGN KEY (destinatario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Mensagens diretas entre usuários (chat 1:1, sem restrição de setor/nível)
CREATE TABLE IF NOT EXISTS mensagens_diretas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    remetente_id INT NOT NULL,
    destinatario_id INT NOT NULL,
    conteudo TEXT NOT NULL,
    enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lida BOOLEAN NOT NULL DEFAULT FALSE,
    lida_em DATETIME NULL,
    INDEX idx_msg_conversa (remetente_id, destinatario_id, enviado_em),
    INDEX idx_msg_destinatario_lida (destinatario_id, lida),
    CONSTRAINT fk_msg_remetente FOREIGN KEY (remetente_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT fk_msg_destinatario FOREIGN KEY (destinatario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
