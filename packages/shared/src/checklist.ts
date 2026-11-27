/**
 * Checklist logic that doesn't need the network: rule checks, the AI prompt,
 * validation of the model's answer, and merging rules + AI into final results.
 * The worker does the I/O; everything here is pure and unit-tested.
 */
import { parse } from 'node-html-parser';
import { z } from 'zod';
import { AI_CHECK_IDS, CHECKS, CONFIDENCE_THRESHOLD, type CheckId, type CheckResult, checkById } from './checks.ts';
import { MOBILE_VIEWPORT } from './config.ts';
import type { Candidate } from './schemas.ts';
import { extractJsonLd, findLocalBusiness, isValidLocalBusiness, nodeTypes } from './seo.ts';

export const MAX_FORM_FIELDS = 4;
const FOLD = MOBILE_VIEWPORT.height;

/* ---------- Geometry ---------- */

export function inFirstScreen(c: Candidate): boolean {
  return c.visible && c.rect.y < FOLD && c.rect.y + c.rect.height > 0 && c.rect.width > 0;
}

/** Marker box in percent of the first-screen screenshot, or null if the element isn't on it. */
export function boxFor(c: Candidate | undefined): CheckResult['box'] {
  if (!c || !inFirstScreen(c)) return null;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const x = clamp((c.rect.x / MOBILE_VIEWPORT.width) * 100);
  const y = clamp((c.rect.y / FOLD) * 100);
  const w = clamp(((c.rect.x + c.rect.width) / MOBILE_VIEWPORT.width) * 100) - x;
  const h = clamp(((c.rect.y + c.rect.height) / FOLD) * 100) - y;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/* ---------- Rule checks ---------- */

export interface PageFacts {
  html: string;
  visibleText: string;
  candidates: Candidate[];
}

const HOURS_RE =
  /\b(?:mon|tue|wed|thu|fri|sat|sun|seg|ter|qua|qui|sex|s[áa]b|dom)[a-z.\-çá]*\b[^\n]{0,40}?\b\d{1,2}(?:[:h.]\d{2})?\s*(?:am|pm|h)?\s*(?:-|–|—|to|às|a|até)\s*\d{1,2}(?:[:h.]\d{2})?/i;

export interface RuleFindings {
  results: Partial<Record<CheckId, CheckResult>>;
  /** Extra facts passed to the AI and merged afterwards. */
  hints: { aggregateRating: boolean; openingHoursSchema: boolean; hoursTextMatch: string | null; reviewWidget: Candidate | null };
}

export function runRuleChecks(page: PageFacts): RuleFindings {
  const results: Partial<Record<CheckId, CheckResult>> = {};
  const base = (id: CheckId) => ({ check_id: id, source: checkById(id).source });

  // tap_to_call_first_screen — rule only
  const tels = page.candidates.filter((c) => c.kind === 'tel');
  const telTop = tels.find(inFirstScreen);
  const telBelow = tels.find((c) => c.visible && !inFirstScreen(c));
  results.tap_to_call_first_screen = {
    ...base('tap_to_call_first_screen'),
    result: telTop ? 'pass' : 'fail',
    confidence: 1,
    evidence: telTop
      ? `Tap-to-call link "${telTop.text || 'tel:'}" at ${Math.round(telTop.rect.y)}px.`
      : telBelow
        ? `A tap-to-call link exists ("${telBelow.text}") but only at ${Math.round(telBelow.rect.y)}px, below the first screen (${FOLD}px).`
        : 'No tap-to-call (tel:) link on the page.',
    evidence_selector: (telTop ?? telBelow)?.selector ?? null,
    // A failing check only gets a marker if the cited element is on screen; a below-fold tel link isn't.
    box: null,
  };

  // short_contact_form — rule only
  const forms = page.candidates.filter((c) => c.kind === 'form' && c.visible && (c.fieldCount ?? 0) > 0);
  const longest = forms.reduce<Candidate | undefined>((m, f) => (!m || (f.fieldCount ?? 0) > (m.fieldCount ?? 0) ? f : m), undefined);
  results.short_contact_form = longest
    ? {
        ...base('short_contact_form'),
        result: (longest.fieldCount ?? 0) <= MAX_FORM_FIELDS ? 'pass' : 'fail',
        confidence: 1,
        evidence: `Form with ${longest.fieldCount} visible field${longest.fieldCount === 1 ? '' : 's'} (aim for ${MAX_FORM_FIELDS} or fewer).`,
        evidence_selector: longest.selector,
        box: (longest.fieldCount ?? 0) > MAX_FORM_FIELDS ? boxFor(longest) : null,
      }
    : {
        ...base('short_contact_form'),
        result: 'fail',
        confidence: 0.9,
        evidence: 'No contact form found on the page.',
        evidence_selector: null,
        box: null,
      };

  // local_business_schema — rule only
  const { nodes } = extractJsonLd(page.html);
  const lb = findLocalBusiness(nodes);
  const lbValid = lb !== undefined && isValidLocalBusiness(lb);
  results.local_business_schema = {
    ...base('local_business_schema'),
    result: lbValid ? 'pass' : 'fail',
    confidence: 1,
    evidence: lb
      ? lbValid
        ? `${nodeTypes(lb).join(', ')} JSON-LD with name and contact details.`
        : `${nodeTypes(lb).join(', ')} JSON-LD found, but it's missing a name, address or telephone.`
      : 'No LocalBusiness JSON-LD on the page.',
    evidence_selector: null,
    box: null,
  };

  const aggregateRating = nodes.some((n) => nodeTypes(n).includes('AggregateRating') || n['aggregateRating'] !== undefined);
  const openingHoursSchema = nodes.some((n) => n['openingHours'] !== undefined || n['openingHoursSpecification'] !== undefined);
  const hoursTextMatch = HOURS_RE.exec(page.visibleText)?.[0] ?? null;
  const reviewWidget = page.candidates.find((c) => c.kind === 'review_widget' && c.visible) ?? null;
  return { results, hints: { aggregateRating, openingHoursSchema, hoursTextMatch, reviewWidget } };
}

/* ---------- AI prompt ---------- */

export const AiAnswer = z.object({
  result: z.enum(['pass', 'fail']),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(300),
  evidence_element_id: z.string().nullable(),
});
export const AiChecklistOutput = z.object(
  Object.fromEntries(AI_CHECK_IDS.map((id) => [id, AiAnswer])) as Record<(typeof AI_CHECK_IDS)[number], typeof AiAnswer>,
);
export type AiChecklistOutput = z.infer<typeof AiChecklistOutput>;

export function domOutline(html: string, limit = 80): string {
  const root = parse(html);
  const lines: string[] = [];
  for (const el of root.querySelectorAll('h1, h2, h3, a, button, nav, form, label')) {
    const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text && el.tagName !== 'FORM') continue;
    lines.push(`<${el.tagName.toLowerCase()}>${text}`);
    if (lines.length >= limit) break;
  }
  return lines.join('\n');
}

export const CHECKLIST_SYSTEM_PROMPT = `You audit local business websites for how easily a visitor on a phone can make an enquiry.
You are given: a screenshot of the FIRST mobile screen (390x844 CSS px), the page's visible text, a DOM outline, and a list of candidate elements found by the browser, each with an id.
Answer each question strictly from what you are given. Do not guess.
For each check return: result ("pass" or "fail"), confidence (0 to 1: how sure you are from the evidence), evidence (a short quote or description of what you saw, max 200 characters), and evidence_element_id (the id of the candidate element that supports your answer, or null if none applies).
Never invent element ids and never output coordinates. Reply with a single JSON object and nothing else.`;

export function buildChecklistUserText(page: PageFacts, findings: RuleFindings): string {
  const candidates = page.candidates
    .filter((c) => c.kind !== 'jsonld')
    .slice(0, 30)
    .map((c) => `${c.id} | ${c.kind} | ${inFirstScreen(c) ? 'first screen' : c.visible ? 'below first screen' : 'hidden'} | "${c.text.slice(0, 80)}"`)
    .join('\n');
  const questions = CHECKS.filter((c) => c.aiQuestion)
    .map((c) => `- ${c.id}: ${c.aiQuestion}`)
    .join('\n');
  const facts = [
    findings.hints.aggregateRating ? 'Structured data contains an AggregateRating.' : null,
    findings.hints.openingHoursSchema ? 'Structured data contains opening hours (may not be visible on the page).' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return `QUESTIONS (answer every one):
${questions}

CANDIDATE ELEMENTS (id | kind | position | text):
${candidates || '(none found)'}

${facts ? `FACTS FROM STRUCTURED DATA: ${facts}\n\n` : ''}DOM OUTLINE:
${domOutline(page.html)}

VISIBLE TEXT (trimmed):
${page.visibleText.replace(/\s+\n/g, '\n').slice(0, 5000)}

Reply with JSON shaped exactly like:
{${AI_CHECK_IDS.map((id) => `"${id}": {"result": "pass|fail", "confidence": 0.0, "evidence": "...", "evidence_element_id": "c1" | null}`).join(', ')}}`;
}

/** Validate raw model text. Returns the parsed output or a message suitable for the retry prompt. */
export function parseAiChecklist(
  raw: string,
  candidateIds: ReadonlySet<string>,
): { ok: true; value: AiChecklistOutput } | { ok: false; error: string } {
  const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'The reply was not valid JSON. Reply with only the JSON object.' };
  }
  const parsed = AiChecklistOutput.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `The JSON did not match the schema: ${issues}` };
  }
  for (const [id, answer] of Object.entries(parsed.data)) {
    if (answer.evidence_element_id !== null && !candidateIds.has(answer.evidence_element_id)) {
      return { ok: false, error: `${id}.evidence_element_id "${answer.evidence_element_id}" is not one of the candidate ids. Use a listed id or null.` };
    }
  }
  return { ok: true, value: parsed.data };
}

/* ---------- Merge ---------- */

export type AiOutcome =
  | { kind: 'answered'; output: AiChecklistOutput }
  | { kind: 'invalid'; error: string }
  | { kind: 'skipped'; reason: string };

export function mergeChecklist(page: PageFacts, findings: RuleFindings, ai: AiOutcome): CheckResult[] {
  const byId = new Map(page.candidates.map((c) => [c.id, c]));
  const out: CheckResult[] = [];

  for (const def of CHECKS) {
    const rule = findings.results[def.id];
    if (def.source === 'rule' && rule) {
      out.push(rule);
      continue;
    }

    // AI or rule+ai checks
    let result: CheckResult;
    if (ai.kind === 'answered') {
      const a = ai.output[def.id as (typeof AI_CHECK_IDS)[number]];
      const el = a.evidence_element_id ? byId.get(a.evidence_element_id) : undefined;
      result = {
        check_id: def.id,
        result: a.confidence < CONFIDENCE_THRESHOLD ? 'unsure' : a.result,
        confidence: round2(a.confidence),
        evidence: a.evidence,
        evidence_selector: el?.selector ?? null,
        box: a.result === 'fail' ? boxFor(el) : null,
        source: def.source,
      };
    } else {
      result = {
        check_id: def.id,
        result: 'unsure',
        confidence: 0,
        evidence: ai.kind === 'skipped' ? ai.reason : 'The AI answer could not be validated, so this check is unsure.',
        evidence_selector: null,
        box: null,
        source: def.source,
      };
    }

    // Rule evidence that settles a rule+ai check outright.
    if (def.id === 'reviews_visible' && findings.hints.reviewWidget) {
      const w = findings.hints.reviewWidget;
      result = { ...result, result: 'pass', confidence: Math.max(result.confidence, 0.9), evidence: `Review widget on the page: "${w.text.slice(0, 80) || w.selector}".`, evidence_selector: w.selector, box: null };
    }
    if (def.id === 'hours_visible' && findings.hints.hoursTextMatch) {
      result = { ...result, result: 'pass', confidence: Math.max(result.confidence, 0.9), evidence: `Hours in the page text: "${findings.hints.hoursTextMatch.trim().slice(0, 100)}".`, evidence_selector: null, box: null };
    }
    if (def.id === 'booking_first_screen' && result.result === 'pass' && result.evidence_selector === null) {
      // The AI says pass but cited nothing; only accept that if the browser found an action in the first screen.
      const any = page.candidates.find((c) => (c.kind === 'booking' || c.kind === 'contact') && inFirstScreen(c));
      if (!any) result = { ...result, result: 'unsure', confidence: Math.min(result.confidence, 0.5) };
    }
    out.push(result);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
