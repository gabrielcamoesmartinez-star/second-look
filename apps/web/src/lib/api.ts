import { CreateAuditResponse, errorCopy } from '@second-look/shared';
import { supabase } from './supabase';

export type CreateAuditResult =
  | { ok: true; auditId: string; normalizedUrl: string; addedScheme: boolean; remainingToday: number; cached: boolean }
  | { ok: false; message: string };

/** Calls the create-audit Edge Function. The server re-validates everything. */
export async function createAudit(url: string, force = false): Promise<CreateAuditResult> {
  const { data, error } = await supabase.functions.invoke('create-audit', { body: { url, force } });
  let payload: unknown = data;
  if (error) {
    // Non-2xx responses still carry our JSON body with a code and message.
    const ctx = (error as { context?: Response }).context;
    payload = ctx ? await ctx.json().catch(() => null) : null;
  }
  const parsed = CreateAuditResponse.safeParse(payload);
  if (!parsed.success) return { ok: false, message: errorCopy('internal_error') };
  if (!parsed.data.ok) return { ok: false, message: parsed.data.message };
  return parsed.data;
}
