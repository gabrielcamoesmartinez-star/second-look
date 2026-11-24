import { isAllowedByRobots } from '@second-look/shared';
import { chromium, errors as pwErrors, type Browser, type Route } from 'playwright';
import { AuditError } from '../errors';
import { assertPublicHost, defaultGuard, safeGetText, type NetGuard } from '../ssrf';

export const MOBILE = { width: 390, height: 844 } as const;
export const DESKTOP = { width: 1280, height: 800 } as const;
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_FULLPAGE_HEIGHT = 8000;

export interface FetchResult {
  finalUrl: string;
  status: number;
  html: string;
  mobileFirstScreen: Buffer;
  mobileFullPage: Buffer;
  desktopFirstScreen: Buffer;
  robotsNote: string | null;
}

export interface FetchOptions {
  userAgent: string;
  guard?: NetGuard;
  navigationTimeoutMs?: number;
  settleMs?: number;
}

let browserPromise: Promise<Browser> | null = null;

/** One shared Chromium per worker process; contexts are isolated per audit. */
export function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch({
    args: ['--disable-dev-shm-usage'],
    // Optional: use a system Chrome instead of Playwright's bundled Chromium.
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close();
  }
}

/** Checks robots.txt for our bot. 4xx means no rules. Network errors and 5xx are noted but don't block. */
export async function checkRobots(url: string, opts: FetchOptions): Promise<string | null> {
  const target = new URL(url);
  const robotsUrl = new URL('/robots.txt', target.origin).toString();
  try {
    const res = await safeGetText(robotsUrl, { userAgent: opts.userAgent, guard: opts.guard, timeoutMs: 8000 });
    if (res.status >= 400 && res.status < 500) return null;
    if (res.status >= 500) return `robots.txt returned ${res.status}; continued.`;
    if (!isAllowedByRobots(res.text, opts.userAgent, target.pathname + target.search))
      throw new AuditError('blocked_by_robots', 'robots.txt disallows SecondLookBot for this page');
    return null;
  } catch (err) {
    if (err instanceof AuditError && (err.code === 'blocked_by_robots' || err.code === 'ssrf_blocked')) throw err;
    return 'robots.txt could not be fetched; continued.';
  }
}

/** Blocks any request (page, script, image, iframe) to a non-public address. Caches answers per host. */
function makeRouteGuard(guard: NetGuard, blockedMain: { hit: boolean }, navigationTimeoutMs: number) {
  const cache = new Map<string, Promise<boolean>>();
  return async (route: Route) => {
    const req = route.request();
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return route.abort('blockedbyclient');
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort('blockedbyclient');
    let ok = cache.get(u.hostname);
    if (!ok) {
      ok = assertPublicHost(u.hostname, guard).then(
        () => true,
        () => false,
      );
      cache.set(u.hostname, ok);
    }
    const isMainNav = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    if (!(await ok)) {
      if (isMainNav) blockedMain.hit = true;
      return route.abort('blockedbyclient');
    }
    if (!isMainNav) return route.continue();
    // Chromium follows server redirects internally without asking the router again, so for the
    // main document we fetch it ourselves with redirects off and check every Location header.
    try {
      const res = await route.fetch({ maxRedirects: 0, timeout: navigationTimeoutMs });
      const location = res.headers()['location'];
      if (res.status() >= 300 && res.status() < 400 && location) {
        const next = new URL(location, u);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          blockedMain.hit = true;
          return route.abort('blockedbyclient');
        }
        const nextOk = await assertPublicHost(next.hostname, guard).then(() => true, () => false);
        if (!nextOk) {
          blockedMain.hit = true;
          return route.abort('blockedbyclient');
        }
      }
      return route.fulfill({ response: res });
    } catch {
      return route.abort('failed');
    }
  };
}

export async function fetchPage(url: string, opts: FetchOptions): Promise<FetchResult> {
  const guard = opts.guard ?? defaultGuard;
  await assertPublicHost(new URL(url).hostname, guard);
  const robotsNote = await checkRobots(url, opts);

  const browser = await getBrowser();
  const blockedMain = { hit: false };
  const mobile = await browser.newContext({
    viewport: MOBILE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: opts.userAgent,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
  });
  try {
    await mobile.route('**/*', makeRouteGuard(guard, blockedMain, opts.navigationTimeoutMs ?? 30_000));
    const page = await mobile.newPage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: opts.navigationTimeoutMs ?? 30_000 });
    } catch (err) {
      if (blockedMain.hit) throw new AuditError('ssrf_blocked', 'The page redirected to a non-public address');
      if (err instanceof pwErrors.TimeoutError) throw new AuditError('fetch_timeout', 'Page did not finish loading in time', true);
      throw new AuditError('fetch_failed', err instanceof Error ? err.message.split('\n')[0] : 'Navigation failed', true);
    }
    if (blockedMain.hit) throw new AuditError('ssrf_blocked', 'The page redirected to a non-public address');
    if (!response) throw new AuditError('fetch_failed', 'No response from the site', true);
    const status = response.status();
    if (status >= 400) throw new AuditError('http_error', `The site responded with HTTP ${status}`, status >= 500);

    await page.waitForTimeout(opts.settleMs ?? 1500); // let late scripts and fonts settle
    const finalUrl = page.url();
    const html = await page.content();
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new AuditError('page_too_large');

    const mobileFirstScreen = await page.screenshot({ type: 'png' });
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const mobileFullPage = await page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: true,
      clip: { x: 0, y: 0, width: MOBILE.width, height: Math.min(fullHeight, MAX_FULLPAGE_HEIGHT) },
    });

    const desktop = await browser.newContext({ viewport: DESKTOP, userAgent: opts.userAgent, serviceWorkers: 'block' });
    let desktopFirstScreen: Buffer;
    try {
      await desktop.route('**/*', makeRouteGuard(guard, { hit: false }, opts.navigationTimeoutMs ?? 30_000));
      const dpage = await desktop.newPage();
      await dpage.goto(finalUrl, { waitUntil: 'load', timeout: opts.navigationTimeoutMs ?? 30_000 }).catch(() => null);
      await dpage.waitForTimeout(500);
      desktopFirstScreen = await dpage.screenshot({ type: 'png' });
    } finally {
      await desktop.close();
    }

    return { finalUrl, status, html, mobileFirstScreen, mobileFullPage, desktopFirstScreen, robotsNote };
  } finally {
    await mobile.close();
  }
}
