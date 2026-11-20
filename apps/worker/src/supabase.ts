import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AuditPatch, AuditRecord, BlobStore, Store, StepUpdate } from './ports.ts';

export const BUCKET = 'audit-artifacts';

export function serviceClient(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

const AuditRecordRow = z.object({ id: z.string().uuid(), user_id: z.string().uuid(), input_url: z.string(), status: z.string() });

export function supabaseStore(db: SupabaseClient): Store {
  return {
    async getAudit(id): Promise<AuditRecord | null> {
      const { data, error } = await db.from('audits').select('id,user_id,input_url,status').eq('id', id).maybeSingle();
      if (error) throw new Error(`getAudit: ${error.message}`);
      return data ? AuditRecordRow.parse(data) : null;
    },
    async updateAudit(id, patch: AuditPatch) {
      const { error } = await db.from('audits').update(patch).eq('id', id);
      if (error) throw new Error(`updateAudit: ${error.message}`);
    },
    async updateStep(id, step, u: StepUpdate) {
      const now = new Date().toISOString();
      const row: Record<string, unknown> = { status: u.status };
      if (u.attempt !== undefined) row['attempt'] = u.attempt;
      if (u.error_code !== undefined) row['error_code'] = u.error_code;
      if (u.detail !== undefined) row['detail'] = u.detail;
      if (u.status === 'running' && u.attempt === 1) row['started_at'] = now;
      if (u.status === 'done' || u.status === 'failed' || u.status === 'skipped') row['finished_at'] = now;
      const { error } = await db.from('audit_steps').upsert({ audit_id: id, step, ...row }, { onConflict: 'audit_id,step' });
      if (error) throw new Error(`updateStep: ${error.message}`);
    },
  };
}

export function supabaseBlobs(db: SupabaseClient): BlobStore {
  return {
    async put(path, body, contentType) {
      const { error } = await db.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
      if (error) throw new Error(`upload ${path}: ${error.message}`);
    },
  };
}

const ClaimRow = z.object({ audit_id: z.string().uuid(), attempts: z.number().int() });

export function supabaseQueue(db: SupabaseClient, workerId: string) {
  return {
    async claim(): Promise<z.infer<typeof ClaimRow> | null> {
      const { data, error } = await db.rpc('claim_job', { p_worker: workerId });
      if (error) throw new Error(`claim_job: ${error.message}`);
      const rows = z.array(ClaimRow).parse(data ?? []);
      return rows[0] ?? null;
    },
    async heartbeat(auditId: string): Promise<boolean> {
      const { data, error } = await db.rpc('heartbeat_job', { p_audit: auditId, p_worker: workerId });
      if (error) throw new Error(`heartbeat_job: ${error.message}`);
      return data === true;
    },
    async finish(auditId: string) {
      const { error } = await db.rpc('finish_job', { p_audit: auditId, p_worker: workerId });
      if (error) throw new Error(`finish_job: ${error.message}`);
    },
    async release(auditId: string) {
      const { error } = await db.rpc('release_job', { p_audit: auditId, p_worker: workerId });
      if (error) throw new Error(`release_job: ${error.message}`);
    },
    async requeueStale(staleSeconds: number): Promise<number> {
      const { data, error } = await db.rpc('requeue_stale_jobs', { p_stale_seconds: staleSeconds, p_max_attempts: 3 });
      if (error) throw new Error(`requeue_stale_jobs: ${error.message}`);
      return z.number().int().parse(data);
    },
  };
}
export type Queue = ReturnType<typeof supabaseQueue>;
