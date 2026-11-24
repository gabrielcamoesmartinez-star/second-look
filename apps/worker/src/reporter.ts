import type { AuditStatus, CategoryScores, ErrorCode, StepName, StepStatus } from '@second-look/shared';

/** Everything the pipeline needs from the outside world. Supabase in production, in-memory in tests. */
export interface Reporter {
  getAudit(): Promise<{ id: string; userId: string; inputUrl: string; status: AuditStatus }>;
  setAudit(patch: {
    status?: AuditStatus;
    final_url?: string;
    error_code?: ErrorCode | null;
    error_message?: string | null;
    category_scores?: CategoryScores;
    screenshot_path?: string;
    html_path?: string;
    duration_ms?: number;
    completed_at?: string;
  }): Promise<void>;
  setStep(step: StepName, patch: { status: StepStatus; attempt?: number; error_code?: string | null; detail?: string | null }): Promise<void>;
  upload(path: string, body: Buffer, contentType: string): Promise<void>;
  isCancelled(): Promise<boolean>;
}
