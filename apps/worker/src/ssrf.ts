import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isBlockedIp, isIpLiteral } from '@second-look/shared';
import { Agent } from 'undici';
import { AuditError } from './errors';

export type Resolver = (hostname: string) => Promise<string[]>;
export type IpPolicy = (ip: string) => boolean; // true = blocked

export const defaultResolver: Resolver = async (hostname) => {
  const results: LookupAddress[] = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export interface NetGuard {
  resolve: Resolver;
  isBlocked: IpPolicy;
}

export const defaultGuard: NetGuard = { resolve: defaultResolver, isBlocked: isBlockedIp };

/**
 * Resolves a host and refuses it if ANY address is private/reserved. Returns the addresses.
 * Checking every address (not just the first) stops "public + private" DNS tricks.
 */
export async function assertPublicHost(hostname: string, guard: NetGuard = defaultGuard): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let addresses: string[];
  if (isIpLiteral(host)) addresses = [host];
  else {
    try {
      addresses = await guard.resolve(host);
    } catch {
      throw new AuditError('fetch_failed', `Could not resolve ${host}`);
    }
  }
  if (!addresses.length) throw new AuditError('fetch_failed', `No addresses for ${host}`);
  if (addresses.some((ip) => guard.isBlocked(ip))) throw new AuditError('ssrf_blocked', `${host} resolves to a non-public address`);
  return addresses;
}

/**
 * An undici dispatcher that validates the IP at connect time, so a DNS answer can't change
 * between our check and the actual connection (DNS rebinding).
 */
export function guardedAgent(guard: NetGuard = defaultGuard): Agent {
  return new Agent({
    connect: {
      lookup(hostname, _options, callback) {
        assertPublicHost(hostname, guard).then(
          (addrs) => {
            const ip = addrs[0]!;
            callback(null, [{ address: ip, family: ip.includes(':') ? 6 : 4 }]);
          },
          (err: unknown) => callback(err as Error, []),
        );
      },
    },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
}

/** GET with manual redirects (max 5), re-checking every hop. Returns status and body text (capped). */
export async function safeGetText(
  url: string,
  opts: { guard?: NetGuard; userAgent: string; maxBytes?: number; timeoutMs?: number },
): Promise<{ status: number; text: string; finalUrl: string }> {
  const guard = opts.guard ?? defaultGuard;
  const dispatcher = guardedAgent(guard);
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  let current = new URL(url);
  try {
    for (let hop = 0; hop <= 5; hop++) {
      if (!['http:', 'https:'].includes(current.protocol)) throw new AuditError('ssrf_blocked', 'Redirect to a non-web address');
      await assertPublicHost(current.hostname, guard);
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': opts.userAgent, accept: 'text/plain,text/html;q=0.9,*/*;q=0.1' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        // @ts-expect-error undici dispatcher is supported by Node's fetch
        dispatcher,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current);
        await res.body?.cancel();
        continue;
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
      return { status: res.status, text: Buffer.concat(chunks).toString('utf8'), finalUrl: current.toString() };
    }
    throw new AuditError('fetch_failed', 'Too many redirects');
  } finally {
    await dispatcher.close();
  }
}
