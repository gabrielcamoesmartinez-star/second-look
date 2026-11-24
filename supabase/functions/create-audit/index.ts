// POST /create-audit  { url: string, force?: boolean }
// Validates the URL, applies SSRF host checks, quota and per-IP limits, then queues the audit.
import { createClient } from 'npm:@supabase/supabase-js@2.47.10';
import { z } from 'npm:zod@3.24.1';
import { normalizeUrl } from '../_shared/url.ts';
import { ERROR_COPY, type ErrorCode } from '../_shared/errors.ts';
import { corsHeaders } from '../_shared/cors.ts';

const Body = z.object({ url: z.string().min(1).max(2048), force: z.boolean().optional() });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const USER_LIMIT = Number(Deno.env.get('AUDITS_PER_USER_PER_DAY') ?? '3');
const IP_LIMIT = Number(Deno.env.get('AUDITS_PER_IP_PER_DAY') ?? '10');
const IP_SALT = Deno.env.get('IP_HASH_SALT') ?? '';

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function fail(req: Request, status: number, code: ErrorCode): Response {
  return json(req, status, { ok: false, code, message: ERROR_COPY[code] });
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${IP_SALT}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { ok: false, code: 'internal_error', message: 'Use POST.' });
  if (!IP_SALT) console.error('IP_HASH_SALT is not set');

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return fail(req, 401, 'not_authenticated');

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return fail(req, 400, 'invalid_url');
  }

  const normalized = normalizeUrl(body.url);
  if (!normalized.ok) return fail(req, 400, normalized.code);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('enqueue_audit', {
    p_user_id: userData.user.id,
    p_url: normalized.url,
    p_ip_hash: await hashIp(ip),
    p_user_daily_limit: USER_LIMIT,
    p_ip_daily_limit: IP_LIMIT,
    p_force: body.force ?? false,
  });
  if (error) {
    console.error(JSON.stringify({ msg: 'enqueue_audit failed', error: error.message }));
    return fail(req, 500, 'internal_error');
  }

  const result = data as { ok: boolean; code?: ErrorCode; audit_id?: string; remaining?: number; cached?: boolean };
  if (!result.ok) return fail(req, 429, result.code ?? 'internal_error');

  console.log(JSON.stringify({ msg: 'audit queued', audit_id: result.audit_id, cached: result.cached }));
  return json(req, 200, {
    ok: true,
    auditId: result.audit_id,
    normalizedUrl: normalized.url,
    addedScheme: normalized.addedScheme,
    remainingToday: result.remaining ?? 0,
    cached: result.cached ?? false,
  });
});
