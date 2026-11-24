import type { SupabaseClient } from '@supabase/supabase-js';
import type { Reporter } from './reporter';

export const BUCKET = 'audit-artifacts';

export function supabaseReporter(db: SupabaseClient, auditId: string): Reporter {
  const must = <T>(res: { data: T; error: { message: string } | null }, what: string): T => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return res.data;
  };
  return {
    async getAudit() {
      const row = must(
        await db.from('audits').select('id, user_id, input_url, status').eq('id', auditId).single(),
        'load audit',
      ) as { id: string; user_id: string; input_url: string; status: never };
      return { id: row.id, userId: row.user_id, inputUrl: row.input_url, status: row.status };
    },
    async setAudit(patch) {
      must(await db.from('audits').update(patch).eq('id', auditId), 'update audit');
    },
    async setStep(step, patch) {
      const ts = new Date().toISOString();
      const extra =
        patch.status === 'running' ? { started_at: ts, finished_at: null }
        : ['done', 'failed', 'skipped'].includes(patch.status) ? { finished_at: ts }
        : {};
      must(await db.from('audit_steps').update({ ...patch, ...extra }).eq('audit_id', auditId).eq('step', step), `update step ${step}`);
    },
    async upload(path, body, contentType) {
      must(await db.storage.from(BUCKET).upload(path, body, { contentType, upsert: true }), `upload ${path}`);
    },
    async isCancelled() {
      const row = must(await db.from('audits').select('status').eq('id', auditId).single(), 'check cancel') as { status: string };
      return row.status === 'cancelled';
    },
  };
}
