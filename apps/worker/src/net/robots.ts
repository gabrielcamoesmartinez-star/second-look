import robotsParser from 'robots-parser';
import { BOT_USER_AGENT_NAME } from '@second-look/shared';
import { FetchError, type SafeFetch } from './safeFetch.ts';

export type RobotsDecision = { allowed: true; note: string } | { allowed: false; note: string };

/**
 * robots.txt for SecondLookBot.
 * 2xx → obey rules. 4xx → no rules (allowed), per RFC 9309.
 * 5xx/unreachable → RFC 9309 says assume disallow; we allow instead and say so,
 * because a broken robots.txt is common on small business sites and the owner
 * asked for the audit. Recorded as a known limit.
 */
export async function checkRobots(pageUrl: string, safeFetch: SafeFetch, userAgent: string, signal?: AbortSignal): Promise<RobotsDecision> {
  const robotsUrl = new URL('/robots.txt', pageUrl).toString();
  try {
    const res = await safeFetch(robotsUrl, { userAgent, timeoutMs: 10_000, maxBytes: 512 * 1024, signal });
    if (res.status >= 400 && res.status < 500) return { allowed: true, note: `robots.txt returned ${res.status}` };
    if (res.status >= 500) return { allowed: true, note: `robots.txt returned ${res.status}; treated as allowed` };
    const robots = robotsParser(res.url, res.body.toString('utf8'));
    const allowed = robots.isAllowed(pageUrl, BOT_USER_AGENT_NAME) ?? true;
    return allowed ? { allowed: true, note: 'Allowed by robots.txt' } : { allowed: false, note: 'Disallowed by robots.txt' };
  } catch (e) {
    if (e instanceof FetchError && e.code === 'ssrf_blocked') throw e;
    return { allowed: true, note: `robots.txt unreachable (${e instanceof Error ? e.message : 'error'}); treated as allowed` };
  }
}
