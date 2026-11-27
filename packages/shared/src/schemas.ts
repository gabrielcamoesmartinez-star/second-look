import { z } from 'zod';

export const AuditStatus = z.enum(['queued', 'running', 'complete', 'partial', 'failed', 'cancelled']);
export type AuditStatus = z.infer<typeof AuditStatus>;

export const StepName = z.enum(['fetch', 'accessibility', 'performance', 'seo', 'checklist_ai', 'summary']);
export type StepName = z.infer<typeof StepName>;
/** Steps the pipeline runs, in order. */
export const PIPELINE_STEPS: readonly StepName[] = ['fetch', 'performance', 'accessibility', 'seo', 'checklist_ai', 'summary'];
/** @deprecated use PIPELINE_STEPS */
export const STAGE1_STEPS = PIPELINE_STEPS;

export const StepStatus = z.enum(['queued', 'running', 'retrying', 'done', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatus>;

export const MAX_STEP_ATTEMPTS = 3;

/* ---------- API: create-audit ---------- */

export const CreateAuditRequest = z.object({
  url: z.string().min(1).max(2048),
  force: z.boolean().optional().default(false),
});
export type CreateAuditRequest = z.infer<typeof CreateAuditRequest>;

export const CreateAuditResponse = z.union([
  z.object({
    ok: z.literal(true),
    auditId: z.string().uuid(),
    normalisedUrl: z.string(),
    addedScheme: z.boolean(),
    remaining: z.number().int(),
    /** True when a result from the last 24h was returned instead of a new audit (no quota used). */
    cached: z.boolean().optional(),
  }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
export type CreateAuditResponse = z.infer<typeof CreateAuditResponse>;

/* ---------- Database rows (read by the web app) ---------- */

export const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof Box>;

export const SeoCheck = z.object({
  id: z.string(),
  label: z.string(),
  result: z.enum(['pass', 'fail']),
  detail: z.string(),
});
export type SeoCheck = z.infer<typeof SeoCheck>;

export const PageSpeedSummary = z.object({
  score: z.number().min(0).max(100),
  audits: z.array(
    z.object({ id: z.string(), title: z.string(), score: z.number().nullable(), displayValue: z.string().nullable() }),
  ),
});
export type PageSpeedSummary = z.infer<typeof PageSpeedSummary>;

export const CategoryScores = z
  .object({
    performance: PageSpeedSummary.optional(),
    accessibility: PageSpeedSummary.optional(),
    seo: z.object({ score: z.number().min(0).max(100), checks: z.array(SeoCheck) }).optional(),
    /** Overall score breakdown (Stage 2). */
    breakdown: z
      .object({
        categories: z.record(
          z.string(),
          z.object({ score: z.number().nullable(), weight: z.number(), effectiveWeight: z.number(), reason: z.string().optional() }),
        ),
        missing: z.array(z.string()),
      })
      .optional(),
  })
  .passthrough();
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
  share_token: z.string().nullable(),
  duration_ms: z.number().nullable(),
  ai_input_tokens: z.number().nullable(),
  ai_output_tokens: z.number().nullable(),
  ai_cost_usd: z.coerce.number().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRow>;

export const AuditStepRow = z.object({
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

/* ---------- Worker: candidate elements collected from the page ---------- */

export const CandidateKind = z.enum(['tel', 'booking', 'contact', 'form', 'review_widget', 'jsonld']);
export const Candidate = z.object({
  id: z.string(),
  kind: CandidateKind,
  text: z.string().max(200),
  selector: z.string(),
  /** Absolute CSS pixels on the full mobile page. */
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  visible: z.boolean(),
  fieldCount: z.number().int().optional(),
});
export type Candidate = z.infer<typeof Candidate>;

/* ---------- Check results and fixes (read by the web app) ---------- */

export const CheckResultRow = z.object({
  id: z.string().uuid(),
  audit_id: z.string().uuid(),
  check_id: z.string(),
  result: z.enum(['pass', 'fail', 'unsure']),
  confidence: z.coerce.number(),
  evidence: z.string(),
  evidence_selector: z.string().nullable(),
  box: Box.nullable(),
  source: z.enum(['rule', 'ai', 'rule+ai']),
});
export type CheckResultRow = z.infer<typeof CheckResultRow>;

export const FixRow = z.object({
  audit_id: z.string().uuid(),
  rank: z.number().int(),
  title: z.string(),
  why: z.string(),
  evidence: z.string(),
  impact: z.enum(['high', 'medium', 'low']),
  effort: z.number().int(),
  category: z.string(),
  check_ids: z.array(z.string()),
});
export type FixRow = z.infer<typeof FixRow>;
