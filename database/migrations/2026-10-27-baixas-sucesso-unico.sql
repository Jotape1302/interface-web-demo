-- =============================================================================
-- Baixa com sucesso ÚNICA por conta (2026-10-27) - conciliacao_baixas_historico
-- =============================================================================
-- Uma conta (empresa + conta_pagar_id) só pode ter UMA linha com status 'sucesso'. Barra o
-- clique duplo / dois gateways baixando a mesma conta (e inflando o ROI). O gateway trata o
-- ER_DUP_ENTRY (1062) desse índice como "já baixada".
--
-- Coluna gerada chave_sucesso = 'empresa|conta_pagar_id' só quando status = 'sucesso' (NULL
-- nas demais, e NULL não conflita em UNIQUE) + UNIQUE uk_baixas_sucesso.
--
-- PRÉ-CONDIÇÃO (a migração ABORTA se não for atendida): não pode haver duplicatas de sucesso.
-- Para listá-las ANTES (e decidir qual linha manter; apague/ajuste as outras à mão):
--   SELECT empresa, conta_pagar_id, COUNT(*) AS n, GROUP_CONCAT(id ORDER BY id) AS ids
--     FROM conciliacao_baixas_historico WHERE status = 'sucesso'
--    GROUP BY empresa, conta_pagar_id HAVING COUNT(*) > 1;
--
-- ORDEM: aplique ANTES de subir o gateway que trata o ER_DUP_ENTRY. Idempotente.
-- =============================================================================

USE financeiro;

DELIMITER //
BEGIN NOT ATOMIC
  DECLARE duplicadas INT DEFAULT 0;
  -- Só confere se o índice ainda não existe (reaplicar não deve falhar por causa dele).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conciliacao_baixas_historico'
       AND INDEX_NAME = 'uk_baixas_sucesso'
  ) THEN
    SELECT COUNT(*) INTO duplicadas FROM (
      SELECT 1 FROM conciliacao_baixas_historico WHERE status = 'sucesso'
       GROUP BY empresa, conta_pagar_id HAVING COUNT(*) > 1
    ) d;
    IF duplicadas > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'ABORTADO: ha contas com mais de uma baixa com sucesso em conciliacao_baixas_historico. Liste com a query do cabecalho desta migracao, corrija e rode de novo.';
    END IF;
  END IF;
END//
DELIMITER ;

ALTER TABLE conciliacao_baixas_historico
  ADD COLUMN IF NOT EXISTS chave_sucesso VARCHAR(80)
    AS (CASE WHEN status = 'sucesso' THEN CONCAT(empresa, '|', conta_pagar_id) END) PERSISTENT;

ALTER TABLE conciliacao_baixas_historico
  ADD UNIQUE INDEX IF NOT EXISTS uk_baixas_sucesso (chave_sucesso);
