import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * IP do cliente (GW-04). Por padrão é o endereço do socket; X-Forwarded-For / X-Real-IP só
 * valem quando o socket vem de um proxy confiável (TRUSTED_PROXIES). Sem isso, qualquer um
 * forjava o header e escapava do limite por IP e do bloqueio de login.
 *
 * Padrão (DEFAULT_TRUSTED_PROXIES): loopback + faixas privadas (RFC 1918, ULA IPv6). Motivo:
 * o NGINX roda no host da VPS e o gateway em Docker rootless — a conexão do NGINX chega ao
 * container com IP de origem da rede docker/slirp (10.0.2.x, 172.x...), não 127.0.0.1. Para
 * esse padrão ser seguro a porta 3100 NÃO pode estar alcançável de fora do host (publique-a
 * só em 127.0.0.1). Em produção, prefira apontar TRUSTED_PROXIES para o IP exato que o gateway
 * vê (aparece no log `untrusted_forwarded_header` se o padrão não cobrir).
 */
export const DEFAULT_TRUSTED_PROXIES = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
];

/** "::ffff:10.0.0.1" → "10.0.0.1" (socket IPv6 dual-stack). */
export function normalizeIp(raw: string | undefined | null): string {
  const ip = (raw ?? "").trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

/** Valida e normaliza a lista (IP ou CIDR). Lança Error com a entrada inválida. */
export function parseTrustedProxies(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TRUSTED_PROXIES];
  if (raw.trim().toLowerCase() === "none") return [];
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [addr, prefix] = entry.split("/");
    const family = isIP(addr ?? "");
    const max = family === 4 ? 32 : 128;
    if (!family || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > max))) {
      throw new Error(`TRUSTED_PROXIES inválido: ${entry}`);
    }
  }
  return entries;
}

export function buildTrustedProxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr, prefix] = entry.split("/") as [string, string | undefined];
    const type = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(prefix), type);
  }
  return list;
}

export function isTrusted(list: BlockList, ip: string): boolean {
  const family = isIP(ip);
  if (!family) return false;
  return list.check(ip, family === 6 ? "ipv6" : "ipv4");
}

let warnedUntrusted = false;

/**
 * Cliente = socket, a não ser que o socket seja proxy confiável. Nesse caso usa o
 * X-Forwarded-For da direita para a esquerda, pulando proxies confiáveis (o NGINX com
 * $proxy_add_x_forwarded_for acrescenta o IP real no fim; o que o cliente mandou fica à
 * esquerda e é ignorado). Sem X-Forwarded-For, usa X-Real-IP.
 */
export function clientIpFrom(req: IncomingMessage, trusted: BlockList): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress) || "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  const realIp = req.headers["x-real-ip"];
  if (!isTrusted(trusted, socketIp)) {
    if ((forwarded || realIp) && !warnedUntrusted) {
      warnedUntrusted = true;
      console.warn(
        JSON.stringify({
          event: "untrusted_forwarded_header",
          message:
            "Header X-Forwarded-For/X-Real-IP ignorado: o socket não está em TRUSTED_PROXIES. Se este é o NGINX, inclua este IP em TRUSTED_PROXIES.",
          socketIp,
        }),
      );
    }
    return socketIp;
  }
  const chain = (typeof forwarded === "string" ? forwarded : Array.isArray(forwarded) ? forwarded.join(",") : "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (!isIP(hop)) break;
    if (!isTrusted(trusted, hop)) return hop;
  }
  // Todos os saltos são "confiáveis" (cliente na rede interna): vale o que o proxy viu (o último).
  const last = chain[chain.length - 1];
  if (last && isIP(last)) return last;
  const real = typeof realIp === "string" ? normalizeIp(realIp) : "";
  if (real && isIP(real)) return real;
  return socketIp;
}
