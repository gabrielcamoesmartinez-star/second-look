import { runSeoChecks, type CategoryScores, type StepName } from '@second-look/shared';
import { AuditError, toAuditError } from './errors';
import { log } from './log';
import type { Reporter } from './reporter';
import type { FetchResult } from './steps/fetch';
import type { PageSpeedResult } from './steps/pagespeed';

export interface PipelineDeps {
  reporter: Reporter;
  fetchPage: (url: string) => Promise<FetchResult>;
  pageSpeed: (url: string, onRetry: (attempt: number, err: AuditError) => Promise<void>) => Promise<PageSpeedResult>;
  now?: () => number;
}

class Cancelled extends Error {}

/**
 * Runs one audit end to end and records every step. Never throws for expected failures:
 * the audit ends as complete, partial (some steps failed) or failed (the page couldn't be fetched).
 */
export async function runAudit(deps: PipelineDeps): Promise<'complete' | 'partial' | 'failed' | 'cancelled'> {
  const { reporter } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const audit = await reporter.getAudit();
  if (audit.status === 'cancelled') return 'cancelled';
  await reporter.setAudit({ status: 'running', error_code: null, error_message: null });

  const checkCancel = async () => {
    if (await reporter.isCancelled()) throw new Cancelled();
  };

  const step = async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
    await reporter.setStep(name, { status: 'running', attempt: 1, error_code: null, detail: null });
    try {
      const out = await fn();
      await reporter.setStep(name, { status: 'done' });
      return out;
    } catch (err) {
      const e = toAuditError(err);
      await reporter.setStep(name, { status: 'failed', error_code: e.code, detail: e.message.slice(0, 500) });
      throw e;
    }
  };

  const scores: CategoryScores = { performance: null, accessibility: null, seo: null };
  let anyFailed = false;
  try {
    // 1. Fetch is required: without the page nothing else can run.
    let page: FetchResult;
    try {
      page = await step('fetch', () => deps.fetchPage(audit.inputUrl));
    } catch (err) {
      const e = toAuditError(err);
      for (const s of ['accessibility', 'performance', 'seo'] as const) await reporter.setStep(s, { status: 'skipped' });
      await reporter.setAudit({
        status: 'failed',
        error_code: e.code,
        error_message: e.message.slice(0, 500),
        duration_ms: now() - started,
        completed_at: new Date().toISOString(),
      });
      log('warn', 'audit failed at fetch', { audit_id: audit.id, code: e.code });
      return 'failed';
    }

    const base = `${audit.userId}/${audit.id}`;
    await Promise.all([
      reporter.upload(`${base}/mobile-first.png`, page.mobileFirstScreen, 'image/png'),
      reporter.upload(`${base}/mobile-full.jpg`, page.mobileFullPage, 'image/jpeg'),
      reporter.upload(`${base}/desktop-first.png`, page.desktopFirstScreen, 'image/png'),
      reporter.upload(`${base}/page.html`, Buffer.from(page.html, 'utf8'), 'text/html'),
    ]);
    await reporter.setAudit({
      final_url: page.finalUrl,
      screenshot_path: `${base}/mobile-first.png`,
      html_path: `${base}/page.html`,
    });
    if (page.robotsNote) await reporter.setStep('fetch', { status: 'done', detail: page.robotsNote });
    await checkCancel();

    // 2. PageSpeed (performance + accessibility share one API call) and SEO rules run in parallel.
    const pageSpeedTask = (async () => {
      await reporter.setStep('performance', { status: 'running', attempt: 1 });
      await reporter.setStep('accessibility', { status: 'running', attempt: 1 });
      try {
        const res = await deps.pageSpeed(page.finalUrl, async (attempt, err) => {
          for (const s of ['performance', 'accessibility'] as const)
            await reporter.setStep(s, { status: 'retrying', attempt, detail: err.message.slice(0, 200) });
        });
        scores.performance = res.performance;
        scores.accessibility = res.accessibility;
        await reporter.setStep('performance', { status: 'done', detail: null });
        await reporter.setStep('accessibility', { status: 'done', detail: null });
      } catch (err) {
        anyFailed = true;
        const e = toAuditError(err);
        for (const s of ['performance', 'accessibility'] as const)
          await reporter.setStep(s, { status: 'failed', error_code: e.code, detail: e.message.slice(0, 500) });
      }
    })();

    const seoTask = step('seo', async () => {
      scores.seo = runSeoChecks(page.html);
    }).catch(() => {
      anyFailed = true;
    });

    await Promise.all([pageSpeedTask, seoTask]);
    await checkCancel();

    const status = anyFailed ? 'partial' : 'complete';
    await reporter.setAudit({
      status,
      category_scores: scores,
      error_code: anyFailed ? (scores.performance ? null : 'pagespeed_failed') : null,
      duration_ms: now() - started,
      completed_at: new Date().toISOString(),
    });
    log('info', 'audit finished', { audit_id: audit.id, status, duration_ms: now() - started });
    return status;
  } catch (err) {
    if (err instanceof Cancelled) {
      await reporter.setAudit({ status: 'cancelled', error_code: 'cancelled', completed_at: new Date().toISOString() });
      return 'cancelled';
    }
    const e = toAuditError(err);
    log('error', 'audit crashed', { audit_id: audit.id, code: e.code, error: e.message });
    await reporter.setAudit({
      status: 'failed',
      error_code: 'internal_error',
      error_message: e.message.slice(0, 500),
      duration_ms: now() - started,
      completed_at: new Date().toISOString(),
    });
    return 'failed';
  }
}
