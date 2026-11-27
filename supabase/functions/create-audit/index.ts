// Deno entry point for the create-audit Edge Function.
import { createClient } from 'npm:@supabase/supabase-js@2.46.1';
import { handleCreateAudit } from './handler.ts';

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
const SUPABASE_URL = env('SUPABASE_URL');
const anon = createClient(SUPABASE_URL, env('SUPABASE_ANON_KEY'), { auth: { persistSession: false } });
const service = createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const USER_LIMIT = Number(Deno.env.get('AUDITS_PER_USER_PER_DAY') ?? '3');
const IP_LIMIT = Number(Deno.env.get('AUDITS_PER_IP_PER_DAY') ?? '10');
const IP_SALT = env('IP_HASH_SALT');
const ALLOWED_ORIGIN = env('PUBLIC_SITE_URL').replace(/\/$/, '');

async function resolve(hostname: string): Promise<string[]> {
  const [a, aaaa] = await Promise.allSettled([Deno.resolveDns(hostname, 'A'), Deno.resolveDns(hostname, 'AAAA')]);
  const out = [...(a.status === 'fulfilled' ? a.value : []), ...(aaaa.status === 'fulfilled' ? aaaa.value : [])];
  if (out.length === 0) throw new Error('ENOTFOUND');
  return out;
}

Deno.serve((req) =>
  handleCreateAudit(req, {
    allowedOrigin: ALLOWED_ORIGIN,
    resolve,
    async getUserId(jwt) {
      const { data, error } = await anon.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    async hashIp(ip) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${IP_SALT}:${ip}`));
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    },
    async findRecent({ userId, url }) {
      const { data, error } = await service.rpc('find_recent_audit', { p_user: userId, p_input_url: url });
      if (error) throw new Error(error.message);
      return typeof data === 'string' ? data : null;
    },
    async remaining(userId) {
      const { data, error } = await service.from('profiles').select('audits_today, quota_reset_at').eq('id', userId).maybeSingle();
      if (error || !data) return USER_LIMIT;
      return new Date(data.quota_reset_at as string) <= new Date() ? USER_LIMIT : Math.max(USER_LIMIT - (data.audits_today as number), 0);
    },
    async reserve({ userId, ipHash, url }) {
      const { data, error } = await service.rpc('reserve_audit', {
        p_user: userId,
        p_ip_hash: ipHash,
        p_input_url: url,
        p_user_limit: USER_LIMIT,
        p_ip_limit: IP_LIMIT,
      });
      if (error) throw new Error(error.message);
      const row = (data as Array<{ audit_id: string; remaining: number }>)[0];
      if (!row) throw new Error('reserve_audit returned no row');
      return { auditId: row.audit_id, remaining: row.remaining };
    },
  }),
);
