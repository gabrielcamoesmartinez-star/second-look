/**
 * URL normalisation for user input. Runs in the browser (inline validation),
 * the create-audit Edge Function (authoritative) and the worker.
 */

export type NormaliseResult =
  | { ok: true; url: string; hostname: string; addedScheme: boolean }
  | { ok: false; code: 'invalid_url'; reason: string };

const MAX_URL_LENGTH = 2048;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];

export interface NormaliseOptions {
  /** Tests only: fixture servers listen on random ports. */
  allowAnyPort?: boolean;
}

export function normaliseUrl(raw: string, opts: NormaliseOptions = {}): NormaliseResult {
  const input = raw.trim();
  if (input.length === 0) return fail('Empty input');
  if (input.length > MAX_URL_LENGTH) return fail('URL is too long');
  if (/\s/.test(input)) return fail('URL contains spaces');

  let addedScheme = false;
  let candidate = input;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(candidate);
  // "example.com:8080" parses as scheme "example.com" – treat a dotted "scheme" as a host.
  if (!schemeMatch || (schemeMatch[1]?.includes('.') ?? false)) {
    candidate = `https://${candidate.replace(/^\/\//, '')}`;
    addedScheme = true;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return fail('Not a parseable URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('Only http and https are allowed');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return fail('URLs with credentials are not allowed');
  }
  if (!opts.allowAnyPort && parsed.port !== '' && parsed.port !== '80' && parsed.port !== '443') {
    return fail('Only the standard web ports are allowed');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length === 0) return fail('Missing host');
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
  if (!isIpLiteral) {
    if (!hostname.includes('.')) return fail('Host has no domain suffix');
    if (hostname === 'localhost' || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      return fail('Not a public host name');
    }
    const labels = hostname.split('.');
    const tld = labels[labels.length - 1] ?? '';
    if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) return fail('Invalid top-level domain');
  }

  parsed.hash = '';
  parsed.hostname = hostname;
  return { ok: true, url: parsed.toString(), hostname, addedScheme };
}

function fail(reason: string): NormaliseResult {
  return { ok: false, code: 'invalid_url', reason };
}
