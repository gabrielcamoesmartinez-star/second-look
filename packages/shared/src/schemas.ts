import { z } from 'zod';
import { ERROR_CODES } from './errors';

export const AuditStatus = z.enum(['queued', 'running', 'complete', 'partial', 'failed', 'cancelled']);
export type AuditStatus = z.infer<typeof AuditStatus>;

export const STEP_NAMES = ['fetch', 'accessibility', 'performance', 'seo', 'checklist_ai', 'summary'] as const;
export const StepName = z.enum(STEP_NAMES);
export type StepName = z.infer<typeof StepName>;

/** Steps that run in Stage 1. The AI steps are added in Stage 2. */
export const STAGE1_STEPS: StepName[] = ['fetch', 'accessibility', 'performance', 'seo'];

export const StepStatus = z.enum(['queued', 'running', 'retrying', 'done', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatus>;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const CreateAuditRequest = z.object({
  url: z.string().min(1).max(2048),
});
export type CreateAuditRequest = z.infer<typeof CreateAuditRequest>;

export const CreateAuditResponse = z.union([
  z.object({ ok: z.literal(true), auditId: z.string().uuid(), normalizedUrl: z.string(), addedScheme: z.boolean(), remainingToday: z.number().int(), cached: z.boolean() }),
  z.object({ ok: z.literal(false), code: ErrorCodeSchema, message: z.string() }),
]);
export type CreateAuditResponse = z.infer<typeof CreateAuditResponse>;

export const CheckOutcome = z.enum(['pass', 'warn', 'fail']);
export type CheckOutcome = z.infer<typeof CheckOutcome>;

export const SeoCheck = z.object({
  id: z.string(),
  label: z.string(),
  result: CheckOutcome,
  detail: z.string(),
});
export type SeoCheck = z.infer<typeof SeoCheck>;

export const SeoResult = z.object({
  score: z.number().min(0).max(100),
  checks: z.array(SeoCheck),
});
export type SeoResult = z.infer<typeof SeoResult>;

export const LighthouseCategoryResult = z.object({
  score: z.number().min(0).max(100),
  topIssues: z.array(z.object({ id: z.string(), title: z.string(), displayValue: z.string().nullable() })),
  metrics: z.record(z.string(), z.string()).default({}),
});
export type LighthouseCategoryResult = z.infer<typeof LighthouseCategoryResult>;

export const CategoryScores = z.object({
  performance: LighthouseCategoryResult.nullable().default(null),
  accessibility: LighthouseCategoryResult.nullable().default(null),
  seo: SeoResult.nullable().default(null),
});
export type CategoryScores = z.infer<typeof CategoryScores>;

export const AuditRow = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  input_url: z.string(),
  final_url: z.string().nullable(),
  checklist: z.string(),
  status: AuditStatus,
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  score: z.number().nullable(),
  category_scores: CategoryScores.nullable(),
  summary: z.string().nullable(),
  screenshot_path: z.string().nullable(),
  html_path: z.string().nullable(),
  pdf_path: z.string().nullable(),
  duration_ms: z.number().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRow>;

export const AuditStepRow = z.object({
  id: z.number(),
  audit_id: z.string().uuid(),
  step: StepName,
  status: StepStatus,
  attempt: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_code: z.string().nullable(),
  detail: z.string().nullable(),
});
export type AuditStepRow = z.infer<typeof AuditStepRow>;

export const STEP_LABELS: Record<StepName, string> = {
  fetch: 'Fetch page and screenshots',
  accessibility: 'Accessibility (Lighthouse)',
  performance: 'Performance (Lighthouse)',
  seo: 'Local SEO checks',
  checklist_ai: 'Enquiry checklist (AI)',
  summary: 'Rank fixes and write summary',
};
