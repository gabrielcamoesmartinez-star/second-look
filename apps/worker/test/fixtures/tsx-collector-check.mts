// Run with tsx (like production). Prints JSON: was __name injected, and does the collector run in a real page?
import { chromium } from 'playwright';
import { collectCandidatesInPage, IN_PAGE_COLLECTOR } from '../../src/pipeline/capture.ts';
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM_PATH'] || undefined });
try {
  const page = await browser.newPage();
  await page.setContent('<a href="tel:+351210000000">Call</a><form><input name="a"></form>');
  const out = (await page.evaluate(IN_PAGE_COLLECTOR)) as Array<{ kind: string }>;
  console.log(JSON.stringify({ injected: collectCandidatesInPage.toString().includes('__name'), kinds: out.map((c) => c.kind) }));
} finally {
  await browser.close();
}
