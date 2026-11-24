import { parse } from 'node-html-parser';
import type { SeoCheck, SeoResult } from './schemas';

/** schema.org LocalBusiness and the subtypes local service businesses commonly use. */
const LOCAL_BUSINESS_TYPES = new Set(
  [
    'LocalBusiness', 'ProfessionalService', 'HomeAndConstructionBusiness', 'HealthAndBeautyBusiness',
    'HairSalon', 'BeautySalon', 'DaySpa', 'NailSalon', 'TattooParlor', 'MedicalBusiness', 'Dentist',
    'Physician', 'MedicalClinic', 'Optician', 'Pharmacy', 'FoodEstablishment', 'Restaurant', 'CafeOrCoffeeShop',
    'Bakery', 'BarOrPub', 'Electrician', 'Plumber', 'HVACBusiness', 'Locksmith', 'RoofingContractor',
    'GeneralContractor', 'HousePainter', 'MovingCompany', 'AutoRepair', 'AutomotiveBusiness', 'LegalService',
    'Attorney', 'Notary', 'AccountingService', 'FinancialService', 'RealEstateAgent', 'SportsActivityLocation',
    'ExerciseGym', 'HealthClub', 'LodgingBusiness', 'Hotel', 'ChildCare', 'DryCleaningOrLaundry',
    'EmploymentAgency', 'TravelAgency', 'Store', 'VeterinaryCare', 'AnimalShelter',
  ].map((t) => t.toLowerCase()),
);

const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{7,18}\d/g;

/** A phone number is 9–15 digits, optionally with +, spaces, dots, dashes or brackets. */
export function hasPhoneNumber(text: string): boolean {
  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15 && !/^(19|20)\d{6}$/.test(digits)) return true;
  }
  return false;
}
const POSTCODE_RE = /\b\d{4}-\d{3}\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b|\b\d{5}(-\d{4})?\b/;

function collectTypes(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectTypes(n, out));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') out.push(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.push(x));
    for (const v of Object.values(obj)) if (v && typeof v === 'object') collectTypes(v, out);
  }
}

export interface JsonLdInfo {
  blocks: number;
  invalidBlocks: number;
  types: string[];
  hasLocalBusiness: boolean;
  hasPostalAddress: boolean;
  hasOpeningHours: boolean;
  hasAggregateRating: boolean;
}

export function readJsonLd(html: string): JsonLdInfo {
  const root = parse(html);
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  const types: string[] = [];
  let invalid = 0;
  let hours = false;
  for (const s of scripts) {
    try {
      const data: unknown = JSON.parse(s.textContent);
      collectTypes(data, types);
      if (/"opening(Hours|HoursSpecification)"/.test(s.textContent)) hours = true;
    } catch {
      invalid++;
    }
  }
  const lower = types.map((t) => t.replace(/^https?:\/\/schema\.org\//, '').toLowerCase());
  return {
    blocks: scripts.length,
    invalidBlocks: invalid,
    types,
    hasLocalBusiness: lower.some((t) => LOCAL_BUSINESS_TYPES.has(t)),
    hasPostalAddress: lower.includes('postaladdress'),
    hasOpeningHours: hours,
    hasAggregateRating: lower.includes('aggregaterating'),
  };
}

const points = { pass: 1, warn: 0.5, fail: 0 } as const;

/** Rule-based local SEO checks on the rendered HTML. No AI involved. */
export function runSeoChecks(html: string): SeoResult {
  const root = parse(html, { comment: false });
  const checks: SeoCheck[] = [];
  const add = (c: SeoCheck) => checks.push(c);

  const title = root.querySelector('title')?.textContent.trim() ?? '';
  if (!title) add({ id: 'title', label: 'Page title', result: 'fail', detail: 'No <title> found.' });
  else if (title.length < 10 || title.length > 65)
    add({ id: 'title', label: 'Page title', result: 'warn', detail: `Title is ${title.length} characters ("${title.slice(0, 70)}"). Aim for 10–65.` });
  else add({ id: 'title', label: 'Page title', result: 'pass', detail: `"${title}"` });

  const desc = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';
  if (!desc) add({ id: 'meta_description', label: 'Meta description', result: 'fail', detail: 'No meta description found.' });
  else if (desc.length < 50 || desc.length > 160)
    add({ id: 'meta_description', label: 'Meta description', result: 'warn', detail: `Description is ${desc.length} characters. Aim for 50–160.` });
  else add({ id: 'meta_description', label: 'Meta description', result: 'pass', detail: `${desc.length} characters.` });

  const h1s = root.querySelectorAll('h1');
  if (h1s.length === 1) add({ id: 'h1', label: 'One main heading (h1)', result: 'pass', detail: `"${h1s[0]?.textContent.trim().slice(0, 80)}"` });
  else if (h1s.length === 0) add({ id: 'h1', label: 'One main heading (h1)', result: 'fail', detail: 'No h1 found.' });
  else add({ id: 'h1', label: 'One main heading (h1)', result: 'warn', detail: `${h1s.length} h1 headings found; use one.` });

  const lang = root.querySelector('html')?.getAttribute('lang')?.trim();
  add(lang
    ? { id: 'lang', label: 'Page language set', result: 'pass', detail: `lang="${lang}"` }
    : { id: 'lang', label: 'Page language set', result: 'fail', detail: 'The <html> tag has no lang attribute.' });

  const viewport = root.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
  add(viewport.includes('width=device-width')
    ? { id: 'viewport', label: 'Mobile viewport', result: 'pass', detail: viewport }
    : { id: 'viewport', label: 'Mobile viewport', result: 'fail', detail: 'No mobile viewport meta tag.' });

  const ld = readJsonLd(html);
  if (ld.hasLocalBusiness)
    add({ id: 'local_business_schema', label: 'LocalBusiness structured data', result: 'pass', detail: `Types found: ${ld.types.join(', ')}` });
  else if (ld.invalidBlocks > 0)
    add({ id: 'local_business_schema', label: 'LocalBusiness structured data', result: 'fail', detail: `${ld.invalidBlocks} JSON-LD block(s) could not be parsed.` });
  else
    add({ id: 'local_business_schema', label: 'LocalBusiness structured data', result: 'fail', detail: ld.blocks ? `JSON-LD present (${ld.types.join(', ') || 'no types'}) but no LocalBusiness type.` : 'No JSON-LD structured data found.' });

  const bodyText = root.querySelector('body')?.textContent.replace(/\s+/g, ' ') ?? '';
  const hasTel = root.querySelectorAll('a[href^="tel:"]').length > 0;
  if (hasTel) add({ id: 'phone', label: 'Phone number on page', result: 'pass', detail: 'Tappable tel: link found.' });
  else if (hasPhoneNumber(bodyText)) add({ id: 'phone', label: 'Phone number on page', result: 'warn', detail: 'A phone number appears in the text but is not a tappable tel: link.' });
  else add({ id: 'phone', label: 'Phone number on page', result: 'fail', detail: 'No phone number found.' });

  if (ld.hasPostalAddress || root.querySelector('address'))
    add({ id: 'address', label: 'Address on page', result: 'pass', detail: ld.hasPostalAddress ? 'PostalAddress in structured data.' : '<address> element found.' });
  else if (POSTCODE_RE.test(bodyText))
    add({ id: 'address', label: 'Address on page', result: 'warn', detail: 'Looks like a postcode in the text, but no structured address.' });
  else add({ id: 'address', label: 'Address on page', result: 'fail', detail: 'No address found.' });

  const score = Math.round((checks.reduce((s, c) => s + points[c.result], 0) / checks.length) * 100);
  return { score, checks };
}
