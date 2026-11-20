/**
 * Worker integration: the real pipeline (real Chromium, real HTTP, real
 * SSRF checks) against local fixture sites. PageSpeed is replaced by a
 * synthetic response in the real API shape so CI is deterministic and free.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepName } from '@second-look/shared';
import { silentLogger } from '../src/log.ts';
import { createSafeFetch, type SafeFetch } from '../src/net/safeFetch.ts';
import type { AuditPatch, AuditRecord, BlobStore, PageSpeedClient, StepUpdate, Store } from '../src/ports.ts';
import { runAudit } from '../src/pipeline/run.ts';
import { BROWSER_ARGS } from '../src/pipeline/capture.ts';

const sharedFixtures = join(__dirname, '..', '..', '..', 'packages', 'shared', 'test', 'fixtures');
const goodHtml = readFileSync(join(sharedFixtures, 'good.html'), 'utf8');
const badHtml = readFileSync(join(sharedFixtures, 'bad.html'), 'utf8');
const psiFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'psi-synthetic.json'), 'utf8')) as unknown;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
async function serve(handler: Handler): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const html = (body: string): Handler => (req, res) => {
  if (req.url === '/robots.txt') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
};

let browser: Browser;
const hosts: Record<'good' | 'bad' | 'robots' | 'slow' | 'redirect' | 'loop', string> = {
  good: '', bad: '', robots: '', slow: '', redirect: '', loop: '',
};
const blockedRequests: string[] = [];
let safeFetch: SafeFetch;

beforeAll(async () => {
  hosts.good = await serve(html(goodHtml));
  hosts.bad = await serve(html(badHtml));
  hosts.robots = await serve((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /\n');
    html(goodHtml)(req, res);
  });
  hosts.slow = await serve((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(404).end();
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(goodHtml), 10_000).unref();
  });
  hosts.redirect = await serve((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(404).end();
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
  });
  hosts.loop = await serve((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(404).end();
    const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? '0');
    res.writeHead(302, { location: `/?n=${n + 1}` }).end();
  });

  const inner = createSafeFetch({
    resolve: async () => {
      throw new Error('fixtures use IP literals; DNS must not be needed');
    },
    testOnlyAllowedHosts: new Set(Object.values(hosts)),
  });
  safeFetch = async (url, opts) => {
    try {
      return await inner(url, opts);
    } catch (e) {
      blockedRequests.push(url);
      throw e;
    }
  };

  browser = await chromium.launch({ executablePath: process.env['CHROMIUM_PATH'] || undefined, args: [...BROWSER_ARGS] });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.closeAllConnections();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

type Rec = Omit<AuditRecord, 'status'> & Omit<AuditPatch, 'status'> & { status: string };
class MemoryStore implements Store {
  audits = new Map<string, Rec>();
  steps = new Map<StepName, StepUpdate>();
  history: Array<[StepName, StepUpdate['status'], number | undefined]> = [];
  async getAudit(id: string) {
    return this.audits.get(id) ?? null;
  }
  async updateAudit(id: string, patch: AuditPatch) {
    const cur = this.audits.get(id);
    if (cur) this.audits.set(id, { ...cur, ...patch });
  }
  async updateStep(_id: string, step: StepName, u: StepUpdate) {
    this.steps.set(step, { ...this.steps.get(step), ...u });
    this.history.push([step, u.status, u.attempt]);
  }
}
class MemoryBlobs implements BlobStore {
  files = new Map<string, Buffer>();
  async put(path: string, body: Buffer) {
    this.files.set(path, body);
  }
}

const okPsi: PageSpeedClient = { run: async () => psiFixture };

async function audit(url: string, pagespeed: PageSpeedClient = okPsi) {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  store.audits.set('a1', { id: 'a1', user_id: 'u1', input_url: url, status: 'queued' });
  const outcome = await runAudit('a1', {
    store,
    blobs,
    pagespeed,
    browser,
    safeFetch,
    userAgent: 'SecondLookBot/1.0 (+https://test.invalid/bot)',
    log: silentLogger,
    pagespeedBackoffMs: 10,
    navTimeoutMs: 4_000,
    allowAnyPort: true,
  });
  return { outcome, store, blobs, record: store.audits.get('a1')! };
}

describe('pipeline on fixture sites', () => {
  it('good site: complete, screenshots stored, SEO all pass, tel candidate in first screen', async () => {
    const { outcome, record, store, blobs } = await audit(`http://${hosts.good}/`);
    expect(outcome).toBe('complete');
    expect(record.status).toBe('complete');
    expect(record.category_scores?.performance?.score).toBe(66);
    expect(record.category_scores?.accessibility?.score).toBe(83);
    expect(record.category_scores?.seo?.score).toBe(100);
    expect(['fetch', 'performance', 'accessibility', 'seo'].map((s) => store.steps.get(s as StepName)?.status)).toEqual([
      'done', 'done', 'done', 'done',
    ]);
    const png = blobs.files.get('u1/a1/mobile-first-screen.png');
    expect(png?.subarray(1, 4).toString()).toBe('PNG');
    expect(png?.readUInt32BE(16)).toBe(780); // 390px × deviceScaleFactor 2
    expect(blobs.files.has('u1/a1/page.html')).toBe(true);
    const candidates = JSON.parse(blobs.files.get('u1/a1/candidates.json')!.toString()) as Array<{ kind: string; rect: { y: number }; visible: boolean; fieldCount?: number }>;
    const tel = candidates.find((c) => c.kind === 'tel');
    expect(tel?.visible).toBe(true);
    expect(tel!.rect.y).toBeLessThan(844);
    expect(candidates.find((c) => c.kind === 'form')?.fieldCount).toBe(3);
    expect(candidates.some((c) => c.kind === 'booking')).toBe(true);
  }, 30_000);

  it('bad site: SEO fails, and the metadata-IP image is refused', async () => {
    const { outcome, record } = await audit(`http://${hosts.bad}/`);
    expect(outcome).toBe('complete');
    expect(record.category_scores?.seo?.score).toBe(0);
    expect(blockedRequests).toContain('http://169.254.169.254/latest/meta-data/');
  }, 30_000);

  it('robots disallow: failed with blocked_by_robots, nothing fetched', async () => {
    const { outcome, record, store, blobs } = await audit(`http://${hosts.robots}/`);
    expect(outcome).toBe('failed');
    expect(record.error_code).toBe('blocked_by_robots');
    expect(store.steps.get('seo')?.status).toBe('skipped');
    expect(blobs.files.size).toBe(0);
  }, 30_000);

  it('slow site: fetch_timeout', async () => {
    const { outcome, record } = await audit(`http://${hosts.slow}/`);
    expect(outcome).toBe('failed');
    expect(record.error_code).toBe('fetch_timeout');
  }, 30_000);

  it('redirect to a private IP: ssrf_blocked', async () => {
    const { outcome, record } = await audit(`http://${hosts.redirect}/`);
    expect(outcome).toBe('failed');
    expect(record.error_code).toBe('ssrf_blocked');
  }, 30_000);

  it('redirect loop: too_many_redirects', async () => {
    const { record } = await audit(`http://${hosts.loop}/`);
    expect(record.error_code).toBe('too_many_redirects');
  }, 30_000);

  it('PageSpeed down: retries 3 times, then partial with SEO still done', async () => {
    let calls = 0;
    const failing: PageSpeedClient = {
      run: async () => {
        calls += 1;
        throw new Error('PageSpeed HTTP 500 key=SECRET123');
      },
    };
    const { outcome, record, store } = await audit(`http://${hosts.good}/`, failing);
    expect(calls).toBe(3);
    expect(outcome).toBe('partial');
    expect(record.status).toBe('partial');
    expect(store.steps.get('performance')?.status).toBe('failed');
    expect(store.steps.get('performance')?.detail).not.toContain('SECRET123');
    expect(store.steps.get('seo')?.status).toBe('done');
    expect(store.history.filter(([s, st]) => s === 'performance' && st === 'retrying').map(([, , a]) => a)).toEqual([2, 3]);
  }, 30_000);
});

describe('safeFetch direct', () => {
  it('blocks a private IP literal that is not allow-listed', async () => {
    await expect(safeFetch('http://127.0.0.1:1/', { userAgent: 't', timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('enforces the byte cap', async () => {
    await expect(safeFetch(`http://${hosts.good}/`, { userAgent: 't', timeoutMs: 2000, maxBytes: 100 })).rejects.toMatchObject({
      code: 'page_too_large',
    });
  });
  it('pins DNS: a hostname that resolves private is blocked before connecting', async () => {
    const f = createSafeFetch({ resolve: async () => ['10.1.2.3'] });
    await expect(f('http://rebind.example/', { userAgent: 't', timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
});
