import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_ACTION_LABELS, auditActionLabel, formatAuditDetails, makeDemoAuditEntries } from './audit-actions';
import { AUDIT_ACTIONS } from '../../backend/gateway/src/audit';

test('toda ação registrada pelo gateway tem rótulo no frontend', () => {
  for (const acao of AUDIT_ACTIONS) {
    assert.ok(AUDIT_ACTION_LABELS[acao], `sem rótulo para "${acao}"`);
  }
});

test('ação desconhecida aparece pelo próprio id', () => {
  assert.equal(auditActionLabel('acao_nova'), 'acao_nova');
});

test('detalhes viram texto corrido e permissões listam só as ativas', () => {
  assert.equal(formatAuditDetails(undefined), '');
  assert.equal(formatAuditDetails({ setor: 'Logística', itens: 3 }), 'Setor: Logística · Itens: 3');
  assert.equal(
    formatAuditDetails({ permissoes: { 'danfe-tiny': true, overview: false, 'accounts-payable': true } }),
    'Permissões: danfe-tiny, accounts-payable',
  );
  assert.equal(formatAuditDetails({ permissoes: {} }), 'Permissões: nenhuma');
});

test('dados de demonstração só usam ações conhecidas', () => {
  for (const e of makeDemoAuditEntries()) assert.ok(AUDIT_ACTION_LABELS[e.acao]);
});

void test('detalhes do RBAC: listas de chaves e booleanos', () => {
  assert.equal(
    formatAuditDetails({ concedidas: ['contas_pagar:ver', 'erros:ver'], revogadas: [], versao: 3 }),
    'Concedidas: contas_pagar:ver, erros:ver · Revogadas: nenhuma · Versão: 3',
  );
  assert.equal(formatAuditDetails({ de: 'admin', para: 'user', permissoesZeradas: true }), 'De: admin · Para: user · Permissões zeradas: sim');
});
