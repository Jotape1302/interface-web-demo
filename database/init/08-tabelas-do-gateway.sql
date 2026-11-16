-- =============================================================================
-- 08-tabelas-do-gateway.sql - TABELAS QUE ANTES SÓ O BOOTSTRAP DO GATEWAY CRIAVA
-- =============================================================================
-- DDL idêntico ao do bootstrap do gateway (CREATE TABLE IF NOT EXISTS), para o banco novo
-- já nascer completo e versionado aqui. O bootstrap continua idempotente e não conflita.
--   usuario_alteracoes_pendentes -> backend/gateway/src/auth.ts
--   mensagens_diretas            -> backend/gateway/src/chat.ts
--   contagem_estoque_*           -> backend/gateway/src/stock-sku.ts
-- Se mudar o DDL num lado, mude no outro.

USE financeiro;

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
  INDEX idx_alt_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mensagens_diretas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  remetente_id INT NOT NULL,
  destinatario_id INT NOT NULL,
  conteudo TEXT NOT NULL,
  enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lida BOOLEAN NOT NULL DEFAULT FALSE,
  lida_em DATETIME NULL,
  INDEX idx_msg_conversa (remetente_id, destinatario_id, enviado_em),
  INDEX idx_msg_destinatario_lida (destinatario_id, lida)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contagem_estoque_sku_manual (
  registro_id CHAR(12) NOT NULL PRIMARY KEY,
  sku VARCHAR(60) NOT NULL,
  usuario_id INT NULL,
  usuario_nome VARCHAR(255) NULL,
  informado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sku_manual_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contagem_estoque_excluidas (
  registro_id CHAR(12) NOT NULL PRIMARY KEY,
  usuario_id INT NULL,
  usuario_nome VARCHAR(255) NULL,
  excluida_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- unidades_por_fardo / unidades_soltas (2026-10-14) já nascem aqui; o padrão do fardo é 5
-- (UNIDADES_POR_FARDO_PADRAO em stock-sku.ts).
CREATE TABLE IF NOT EXISTS contagem_estoque_conferencia (
  registro_id CHAR(12) NOT NULL PRIMARY KEY,
  status VARCHAR(12) NOT NULL,
  quantidade_final INT NOT NULL,
  usuario_id INT NULL,
  usuario_nome VARCHAR(255) NULL,
  conferida_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unidades_por_fardo INT NOT NULL DEFAULT 5,
  unidades_soltas INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contagem_estoque_tiny (
  registro_id CHAR(12) NOT NULL PRIMARY KEY,
  status VARCHAR(12) NOT NULL,
  sku VARCHAR(60) NOT NULL,
  produto VARCHAR(255) NULL,
  unidades INT NOT NULL,
  saldo_anterior DECIMAL(14,4) NULL,
  entrada DECIMAL(14,4) NULL,
  id_lancamento BIGINT NULL,
  deposito VARCHAR(120) NULL,
  mensagem VARCHAR(500) NULL,
  usuario_id INT NULL,
  usuario_nome VARCHAR(255) NULL,
  enviado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lancado_em DATETIME NULL -- 1º lançamento com sucesso (ROI); reenvio não apaga
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
