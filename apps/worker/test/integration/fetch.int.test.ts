import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedIp } from '@second-look/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeBrowser, fetchPage } from '../../src/steps/fetch';
import type { NetGuard } from '../../src/ssrf';

// Fixture sites run on 127.0.0.1. The test guard allows exactly that address and keeps
// every other private range blocked, so redirect-to-private is still caught.
const guard: NetGuard = {
  resolve: async (h) => (h === 'localhost' ? ['127.0.0.1'] : [h]),
  isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedIp(ip),
};
const UA = 'SecondLookBot/1.0 (+https://secondlook.example/bot)';

const GOOD = `<!doctype html><html lang="pt"><head><meta name="viewport" content="width=device-width"><title>Barbearia do Rio</title></head>
<body><h1>Barbearia do Rio</h1><a href="tel:+351210000000">Ligar</a><img src="http://169.254.169.254/latest/meta-data"></body></html>`;

function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

let site: { server: Server; base: string };
let blocked: { server: Server; base: string };

beforeAll(async () => {
  site = await serve((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(404).end();
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(GOOD);
    if (req.url === '/slow') return; // never responds
    if (req.url === '/to-private') return res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    if (req.url === '/broken') return res.writeHead(500).end('boom');
    res.writeHead(404).end();
  });
  blocked = await serve((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /');
    res.writeHead(200, { 'content-type': 'text/html' }).end(GOOD);
  });
}, 30_000);

afterAll(async () => {
  site.server.closeAllConnections();
  site.server.close();
  blocked.server.close();
  await closeBrowser();
});

describe('fetchPage (real Chromium against fixture sites)', () => {
  it('captures HTML and three screenshots from a good site', async () => {
    const r = await fetchPage(`${site.base}/`, { userAgent: UA, guard, settleMs: 100 });
    expect(r.status).toBe(200);
    expect(r.html).toContain('Barbearia do Rio');
    expect(r.mobileFirstScreen.subarray(1, 4).toString()).toBe('PNG');
    expect(r.desktopFirstScreen.length).toBeGreaterThan(1000);
    expect(r.mobileFullPage[0]).toBe(0xff); // JPEG
  }, 60_000);

  it('refuses a site whose robots.txt disallows us', async () => {
    await expect(fetchPage(`${blocked.base}/`, { userAgent: UA, guard })).rejects.toMatchObject({ code: 'blocked_by_robots' });
  }, 30_000);

  it('blocks a redirect to a private address', async () => {
    await expect(fetchPage(`${site.base}/to-private`, { userAgent: UA, guard })).rejects.toMatchObject({ code: 'ssrf_blocked' });
  }, 30_000);

  it('times out on a site that never responds', async () => {
    await expect(fetchPage(`${site.base}/slow`, { userAgent: UA, guard, navigationTimeoutMs: 2000 })).rejects.toMatchObject({ code: 'fetch_timeout' });
  }, 30_000);

  it('reports server errors as http_error', async () => {
    await expect(fetchPage(`${site.base}/broken`, { userAgent: UA, guard })).rejects.toMatchObject({ code: 'http_error' });
  }, 30_000);
});
