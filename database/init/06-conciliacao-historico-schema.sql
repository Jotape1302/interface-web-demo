-- =============================================================================
-- 06-conciliacao-historico-schema.sql - HISTÓRICO DE BAIXAS DA CONCILIAÇÃO (NORVIA)
-- =============================================================================
-- Uma linha por conta enviada para baixa na tela Contas a Pagar (conciliação Banco Inter
-- × Tiny ERP), com o usuário, o lote, os valores e o resultado (sucesso/erro). Também é
-- a fonte do ROI de Contas a Pagar na Visão geral (5 min poupados por baixa com sucesso).
-- Substitui a antiga conciliacao_contas_pagar do fluxo n8n (ver
-- database/migrations/2026-09-28-remove-conciliacao-contas-pagar.sql).
-- O gateway também cria esta tabela no bootstrap (reconciliation-history.ts) se ela ainda
-- não existir. executado_em é gravado em UTC.

USE financeiro;

CREATE TABLE IF NOT EXISTS conciliacao_baixas_historico (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    lote_id CHAR(36) NOT NULL,
    executado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    usuario_id INT NULL,
    usuario_nome VARCHAR(255) NULL,
    empresa VARCHAR(50) NOT NULL,
    conta_pagar_id BIGINT NOT NULL,
    numero_documento VARCHAR(100) NULL,
    fornecedor_nome VARCHAR(255) NULL,
    data_vencimento DATE NULL,
    data_pagamento DATE NULL,
    valor_tiny DECIMAL(12, 2) NULL,
    valor_pago DECIMAL(12, 2) NOT NULL,
    juros DECIMAL(12, 2) NOT NULL DEFAULT 0,
    multa DECIMAL(12, 2) NOT NULL DEFAULT 0,
    desconto DECIMAL(12, 2) NOT NULL DEFAULT 0,
    inter_transacao_id VARCHAR(255) NULL,
    metodo_match VARCHAR(32) NULL,
    status VARCHAR(10) NOT NULL,
    mensagem TEXT NULL,
    INDEX idx_baixas_executado (executado_em),
    INDEX idx_baixas_empresa (empresa),
    INDEX idx_baixas_status (status),
    INDEX idx_baixas_conta (conta_pagar_id),
    INDEX idx_baixas_lote (lote_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
