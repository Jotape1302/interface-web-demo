-- =============================================================================
-- Sessões com token em hash + id público (correção de segurança GW-03, 2026-10-06).
-- =============================================================================
-- Antes: usuario_sessoes.id guardava o token de sessão BRUTO — quem lesse a tabela (backup,
-- dump, usuário do banco) podia se passar por qualquer usuário logado, e o painel admin
-- devolvia esse token como "id" da sessão.
-- Agora: o gateway grava sha256(token) em `id` e mostra/encerra sessões pelo `public_id`
-- (24 hex aleatórios, sem relação com o token).
--
-- CORTE: as sessões abertas antes do deploy NÃO são convertidas (não dá para obter o hash a
-- partir de um token que o gateway não guarda mais em memória — e converter manteria vivos
-- tokens que já ficaram expostos). Elas são desativadas: todo mundo faz login de novo uma vez.
--
-- O gateway novo executa estes mesmos comandos (idempotentes) no bootstrap, então rodar este
-- arquivo é opcional; rodar antes ou depois do deploy dá no mesmo. Requer MariaDB ≥ 10.0.2
-- (ADD COLUMN / ADD INDEX IF NOT EXISTS).
--
-- Execute como o usuário da aplicação, no banco financeiro:

USE financeiro;

ALTER TABLE usuario_sessoes ADD COLUMN IF NOT EXISTS public_id CHAR(24) NULL AFTER id;
ALTER TABLE usuario_sessoes ADD UNIQUE INDEX IF NOT EXISTS uk_sessoes_public_id (public_id);

-- Invalida as sessões antigas (token bruto em `id`, sem public_id).
UPDATE usuario_sessoes SET ativo = FALSE WHERE public_id IS NULL AND ativo = TRUE;

-- Opcional, depois de alguns dias: apaga o histórico das sessões antigas.
-- DELETE FROM usuario_sessoes WHERE public_id IS NULL;
