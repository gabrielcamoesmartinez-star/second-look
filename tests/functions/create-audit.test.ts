import { describe, expect, it } from 'vitest';
import { handleCreateAudit, type CreateAuditDeps } from '../../supabase/functions/create-audit/handler.ts';

const uuid = '11111111-1111-4111-8111-111111111111';
function deps(over: Partial<CreateAuditDeps> = {}): CreateAuditDeps & { reserved: unknown[] } {
  const reserved: unknown[] = [];
  return {
    reserved,
    allowedOrigin: 'https://secondlook.test',
    getUserId: async (jwt) => (jwt === 'good' ? 'user-1' : null),
    resolve: async (h) => (h === 'private.example' ? ['10.0.0.7'] : ['93.184.215.14']),
    hashIp: async (ip) => `hash(${ip})`,
    reserve: async (a) => {
      reserved.push(a);
      return { auditId: uuid, remaining: 2 };
    },
    findRecent: async ({ url }) => (url === 'https://cached.example/' ? '22222222-2222-4222-8222-222222222222' : null),
    remaining: async () => 1,
    ...over,
  };
}
const post = (body: unknown, auth = 'Bearer good') =>
  new Request('https://fn.test/create-audit', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('create-audit', () => {
  it('rejects missing or bad auth', async () => {
    expect((await handleCreateAudit(post({ url: 'a.pt' }, ''), deps())).status).toBe(401);
    expect((await handleCreateAudit(post({ url: 'a.pt' }, 'Bearer nope'), deps())).status).toBe(401);
  });

  it('normalises, checks SSRF, hashes the client IP and enqueues', async () => {
    const d = deps();
    const res = await handleCreateAudit(post({ url: 'example.pt' }), d);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, auditId: uuid, normalisedUrl: 'https://example.pt/', addedScheme: true, remaining: 2 });
    expect(d.reserved).toEqual([{ userId: 'user-1', ipHash: 'hash(203.0.113.9)', url: 'https://example.pt/' }]);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://secondlook.test');
  });

  it.each([
    [{ url: 'javascript:alert(1)' }, 400, 'invalid_url'],
    [{ url: 'http://169.254.169.254/' }, 400, 'ssrf_blocked'],
    [{ url: 'https://private.example' }, 400, 'ssrf_blocked'],
    [{ url: 42 }, 400, 'invalid_url'],
    ['{not json', 400, 'invalid_url'],
  ])('rejects %j', async (body, status, code) => {
    const d = deps();
    const res = await handleCreateAudit(post(body), d);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
    expect(d.reserved).toEqual([]);
  });

  it('maps quota and IP limits to 429 with friendly copy', async () => {
    const quota = await handleCreateAudit(post({ url: 'a.pt' }), deps({ reserve: async () => { throw new Error('quota_exceeded'); } }));
    expect(quota.status).toBe(429);
    expect(await quota.json()).toMatchObject({ code: 'quota_exceeded', message: "You've used today's audits. Try again tomorrow." });
    const ip = await handleCreateAudit(post({ url: 'a.pt' }), deps({ reserve: async () => { throw new Error('ip_rate_limited'); } }));
    expect((await ip.json()).code).toBe('ip_rate_limited');
  });

  it('answers CORS preflight and refuses GET', async () => {
    expect((await handleCreateAudit(new Request('https://fn.test', { method: 'OPTIONS' }), deps())).status).toBe(204);
    expect((await handleCreateAudit(new Request('https://fn.test', { method: 'GET' }), deps())).status).toBe(405);
  });
});

describe('create-audit cache', () => {
  it('returns a recent result without using quota', async () => {
    const d = deps();
    const res = await handleCreateAudit(post({ url: 'cached.example' }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auditId: '22222222-2222-4222-8222-222222222222', cached: true, remaining: 1 });
    expect(d.reserved).toEqual([]);
  });
  it('force re-runs and counts against quota', async () => {
    const d = deps();
    const res = await handleCreateAudit(post({ url: 'cached.example', force: true }), d);
    expect(res.status).toBe(201);
    expect(d.reserved).toHaveLength(1);
  });
});
