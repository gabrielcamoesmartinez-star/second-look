import { isBlockedIp, isIpLiteral } from './ip';

export type NormalizeResult =
  | { ok: true; url: string; host: string; addedScheme: boolean }
  | { ok: false; code: 'invalid_url' | 'ssrf_blocked' };

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.corp'];
const MAX_URL_LENGTH = 2048;

/**
 * Cleans up what a person typed into a URL we can audit.
 * Adds https:// when missing, only allows http/https, rejects credentials, IP literals in
 * private ranges and obviously internal host names. DNS-level checks happen in the worker.
 */
export function normalizeUrl(input: string): NormalizeResult {
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL_LENGTH || /\s/.test(raw)) return { ok: false, code: 'invalid_url' };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return { ok: false, code: 'invalid_url' };
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:]+:\d+/.test(raw))
    return { ok: false, code: 'invalid_url' }; // e.g. "javascript:alert(1)", "mailto:x"

  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { ok: false, code: 'invalid_url' };
  }

  if (url.username || url.password) return { ok: false, code: 'invalid_url' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, code: 'invalid_url' };

  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIpLiteral(bare)) {
    if (isBlockedIp(bare)) return { ok: false, code: 'ssrf_blocked' };
  } else {
    if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))
      return { ok: false, code: 'ssrf_blocked' };
    // A public host name needs a dot and a plausible TLD.
    if (!host.includes('.') || !/\.[a-z][a-z0-9-]{1,62}$/.test(host)) return { ok: false, code: 'invalid_url' };
    if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, code: 'invalid_url' }; // punycode is a-z0-9-
  }

  if (url.port && !['80', '443'].includes(url.port)) return { ok: false, code: 'ssrf_blocked' };

  url.hash = '';
  url.hostname = host;
  return { ok: true, url: url.toString(), host, addedScheme: !hasScheme };
}
