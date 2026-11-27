/**
 * The audit pipeline: fetch → performance + accessibility → seo → checklist_ai → summary.
 * Each step writes its status to audit_steps (which drives the Running
 * screen over Realtime). Steps are idempotent: a re-run overwrites outputs.
 */
import type { Browser } from 'playwright';
import { buildFixes, type CategoryScores, computeScore, ERROR_COPY, normaliseUrl, type ErrorCode } from '@second-look/shared';
import { mergeChecklist, runRuleChecks, type AiOutcome } from '@second-look/shared/checklist.ts';
import { runSeoRules } from '@second-look/shared/seo.ts';
import { costUsd, type AiClient, type Pricing } from '../ai/anthropic.ts';
import { emptyUsage, runAiChecklist, runAiSummary } from '../ai/steps.ts';
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
  /** null when ANTHROPIC_API_KEY isn't configured: AI checks are marked unsure. */
  ai: AiClient | null;
  pricing: Pricing;
  dailyAiBudgetUsd: number;
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

  /* ---------- checklist (rules + AI) ---------- */
  await store.updateStep(auditId, 'checklist_ai', { status: 'running', attempt: 1, error_code: null, detail: null });
  const page = { html: capture.html, visibleText: capture.visibleText, candidates: capture.candidates };
  const findings = runRuleChecks(page);
  const usage = emptyUsage();
  let aiOutcome: AiOutcome;
  let checklistError: { code: ErrorCode; detail: string } | null = null;
  const spentToday = await store.getAiSpendToday();
  if (!deps.ai) {
    aiOutcome = { kind: 'skipped', reason: 'The AI check is not configured, so this check is unsure.' };
    checklistError = { code: 'ai_failed', detail: 'ANTHROPIC_API_KEY is not set.' };
  } else if (spentToday >= deps.dailyAiBudgetUsd) {
    aiOutcome = { kind: 'skipped', reason: ERROR_COPY.ai_budget_reached.message };
    checklistError = { code: 'ai_budget_reached', detail: `Daily AI budget of $${deps.dailyAiBudgetUsd.toFixed(2)} reached.` };
  } else {
    try {
      const r = await runAiChecklist(deps.ai, page, findings, capture.firstScreenPng, usage, deps.signal);
      if (r.ok) {
        aiOutcome = { kind: 'answered', output: r.value };
        if (r.retried) log.warn('checklist AI output needed a retry');
      } else {
        aiOutcome = { kind: 'invalid', error: r.error };
        checklistError = { code: 'ai_invalid_output', detail: r.error.slice(0, 300) };
      }
    } catch (e) {
      if (deps.signal?.aborted) throw e;
      aiOutcome = { kind: 'skipped', reason: "The AI check couldn't run, so this check is unsure." };
      checklistError = { code: 'ai_failed', detail: (e instanceof Error ? e.message : String(e)).replace(/sk-ant-[\w-]+/g, 'sk-ant-***').slice(0, 300) };
    }
  }
  const checks = mergeChecklist(page, findings, aiOutcome);
  await store.saveCheckResults(auditId, checks);
  if (checklistError) {
    partial = true;
    log.warn('checklist AI not used', { code: checklistError.code, detail: checklistError.detail });
    await store.updateStep(auditId, 'checklist_ai', { status: 'failed', error_code: checklistError.code, detail: checklistError.detail });
  } else {
    const decided = checks.filter((c) => c.result !== 'unsure').length;
    await store.updateStep(auditId, 'checklist_ai', { status: 'done', detail: `${checks.length} checks · ${decided} decided · ${checks.length - decided} unsure` });
  }

  /* ---------- score + fixes (no AI) ---------- */
  const topAudit = (cat: 'performance' | 'accessibility') => {
    const a = categories[cat]?.audits.find((x) => x.score !== null && x.score < 0.9);
    return a ? `${a.title}${a.displayValue ? ` ${a.displayValue}` : ''}` : undefined;
  };
  const score = computeScore({ checks, performance: categories.performance?.score, accessibility: categories.accessibility?.score, seo: seo.score });
  categories.breakdown = { categories: score.categories, missing: score.missing };
  const fixes = buildFixes({
    checks,
    seoChecks: seo.checks,
    performance: categories.performance ? { score: categories.performance.score, topAudit: topAudit('performance') } : undefined,
    accessibility: categories.accessibility ? { score: categories.accessibility.score, topAudit: topAudit('accessibility') } : undefined,
  });
  await store.saveFixes(auditId, fixes);
  await store.updateAudit(auditId, { score: score.score, category_scores: categories });

  /* ---------- owner summary (AI) ---------- */
  await store.updateStep(auditId, 'summary', { status: 'running', attempt: 1, error_code: null, detail: null });
  let summary: string | null = null;
  if (!deps.ai || checklistError?.code === 'ai_budget_reached' || spentToday >= deps.dailyAiBudgetUsd) {
    await store.updateStep(auditId, 'summary', { status: 'skipped', detail: deps.ai ? ERROR_COPY.ai_budget_reached.message : 'AI not configured.' });
  } else {
    try {
      const r = await runAiSummary(deps.ai, { url: capture.finalUrl, score, checks, fixes }, usage, deps.signal);
      if (r.ok) {
        summary = r.value;
        await store.updateStep(auditId, 'summary', { status: 'done', detail: r.retried ? 'Valid after one retry' : null });
      } else {
        partial = true;
        await store.updateStep(auditId, 'summary', { status: 'failed', error_code: 'summary_invalid', detail: r.error.slice(0, 300) });
      }
    } catch (e) {
      if (deps.signal?.aborted) throw e;
      partial = true;
      await store.updateStep(auditId, 'summary', { status: 'failed', error_code: 'ai_failed', detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }

  const aiCost = costUsd(deps.pricing, usage.inputTokens, usage.outputTokens);
  if (usage.calls > 0) await store.addAiSpend(aiCost);
  log.info('ai usage', { calls: usage.calls, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: aiCost });

  return finish(partial ? 'partial' : 'complete', {
    score: score.score,
    summary,
    ai_input_tokens: usage.inputTokens,
    ai_output_tokens: usage.outputTokens,
    ai_cost_usd: Math.round(aiCost * 1e6) / 1e6,
  });
}

async function skipRemaining(store: Store, auditId: string, detail: string): Promise<void> {
  for (const step of ['performance', 'accessibility', 'seo', 'checklist_ai', 'summary'] as const) {
    await store.updateStep(auditId, step, { status: 'skipped', detail });
  }
}
