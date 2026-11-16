-- =============================================================================
-- Índices de sessões/usuários e FKs de autoria em usuarios (2026-10-27)
-- =============================================================================
-- DB-04
--   * usuario_sessoes: índice composto (usuario_id, ativo, expira_em) para "sessões ativas do
--     usuário" e índice em expira_em (limpeza das expiradas);
--   * remove idx_usuarios_email (redundante: email já é UNIQUE) e idx_perm_usuario (redundante:
--     UNIQUE uk_usuario_recurso (usuario_id, recurso) já indexa usuario_id e serve à FK).
-- DB-05
--   * FK ON DELETE SET NULL em usuarios.aprovado_por e usuarios.permissoes_alterado_por ->
--     usuarios(id). Se o autor for excluído, o campo fica NULL.
--   * auditoria_acoes.usuario_id e conciliacao_baixas_historico.usuario_id ficam SEM FK de
--     propósito: o histórico precisa sobreviver à exclusão do usuário.
--
-- PRÉ-CONDIÇÃO das FKs (a migração ABORTA se não for atendida): sem órfãos. Para listá-los:
--   SELECT id, aprovado_por, permissoes_alterado_por FROM usuarios u
--    WHERE (aprovado_por IS NOT NULL AND aprovado_por NOT IN (SELECT id FROM usuarios))
--       OR (permissoes_alterado_por IS NOT NULL AND permissoes_alterado_por NOT IN (SELECT id FROM usuarios));
-- (corrija com UPDATE ... SET coluna = NULL nos órfãos e rode de novo.)
--
-- Idempotente; não depende da ordem de deploy do gateway.
-- =============================================================================

USE financeiro;

ALTER TABLE usuario_sessoes
  ADD INDEX IF NOT EXISTS idx_sessoes_usuario_ativo_expira (usuario_id, ativo, expira_em),
  ADD INDEX IF NOT EXISTS idx_sessoes_expira (expira_em);

ALTER TABLE usuarios DROP INDEX IF EXISTS idx_usuarios_email;
ALTER TABLE usuario_permissoes DROP INDEX IF EXISTS idx_perm_usuario;

DELIMITER //
BEGIN NOT ATOMIC
  DECLARE orfaos INT DEFAULT 0;
  SELECT COUNT(*) INTO orfaos FROM usuarios u
   WHERE (u.aprovado_por IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usuarios a WHERE a.id = u.aprovado_por))
      OR (u.permissoes_alterado_por IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usuarios a WHERE a.id = u.permissoes_alterado_por));
  IF orfaos > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'ABORTADO: usuarios com aprovado_por/permissoes_alterado_por apontando para usuario inexistente. Liste com a query do cabecalho, ponha NULL nesses campos e rode de novo.';
  END IF;
END//
DELIMITER ;

ALTER TABLE usuarios
  ADD CONSTRAINT fk_usuarios_aprovado_por
    FOREIGN KEY IF NOT EXISTS fk_usuarios_aprovado_por (aprovado_por) REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_usuarios_perm_alterado_por
    FOREIGN KEY IF NOT EXISTS fk_usuarios_perm_alterado_por (permissoes_alterado_por) REFERENCES usuarios(id) ON DELETE SET NULL;
