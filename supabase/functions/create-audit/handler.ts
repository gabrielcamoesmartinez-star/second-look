/**
 * POST /create-audit — the only way an audit is created.
 * Runtime-agnostic: index.ts wires it to Deno; tests call it from Node.
 */
import { CreateAuditRequest } from '../_shared/schemas.ts';
import { normaliseUrl } from '../_shared/url.ts';
import { checkHost, type Resolver } from '../_shared/ssrf.ts';
import { ERROR_COPY, type ErrorCode } from '../_shared/errors.ts';

export interface CreateAuditDeps {
  /** Returns the user id for a bearer token, or null if invalid. */
  getUserId(jwt: string): Promise<string | null>;
  resolve: Resolver;
  reserve(args: { userId: string; ipHash: string; url: string }): Promise<{ auditId: string; remaining: number }>;
  hashIp(ip: string): Promise<string>;
  allowedOrigin: string;
}

const MAX_BODY_BYTES = 4096;

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

export async function handleCreateAudit(req: Request, deps: CreateAuditDeps): Promise<Response> {
  const cors = corsHeaders(deps.allowedOrigin);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  const fail = (status: number, code: ErrorCode, detail?: string) =>
    json(status, { ok: false, code, message: ERROR_COPY[code].message, ...(detail ? { detail } : {}) });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, code: 'method_not_allowed', message: 'Use POST.' });

  const jwt = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  const userId = jwt ? await deps.getUserId(jwt) : null;
  if (!userId) return fail(401, 'unauthorized');

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'invalid_url', 'Body too large');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'invalid_url', 'Body is not JSON');
  }
  const parsed = CreateAuditRequest.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_url');

  const norm = normaliseUrl(parsed.data.url);
  if (!norm.ok) return fail(400, 'invalid_url', norm.reason);

  const host = await checkHost(norm.hostname, deps.resolve);
  if (!host.ok) return fail(host.code === 'ssrf_blocked' ? 400 : 422, host.code);

  // Supabase's gateway sets x-forwarded-for; the first entry is the client.
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  const ipHash = await deps.hashIp(ip);

  try {
    const { auditId, remaining } = await deps.reserve({ userId, ipHash, url: norm.url });
    return json(201, { ok: true, auditId, normalisedUrl: norm.url, addedScheme: norm.addedScheme, remaining });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('quota_exceeded')) return fail(429, 'quota_exceeded');
    if (msg.includes('ip_rate_limited')) return fail(429, 'ip_rate_limited');
    console.error(JSON.stringify({ level: 'error', fn: 'create-audit', msg }));
    return fail(500, 'internal');
  }
}
