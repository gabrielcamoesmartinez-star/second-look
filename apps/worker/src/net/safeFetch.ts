/**
 * SSRF-safe HTTP client used for every byte the worker fetches
 * (robots.txt, the page itself, and every sub-resource the browser asks for).
 *
 * - Each hop's hostname is resolved by OUR lookup, every address is checked,
 *   and the socket connects to the address we validated (no second lookup,
 *   so DNS rebinding between check and connect is impossible).
 * - Redirects are followed manually, re-checking each hop, max 5.
 * - Response bodies are streamed with a hard byte cap and a timeout.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { checkHost, isIpLiteral, MAX_REDIRECTS, type Resolver } from '@second-look/shared';

export class FetchError extends Error {
  constructor(
    public readonly code:
      | 'ssrf_blocked'
      | 'dns_failed'
      | 'fetch_timeout'
      | 'fetch_failed'
      | 'too_many_redirects'
      | 'page_too_large'
      | 'http_error'
      | 'invalid_url',
    message: string,
  ) {
    super(message);
  }
}

export interface SafeFetchPolicy {
  resolve: Resolver;
  /**
   * host:port pairs allowed even though they are private. ONLY set by tests
   * (fixture servers on 127.0.0.1). Never read from env or config.
   */
  testOnlyAllowedHosts?: ReadonlySet<string>;
}

export const defaultResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

export interface SafeResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  redirects: string[];
}

export interface SafeFetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  /** 0 = return the 3xx response itself (the browser follows it and comes back through us). */
  maxRedirects?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function createSafeFetch(policy: SafeFetchPolicy) {
  async function guardedLookupFor(url: URL): Promise<LookupFunction | undefined> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (policy.testOnlyAllowedHosts?.has(`${hostname}:${port}`)) return undefined;
    const check = await checkHost(hostname, policy.resolve);
    if (!check.ok) throw new FetchError(check.code, check.reason);
    const pinned = check.addresses[0] as string;
    const family = pinned.includes(':') ? 6 : 4;
    if (isIpLiteral(hostname)) return undefined; // nothing to resolve; already validated
    // Node calls lookup with {all:true} for autoSelectFamily; support both shapes.
    return ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: pinned, family }]);
      else cb(null, pinned, family);
    }) as unknown as LookupFunction;
  }

  async function once(url: URL, opts: SafeFetchOptions): Promise<Omit<SafeResponse, 'redirects' | 'url'>> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('invalid_url', `Blocked scheme ${url.protocol}`);
    const lookup = await guardedLookupFor(url);
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method: 'GET',
          lookup,
          headers: { 'user-agent': opts.userAgent, accept: '*/*', 'accept-encoding': 'identity', ...opts.headers },
          timeout: opts.timeoutMs,
          signal: opts.signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const declared = Number(res.headers['content-length'] ?? '0');
          if (declared > opts.maxBytes) {
            req.destroy();
            reject(new FetchError('page_too_large', `Declared ${declared} bytes`));
            return;
          }
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > opts.maxBytes) {
              req.destroy();
              reject(new FetchError('page_too_large', `Exceeded ${opts.maxBytes} bytes`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
          res.on('error', (e) => reject(new FetchError('fetch_failed', e.message)));
        },
      );
      const deadline = setTimeout(() => req.destroy(new FetchError('fetch_timeout', 'Timed out')), opts.timeoutMs);
      req.on('timeout', () => req.destroy(new FetchError('fetch_timeout', 'Timed out')));
      req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError('fetch_failed', e.message)));
      req.on('close', () => clearTimeout(deadline));
      req.end();
    });
  }

  return async function safeFetch(input: string, opts: SafeFetchOptions): Promise<SafeResponse> {
    const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
    const redirects: string[] = [];
    let current = new URL(input);
    for (;;) {
      const res = await once(current, opts);
      const location = res.headers['location'];
      if (res.status >= 300 && res.status < 400 && location && maxRedirects > 0) {
        if (redirects.length >= maxRedirects) throw new FetchError('too_many_redirects', `More than ${maxRedirects} redirects`);
        current = new URL(location, current);
        redirects.push(current.toString());
        continue; // next hop is re-validated in once()
      }
      return { url: current.toString(), redirects, ...res };
    }
  };
}

export type SafeFetch = ReturnType<typeof createSafeFetch>;
