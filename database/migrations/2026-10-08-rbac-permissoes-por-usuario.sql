-- =============================================================================
-- RBAC por usuário (2026-10-08): perfil Gestor, marca ROOT, versão das permissões
-- e limpeza "começar sem permissões".
-- =============================================================================
-- O que muda:
--   * usuarios.role ganha 'gestor' (abaixo do admin);
--   * usuarios.is_root marca o admin raiz (antes só o frontend o reconhecia, por username);
--   * usuarios.permissoes_versao / permissoes_alterado_por / permissoes_alterado_em:
--     concorrência otimista (409) e "Alterado por X em ..." do editor de permissões;
--   * PARTE 2 (DESTRUTIVA): apaga as permissões legadas (overview, accounts_payable,
--     danfe_tiny, ml_reconciliation, financial_dashboard, admin_panel e qualquer chave sem ':')
--     e as linhas "negadas". Todo não-admin fica SEM ACESSO até o admin marcar no painel.
--
-- A PARTE 1 o gateway novo também executa no bootstrap (idempotente); a PARTE 2 NÃO — só
-- por este arquivo, aplicada à mão.
--
-- ATENÇÃO — ORDEM: rode a PARTE 2 SÓ com o gateway NOVO no ar (ou com o gateway parado).
-- O gateway antigo trata "ausência de linha" como PERMITIDO (areas.ts, hasPermission):
-- apagar as linhas com ele no ar LIBERA TUDO para todo mundo.
--
-- Idempotente: rodar 2x não dá erro nem duplica nada. Requer MariaDB >= 10.0.2.
-- Comando (na VPS, a partir de ~/norvia/interface-web):
--   docker compose exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" financeiro' \
--     < database/migrations/2026-10-08-rbac-permissoes-por-usuario.sql
-- =============================================================================

USE financeiro;

-- ---------------------------------------------------------------- PARTE 1 (não destrutiva)

-- Inclui 'gestor' (valores existentes 'admin'/'user' são preservados pelo nome).
ALTER TABLE usuarios MODIFY COLUMN role ENUM('admin', 'gestor', 'user') NOT NULL DEFAULT 'user';

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_root BOOLEAN NOT NULL DEFAULT FALSE AFTER role;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes_versao INT UNSIGNED NOT NULL DEFAULT 0 AFTER status;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes_alterado_por INT NULL AFTER permissoes_versao;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permissoes_alterado_em DATETIME NULL AFTER permissoes_alterado_por;

-- ROOT = o admin do seed (BOOTSTRAP_ADMIN em auth.ts), só se ainda não houver ROOT.
UPDATE usuarios SET is_root = TRUE
WHERE role = 'admin'
  AND (username = 'admin_jp' OR email = 'admin@norvia.example')
  AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM usuarios WHERE is_root = TRUE) AS r)
ORDER BY id LIMIT 1;

-- ---------------------------------------------------------------- PARTE 2 (DESTRUTIVA)
-- Só com o gateway NOVO no ar ou com o gateway parado (ver ATENÇÃO acima).
-- Chaves novas têm sempre ':' ('<aba>:<acao>'), então as concessões feitas pelo admin no
-- painel depois do deploy NÃO são apagadas se o arquivo for rodado de novo.

DELETE FROM usuario_permissoes WHERE recurso NOT LIKE '%:%' OR permitido = FALSE;

-- ---------------------------------------------------------------- Verificação (só leitura)
SELECT id, username, role, is_root, status, permissoes_versao FROM usuarios ORDER BY id;
SELECT COUNT(*) AS linhas_legadas_restantes FROM usuario_permissoes WHERE recurso NOT LIKE '%:%';
SELECT COUNT(*) AS roots FROM usuarios WHERE is_root = TRUE;
