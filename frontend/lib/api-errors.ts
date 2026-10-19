// Mensagem de erro legível a partir das respostas do gateway (contrato de 2026-10-06):
// - erros do próprio gateway: { error, requestId? } (500 traz sempre requestId);
// - erros das automações repassados: { error, detail, erro_id?, requestId? };
// - FastAPI direto: { detail } (string ou lista de { msg } no 422);
// - 413/415 podem vir do NGINX em HTML, sem JSON.
// Nunca lança: corpo vazio/HTML cai na mensagem padrão com o status HTTP.

export interface ApiErrorBody {
  error?: unknown;
  detail?: unknown;
  message?: unknown;
  erro_id?: unknown;
  requestId?: unknown;
}

function texto(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const msgs = value
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string'
          ? (item as { msg: string }).msg
          : null,
      )
      .filter((m): m is string => Boolean(m));
    if (msgs.length) return msgs.join('; ');
  }
  return null;
}

function referencia(body: ApiErrorBody | null, status: number): string | null {
  if (!body) return null;
  const erroId = texto(body.erro_id);
  if (erroId) return erroId;
  // requestId só interessa ao suporte quando a falha é do servidor.
  const requestId = texto(body.requestId);
  return status >= 500 && requestId ? requestId : null;
}

function padraoPorStatus(status: number, fallback: string): string {
  if (status === 413) return 'O arquivo ou os dados enviados são grandes demais (HTTP 413).';
  if (status === 415) return 'Formato de envio não suportado pelo servidor (HTTP 415).';
  return `${fallback} (HTTP ${status}).`;
}

/** Monta a mensagem a partir de um corpo já lido (ou null quando não era JSON). */
export function apiErrorMessage(body: unknown, status: number, fallback: string): string {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as ApiErrorBody) : null;
  const principal = (b && (texto(b.detail) ?? texto(b.error) ?? texto(b.message))) || padraoPorStatus(status, fallback);
  const ref = referencia(b, status);
  return ref && !principal.includes(ref) ? `${principal} (ref.: ${ref})` : principal;
}

/** Lê o corpo de uma resposta não-OK (JSON ou não) e devolve a mensagem para o usuário. */
export async function readApiError(res: Response, fallback: string): Promise<string> {
  let body: unknown = null;
  try {
    const raw = await res.text();
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return apiErrorMessage(body, res.status, fallback);
}

export interface ApiErrorDetail {
  status: number;
  message: string;
  code: string | null;
  field: string | null;
  items: string[];
  labels: string[];
  current: { updatedByName: string | null; updatedAt: string | null; version?: number } | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Erro do gateway com os campos estruturados (RBAC, 2026-10-08): `code`, `field` (campo do
 * formulário), `items`/`labels` (permissões envolvidas) e `current` (conflito de versão).
 */
export function apiErrorDetail(body: unknown, status: number, fallback: string): ApiErrorDetail {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const cur = b?.current && typeof b.current === 'object' ? (b.current as Record<string, unknown>) : null;
  return {
    status,
    message: apiErrorMessage(body, status, fallback),
    code: typeof b?.code === 'string' ? b.code : null,
    field: typeof b?.field === 'string' ? b.field : null,
    items: stringList(b?.items),
    labels: stringList(b?.labels),
    current: cur
      ? {
          updatedByName: typeof cur.updatedByName === 'string' ? cur.updatedByName : null,
          updatedAt: typeof cur.updatedAt === 'string' ? cur.updatedAt : null,
          ...(typeof cur.version === 'number' ? { version: cur.version } : {}),
        }
      : null,
  };
}

export async function readApiErrorDetail(res: Response, fallback: string): Promise<ApiErrorDetail> {
  let body: unknown = null;
  try {
    const raw = await res.text();
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return apiErrorDetail(body, res.status, fallback);
}
