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
import type { CheckResult, RankedFix, StepName } from '@second-look/shared';
import type { AiClient, AiRequest } from '../src/ai/anthropic.ts';
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
  checks: CheckResult[] = [];
  fixes: RankedFix[] = [];
  spend = 0;
  async saveCheckResults(_id: string, r: CheckResult[]) {
    this.checks = r;
  }
  async saveFixes(_id: string, f: RankedFix[]) {
    this.fixes = f;
  }
  async getAiSpendToday() {
    return this.spend;
  }
  async addAiSpend(usd: number) {
    this.spend += usd;
  }
}

/**
 * Fake Claude. Replies are HAND-WRITTEN in the shape the real model returns (not
 * recordings), so CI is deterministic and free. `script` overrides replies in order.
 */
const AI_IDS = ['booking_first_screen', 'single_primary_cta', 'location_stated', 'reviews_visible', 'hours_visible'] as const;
function fakeAi(script: Array<(req: AiRequest) => string> = []): AiClient & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    model: 'fake-model',
    requests,
    async complete(req) {
      requests.push(req);
      const scripted = script.shift();
      if (scripted) return { text: scripted(req), inputTokens: 1000, outputTokens: 200 };
      return { text: defaultReply(req), inputTokens: 1000, outputTokens: 200 };
    },
  };
}
function userText(req: AiRequest): string {
  const c = req.messages[0]?.content;
  return typeof c === 'string' ? c : (c ?? []).map((x) => (x.type === 'text' ? x.text : '')).join('');
}
function defaultReply(req: AiRequest): string {
  if (req.system.includes('summary')) {
    const score = /"overall_score_out_of_100": (\d+|null)/.exec(userText(req))?.[1];
    return `Your website scores ${score} out of 100 for turning visitors into enquiries.\n\nThe main problems are listed in the fixes below.\n\nStart with the first fix.`;
  }
  const booking = /^(c\d+) \| (?:booking|contact) \| first screen/m.exec(userText(req))?.[1] ?? null;
  return JSON.stringify(
    Object.fromEntries(AI_IDS.map((id) => [id, { result: 'pass', confidence: 0.9, evidence: 'Seen on the page.', evidence_element_id: id === 'booking_first_screen' ? booking : null }])),
  );
}
class MemoryBlobs implements BlobStore {
  files = new Map<string, Buffer>();
  async put(path: string, body: Buffer) {
    this.files.set(path, body);
  }
}

const okPsi: PageSpeedClient = { run: async () => psiFixture };

async function audit(url: string, pagespeed: PageSpeedClient = okPsi, opts: { ai?: AiClient | null; spend?: number; budget?: number } = {}) {
  const store = new MemoryStore();
  store.spend = opts.spend ?? 0;
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
    ai: opts.ai === undefined ? fakeAi() : opts.ai,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    dailyAiBudgetUsd: opts.budget ?? 0.5,
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
    expect(['fetch', 'performance', 'accessibility', 'seo', 'checklist_ai', 'summary'].map((s) => store.steps.get(s as StepName)?.status)).toEqual([
      'done', 'done', 'done', 'done', 'done', 'done',
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

describe('checklist, scoring and summary', () => {
  it('good site: 8 checks with source, score, fixes, summary, tokens and spend recorded', async () => {
    const ai = fakeAi();
    const { outcome, store, record } = await audit(`http://${hosts.good}/`, okPsi, { ai });
    expect(outcome).toBe('complete');
    expect(store.checks).toHaveLength(8);
    const by = Object.fromEntries(store.checks.map((c) => [c.check_id, c]));
    expect(by['tap_to_call_first_screen']).toMatchObject({ result: 'pass', source: 'rule' });
    expect(by['short_contact_form']).toMatchObject({ result: 'pass', source: 'rule' });
    expect(by['local_business_schema']).toMatchObject({ result: 'pass', source: 'rule' });
    expect(by['booking_first_screen']).toMatchObject({ result: 'pass', source: 'rule+ai' });
    expect(by['booking_first_screen']?.evidence_selector).not.toBeNull();
    expect(record.score).toBeGreaterThan(80);
    expect(record.category_scores?.breakdown?.missing).toEqual([]);
    expect(record.summary?.split('\n\n')).toHaveLength(3);
    expect(ai.requests).toHaveLength(2);
    const img = ai.requests[0]?.messages[0]?.content;
    expect(Array.isArray(img) && img[0]?.type).toBe('image');
    expect(record.ai_input_tokens).toBe(2000);
    expect(record.ai_output_tokens).toBe(400);
    expect(record.ai_cost_usd).toBeCloseTo((2000 * 0.1 + 400 * 0.5) / 1e6, 9);
    expect(store.spend).toBeCloseTo(record.ai_cost_usd!, 9);
  }, 30_000);

  it('bad site: failing checks become ranked fixes; markers only for on-screen elements', async () => {
    const failAll = () =>
      JSON.stringify(Object.fromEntries(AI_IDS.map((id) => [id, { result: 'fail', confidence: 0.95, evidence: 'Not seen.', evidence_element_id: null }])));
    const { store } = await audit(`http://${hosts.bad}/`, okPsi, { ai: fakeAi([failAll]) });
    expect(store.fixes.length).toBeGreaterThan(5);
    expect(store.fixes[0]).toMatchObject({ rank: 1, title: 'Add a tap-to-call button at the top of the page' });
    expect(store.fixes.map((f) => f.rank)).toEqual(store.fixes.map((_, i) => i + 1));
    const form = store.checks.find((c) => c.check_id === 'short_contact_form');
    expect(form?.result).toBe('fail');
    // The 6-field form sits below the 1400px spacer, so it gets no marker on the first screen.
    expect(form?.box).toBeNull();
  }, 30_000);

  it('invalid AI JSON is retried once with the error, then accepted', async () => {
    const ai = fakeAi([() => 'Here you go: {not json', (req) => defaultReply(req)]);
    const { store, record } = await audit(`http://${hosts.good}/`, okPsi, { ai });
    expect(ai.requests[1]?.messages).toHaveLength(3);
    expect(String(ai.requests[1]?.messages[2]?.content)).toMatch(/not valid JSON/);
    expect(store.steps.get('checklist_ai')?.status).toBe('done');
    expect(record.status).toBe('complete');
  }, 30_000);

  it('AI invalid twice: AI checks unsure, rule checks still decided, audit partial', async () => {
    const ai = fakeAi([() => 'nope', () => '{"still": "wrong"}']);
    const { store, record } = await audit(`http://${hosts.good}/`, okPsi, { ai });
    expect(store.steps.get('checklist_ai')).toMatchObject({ status: 'failed', error_code: 'ai_invalid_output' });
    expect(store.checks.find((c) => c.check_id === 'single_primary_cta')).toMatchObject({ result: 'unsure', confidence: 0 });
    expect(store.checks.find((c) => c.check_id === 'tap_to_call_first_screen')?.result).toBe('pass');
    expect(record.status).toBe('partial');
  }, 30_000);

  it('daily AI budget reached: no AI calls, rules still run, summary skipped', async () => {
    const ai = fakeAi();
    const { store, record } = await audit(`http://${hosts.good}/`, okPsi, { ai, spend: 0.5, budget: 0.5 });
    expect(ai.requests).toHaveLength(0);
    expect(store.steps.get('checklist_ai')).toMatchObject({ status: 'failed', error_code: 'ai_budget_reached' });
    expect(store.steps.get('summary')?.status).toBe('skipped');
    expect(store.checks.find((c) => c.check_id === 'local_business_schema')?.result).toBe('pass');
    expect(record.summary).toBeNull();
    expect(record.score).not.toBeNull();
    expect(record.ai_cost_usd).toBe(0);
  }, 30_000);

  it('a summary with invented numbers is rejected twice and not shown', async () => {
    const fake = () => 'You could get 37% more calls.\n\nSecond.\n\nThird.';
    const ai = fakeAi([(req) => defaultReply(req), fake, fake]);
    const { store, record } = await audit(`http://${hosts.good}/`, okPsi, { ai });
    expect(store.steps.get('summary')).toMatchObject({ status: 'failed', error_code: 'summary_invalid' });
    expect(store.steps.get('summary')?.detail).toMatch(/37/);
    expect(record.summary).toBeNull();
    expect(record.status).toBe('partial');
  }, 30_000);

  it('no AI configured: audit still completes with rule checks (partial)', async () => {
    const { store, record } = await audit(`http://${hosts.good}/`, okPsi, { ai: null });
    expect(store.checks).toHaveLength(8);
    expect(store.steps.get('checklist_ai')?.error_code).toBe('ai_failed');
    expect(record.status).toBe('partial');
  }, 30_000);
});
