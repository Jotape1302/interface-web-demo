// ID de workflow do n8n, no mesmo formato aceito pelo gateway (WORKFLOW_ID_RE em
// backend/gateway/src/routes/token-automation.ts). O valor salvo no localStorage é entrada
// não confiável: só vai para a query da API ou para o link do n8n se casar com isto.
const WORKFLOW_ID_RE = /^[A-Za-z0-9]{1,32}$/;

export function isValidWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID_RE.test(value);
}
