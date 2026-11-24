import { isBlockedIp } from '@second-look/shared';
import { describe, expect, it } from 'vitest';
import { assertPublicHost, type NetGuard } from '../src/ssrf';

const guard = (map: Record<string, string[]>): NetGuard => ({
  resolve: async (h) => {
    if (!(h in map)) throw new Error('ENOTFOUND');
    return map[h]!;
  },
  isBlocked: isBlockedIp,
});

describe('assertPublicHost', () => {
  it('accepts a host that resolves only to public addresses', async () => {
    await expect(assertPublicHost('shop.example', guard({ 'shop.example': ['93.184.216.34'] }))).resolves.toEqual(['93.184.216.34']);
  });
  it('rejects a host with ANY private address (mixed DNS answer)', async () => {
    await expect(assertPublicHost('evil.example', guard({ 'evil.example': ['93.184.216.34', '10.0.0.1'] }))).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects a name pointing at the cloud metadata address', async () => {
    await expect(assertPublicHost('meta.example', guard({ 'meta.example': ['169.254.169.254'] }))).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects private IP literals without resolving', async () => {
    await expect(assertPublicHost('[::1]', guard({}))).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('reports unresolvable hosts as fetch_failed', async () => {
    await expect(assertPublicHost('nope.example', guard({}))).rejects.toMatchObject({ code: 'fetch_failed' });
  });
});
