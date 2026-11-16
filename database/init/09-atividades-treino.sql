-- =============================================================================
-- 09-atividades-treino.sql - AÇÕES DOS USUÁRIOS PARA TREINO DE MODELOS (NORVIA)
-- =============================================================================
-- Cada ação que altera algo no painel (menos credenciais, contagem de estoque e chat), com o
-- que a pessoa enviou, a resposta e, nas ações instrumentadas, o contexto da tela e a sugestão
-- da automação. Dados de pessoa física mascarados e segredos ocultos pelo gateway antes de gravar.
-- Sem prazo de retenção. Exportação: scripts/exportar-atividades.sh.
-- DDL idêntico ao bootstrap de backend/gateway/src/atividades.ts: se mudar um, mude o outro.
-- criado_em é gravado em UTC.

USE financeiro;

CREATE TABLE IF NOT EXISTS atividades_treino (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NULL,
  perfil VARCHAR(32) NULL,
  setor VARCHAR(64) NULL,
  metodo VARCHAR(8) NOT NULL,
  rota VARCHAR(255) NOT NULL,
  permissao VARCHAR(96) NULL,
  consulta TEXT NULL,
  entrada LONGTEXT NULL,
  contexto LONGTEXT NULL,
  sugestao LONGTEXT NULL,
  resposta LONGTEXT NULL,
  truncado TINYINT(1) NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL,
  duracao_ms INT NULL,
  request_id VARCHAR(64) NULL,
  criado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_atividades_criado (criado_em),
  INDEX idx_atividades_permissao (permissao, criado_em),
  INDEX idx_atividades_rota (rota, criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
