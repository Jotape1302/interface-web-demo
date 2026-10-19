CREATE DATABASE IF NOT EXISTS financeiro 
CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE financeiro;

-- =============================================================================
-- 1. TABELA DE BOLETOS DDA (BANCO INTER)
-- Suporte às contas: norvia_curitiba, norvia_campinas, fabrilux, revesta
-- =============================================================================
CREATE TABLE IF NOT EXISTS inter_dda_boletos (
    codigo_barras VARCHAR(60) NOT NULL PRIMARY KEY,
    empresa_identificador VARCHAR(50) NULL,      -- 'norvia_curitiba', 'norvia_campinas', 'fabrilux', 'revesta'
    pagador_cnpj_cpf VARCHAR(20) NULL,           -- CNPJ da sua empresa pagadora
    inter_conta_id VARCHAR(50) NULL,             -- Identificador da conta Inter
    fornecedor_cnpj_cpf VARCHAR(20) NULL,        -- CNPJ do fornecedor emissor do boleto
    beneficiario_cnpj_cpf VARCHAR(20) AS (COALESCE(fornecedor_cnpj_cpf, '')) VIRTUAL,
    beneficiario_nome VARCHAR(255) NULL,
    valor DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    data_vencimento DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDENTE',
    status_match VARCHAR(50) NOT NULL DEFAULT 'PENDENTE',
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dda_empresa (empresa_identificador),
    INDEX idx_dda_pagador (pagador_cnpj_cpf),
    INDEX idx_dda_vencimento (data_vencimento),
    INDEX idx_dda_status (status),
    INDEX idx_dda_status_match (status_match)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- 2. TABELA DE TOKENS DE API (TINY ERP V3 E BANCO INTER)
-- Suporte às 4 contas: norvia_curitiba, norvia_campinas, fabrilux, revesta
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    servico VARCHAR(50) NOT NULL,                -- 'tiny_v3' ou 'inter'
    conta_identificador VARCHAR(50) NOT NULL,    -- 'norvia_curitiba', 'norvia_campinas', 'fabrilux', 'revesta'
    empresa_cnpj VARCHAR(20) NULL,               -- CNPJ correspondente
    client_id VARCHAR(255) NULL,                -- Client ID do aplicativo Tiny
    client_secret VARCHAR(255) NULL,            -- Client Secret do aplicativo Tiny
    access_token TEXT NOT NULL,
    refresh_token TEXT NULL,
    expira_em DATETIME NOT NULL,
    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_servico_conta (servico, conta_identificador),
    INDEX idx_tokens_servico (servico),
    INDEX idx_tokens_conta (conta_identificador)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro inicial para as 4 contas do Tiny ERP v3
INSERT INTO api_tokens (servico, conta_identificador, empresa_cnpj, access_token, refresh_token, expira_em)
VALUES 
    ('tiny_v3', 'fabrilux', '43820617000166', '', '', NOW()),
    ('tiny_v3', 'revesta', '36592814000100', '', '', NOW()),
    ('tiny_v3', 'norvia_campinas', '27184930000107', '', '', NOW()),
    ('tiny_v3', 'norvia_curitiba', '27184930000280', '', '', NOW())
ON DUPLICATE KEY UPDATE 
    empresa_cnpj = COALESCE(VALUES(empresa_cnpj), empresa_cnpj);

