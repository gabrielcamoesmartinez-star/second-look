/**
 * pnpm eval:snapshot [id…]
 * Captures each site in evals/sites.json with the worker's real, SSRF-safe
 * capture code and saves it under evals/snapshots/<id>/. Existing snapshots
 * are skipped unless their id is passed explicitly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { botUserAgent } from '@second-look/shared';
import { createSafeFetch, defaultResolver } from '@second-look/worker/net/safeFetch.ts';
import { checkRobots } from '@second-look/worker/net/robots.ts';
import { BROWSER_ARGS, capturePage } from '@second-look/worker/pipeline/capture.ts';
import { EVALS_DIR, SitesFile, SNAPSHOTS_DIR } from './lib.ts';

const only = new Set(process.argv.slice(2));
const { sites } = SitesFile.parse(JSON.parse(readFileSync(join(EVALS_DIR, 'sites.json'), 'utf8')));
if (sites.length === 0) {
  console.error('evals/sites.json has no sites yet. Add 15–20 real local business sites first.');
  process.exit(1);
}

const safeFetch = createSafeFetch({ resolve: defaultResolver });
const userAgent = botUserAgent(process.env['PUBLIC_SITE_URL'] ?? 'https://second-look-pink.vercel.app');
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM_PATH'] || undefined, args: [...BROWSER_ARGS] });

let ok = 0;
for (const site of sites) {
  const dir = join(SNAPSHOTS_DIR, site.id);
  if (existsSync(join(dir, 'meta.json')) && !only.has(site.id)) {
    console.log(`skip  ${site.id} (already captured; pass its id to recapture)`);
    continue;
  }
  if (only.size > 0 && !only.has(site.id)) continue;
  try {
    const robots = await checkRobots(site.url, safeFetch, userAgent);
    if (!robots.allowed) {
      console.log(`robots ${site.id}: ${robots.note}. Remove it from sites.json.`);
      continue;
    }
    const c = await capturePage(browser, site.url, { safeFetch, userAgent });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'first-screen.png'), c.firstScreenPng);
    writeFileSync(join(dir, 'page.html'), c.html);
    writeFileSync(join(dir, 'visible-text.txt'), c.visibleText);
    writeFileSync(join(dir, 'candidates.json'), JSON.stringify(c.candidates, null, 1));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ url: site.url, final_url: c.finalUrl, captured_at: new Date().toISOString() }, null, 1));
    console.log(`ok    ${site.id} → ${c.finalUrl} (${c.candidates.length} candidates)`);
    ok += 1;
  } catch (e) {
    console.log(`fail  ${site.id}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}
await browser.close();
console.log(`\n${ok} captured. Next: pnpm eval:labels, then fill in evals/labels/*.json by hand.`);
