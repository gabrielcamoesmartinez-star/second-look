import { describe, expect, it } from 'vitest';
import { checkHost, isPublicIp, type Resolver } from '../src/ssrf.ts';

describe('isPublicIp', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '100.100.100.200', '192.0.0.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '240.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
    '64:ff9b::a00:1', // NAT64 wrapping 10.0.0.1
    '2001::1', // Teredo
    '[::1]', 'fe80::1%eth0', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '::ffff:8.8.8.8', '[2a00:1450:4003:80f::200e]'])(
    'allows %s',
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
});

describe('checkHost', () => {
  const dns = (map: Record<string, string[]>): Resolver => async (h) => {
    const v = map[h];
    if (!v) throw new Error('ENOTFOUND');
    return v;
  };

  it('passes a public host and returns the addresses to pin', async () => {
    const r = await checkHost('good.example', dns({ 'good.example': ['93.184.215.14'] }));
    expect(r).toEqual({ ok: true, addresses: ['93.184.215.14'] });
  });

  it('blocks if any record is private', async () => {
    const r = await checkHost('mixed.example', dns({ 'mixed.example': ['93.184.215.14', '10.0.0.5'] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('ssrf_blocked');
  });

  it('blocks private IP literals without a DNS lookup', async () => {
    const r = await checkHost('169.254.169.254', async () => {
      throw new Error('should not resolve');
    });
    expect(!r.ok && r.code).toBe('ssrf_blocked');
  });

  it('reports DNS failure separately', async () => {
    const r = await checkHost('missing.example', dns({}));
    expect(!r.ok && r.code).toBe('dns_failed');
  });

  it('catches DNS rebinding: a second lookup (after a redirect) that turns private is blocked', async () => {
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return calls === 1 ? ['93.184.215.14'] : ['127.0.0.1'];
    };
    const first = await checkHost('rebind.example', rebinding);
    expect(first.ok).toBe(true);
    // The fetcher re-checks every hop, so the redirect target is resolved again.
    const second = await checkHost('rebind.example', rebinding);
    expect(!second.ok && second.code).toBe('ssrf_blocked');
  });
});
