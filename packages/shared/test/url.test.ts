import { describe, expect, it } from 'vitest';
import { normaliseUrl } from '../src/url.ts';

describe('normaliseUrl', () => {
  it('adds https:// and reports it', () => {
    const r = normaliseUrl('  example.pt  ');
    expect(r).toEqual({ ok: true, url: 'https://example.pt/', hostname: 'example.pt', addedScheme: true });
  });

  it('keeps an explicit http scheme', () => {
    const r = normaliseUrl('http://Example.COM/path?q=1#frag');
    expect(r.ok && r.url).toBe('http://example.com/path?q=1');
    expect(r.ok && r.addedScheme).toBe(false);
  });

  it('treats host:port without a scheme as a host', () => {
    expect(normaliseUrl('example.com:443').ok).toBe(true);
    expect(normaliseUrl('example.com:8080').ok).toBe(false);
  });

  it.each([
    'ftp://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'https://localhost',
    'https://printer.local',
    'https://metadata.google.internal',
    'https://intranet',
    'exa mple.com',
    '',
    'https://example.123',
  ])('rejects %s', (input) => {
    const r = normaliseUrl(input);
    expect(r.ok).toBe(false);
  });

  it('accepts IDN hosts', () => {
    const r = normaliseUrl('https://pão.pt');
    expect(r.ok && r.hostname).toBe('xn--po-sia.pt');
  });

  it('lets IP literals through to the SSRF check', () => {
    expect(normaliseUrl('http://127.0.0.1').ok).toBe(true);
  });
});
