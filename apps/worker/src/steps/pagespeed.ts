import type { LighthouseCategoryResult } from '@second-look/shared';
import { z } from 'zod';
import { AuditError } from '../errors';

const PsiResponse = z.object({
  lighthouseResult: z.object({
    categories: z.record(
      z.string(),
      z.object({ score: z.number().nullable(), auditRefs: z.array(z.object({ id: z.string(), weight: z.number() })) }),
    ),
    audits: z.record(
      z.string(),
      z.object({ title: z.string(), score: z.number().nullable(), displayValue: z.string().optional() }),
    ),
  }),
});

const METRIC_IDS = {
  'largest-contentful-paint': 'LCP',
  'cumulative-layout-shift': 'CLS',
  'total-blocking-time': 'TBT',
  'first-contentful-paint': 'FCP',
  'speed-index': 'Speed Index',
} as const;

export interface PageSpeedResult {
  performance: LighthouseCategoryResult;
  accessibility: LighthouseCategoryResult;
}

export function parsePageSpeed(json: unknown): PageSpeedResult {
  const parsed = PsiResponse.safeParse(json);
  if (!parsed.success) throw new AuditError('pagespeed_failed', 'Unexpected PageSpeed response shape');
  const { categories, audits } = parsed.data.lighthouseResult;
  const category = (id: 'performance' | 'accessibility'): LighthouseCategoryResult => {
    const cat = categories[id];
    if (!cat || cat.score === null) throw new AuditError('pagespeed_failed', `PageSpeed returned no ${id} score`);
    const topIssues = cat.auditRefs
      .filter((r) => r.weight > 0)
      .map((r) => ({ ref: r, audit: audits[r.id] }))
      .filter((x) => x.audit && x.audit.score !== null && x.audit.score < 0.9)
      .sort((a, b) => b.ref.weight - a.ref.weight || (a.audit!.score ?? 0) - (b.audit!.score ?? 0))
      .slice(0, 5)
      .map((x) => ({ id: x.ref.id, title: x.audit!.title, displayValue: x.audit!.displayValue ?? null }));
    const metrics: Record<string, string> = {};
    if (id === 'performance')
      for (const [auditId, label] of Object.entries(METRIC_IDS)) {
        const v = audits[auditId]?.displayValue;
        if (v) metrics[label] = v;
      }
    return { score: Math.round(cat.score * 100), topIssues, metrics };
  };
  return { performance: category('performance'), accessibility: category('accessibility') };
}

export interface PageSpeedOptions {
  apiKey: string;
  attempts?: number;
  timeoutMs?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (attempt: number, err: AuditError) => Promise<void> | void;
}

/** Calls Google PageSpeed Insights (mobile) with retries and exponential backoff. */
export async function runPageSpeed(url: string, opts: PageSpeedOptions): Promise<PageSpeedResult> {
  const attempts = opts.attempts ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', 'mobile');
  endpoint.searchParams.append('category', 'performance');
  endpoint.searchParams.append('category', 'accessibility');
  endpoint.searchParams.set('key', opts.apiKey);

  let last: AuditError = new AuditError('pagespeed_failed');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await doFetch(endpoint, { signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000) });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new AuditError('pagespeed_failed', `PageSpeed HTTP ${res.status}`, retryable);
      }
      return parsePageSpeed(await res.json());
    } catch (err) {
      last =
        err instanceof AuditError
          ? err
          : new AuditError('pagespeed_failed', err instanceof Error ? err.message : 'PageSpeed request failed', true);
      if (!last.retryable || attempt === attempts) break;
      await opts.onRetry?.(attempt + 1, last);
      await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 2000) * 2 ** (attempt - 1)));
    }
  }
  throw last;
}
