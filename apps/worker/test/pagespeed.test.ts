import { describe, expect, it, vi } from 'vitest';
import { parsePageSpeed, runPageSpeed } from '../src/steps/pagespeed';
import { psiFixture } from './fixtures/psi';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('parsePageSpeed', () => {
  it('extracts scores, weighted failing audits and metrics', () => {
    const r = parsePageSpeed(psiFixture);
    expect(r.performance.score).toBe(49);
    expect(r.performance.topIssues.map((i) => i.id)).toEqual(['largest-contentful-paint']);
    expect(r.performance.metrics).toMatchObject({ LCP: '4.8 s', TBT: '120 ms', CLS: '0.01' });
    expect(r.accessibility).toMatchObject({ score: 86, topIssues: [{ id: 'button-name' }] });
  });
  it('rejects unexpected shapes', () => {
    expect(() => parsePageSpeed({ nope: true })).toThrow(/Unexpected PageSpeed/);
  });
});

describe('runPageSpeed', () => {
  it('retries on 500 then succeeds, reporting each retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(ok(psiFixture));
    const onRetry = vi.fn();
    const r = await runPageSpeed('https://example.com/', { apiKey: 'k'.repeat(20), fetchImpl, onRetry, backoffMs: 1 });
    expect(r.performance.score).toBe(49);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(2, expect.objectContaining({ code: 'pagespeed_failed' }));
  });
  it('does not retry a 400 and fails with pagespeed_failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    await expect(runPageSpeed('https://example.com/', { apiKey: 'k'.repeat(20), fetchImpl, backoffMs: 1 })).rejects.toMatchObject({ code: 'pagespeed_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('gives up after 3 attempts', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(runPageSpeed('https://example.com/', { apiKey: 'k'.repeat(20), fetchImpl, backoffMs: 1 })).rejects.toMatchObject({ code: 'pagespeed_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
