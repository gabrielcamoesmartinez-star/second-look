/**
 * Fetch step: open the page in Chromium with every request proxied through
 * safeFetch, take screenshots, and collect candidate elements with their
 * real bounding boxes (the only source of marker coordinates).
 */
import type { Browser, BrowserContext, Route } from 'playwright';
import { Candidate, DESKTOP_VIEWPORT, MAX_PAGE_BYTES, MAX_REDIRECTS, MOBILE_VIEWPORT, NAV_TIMEOUT_MS } from '@second-look/shared';
import { z } from 'zod';
import { FetchError, type SafeFetch } from '../net/safeFetch.ts';

/** Cap on everything the page loads, to protect the worker. The 10 MB limit applies to the HTML document itself. */
const TOTAL_PAGE_BUDGET_BYTES = 40 * 1024 * 1024;
const SUBRESOURCE_TIMEOUT_MS = 15_000;
const SETTLE_MS = 1_500;

export interface Capture {
  finalUrl: string;
  status: number;
  html: string;
  visibleText: string;
  firstScreenPng: Buffer;
  fullPageJpeg: Buffer;
  desktopPng: Buffer | null;
  candidates: Candidate[];
  pageHeight: number;
}

/** Launch flags: a dead proxy with no loopback bypass, so the browser has no network of its own. */
export const BROWSER_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--dns-prefetch-disable',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
] as const;

export interface CaptureDeps {
  safeFetch: SafeFetch;
  userAgent: string;
  signal?: AbortSignal;
  navTimeoutMs?: number;
}

const FORWARDED_HEADERS = ['accept', 'accept-language', 'range', 'referer'];

async function guardedContext(
  browser: Browser,
  safeFetch: SafeFetch,
  userAgent: string,
  mobile: boolean,
  signal: AbortSignal | undefined,
  navTimeoutMs: number,
): Promise<{ context: BrowserContext; mainError: () => FetchError | null; takeRedirect: () => string | null }> {
  const context = await browser.newContext({
    viewport: mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    userAgent,
    serviceWorkers: 'block',
    acceptDownloads: false,
    locale: 'en-GB',
  });
  let mainError: FetchError | null = null;
  let pendingRedirect: string | null = null;
  let budget = TOTAL_PAGE_BUDGET_BYTES;

  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.abort('blockedbyclient');
    const isMainDoc = req.isNavigationRequest() && req.frame().parentFrame() === null;
    const headers: Record<string, string> = {};
    for (const h of FORWARDED_HEADERS) {
      const v = req.headers()[h];
      if (v) headers[h] = v;
    }
    try {
      const res = await safeFetch(req.url(), {
        userAgent,
        headers,
        // Chromium does NOT send redirect hops of a fulfilled response back through route(),
        // so the browser must never see a 3xx. Main document: we hand the hop back to
        // capturePage, which navigates to it (through this handler again). Sub-resources:
        // safeFetch follows and re-validates every hop itself.
        maxRedirects: isMainDoc ? 0 : MAX_REDIRECTS,
        timeoutMs: isMainDoc ? navTimeoutMs : SUBRESOURCE_TIMEOUT_MS,
        maxBytes: isMainDoc ? MAX_PAGE_BYTES : Math.max(budget, 0),
        signal,
      });
      budget -= res.body.length;
      const location = res.headers['location'];
      if (isMainDoc && res.status >= 300 && res.status < 400 && location) {
        pendingRedirect = new URL(location, req.url()).toString();
        return route.fulfill({ status: 200, contentType: 'text/html', body: '' });
      }
      const out = { ...res.headers };
      delete out['content-encoding'];
      delete out['transfer-encoding'];
      delete out['content-length'];
      return route.fulfill({ status: res.status, headers: out, body: res.body });
    } catch (e) {
      if (isMainDoc) mainError = e instanceof FetchError ? e : new FetchError('fetch_failed', String(e));
      return route.abort(e instanceof FetchError && e.code === 'fetch_timeout' ? 'timedout' : 'blockedbyclient');
    }
  });
  // WebSockets would bypass route(); refuse them outright.
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  return {
    context,
    mainError: () => mainError,
    takeRedirect: () => {
      const r = pendingRedirect;
      pendingRedirect = null;
      return r;
    },
  };
}

export async function capturePage(
  browser: Browser,
  url: string,
  deps: CaptureDeps,
): Promise<Capture> {
  const navTimeoutMs = deps.navTimeoutMs ?? NAV_TIMEOUT_MS;
  const { context, mainError, takeRedirect } = await guardedContext(browser, deps.safeFetch, deps.userAgent, true, deps.signal, navTimeoutMs);
  try {
    const page = await context.newPage();
    const onAbort = () => void context.close();
    deps.signal?.addEventListener('abort', onAbort, { once: true });

    let response;
    let target = url;
    for (let hops = 0; ; hops++) {
      try {
        response = await page.goto(target, { waitUntil: 'load', timeout: navTimeoutMs });
      } catch (e) {
        const known = mainError();
        if (known) throw known;
        if (e instanceof Error && /Timeout/i.test(e.message)) throw new FetchError('fetch_timeout', e.message);
        throw new FetchError('fetch_failed', e instanceof Error ? e.message : String(e));
      }
      const known = mainError();
      if (known) throw known;
      const next = takeRedirect();
      if (next === null) break;
      if (hops >= MAX_REDIRECTS) throw new FetchError('too_many_redirects', `More than ${MAX_REDIRECTS} redirects`);
      target = next;
    }
    if (!response) throw new FetchError('fetch_failed', 'No response');
    const status = response.status();
    if (status >= 400) throw new FetchError('http_error', `The page returned HTTP ${status}`);

    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    // Let entrance animations (typed headings, fades) settle before we capture.
    await page.waitForTimeout(SETTLE_MS);

    const firstScreenPng = await page.screenshot({ type: 'png' });
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const fullPageJpeg = await page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: pageHeight <= 12_000,
      clip: pageHeight > 12_000 ? { x: 0, y: 0, width: MOBILE_VIEWPORT.width, height: 12_000 } : undefined,
    });
    const html = await page.content();
    const visibleText = await page.evaluate(() => document.body?.innerText ?? '');
    const rawCandidates: unknown = await page.evaluate(IN_PAGE_COLLECTOR);
    const candidates = z.array(Candidate).parse(rawCandidates);
    const finalUrl = page.url();
    deps.signal?.removeEventListener('abort', onAbort);

    const desktopPng = await captureDesktop(browser, finalUrl, deps).catch(() => null);

    return { finalUrl, status, html, visibleText, firstScreenPng, fullPageJpeg, desktopPng, candidates, pageHeight };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function captureDesktop(browser: Browser, url: string, deps: CaptureDeps): Promise<Buffer> {
  const navTimeoutMs = deps.navTimeoutMs ?? NAV_TIMEOUT_MS;
  const { context } = await guardedContext(browser, deps.safeFetch, deps.userAgent, false, deps.signal, navTimeoutMs);
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: navTimeoutMs });
    return await page.screenshot({ type: 'png' });
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * The collector is sent to the page as source text. Transpilers like tsx/esbuild
 * (keepNames) inject calls to a `__name` helper that only exists in Node, so the
 * page would throw "__name is not defined". Defining a no-op `__name` in the same
 * scope makes the serialized function work however it was compiled.
 */
export const IN_PAGE_COLLECTOR = `(() => {
  const __name = (fn) => fn;
  return (${collectCandidatesInPage.toString()})();
})()`;

/**
 * Runs inside the page. Must be self-contained (no closures).
 * Returns candidate elements with absolute page coordinates.
 */
export function collectCandidatesInPage(): unknown[] {
  const ACTION_WORDS =
    /\b(book|booking|appointment|schedule|quote|estimate|contact|enquir|inquir|get in touch|call us|reserve|reservation|marcar|marca[cç][aã]o|agendar|agendamento|reservar|reserva|or[cç]amento|contacto|contactar|contacte|fale connosco|ligue)/i;
  const REVIEW_HINT = /review|rating|testimonial|trustpilot|google-?reviews|elfsight|feefo|yotpo|stars?\b|avalia/i;
  const MAX = 40;
  const out: Array<Record<string, unknown>> = [];
  let n = 0;

  const selectorFor = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement && parts.length < 6) {
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      const sibs = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const push = (el: Element, kind: string, extra: Record<string, unknown> = {}) => {
    if (out.length >= MAX) return;
    const r = el.getBoundingClientRect();
    n += 1;
    out.push({
      id: `c${n}`,
      kind,
      text: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('href') || '').trim().slice(0, 200),
      selector: selectorFor(el),
      rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
      visible: isVisible(el),
      ...extra,
    });
  };

  document.querySelectorAll('a[href^="tel:"]').forEach((el) => push(el, 'tel'));
  document.querySelectorAll('a, button, [role="button"], input[type="submit"]').forEach((el) => {
    if (el.matches('a[href^="tel:"]')) return;
    const label = `${(el as HTMLElement).innerText || ''} ${el.getAttribute('aria-label') || ''} ${(el as HTMLInputElement).value || ''}`;
    if (!ACTION_WORDS.test(label)) return;
    push(el, /contact|contacto|contact[ae]r|fale|enquir|inquir|get in touch/i.test(label) ? 'contact' : 'booking');
  });
  document.querySelectorAll('form').forEach((form) => {
    const fields = Array.from(form.querySelectorAll('input, textarea, select')).filter((f) => {
      const type = (f.getAttribute('type') || '').toLowerCase();
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type) && isVisible(f);
    });
    push(form, 'form', { fieldCount: fields.length });
  });
  document.querySelectorAll('[class], [id], iframe').forEach((el) => {
    const hint = `${el.getAttribute('class') || ''} ${el.id || ''} ${el.getAttribute('src') || ''}`;
    if (REVIEW_HINT.test(hint) && isVisible(el) && !el.closest('[data-sl-review]')) {
      el.setAttribute('data-sl-review', '');
      push(el, 'review_widget');
    }
  });
  document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => push(el, 'jsonld'));
  return out;
}
