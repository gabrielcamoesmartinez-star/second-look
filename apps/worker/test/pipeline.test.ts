import { describe, expect, it } from 'vitest';
import { AuditError } from '../src/errors';
import { runAudit } from '../src/pipeline';
import type { FetchResult } from '../src/steps/fetch';
import { parsePageSpeed } from '../src/steps/pagespeed';
import { memoryReporter } from './memoryReporter';
import { psiFixture } from './fixtures/psi';

const page: FetchResult = {
  finalUrl: 'https://example.com/',
  status: 200,
  html: '<html lang="en"><head><title>Example business in Lisbon</title></head><body><h1>Hi</h1></body></html>',
  mobileFirstScreen: Buffer.from('a'),
  mobileFullPage: Buffer.from('b'),
  desktopFirstScreen: Buffer.from('c'),
  robotsNote: null,
};

describe('runAudit', () => {
  it('completes with real step results and uploads artifacts', async () => {
    const { state, reporter } = memoryReporter();
    const result = await runAudit({ reporter, fetchPage: async () => page, pageSpeed: async () => parsePageSpeed(psiFixture) });
    expect(result).toBe('complete');
    expect(state.audit.status).toBe('complete');
    expect(Object.values(state.steps).every((s) => s.status === 'done')).toBe(true);
    expect(state.uploads).toEqual(['u1/a1/mobile-first.png', 'u1/a1/mobile-full.jpg', 'u1/a1/desktop-first.png', 'u1/a1/page.html']);
    expect(state.audit.category_scores).toMatchObject({ performance: { score: 49 }, accessibility: { score: 86 }, seo: { score: expect.any(Number) } });
  });

  it('fails the audit and skips the rest when the page cannot be fetched', async () => {
    const { state, reporter } = memoryReporter();
    const result = await runAudit({
      reporter,
      fetchPage: async () => {
        throw new AuditError('blocked_by_robots');
      },
      pageSpeed: async () => parsePageSpeed(psiFixture),
    });
    expect(result).toBe('failed');
    expect(state.audit).toMatchObject({ status: 'failed', error_code: 'blocked_by_robots' });
    expect(state.steps.fetch?.status).toBe('failed');
    expect(state.steps.seo?.status).toBe('skipped');
  });

  it('is partial when PageSpeed fails, and shows the retries', async () => {
    const { state, reporter } = memoryReporter();
    const result = await runAudit({
      reporter,
      fetchPage: async () => page,
      pageSpeed: async (_url, onRetry) => {
        await onRetry(2, new AuditError('pagespeed_failed', 'PageSpeed HTTP 500', true));
        throw new AuditError('pagespeed_failed', 'PageSpeed HTTP 500');
      },
    });
    expect(result).toBe('partial');
    expect(state.audit).toMatchObject({ status: 'partial', error_code: 'pagespeed_failed' });
    expect(state.steps.performance?.history).toEqual(['running', 'retrying', 'failed']);
    expect(state.steps.seo?.status).toBe('done');
  });

  it('stops when the audit is cancelled', async () => {
    const { state, reporter } = memoryReporter();
    state.cancelAfterFetch = true;
    const result = await runAudit({ reporter, fetchPage: async () => page, pageSpeed: async () => parsePageSpeed(psiFixture) });
    expect(result).toBe('cancelled');
    expect(state.audit.status).toBe('cancelled');
  });
});
