-- =============================================================================
-- 10-agentes-qwen.sql - ABA "AGENTES QWEN": ÚLTIMO ESTADO E AVISOS JÁ ENVIADOS (NORVIA)
-- =============================================================================
-- agentes_qwen_estado: o último estado dos agentes Qwen repassado pelo coletor de incidentes
-- (uma linha, id = 1; JSON em dados). agentes_qwen_avisos: chave incidente:volta:situação de
-- cada aviso já enviado a quem tem agentes_qwen:ver, para não repetir. agentes_qwen_comandos:
-- "marcar como resolvido" pedido na aba, entregue ao PC no repasse (concluido_em quando confirmado).
-- DDL idêntico ao bootstrap de backend/gateway/src/agentes-qwen.ts: se mudar um, mude o outro.

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
