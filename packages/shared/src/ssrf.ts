/**
 * SSRF protection. Only globally routable unicast addresses are allowed.
 * The DNS resolver is injected so the same logic runs in Node (worker)
 * and Deno (Edge Functions), and so tests can simulate DNS rebinding.
 */
import ipaddr from 'ipaddr.js';

export type Resolver = (hostname: string) => Promise<string[]>;

export type HostCheck =
  | { ok: true; addresses: string[] }
  | { ok: false; code: 'ssrf_blocked' | 'dns_failed'; reason: string };

/** IPv6 ranges that embed or translate to IPv4 and could smuggle a private address. */
const BLOCKED_V6_RANGES = new Set(['6to4', 'teredo', 'rfc6052', 'rfc6145', 'ipv4Mapped']);

export function isPublicIp(address: string): boolean {
  const raw = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (!ipaddr.isValid(raw)) return false;
  let ip = ipaddr.parse(raw);

  if (ip.kind() === 'ipv6') {
    const v6 = ip as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      ip = v6.toIPv4Address();
    } else {
      const range = v6.range();
      if (BLOCKED_V6_RANGES.has(range)) return false;
      // fec0::/10 (deprecated site-local) is reported as "unicast" by ipaddr.js.
      if (v6.match(ipaddr.IPv6.parse('fec0::'), 10)) return false;
      return range === 'unicast';
    }
  }
  const v4 = ip as ipaddr.IPv4;
  // ipaddr.js labels 0.0.0.0/8 "unspecified" only for 0.0.0.0 itself.
  if (v4.octets[0] === 0) return false;
  return v4.range() === 'unicast';
}

export function isIpLiteral(hostname: string): boolean {
  return ipaddr.isValid(hostname.replace(/^\[|\]$/g, ''));
}

/**
 * Resolve a hostname and require every returned address to be public.
 * One private record is enough to block: an attacker controls which
 * record a client picks.
 */
export async function checkHost(hostname: string, resolve: Resolver): Promise<HostCheck> {
  if (isIpLiteral(hostname)) {
    return isPublicIp(hostname)
      ? { ok: true, addresses: [hostname.replace(/^\[|\]$/g, '')] }
      : { ok: false, code: 'ssrf_blocked', reason: `Address ${hostname} is not public` };
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    return { ok: false, code: 'dns_failed', reason: err instanceof Error ? err.message : 'DNS lookup failed' };
  }
  if (addresses.length === 0) return { ok: false, code: 'dns_failed', reason: 'No DNS records' };
  const bad = addresses.find((a) => !isPublicIp(a));
  if (bad !== undefined) {
    return { ok: false, code: 'ssrf_blocked', reason: `${hostname} resolves to non-public address ${bad}` };
  }
  return { ok: true, addresses };
}
