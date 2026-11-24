import { describe, expect, it } from 'vitest';
import { hasPhoneNumber, readJsonLd, runSeoChecks } from '../src/seo';

const good = `<!doctype html><html lang="pt"><head>
<title>Barbearia do Rio — Cortes no Cais do Sodré</title>
<meta name="description" content="Barbearia clássica no Cais do Sodré, Lisboa. Cortes, barba e marcações online. Aberto de segunda a sábado.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"HairSalon","name":"Barbearia do Rio","address":{"@type":"PostalAddress","streetAddress":"Rua do Rio 12","postalCode":"1200-001"},"openingHours":"Mo-Sa 09:00-19:00"}</script>
</head><body><h1>Barbearia do Rio</h1><a href="tel:+351210000000">Ligar</a></body></html>`;

const bad = `<html><head></head><body><h1>A</h1><h1>B</h1><p>Call 21 000 0000 · 1200-001 Lisboa</p></body></html>`;

describe('runSeoChecks', () => {
  it('passes a well-built page', () => {
    const r = runSeoChecks(good);
    expect(r.checks.every((c) => c.result === 'pass')).toBe(true);
    expect(r.score).toBe(100);
  });
  it('flags a weak page with specific results', () => {
    const r = runSeoChecks(bad);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.result]));
    expect(by).toMatchObject({ title: 'fail', meta_description: 'fail', h1: 'warn', lang: 'fail', viewport: 'fail', local_business_schema: 'fail', phone: 'warn', address: 'warn' });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(40);
  });
  it('reports unparseable JSON-LD', () => {
    const r = runSeoChecks('<html lang="en"><head><script type="application/ld+json">{oops</script></head><body></body></html>');
    expect(r.checks.find((c) => c.id === 'local_business_schema')?.detail).toMatch(/could not be parsed/);
  });
});

describe('readJsonLd', () => {
  it('finds LocalBusiness inside @graph and type arrays', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":["Organization","Dentist"],"aggregateRating":{"@type":"AggregateRating"}}]}</script>`;
    const r = readJsonLd(html);
    expect(r.hasLocalBusiness).toBe(true);
    expect(r.hasAggregateRating).toBe(true);
  });
});

describe('hasPhoneNumber', () => {
  it.each(['+351 210 000 000', '(21) 000-0000 ext', '07908 898823', '+44 20 7946 0958'])('finds %j', (t) => expect(hasPhoneNumber(t)).toBe(true));
  it.each(['Founded 2012', 'Open 9:00-19:00', '20261124'])('ignores %j', (t) => expect(hasPhoneNumber(t)).toBe(false));
});
