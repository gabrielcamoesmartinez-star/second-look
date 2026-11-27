/**
 * Fixed fix library. Each failed check (or failed SEO rule, or a weak
 * PageSpeed category) maps to one template. The AI never invents fixes.
 * Ranking: impact weight ÷ effort, highest first.
 */
import type { CheckId, CheckResult } from './checks.ts';
import type { SeoCheck } from './schemas.ts';

export type Impact = 'high' | 'medium' | 'low';
export const IMPACT_WEIGHT: Record<Impact, number> = { high: 3, medium: 2, low: 1 };

export interface FixTemplate {
  key: string;
  title: string;
  why: string;
  impact: Impact;
  /** 1 (minutes) … 5 (a project). */
  effort: 1 | 2 | 3 | 4 | 5;
  category: 'enquiry' | 'local_visibility' | 'performance' | 'accessibility';
}

export const CHECK_FIXES: Record<CheckId, FixTemplate> = {
  tap_to_call_first_screen: {
    key: 'tap_to_call_first_screen',
    title: 'Add a tap-to-call button at the top of the page',
    why: 'Phone visitors want to call without hunting for the number. A tel: link in the header turns the first screen into a call.',
    impact: 'high',
    effort: 1,
    category: 'enquiry',
  },
  booking_first_screen: {
    key: 'booking_first_screen',
    title: 'Put a booking or quote button in the first screen',
    why: 'If the next step is below the fold, many visitors leave before they see it.',
    impact: 'high',
    effort: 2,
    category: 'enquiry',
  },
  single_primary_cta: {
    key: 'single_primary_cta',
    title: 'Make one call to action stand out',
    why: 'Several equal buttons (or none) make visitors hesitate. One clear, contrasting button for the main action gets more clicks.',
    impact: 'medium',
    effort: 2,
    category: 'enquiry',
  },
  location_stated: {
    key: 'location_stated',
    title: 'Say where you are and which areas you serve',
    why: 'Visitors and search engines need to know you cover their area. Name the town or service area near the top.',
    impact: 'medium',
    effort: 1,
    category: 'local_visibility',
  },
  reviews_visible: {
    key: 'reviews_visible',
    title: 'Show your reviews or ratings on the page',
    why: 'First-time visitors look for proof. A rating or a few short reviews near the top builds trust.',
    impact: 'medium',
    effort: 2,
    category: 'local_visibility',
  },
  hours_visible: {
    key: 'hours_visible',
    title: 'Show your opening hours',
    why: 'Hours answer "can I call now?". Without them, people assume you are closed or go elsewhere.',
    impact: 'medium',
    effort: 1,
    category: 'local_visibility',
  },
  short_contact_form: {
    key: 'short_contact_form',
    title: 'Shorten the contact form to 4 fields or fewer',
    why: 'Each extra field loses people. Name, phone or email, and a message are usually enough.',
    impact: 'medium',
    effort: 2,
    category: 'enquiry',
  },
  local_business_schema: {
    key: 'local_business_schema',
    title: 'Add LocalBusiness structured data',
    why: 'A small JSON-LD block tells Google your name, address, phone and hours, which helps you appear in local results.',
    impact: 'low',
    effort: 2,
    category: 'local_visibility',
  },
};

export const SEO_FIXES: Record<string, FixTemplate> = {
  title: { key: 'seo_title', title: 'Write a clear page title', why: 'The title is the headline in Google results. Include what you do and where.', impact: 'medium', effort: 1, category: 'local_visibility' },
  meta_description: { key: 'seo_meta_description', title: 'Add a meta description', why: 'It is the text under your link in Google. A good one gets more clicks.', impact: 'low', effort: 1, category: 'local_visibility' },
  single_h1: { key: 'seo_single_h1', title: 'Use exactly one main heading (h1)', why: 'One clear h1 tells visitors and search engines what the page is about.', impact: 'low', effort: 1, category: 'local_visibility' },
  lang: { key: 'seo_lang', title: 'Set the page language', why: 'The lang attribute helps screen readers and search engines read the page correctly.', impact: 'low', effort: 1, category: 'accessibility' },
  phone_in_text: { key: 'seo_phone_in_text', title: 'Show your phone number as text', why: 'A visible number reassures visitors and helps search engines match you to your business listing.', impact: 'medium', effort: 1, category: 'local_visibility' },
  address_in_text: { key: 'seo_address_in_text', title: 'Show your address or service area as text', why: 'Text (not just an image or map) can be read by search engines and copied by visitors.', impact: 'low', effort: 1, category: 'local_visibility' },
};
/** LocalBusiness JSON-LD is already covered by the checklist fix. */
const SEO_SKIP = new Set(['local_business_jsonld']);

export const SPEED_FIX: FixTemplate = {
  key: 'performance',
  title: 'Make the page load faster on phones',
  why: 'Slow pages lose visitors before they see anything. Start with the biggest items Google PageSpeed lists.',
  impact: 'high',
  effort: 4,
  category: 'performance',
};
export const A11Y_FIX: FixTemplate = {
  key: 'accessibility',
  title: 'Fix the accessibility issues Google found',
  why: 'Low contrast, unlabeled buttons and missing alt text make the site harder to use for everyone, not only screen-reader users.',
  impact: 'medium',
  effort: 3,
  category: 'accessibility',
};
export const SPEED_FIX_BELOW = 50;
export const A11Y_FIX_BELOW = 80;

export interface RankedFix {
  rank: number;
  title: string;
  why: string;
  evidence: string;
  impact: Impact;
  effort: number;
  category: FixTemplate['category'];
  check_ids: string[];
}

export interface FixInputs {
  checks: CheckResult[];
  seoChecks?: SeoCheck[];
  performance?: { score: number; topAudit?: string };
  accessibility?: { score: number; topAudit?: string };
}

export function buildFixes(input: FixInputs): RankedFix[] {
  const items: Array<Omit<RankedFix, 'rank'>> = [];
  const push = (t: FixTemplate, evidence: string, ids: string[]) =>
    items.push({ title: t.title, why: t.why, evidence, impact: t.impact, effort: t.effort, category: t.category, check_ids: ids });

  for (const c of input.checks) if (c.result === 'fail') push(CHECK_FIXES[c.check_id], c.evidence, [c.check_id]);
  for (const s of input.seoChecks ?? []) {
    const t = SEO_FIXES[s.id];
    if (s.result === 'fail' && t && !SEO_SKIP.has(s.id)) push(t, s.detail, [`seo:${s.id}`]);
  }
  if (input.performance && input.performance.score < SPEED_FIX_BELOW) {
    push(SPEED_FIX, `Performance score ${input.performance.score}/100${input.performance.topAudit ? `; biggest issue: ${input.performance.topAudit}` : ''}.`, ['performance']);
  }
  if (input.accessibility && input.accessibility.score < A11Y_FIX_BELOW) {
    push(A11Y_FIX, `Accessibility score ${input.accessibility.score}/100${input.accessibility.topAudit ? `; for example: ${input.accessibility.topAudit}` : ''}.`, ['accessibility']);
  }

  return items
    .map((f, i) => ({ f, i, ratio: IMPACT_WEIGHT[f.impact] / f.effort }))
    .sort((a, b) => b.ratio - a.ratio || IMPACT_WEIGHT[b.f.impact] - IMPACT_WEIGHT[a.f.impact] || a.i - b.i)
    .map(({ f }, idx) => ({ ...f, rank: idx + 1 }));
}
