import { describe, expect, it } from 'vitest';
import type { CheckId, CheckResult } from '../src/checks.ts';
import { buildFixes } from '../src/fixes.ts';
import { computeScore } from '../src/scoring.ts';
import { validateSummary, type SummaryInput } from '../src/summary.ts';

const r = (check_id: CheckId, result: CheckResult['result'], evidence = 'e'): CheckResult => ({
  check_id,
  result,
  confidence: result === 'unsure' ? 0.4 : 0.95,
  evidence,
  evidence_selector: null,
  box: null,
  source: 'rule',
});
const allPass: CheckResult[] = (
  ['tap_to_call_first_screen', 'booking_first_screen', 'single_primary_cta', 'short_contact_form', 'location_stated', 'reviews_visible', 'hours_visible', 'local_business_schema'] as CheckId[]
).map((id) => r(id, 'pass'));

describe('computeScore', () => {
  it('weights 40/25/20/15', () => {
    const s = computeScore({ checks: allPass, performance: 50, accessibility: 0, seo: 100 });
    // 100*.4 + 100*.25 + 50*.2 + 0*.15 = 75
    expect(s.score).toBe(75);
    expect(s.missing).toEqual([]);
  });

  it('re-weights when a category is missing and reports it', () => {
    const s = computeScore({ checks: allPass, performance: 50, seo: 100 });
    // accessibility missing → weights .4,.25,.2 scaled by 1/.85: (40+25+10)/.85 = 88.2
    expect(s.score).toBe(88);
    expect(s.missing).toEqual(['accessibility']);
    expect(s.categories.accessibility).toMatchObject({ score: null, effectiveWeight: 0, reason: expect.stringMatching(/PageSpeed/) });
    expect(s.categories.enquiry.effectiveWeight).toBeCloseTo(0.4 / 0.85, 5);
  });

  it('leaves unsure checks out instead of counting them as fails', () => {
    const checks = allPass.map((c) => (c.check_id === 'single_primary_cta' ? r(c.check_id, 'unsure') : c.check_id === 'booking_first_screen' ? r(c.check_id, 'fail') : c));
    // enquiry: pass, fail, pass (unsure dropped) = 66.7
    expect(computeScore({ checks }).categories.enquiry.score).toBe(67);
  });

  it('SEO basics count as one item in local visibility', () => {
    const s = computeScore({ checks: allPass, seo: 0 });
    // 4 passes + seo 0 → 80
    expect(s.categories.local_visibility.score).toBe(80);
  });

  it('nothing measured → null score', () => {
    const s = computeScore({ checks: allPass.map((c) => r(c.check_id, 'unsure')) });
    expect(s.score).toBeNull();
    expect(s.missing.sort()).toEqual(['accessibility', 'enquiry', 'local_visibility', 'performance']);
  });
});

describe('buildFixes', () => {
  it('only failed items get fixes, ranked by impact ÷ effort', () => {
    const checks = allPass.map((c) =>
      ['tap_to_call_first_screen', 'local_business_schema', 'single_primary_cta'].includes(c.check_id) ? r(c.check_id, 'fail', `ev:${c.check_id}`) : c,
    );
    const fixes = buildFixes({ checks, performance: { score: 30, topAudit: 'Largest Contentful Paint 6.1 s' }, accessibility: { score: 95 } });
    expect(fixes.map((f) => f.check_ids[0])).toEqual([
      'tap_to_call_first_screen', // high/1 = 3
      'single_primary_cta', // medium/2 = 1
      'performance', // high/4 = .75
      'local_business_schema', // low/2 = .5
    ]);
    expect(fixes.map((f) => f.rank)).toEqual([1, 2, 3, 4]);
    expect(fixes[0]?.evidence).toBe('ev:tap_to_call_first_screen');
    expect(fixes[2]?.evidence).toMatch(/Performance score 30\/100; biggest issue: Largest Contentful Paint 6.1 s/);
  });

  it('SEO rule fails map to templates; LocalBusiness JSON-LD is not duplicated', () => {
    const fixes = buildFixes({
      checks: allPass,
      seoChecks: [
        { id: 'title', label: 'Page title', result: 'fail', detail: 'No <title> found.' },
        { id: 'local_business_jsonld', label: 'x', result: 'fail', detail: 'none' },
        { id: 'lang', label: 'x', result: 'pass', detail: 'ok' },
      ],
    });
    expect(fixes.map((f) => f.check_ids[0])).toEqual(['seo:title']);
  });

  it('fix text always comes from the library', () => {
    const fixes = buildFixes({ checks: [r('hours_visible', 'fail')] });
    expect(fixes[0]?.title).toBe('Show your opening hours');
  });
});

describe('validateSummary', () => {
  const input: SummaryInput = {
    url: 'https://bakery.example/',
    score: computeScore({ checks: allPass, performance: 62, accessibility: 88, seo: 71 }),
    checks: allPass,
    fixes: [],
  };
  const ok = 'Your site does well, scoring ' + input.score.score + ' out of 100.\n\nIt loads at a reasonable speed.\n\nStart by checking your reviews.';

  it('accepts 3 short paragraphs using only given numbers', () => {
    expect(validateSummary(ok, input).ok).toBe(true);
  });
  it('accepts paragraphs separated by single newlines (a real model habit) and normalises them', () => {
    const single = ok.replace(/\n\n/g, '\n');
    expect(validateSummary(single, input)).toEqual({ ok: true, value: ok });
  });
  it('rejects the wrong number of paragraphs', () => {
    expect(validateSummary('One paragraph only.', input)).toMatchObject({ ok: false, error: expect.stringMatching(/exactly 3/) });
  });
  it('rejects fabricated numbers', () => {
    const fake = 'You could get 40% more enquiries.\n\nSecond.\n\nThird.';
    expect(validateSummary(fake, input)).toMatchObject({ ok: false, error: expect.stringMatching(/40/) });
  });
  it('rejects bullets and overly long text', () => {
    expect(validateSummary('- a\n\nb\n\nc', input).ok).toBe(false);
    expect(validateSummary(`${'word '.repeat(150)}\n\nb\n\nc`, input).ok).toBe(false);
  });
});
