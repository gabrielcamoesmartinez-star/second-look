import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/url';

describe('normalizeUrl', () => {
  it('adds https:// to a bare domain and says so', () => {
    expect(normalizeUrl('barbeariadorio.pt')).toEqual({ ok: true, url: 'https://barbeariadorio.pt/', host: 'barbeariadorio.pt', addedScheme: true });
  });
  it('keeps http and paths, drops the fragment, lowercases the host', () => {
    const r = normalizeUrl('  http://Example.COM/servicos?x=1#top ');
    expect(r).toMatchObject({ ok: true, url: 'http://example.com/servicos?x=1', addedScheme: false });
  });
  it.each(['', '   ', 'not a url', 'javascript:alert(1)', 'ftp://example.com', 'mailto:a@b.com', 'https://user:pw@example.com', 'example', 'https://exa mple.com'])(
    'rejects %j as invalid',
    (input) => expect(normalizeUrl(input)).toMatchObject({ ok: false, code: 'invalid_url' }),
  );
  it.each(['localhost', 'http://localhost:3000', 'https://127.0.0.1', 'http://10.0.0.5/admin', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'printer.local', 'db.internal', 'https://example.com:8080'])(
    'blocks %j as not public',
    (input) => expect(normalizeUrl(input)).toMatchObject({ ok: false, code: 'ssrf_blocked' }),
  );
  it('allows a public IP literal', () => {
    expect(normalizeUrl('https://8.8.8.8')).toMatchObject({ ok: true });
  });
});
