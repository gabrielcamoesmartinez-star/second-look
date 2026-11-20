/**
 * The Stage 1 audit pipeline: fetch → performance + accessibility → seo.
 * Each step writes its status to audit_steps (which drives the Running
 * screen over Realtime). Steps are idempotent: a re-run overwrites outputs.
 */
import type { Browser } from 'playwright';
import { type CategoryScores, ERROR_COPY, normaliseUrl } from '@second-look/shared';
import { runSeoRules } from '@second-look/shared/seo.ts';
import { FetchError, type SafeFetch } from '../net/safeFetch.ts';
import { checkRobots } from '../net/robots.ts';
import type { BlobStore, Logger, PageSpeedClient, Store } from '../ports.ts';
import { capturePage, type Capture } from './capture.ts';
import { runPageSpeed, summariseCategory } from './pagespeed.ts';

export interface PipelineDeps {
  store: Store;
  blobs: BlobStore;
  pagespeed: PageSpeedClient;
  browser: Browser;
  safeFetch: SafeFetch;
  userAgent: string;
  log: Logger;
  signal?: AbortSignal;
  /** Test hook: shorten PageSpeed retry backoff. */
  pagespeedBackoffMs?: number;
  /** Test hook: shorter navigation timeout than the production 30s. */
  navTimeoutMs?: number;
  /** Test hook: fixture servers use random ports. */
  allowAnyPort?: boolean;
}

export type PipelineOutcome = 'complete' | 'partial' | 'failed' | 'cancelled';

export async function runAudit(auditId: string, deps: PipelineDeps): Promise<PipelineOutcome> {
  const { store, log } = deps;
  const started = Date.now();
  const audit = await store.getAudit(auditId);
  if (!audit) throw new Error(`Audit ${auditId} not found`);
  if (audit.status === 'cancelled') return 'cancelled';

  await store.updateAudit(auditId, { status: 'running', error_code: null, error_message: null });
  const prefix = `${audit.user_id}/${auditId}`;
  const categories: CategoryScores = {};
  let partial = false;

  const finish = async (outcome: Exclude<PipelineOutcome, 'cancelled'>, extra: Parameters<Store['updateAudit']>[1] = {}) => {
    await store.updateAudit(auditId, {
      status: outcome,
      category_scores: categories,
      duration_ms: Date.now() - started,
      completed_at: new Date().toISOString(),
      ...extra,
    });
    log.info('audit finished', { outcome, duration_ms: Date.now() - started });
    return outcome;
  };

  /* ---------- fetch ---------- */
  await store.updateStep(auditId, 'fetch', { status: 'running', attempt: 1, error_code: null, detail: null });
  let capture: Capture;
  try {
    const norm = normaliseUrl(audit.input_url, { allowAnyPort: deps.allowAnyPort === true });
    if (!norm.ok) throw new FetchError('invalid_url', norm.reason);
    const robots = await checkRobots(norm.url, deps.safeFetch, deps.userAgent, deps.signal);
    if (!robots.allowed) {
      await store.updateStep(auditId, 'fetch', { status: 'failed', error_code: 'blocked_by_robots', detail: robots.note });
      await skipRemaining(store, auditId, 'Skipped because the page could not be fetched.');
      return finish('failed', { error_code: 'blocked_by_robots', error_message: ERROR_COPY.blocked_by_robots.message });
    }
    capture = await capturePage(deps.browser, norm.url, {
      safeFetch: deps.safeFetch,
      userAgent: deps.userAgent,
      signal: deps.signal,
      navTimeoutMs: deps.navTimeoutMs,
    });
  } catch (e) {
    if (deps.signal?.aborted) throw e;
    const code = e instanceof FetchError ? e.code : 'fetch_failed';
    log.warn('fetch failed', { code, err: e instanceof Error ? e.message : String(e) });
    await store.updateStep(auditId, 'fetch', { status: 'failed', error_code: code, detail: e instanceof Error ? e.message.slice(0, 300) : null });
    await skipRemaining(store, auditId, 'Skipped because the page could not be fetched.');
    return finish('failed', { error_code: code, error_message: ERROR_COPY[code].message });
  }

  await Promise.all([
    deps.blobs.put(`${prefix}/mobile-first-screen.png`, capture.firstScreenPng, 'image/png'),
    deps.blobs.put(`${prefix}/mobile-full.jpg`, capture.fullPageJpeg, 'image/jpeg'),
    capture.desktopPng ? deps.blobs.put(`${prefix}/desktop-first-screen.png`, capture.desktopPng, 'image/png') : Promise.resolve(),
    deps.blobs.put(`${prefix}/page.html`, Buffer.from(capture.html, 'utf8'), 'text/html; charset=utf-8'),
    deps.blobs.put(`${prefix}/visible-text.txt`, Buffer.from(capture.visibleText, 'utf8'), 'text/plain; charset=utf-8'),
    deps.blobs.put(`${prefix}/candidates.json`, Buffer.from(JSON.stringify(capture.candidates), 'utf8'), 'application/json'),
  ]);
  await store.updateAudit(auditId, {
    final_url: capture.finalUrl,
    screenshot_path: `${prefix}/mobile-first-screen.png`,
    html_path: `${prefix}/page.html`,
  });
  await store.updateStep(auditId, 'fetch', {
    status: 'done',
    detail: `HTTP ${capture.status} · ${capture.candidates.length} candidate elements · ${Math.round(capture.html.length / 1024)} KB HTML`,
  });

  /* ---------- performance + accessibility (one PageSpeed call) ---------- */
  for (const step of ['performance', 'accessibility'] as const) {
    await store.updateStep(auditId, step, { status: 'running', attempt: 1, error_code: null, detail: null });
  }
  const psi = await runPageSpeed(deps.pagespeed, capture.finalUrl, {
    signal: deps.signal,
    backoffMs: deps.pagespeedBackoffMs,
    onRetry: async (attempt, err) => {
      log.warn('pagespeed retry', { attempt, err });
      for (const step of ['performance', 'accessibility'] as const) {
        await store.updateStep(auditId, step, { status: 'retrying', attempt, detail: err.slice(0, 300) });
      }
    },
  });
  for (const step of ['performance', 'accessibility'] as const) {
    if (psi.ok) {
      const summary = summariseCategory(psi.psi, step);
      if (summary) {
        categories[step] = summary;
        await store.updateStep(auditId, step, { status: 'done', detail: `Score ${summary.score}` });
        continue;
      }
    }
    partial = true;
    await store.updateStep(auditId, step, {
      status: 'failed',
      error_code: 'pagespeed_failed',
      detail: psi.ok ? 'PageSpeed returned no score for this category.' : psi.error.slice(0, 300),
    });
  }

  /* ---------- seo (rules only) ---------- */
  await store.updateStep(auditId, 'seo', { status: 'running', attempt: 1, error_code: null, detail: null });
  const seo = runSeoRules(capture.html, capture.visibleText);
  categories.seo = seo;
  await store.updateStep(auditId, 'seo', {
    status: 'done',
    detail: `${seo.checks.filter((c) => c.result === 'pass').length} of ${seo.checks.length} checks passed`,
  });

  return finish(partial ? 'partial' : 'complete');
}

async function skipRemaining(store: Store, auditId: string, detail: string): Promise<void> {
  for (const step of ['performance', 'accessibility', 'seo'] as const) {
    await store.updateStep(auditId, step, { status: 'skipped', detail });
  }
}
