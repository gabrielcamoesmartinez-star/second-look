/**
 * Regression: in production the worker runs under tsx, which injects `__name(...)`
 * into compiled functions. The in-page collector must still run inside the browser.
 * (Vitest compiles differently, so this test runs tsx itself.)
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('the candidate collector runs in a page when compiled by tsx', () => {
  const out = execFileSync('npx', ['tsx', join(__dirname, 'fixtures', 'tsx-collector-check.mts')], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    env: process.env,
  });
  const result = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { injected: boolean; kinds: string[] };
  expect(result.injected).toBe(true); // proves the test exercises the real failure mode
  expect(result.kinds).toEqual(['tel', 'form']);
}, 60_000);
