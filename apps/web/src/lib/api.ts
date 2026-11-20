import { AuditRow, AuditStepRow, CreateAuditResponse, errorCopy } from '@second-look/shared';
import { z } from 'zod';
import { supabase, SUPABASE_URL } from './supabase.ts';

export async function createAudit(url: string): Promise<CreateAuditResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, code: 'unauthorized', message: errorCopy('unauthorized').message };
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/create-audit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    return { ok: false, code: 'internal', message: 'Could not reach the server. Check your connection.' };
  }
  const parsed = CreateAuditResponse.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : { ok: false, code: 'internal', message: errorCopy('internal').message };
}

const AUDIT_COLUMNS =
  'id,user_id,input_url,final_url,checklist,status,error_code,error_message,score,category_scores,summary,screenshot_path,html_path,pdf_path,share_token,duration_ms,ai_input_tokens,ai_output_tokens,ai_cost_usd,created_at,completed_at';

export async function listAudits(): Promise<AuditRow[]> {
  const { data, error } = await supabase.from('audits').select(AUDIT_COLUMNS).order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  return z.array(AuditRow).parse(data);
}

export async function getAudit(id: string): Promise<{ audit: AuditRow | null; steps: AuditStepRow[] }> {
  const [a, s] = await Promise.all([
    supabase.from('audits').select(AUDIT_COLUMNS).eq('id', id).maybeSingle(),
    supabase.from('audit_steps').select('*').eq('audit_id', id),
  ]);
  if (a.error) throw new Error(a.error.message);
  if (s.error) throw new Error(s.error.message);
  return { audit: a.data ? AuditRow.parse(a.data) : null, steps: z.array(AuditStepRow).parse(s.data ?? []) };
}

export async function quotaRemaining(limit: number): Promise<number> {
  const { data, error } = await supabase.rpc('quota_remaining', { p_user_limit: limit });
  if (error) throw new Error(error.message);
  return z.number().int().nullable().parse(data) ?? limit;
}

export async function signedArtifactUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('audit-artifacts').createSignedUrl(path, 600);
  return error ? null : data.signedUrl;
}

export const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled']);
