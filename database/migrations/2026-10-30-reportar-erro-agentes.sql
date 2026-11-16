-- =============================================================================
-- "Reportar erro" vai aos agentes Qwen (2026-10-30) - incidentes + permissões erros:*
-- =============================================================================
-- A aba Erros & Falhas saiu: o botão "Reportar erro" das abas manda o caso aos agentes Qwen
-- (gateway incidents.ts → fila de comandos do repasse → PC). A tabela incidentes ganha a mensagem
-- de erro da tela e a ligação com o incidente dos agentes. O gateway também cria as colunas no
-- bootstrap se o usuário do banco tiver ALTER; esta migração só registra a versão.
-- Parte destrutiva: apaga as permissões erros:ver/erros:resolver (a aba não existe mais; chave
-- fora do catálogo faria o editor de permissões recusar o salvamento do usuário).
-- ORDEM: qualquer uma (antes ou depois do gateway). Idempotente.
-- =============================================================================

USE financeiro;

ALTER TABLE incidentes ADD COLUMN IF NOT EXISTS mensagem_erro TEXT NULL;
ALTER TABLE incidentes ADD COLUMN IF NOT EXISTS agente_incidente_id INT NULL;
ALTER TABLE incidentes ADD COLUMN IF NOT EXISTS agente_grupo VARCHAR(20) NULL;
CREATE INDEX IF NOT EXISTS idx_incidentes_agente ON incidentes (agente_incidente_id);

DELETE FROM usuario_permissoes WHERE recurso LIKE 'erros:%';
