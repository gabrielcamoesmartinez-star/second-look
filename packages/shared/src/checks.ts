/**
 * The local_service checklist (version 1). Each check states how it is decided.
 * Rules decide wherever a rule can; the AI is used only for judgement calls.
 */
import { z } from 'zod';

export const CheckId = z.enum([
  'tap_to_call_first_screen',
  'booking_first_screen',
  'single_primary_cta',
  'location_stated',
  'reviews_visible',
  'hours_visible',
  'short_contact_form',
  'local_business_schema',
]);
export type CheckId = z.infer<typeof CheckId>;

export type CheckCategory = 'enquiry' | 'local_visibility';
export type CheckSource = 'rule' | 'ai' | 'rule+ai';

export interface CheckDefinition {
  id: CheckId;
  name: string;
  /** One line: why it matters to an owner. Used on the landing page and the report. */
  reason: string;
  category: CheckCategory;
  source: CheckSource;
  /** What the AI is asked, for checks the AI takes part in. */
  aiQuestion?: string;
}

export const CHECKS: readonly CheckDefinition[] = [
  {
    id: 'tap_to_call_first_screen',
    name: 'Tap-to-call in the first screen',
    reason: 'Most local enquiries start on a phone; a number people can tap gets calls.',
    category: 'enquiry',
    source: 'rule',
  },
  {
    id: 'booking_first_screen',
    name: 'Booking, quote or contact action in the first screen',
    reason: 'Visitors decide in seconds; the next step should be visible without scrolling.',
    category: 'enquiry',
    source: 'rule+ai',
    aiQuestion:
      'Is there a visible booking, quote or contact action (button or link) in this first mobile screen? Cite the candidate element if one matches.',
  },
  {
    id: 'single_primary_cta',
    name: 'One clear primary call to action',
    reason: 'One obvious next step converts better than several competing ones.',
    category: 'enquiry',
    source: 'ai',
    aiQuestion:
      'Looking at the first mobile screen, is there ONE clearly dominant call to action (e.g. one prominent button), rather than none or several competing equally?',
  },
  {
    id: 'location_stated',
    name: 'Location or service area stated',
    reason: 'People and search engines need to know you serve their area.',
    category: 'local_visibility',
    source: 'ai',
    aiQuestion: 'Does the page text clearly state where the business is or which areas it serves (a town, city, region or address)?',
  },
  {
    id: 'reviews_visible',
    name: 'Reviews, ratings or trust signals visible',
    reason: 'Visible reviews reassure first-time visitors that others chose you.',
    category: 'local_visibility',
    source: 'rule+ai',
    aiQuestion:
      'Are reviews, star ratings, testimonials or other trust signals (e.g. awards, certifications, "trusted by") visible in the screenshot or stated in the page text?',
  },
  {
    id: 'hours_visible',
    name: 'Opening hours visible',
    reason: 'Hours answer "can I call or visit now?" before people give up.',
    category: 'local_visibility',
    source: 'rule+ai',
    aiQuestion: 'Does the page text show opening hours or availability (days and times)?',
  },
  {
    id: 'short_contact_form',
    name: 'Contact form has 4 fields or fewer',
    reason: 'Every extra field loses people; short forms get more enquiries.',
    category: 'enquiry',
    source: 'rule',
  },
  {
    id: 'local_business_schema',
    name: 'LocalBusiness structured data',
    reason: 'Structured data helps Google show your business details in search and Maps.',
    category: 'local_visibility',
    source: 'rule',
  },
];

export const AI_CHECK_IDS = CHECKS.filter((c) => c.source !== 'rule').map((c) => c.id);

export function checkById(id: CheckId): CheckDefinition {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown check ${id}`);
  return c;
}

/** Below this confidence an answer is shown, and scored, as unsure. */
export const CONFIDENCE_THRESHOLD = 0.7;

export const CheckResult = z.object({
  check_id: CheckId,
  result: z.enum(['pass', 'fail', 'unsure']),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(500),
  evidence_selector: z.string().nullable(),
  /** Percent of the first-screen screenshot. Always from the browser, never the model. */
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  source: z.enum(['rule', 'ai', 'rule+ai']),
});
export type CheckResult = z.infer<typeof CheckResult>;
