import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', env: { NODE_ENV: 'test' }, include: ['test/integration/**/*.test.ts'], testTimeout: 60_000 },
});
