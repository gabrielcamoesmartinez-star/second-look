/**
 * Overall score. Category weights: enquiry path 40%, local visibility 25%,
 * performance 20%, accessibility 15%. A category that couldn't be measured is
 * dropped and the remaining weights are scaled up; the report says which.
 */
import { CHECKS, type CheckResult } from './checks.ts';

export type ScoreCategory = 'enquiry' | 'local_visibility' | 'performance' | 'accessibility';
export const CATEGORY_WEIGHTS: Record<ScoreCategory, number> = {
  enquiry: 0.4,
  local_visibility: 0.25,
  performance: 0.2,
  accessibility: 0.15,
};
export const CATEGORY_LABELS: Record<ScoreCategory, string> = {
  enquiry: 'Enquiry path',
  local_visibility: 'Local visibility',
  performance: 'Performance',
  accessibility: 'Accessibility',
};

export interface ScoreInputs {
  checks: CheckResult[];
  /** 0–100, or undefined if not measured. */
  performance?: number;
  accessibility?: number;
  /** SEO basics rule score 0–100 (feeds local visibility), if measured. */
  seo?: number;
}

export interface ScoreOutput {
  score: number | null;
  categories: Record<ScoreCategory, { score: number | null; weight: number; effectiveWeight: number; reason?: string }>;
  missing: ScoreCategory[];
}

/** Pass = 100, fail = 0. Unsure answers are left out rather than guessed. */
function checkCategoryScore(checks: CheckResult[], category: 'enquiry' | 'local_visibility', extra: number[] = []): number | null {
  const ids = new Set(CHECKS.filter((c) => c.category === category).map((c) => c.id));
  const decided = checks.filter((c) => ids.has(c.check_id) && c.result !== 'unsure').map((c) => (c.result === 'pass' ? 100 : 0));
  const all = [...decided, ...extra];
  return all.length === 0 ? null : all.reduce((a, b) => a + b, 0) / all.length;
}

export function computeScore(input: ScoreInputs): ScoreOutput {
  const raw: Record<ScoreCategory, { score: number | null; reason?: string }> = {
    enquiry: { score: checkCategoryScore(input.checks, 'enquiry') },
    // SEO basics count as one more item in local visibility.
    local_visibility: { score: checkCategoryScore(input.checks, 'local_visibility', input.seo === undefined ? [] : [input.seo]) },
    performance: { score: input.performance ?? null, reason: input.performance === undefined ? 'Google PageSpeed did not return a performance score.' : undefined },
    accessibility: { score: input.accessibility ?? null, reason: input.accessibility === undefined ? 'Google PageSpeed did not return an accessibility score.' : undefined },
  };
  if (raw.enquiry.score === null) raw.enquiry.reason = 'Every enquiry check was unsure.';
  if (raw.local_visibility.score === null) raw.local_visibility.reason = 'Every local visibility check was unsure.';

  const present = (Object.keys(CATEGORY_WEIGHTS) as ScoreCategory[]).filter((k) => raw[k].score !== null);
  const totalWeight = present.reduce((s, k) => s + CATEGORY_WEIGHTS[k], 0);
  const categories = {} as ScoreOutput['categories'];
  for (const k of Object.keys(CATEGORY_WEIGHTS) as ScoreCategory[]) {
    const s = raw[k].score;
    categories[k] = {
      score: s === null ? null : Math.round(s),
      weight: CATEGORY_WEIGHTS[k],
      effectiveWeight: s === null || totalWeight === 0 ? 0 : CATEGORY_WEIGHTS[k] / totalWeight,
      ...(raw[k].reason && s === null ? { reason: raw[k].reason } : {}),
    };
  }
  const score =
    present.length === 0 ? null : Math.round(present.reduce((sum, k) => sum + (raw[k].score as number) * (CATEGORY_WEIGHTS[k] / totalWeight), 0));
  return { score, categories, missing: (Object.keys(CATEGORY_WEIGHTS) as ScoreCategory[]).filter((k) => raw[k].score === null) };
}
