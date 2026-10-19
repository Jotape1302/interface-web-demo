-- =============================================================================
-- Remove a tabela conciliacao_contas_pagar (antigo fluxo n8n de agendamento de pagamentos).
-- =============================================================================
-- A partir do commit que adicionou este arquivo, nada na plataforma lê ou grava essa tabela:
--   - métricas/ROI e falhas do Contas a Pagar vêm de conciliacao_baixas_historico;
--   - o health check do Banco Inter consulta a API de conciliação (mTLS/OAuth2 real).
--
-- NÃO rode antes de:
--   1. fazer deploy do gateway com essa mudança (a versão antiga do gateway lê esta tabela
--      e o painel mostraria "Dados financeiros indisponíveis");
--   2. confirmar no n8n que nenhum workflow ativo grava nela (buscar "conciliacao_contas_pagar"
--      nos nós MySQL/MariaDB dos workflows);
--   3. guardar uma cópia só desta tabela (o comando está no passo a passo do deploy).
--
-- Execute como o usuário da aplicação, no banco financeiro:

USE financeiro;

DROP TABLE IF EXISTS conciliacao_contas_pagar;
