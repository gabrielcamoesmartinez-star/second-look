/**
 * SEO basics — rules only, no AI. Input is the rendered HTML and the page's
 * visible text (document.body.innerText from the browser).
 */
import { parse } from 'node-html-parser';
import { LOCAL_BUSINESS_TYPES } from './localBusinessTypes.ts';
import type { SeoCheck } from './schemas.ts';

export const TITLE_MIN = 10;
export const TITLE_MAX = 65;
export const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 160;

type JsonObject = Record<string, unknown>;

export interface SeoResult {
  score: number;
  checks: SeoCheck[];
}

export function extractJsonLd(html: string): { nodes: JsonObject[]; invalidBlocks: number } {
  const root = parse(html);
  const nodes: JsonObject[] = [];
  let invalidBlocks = 0;
  for (const el of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collectNodes(JSON.parse(el.textContent) as unknown, nodes);
    } catch {
      invalidBlocks += 1;
    }
  }
  return { nodes, invalidBlocks };
}

function collectNodes(value: unknown, out: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as JsonObject;
    out.push(obj);
    if ('@graph' in obj) collectNodes(obj['@graph'], out);
  }
}

export function nodeTypes(node: JsonObject): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^https?:\/\/schema\.org\//, ''));
}

export function findLocalBusiness(nodes: JsonObject[]): JsonObject | undefined {
  return nodes.find((n) => nodeTypes(n).some((t) => LOCAL_BUSINESS_TYPES.has(t)));
}

/** A LocalBusiness node is "valid" for our purposes when it names the business and gives a way to find or reach it. */
export function isValidLocalBusiness(node: JsonObject): boolean {
  const hasName = typeof node['name'] === 'string' && node['name'].trim().length > 0;
  const hasContact = node['address'] !== undefined || typeof node['telephone'] === 'string';
  return hasName && hasContact;
}

const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g;
export function findPhone(text: string): string | undefined {
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    // 9 digits covers PT numbers; 10–13 covers UK/US/international formats.
    if (digits.length >= 9 && digits.length <= 13 && !/^(19|20)\d{2}$/.test(m[0].trim())) return m[0].trim();
  }
  return undefined;
}

const ADDRESS_RES: RegExp[] = [
  /\b\d{4}-\d{3}\b/, // PT postcode
  /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/, // UK postcode
  /\b[A-Z]{2}\s\d{5}(?:-\d{4})?\b/, // US state + ZIP
  /\b(?:Rua|Avenida|Av\.|Travessa|Largo|Praça|Estrada|Calçada)\s+\S+/i,
  /\b\d+\s+\w+(?:\s\w+)?\s(?:Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Drive|Boulevard|Way)\b/i,
];
export function findAddress(text: string): string | undefined {
  for (const re of ADDRESS_RES) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

export function runSeoRules(html: string, visibleText: string): SeoResult {
  const root = parse(html);
  const checks: SeoCheck[] = [];

  const title = root.querySelector('title')?.textContent.trim() ?? '';
  checks.push({
    id: 'title',
    label: 'Page title',
    result: title.length >= TITLE_MIN && title.length <= TITLE_MAX ? 'pass' : 'fail',
    detail: title.length === 0 ? 'No <title> found.' : `"${truncate(title, 80)}" (${title.length} characters; aim for ${TITLE_MIN}–${TITLE_MAX}).`,
  });

  const desc = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';
  checks.push({
    id: 'meta_description',
    label: 'Meta description',
    result: desc.length >= DESCRIPTION_MIN && desc.length <= DESCRIPTION_MAX ? 'pass' : 'fail',
    detail:
      desc.length === 0
        ? 'No meta description found.'
        : `${desc.length} characters (aim for ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}).`,
  });

  const h1s = root.querySelectorAll('h1');
  checks.push({
    id: 'single_h1',
    label: 'Exactly one h1',
    result: h1s.length === 1 ? 'pass' : 'fail',
    detail: h1s.length === 1 ? `"${truncate(h1s[0]?.textContent.trim() ?? '', 80)}"` : `Found ${h1s.length} h1 elements.`,
  });

  const lang = root.querySelector('html')?.getAttribute('lang')?.trim() ?? '';
  checks.push({
    id: 'lang',
    label: 'Language attribute',
    result: lang.length > 0 ? 'pass' : 'fail',
    detail: lang.length > 0 ? `lang="${lang}"` : 'The <html> element has no lang attribute.',
  });

  const { nodes, invalidBlocks } = extractJsonLd(html);
  const lb = findLocalBusiness(nodes);
  const lbValid = lb !== undefined && isValidLocalBusiness(lb);
  checks.push({
    id: 'local_business_jsonld',
    label: 'LocalBusiness structured data',
    result: lbValid ? 'pass' : 'fail',
    detail: lb
      ? lbValid
        ? `Found ${nodeTypes(lb).join(', ')} with name and contact details.`
        : `Found ${nodeTypes(lb).join(', ')} but it is missing a name, address or telephone.`
      : invalidBlocks > 0
        ? `${invalidBlocks} JSON-LD block(s) could not be parsed, and no LocalBusiness was found.`
        : 'No LocalBusiness JSON-LD found.',
  });

  const phone = findPhone(visibleText);
  checks.push({
    id: 'phone_in_text',
    label: 'Phone number in page text',
    result: phone ? 'pass' : 'fail',
    detail: phone ? `Found "${phone}".` : 'No phone number found in the visible text.',
  });

  const address = findAddress(visibleText);
  checks.push({
    id: 'address_in_text',
    label: 'Address in page text',
    result: address ? 'pass' : 'fail',
    detail: address ? `Found "${address}".` : 'No street address or postcode found in the visible text.',
  });

  const passed = checks.filter((c) => c.result === 'pass').length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
