// GENERATED from packages/shared/src/ip.ts by scripts/sync-edge-shared.mjs. Do not edit.
/**
 * IP range checks used for SSRF protection. An audit may only fetch public internet addresses.
 * Covers IPv4 private, loopback, link-local, CGNAT, benchmarking, multicast and reserved ranges,
 * plus IPv6 loopback, unique-local, link-local, multicast, NAT64 and IPv4-mapped addresses.
 */

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
];

export function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4Range(n: number, base: string, bits: number): boolean {
  const b = parseIPv4(base);
  if (b === null) return false;
  const size = 2 ** (32 - bits);
  return n >= b && n < b + size;
}

/** Expands an IPv6 string into 8 16-bit groups. Returns null if it isn't valid IPv6. */
export function parseIPv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return null;

  // Embedded IPv4 in the last 32 bits, e.g. ::ffff:192.168.0.1
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    ip = ip.slice(0, lastColon + 1) + '0:0';
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...head, ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - groups.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const full = [
    ...head.map((g) => parseInt(g, 16)),
    ...Array<number>(halves.length === 2 ? missing : 0).fill(0),
    ...rest.map((g) => parseInt(g, 16)),
  ];
  if (tail.length) {
    full[6] = tail[0] ?? 0;
    full[7] = tail[1] ?? 0;
  }
  return full.length === 8 ? full : null;
}

export function isBlockedIPv4(ip: string): boolean {
  const n = parseIPv4(ip);
  if (n === null) return true; // fail closed
  return V4_BLOCKED.some(([base, bits]) => inV4Range(n, base, bits));
}

export function isBlockedIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return true; // fail closed
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g6 = 0, h = 0] = g;
  const v4From = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

  if (g.every((x) => x === 0)) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g6 === 0 && h === 1)
    return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0))
    return isBlockedIPv4(v4From(g6, h));
  // NAT64 64:ff9b::/96 — check the embedded IPv4
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return isBlockedIPv4(v4From(g6, h));
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return isBlockedIPv4(v4From(b, c)); // 6to4 embeds IPv4
  return false;
}

/** True if the address must never be fetched. Anything unparseable is treated as blocked. */
export function isBlockedIp(ip: string): boolean {
  if (parseIPv4(ip) !== null) return isBlockedIPv4(ip);
  if (parseIPv6(ip) !== null) return isBlockedIPv6(ip);
  return true;
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}
