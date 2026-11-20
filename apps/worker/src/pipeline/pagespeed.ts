/**
 * Google PageSpeed Insights (mobile; performance + accessibility).
 * One API call feeds both the performance and accessibility steps.
 */
import { MAX_STEP_ATTEMPTS, type PageSpeedSummary } from '@second-look/shared';
import { z } from 'zod';
import type { PageSpeedClient } from '../ports.ts';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const PSI_TIMEOUT_MS = 90_000;

const LhAudit = z.object({
  id: z.string(),
  title: z.string(),
  score: z.number().nullable().optional(),
  scoreDisplayMode: z.string().optional(),
  displayValue: z.string().optional(),
});
const LhCategory = z.object({ score: z.number().nullable(), auditRefs: z.array(z.object({ id: z.string(), weight: z.number() })) });
export const PsiResponse = z.object({
  lighthouseResult: z.object({
    finalUrl: z.string().optional(),
    categories: z.object({ performance: LhCategory.optional(), accessibility: LhCategory.optional() }),
    audits: z.record(z.string(), LhAudit),
  }),
});
export type PsiResponse = z.infer<typeof PsiResponse>;

export function createPageSpeedClient(apiKey: string, fetchImpl: typeof fetch = fetch): PageSpeedClient {
  return {
    async run(url, signal) {
      const qs = new URLSearchParams({ url, strategy: 'mobile', key: apiKey });
      qs.append('category', 'performance');
      qs.append('category', 'accessibility');
      const timeout = AbortSignal.timeout(PSI_TIMEOUT_MS);
      const res = await fetchImpl(`${PSI_ENDPOINT}?${qs}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
  };
}

export function summariseCategory(psi: PsiResponse, category: 'performance' | 'accessibility'): PageSpeedSummary | null {
  const cat = psi.lighthouseResult.categories[category];
  if (!cat || cat.score === null) return null;
  const audits = cat.auditRefs
    .map((ref) => ({ ref, audit: psi.lighthouseResult.audits[ref.id] }))
    .filter((x): x is { ref: { id: string; weight: number }; audit: z.infer<typeof LhAudit> } => x.audit !== undefined)
    // Keep scored audits that aren't perfect, plus key metrics, most important first.
    .filter(({ audit, ref }) => (audit.score !== null && audit.score !== undefined && audit.score < 1) || (category === 'performance' && ref.weight > 0))
    .sort((a, b) => b.ref.weight - a.ref.weight || (a.audit.score ?? 1) - (b.audit.score ?? 1))
    .slice(0, 12)
    .map(({ audit }) => ({ id: audit.id, title: audit.title, score: audit.score ?? null, displayValue: audit.displayValue ?? null }));
  return { score: Math.round(cat.score * 100), audits };
}

export async function runPageSpeed(
  client: PageSpeedClient,
  url: string,
  opts: { onRetry: (attempt: number, err: string) => Promise<void>; signal?: AbortSignal; backoffMs?: number },
): Promise<{ ok: true; psi: PsiResponse } | { ok: false; error: string }> {
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await opts.onRetry(attempt, lastError);
      await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 2_000) * 2 ** (attempt - 2)));
    }
    try {
      const raw = await client.run(url, opts.signal);
      const parsed = PsiResponse.safeParse(raw);
      if (parsed.success) return { ok: true, psi: parsed.data };
      lastError = `Unexpected PageSpeed response: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e instanceof Error ? e.message.replace(/key=[^&\s]+/g, 'key=***') : String(e);
    }
  }
  return { ok: false, error: lastError };
}
