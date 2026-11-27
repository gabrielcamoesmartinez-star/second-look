import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CHECK_IDS, CHECKS } from '../src/checks.ts';
import {
  boxFor,
  buildChecklistUserText,
  mergeChecklist,
  parseAiChecklist,
  runRuleChecks,
  type AiChecklistOutput,
  type PageFacts,
} from '../src/checklist.ts';
import type { Candidate } from '../src/schemas.ts';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const cand = (over: Partial<Candidate> & Pick<Candidate, 'id' | 'kind'>): Candidate => ({
  text: '',
  selector: `#${over.id}`,
  rect: { x: 16, y: 16, width: 200, height: 44 },
  visible: true,
  ...over,
});

const goodPage: PageFacts = {
  html: fixture('good.html'),
  visibleText: 'Emergency plumber in Lisbon. Serving Lisbon, Oeiras and Amadora. Open Monday to Friday, 8:00–18:00.',
  candidates: [
    cand({ id: 'c1', kind: 'tel', text: 'Call +351 21 000 0000' }),
    cand({ id: 'c2', kind: 'booking', text: 'Get a free quote', rect: { x: 16, y: 200, width: 150, height: 44 } }),
    cand({ id: 'c3', kind: 'form', fieldCount: 3, rect: { x: 0, y: 300, width: 390, height: 300 } }),
  ],
};
const badPage: PageFacts = {
  html: fixture('bad.html'),
  visibleText: 'Welcome to our website. We have been in business since 2015.',
  candidates: [
    cand({ id: 'c1', kind: 'tel', text: 'Call us', rect: { x: 16, y: 1600, width: 100, height: 30 } }),
    cand({ id: 'c2', kind: 'form', fieldCount: 6, rect: { x: 0, y: 400, width: 390, height: 400 } }),
  ],
};

const answer = (result: 'pass' | 'fail', confidence = 0.9, el: string | null = null) => ({
  result,
  confidence,
  evidence: 'seen',
  evidence_element_id: el,
});
const aiAll = (result: 'pass' | 'fail', confidence = 0.9): AiChecklistOutput =>
  Object.fromEntries(AI_CHECK_IDS.map((id) => [id, answer(result, confidence)])) as AiChecklistOutput;

describe('check library', () => {
  it('has the 8 version-1 checks with a source each', () => {
    expect(CHECKS).toHaveLength(8);
    expect(CHECKS.every((c) => ['rule', 'ai', 'rule+ai'].includes(c.source))).toBe(true);
    expect(CHECKS.filter((c) => c.source !== 'rule').every((c) => c.aiQuestion)).toBe(true);
  });
});

describe('rule checks', () => {
  it('good page: tel in first screen, short form, valid LocalBusiness, hours/rating hints', () => {
    const f = runRuleChecks(goodPage);
    expect(f.results.tap_to_call_first_screen?.result).toBe('pass');
    expect(f.results.short_contact_form).toMatchObject({ result: 'pass', evidence: expect.stringContaining('3 visible fields') });
    expect(f.results.local_business_schema?.result).toBe('pass');
    expect(f.hints.aggregateRating).toBe(true);
    expect(f.hints.openingHoursSchema).toBe(true);
    expect(f.hints.hoursTextMatch).toMatch(/Monday to Friday, 8:00–18:00/);
  });

  it('bad page: tel only below the fold, long form gets a marker, no schema', () => {
    const f = runRuleChecks(badPage);
    expect(f.results.tap_to_call_first_screen).toMatchObject({ result: 'fail', box: null });
    expect(f.results.tap_to_call_first_screen?.evidence).toMatch(/below the first screen/);
    expect(f.results.short_contact_form?.result).toBe('fail');
    expect(f.results.short_contact_form?.box).not.toBeNull();
    expect(f.results.local_business_schema?.result).toBe('fail');
  });

  it('no form at all is not applicable (unsure, no fix), not a fail', () => {
    expect(runRuleChecks({ ...goodPage, candidates: [] }).results.short_contact_form).toMatchObject({
      result: 'unsure',
      confidence: 0,
      evidence: 'No contact form on the page, so this check does not apply.',
    });
  });

  it('a passing tap-to-call link still gets its browser box (shown only in the all-markers view)', () => {
    expect(runRuleChecks(goodPage).results.tap_to_call_first_screen?.box).toEqual({ x: 4.1, y: 1.9, w: 51.3, h: 5.2 });
  });

  it.each(['Seg–Sex 9h às 18h', 'Mon-Fri 9am-5pm', 'Sábado: 10:00 - 13:00'])('detects hours in "%s"', (t) => {
    expect(runRuleChecks({ ...badPage, visibleText: t }).hints.hoursTextMatch).not.toBeNull();
  });
});

describe('marker boxes come from the browser', () => {
  it('converts CSS px to percent of the first screen', () => {
    expect(boxFor(cand({ id: 'x', kind: 'booking', rect: { x: 39, y: 84.4, width: 195, height: 42.2 } }))).toEqual({ x: 10, y: 10, w: 50, h: 5 });
  });
  it('off-canvas menu items are not on the first screen', () => {
    expect(boxFor(cand({ id: 'x', kind: 'booking', rect: { x: 390, y: 20, width: 300, height: 40 } }))).toBeNull();
    expect(boxFor(cand({ id: 'x', kind: 'booking', rect: { x: -300, y: 20, width: 300, height: 40 } }))).toBeNull();
  });
  it('clamps elements that cross the fold and drops ones below it or hidden', () => {
    expect(boxFor(cand({ id: 'x', kind: 'form', rect: { x: 0, y: 800, width: 390, height: 300 } }))?.h).toBeCloseTo(5.2, 1);
    expect(boxFor(cand({ id: 'x', kind: 'form', rect: { x: 0, y: 900, width: 390, height: 40 } }))).toBeNull();
    expect(boxFor(cand({ id: 'x', kind: 'form', visible: false }))).toBeNull();
  });
});

describe('AI output validation', () => {
  const ids = new Set(['c1', 'c2']);
  it('accepts valid JSON, including inside a code fence', () => {
    const json = JSON.stringify(aiAll('pass'));
    expect(parseAiChecklist(json, ids).ok).toBe(true);
    expect(parseAiChecklist('```json\n' + json + '\n```', ids).ok).toBe(true);
  });
  it('rejects non-JSON with a message for the retry', () => {
    const r = parseAiChecklist('Sure! Here are the results…', ids);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/not valid JSON/) });
  });
  it('rejects a missing check and a confidence out of range', () => {
    const bad = { ...aiAll('pass') } as Record<string, unknown>;
    delete bad['hours_visible'];
    expect(parseAiChecklist(JSON.stringify(bad), ids)).toMatchObject({ ok: false, error: expect.stringMatching(/hours_visible/) });
    const bad2 = { ...aiAll('pass'), location_stated: answer('pass', 1.7) };
    expect(parseAiChecklist(JSON.stringify(bad2), ids).ok).toBe(false);
  });
  it('rejects an invented element id', () => {
    const bad = { ...aiAll('pass'), booking_first_screen: answer('pass', 0.9, 'c99') };
    expect(parseAiChecklist(JSON.stringify(bad), ids)).toMatchObject({ ok: false, error: expect.stringMatching(/c99/) });
  });
  it('rejects coordinates: extra keys are not allowed to carry through', () => {
    const withBox = { ...aiAll('pass'), single_primary_cta: { ...answer('fail'), box: { x: 1, y: 2, w: 3, h: 4 } } };
    const r = parseAiChecklist(JSON.stringify(withBox), ids);
    expect(r.ok && 'box' in r.value.single_primary_cta).toBe(false);
  });
});

describe('merge', () => {
  it('produces all 8 checks with the right sources', () => {
    const results = mergeChecklist(goodPage, runRuleChecks(goodPage), { kind: 'answered', output: aiAll('pass') });
    expect(results.map((r) => r.check_id).sort()).toEqual(CHECKS.map((c) => c.id).sort());
    expect(Object.fromEntries(results.map((r) => [r.check_id, r.source]))).toMatchObject({
      tap_to_call_first_screen: 'rule',
      single_primary_cta: 'ai',
      booking_first_screen: 'rule+ai',
    });
  });

  it('low confidence becomes unsure', () => {
    const results = mergeChecklist(goodPage, runRuleChecks(goodPage), { kind: 'answered', output: { ...aiAll('pass'), location_stated: answer('pass', 0.5) } });
    expect(results.find((r) => r.check_id === 'location_stated')?.result).toBe('unsure');
  });

  it('a failed AI check citing an on-screen element gets the browser box; the model never supplies one', () => {
    const page = { ...goodPage, candidates: [...goodPage.candidates, cand({ id: 'c9', kind: 'booking', text: 'Book', rect: { x: 39, y: 84.4, width: 195, height: 42.2 } })] };
    const out = { ...aiAll('pass'), single_primary_cta: answer('fail', 0.9, 'c9') };
    const r = mergeChecklist(page, runRuleChecks(page), { kind: 'answered', output: out }).find((x) => x.check_id === 'single_primary_cta');
    expect(r).toMatchObject({ result: 'fail', box: { x: 10, y: 10, w: 50, h: 5 }, evidence_selector: '#c9' });
  });

  it('rule evidence settles hours even if the AI said fail', () => {
    const r = mergeChecklist(goodPage, runRuleChecks(goodPage), { kind: 'answered', output: aiAll('fail') }).find((x) => x.check_id === 'hours_visible');
    expect(r).toMatchObject({ result: 'pass', source: 'rule+ai' });
  });

  it('AI skipped (budget) or invalid: rule checks still decide, AI-only checks are unsure', () => {
    for (const ai of [{ kind: 'skipped', reason: 'The AI check is paused for today.' } as const, { kind: 'invalid', error: 'x' } as const]) {
      const results = mergeChecklist(badPage, runRuleChecks(badPage), ai);
      expect(results.find((r) => r.check_id === 'tap_to_call_first_screen')?.result).toBe('fail');
      expect(results.find((r) => r.check_id === 'single_primary_cta')).toMatchObject({ result: 'unsure', confidence: 0 });
    }
  });

  it('booking pass with no cited element and no first-screen action is downgraded', () => {
    const page = { ...badPage };
    const r = mergeChecklist(page, runRuleChecks(page), { kind: 'answered', output: aiAll('pass') }).find((x) => x.check_id === 'booking_first_screen');
    expect(r?.result).toBe('unsure');
  });
});

describe('prompt', () => {
  it('lists every AI question and the candidates, and asks for ids not coordinates', () => {
    const text = buildChecklistUserText(goodPage, runRuleChecks(goodPage));
    for (const id of AI_CHECK_IDS) expect(text).toContain(id);
    expect(text).toContain('c2 | booking | first screen | "Get a free quote"');
    expect(text).not.toMatch(/"x":|"box"/);
  });
});
