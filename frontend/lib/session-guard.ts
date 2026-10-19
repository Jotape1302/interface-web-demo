// Regras puras (sem React/DOM) usadas pelo AuthProvider e pelo interceptor global de fetch.
// Ficam aqui para serem testadas com `tsx --test` (ver session-guard.test.ts).

/**
 * Rotas que exigem sessão ativa no gateway: todo `/api/*` exceto health e login/cadastro
 * (rotas abertas em backend/gateway/src/server.ts — `openRoutes` antes de `checkAreaAccess`).
 * Um 401 nelas com um token salvo significa que a sessão morreu no meio da navegação
 * (gateway reiniciado, TTL expirado, sessão revogada). Lista negativa de propósito: rota nova
 * do gateway (financial-dashboard, marketplace/fretes, marketplace/dimensoes, ml-reconciliation,
 * notifications, chat, events, incidents…) já fica coberta sem lembrar de editar aqui.
 *
 * Erros das automações NÃO chegam como 401: o gateway troca 401/403 da automação ("falha de
 * autenticação entre o gateway e a automação") por 502, e 502 nunca desloga.
 */
export const PROTECTED_API_PATTERN = /\/api\/(?!(?:health|auth\/login|auth\/register)(?:[/?#]|$))[^?#]/;

export function isProtectedApiUrl(url: string): boolean {
  let path = url;
  try {
    path = new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    // mantém a string original
  }
  return PROTECTED_API_PATTERN.test(path);
}

/**
 * Só caminhos internos ("/…"): nunca outro site ("//host", "/\host" — que o navegador trata
 * como "//host" —, "https://…", "javascript:…").
 */
export function caminhoInterno(destino: string | null | undefined): string | null {
  if (!destino || !destino.startsWith('/') || destino.startsWith('//')) return null;
  if (destino.includes('\\')) return null;
  // Caracteres de controle (\t, \n…) são removidos pelo parser de URL e podem montar "//".
  for (let i = 0; i < destino.length; i++) {
    const code = destino.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return destino;
}

function originOf(url: string, base: string): string | null {
  try {
    return new URL(url, base).origin;
  } catch {
    return null;
  }
}

/**
 * O token de sessão só vai para a API do gateway. `apiBaseUrl` vem de resolveApiBaseUrl():
 * absoluta (ex.: http://192.168.50.20:3100, https://host/automacoes) ou relativa — neste caso a
 * API é a própria origem da página. Qualquer outro destino (n8n, CDN, URL de foto de perfil
 * externa, etc.) segue sem Authorization/x-session-token.
 */
export function shouldAttachSessionToken(targetUrl: string, apiBaseUrl: string, pageOrigin: string): boolean {
  const target = originOf(targetUrl, pageOrigin);
  if (!target || target === 'null') return false;
  const api = originOf(apiBaseUrl || '/', pageOrigin);
  return target === (api && api !== 'null' ? api : pageOrigin);
}

/**
 * Atalho de login de demonstração (sem gateway): só em build de demo
 * (NEXT_PUBLIC_DATA_MODE=demo) ou rodando em localhost/127.0.0.1. Na VPS (build live,
 * acessada por domínio) as credenciais "demo" vão para o gateway como qualquer outra.
 */
export function isDemoLoginAllowed(dataMode: string | undefined, hostname: string | undefined): boolean {
  if (dataMode === 'demo') return true;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** Link externo vindo de dado de API (ex.: permalink do Mercado Livre): só http(s). */
export function linkExternoSeguro(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
