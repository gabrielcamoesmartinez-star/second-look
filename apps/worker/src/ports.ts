/**
 * The pipeline talks to the outside world only through these interfaces.
 * Production wires them to Supabase and Google; integration tests wire them
 * to in-memory fakes and recorded responses.
 */
import type { CategoryScores, ErrorCode, StepName, StepStatus } from '@second-look/shared';

export interface StepUpdate {
  status: StepStatus;
  attempt?: number;
  error_code?: ErrorCode | null;
  detail?: string | null;
}

export interface AuditPatch {
  status?: 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
  final_url?: string | null;
  error_code?: ErrorCode | null;
  error_message?: string | null;
  category_scores?: CategoryScores;
  screenshot_path?: string | null;
  html_path?: string | null;
  duration_ms?: number;
  completed_at?: string;
}

export interface AuditRecord {
  id: string;
  user_id: string;
  input_url: string;
  status: string;
}

export interface Store {
  getAudit(id: string): Promise<AuditRecord | null>;
  updateAudit(id: string, patch: AuditPatch): Promise<void>;
  updateStep(id: string, step: StepName, update: StepUpdate): Promise<void>;
}

export interface BlobStore {
  put(path: string, body: Buffer, contentType: string): Promise<void>;
}

export interface PageSpeedClient {
  run(url: string, signal?: AbortSignal): Promise<unknown>;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
