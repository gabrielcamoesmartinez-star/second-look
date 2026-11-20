import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAddress, findPhone, runSeoRules } from '../src/seo.ts';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const textOf = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');

const byId = (html: string) => {
  const r = runSeoRules(html, textOf(html));
  return Object.fromEntries(r.checks.map((c) => [c.id, c.result]));
};

describe('runSeoRules', () => {
  it('passes every check on the good fixture', () => {
    const html = fixture('good.html');
    const r = runSeoRules(html, textOf(html));
    expect(r.checks.filter((c) => c.result === 'fail')).toEqual([]);
    expect(r.score).toBe(100);
  });

  it('fails every check on the bad fixture', () => {
    const results = byId(fixture('bad.html'));
    expect(results).toEqual({
      title: 'fail',
      meta_description: 'fail',
      single_h1: 'fail',
      lang: 'fail',
      local_business_jsonld: 'fail',
      phone_in_text: 'fail',
      address_in_text: 'fail',
    });
  });

  it('finds LocalBusiness subtypes inside @graph with a full schema.org IRI', () => {
    const html = `<html lang="en"><head><script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x"},
      {"@type":["https://schema.org/Plumber"],"name":"Pipes Ltd","telephone":"+44 20 7946 0000"}]}
    </script></head><body></body></html>`;
    expect(byId(html)['local_business_jsonld']).toBe('pass');
  });

  it('fails a LocalBusiness with no contact details', () => {
    const html = `<script type="application/ld+json">{"@type":"Dentist","name":"Smile"}</script>`;
    expect(byId(html)['local_business_jsonld']).toBe('fail');
  });

  it('survives malformed JSON-LD', () => {
    const html = `<script type="application/ld+json">{not json</script>`;
    const r = runSeoRules(html, '');
    expect(r.checks.find((c) => c.id === 'local_business_jsonld')?.detail).toMatch(/could not be parsed/);
  });

  it('flags two h1s', () => {
    expect(byId('<h1>a</h1><h1>b</h1>')['single_h1']).toBe('fail');
  });
});

describe('text detectors', () => {
  it.each(['Ligue 912 345 678', 'Call +351 21 123 4567', 'Tel: 020 7946 0958', '(415) 555-0132'])('finds phone in %s', (t) => {
    expect(findPhone(t)).toBeDefined();
  });
  it.each(['Since 2015', 'Open 9 to 17', 'Price 120'])('ignores non-phone %s', (t) => {
    expect(findPhone(t)).toBeUndefined();
  });
  it.each(['Rua Augusta 12, 1100-053 Lisboa', '10 Downing Street', 'London SW1A 2AA', 'Austin, TX 78701'])('finds address in %s', (t) => {
    expect(findAddress(t)).toBeDefined();
  });
});
