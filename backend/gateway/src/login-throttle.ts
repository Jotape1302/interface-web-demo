/**
 * Proteção contra força bruta no login (GW-05). O limite global do servidor (300 req/min por
 * IP) não serve para isso — ainda permite ~300 senhas testadas por minuto.
 *
 * Três mecanismos, em memória (o gateway roda como processo único):
 * - por (login + IP): MAX_FAILURES_PER_PAIR falhas na janela bloqueiam aquele login SÓ a partir
 *   daquele IP por LOGIN_LOCK_MS. Um terceiro errando a senha do admin não tranca o admin, que
 *   entra de outro IP normalmente;
 * - por IP: MAX_FAILURES_PER_IP falhas na janela bloqueiam o IP inteiro — contra um IP testando
 *   muitos logins. Mais folgado porque, atrás do NAT do escritório, vários usuários legítimos
 *   podem compartilhar o mesmo IP;
 * - por conta: atraso progressivo (não bloqueio). A partir de ACCOUNT_DELAY_AFTER falhas na
 *   janela (de qualquer IP), cada tentativa naquela conta espera 1s, 2s, 4s... até
 *   MAX_ACCOUNT_DELAY_MS antes de conferir a senha. Encarece o ataque distribuído sem nunca
 *   impedir o dono da conta de entrar.
 * Login bem-sucedido zera o par (login+IP) e o contador da conta.
 */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_LOCK_MS = 15 * 60_000;
export const MAX_FAILURES_PER_PAIR = 5;
export const MAX_FAILURES_PER_IP = 20;
export const ACCOUNT_DELAY_AFTER = 5;
export const MAX_ACCOUNT_DELAY_MS = 8_000;
const MAX_TRACKED_KEYS = 20_000;

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export interface LoginThrottle {
  /** Segundos restantes de bloqueio para este login a partir deste IP (0 = liberado). */
  check(login: string, ip: string, now?: number): number;
  /** Atraso (ms) a aplicar antes de conferir a senha desta conta. */
  accountDelayMs(login: string, now?: number): number;
  recordFailure(login: string, ip: string, now?: number): void;
  recordSuccess(login: string, ip: string): void;
}

export function createLoginThrottle(): LoginThrottle {
  const entries = new Map<string, Entry>();

  const norm = (v: string) => v.trim().toLowerCase();
  const pairKey = (login: string, ip: string) => `pair:${norm(login)}|${norm(ip)}`;
  const ipKey = (ip: string) => `ip:${norm(ip)}`;
  const accountKey = (login: string) => `acct:${norm(login)}`;

  function prune(entry: Entry, now: number) {
    entry.failures = entry.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
  }

  function lockRemaining(key: string, now: number): number {
    const entry = entries.get(key);
    if (!entry || entry.lockedUntil <= now) return 0;
    return Math.ceil((entry.lockedUntil - now) / 1000);
  }

  function fail(key: string, max: number | null, now: number) {
    if (!entries.has(key) && entries.size >= MAX_TRACKED_KEYS) {
      // Evita crescimento ilimitado sob ataque distribuído: descarta entradas sem bloqueio ativo.
      for (const [k, e] of entries) {
        prune(e, now);
        if (e.lockedUntil <= now && e.failures.length === 0) entries.delete(k);
      }
      if (entries.size >= MAX_TRACKED_KEYS) {
        for (const [k, e] of entries) if (e.lockedUntil <= now) entries.delete(k);
      }
    }
    const entry = entries.get(key) ?? { failures: [], lockedUntil: 0 };
    prune(entry, now);
    entry.failures.push(now);
    if (entry.failures.length > 64) entry.failures.splice(0, entry.failures.length - 64);
    if (max !== null && entry.failures.length >= max) {
      entry.lockedUntil = now + LOGIN_LOCK_MS;
      entry.failures = [];
    }
    entries.set(key, entry);
  }

  return {
    check(login, ip, now = Date.now()) {
      const pair = login.trim() ? lockRemaining(pairKey(login, ip), now) : 0;
      return Math.max(pair, lockRemaining(ipKey(ip), now));
    },
    accountDelayMs(login, now = Date.now()) {
      if (!login.trim()) return 0;
      const entry = entries.get(accountKey(login));
      if (!entry) return 0;
      prune(entry, now);
      const excess = entry.failures.length - ACCOUNT_DELAY_AFTER;
      if (excess < 0) return 0;
      return Math.min(MAX_ACCOUNT_DELAY_MS, 1000 * 2 ** excess);
    },
    recordFailure(login, ip, now = Date.now()) {
      if (login.trim()) {
        fail(pairKey(login, ip), MAX_FAILURES_PER_PAIR, now);
        fail(accountKey(login), null, now);
      }
      fail(ipKey(ip), MAX_FAILURES_PER_IP, now);
    },
    recordSuccess(login, ip) {
      entries.delete(pairKey(login, ip));
      entries.delete(accountKey(login));
    },
  };
}
