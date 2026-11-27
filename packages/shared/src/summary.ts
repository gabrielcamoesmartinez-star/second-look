/**
 * Owner summary: a second, small AI call that writes 3 short paragraphs from
 * the structured results only. The validator rejects the wrong shape and any
 * number that doesn't appear in the input.
 */
import { checkById, type CheckResult } from './checks.ts';
import type { RankedFix } from './fixes.ts';
import type { ScoreOutput } from './scoring.ts';
import { CATEGORY_LABELS } from './scoring.ts';

export const SUMMARY_MAX_PARAGRAPH_CHARS = 450;
export const SUMMARY_MAX_WORDS = 200;

export interface SummaryInput {
  url: string;
  score: ScoreOutput;
  checks: CheckResult[];
  fixes: RankedFix[];
}

export function summaryFacts(input: SummaryInput): Record<string, unknown> {
  return {
    website: input.url,
    overall_score_out_of_100: input.score.score,
    categories: Object.fromEntries(
      Object.entries(input.score.categories).map(([k, v]) => [CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS], v.score === null ? 'not measured' : v.score]),
    ),
    checks: input.checks.map((c) => ({ check: checkById(c.check_id).name, result: c.result, evidence: c.evidence })),
    top_fixes: input.fixes.slice(0, 3).map((f) => ({ fix: f.title, impact: f.impact })),
  };
}

export const SUMMARY_SYSTEM_PROMPT = `You write a short summary of a website audit for the owner of a small local business. They are not technical.
Write exactly 3 short paragraphs. Separate them with a blank line (two newline characters):
1. How the site does overall at turning visitors into enquiries, in plain words.
2. The most important problems found.
3. What to do first, using the top fixes.
Use ONLY the facts provided. Do not add facts, numbers, percentages, prices or claims that are not in them. You may mention the overall score as given.
No headings, no bullet points, no greetings, no sign-off. Plain text only.`;

export function buildSummaryUserText(input: SummaryInput): string {
  return `FACTS:\n${JSON.stringify(summaryFacts(input), null, 2)}`;
}

/** Every number in the text must appear somewhere in the facts. */
function numbersIn(s: string): string[] {
  return s.match(/\d+(?:[.,]\d+)?/g) ?? [];
}

export function validateSummary(text: string, input: SummaryInput): { ok: true; value: string } | { ok: false; error: string } {
  const clean = text.trim().replace(/\r\n/g, '\n');
  let paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // Models often separate paragraphs with a single newline; accept that layout too.
  if (paragraphs.length !== 3) paragraphs = clean.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length !== 3) return { ok: false, error: `Write exactly 3 paragraphs separated by blank lines (got ${paragraphs.length}).` };
  if (paragraphs.some((p) => p.length > SUMMARY_MAX_PARAGRAPH_CHARS)) return { ok: false, error: `Keep each paragraph under ${SUMMARY_MAX_PARAGRAPH_CHARS} characters.` };
  if (clean.split(/\s+/).length > SUMMARY_MAX_WORDS) return { ok: false, error: `Keep it under ${SUMMARY_MAX_WORDS} words.` };
  if (/^\s*[-*#•]/m.test(clean)) return { ok: false, error: 'No bullet points or headings.' };
  const allowed = new Set(numbersIn(JSON.stringify(summaryFacts(input))));
  const invented = numbersIn(clean).filter((n) => !allowed.has(n));
  if (invented.length > 0) return { ok: false, error: `These numbers are not in the facts: ${[...new Set(invented)].join(', ')}. Remove them.` };
  return { ok: true, value: paragraphs.join('\n\n') };
}
